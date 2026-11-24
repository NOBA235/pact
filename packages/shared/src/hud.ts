export type HudStateType =
  | 'DARK_IDLE'
  | 'CONFLICT'
  | 'PACT_DRAFT'
  | 'SENT_PENDING'
  | 'LOCKED_PULSE';

export interface DarkIdlePayload {
  state: 'DARK_IDLE';
  subtitle?: string;
}

export interface ConflictPayload {
  state: 'CONFLICT';
  docTitle: string;
  docFact: string;
  spokenClaim: string;
}

export interface PactDraftPayload {
  state: 'PACT_DRAFT';
  pactId?: string;
  title: string;
  owner: string;
  dueText: string;
}

export interface SentPendingPayload {
  state: 'SENT_PENDING';
  pactId?: string;
  title: string;
}

export interface LockedPulsePayload {
  state: 'LOCKED_PULSE';
  pactId?: string;
  title: string;
  confirmedBy: string;
}

export type HudPayload =
  | DarkIdlePayload
  | ConflictPayload
  | PactDraftPayload
  | SentPendingPayload
  | LockedPulsePayload;

export interface FormattedHudFrame {
  state: HudStateType;
  lines: [string, string, string];
  text: string;
  isDim: boolean;
}

export const HUD_MAX_LINES = 3;
export const HUD_MAX_CHARS_PER_LINE = 28;

/**
 * Truncates text to `maxChars` cleanly on a word boundary when possible,
 * collapsing internal newlines and multiple spaces into single spaces.
 */
export function truncateLine(input: string, maxChars: number = HUD_MAX_CHARS_PER_LINE): string {
  if (maxChars <= 0) return '';
  const normalized = input.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars === 1) {
    return '…';
  }
  const budget = maxChars - 1; // Reserve 1 char for '…'
  const slice = normalized.slice(0, budget + 1);
  const lastSpace = slice.lastIndexOf(' ');
  // Use word boundary if it retains at least 60% of the budget
  if (lastSpace >= Math.floor(budget * 0.6)) {
    return slice.slice(0, lastSpace).trimEnd() + '…';
  }
  return normalized.slice(0, budget).trimEnd() + '…';
}

/**
 * Formats any of the 5 HUD states into a strict 3-line x <=28-char frame.
 */
export function formatHudFrame(payload: HudPayload): FormattedHudFrame {
  let rawLines: [string, string, string];
  let isDim = false;

  switch (payload.state) {
    case 'DARK_IDLE': {
      isDim = true;
      rawLines = [
        'PACT · ACTIVE',
        payload.subtitle ? truncateLine(payload.subtitle, HUD_MAX_CHARS_PER_LINE) : '',
        '',
      ];
      break;
    }

    case 'CONFLICT': {
      // Line 1: ! CONFLICT · [DOC] (max 28c => prefix "! CONFLICT · " is 13 chars, doc <= 15 chars)
      const docTag = truncateLine(payload.docTitle || 'DOC', 15);
      // Line 2: Doc: [fact <=23c] (prefix "Doc: " is 5 chars + 23 = 28)
      const docFact = truncateLine(payload.docFact, 23);
      // Line 3: Said: [claim <=22c] (prefix "Said: " is 6 chars + 22 = 28)
      const spokenClaim = truncateLine(payload.spokenClaim, 22);
      rawLines = [
        `! CONFLICT · ${docTag}`,
        `Doc: ${docFact}`,
        `Said: ${spokenClaim}`,
      ];
      break;
    }

    case 'PACT_DRAFT': {
      // Line 1: PACT? [TAP: LOCK]
      // Line 2: [Title <=28c]
      // Line 3: [Owner] · [Due]
      const title = truncateLine(payload.title, HUD_MAX_CHARS_PER_LINE);
      const due = truncateLine(payload.dueText || 'TBD', 12);
      const separator = ' · ';
      const ownerBudget = Math.max(4, HUD_MAX_CHARS_PER_LINE - separator.length - due.length);
      const owner = truncateLine(payload.owner || 'Me', ownerBudget);
      rawLines = [
        'PACT? [TAP: LOCK]',
        title,
        `${owner}${separator}${due}`,
      ];
      break;
    }

    case 'SENT_PENDING': {
      // Line 1: SENT TO TG + NOTION
      // Line 2: Awaiting TG tap...
      // Line 3: [Title <=28c]
      rawLines = [
        'SENT TO TG + NOTION',
        'Awaiting TG tap...',
        truncateLine(payload.title, HUD_MAX_CHARS_PER_LINE),
      ];
      break;
    }

    case 'LOCKED_PULSE': {
      // Line 1: ✓ PACT LOCKED
      // Line 2: [Title <=28c]
      // Line 3: By @[user] · Saved
      const cleanHandle = (payload.confirmedBy || 'partner').replace(/^@+/, '').trim();
      // Prefix "By @" (4) + suffix " · Saved" (8) = 12 chars => handle budget = 16 chars
      const handle = truncateLine(cleanHandle, 16);
      rawLines = [
        '✓ PACT LOCKED',
        truncateLine(payload.title, HUD_MAX_CHARS_PER_LINE),
        `By @${handle} · Saved`,
      ];
      break;
    }
  }

  const lines: [string, string, string] = [
    truncateLine(rawLines[0], HUD_MAX_CHARS_PER_LINE),
    truncateLine(rawLines[1], HUD_MAX_CHARS_PER_LINE),
    truncateLine(rawLines[2], HUD_MAX_CHARS_PER_LINE),
  ];

  return {
    state: payload.state,
    lines,
    text: lines.join('\n'),
    isDim,
  };
}
