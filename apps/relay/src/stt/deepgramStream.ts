import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { SpeakerRoleTag, UtteranceRecord } from '@pact/shared';
import { resolveSpeakerLabel } from './contextWindow.js';

export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  punctuated_word?: string;
}

export interface DeepgramTranscriptResponse {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: DeepgramWord[];
    }>;
  };
}

export type DeepgramConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error'
  | 'fallback';

export interface DeepgramStreamCallbacks {
  onStateChange?: (state: DeepgramConnectionState) => void;
  onUtterance?: (utterance: UtteranceRecord) => void;
  onError?: (error: Error) => void;
}

export interface DeepgramStreamOptions {
  sessionId: string;
  apiKey?: string;
  endpointUrl?: string;
  callbacks: DeepgramStreamCallbacks;
}

const activeDeepgramSockets = new Set<WebSocket>();

export function getActiveDeepgramSocketCount(): number {
  return activeDeepgramSockets.size;
}

export function buildDeepgramStreamingUrl(baseUrl = 'wss://api.deepgram.com/v1/listen'): string {
  const url = new URL(baseUrl);
  url.searchParams.set('model', 'nova-2');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', '16000');
  url.searchParams.set('channels', '1');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '350');
  url.searchParams.set('diarize', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  return url.toString();
}

/**
 * Manages a single per-session Deepgram Streaming WSS connection
 * (encoding=linear16, sample_rate=16000, channels=1, interim_results=true, endpointing=350, diarize=true).
 * Guarantees deterministic teardown with zero socket or timer leaks.
 */
export class DeepgramStreamSession {
  private readonly sessionId: string;
  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly callbacks: DeepgramStreamCallbacks;

  private ws: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private state: DeepgramConnectionState = 'idle';
  private closed = false;

  private latestSpeakerRole: SpeakerRoleTag = 'unknown';
  private lastChunkSentAt: number = Date.now();
  private fallbackEnergyFrames = 0;

  constructor(options: DeepgramStreamOptions) {
    this.sessionId = options.sessionId;
    this.apiKey = (options.apiKey ?? process.env.DEEPGRAM_API_KEY ?? '').trim();
    this.endpointUrl = buildDeepgramStreamingUrl(
      options.endpointUrl ?? process.env.DEEPGRAM_WSS_URL ?? 'wss://api.deepgram.com/v1/listen'
    );
    this.callbacks = options.callbacks;
  }

  public getState(): DeepgramConnectionState {
    return this.state;
  }

  private setState(next: DeepgramConnectionState): void {
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  public start(): void {
    if (this.closed) return;

    if (!this.apiKey) {
      this.setState('fallback');
      return;
    }

    this.setState('connecting');
    const socket = new WebSocket(this.endpointUrl, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });

    this.ws = socket;
    activeDeepgramSockets.add(socket);

    socket.on('open', () => {
      if (this.closed || this.ws !== socket) {
        this.cleanupSocket(socket);
        return;
      }
      this.setState('open');
      this.keepAliveTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8000);
    });

    socket.on('message', (raw: Buffer | string) => {
      if (this.closed) return;
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      this.handleDeepgramMessage(text);
    });

    socket.on('error', (err: Error) => {
      if (this.closed) return;
      this.setState('error');
      this.callbacks.onError?.(err);
    });

    socket.on('close', () => {
      activeDeepgramSockets.delete(socket);
      this.clearKeepAlive();
      if (!this.closed) {
        this.setState('closed');
      }
    });
  }

  /**
   * Streams raw 16 kHz S16LE mono PCM bytes to Deepgram immediately and discards the buffer reference.
   */
  public sendPcmChunk(
    pcmChunk: Buffer,
    speakerRole: SpeakerRoleTag = 'unknown',
    sentAt: number = Date.now()
  ): void {
    if (this.closed || pcmChunk.byteLength === 0) return;

    this.latestSpeakerRole = speakerRole;
    this.lastChunkSentAt = sentAt;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcmChunk);
      return;
    }

    // Local PCM speech-burst detector when running without a live DEEPGRAM_API_KEY
    if (this.state === 'fallback') {
      const rms = computeInt16Rms(pcmChunk);
      if (rms > 350) {
        this.fallbackEnergyFrames += 1;
        if (!this.fallbackFlushTimer) {
          this.fallbackFlushTimer = setTimeout(() => {
            this.fallbackFlushTimer = null;
            if (this.closed || this.fallbackEnergyFrames === 0) return;
            const frames = this.fallbackEnergyFrames;
            this.fallbackEnergyFrames = 0;
            const now = Date.now();
            const latencyMs = Math.max(1, now - this.lastChunkSentAt);
            this.callbacks.onUtterance?.({
              id: randomUUID(),
              sessionId: this.sessionId,
              text: `[PCM 16kHz speech burst: ${frames * 100}ms captured via ${this.latestSpeakerRole}]`,
              speakerLabel: resolveSpeakerLabel(this.latestSpeakerRole, 0),
              speakerRole: this.latestSpeakerRole,
              isFinal: true,
              latencyMs,
              timestamp: now,
            });
          }, 350);
        }
      }
    }
  }

  private handleDeepgramMessage(jsonText: string): void {
    let payload: DeepgramTranscriptResponse;
    try {
      payload = JSON.parse(jsonText) as DeepgramTranscriptResponse;
    } catch {
      return;
    }

    const alt = payload.channel?.alternatives?.[0];
    const transcript = alt?.transcript?.trim();
    if (!transcript) return;

    const isFinal = Boolean(payload.is_final || payload.speech_final);
    const firstWordSpeaker = alt?.words?.find((w) => typeof w.speaker === 'number')?.speaker ?? null;
    const now = Date.now();
    const latencyMs = Math.max(1, now - this.lastChunkSentAt);

    const utterance: UtteranceRecord = {
      id: randomUUID(),
      sessionId: this.sessionId,
      text: transcript,
      speakerLabel: resolveSpeakerLabel(this.latestSpeakerRole, firstWordSpeaker),
      speakerRole: this.latestSpeakerRole,
      isFinal,
      latencyMs,
      timestamp: now,
    };

    this.callbacks.onUtterance?.(utterance);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.fallbackFlushTimer) {
      clearTimeout(this.fallbackFlushTimer);
      this.fallbackFlushTimer = null;
    }
  }

  private cleanupSocket(socket: WebSocket): void {
    activeDeepgramSockets.delete(socket);
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'CloseStream' }));
      }
    } catch {}
    try {
      socket.removeAllListeners();
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    } catch {}
  }

  /**
   * Deterministically tears down the Deepgram WebSocket and timers with zero leaks.
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearKeepAlive();

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      this.cleanupSocket(socket);
    }

    this.setState('closed');
  }
}

function computeInt16Rms(buf: Buffer): number {
  const sampleCount = Math.floor(buf.byteLength / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(i * 2);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / sampleCount);
}
