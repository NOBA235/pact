import './style.css';
import { AudioSpeakerRole } from '@evenrealities/even_hub_sdk';
import { PactEvenBridge } from './sdk/evenBridge.js';
import { PactRelayClient } from './ws/relayClient.js';
import { PactAudioAdapter, BYTES_PER_FRAME } from './audio/audioAdapter.js';
import { mountTestBar, SAMPLE_HUD_PAYLOADS } from './ui/testBar.js';
import type { AudioCaptureMode, HudStateType } from '@pact/shared';

declare global {
  interface Window {
    __pactSetHudState?: (state: HudStateType) => Promise<void>;
    __pactStartSession?: (mode?: AudioCaptureMode) => Promise<void>;
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
  let activeSessionId = `session-${Date.now()}`;
  let dgState = 'idle';
  let dgSockets = 0;
  let hudFadeTimer: ReturnType<typeof setTimeout> | null = null;
  const relayHttpBase =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_RELAY_HTTP_URL || 'http://localhost:8787';

  const stateOrder: HudStateType[] = [
    'DARK_IDLE',
    'CONFLICT',
    'PACT_DRAFT',
    'SENT_PENDING',
    'LOCKED_PULSE',
  ];

  const relayClient = new PactRelayClient({
    onLog: (msg) => controller?.appendLog(msg),
    onConnectionChange: (connected) => {
      controller?.updateRelayStatus(connected, dgState, dgSockets);
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
        case 'relay.error': {
          controller?.appendLog(`Relay Error [${msg.code}]: ${msg.message}`);
          break;
        }
      }
    },
  });

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
      const current = pactBridge.getCurrentFrame().state;
      controller?.appendLog(`onSingleTap() triggered in state=${current} (source=${source})`);
      relayClient.sendHudTap('single_tap', current);
      if (current === 'PACT_DRAFT') {
        void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS.SENT_PENDING);
      }
    },
    onDoubleTap: (source) => {
      const current = pactBridge.getCurrentFrame().state;
      controller?.appendLog(`onDoubleTap() triggered in state=${current} (source=${source})`);
      relayClient.sendHudTap('double_tap', current);
      if (current === 'PACT_DRAFT' || current === 'CONFLICT') {
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

  const handleStartSession = async (mode: AudioCaptureMode = 'g2_bridge'): Promise<void> => {
    activeSessionId = `session-${Date.now()}`;
    relayClient.startSession(mode, activeSessionId);
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

  const handleSyncNotionDealDoc = async (pageId: string = 'demo-sow-2026'): Promise<void> => {
    try {
      const res = await fetch(`${relayHttpBase}/api/sessions/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSessionId,
          pageIds: [pageId],
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        pagesSynced?: number;
        chunksStored?: number;
        docTitles?: string[];
        error?: string;
      };
      if (data.ok) {
        controller?.appendLog(
          `Synced Notion doc (${data.docTitles?.join(', ')}): ${data.chunksStored} chunks embedded in pgvector`
        );
      } else {
        controller?.appendLog(`Notion sync error: ${data.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      controller?.appendLog(`Notion sync request failed: ${msg}`);
    }
  };

  controller = mountTestBar(appRoot, pactBridge, {
    onStartSession: handleStartSession,
    onStopSession: handleStopSession,
    onStreamTestPcm: () => handleInjectPcmBurst('self'),
    onSyncNotionDealDoc: handleSyncNotionDealDoc,
    onSimulateUtterance: (text) => {
      relayClient.sendSyntheticSpeech(text, 'other');
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
