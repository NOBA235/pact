import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import type { UtteranceRecord } from '@pact/shared';
import { RollingUtteranceWindow, resolveSpeakerLabel } from './contextWindow.js';
import {
  DeepgramStreamSession,
  buildDeepgramStreamingUrl,
  getActiveDeepgramSocketCount,
} from './deepgramStream.js';

describe('RollingUtteranceWindow & DeepgramStreamSession', () => {
  it('maintains a strict 4-utterance rolling context window with speakerRole metadata', () => {
    const win = new RollingUtteranceWindow(4);

    for (let i = 1; i <= 6; i++) {
      win.push({
        id: `u-${i}`,
        sessionId: 'sess-1',
        text: `Utterance number ${i}`,
        speakerLabel: resolveSpeakerLabel(i % 2 === 0 ? 'self' : 'other', i % 2),
        speakerRole: i % 2 === 0 ? 'self' : 'other',
        isFinal: true,
        timestamp: 1000 + i,
      });
    }

    const recent = win.getRecent();
    assert.equal(recent.length, 4);
    assert.deepEqual(
      recent.map((u) => u.id),
      ['u-3', 'u-4', 'u-5', 'u-6']
    );
    assert.equal(recent[1]?.speakerRole, 'self');
    assert.equal(recent[1]?.speakerLabel, 'Self (G2 · S0)');
  });

  it('builds the verified Deepgram Streaming URL with 16kHz linear16, endpointing=350, diarize=true', () => {
    const url = new URL(buildDeepgramStreamingUrl());
    assert.equal(url.searchParams.get('encoding'), 'linear16');
    assert.equal(url.searchParams.get('sample_rate'), '16000');
    assert.equal(url.searchParams.get('channels'), '1');
    assert.equal(url.searchParams.get('interim_results'), 'true');
    assert.equal(url.searchParams.get('endpointing'), '350');
    assert.equal(url.searchParams.get('diarize'), 'true');
  });

  it('streams 16kHz PCM to a Deepgram WSS server, emits finalized utterances in <1s, and tears down cleanly with 0 leaked sockets', async () => {
    // Spin up an ephemeral local mock Deepgram WSS server
    const wss = new WebSocketServer({ port: 0 });
    const address = wss.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    wss.on('connection', (socket, req) => {
      assert.equal(req.headers.authorization, 'Token test-dg-key');
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          socket.send(
            JSON.stringify({
              type: 'Results',
              is_final: true,
              speech_final: true,
              channel: {
                alternatives: [
                  {
                    transcript: 'We agree to deliver the Q1 API integration by Friday.',
                    confidence: 0.98,
                    words: [{ word: 'We', start: 0, end: 0.2, confidence: 0.99, speaker: 0 }],
                  },
                ],
              },
            })
          );
        }
      });
    });

    try {
      const received: UtteranceRecord[] = [];

      // Start & stop 3 consecutive sessions to verify zero socket leaks
      for (let cycle = 0; cycle < 3; cycle++) {
        const session = new DeepgramStreamSession({
          sessionId: `sess-cycle-${cycle}`,
          apiKey: 'test-dg-key',
          endpointUrl: `ws://127.0.0.1:${port}/v1/listen`,
          callbacks: {
            onUtterance: (u) => received.push(u),
          },
        });

        session.start();

        // Wait for open
        for (let i = 0; i < 20; i++) {
          if (session.getState() === 'open') break;
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(session.getState(), 'open');
        assert.equal(getActiveDeepgramSocketCount(), 1);

        const pcmFrame = Buffer.alloc(3200, 1);
        session.sendPcmChunk(pcmFrame, 'self', Date.now());

        // Wait for utterance callback
        for (let i = 0; i < 20; i++) {
          if (received.length === cycle + 1) break;
          await new Promise((r) => setTimeout(r, 20));
        }

        assert.equal(received.length, cycle + 1);
        const latest = received[cycle]!;
        assert.equal(latest.isFinal, true);
        assert.equal(latest.speakerRole, 'self');
        assert.ok((latest.latencyMs ?? 9999) < 1000, `Expected <1000ms latency, got ${latest.latencyMs}ms`);

        session.close();
        assert.equal(getActiveDeepgramSocketCount(), 0);
      }
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
