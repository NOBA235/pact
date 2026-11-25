import 'dotenv/config';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  formatHudFrame,
  type ClientToRelayMessage,
  type HudPayload,
  type HudStateType,
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
import {
  recordSessionStart,
  recordSessionStop,
  recordDetectedConflict,
} from './db/supabase.js';
import {
  listNotionPages,
  syncSessionDocuments,
  queryTopDocChunks,
  getSyncedChunksForSession,
  type CustomSyncDocument,
} from './notion/indexer.js';
import {
  passesPreFilterGate,
  hasVerifiableTerms,
  detectContradiction,
} from './ai/detector.js';

export const HUD_AUTO_FADE_MS = 15000;
const GLOBAL_SYNC_SESSION_ID = 'global-deal-context';

interface ActiveClientSession {
  sessionId: string;
  ws: WebSocket;
  window: RollingUtteranceWindow;
  deepgram: DeepgramStreamSession | null;
  lastSpeakerRole: SpeakerRoleTag;
  lastChunkSentAt: number;
  framesReceived: number;
  currentHudState: HudStateType;
  autoFadeTimer: ReturnType<typeof setTimeout> | null;
}

const activeSessions = new Map<WebSocket, ActiveClientSession>();
const recentFinalUtterances: UtteranceRecord[] = [];
const recentConflicts: Array<{
  sessionId: string;
  docTitle: string;
  docFact: string;
  spokenClaim: string;
  confidence: number;
  latencyMs: number;
  timestamp: number;
}> = [];

export function getRelayHealth() {
  const frame = formatHudFrame({ state: 'DARK_IDLE' });
  return {
    status: 'ok',
    activeClientSessions: activeSessions.size,
    activeDeepgramSockets: getActiveDeepgramSocketCount(),
    syncedGlobalChunks: getSyncedChunksForSession(GLOBAL_SYNC_SESSION_ID).length,
    recentFinalUtterancesCount: recentFinalUtterances.length,
    recentFinalUtterances: recentFinalUtterances.slice(-10),
    recentConflicts: recentConflicts.slice(-10),
    sampleIdleFrame: frame.text,
  };
}

function sendToClient(ws: WebSocket, message: RelayToClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function clearAutoFadeTimer(session: ActiveClientSession): void {
  if (session.autoFadeTimer) {
    clearTimeout(session.autoFadeTimer);
    session.autoFadeTimer = null;
  }
}

function pushHudFrameToSession(
  session: ActiveClientSession,
  payload: HudPayload,
  autoFadeMs: number = 0
): void {
  clearAutoFadeTimer(session);
  const frame = formatHudFrame(payload);
  session.currentHudState = frame.state;

  sendToClient(session.ws, {
    type: 'hud.frame',
    payload,
    frame,
  });

  if (autoFadeMs > 0 && frame.state !== 'DARK_IDLE') {
    session.autoFadeTimer = setTimeout(() => {
      session.autoFadeTimer = null;
      const idlePayload: HudPayload = { state: 'DARK_IDLE' };
      const idleFrame = formatHudFrame(idlePayload);
      session.currentHudState = 'DARK_IDLE';
      sendToClient(session.ws, {
        type: 'hud.frame',
        payload: idlePayload,
        frame: idleFrame,
      });
    }, autoFadeMs);
  }
}

function teardownClientSession(ws: WebSocket, reason: string): void {
  const session = activeSessions.get(ws);
  if (!session) return;

  clearAutoFadeTimer(session);
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

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, any>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function evaluateUtteranceForContradiction(
  session: ActiveClientSession,
  utterance: UtteranceRecord,
  rollingWindow: UtteranceRecord[]
): Promise<void> {
  const startTime = Date.now();
  const text = utterance.text.trim();

  if (!passesPreFilterGate(text) || !hasVerifiableTerms(text)) {
    return;
  }

  // Search session-specific chunks first, falling back to global synced deal chunks
  let topChunks = await queryTopDocChunks(session.sessionId, text, 3);
  if (topChunks.length === 0) {
    topChunks = await queryTopDocChunks(GLOBAL_SYNC_SESSION_ID, text, 3);
  }
  if (topChunks.length === 0) {
    return;
  }

  const recentUtterances = rollingWindow.filter((u) => u.id !== utterance.id).slice(-3);
  const result = await detectContradiction({
    utterance,
    recentUtterances,
    topChunks,
  });

  if (result.type === 'conflict' && result.confidence >= 0.85) {
    const totalLatencyMs = Date.now() - (utterance.timestamp - (utterance.latencyMs ?? 0));
    const detectorLatencyMs = Date.now() - startTime;
    const conflictPayload: HudPayload = {
      state: 'CONFLICT',
      docTitle: result.docTitle,
      docFact: result.docFact,
      spokenClaim: result.spokenClaim,
    };

    pushHudFrameToSession(session, conflictPayload, HUD_AUTO_FADE_MS);

    recentConflicts.push({
      sessionId: session.sessionId,
      docTitle: result.docTitle,
      docFact: result.docFact,
      spokenClaim: result.spokenClaim,
      confidence: result.confidence,
      latencyMs: totalLatencyMs,
      timestamp: Date.now(),
    });

    void recordDetectedConflict({
      sessionId: session.sessionId,
      docTitle: result.docTitle,
      docFact: result.docFact,
      spokenClaim: result.spokenClaim,
      sourceQuote: text,
      confidence: result.confidence,
    });

    console.log(
      `[CONFLICT RADAR] ! CONFLICT · ${result.docTitle} | Doc: ${result.docFact} | Said: ${result.spokenClaim} (conf=${result.confidence}, radar=${detectorLatencyMs}ms, total=${totalLatencyMs}ms)`
    );
  }
}

export function createRelayServer(port: number = Number(process.env.PORT || 8787)) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/api/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRelayHealth()));
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/notion/pages') {
      try {
        const pages = await listNotionPages();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pages }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/sessions/sync') {
      try {
        const body = await readJsonBody(req);
        const sessionId =
          typeof body.sessionId === 'string' && body.sessionId.trim()
            ? body.sessionId.trim()
            : GLOBAL_SYNC_SESSION_ID;
        const pageIds = Array.isArray(body.pageIds)
          ? body.pageIds.map((p: unknown) => String(p))
          : [];
        const customDocs = Array.isArray(body.customDocs)
          ? (body.customDocs as CustomSyncDocument[])
          : [];

        const syncResult = await syncSessionDocuments({
          sessionId,
          pageIds,
          customDocs,
        });

        // Also mirror into GLOBAL_SYNC_SESSION_ID so active and subsequent sessions on this relay can query immediately
        if (sessionId !== GLOBAL_SYNC_SESSION_ID) {
          await syncSessionDocuments({
            sessionId: GLOBAL_SYNC_SESSION_ID,
            pageIds,
            customDocs,
          });
        }

        console.log(
          `[Notion Sync] session=${sessionId} pages=${syncResult.pagesSynced} chunks=${syncResult.chunksStored} titles=${JSON.stringify(syncResult.docTitles)}`
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...syncResult }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
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
      currentHudState: 'DARK_IDLE',
      autoFadeTimer: null,
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

  function handleFinalizedUtterance(
    session: ActiveClientSession,
    utterance: UtteranceRecord
  ): void {
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

    if (utterance.isFinal) {
      void evaluateUtteranceForContradiction(session, utterance, rollingWindow);
    }
  }

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
          handleFinalizedUtterance(session, utterance);
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
        clearAutoFadeTimer(session);
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
        const role = msg.speakerRole ?? 'other';
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
        handleFinalizedUtterance(session, utterance);
        break;
      }

      case 'hud.tap': {
        console.log(
          `[HUD Input] session=${session.sessionId} tap=${msg.tapType} state=${msg.currentState}`
        );
        if (
          msg.tapType === 'double_tap' &&
          (session.currentHudState === 'CONFLICT' ||
            session.currentHudState === 'PACT_DRAFT' ||
            msg.currentState === 'CONFLICT' ||
            msg.currentState === 'PACT_DRAFT')
        ) {
          pushHudFrameToSession(session, { state: 'DARK_IDLE' }, 0);
        }
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
          console.log(
            `[pact-relay] HTTP + WebSocket server listening on http://localhost:${boundPort} (WS: /ws)`
          );
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
