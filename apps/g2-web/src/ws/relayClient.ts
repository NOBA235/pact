import type {
  AudioCaptureMode,
  ClientToRelayMessage,
  HudStateType,
  RelayToClientMessage,
  SpeakerRoleTag,
} from '@pact/shared';

export interface RelayClientCallbacks {
  onConnectionChange?: (connected: boolean, url: string, reconnectingInMs?: number) => void;
  onMessage?: (msg: RelayToClientMessage) => void;
  onLog?: (entry: string) => void;
}

export class PactRelayClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly httpBaseUrl: string;
  private readonly callbacks: RelayClientCallbacks;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private chunkSeq = 0;

  constructor(callbacks: RelayClientCallbacks = {}, customUrl?: string) {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    this.url = customUrl || env?.VITE_RELAY_WS_URL || 'ws://localhost:8787/ws';
    this.httpBaseUrl =
      env?.VITE_RELAY_HTTP_URL ||
      this.url
        .replace(/^wss:/, 'https:')
        .replace(/^ws:/, 'http:')
        .replace(/\/ws\/?$/, '');
    this.callbacks = callbacks;
  }

  private log(msg: string): void {
    this.callbacks.onLog?.(`[RelayWS] ${msg}`);
  }

  public getUrl(): string {
    return this.url;
  }

  public getHttpBaseUrl(): string {
    return this.httpBaseUrl;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public async checkHealth(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.httpBaseUrl}/health`);
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  public connect(): void {
    this.shouldReconnect = true;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.addEventListener('open', () => {
        this.reconnectAttempts = 0;
        this.log(`Connected to ${this.url}`);
        this.callbacks.onConnectionChange?.(true, this.url);
      });

      this.ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const parsed = JSON.parse(event.data) as RelayToClientMessage;
          this.callbacks.onMessage?.(parsed);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`Failed to parse relay message: ${errMsg}`);
        }
      });

      this.ws.addEventListener('close', () => {
        this.ws = null;
        if (this.shouldReconnect) {
          const delayMs = this.scheduleReconnect();
          this.callbacks.onConnectionChange?.(false, this.url, delayMs);
        } else {
          this.callbacks.onConnectionChange?.(false, this.url);
        }
      });

      this.ws.addEventListener('error', () => {
        // Error is followed by close; reconnect handled in close listener
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`WebSocket connection error: ${errMsg}`);
      const delayMs = this.scheduleReconnect();
      this.callbacks.onConnectionChange?.(false, this.url, delayMs);
    }
  }

  private scheduleReconnect(): number {
    if (this.reconnectTimer || !this.shouldReconnect) return 0;
    const baseDelay = Math.min(1000 * Math.pow(1.6, this.reconnectAttempts), 12000);
    const jitter = Math.floor(Math.random() * 250);
    const delayMs = Math.round(baseDelay + jitter);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    return delayMs;
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.callbacks.onConnectionChange?.(false, this.url);
  }

  public sendJson(message: ClientToRelayMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }

  public startSession(
    audioSource: AudioCaptureMode,
    sessionId?: string,
    telegramChatId?: string
  ): boolean {
    this.chunkSeq = 0;
    return this.sendJson({
      type: 'session.start',
      sessionId,
      audioSource,
      telegramChatId,
    });
  }

  public stopSession(sessionId: string): boolean {
    return this.sendJson({
      type: 'session.stop',
      sessionId,
    });
  }

  /**
   * Streams a 16 kHz S16LE mono PCM frame + speakerRole tag over WebSocket
   * using a lightweight metadata header frame followed immediately by raw binary PCM bytes.
   * Zero audio bytes are retained after socket transmission.
   */
  public sendPcmFrame(
    pcmBytes: Uint8Array,
    speakerRole: SpeakerRoleTag,
    direction: number | null = null,
    source: string = 'glasses'
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.chunkSeq += 1;
    this.ws.send(
      JSON.stringify({
        type: 'audio.meta',
        speakerRole,
        direction,
        source,
        seq: this.chunkSeq,
        sentAt: Date.now(),
      } satisfies ClientToRelayMessage)
    );
    this.ws.send(pcmBytes);
    return true;
  }

  public sendSyntheticSpeech(
    text: string,
    speakerRole: SpeakerRoleTag = 'self',
    speakerLabel?: string
  ): boolean {
    return this.sendJson({
      type: 'stt.simulate',
      text,
      speakerRole,
      speakerLabel,
      sentAt: Date.now(),
    });
  }

  public sendHudTap(tapType: 'single_tap' | 'double_tap', currentState: HudStateType): boolean {
    return this.sendJson({
      type: 'hud.tap',
      tapType,
      currentState,
      timestamp: Date.now(),
    });
  }
}
