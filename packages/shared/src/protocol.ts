import type { FormattedHudFrame, HudPayload, HudStateType } from './hud.js';

export type SpeakerRoleTag = 'self' | 'other' | 'unknown';

export type AudioCaptureMode = 'g2_bridge' | 'browser_mic';

export interface UtteranceRecord {
  id: string;
  sessionId: string;
  text: string;
  speakerLabel: string;
  speakerRole: SpeakerRoleTag;
  isFinal: boolean;
  latencyMs?: number;
  timestamp: number;
}

export interface SessionStartMessage {
  type: 'session.start';
  sessionId?: string;
  audioSource: AudioCaptureMode;
}

export interface SessionStopMessage {
  type: 'session.stop';
  sessionId: string;
}

export interface AudioMetaMessage {
  type: 'audio.meta';
  speakerRole: SpeakerRoleTag;
  direction?: number | null;
  source?: string;
  seq?: number;
  sentAt?: number;
}

export interface AudioChunkMessage {
  type: 'audio.chunk';
  pcmBase64: string;
  speakerRole: SpeakerRoleTag;
  direction?: number | null;
  sentAt?: number;
}

export interface SyntheticSpeechMessage {
  type: 'stt.simulate';
  text: string;
  speakerRole?: SpeakerRoleTag;
  speakerLabel?: string;
  sentAt?: number;
}

export interface HudTapMessage {
  type: 'hud.tap';
  tapType: 'single_tap' | 'double_tap';
  currentState: HudStateType;
  timestamp: number;
}

export type ClientToRelayMessage =
  | SessionStartMessage
  | SessionStopMessage
  | AudioMetaMessage
  | AudioChunkMessage
  | SyntheticSpeechMessage
  | HudTapMessage;

export interface SessionStatusMessage {
  type: 'session.status';
  sessionId: string;
  status: 'connected' | 'streaming' | 'stopped';
  deepgramState: 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'fallback';
  activeDeepgramSockets: number;
  message?: string;
}

export interface SttTranscriptMessage {
  type: 'stt.transcript';
  utterance: UtteranceRecord;
  rollingWindow: UtteranceRecord[];
}

export interface HudFrameMessage {
  type: 'hud.frame';
  payload: HudPayload;
  frame: FormattedHudFrame;
}

export interface RelayErrorMessage {
  type: 'relay.error';
  code: string;
  message: string;
}

export type RelayToClientMessage =
  | SessionStatusMessage
  | SttTranscriptMessage
  | HudFrameMessage
  | RelayErrorMessage;
