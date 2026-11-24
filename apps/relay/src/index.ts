import 'dotenv/config';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  formatHudFrame,
  type ClientToRelayMessage,
  type RelayToClientMessage,
  type SpeakerRoleTag,
  type UtteranceRecord,
} from '@pact/shared';
import {
  DeepgramStreamSession,
  getActiveDeepgramSocketCount,
  type DeepgramConnectionState,
} from './stt/deepgramStream.js';
import { RollingUtteranceWindow, resolveSpeakerLabel } from './stt/contextWindow.js';
import { recordSessionStart, recordSessionStop } from './db/supabase.js';

interface ActiveClientSession {
  sessionId: string;
  ws: WebSocket;
  window: RollingUtteranceWindow;
  deepgram: DeepgramStreamSession | null;
  lastSpeakerRole: SpeakerRoleTag;
  lastChunkSentAt: number;
  framesReceived: number;
}

const activeSessions = new Map<WebSocket, ActiveClientSession>();
const recentFinalUtterances: UtteranceRecord[] = [];

export function getRelayHealth() {
  const frame = formatHudFrame({ state: 'DARK_IDLE' });
  return {
    status: 'ok',
    activeClientSessions: activeSessions.size,
    activeDeepgramSockets: getActiveDeepgramSocketCount(),
    recentFinalUtterancesCount: recentFinalUtterances.length,
    recentFinalUtterances: recentFinalUtterances.slice(-10),
    sampleIdleFrame: frame.text,
  };
}

function sendToClient(ws: WebSocket, message: RelayToClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function teardownClientSession(ws: WebSocket, reason: string): void {
  const session = activeSessions.get(ws);
  if (!session) return;

  if (session.deepgram) {
    session.deepgram.close();
    session.deepgram = null;
  }
  session.window.clear();
  activeSessions.delete(ws);

  void recordSessionStop(session.sessionId);
  console.log(
    `[pact-relay] Session ${session.sessionId} stopped (${reason}) | activeDeepgramSockets=${getActiveDeepgramSocketCount()}`
  );
}

export function createRelayServer(port: number = Number(process.env.PORT || 8787)) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/api/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRelayHealth()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const initialSessionId = randomUUID();
    const clientState: ActiveClientSession = {
      sessionId: initialSessionId,
      ws,
      window: new RollingUtteranceWindow(4),
      deepgram: null,
      lastSpeakerRole: 'unknown',
      lastChunkSentAt: Date.now(),
      framesReceived: 0,
    };
    activeSessions.set(ws, clientState);

    sendToClient(ws, {
      type: 'session.status',
      sessionId: clientState.sessionId,
      status: 'connected',
      deepgramState: 'idle',
      activeDeepgramSockets: getActiveDeepgramSocketCount(),
      message: 'Connected to PACT Relay',
    });

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      const session = activeSessions.get(ws);
      if (!session) return;

      if (isBinary) {
        const pcmBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        session.framesReceived += 1;
        session.deepgram?.sendPcmChunk(pcmBuf, session.lastSpeakerRole, session.lastChunkSentAt);
        return;
      }

      const rawText = typeof data === 'string' ? data : data.toString('utf8');
      let msg: ClientToRelayMessage;
      try {
        msg = JSON.parse(rawText) as ClientToRelayMessage;
      } catch {
        sendToClient(ws, {
          type: 'relay.error',
          code: 'INVALID_JSON',
          message: 'Failed to parse WebSocket JSON message',
        });
        return;
      }

      handleClientMessage(session, msg);
    });

    ws.on('close', () => {
      teardownClientSession(ws, 'ws_close');
    });

    ws.on('error', () => {
      teardownClientSession(ws, 'ws_error');
    });
  });

  function startDeepgramForSession(session: ActiveClientSession): void {
    if (session.deepgram) {
      session.deepgram.close();
      session.deepgram = null;
    }

    const dg = new DeepgramStreamSession({
      sessionId: session.sessionId,
      callbacks: {
        onStateChange: (dgState: DeepgramConnectionState) => {
          sendToClient(session.ws, {
            type: 'session.status',
            sessionId: session.sessionId,
            status: dgState === 'closed' ? 'stopped' : 'streaming',
            deepgramState: dgState,
            activeDeepgramSockets: getActiveDeepgramSocketCount(),
          });
        },
        onUtterance: (utterance: UtteranceRecord) => {
          const rollingWindow = utterance.isFinal
            ? session.window.push(utterance)
            : session.window.getRecent();

          if (utterance.isFinal) {
            recentFinalUtterances.push(utterance);
            if (recentFinalUtterances.length > 50) {
              recentFinalUtterances.shift();
            }
            console.log(
              `[STT Final] [${utterance.speakerLabel}] (role=${utterance.speakerRole}, latency=${utterance.latencyMs}ms, window=${rollingWindow.length}/4): "${utterance.text}"`
            );
          }

          sendToClient(session.ws, {
            type: 'stt.transcript',
            utterance,
            rollingWindow,
          });
        },
        onError: (err: Error) => {
          console.error(`[Deepgram Error] session=${session.sessionId}:`, err.message);
          sendToClient(session.ws, {
            type: 'relay.error',
            code: 'DEEPGRAM_ERROR',
            message: err.message,
          });
        },
      },
    });

    session.deepgram = dg;
    dg.start();
  }

  function handleClientMessage(session: ActiveClientSession, msg: ClientToRelayMessage): void {
    switch (msg.type) {
      case 'session.start': {
        if (msg.sessionId) {
          session.sessionId = msg.sessionId;
        }
        session.window.clear();
        session.framesReceived = 0;
        void recordSessionStart(session.sessionId);
        startDeepgramForSession(session);
        console.log(
          `[pact-relay] Session ${session.sessionId} started (audioSource=${msg.audioSource}) | activeDeepgramSockets=${getActiveDeepgramSocketCount()}`
        );
        break;
      }

      case 'session.stop': {
        if (session.deepgram) {
          session.deepgram.close();
          session.deepgram = null;
        }
        session.window.clear();
        void recordSessionStop(session.sessionId);
        sendToClient(session.ws, {
          type: 'session.status',
          sessionId: session.sessionId,
          status: 'stopped',
          deepgramState: 'closed',
          activeDeepgramSockets: getActiveDeepgramSocketCount(),
          message: 'Session stopped cleanly',
        });
        console.log(
          `[pact-relay] Session ${session.sessionId} stopped by client | activeDeepgramSockets=${getActiveDeepgramSocketCount()}`
        );
        break;
      }

      case 'audio.meta': {
        session.lastSpeakerRole = msg.speakerRole;
        session.lastChunkSentAt = msg.sentAt ?? Date.now();
        break;
      }

      case 'audio.chunk': {
        session.lastSpeakerRole = msg.speakerRole;
        session.lastChunkSentAt = msg.sentAt ?? Date.now();
        const pcmBuf = Buffer.from(msg.pcmBase64, 'base64');
        session.framesReceived += 1;
        session.deepgram?.sendPcmChunk(pcmBuf, session.lastSpeakerRole, session.lastChunkSentAt);
        break;
      }

      case 'stt.simulate': {
        const now = Date.now();
        const role = msg.speakerRole ?? 'self';
        const utterance: UtteranceRecord = {
          id: randomUUID(),
          sessionId: session.sessionId,
          text: msg.text.trim(),
          speakerLabel: msg.speakerLabel ?? resolveSpeakerLabel(role, role === 'self' ? 0 : 1),
          speakerRole: role,
          isFinal: true,
          latencyMs: Math.max(1, now - (msg.sentAt ?? now)),
          timestamp: now,
        };
        const rollingWindow = session.window.push(utterance);
        recentFinalUtterances.push(utterance);
        console.log(
          `[STT Final] [${utterance.speakerLabel}] (role=${utterance.speakerRole}, latency=${utterance.latencyMs}ms, window=${rollingWindow.length}/4): "${utterance.text}"`
        );
        sendToClient(session.ws, {
          type: 'stt.transcript',
          utterance,
          rollingWindow,
        });
        break;
      }

      case 'hud.tap': {
        console.log(
          `[HUD Input] session=${session.sessionId} tap=${msg.tapType} state=${msg.currentState}`
        );
        break;
      }
    }
  }

  return {
    server,
    wss,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(port, () => {
          const addr = server.address();
          const boundPort = typeof addr === 'object' && addr ? addr.port : port;
          console.log(`[pact-relay] HTTP + WebSocket server listening on http://localhost:${boundPort} (WS: /ws)`);
          resolve(boundPort);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of activeSessions.keys()) {
          teardownClientSession(ws, 'server_shutdown');
          ws.terminate();
        }
        wss.close(() => {
          server.close(() => resolve());
        });
      }),
  };
}

const isMainModule =
  process.argv[1]?.replace(/\\/g, '/').endsWith('apps/relay/src/index.ts') ||
  process.argv[1]?.endsWith('index.ts');

if (isMainModule) {
  const relay = createRelayServer();
  void relay.listen();
}
