import { truncateLine, type SpeakerRoleTag, type UtteranceRecord } from '@pact/shared';
import type { MatchedDocChunk } from '../notion/indexer.js';

export interface ContradictionDetectionResult {
  type: 'conflict' | 'none';
  confidence: number;
  docTitle: string;
  docFact: string;
  spokenClaim: string;
}

export interface PactCandidate {
  title: string;       // <= 26 chars
  owner: string;       // "Me" | "Counterparty" | "<Name>"
  dueText: string;     // <= 12 chars
  sourceQuote: string;
}

export type UnifiedDetectionResult =
  | {
      type: 'conflict';
      confidence: number;
      docTitle: string;
      docFact: string;
      spokenClaim: string;
    }
  | ({
      type: 'pact';
      confidence: number;
    } & PactCandidate)
  | {
      type: 'none';
      confidence: number;
    };

export const CONFLICT_CONFIDENCE_THRESHOLD = 0.85;
export const PACT_CONFIDENCE_THRESHOLD = 0.82;

const FILLER_PHRASES = new Set([
  'yeah',
  'yes',
  'yep',
  'right',
  'okay',
  'ok',
  'sure',
  'uh huh',
  'mm hmm',
  'got it',
  'makes sense',
  'sounds good',
  'exactly',
  'totally',
  'definitely',
  'awesome',
  'great',
  'cool',
  'nice',
  'thank you',
  'thanks',
  'hello',
  'hi there',
  'good morning',
  'good afternoon',
  'how are you',
  'nice to meet you',
]);

const VERIFIABLE_CLAIM_REGEX =
  /(\d+%|\b\d+(?:\.\d+)?\b|\$\d+|\b(?:percent|percentage|cap|capped|rev-share|revenue\s+share|royalty|fee|price|pricing|cost|budget|valuation|discount|net-\d+|q[1-4]|quarter|delivery|deliver|deadline|milestone|sla|uptime|exclusivity|tier)\b)/i;

const COMMITMENT_CUE_REGEX =
  /\b(?:i\s+will|i'll|we\s+will|we'll|i\s+commit\s+to|we\s+commit\s+to|i\s+promise\s+to|we\s+promise\s+to|let\s+me|i\s+can\s+send|i\s+can\s+deliver|we\s+can\s+deliver|you\s+will|you'll|counterparty\s+will)\b/i;

const VAGUE_NON_COMMITMENT_REGEX =
  /\b(?:we(?:'ll|\s+will)\s+see|i(?:'ll|\s+will)\s+think\s+about|let(?:'s|\s+us)\s+grab\s+coffee|catch\s+up\s+soon|circle\s+back\s+someday|maybe\s+we)\b/i;

/**
 * Fast deterministic Pre-Filter Gate:
 * Skips filler/backchannels ("yeah", "right", etc.) and utterances under 4 words
 * before triggering embeddings or Claude calls.
 */
export function passesPreFilterGate(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s%$'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  if (FILLER_PHRASES.has(normalized)) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 4) return false;

  const nonFillerWords = words.filter((w) => !FILLER_PHRASES.has(w));
  if (nonFillerWords.length === 0) return false;

  return true;
}

/**
 * Checks whether an utterance contains verifiable factual terms
 * (numbers, percentages, dates/quarters, caps, prices, or scope deliverables).
 */
export function hasVerifiableTerms(text: string): boolean {
  return VERIFIABLE_CLAIM_REGEX.test(text);
}

/**
 * Checks whether an utterance contains verbal commitment cues worth evaluating.
 */
export function hasCommitmentCue(text: string): boolean {
  if (text.trim().endsWith('?')) return false;
  if (/^(?:can|could|would|should|do|did|will|are|is)\s+(?:you|we|i|they)\b/i.test(text.trim())) {
    return false;
  }
  if (VAGUE_NON_COMMITMENT_REGEX.test(text)) return false;
  return COMMITMENT_CUE_REGEX.test(text);
}

/**
 * Single-hop AI analyzer using Claude (Anthropic API or OpenRouter CLAUDE_MODEL) returning strict JSON
 * for `conflict`, `pact`, or `none`:
 * - Conflict requires confidence >= 0.85 and explicit contradiction against `topChunks`.
 * - Pact requires confidence >= 0.82 + concrete deliverable + (owner OR deadline/numeric term),
 *   and incorporates G2 `speakerRole` (`self` -> `"Me"` on first-person promises).
 */
export async function analyzeUtterance(params: {
  utterance: UtteranceRecord;
  recentUtterances: UtteranceRecord[];
  topChunks: MatchedDocChunk[];
}): Promise<UnifiedDetectionResult> {
  const { utterance, recentUtterances, topChunks } = params;
  const text = utterance.text.trim();

  if (!passesPreFilterGate(text)) {
    return { type: 'none', confidence: 0 };
  }

  const checkConflict = hasVerifiableTerms(text) && topChunks.length > 0;
  const checkPact = hasCommitmentCue(text);

  if (!checkConflict && !checkPact) {
    return { type: 'none', confidence: 0 };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();

  if (anthropicKey || openRouterKey) {
    try {
      const raw = await callClaudeUnifiedJson({
        utterance,
        recentUtterances: recentUtterances.slice(-3),
        topChunks: checkConflict ? topChunks.slice(0, 3) : [],
        anthropicKey,
        openRouterKey,
      });
      return normalizeUnifiedResult(raw, utterance);
    } catch (err) {
      console.warn('[Claude Detector] Cloud API error, falling back to deterministic analyzer:', err);
    }
  }

  // Deterministic analyzer when cloud API keys are absent
  if (checkConflict) {
    const conflictFallback = evaluateDeterministicContradiction(text, topChunks.slice(0, 3));
    if (conflictFallback.type === 'conflict' && conflictFallback.confidence >= CONFLICT_CONFIDENCE_THRESHOLD) {
      return normalizeUnifiedResult(
        {
          type: 'conflict',
          confidence: conflictFallback.confidence,
          docTitle: conflictFallback.docTitle,
          docFact: conflictFallback.docFact,
          spokenClaim: conflictFallback.spokenClaim,
        },
        utterance
      );
    }
  }

  if (checkPact) {
    const pactFallback = evaluateDeterministicPact(utterance);
    return normalizeUnifiedResult(pactFallback, utterance);
  }

  return { type: 'none', confidence: 0 };
}

/**
 * Backward-compatible Contradiction Radar helper used by existing callers and tests.
 */
export async function detectContradiction(params: {
  utterance: UtteranceRecord;
  recentUtterances: UtteranceRecord[];
  topChunks: MatchedDocChunk[];
}): Promise<ContradictionDetectionResult> {
  const result = await analyzeUtterance(params);
  if (result.type === 'conflict') {
    return {
      type: 'conflict',
      confidence: result.confidence,
      docTitle: result.docTitle,
      docFact: result.docFact,
      spokenClaim: result.spokenClaim,
    };
  }
  return {
    type: 'none',
    confidence: result.confidence,
    docTitle: '',
    docFact: '',
    spokenClaim: '',
  };
}

function resolvePactOwner(
  rawOwner: string | undefined,
  spokenText: string,
  speakerRole: SpeakerRoleTag
): string {
  const isFirstPersonPromise = /\b(?:i\s+will|i'll|we\s+will|we'll|i\s+commit|we\s+commit|i\s+promise|we\s+promise|let\s+me|i\s+can)\b/i.test(
    spokenText
  );
  const isSecondPerson = /\b(?:you\s+will|you'll)\b/i.test(spokenText);

  if (isFirstPersonPromise) {
    if (speakerRole === 'self') return 'Me';
    if (speakerRole === 'other') {
      if (rawOwner && rawOwner !== 'Me' && rawOwner !== 'Speaker' && rawOwner !== 'Unknown') {
        return truncateLine(rawOwner, 14);
      }
      return 'Counterparty';
    }
  }

  if (isSecondPerson) {
    if (speakerRole === 'self') return 'Counterparty';
    if (speakerRole === 'other') return 'Me';
  }

  const cleaned = (rawOwner || '').trim();
  if (cleaned === 'Me' || cleaned === 'Counterparty') return cleaned;
  if (cleaned) return truncateLine(cleaned, 14);
  return speakerRole === 'self' ? 'Me' : 'Counterparty';
}

function normalizeUnifiedResult(
  raw: Record<string, any>,
  utterance: UtteranceRecord
): UnifiedDetectionResult {
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0;

  if (raw.type === 'conflict') {
    const docFact = typeof raw.docFact === 'string' ? raw.docFact.trim() : '';
    const spokenClaim = typeof raw.spokenClaim === 'string' ? raw.spokenClaim.trim() : '';
    if (confidence >= CONFLICT_CONFIDENCE_THRESHOLD && docFact && spokenClaim) {
      return {
        type: 'conflict',
        confidence: Math.min(1, Number(confidence.toFixed(2))),
        docTitle: truncateLine(String(raw.docTitle || 'DOC'), 15),
        docFact: truncateLine(docFact, 23),
        spokenClaim: truncateLine(spokenClaim, 22),
      };
    }
    return { type: 'none', confidence };
  }

  if (raw.type === 'pact') {
    const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : '';
    const rawDue = typeof raw.dueText === 'string' ? raw.dueText.trim() : '';
    const owner = resolvePactOwner(raw.owner, utterance.text, utterance.speakerRole);
    const hasNumericOrDeadline =
      Boolean(rawDue && rawDue.toUpperCase() !== 'NONE') ||
      /\b(?:\d+|fri|mon|tue|wed|thu|sat|sun|tomorrow|today|tonight|eod|eow|next\s+\w+|q[1-4]|noon|pm|am)\b/i.test(
        utterance.text
      );

    if (
      confidence >= PACT_CONFIDENCE_THRESHOLD &&
      rawTitle.length >= 4 &&
      (Boolean(owner) || hasNumericOrDeadline)
    ) {
      return {
        type: 'pact',
        confidence: Math.min(1, Number(confidence.toFixed(2))),
        title: truncateLine(rawTitle, 26),
        owner,
        dueText: truncateLine(rawDue || extractDuePhrase(utterance.text) || 'Confirmed', 12),
        sourceQuote:
          typeof raw.sourceQuote === 'string' && raw.sourceQuote.trim()
            ? raw.sourceQuote.trim()
            : utterance.text.trim(),
      };
    }
  }

  return { type: 'none', confidence };
}

async function callClaudeUnifiedJson(params: {
  utterance: UtteranceRecord;
  recentUtterances: UtteranceRecord[];
  topChunks: MatchedDocChunk[];
  anthropicKey?: string;
  openRouterKey?: string;
}): Promise<Record<string, any>> {
  const { utterance, recentUtterances, topChunks, anthropicKey, openRouterKey } = params;

  const systemPrompt = [
    'You are PACT Live Deal Intelligence for an Even Realities G2 heads-up display.',
    'Analyze `latestUtterance` alongside `recentContext` and `syncedDocChunks` in ONE pass and classify into `conflict`, `pact`, or `none`:',
    '1. `conflict`: ONLY if the speaker states an explicit factual contradiction against `syncedDocChunks` (wrong percentage/cap, price, valuation, delivery quarter/date, or payment term) with confidence >= 0.85. Never flag unmentioned details.',
    '2. `pact`: ONLY if a speaker makes a concrete verbal commitment/promise with a clear deliverable AND (an owner OR deadline/numeric term) with confidence >= 0.82. Use `speakerRole`: if `speakerRole` is "self" on a first-person promise ("I will", "We will"), `owner` MUST be "Me"; if `speakerRole` is "other" on a first-person promise, `owner` MUST be "Counterparty" (or their stated name). Never flag questions or vague banter.',
    '3. `none`: Everything else.',
    'Return STRICT JSON ONLY matching one of:',
    '{"type":"conflict","confidence":0.95,"docTitle":"<=15c","docFact":"<=23c","spokenClaim":"<=22c"}',
    '{"type":"pact","confidence":0.90,"title":"<=26c concise deliverable","owner":"Me"|"Counterparty"|"<Name>","dueText":"<=12c e.g. Fri 5pm","sourceQuote":"exact quote"}',
    '{"type":"none","confidence":0.0}',
  ].join('\n');

  const userPrompt = JSON.stringify({
    latestUtterance: {
      speaker: utterance.speakerLabel,
      speakerRole: utterance.speakerRole,
      text: utterance.text,
    },
    recentContext: recentUtterances.map((u) => ({
      speaker: u.speakerLabel,
      speakerRole: u.speakerRole,
      text: u.text,
    })),
    syncedDocChunks: topChunks.map((c) => ({
      docTitle: c.docTitle,
      content: c.content,
    })),
  });

  if (anthropicKey) {
    const model = process.env.CLAUDE_MODEL?.replace(/^anthropic\//, '') || 'claude-3-5-haiku-latest';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 220,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const rawText = data.content?.find((c) => c.type === 'text')?.text ?? '';
    return parseJsonObject(rawText);
  }

  const model = process.env.CLAUDE_MODEL || 'anthropic/claude-3.5-haiku';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 220,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawText = data.choices?.[0]?.message?.content ?? '';
  return parseJsonObject(rawText);
}

function parseJsonObject(rawText: string): Record<string, any> {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { type: 'none', confidence: 0 };
  }
  return JSON.parse(rawText.slice(start, end + 1)) as Record<string, any>;
}

export function parseStrictDetectorJson(rawText: string): ContradictionDetectionResult {
  const parsed = parseJsonObject(rawText);
  return {
    type: parsed.type === 'conflict' ? 'conflict' : 'none',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    docTitle: typeof parsed.docTitle === 'string' ? parsed.docTitle : 'DOC',
    docFact: typeof parsed.docFact === 'string' ? parsed.docFact : '',
    spokenClaim: typeof parsed.spokenClaim === 'string' ? parsed.spokenClaim : '',
  };
}

function extractDuePhrase(text: string): string {
  const byMatch = text.match(
    /\b(?:by|before|on|no\s+later\s+than|within)\s+((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight|today|eod|eow|q[1-4]|\d+\s*(?:hours?|hrs?|days?|weeks?|business\s+days?))(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm|noon)?)?)/i
  );
  if (byMatch?.[1]) {
    const shortened = byMatch[1]
      .replace(/\bmonday\b/i, 'Mon')
      .replace(/\btuesday\b/i, 'Tue')
      .replace(/\bwednesday\b/i, 'Wed')
      .replace(/\bthursday\b/i, 'Thu')
      .replace(/\bfriday\b/i, 'Fri')
      .replace(/\bsaturday\b/i, 'Sat')
      .replace(/\bsunday\b/i, 'Sun')
      .replace(/\btomorrow\b/i, 'Tomorrow')
      .replace(/\bbusiness\s+days?\b/i, 'bd')
      .replace(/\bhours?\b/i, 'h')
      .replace(/\bat\s+/i, '')
      .trim();
    return truncateLine(shortened, 12);
  }

  const standaloneTime = text.match(/\b(tomorrow|tonight|today|eod|eow|q[1-4])\b/i);
  if (standaloneTime?.[1]) {
    const tok = standaloneTime[1];
    return tok.charAt(0).toUpperCase() + tok.slice(1);
  }

  return '';
}

/**
 * Deterministic commitment extractor used when cloud LLM keys are not present in `.env`.
 */
export function evaluateDeterministicPact(utterance: UtteranceRecord): Record<string, any> {
  const text = utterance.text.trim();
  if (!hasCommitmentCue(text)) {
    return { type: 'none', confidence: 0 };
  }

  const actionMatch = text.match(
    /\b(?:i\s+will|i'll|we\s+will|we'll|i\s+commit\s+to|we\s+commit\s+to|i\s+promise\s+to|we\s+promise\s+to|let\s+me|i\s+can|we\s+can|you\s+will|you'll|counterparty\s+will)\s+(send|sending|deliver|delivering|share|sharing|ship|shipping|wire|wiring|transfer|sign|signing|provide|providing|draft|drafting|prepare|submit|complete|update|finalize|review)\s+(.+)/i
  );

  if (!actionMatch) {
    return { type: 'none', confidence: 0.2 };
  }

  const rawVerb = actionMatch[1]!.toLowerCase();
  const normalizedVerb = rawVerb
    .replace(/sending$/, 'send')
    .replace(/delivering$/, 'deliver')
    .replace(/sharing$/, 'share')
    .replace(/shipping$/, 'ship')
    .replace(/wiring$/, 'wire')
    .replace(/signing$/, 'sign')
    .replace(/providing$/, 'provide')
    .replace(/drafting$/, 'draft');
  const capVerb = normalizedVerb.charAt(0).toUpperCase() + normalizedVerb.slice(1);

  let remainder = actionMatch[2]!
    .replace(/\b(?:by|before|on|within|no\s+later\s+than)\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight|today|eod|eow|q[1-4]|\d+\s*(?:hours?|hrs?|days?|weeks?)).*$/i, '')
    .replace(/^(?:over|out)\s+/i, '')
    .replace(/^(?:you|us|them)\s+/i, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/[.!,;]+$/g, '')
    .trim();

  if (remainder.length < 3) {
    return { type: 'none', confidence: 0.3 };
  }

  const dueText = extractDuePhrase(text);
  const hasNumericTerm = /(?:\$\d+|\d+%|\b\d+\b)/i.test(text);
  const owner = resolvePactOwner(undefined, text, utterance.speakerRole);

  if (!dueText && !hasNumericTerm && !owner) {
    return { type: 'none', confidence: 0.4 };
  }

  const candidateTitle = truncateLine(`${capVerb} ${remainder}`, 26);

  return {
    type: 'pact',
    confidence: 0.91,
    title: candidateTitle,
    owner,
    dueText: dueText || 'Agreed',
    sourceQuote: text,
  };
}

/**
 * Fast deterministic factual comparator used when cloud LLM keys are not present in `.env`.
 */
export function evaluateDeterministicContradiction(
  spokenText: string,
  topChunks: MatchedDocChunk[]
): ContradictionDetectionResult {
  const spokenLower = spokenText.toLowerCase();

  for (const chunk of topChunks) {
    const chunkLower = chunk.content.toLowerCase();

    const spokenPctMatch = spokenText.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
    const docPctMatch = chunk.content.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);

    if (spokenPctMatch && docPctMatch) {
      const spokenPct = spokenPctMatch[1]!;
      const docPct = docPctMatch[1]!;
      const isRevShare =
        (spokenLower.includes('revenue') ||
          spokenLower.includes('rev-share') ||
          spokenLower.includes('share') ||
          spokenLower.includes('cap')) &&
        (chunkLower.includes('revenue') ||
          chunkLower.includes('rev-share') ||
          chunkLower.includes('share') ||
          chunkLower.includes('cap'));
      const isDiscount = spokenLower.includes('discount') && chunkLower.includes('discount');

      if ((isRevShare || isDiscount) && spokenPct !== docPct) {
        const suffix = isRevShare ? 'rev-share' : 'discount';
        return {
          type: 'conflict',
          confidence: 0.96,
          docTitle: chunk.docTitle,
          docFact: `${docPct}% ${suffix}`,
          spokenClaim: `${spokenPct}% ${suffix}`,
        };
      }
    }

    const spokenQMatch = spokenText.match(/\b(Q[1-4])\b/i);
    const docQMatch = chunk.content.match(/\b(Q[1-4])\b/i);
    if (spokenQMatch && docQMatch) {
      const spokenQ = spokenQMatch[1]!.toUpperCase();
      const docQ = docQMatch[1]!.toUpperCase();
      const isDeliveryTopic =
        (spokenLower.includes('deliver') ||
          spokenLower.includes('launch') ||
          spokenLower.includes('schedule') ||
          spokenLower.includes('ship')) &&
        (chunkLower.includes('deliver') ||
          chunkLower.includes('schedule') ||
          chunkLower.includes('milestone'));
      if (isDeliveryTopic && spokenQ !== docQ) {
        return {
          type: 'conflict',
          confidence: 0.94,
          docTitle: chunk.docTitle,
          docFact: `Delivery: ${docQ}`,
          spokenClaim: `Delivery: ${spokenQ}`,
        };
      }
    }

    const spokenUsdMatch = spokenText.match(/\$(\d+(?:,\d{3})*(?:\.\d+)?\s*[kKmM]?)/);
    const docUsdMatch = chunk.content.match(/\$(\d+(?:,\d{3})*(?:\.\d+)?\s*[kKmM]?)/);
    if (spokenUsdMatch && docUsdMatch) {
      const spokenUsd = spokenUsdMatch[1]!.replace(/\s+/g, '');
      const docUsd = docUsdMatch[1]!.replace(/\s+/g, '');
      const sameMoneyTopic =
        (spokenLower.includes('fee') && chunkLower.includes('fee')) ||
        (spokenLower.includes('cap') && chunkLower.includes('cap')) ||
        (spokenLower.includes('valuation') && chunkLower.includes('valuation'));
      if (sameMoneyTopic && spokenUsd.toLowerCase() !== docUsd.toLowerCase()) {
        const label = spokenLower.includes('valuation') ? 'val cap' : 'fee';
        return {
          type: 'conflict',
          confidence: 0.92,
          docTitle: chunk.docTitle,
          docFact: `$${docUsd} ${label}`,
          spokenClaim: `$${spokenUsd} ${label}`,
        };
      }
    }
  }

  return {
    type: 'none',
    confidence: 0.05,
    docTitle: '',
    docFact: '',
    spokenClaim: '',
  };
}
