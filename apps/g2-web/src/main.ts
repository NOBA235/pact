import './style.css';
import { PactEvenBridge } from './sdk/evenBridge.js';
import { mountTestBar, SAMPLE_HUD_PAYLOADS } from './ui/testBar.js';
import type { HudStateType } from '@pact/shared';

declare global {
  interface Window {
    __pactSetHudState?: (state: HudStateType) => Promise<void>;
    __pactBridge?: PactEvenBridge;
  }
}

async function bootstrap(): Promise<void> {
  const appRoot = document.querySelector<HTMLElement>('#app');
  if (!appRoot) {
    throw new Error('Missing #app root container');
  }

  let controller: ReturnType<typeof mountTestBar> | null = null;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  const stateOrder: HudStateType[] = [
    'DARK_IDLE',
    'CONFLICT',
    'PACT_DRAFT',
    'SENT_PENDING',
    'LOCKED_PULSE',
  ];

  const pactBridge = new PactEvenBridge({
    onLog: (msg) => {
      controller?.appendLog(msg);
    },
    onFrameRendered: (frame) => {
      controller?.updateMirrorFrame(frame);
      if (pulseTimer) {
        clearTimeout(pulseTimer);
        pulseTimer = null;
      }
      if (frame.state === 'LOCKED_PULSE') {
        pulseTimer = setTimeout(() => {
          void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS.DARK_IDLE);
        }, 3000);
      }
    },
    onSingleTap: (source) => {
      const current = pactBridge.getCurrentFrame().state;
      controller?.appendLog(`onSingleTap() triggered in state=${current} (source=${source})`);
      if (current === 'PACT_DRAFT') {
        void pactBridge.renderHudState(SAMPLE_HUD_PAYLOADS.SENT_PENDING);
      }
    },
    onDoubleTap: (source) => {
      const current = pactBridge.getCurrentFrame().state;
      controller?.appendLog(`onDoubleTap() triggered in state=${current} (source=${source})`);
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
  });

  controller = mountTestBar(appRoot, pactBridge);

  window.__pactBridge = pactBridge;
  window.__pactSetHudState = async (state: HudStateType) => {
    const payload = SAMPLE_HUD_PAYLOADS[state];
    if (payload) {
      await pactBridge.renderHudState(payload);
    }
  };

  await pactBridge.init();
}

void bootstrap();
