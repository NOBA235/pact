import type { SpeakerRoleTag, UtteranceRecord } from '@pact/shared';

export const DEFAULT_CONTEXT_WINDOW_SIZE = 4;

/**
 * Ephemeral in-memory rolling context window storing at most 4 finalized utterances
 * ({ text, speakerLabel, speakerRole, timestamp }).
 * Zero raw audio bytes are stored or referenced.
 */
export class RollingUtteranceWindow {
  private readonly maxSize: number;
  private readonly utterances: UtteranceRecord[] = [];

  constructor(maxSize: number = DEFAULT_CONTEXT_WINDOW_SIZE) {
    this.maxSize = Math.max(1, maxSize);
  }

  public push(utterance: UtteranceRecord): UtteranceRecord[] {
    const cleanText = utterance.text.trim();
    if (!cleanText) {
      return this.getRecent();
    }

    this.utterances.push({
      ...utterance,
      text: cleanText,
    });

    while (this.utterances.length > this.maxSize) {
      this.utterances.shift();
    }

    return this.getRecent();
  }

  public getRecent(): UtteranceRecord[] {
    return [...this.utterances];
  }

  public size(): number {
    return this.utterances.length;
  }

  public clear(): void {
    this.utterances.length = 0;
  }
}

/**
 * Resolves a human-readable speaker label from G2's AudioSpeakerRole metadata
 * combined with Deepgram's word-level diarization speaker index.
 */
export function resolveSpeakerLabel(
  speakerRole: SpeakerRoleTag,
  diarizedSpeakerIndex?: number | null
): string {
  if (speakerRole === 'self') {
    return diarizedSpeakerIndex !== undefined && diarizedSpeakerIndex !== null
      ? `Self (G2 · S${diarizedSpeakerIndex})`
      : 'Self (G2)';
  }
  if (speakerRole === 'other') {
    return diarizedSpeakerIndex !== undefined && diarizedSpeakerIndex !== null
      ? `Counterparty (G2 · S${diarizedSpeakerIndex})`
      : 'Counterparty (G2)';
  }
  if (diarizedSpeakerIndex !== undefined && diarizedSpeakerIndex !== null) {
    return `Speaker ${diarizedSpeakerIndex}`;
  }
  return 'Speaker';
}
