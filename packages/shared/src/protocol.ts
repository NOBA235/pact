import type { FormattedHudFrame, HudPayload, HudStateType } from './hud.js';

export type SpeakerRoleTag = 'self' | 'other' | 'unknown';

export type AudioCaptureMode = 'g2_bridge' | 'browser_mic';

export type PactLifecycleStatus = 'draft' | 'pending' | 'locked' | 'declined' | 'dismissed';

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

export interface PactRecord {
  id: string;
  sessionId: string;
  title: string;
  owner: string;
  dueText: string;
  sourceQuote: string;
  speakerRole: SpeakerRoleTag;
  confidence: number;
  status: PactLifecycleStatus;
  notionPageId?: string | null;
  telegramChatId?: string | null;
  telegramMessageId?: number | null;
  confirmedBy?: string | null;
  lockedAt?: string | null;
  createdAt: string;
}

export interface SessionStartMessage {
  type: 'session.start';
  sessionId?: string;
  audioSource: AudioCaptureMode;
  telegramChatId?: string;
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

export interface PactUpdatedMessage {
  type: 'pact.updated';
  pact: PactRecord;
  sessionPacts: PactRecord[];
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
  | PactUpdatedMessage
  | RelayErrorMessage;
