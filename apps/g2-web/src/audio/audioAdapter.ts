import {
  AudioInputSource,
  AudioSpeakerRole,
  type AudioEvent,
} from '@evenrealities/even_hub_sdk';
import type { AudioCaptureMode, SpeakerRoleTag } from '@pact/shared';
import type { PactEvenBridge } from '../sdk/evenBridge.js';
import type { PactRelayClient } from '../ws/relayClient.js';

export const TARGET_SAMPLE_RATE = 16000;
export const SAMPLES_PER_FRAME = 1600; // 100 ms at 16 kHz
export const BYTES_PER_FRAME = 3200;   // 1600 * 2 bytes (S16LE)

export interface AudioAdapterStats {
  mode: AudioCaptureMode;
  active: boolean;
  framesSent: number;
  bytesSent: number;
  lastSpeakerRole: SpeakerRoleTag;
}

export interface AudioAdapterCallbacks {
  onStatsChange?: (stats: AudioAdapterStats) => void;
  onLog?: (msg: string) => void;
}

export function normalizeSpeakerRole(role?: AudioSpeakerRole | string | null): SpeakerRoleTag {
  if (role === AudioSpeakerRole.Self || role === 'self') return 'self';
  if (role === AudioSpeakerRole.Other || role === 'other') return 'other';
  return 'unknown';
}

/**
 * Downsamples a Float32 mono audio buffer from `inputSampleRate` to 16,000 Hz
 * and converts it to signed 16-bit little-endian PCM (Int16Array).
 */
export function float32ToLinear16Pcm(
  input: Float32Array,
  inputSampleRate: number = TARGET_SAMPLE_RATE
): Int16Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j]!;
      count += 1;
    }
    const sample = count > 0 ? sum / count : (input[start] ?? 0);
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }

  return out;
}

/**
 * Dual-mode ephemeral 16 kHz S16LE PCM AudioAdapter:
 * - Primary (`g2_bridge`): Calls `bridge.audioControl(true)` and forwards `event.audioEvent.audioPcm`
 *   + `speakerRole` directly to `apps/relay` over WebSocket.
 * - Fallback (`browser_mic`): Captures 16 kHz mono linear16 PCM via WebView `AudioContext`
 *   so live testing works outside the simulator or without a physical glasses mic.
 */
export class PactAudioAdapter {
  private readonly bridge: PactEvenBridge;
  private readonly relay: PactRelayClient;
  private readonly callbacks: AudioAdapterCallbacks;

  private mode: AudioCaptureMode = 'g2_bridge';
  private active = false;
  private framesSent = 0;
  private bytesSent = 0;
  private lastSpeakerRole: SpeakerRoleTag = 'unknown';

  // Browser AudioContext fallback state
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private pcmCarryBuffer: number[] = [];

  constructor(
    bridge: PactEvenBridge,
    relay: PactRelayClient,
    callbacks: AudioAdapterCallbacks = {}
  ) {
    this.bridge = bridge;
    this.relay = relay;
    this.callbacks = callbacks;
  }

  private log(msg: string): void {
    this.callbacks.onLog?.(`[AudioAdapter] ${msg}`);
  }

  public getStats(): AudioAdapterStats {
    return {
      mode: this.mode,
      active: this.active,
      framesSent: this.framesSent,
      bytesSent: this.bytesSent,
      lastSpeakerRole: this.lastSpeakerRole,
    };
  }

  public setMode(mode: AudioCaptureMode): void {
    this.mode = mode;
    this.emitStats();
  }

  public getMode(): AudioCaptureMode {
    return this.mode;
  }

  public isActive(): boolean {
    return this.active;
  }

  private emitStats(): void {
    this.callbacks.onStatsChange?.(this.getStats());
  }

  /**
   * Starts ephemeral 16 kHz PCM capture in the configured mode.
   */
  public async start(mode: AudioCaptureMode = this.mode): Promise<void> {
    if (this.active) {
      await this.stop();
    }

    this.mode = mode;
    this.framesSent = 0;
    this.bytesSent = 0;
    this.pcmCarryBuffer = [];

    if (mode === 'g2_bridge') {
      this.active = true;
      await this.bridge.setAudioCapture(true, AudioInputSource.Glasses);
      this.log('Started G2 / Simulator bridge 16kHz PCM audio stream (audioControl=true).');
      this.emitStats();
      return;
    }

    // Fallback: Browser / WebView AudioContext 16 kHz mono linear16 capture
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('navigator.mediaDevices.getUserMedia is not available in this WebView');
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    const actualSampleRate = this.audioContext.sampleRate;
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);

    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.active) return;
      const channelData = event.inputBuffer.getChannelData(0);
      const pcm16 = float32ToLinear16Pcm(channelData, actualSampleRate);
      for (let i = 0; i < pcm16.length; i++) {
        this.pcmCarryBuffer.push(pcm16[i]!);
      }

      while (this.pcmCarryBuffer.length >= SAMPLES_PER_FRAME) {
        const frameSamples = this.pcmCarryBuffer.splice(0, SAMPLES_PER_FRAME);
        const int16Frame = Int16Array.from(frameSamples);
        const rawBytes = new Uint8Array(
          int16Frame.buffer,
          int16Frame.byteOffset,
          int16Frame.byteLength
        );
        this.forwardPcmBytes(rawBytes, 'unknown', null, 'browser_mic');
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    this.active = true;
    this.log(`Started Browser AudioContext PCM stream (sampleRate=${actualSampleRate} -> 16000Hz).`);
    this.emitStats();
  }

  /**
   * Stops audio capture and tears down all audio resources with zero retention.
   */
  public async stop(): Promise<void> {
    if (!this.active && !this.mediaStream && !this.audioContext) {
      return;
    }

    const activeMode = this.mode;
    this.active = false;
    this.pcmCarryBuffer = [];

    if (activeMode === 'g2_bridge') {
      await this.bridge.setAudioCapture(false, AudioInputSource.Glasses);
      this.log('Stopped G2 / Simulator bridge audio stream (audioControl=false).');
    }

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try {
        this.processorNode.disconnect();
      } catch {}
      this.processorNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {}
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {}
      this.audioContext = null;
    }

    this.emitStats();
  }

  /**
   * Invoked whenever `PactEvenBridge` receives an `event.audioEvent` from G2 / simulator.
   */
  public handleBridgeAudioEvent(audioEvent: AudioEvent): void {
    if (!this.active || this.mode !== 'g2_bridge') {
      return;
    }
    const role = normalizeSpeakerRole(audioEvent.speakerRole);
    this.forwardPcmBytes(
      audioEvent.audioPcm,
      role,
      audioEvent.direction ?? null,
      audioEvent.source ?? 'glasses'
    );
  }

  private forwardPcmBytes(
    pcmBytes: Uint8Array,
    speakerRole: SpeakerRoleTag,
    direction: number | null,
    source: string
  ): void {
    const sent = this.relay.sendPcmFrame(pcmBytes, speakerRole, direction, source);
    if (sent) {
      this.framesSent += 1;
      this.bytesSent += pcmBytes.byteLength;
      this.lastSpeakerRole = speakerRole;
      if (this.framesSent === 1 || this.framesSent % 20 === 0) {
        this.emitStats();
      }
    }
  }
}
