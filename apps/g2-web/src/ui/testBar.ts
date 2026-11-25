import type {
  AudioCaptureMode,
  FormattedHudFrame,
  HudPayload,
  HudStateType,
  PactRecord,
  UtteranceRecord,
} from '@pact/shared';
import type { PactEvenBridge } from '../sdk/evenBridge.js';
import type { AudioAdapterStats } from '../audio/audioAdapter.js';

export interface NotionPageOption {
  id: string;
  title: string;
  source?: string;
}

export const SAMPLE_HUD_PAYLOADS: Record<HudStateType, HudPayload> = {
  DARK_IDLE: {
    state: 'DARK_IDLE',
  },
  CONFLICT: {
    state: 'CONFLICT',
    docTitle: 'SOW',
    docFact: '10% rev-share cap',
    spokenClaim: '15% rev-share cap',
  },
  PACT_DRAFT: {
    state: 'PACT_DRAFT',
    pactId: 'pact-demo-01',
    title: 'Send revised cap table PDF',
    owner: 'Me',
    dueText: 'Fri 5pm',
  },
  SENT_PENDING: {
    state: 'SENT_PENDING',
    pactId: 'pact-demo-01',
    title: 'Send revised cap table PDF',
  },
  LOCKED_PULSE: {
    state: 'LOCKED_PULSE',
    pactId: 'pact-demo-01',
    title: 'Send revised cap table PDF',
    confirmedBy: '@alex_vc',
  },
};

export interface CompanionUiHandlers {
  onStartSession: (mode: AudioCaptureMode, telegramChatId: string) => Promise<void>;
  onStopSession: () => Promise<void>;
  onStreamTestPcm: () => void;
  onSyncNotionDealDocs: (pageIds: string[]) => Promise<{ pagesSynced: number; chunksStored: number }>;
  onRefreshNotionPages: () => Promise<NotionPageOption[]>;
  onPingTelegramChat: (chatId: string) => Promise<{ ok: boolean; simulated?: boolean }>;
  onSimulateUtterance: (text: string) => void;
}

export interface TestBarController {
  appendLog: (entry: string) => void;
  updateMirrorFrame: (frame: FormattedHudFrame) => void;
  updateRelayStatus: (
    connected: boolean,
    deepgramState: string,
    activeSockets: number,
    reconnectingInMs?: number
  ) => void;
  updateSyncedDocsCount: (pagesCount: number, chunksCount?: number) => void;
  updateAudioStats: (stats: AudioAdapterStats) => void;
  updateRollingWindow: (windowUtterances: UtteranceRecord[]) => void;
  updateSessionPacts: (pacts: PactRecord[]) => void;
  setNotionPageOptions: (pages: NotionPageOption[]) => void;
}

export function mountTestBar(
  root: HTMLElement,
  pactBridge: PactEvenBridge,
  handlers: CompanionUiHandlers
): TestBarController {
  root.innerHTML = `
    <main class="pact-shell">
      <header class="pact-header">
        <div>
          <span class="pact-badge">EVEN REALITIES G2 · SDK 0.0.16</span>
          <h1 class="pact-title">PACT — Bilateral Commitment &amp; Fact-Check HUD</h1>
        </div>
        <div class="pact-pill-row" role="status" aria-label="Live Session Status Bar">
          <div class="pact-status-pill" id="bridge-status">Bridge: Initializing…</div>
          <div class="pact-status-pill" id="relay-status">Relay WS: Connecting…</div>
          <div class="pact-status-pill" id="dg-status">Deepgram: Idle</div>
          <div class="pact-status-pill" id="docs-status">Synced Docs: 0</div>
        </div>
      </header>

      <section class="pact-lens-card" aria-label="Simulated 576x288 G2 Waveguide Mirror">
        <div class="pact-lens-meta">
          <span>G2 WAVEGUIDE LENS MIRROR (576×288 · 3×28 CHARS)</span>
          <span id="hud-state-badge">STATE: DARK_IDLE</span>
        </div>
        <div class="pact-lens-screen" id="lens-screen">
          <pre class="pact-lens-pre" id="lens-pre">PACT · ACTIVE\n\n</pre>
        </div>
      </section>

      <section class="pact-setup-grid" aria-label="3-Step Session Setup">
        <article class="pact-controls-card">
          <div class="pact-logs-header">
            <h2 class="pact-section-title">1 · Select &amp; Sync Notion Deal Docs (1–5)</h2>
            <button type="button" class="pact-btn-small" id="refresh-notion-btn">Refresh</button>
          </div>
          <div class="pact-doc-checklist" id="notion-doc-checklist"></div>
          <div class="pact-step-footer">
            <button type="button" class="pact-btn pact-btn-ok" id="sync-notion-btn">Sync Selected Docs</button>
            <span class="pact-inline-note" id="notion-sync-status">Select 1–5 deal pages to index in pgvector.</span>
          </div>
        </article>

        <article class="pact-controls-card">
          <div class="pact-logs-header">
            <h2 class="pact-section-title">2 · Link &amp; Verify Telegram Group Chat</h2>
            <span class="pact-inline-note" id="tg-ping-status">Bot inline cards target</span>
          </div>
          <div class="pact-session-row">
            <label class="pact-select-label" for="tg-chat-input">Group Chat ID</label>
            <input
              id="tg-chat-input"
              type="text"
              class="pact-input"
              placeholder="-1001234567890"
              value="-100777888999"
              autocomplete="off"
            />
            <button type="button" class="pact-btn" id="tg-ping-btn">Send Test Ping</button>
          </div>
        </article>

        <article class="pact-controls-card">
          <div class="pact-logs-header">
            <h2 class="pact-section-title">3 · Ephemeral Audio Consent &amp; Start Session</h2>
            <span class="pact-audio-stats" id="audio-stats-label">0 frames · 0.0 KB · role: unknown</span>
          </div>
          <div class="pact-consent-box">
            <label class="pact-checkbox-label" for="consent-checkbox">
              <input type="checkbox" id="consent-checkbox" class="pact-checkbox visually-hidden" />
              <span>Participants informed — audio is ephemeral and never stored</span>
            </label>
          </div>
          <div class="pact-session-row">
            <label class="pact-select-label" for="audio-mode-select">Audio Input</label>
            <select id="audio-mode-select" class="pact-select">
              <option value="g2_bridge">G2 Bridge / Simulator (--aid) 16kHz PCM</option>
              <option value="browser_mic">Browser AudioContext 16kHz PCM Fallback</option>
            </select>
            <button type="button" class="pact-btn pact-btn-ok" id="start-session-btn" disabled>
              Start Session
            </button>
            <button type="button" class="pact-btn pact-btn-warn" id="stop-session-btn">
              Stop Session
            </button>
          </div>
        </article>
      </section>

      <section class="pact-controls-card" aria-label="Live Session Pacts Ledger">
        <div class="pact-logs-header">
          <h2 class="pact-section-title">Live Session Pacts</h2>
          <span class="pact-audio-stats" id="pacts-count-badge">0 pacts</span>
        </div>
        <div class="pact-pacts-list" id="session-pacts-list">
          <div class="pact-window-empty">No commitments drafted in this session yet. Single-tap on the G2 lens to dispatch a drafted Pact to Notion &amp; Telegram.</div>
        </div>
      </section>

      <section class="pact-controls-card" aria-label="Rolling 4-Utterance Context Window">
        <div class="pact-window-header">
          <span>Rolling 4-Utterance Ephemeral Context Window</span>
          <span id="window-count-badge">0 / 4</span>
        </div>
        <div class="pact-window-list" id="rolling-window-list">
          <div class="pact-window-empty">Waiting for live utterances…</div>
        </div>
      </section>

      <details class="pact-diagnostics">
        <summary class="pact-diagnostics-summary">Simulator &amp; HUD Diagnostics Console</summary>
        <div class="pact-diagnostics-body">
          <div class="pact-session-row">
            <button type="button" class="pact-btn pact-btn-warn" id="sim-conflict-btn">Speak Contradiction ("15% rev-share…")</button>
            <button type="button" class="pact-btn pact-btn-accent" id="sim-pact-btn">Speak Commitment ("Send cap table…")</button>
            <button type="button" class="pact-btn" id="sim-banter-btn">Speak Casual Banter</button>
            <button type="button" class="pact-btn" id="test-pcm-btn">Inject 16kHz G2 Audio Burst</button>
          </div>
          <div class="pact-btn-grid">
            <button type="button" class="pact-btn" data-hud-state="DARK_IDLE">
              <span class="btn-num">1</span>
              <span class="btn-label">DARK_IDLE</span>
            </button>
            <button type="button" class="pact-btn pact-btn-warn" data-hud-state="CONFLICT">
              <span class="btn-num">2</span>
              <span class="btn-label">CONFLICT</span>
            </button>
            <button type="button" class="pact-btn pact-btn-accent" data-hud-state="PACT_DRAFT">
              <span class="btn-num">3</span>
              <span class="btn-label">PACT_DRAFT</span>
            </button>
            <button type="button" class="pact-btn" data-hud-state="SENT_PENDING">
              <span class="btn-num">4</span>
              <span class="btn-label">SENT_PENDING</span>
            </button>
            <button type="button" class="pact-btn pact-btn-ok" data-hud-state="LOCKED_PULSE">
              <span class="btn-num">5</span>
              <span class="btn-label">LOCKED_PULSE</span>
            </button>
          </div>
          <div class="pact-logs-header" style="margin-top: 10px;">
            <h3 class="pact-section-title">Tap, Audio &amp; Bridge Event Logs</h3>
            <button type="button" class="pact-btn-small" id="clear-logs-btn">Clear</button>
          </div>
          <div class="pact-log-list" id="tap-log-list" role="log" aria-live="polite"></div>
        </div>
      </details>
    </main>
  `;

  const statusEl = root.querySelector<HTMLElement>('#bridge-status')!;
  const relayStatusEl = root.querySelector<HTMLElement>('#relay-status')!;
  const dgStatusEl = root.querySelector<HTMLElement>('#dg-status')!;
  const docsStatusEl = root.querySelector<HTMLElement>('#docs-status')!;
  const checklistEl = root.querySelector<HTMLElement>('#notion-doc-checklist')!;
  const refreshNotionBtn = root.querySelector<HTMLButtonElement>('#refresh-notion-btn')!;
  const syncNotionBtn = root.querySelector<HTMLButtonElement>('#sync-notion-btn')!;
  const notionStatusEl = root.querySelector<HTMLElement>('#notion-sync-status')!;
  const tgChatInput = root.querySelector<HTMLInputElement>('#tg-chat-input')!;
  const tgPingBtn = root.querySelector<HTMLButtonElement>('#tg-ping-btn')!;
  const tgPingStatusEl = root.querySelector<HTMLElement>('#tg-ping-status')!;
  const consentCheckbox = root.querySelector<HTMLInputElement>('#consent-checkbox')!;
  const audioStatsEl = root.querySelector<HTMLElement>('#audio-stats-label')!;
  const modeSelectEl = root.querySelector<HTMLSelectElement>('#audio-mode-select')!;
  const startBtn = root.querySelector<HTMLButtonElement>('#start-session-btn')!;
  const stopBtn = root.querySelector<HTMLButtonElement>('#stop-session-btn')!;
  const pactsCountEl = root.querySelector<HTMLElement>('#pacts-count-badge')!;
  const pactsListEl = root.querySelector<HTMLElement>('#session-pacts-list')!;
  const windowCountEl = root.querySelector<HTMLElement>('#window-count-badge')!;
  const windowListEl = root.querySelector<HTMLElement>('#rolling-window-list')!;
  const testPcmBtn = root.querySelector<HTMLButtonElement>('#test-pcm-btn')!;
  const simConflictBtn = root.querySelector<HTMLButtonElement>('#sim-conflict-btn')!;
  const simPactBtn = root.querySelector<HTMLButtonElement>('#sim-pact-btn')!;
  const simBanterBtn = root.querySelector<HTMLButtonElement>('#sim-banter-btn')!;
  const stateBadgeEl = root.querySelector<HTMLElement>('#hud-state-badge')!;
  const lensPreEl = root.querySelector<HTMLElement>('#lens-pre')!;
  const lensScreenEl = root.querySelector<HTMLElement>('#lens-screen')!;
  const logListEl = root.querySelector<HTMLElement>('#tap-log-list')!;
  const clearBtn = root.querySelector<HTMLButtonElement>('#clear-logs-btn')!;

  const setNotionPageOptions = (pages: NotionPageOption[]): void => {
    checklistEl.innerHTML = '';
    pages.forEach((p, idx) => {
      const inputId = `notion-doc-${idx}`;
      const label = document.createElement('label');
      label.className = 'pact-checkbox-label';
      label.htmlFor = inputId;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = inputId;
      cb.className = 'pact-checkbox visually-hidden';
      cb.value = p.id;
      cb.checked = idx === 0;

      const textSpan = document.createElement('span');
      textSpan.textContent = `${p.title} (${p.source === 'notion_api' ? 'Notion API' : 'Deal Preset'})`;

      label.append(cb, textSpan);
      checklistEl.append(label);
    });
  };

  setNotionPageOptions([
    { id: 'demo-sow-2026', title: 'SOW — 10% rev-share cap · Delivery: Q1', source: 'preset' },
    { id: 'demo-term-sheet', title: 'TERM SHEET — $12M cap · 20% discount', source: 'preset' },
  ]);

  consentCheckbox.addEventListener('change', () => {
    startBtn.disabled = !consentCheckbox.checked;
  });

  const appendLog = (entry: string): void => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const row = document.createElement('div');
    row.className = 'pact-log-row';
    row.textContent = `[${time}] ${entry}`;
    logListEl.prepend(row);
    if (pactBridge.isInitialized()) {
      statusEl.textContent = 'Bridge: Ready (SDK 0.0.16)';
      statusEl.dataset.ready = 'true';
    }
  };

  const updateMirrorFrame = (frame: FormattedHudFrame): void => {
    stateBadgeEl.textContent = `STATE: ${frame.state}`;
    lensPreEl.textContent = frame.text;
    lensScreenEl.dataset.dim = frame.isDim ? 'true' : 'false';
    root.querySelectorAll<HTMLButtonElement>('[data-hud-state]').forEach((btn) => {
      btn.dataset.active = btn.dataset.hudState === frame.state ? 'true' : 'false';
    });
  };

  const updateRelayStatus = (
    connected: boolean,
    deepgramState: string,
    activeSockets: number,
    reconnectingInMs?: number
  ): void => {
    relayStatusEl.textContent = connected
      ? 'Relay WS: Connected'
      : reconnectingInMs
        ? `Relay WS: Reconnecting (${Math.ceil(reconnectingInMs / 1000)}s)…`
        : 'Relay WS: Disconnected';
    relayStatusEl.dataset.ready = connected ? 'true' : 'false';
    dgStatusEl.textContent = `Deepgram: ${deepgramState} (${activeSockets})`;
  };

  const updateSyncedDocsCount = (pagesCount: number, chunksCount?: number): void => {
    docsStatusEl.textContent =
      chunksCount !== undefined
        ? `Synced Docs: ${pagesCount} (${chunksCount} chunks)`
        : `Synced Docs: ${pagesCount}`;
  };

  const updateAudioStats = (stats: AudioAdapterStats): void => {
    audioStatsEl.textContent = `${stats.framesSent} frames · ${(stats.bytesSent / 1024).toFixed(1)} KB · role: ${stats.lastSpeakerRole}`;
  };

  const updateRollingWindow = (windowUtterances: UtteranceRecord[]): void => {
    windowCountEl.textContent = `${windowUtterances.length} / 4`;
    if (windowUtterances.length === 0) {
      windowListEl.innerHTML = '<div class="pact-window-empty">Waiting for live utterances…</div>';
      return;
    }

    windowListEl.innerHTML = '';
    for (const u of windowUtterances) {
      const item = document.createElement('div');
      item.className = 'pact-utterance-item';
      const meta = document.createElement('span');
      meta.className = 'pact-utterance-meta';
      meta.textContent = `[${u.speakerLabel} · role=${u.speakerRole} · ${u.latencyMs ?? 0}ms]`;
      const body = document.createElement('span');
      body.className = 'pact-utterance-text';
      body.textContent = ` ${u.text}`;
      item.append(meta, body);
      windowListEl.append(item);
    }
  };

  const updateSessionPacts = (pacts: PactRecord[]): void => {
    pactsCountEl.textContent = `${pacts.length} ${pacts.length === 1 ? 'pact' : 'pacts'}`;
    if (pacts.length === 0) {
      pactsListEl.innerHTML =
        '<div class="pact-window-empty">No commitments drafted in this session yet. Single-tap on the G2 lens to dispatch a drafted Pact to Notion &amp; Telegram.</div>';
      return;
    }

    pactsListEl.innerHTML = '';
    for (const p of [...pacts].reverse()) {
      const row = document.createElement('div');
      row.className = 'pact-ledger-item';
      row.dataset.status = p.status;

      const statusBadge = document.createElement('span');
      statusBadge.className = 'pact-ledger-badge';
      statusBadge.textContent =
        p.status === 'locked'
          ? `✓ LOCKED ${p.confirmedBy ?? ''}`.trim()
          : p.status.toUpperCase();

      const mainInfo = document.createElement('div');
      mainInfo.className = 'pact-ledger-main';
      mainInfo.textContent = `${p.title} · ${p.owner} · Due: ${p.dueText}`;

      row.append(statusBadge, mainInfo);
      pactsListEl.append(row);
    }
  };

  refreshNotionBtn.addEventListener('click', () => {
    void handlers.onRefreshNotionPages().then((pages) => {
      if (pages.length > 0) {
        setNotionPageOptions(pages);
      }
    });
  });

  syncNotionBtn.addEventListener('click', () => {
    const selected = Array.from(
      checklistEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')
    )
      .map((el) => el.value)
      .slice(0, 5);

    if (selected.length === 0) {
      notionStatusEl.textContent = 'Select at least 1 deal page first.';
      return;
    }

    notionStatusEl.textContent = 'Syncing blocks & cloud embeddings…';
    void handlers
      .onSyncNotionDealDocs(selected)
      .then((res) => {
        notionStatusEl.textContent = `✓ Synced ${res.pagesSynced} doc(s) · ${res.chunksStored} chunks`;
        updateSyncedDocsCount(res.pagesSynced, res.chunksStored);
      })
      .catch((err) => {
        notionStatusEl.textContent = `Sync error: ${err instanceof Error ? err.message : String(err)}`;
      });
  });

  tgPingBtn.addEventListener('click', () => {
    const chatId = tgChatInput.value.trim();
    if (!chatId) {
      tgPingStatusEl.textContent = 'Enter a Telegram Group Chat ID.';
      return;
    }
    tgPingStatusEl.textContent = 'Sending ping…';
    void handlers
      .onPingTelegramChat(chatId)
      .then((res) => {
        tgPingStatusEl.textContent = res.ok
          ? `✓ Linked (${chatId})${res.simulated ? ' · local mode' : ''}`
          : 'Ping failed';
      })
      .catch((err) => {
        tgPingStatusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      });
  });

  startBtn.addEventListener('click', () => {
    if (!consentCheckbox.checked) return;
    const mode = modeSelectEl.value as AudioCaptureMode;
    const chatId = tgChatInput.value.trim();
    void handlers.onStartSession(mode, chatId);
  });

  stopBtn.addEventListener('click', () => {
    void handlers.onStopSession();
  });

  testPcmBtn.addEventListener('click', () => {
    handlers.onStreamTestPcm();
  });

  simConflictBtn.addEventListener('click', () => {
    handlers.onSimulateUtterance('Since we agreed on a 15% revenue share cap for this deal...');
  });

  simPactBtn.addEventListener('click', () => {
    handlers.onSimulateUtterance('I will send the revised cap table PDF by Friday 5pm.');
  });

  simBanterBtn.addEventListener('click', () => {
    handlers.onSimulateUtterance(
      'Yeah right, we are excited to grab coffee in Dubai after the keynote.'
    );
  });

  root.querySelectorAll<HTMLButtonElement>('[data-hud-state]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stateKey = btn.dataset.hudState as HudStateType;
      const payload = SAMPLE_HUD_PAYLOADS[stateKey];
      if (payload) {
        void pactBridge.renderHudState(payload);
      }
    });
  });

  clearBtn.addEventListener('click', () => {
    logListEl.innerHTML = '';
  });

  return {
    appendLog,
    updateMirrorFrame,
    updateRelayStatus,
    updateSyncedDocsCount,
    updateAudioStats,
    updateRollingWindow,
    updateSessionPacts,
    setNotionPageOptions,
  };
}
