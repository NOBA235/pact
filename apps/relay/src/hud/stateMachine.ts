import { randomUUID } from 'node:crypto';
import {
  formatHudFrame,
  type FormattedHudFrame,
  type HudPayload,
  type HudStateType,
  type PactRecord,
  type SpeakerRoleTag,
} from '@pact/shared';
import type { UnifiedDetectionResult } from '../ai/detector.js';
import {
  recordDetectedConflict,
  updatePactRecord,
  upsertPactRecord,
  listPactsForSession,
} from '../db/supabase.js';
import { createNotionPactLedgerRow } from '../notion/ledger.js';
import { sendTelegramPactCard } from '../telegram/bot.js';

export const DEFAULT_DEDUPE_COOLDOWN_MS = 20_000;
export const DEFAULT_AUTO_FADE_MS = 15_000;
export const DEFAULT_LOCKED_PULSE_MS = 3_000;

export interface StateMachineConfig {
  sessionId: string;
  telegramChatId?: string;
  dedupeCooldownMs?: number;
  autoFadeMs?: number;
  lockedPulseMs?: number;
  onHudFrame: (payload: HudPayload, frame: FormattedHudFrame) => void;
  onPactUpdated?: (pact: PactRecord, sessionPacts: PactRecord[]) => void;
}

const sessionMachines = new Map<string, SessionHudStateMachine>();

export function getSessionStateMachines(sessionId: string): SessionHudStateMachine[] {
  const matches: SessionHudStateMachine[] = [];
  for (const machine of sessionMachines.values()) {
    if (machine.getSessionId() === sessionId) {
      matches.push(machine);
    }
  }
  return matches;
}

/**
 * Computes a normalized semantic dedupe signature for a conflict or pact candidate
 * so repeated phrases within the 20s cooldown window do not re-trigger HUD alerts.
 */
export function buildSemanticSignature(candidate: UnifiedDetectionResult): string {
  if (candidate.type === 'conflict') {
    const normDoc = candidate.docTitle.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const normClaim = candidate.spokenClaim.toLowerCase().replace(/[^a-z0-9%$]+/g, '');
    return `conflict:${normDoc}:${normClaim}`;
  }
  if (candidate.type === 'pact') {
    const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'by', 'on', 'at', 'our', 'my']);
    const tokens = candidate.title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !stopWords.has(t));
    return `pact:${candidate.owner.toLowerCase()}:${tokens.slice(0, 4).join('_')}`;
  }
  return 'none';
}

export class SessionHudStateMachine {
  private readonly instanceKey: string = randomUUID();
  private sessionId: string;
  private telegramChatId?: string;
  private readonly dedupeCooldownMs: number;
  private readonly autoFadeMs: number;
  private readonly lockedPulseMs: number;
  private readonly onHudFrameCallback: (payload: HudPayload, frame: FormattedHudFrame) => void;
  private readonly onPactUpdatedCallback?: (pact: PactRecord, sessionPacts: PactRecord[]) => void;

  private state: HudStateType = 'DARK_IDLE';
  private activeDraftPact: PactRecord | null = null;
  private pendingLockPactId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly dedupeTimestamps = new Map<string, number>();

  constructor(config: StateMachineConfig) {
    this.sessionId = config.sessionId;
    this.telegramChatId = config.telegramChatId;
    this.dedupeCooldownMs = config.dedupeCooldownMs ?? DEFAULT_DEDUPE_COOLDOWN_MS;
    this.autoFadeMs = config.autoFadeMs ?? DEFAULT_AUTO_FADE_MS;
    this.lockedPulseMs = config.lockedPulseMs ?? DEFAULT_LOCKED_PULSE_MS;
    this.onHudFrameCallback = config.onHudFrame;
    this.onPactUpdatedCallback = config.onPactUpdated;

    sessionMachines.set(this.instanceKey, this);
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public setSessionContext(sessionId: string, telegramChatId?: string): void {
    this.sessionId = sessionId;
    if (telegramChatId !== undefined) {
      this.telegramChatId = telegramChatId;
    }
  }

  public getState(): HudStateType {
    return this.state;
  }

  public getActiveDraftPact(): PactRecord | null {
    return this.activeDraftPact;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private transitionTo(payload: HudPayload, autoReturnIdleMs: number = 0): FormattedHudFrame {
    this.clearTimer();
    const frame = formatHudFrame(payload);
    this.state = frame.state;
    this.onHudFrameCallback(payload, frame);

    if (autoReturnIdleMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.state === 'PACT_DRAFT' && this.activeDraftPact) {
          const expired = this.activeDraftPact;
          this.activeDraftPact = null;
          void updatePactRecord(expired.id, { status: 'dismissed' }).then((updated) => {
            if (updated) this.emitPactUpdated(updated);
          });
        }
        this.transitionTo({ state: 'DARK_IDLE' }, 0);
      }, autoReturnIdleMs);
    }

    return frame;
  }

  private emitPactUpdated(pact: PactRecord): void {
    this.onPactUpdatedCallback?.(pact, listPactsForSession(this.sessionId));
  }

  private isDuplicateWithinCooldown(signature: string, now: number = Date.now()): boolean {
    const prev = this.dedupeTimestamps.get(signature);
    if (prev !== undefined && now - prev < this.dedupeCooldownMs) {
      return true;
    }
    this.dedupeTimestamps.set(signature, now);
    return false;
  }

  /**
   * Evaluates a detected `conflict` or `pact` result against the 20s semantic dedupe cooldown
   * and transitions the HUD state accordingly.
   */
  public async handleDetection(
    detection: UnifiedDetectionResult,
    speakerRole: SpeakerRoleTag
  ): Promise<boolean> {
    if (detection.type === 'none') {
      return false;
    }

    // Do not overwrite an active LOCKED_PULSE or an unconfirmed PACT_DRAFT with another pact draft
    if (this.state === 'LOCKED_PULSE') {
      return false;
    }

    const signature = buildSemanticSignature(detection);
    if (this.isDuplicateWithinCooldown(signature)) {
      console.log(`[HUD StateMachine] Suppressed duplicate within 20s cooldown: ${signature}`);
      return false;
    }

    if (detection.type === 'conflict') {
      this.activeDraftPact = null;
      this.transitionTo(
        {
          state: 'CONFLICT',
          docTitle: detection.docTitle,
          docFact: detection.docFact,
          spokenClaim: detection.spokenClaim,
        },
        this.autoFadeMs
      );

      void recordDetectedConflict({
        sessionId: this.sessionId,
        docTitle: detection.docTitle,
        docFact: detection.docFact,
        spokenClaim: detection.spokenClaim,
        sourceQuote: detection.spokenClaim,
        confidence: detection.confidence,
      });
      return true;
    }

    if (detection.type === 'pact') {
      const pact: PactRecord = {
        id: randomUUID(),
        sessionId: this.sessionId,
        title: detection.title,
        owner: detection.owner,
        dueText: detection.dueText,
        sourceQuote: detection.sourceQuote,
        speakerRole,
        confidence: detection.confidence,
        status: 'draft',
        telegramChatId: this.telegramChatId ?? process.env.TELEGRAM_DEFAULT_CHAT_ID ?? null,
        createdAt: new Date().toISOString(),
      };

      this.activeDraftPact = pact;
      await upsertPactRecord(pact);
      this.emitPactUpdated(pact);

      this.transitionTo(
        {
          state: 'PACT_DRAFT',
          pactId: pact.id,
          title: pact.title,
          owner: pact.owner,
          dueText: pact.dueText,
        },
        this.autoFadeMs
      );
      return true;
    }

    return false;
  }

  /**
   * Handles SINGLE_TAP from the G2 glasses / simulator:
   * Strictly gated to `PACT_DRAFT` (zero autonomous writes).
   * Immediately renders `SENT_PENDING`, writes Notion Pact Ledger row ("Pending"),
   * sends Telegram inline verification card, and stores IDs in Supabase `pacts`.
   */
  public async handleSingleTap(): Promise<PactRecord | null> {
    if (this.state !== 'PACT_DRAFT' || !this.activeDraftPact) {
      return null;
    }

    const draft = this.activeDraftPact;
    this.activeDraftPact = null;
    this.pendingLockPactId = draft.id;

    // 1. Immediately push SENT_PENDING to G2 HUD (15s auto-fade so lens stays clean while webhook remains active)
    this.transitionTo(
      {
        state: 'SENT_PENDING',
        pactId: draft.id,
        title: draft.title,
      },
      this.autoFadeMs
    );

    // 2. Mark Pending in Supabase + create Notion row + send Telegram inline card
    const pendingPact =
      (await updatePactRecord(draft.id, { status: 'pending' })) ?? {
        ...draft,
        status: 'pending' as const,
      };
    this.emitPactUpdated(pendingPact);

    try {
      const [notionRes, tgRes] = await Promise.all([
        createNotionPactLedgerRow(pendingPact),
        sendTelegramPactCard(pendingPact, this.telegramChatId),
      ]);

      const syncedPact = await updatePactRecord(draft.id, {
        status: 'pending',
        notionPageId: notionRes.notionPageId,
        telegramChatId: tgRes.chatId,
        telegramMessageId: tgRes.messageId,
      });

      const finalPending = syncedPact ?? {
        ...pendingPact,
        notionPageId: notionRes.notionPageId,
        telegramChatId: tgRes.chatId,
        telegramMessageId: tgRes.messageId,
      };
      this.emitPactUpdated(finalPending);

      console.log(
        `[PACT SENT] id=${finalPending.id} | title="${finalPending.title}" | notion=${finalPending.notionPageId} | tg=${finalPending.telegramChatId}:${finalPending.telegramMessageId}`
      );
      return finalPending;
    } catch (err) {
      console.error(`[PACT SENT ERROR] id=${draft.id}:`, err);
      return pendingPact;
    }
  }

  /**
   * Handles DOUBLE_TAP from the G2 glasses / simulator:
   * Immediately discards `PACT_DRAFT` or `CONFLICT` and returns to `DARK_IDLE`.
   */
  public async handleDoubleTap(): Promise<void> {
    if (this.state !== 'PACT_DRAFT' && this.state !== 'CONFLICT') {
      return;
    }

    const draft = this.activeDraftPact;
    this.activeDraftPact = null;

    this.transitionTo({ state: 'DARK_IDLE' }, 0);

    if (draft) {
      const updated = await updatePactRecord(draft.id, { status: 'dismissed' });
      if (updated) {
        this.emitPactUpdated(updated);
      }
    }
  }

  /**
   * Invoked when the counterparty taps `[✓ Lock Pact]` or `[✕ Decline]` in Telegram.
   * Pushes `LOCKED_PULSE` (3s auto-fade -> `DARK_IDLE`) or brief decline notice.
   */
  public handleTelegramResolution(
    pact: PactRecord,
    resolution: 'locked' | 'declined',
    confirmedBy: string
  ): void {
    if (this.pendingLockPactId === pact.id) {
      this.pendingLockPactId = null;
    }
    this.emitPactUpdated(pact);

    if (resolution === 'locked') {
      this.transitionTo(
        {
          state: 'LOCKED_PULSE',
          pactId: pact.id,
          title: pact.title,
          confirmedBy,
        },
        this.lockedPulseMs
      );
      return;
    }

    const cleanUser = confirmedBy.replace(/^@+/, '').trim() || 'partner';
    this.transitionTo(
      {
        state: 'DARK_IDLE',
        subtitle: `✕ Declined by @${cleanUser}`,
      },
      this.lockedPulseMs
    );
  }

  public dispose(): void {
    this.clearTimer();
    this.activeDraftPact = null;
    this.pendingLockPactId = null;
    sessionMachines.delete(this.instanceKey);
  }
}
