import type {
  AudioCaptureMode,
  FormattedHudFrame,
  HudPayload,
  HudStateType,
  UtteranceRecord,
} from '@pact/shared';
import type { PactEvenBridge } from '../sdk/evenBridge.js';
import type { AudioAdapterStats } from '../audio/audioAdapter.js';

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
  onStartSession: (mode: AudioCaptureMode) => Promise<void>;
  onStopSession: () => Promise<void>;
  onStreamTestPcm: () => void;
}

export interface TestBarController {
  appendLog: (entry: string) => void;
  updateMirrorFrame: (frame: FormattedHudFrame) => void;
  updateRelayStatus: (connected: boolean, deepgramState: string, activeSockets: number) => void;
  updateAudioStats: (stats: AudioAdapterStats) => void;
  updateRollingWindow: (windowUtterances: UtteranceRecord[]) => void;
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
        <div class="pact-pill-row">
          <div class="pact-status-pill" id="bridge-status">Bridge: Initializing…</div>
          <div class="pact-status-pill" id="relay-status">Relay: Connecting…</div>
          <div class="pact-status-pill" id="dg-status">STT: Idle</div>
        </div>
      </header>

      <section class="pact-lens-card" aria-label="Simulated 576x288 G2 Waveguide Mirror">
        <div class="pact-lens-meta">
          <span>G2 WAVEGUIDE MIRROR (576×288 · 3×28 CHARS)</span>
          <span id="hud-state-badge">STATE: DARK_IDLE</span>
        </div>
        <div class="pact-lens-screen" id="lens-screen">
          <pre class="pact-lens-pre" id="lens-pre">PACT · ACTIVE\n\n</pre>
        </div>
      </section>

      <section class="pact-controls-card" aria-label="Live Audio &amp; STT Session Controls">
        <div class="pact-logs-header">
          <h2 class="pact-section-title">Live 16 kHz Ephemeral Audio &amp; Deepgram STT</h2>
          <span class="pact-audio-stats" id="audio-stats-label">0 frames · 0 B · role: unknown</span>
        </div>
        <div class="pact-session-row">
          <label class="pact-select-label" for="audio-mode-select">Audio Input Source</label>
          <select id="audio-mode-select" class="pact-select">
            <option value="g2_bridge">G2 Bridge / Simulator (--aid) 16kHz PCM</option>
            <option value="browser_mic">Browser AudioContext 16kHz PCM Fallback</option>
          </select>
          <button type="button" class="pact-btn pact-btn-ok" id="start-session-btn">Start Session</button>
          <button type="button" class="pact-btn pact-btn-warn" id="stop-session-btn">Stop Session</button>
          <button type="button" class="pact-btn" id="test-pcm-btn">Inject 16kHz G2 Audio Burst</button>
        </div>
        <div class="pact-window-box">
          <div class="pact-window-header">
            <span>Rolling 4-Utterance Context Window (Zero Audio Persistence)</span>
            <span id="window-count-badge">0 / 4</span>
          </div>
          <div class="pact-window-list" id="rolling-window-list">
            <div class="pact-window-empty">No finalized utterances yet. Start a session and speak into the mic.</div>
          </div>
        </div>
      </section>

      <section class="pact-controls-card" aria-label="5-State HUD Test Controls">
        <h2 class="pact-section-title">5-State HUD Trigger Console</h2>
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
      </section>

      <section class="pact-logs-card" aria-label="G2 Tap and Bridge Event Logs">
        <div class="pact-logs-header">
          <h2 class="pact-section-title">Tap, Audio &amp; Bridge Event Logs</h2>
          <button type="button" class="pact-btn-small" id="clear-logs-btn">Clear</button>
        </div>
        <div class="pact-log-list" id="tap-log-list" role="log" aria-live="polite"></div>
      </section>
    </main>
  `;

  const statusEl = root.querySelector<HTMLElement>('#bridge-status')!;
  const relayStatusEl = root.querySelector<HTMLElement>('#relay-status')!;
  const dgStatusEl = root.querySelector<HTMLElement>('#dg-status')!;
  const audioStatsEl = root.querySelector<HTMLElement>('#audio-stats-label')!;
  const modeSelectEl = root.querySelector<HTMLSelectElement>('#audio-mode-select')!;
  const startBtn = root.querySelector<HTMLButtonElement>('#start-session-btn')!;
  const stopBtn = root.querySelector<HTMLButtonElement>('#stop-session-btn')!;
  const testPcmBtn = root.querySelector<HTMLButtonElement>('#test-pcm-btn')!;
  const windowCountEl = root.querySelector<HTMLElement>('#window-count-badge')!;
  const windowListEl = root.querySelector<HTMLElement>('#rolling-window-list')!;
  const stateBadgeEl = root.querySelector<HTMLElement>('#hud-state-badge')!;
  const lensPreEl = root.querySelector<HTMLElement>('#lens-pre')!;
  const lensScreenEl = root.querySelector<HTMLElement>('#lens-screen')!;
  const logListEl = root.querySelector<HTMLElement>('#tap-log-list')!;
  const clearBtn = root.querySelector<HTMLButtonElement>('#clear-logs-btn')!;

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
    activeSockets: number
  ): void => {
    relayStatusEl.textContent = connected ? 'Relay: Connected' : 'Relay: Disconnected';
    relayStatusEl.dataset.ready = connected ? 'true' : 'false';
    dgStatusEl.textContent = `STT: ${deepgramState} (sockets: ${activeSockets})`;
  };

  const updateAudioStats = (stats: AudioAdapterStats): void => {
    audioStatsEl.textContent = `${stats.framesSent} frames · ${(stats.bytesSent / 1024).toFixed(1)} KB · role: ${stats.lastSpeakerRole}`;
  };

  const updateRollingWindow = (windowUtterances: UtteranceRecord[]): void => {
    windowCountEl.textContent = `${windowUtterances.length} / 4`;
    if (windowUtterances.length === 0) {
      windowListEl.innerHTML =
        '<div class="pact-window-empty">No finalized utterances yet. Start a session and speak into the mic.</div>';
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

  startBtn.addEventListener('click', () => {
    const mode = modeSelectEl.value as AudioCaptureMode;
    void handlers.onStartSession(mode);
  });

  stopBtn.addEventListener('click', () => {
    void handlers.onStopSession();
  });

  testPcmBtn.addEventListener('click', () => {
    handlers.onStreamTestPcm();
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
    updateAudioStats,
    updateRollingWindow,
  };
}
