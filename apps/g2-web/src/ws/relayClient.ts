import type {
  AudioCaptureMode,
  ClientToRelayMessage,
  HudStateType,
  RelayToClientMessage,
  SpeakerRoleTag,
} from '@pact/shared';

export interface RelayClientCallbacks {
  onConnectionChange?: (connected: boolean, url: string) => void;
  onMessage?: (msg: RelayToClientMessage) => void;
  onLog?: (entry: string) => void;
}

export class PactRelayClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly callbacks: RelayClientCallbacks;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private chunkSeq = 0;

  constructor(callbacks: RelayClientCallbacks = {}, customUrl?: string) {
    const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_RELAY_WS_URL;
    this.url = customUrl || envUrl || 'ws://localhost:8787/ws';
    this.callbacks = callbacks;
  }

  private log(msg: string): void {
    this.callbacks.onLog?.(`[RelayWS] ${msg}`);
  }

  public getUrl(): string {
    return this.url;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
        this.callbacks.onConnectionChange?.(false, this.url);
        this.ws = null;
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', () => {
        // Error is followed by close; reconnect handled in close listener
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`WebSocket connection error: ${errMsg}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) return;
    const delayMs = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
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

  public startSession(audioSource: AudioCaptureMode, sessionId?: string): boolean {
    this.chunkSeq = 0;
    return this.sendJson({
      type: 'session.start',
      sessionId,
      audioSource,
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
