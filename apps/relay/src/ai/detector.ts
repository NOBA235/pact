import { truncateLine, type UtteranceRecord } from '@pact/shared';
import type { MatchedDocChunk } from '../notion/indexer.js';

export interface ContradictionDetectionResult {
  type: 'conflict' | 'none';
  confidence: number;
  docTitle: string;
  docFact: string;
  spokenClaim: string;
}

export const CONFLICT_CONFIDENCE_THRESHOLD = 0.85;

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

/**
 * Fast deterministic Pre-Filter Gate:
 * Skips filler/backchannels ("yeah", "right", etc.) and utterances under 4 words
 * before triggering embeddings or Claude calls.
 */
export function passesPreFilterGate(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s%$-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  if (FILLER_PHRASES.has(normalized)) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 4) return false;

  // Reject utterances composed entirely of conversational filler tokens
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
 * Evaluates a finalized utterance against the last 3 utterances and top-3 matched
 * Notion doc_chunks using Claude (Anthropic API or OpenRouter CLAUDE_MODEL) returning strict JSON.
 * Triggers a conflict ONLY when confidence >= 0.85 and an explicit contradiction exists.
 */
export async function detectContradiction(params: {
  utterance: UtteranceRecord;
  recentUtterances: UtteranceRecord[];
  topChunks: MatchedDocChunk[];
}): Promise<ContradictionDetectionResult> {
  const { utterance, recentUtterances, topChunks } = params;
  const text = utterance.text.trim();

  const noneResult: ContradictionDetectionResult = {
    type: 'none',
    confidence: 0,
    docTitle: '',
    docFact: '',
    spokenClaim: '',
  };

  if (!passesPreFilterGate(text) || !hasVerifiableTerms(text) || topChunks.length === 0) {
    return noneResult;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();

  if (anthropicKey || openRouterKey) {
    try {
      const claudeResult = await callClaudeContradictionJson({
        utterance,
        recentUtterances: recentUtterances.slice(-3),
        topChunks: topChunks.slice(0, 3),
        anthropicKey,
        openRouterKey,
      });
      return normalizeAndGateResult(claudeResult);
    } catch (err) {
      console.warn('[Claude Detector] Cloud API error, falling back to deterministic comparator:', err);
    }
  }

  const fallback = evaluateDeterministicContradiction(text, topChunks.slice(0, 3));
  return normalizeAndGateResult(fallback);
}

function normalizeAndGateResult(raw: ContradictionDetectionResult): ContradictionDetectionResult {
  if (
    raw.type !== 'conflict' ||
    typeof raw.confidence !== 'number' ||
    raw.confidence < CONFLICT_CONFIDENCE_THRESHOLD ||
    !raw.docFact?.trim() ||
    !raw.spokenClaim?.trim()
  ) {
    return {
      type: 'none',
      confidence: raw.confidence || 0,
      docTitle: '',
      docFact: '',
      spokenClaim: '',
    };
  }

  return {
    type: 'conflict',
    confidence: Math.min(1, Number(raw.confidence.toFixed(2))),
    docTitle: truncateLine(raw.docTitle || 'DOC', 15),
    docFact: truncateLine(raw.docFact, 23),
    spokenClaim: truncateLine(raw.spokenClaim, 22),
  };
}

async function callClaudeContradictionJson(params: {
  utterance: UtteranceRecord;
  recentUtterances: UtteranceRecord[];
  topChunks: MatchedDocChunk[];
  anthropicKey?: string;
  openRouterKey?: string;
}): Promise<ContradictionDetectionResult> {
  const { utterance, recentUtterances, topChunks, anthropicKey, openRouterKey } = params;

  const systemPrompt = [
    'You are PACT Contradiction Radar for an Even Realities G2 heads-up display.',
    'Compare the latest spoken utterance (and recent 3 utterances context) against the synced Notion document chunks.',
    'Flag a conflict ONLY if the speaker states an explicit factual contradiction against a synced document chunk (e.g., wrong percentage cap, wrong price/valuation, wrong delivery quarter/date, or wrong payment term) with confidence >= 0.85.',
    'NEVER flag unmentioned details, questions, or casual conversation.',
    'Return STRICT JSON ONLY with this exact schema:',
    '{"type": "conflict" | "none", "confidence": 0.0 to 1.0, "docTitle": "<=15 chars", "docFact": "<=23 chars concise fact from doc, e.g. 10% rev-share", "spokenClaim": "<=22 chars concise spoken claim, e.g. 15% rev-share"}',
  ].join('\n');

  const userPrompt = JSON.stringify({
    latestUtterance: {
      speaker: utterance.speakerLabel,
      role: utterance.speakerRole,
      text: utterance.text,
    },
    recentContext: recentUtterances.map((u) => ({
      speaker: u.speakerLabel,
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
        max_tokens: 180,
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
    return parseStrictDetectorJson(rawText);
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
      max_tokens: 180,
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
  return parseStrictDetectorJson(rawText);
}

export function parseStrictDetectorJson(rawText: string): ContradictionDetectionResult {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { type: 'none', confidence: 0, docTitle: '', docFact: '', spokenClaim: '' };
  }
  const parsed = JSON.parse(rawText.slice(start, end + 1)) as Partial<ContradictionDetectionResult>;
  return {
    type: parsed.type === 'conflict' ? 'conflict' : 'none',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    docTitle: typeof parsed.docTitle === 'string' ? parsed.docTitle : 'DOC',
    docFact: typeof parsed.docFact === 'string' ? parsed.docFact : '',
    spokenClaim: typeof parsed.spokenClaim === 'string' ? parsed.spokenClaim : '',
  };
}

/**
 * Fast deterministic factual comparator used when cloud LLM keys are not present in `.env`.
 * Compares percentages, quarters (Q1..Q4), dollar amounts, and Net-XX terms when the utterance
 * and a synced Notion chunk share the same domain metric.
 */
export function evaluateDeterministicContradiction(
  spokenText: string,
  topChunks: MatchedDocChunk[]
): ContradictionDetectionResult {
  const spokenLower = spokenText.toLowerCase();

  for (const chunk of topChunks) {
    const chunkLower = chunk.content.toLowerCase();

    // 1. Percentage contradiction check (e.g., revenue share / discount / SLA percentage)
    const spokenPctMatch = spokenText.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
    const docPctMatch = chunk.content.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);

    if (spokenPctMatch && docPctMatch) {
      const spokenPct = spokenPctMatch[1]!;
      const docPct = docPctMatch[1]!;
      const isRevShare =
        (spokenLower.includes('revenue') || spokenLower.includes('rev-share') || spokenLower.includes('share') || spokenLower.includes('cap')) &&
        (chunkLower.includes('revenue') || chunkLower.includes('rev-share') || chunkLower.includes('share') || chunkLower.includes('cap'));
      const isDiscount =
        spokenLower.includes('discount') && chunkLower.includes('discount');

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

    // 2. Delivery Quarter (Q1..Q4) contradiction check
    const spokenQMatch = spokenText.match(/\b(Q[1-4])\b/i);
    const docQMatch = chunk.content.match(/\b(Q[1-4])\b/i);
    if (spokenQMatch && docQMatch) {
      const spokenQ = spokenQMatch[1]!.toUpperCase();
      const docQ = docQMatch[1]!.toUpperCase();
      const isDeliveryTopic =
        (spokenLower.includes('deliver') || spokenLower.includes('launch') || spokenLower.includes('schedule') || spokenLower.includes('ship')) &&
        (chunkLower.includes('deliver') || chunkLower.includes('schedule') || chunkLower.includes('milestone'));
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

    // 3. Dollar / Valuation / Fee contradiction check
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
