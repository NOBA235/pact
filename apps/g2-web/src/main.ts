import './style.css';
import { AudioSpeakerRole } from '@evenrealities/even_hub_sdk';
import { PactEvenBridge } from './sdk/evenBridge.js';
import { PactRelayClient } from './ws/relayClient.js';
import { PactAudioAdapter, BYTES_PER_FRAME } from './audio/audioAdapter.js';
import {
  mountTestBar,
  SAMPLE_HUD_PAYLOADS,
  type NotionPageOption,
} from './ui/testBar.js';
import type { AudioCaptureMode, HudStateType } from '@pact/shared';

declare global {
  interface Window {
    __pactSetHudState?: (state: HudStateType) => Promise<void>;
    __pactStartSession?: (mode?: AudioCaptureMode, telegramChatId?: string) => Promise<void>;
    __pactStopSession?: () => Promise<void>;
    __pactInjectPcmBurst?: (role?: 'self' | 'other') => void;
    __pactBridge?: PactEvenBridge;
    __pactRelay?: PactRelayClient;
    __pactAudio?: PactAudioAdapter;
  }
}

/**
 * Generates a 100 ms (3,200 byte) 16 kHz S16LE 440 Hz tone frame for testing
 * the G2 AudioEvent -> AudioAdapter -> WebSocket -> Deepgram pipeline when
 * no physical microphone hardware is attached.
 */
function createTest16kHzPcmFrame(): Uint8Array {
  const samples = BYTES_PER_FRAME / 2;
  const int16 = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    int16[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 6000);
  }
  return new Uint8Array(int16.buffer);
}

async function bootstrap(): Promise<void> {
  const appRoot = document.querySelector<HTMLElement>('#app');
  if (!appRoot) {
    throw new Error('Missing #app root container');
  }

  let controller: ReturnType<typeof mountTestBar> | null = null;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  let hudFadeTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSessionId = `session-${Date.now()}`;
  let dgState = 'idle';
  let dgSockets = 0;

  const stateOrder: HudStateType[] = [
    'DARK_IDLE',
    'CONFLICT',
    'PACT_DRAFT',
    'SENT_PENDING',
    'LOCKED_PULSE',
  ];

  const relayClient = new PactRelayClient({
    onLog: (msg) => controller?.appendLog(msg),
    onConnectionChange: (connected, _url, reconnectingInMs) => {
      controller?.updateRelayStatus(connected, dgState, dgSockets, reconnectingInMs);
      if (connected) {
        void fetchNotionPages().then((pages) => {
          if (pages.length > 0) {
            controller?.setNotionPageOptions(pages);
          }
        });
      }
    },
    onMessage: (msg) => {
      switch (msg.type) {
        case 'session.status': {
          activeSessionId = msg.sessionId;
          dgState = msg.deepgramState;
          dgSockets = msg.activeDeepgramSockets;
          controller?.updateRelayStatus(relayClient.isConnected(), dgState, dgSockets);
          controller?.appendLog(
            `Session ${msg.sessionId}: status=${msg.status}, deepgram=${msg.deepgramState}, activeSockets=${msg.activeDeepgramSockets}`
          );
          break;
        }
        case 'stt.transcript': {
          const u = msg.utterance;
          if (u.isFinal) {
            controller?.appendLog(
              `STT Final [${u.speakerLabel}] (${u.latencyMs ?? 0}ms): "${u.text}"`
            );
            controller?.updateRollingWindow(msg.rollingWindow);
          }
          break;
        }
        case 'hud.frame': {
          void pactBridge.renderHudState(msg.payload);
          break;
        }
        case 'pact.updated': {
          controller?.updateSessionPacts(msg.sessionPacts);
          controller?.appendLog(
            `Pact [${msg.pact.status.toUpperCase()}]: "${msg.pact.title}" (${msg.pact.owner} · ${msg.pact.dueText})${msg.pact.confirmedBy ? ` — ${msg.pact.confirmedBy}` : ''}`
          );
          break;
        }
        case 'relay.error': {
          controller?.appendLog(`Relay Error [${msg.code}]: ${msg.message}`);
          break;
        }
      }
    },
  });

  const relayHttpBase = relayClient.getHttpBaseUrl();
  let audioAdapter: PactAudioAdapter | null = null;

  const pactBridge = new PactEvenBridge({
    onLog: (msg) => {
      controller?.appendLog(msg);
    },
    onAudioFrame: (audioEvent) => {
      audioAdapter?.handleBridgeAudioEvent(audioEvent);
    },
    onFrameRendered: (frame) => {
      controller?.updateMirrorFrame(frame);
      if (pulseTimer) {
        clearTimeout(pulseTimer);
        pulseTimer = null;
      }
      if (hudFadeTimer) {
        clearTimeout(hudFadeTimer);
        hudFadeTimer = null;
      }
      if (frame.state === 'LOCKED_PULSE') {
        pulseTimer = setTimeout(() => {
          void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS.DARK_IDLE);
        }, 3000);
      } else if (frame.state === 'CONFLICT' || frame.state === 'PACT_DRAFT') {
        hudFadeTimer = setTimeout(() => {
          void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS.DARK_IDLE);
        }, 15000);
      }
    },
    onSingleTap: (source) => {
      const currentFrame = pactBridge.getCurrentFrame();
      const current = currentFrame.state;
      controller?.appendLog(`onSingleTap() triggered in state=${current} (source=${source})`);
      const sentToRelay = relayClient.sendHudTap('single_tap', current);
      if (!sentToRelay && current === 'PACT_DRAFT') {
        void pactBridge.renderHudState({
          state: 'SENT_PENDING',
          title: currentFrame.lines[1] || 'Pending Pact',
        });
      }
    },
    onDoubleTap: (source) => {
      const current = pactBridge.getCurrentFrame().state;
      controller?.appendLog(`onDoubleTap() triggered in state=${current} (source=${source})`);
      const sentToRelay = relayClient.sendHudTap('double_tap', current);
      if (!sentToRelay && (current === 'PACT_DRAFT' || current === 'CONFLICT')) {
        void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS.DARK_IDLE);
      }
    },
    onScrollDown: () => {
      const current = pactBridge.getCurrentFrame().state;
      const idx = stateOrder.indexOf(current);
      const next = stateOrder[(idx + 1) % stateOrder.length]!;
      void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS[next]);
    },
    onScrollUp: () => {
      const current = pactBridge.getCurrentFrame().state;
      const idx = stateOrder.indexOf(current);
      const prev = stateOrder[(idx - 1 + stateOrder.length) % stateOrder.length]!;
      void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS[prev]);
    },
    onLongPress: () => {
      void (async () => {
        await handleStartSession('g2_bridge');
        setTimeout(() => {
          handleInjectPcmBurst('self');
        }, 120);
      })();
    },
    onLongPressRelease: () => {
      void handleStopSession();
    },
  });

  audioAdapter = new PactAudioAdapter(pactBridge, relayClient, {
    onLog: (msg) => controller?.appendLog(msg),
    onStatsChange: (stats) => controller?.updateAudioStats(stats),
  });

  const fetchNotionPages = async (): Promise<NotionPageOption[]> => {
    try {
      const res = await fetch(`${relayHttpBase}/api/notion/pages`);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        ok: boolean;
        pages?: Array<{ id: string; title: string; source?: string }>;
      };
      return data.pages ?? [];
    } catch {
      return [];
    }
  };

  const handleSyncNotionDealDocs = async (
    pageIds: string[]
  ): Promise<{ pagesSynced: number; chunksStored: number }> => {
    const res = await fetch(`${relayHttpBase}/api/sessions/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: activeSessionId,
        pageIds,
      }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      pagesSynced?: number;
      chunksStored?: number;
      docTitles?: string[];
      error?: string;
    };
    if (!data.ok) {
      throw new Error(data.error || 'Failed to sync Notion pages');
    }
    const pagesSynced = data.pagesSynced ?? pageIds.length;
    const chunksStored = data.chunksStored ?? 0;
    controller?.appendLog(
      `Synced Notion docs (${data.docTitles?.join(', ')}): ${chunksStored} chunks embedded in pgvector`
    );
    return { pagesSynced, chunksStored };
  };

  const handlePingTelegramChat = async (
    chatId: string
  ): Promise<{ ok: boolean; simulated?: boolean }> => {
    const res = await fetch(`${relayHttpBase}/api/telegram/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId }),
    });
    const data = (await res.json()) as { ok: boolean; simulated?: boolean; error?: string };
    if (!data.ok) {
      throw new Error(data.error || 'Telegram ping failed');
    }
    controller?.appendLog(`Telegram chat ${chatId} verified via /api/telegram/ping`);
    return data;
  };

  const handleStartSession = async (
    mode: AudioCaptureMode = 'g2_bridge',
    telegramChatId?: string
  ): Promise<void> => {
    activeSessionId = `session-${Date.now()}`;
    relayClient.startSession(mode, activeSessionId, telegramChatId);
    await audioAdapter!.start(mode);
  };

  const handleStopSession = async (): Promise<void> => {
    await audioAdapter!.stop();
    relayClient.stopSession(activeSessionId);
  };

  const handleInjectPcmBurst = (role: 'self' | 'other' = 'self'): void => {
    const sdkRole = role === 'self' ? AudioSpeakerRole.Self : AudioSpeakerRole.Other;
    const frame = createTest16kHzPcmFrame();
    for (let i = 0; i < 4; i++) {
      pactBridge.emitAudioEvent(frame, sdkRole, 0);
    }
    controller?.appendLog(`Injected 4x100ms 16kHz S16LE G2 AudioEvents (speakerRole=${role})`);
  };

  controller = mountTestBar(appRoot, pactBridge, {
    onStartSession: handleStartSession,
    onStopSession: handleStopSession,
    onStreamTestPcm: () => handleInjectPcmBurst('self'),
    onSyncNotionDealDocs: handleSyncNotionDealDocs,
    onRefreshNotionPages: fetchNotionPages,
    onPingTelegramChat: handlePingTelegramChat,
    onSimulateUtterance: (text) => {
      const role = /\b(?:i\s+will|i'll|we\s+will|we'll|i\s+commit)\b/i.test(text)
        ? 'self'
        : 'other';
      relayClient.sendSyntheticSpeech(text, role);
    },
  });

  window.__pactBridge = pactBridge;
  window.__pactRelay = relayClient;
  window.__pactAudio = audioAdapter;
  window.__pactSetHudState = async (state: HudStateType) => {
    const payload = SAMPLE_HUD_PAYLOADS[state];
    if (payload) {
      await pactBridge.renderHudState(payload);
    }
  };
  window.__pactStartSession = handleStartSession;
  window.__pactStopSession = handleStopSession;
  window.__pactInjectPcmBurst = handleInjectPcmBurst;

  relayClient.connect();
  await pactBridge.init();
}

void bootstrap();
