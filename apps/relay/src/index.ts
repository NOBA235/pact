import { formatHudFrame } from '@pact/shared';

export function getRelayHealth(): { status: string; sampleIdleFrame: string } {
  const frame = formatHudFrame({ state: 'DARK_IDLE' });
  return {
    status: 'ok',
    sampleIdleFrame: frame.text,
  };
}

if (process.argv[1]?.endsWith('index.ts')) {
  console.log('[pact-relay] Service ready:', getRelayHealth());
}
