import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from '../db/supabase.js';

export interface NotionPageSummary {
  id: string;
  title: string;
  lastEditedTime: string;
  source: 'notion_api' | 'preset';
}

export interface DocChunkRecord {
  id: string;
  sessionId: string;
  notionPageId: string;
  docTitle: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export interface MatchedDocChunk {
  id: string;
  sessionId: string;
  notionPageId: string;
  docTitle: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

export interface CustomSyncDocument {
  id?: string;
  title: string;
  content: string;
}

export const EMBEDDING_DIMENSION = 1536;

const PRESET_NOTION_PAGES: Record<string, { title: string; content: string }> = {
  'demo-sow-2026': {
    title: 'SOW',
    content: [
      'Statement of Work (SOW) — Enterprise AI Integration.',
      'Section 1 (Commercial Terms): Partner revenue share is strictly capped at a 10% revenue share cap across all enterprise tiers.',
      'Section 2 (Schedule & Milestones): Delivery: Q1 2027. Total upfront implementation fee is $50,000 with Net-30 payment terms.',
      'Section 3 (Support & SLA): 99.9% uptime SLA with 24-hour critical response window.',
    ].join('\n'),
  },
  'demo-term-sheet': {
    title: 'TERM SHEET',
    content: [
      'Series Seed SAFE Term Sheet.',
      'Valuation Cap: $12M post-money valuation cap.',
      'Discount Rate: 20% discount rate on next qualified priced equity financing.',
      'Pro-Rata Rights: Included for investors committing at least $250,000.',
    ].join('\n'),
  },
};

// In-memory per-session chunk store (mirrors Supabase doc_chunks for sub-5ms retrieval & offline resilience)
const sessionChunkStore = new Map<string, DocChunkRecord[]>();

export function getSyncedChunksForSession(sessionId: string): DocChunkRecord[] {
  return sessionChunkStore.get(sessionId) ?? [];
}

/**
 * Splits document text into ~350-character chunks with overlap on clean sentence/word boundaries.
 */
export function chunkDocumentText(
  text: string,
  maxChunkChars: number = 350,
  overlapChars: number = 60
): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChunkChars) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + maxChunkChars, cleaned.length);
    if (end < cleaned.length) {
      const slice = cleaned.slice(start, end);
      const lastSentenceBreak = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('\n'),
        slice.lastIndexOf('; ')
      );
      if (lastSentenceBreak >= Math.floor(maxChunkChars * 0.5)) {
        end = start + lastSentenceBreak + 1;
      } else {
        const lastSpace = slice.lastIndexOf(' ');
        if (lastSpace >= Math.floor(maxChunkChars * 0.5)) {
          end = start + lastSpace;
        }
      }
    }

    const chunk = cleaned.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= cleaned.length) break;
    start = Math.max(start + 1, end - overlapChars);
    // Align overlap start to next word boundary if mid-word
    const nextSpace = cleaned.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace - start < 20) {
      start = nextSpace + 1;
    }
  }

  return chunks;
}

/**
 * Lists accessible Notion pages via the official Notion Search API (`POST /v1/search`),
 * plus built-in deal document presets so development and testing work out of the box.
 */
export async function listNotionPages(): Promise<NotionPageSummary[]> {
  const presets: NotionPageSummary[] = Object.entries(PRESET_NOTION_PAGES).map(([id, doc]) => ({
    id,
    title: doc.title,
    lastEditedTime: new Date().toISOString(),
    source: 'preset',
  }));

  const notionKey = process.env.NOTION_API_KEY?.trim();
  if (!notionKey) {
    return presets;
  }

  try {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { value: 'page', property: 'object' },
        page_size: 25,
      }),
    });

    if (!res.ok) {
      console.warn(`[Notion] /v1/search returned HTTP ${res.status}; returning presets.`);
      return presets;
    }

    const data = (await res.json()) as {
      results?: Array<{
        id: string;
        last_edited_time?: string;
        properties?: Record<
          string,
          {
            type?: string;
            title?: Array<{ plain_text?: string }>;
          }
        >;
      }>;
    };

    const apiPages: NotionPageSummary[] = [];
    for (const page of data.results ?? []) {
      let title = 'Untitled Deal Doc';
      for (const prop of Object.values(page.properties ?? {})) {
        if (prop?.type === 'title' && Array.isArray(prop.title) && prop.title.length > 0) {
          const joined = prop.title.map((t) => t.plain_text ?? '').join('').trim();
          if (joined) {
            title = joined;
            break;
          }
        }
      }
      apiPages.push({
        id: page.id,
        title,
        lastEditedTime: page.last_edited_time ?? new Date().toISOString(),
        source: 'notion_api',
      });
    }

    return [...apiPages, ...presets];
  } catch (err) {
    console.warn('[Notion] Search error, falling back to presets:', err);
    return presets;
  }
}

/**
 * Fetches block children for a Notion page (`GET /v1/blocks/{id}/children`) and extracts plain text.
 */
export async function fetchNotionPageContent(
  pageId: string
): Promise<{ title: string; content: string }> {
  const preset = PRESET_NOTION_PAGES[pageId];
  if (preset) {
    return preset;
  }

  const notionKey = process.env.NOTION_API_KEY?.trim();
  if (!notionKey) {
    throw new Error(`NOTION_API_KEY is not configured and pageId "${pageId}" is not a preset`);
  }

  let title = 'NOTION DOC';
  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: {
        Authorization: `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (pageRes.ok) {
      const pageJson = (await pageRes.json()) as {
        properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
      };
      for (const prop of Object.values(pageJson.properties ?? {})) {
        if (prop?.type === 'title' && Array.isArray(prop.title)) {
          const extracted = prop.title.map((t) => t.plain_text ?? '').join('').trim();
          if (extracted) {
            title = extracted;
            break;
          }
        }
      }
    }
  } catch {}

  const blocksRes = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
    {
      headers: {
        Authorization: `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
      },
    }
  );

  if (!blocksRes.ok) {
    throw new Error(`Notion blocks API returned HTTP ${blocksRes.status} for page ${pageId}`);
  }

  const blocksJson = (await blocksRes.json()) as {
    results?: Array<Record<string, any>>;
  };

  const lines: string[] = [];
  for (const block of blocksJson.results ?? []) {
    const type = block.type as string | undefined;
    if (!type || !block[type]) continue;
    const richText = block[type].rich_text as Array<{ plain_text?: string }> | undefined;
    if (Array.isArray(richText) && richText.length > 0) {
      const line = richText.map((r) => r.plain_text ?? '').join('').trim();
      if (line) lines.push(line);
    }
  }

  return {
    title,
    content: lines.join('\n'),
  };
}

/**
 * Generates 1536-dimensional embeddings via Cloud Embedding API (OpenRouter / OpenAI-compatible).
 * Falls back to a deterministic in-memory token feature hash embedding (1536-dim L2-normalized)
 * when no embedding API key is configured, ensuring zero local ML models and 4 GB RAM discipline.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = (
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    ''
  ).trim();

  if (apiKey) {
    const isOpenAiDirect = Boolean(process.env.OPENAI_API_KEY?.trim());
    const endpoint =
      process.env.EMBEDDING_API_URL?.trim() ||
      (isOpenAiDirect
        ? 'https://api.openai.com/v1/embeddings'
        : 'https://openrouter.ai/api/v1/embeddings');
    const model =
      process.env.EMBEDDING_MODEL?.trim() ||
      (isOpenAiDirect ? 'text-embedding-3-small' : 'openai/text-embedding-3-small');

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (res.ok) {
        const json = (await res.json()) as {
          data?: Array<{ embedding: number[] }>;
        };
        if (Array.isArray(json.data) && json.data.length === texts.length) {
          return json.data.map((d) => d.embedding);
        }
      }
    } catch (err) {
      console.warn('[Embeddings] Cloud embedding request failed, using deterministic vector:', err);
    }
  }

  return texts.map((t) => computeDeterministicEmbedding(t));
}

/**
 * Lightweight 1536-dim L2-normalized semantic token/bigram feature hash vector.
 * Uses zero external libraries or weights while preserving high cosine similarity
 * for shared domain terms (revenue, share, cap, delivery, q1, price, fee, etc.).
 */
export function computeDeterministicEmbedding(text: string): number[] {
  const vec = new Float64Array(EMBEDDING_DIMENSION);
  const normalized = text
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/\$/g, ' usd ')
    .replace(/rev-share/g, 'revenue share');

  const rawTokens = normalized.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  // Expand domain synonyms so "rev-share" and "revenue share" align tightly
  const tokens: string[] = [...rawTokens];
  for (const tok of rawTokens) {
    if (tok === 'rev') tokens.push('revenue');
    if (tok === 'q1' || tok === 'q2' || tok === 'q3' || tok === 'q4') {
      tokens.push('delivery', 'quarter', 'schedule');
    }
    if (/^\d+$/.test(tok)) {
      tokens.push('number', 'term');
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const h1 = fnv1aHash(token) % EMBEDDING_DIMENSION;
    const h2 = fnv1aHash(`salt:${token}`) % EMBEDDING_DIMENSION;
    vec[h1] = (vec[h1] ?? 0) + 1.0;
    vec[h2] = (vec[h2] ?? 0) + 0.5;

    if (i + 1 < tokens.length) {
      const bigram = `${token}_${tokens[i + 1]}`;
      const hb = fnv1aHash(bigram) % EMBEDDING_DIMENSION;
      vec[hb] = (vec[hb] ?? 0) + 0.75;
    }
  }

  let normSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    normSq += vec[i]! * vec[i]!;
  }
  const norm = Math.sqrt(normSq) || 1;
  const result = new Array<number>(EMBEDDING_DIMENSION);
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    result[i] = Number((vec[i]! / norm).toFixed(6));
  }
  return result;
}

function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Syncs 1-5 Notion pages (or custom deal docs) for a session:
 * fetches blocks, chunks text (~350 chars with overlap), embeds via cloud API,
 * and stores in Supabase `doc_chunks` + in-memory session index.
 */
export async function syncSessionDocuments(params: {
  sessionId: string;
  pageIds?: string[];
  customDocs?: CustomSyncDocument[];
}): Promise<{
  sessionId: string;
  pagesSynced: number;
  chunksStored: number;
  docTitles: string[];
}> {
  const { sessionId, pageIds = [], customDocs = [] } = params;
  const resolvedDocs: Array<{ pageId: string; title: string; content: string }> = [];

  for (const pageId of pageIds.slice(0, 5)) {
    const fetched = await fetchNotionPageContent(pageId);
    if (fetched.content.trim()) {
      resolvedDocs.push({
        pageId,
        title: fetched.title,
        content: fetched.content,
      });
    }
  }

  for (const custom of customDocs.slice(0, 5)) {
    if (custom.content?.trim()) {
      resolvedDocs.push({
        pageId: custom.id || `custom-${randomUUID().slice(0, 8)}`,
        title: custom.title || 'SOW',
        content: custom.content.trim(),
      });
    }
  }

  const allChunksMeta: Array<{
    notionPageId: string;
    docTitle: string;
    chunkIndex: number;
    content: string;
  }> = [];

  for (const doc of resolvedDocs) {
    const textChunks = chunkDocumentText(doc.content, 350, 60);
    textChunks.forEach((content, idx) => {
      allChunksMeta.push({
        notionPageId: doc.pageId,
        docTitle: doc.title,
        chunkIndex: idx,
        content,
      });
    });
  }

  const embeddings = await embedTexts(allChunksMeta.map((c) => c.content));
  const records: DocChunkRecord[] = allChunksMeta.map((meta, idx) => ({
    id: randomUUID(),
    sessionId,
    notionPageId: meta.notionPageId,
    docTitle: meta.docTitle,
    chunkIndex: meta.chunkIndex,
    content: meta.content,
    embedding: embeddings[idx] ?? computeDeterministicEmbedding(meta.content),
  }));

  sessionChunkStore.set(sessionId, records);

  // Persist to Supabase pgvector when configured
  const sb = getSupabaseClient();
  if (sb && records.length > 0) {
    try {
      await sb.from('sessions').upsert({
        id: sessionId,
        title: 'PACT Live Session',
        notion_page_ids: resolvedDocs.map((d) => d.pageId),
        status: 'active',
      });
      await sb.from('doc_chunks').delete().eq('session_id', sessionId);
      await sb.from('doc_chunks').insert(
        records.map((r) => ({
          id: r.id,
          session_id: r.sessionId,
          notion_page_id: r.notionPageId,
          doc_title: r.docTitle,
          chunk_index: r.chunkIndex,
          content: r.content,
          embedding: r.embedding,
        }))
      );
    } catch (err) {
      console.warn('[Supabase] Non-fatal doc_chunks insert warning:', err);
    }
  }

  return {
    sessionId,
    pagesSynced: resolvedDocs.length,
    chunksStored: records.length,
    docTitles: [...new Set(resolvedDocs.map((d) => d.title))],
  };
}

/**
 * Queries top-3 `doc_chunks` for `sessionId` via Supabase `match_doc_chunks` RPC
 * with sub-5ms in-memory cosine similarity fallback.
 */
export async function queryTopDocChunks(
  sessionId: string,
  queryText: string,
  matchCount: number = 3,
  matchThreshold: number = 0.15
): Promise<MatchedDocChunk[]> {
  const [queryEmbedding] = await embedTexts([queryText]);
  if (!queryEmbedding) return [];

  const sb = getSupabaseClient();
  const localRecords = sessionChunkStore.get(sessionId) ?? [];

  if (sb && localRecords.length === 0) {
    try {
      const { data, error } = await sb.rpc('match_doc_chunks', {
        query_embedding: queryEmbedding,
        match_session_id: sessionId,
        match_threshold: matchThreshold,
        match_count: matchCount,
      });

      if (!error && Array.isArray(data) && data.length > 0) {
        return data.map((row: Record<string, any>) => ({
          id: String(row.id),
          sessionId: String(row.session_id),
          notionPageId: String(row.notion_page_id),
          docTitle: String(row.doc_title),
          chunkIndex: Number(row.chunk_index),
          content: String(row.content),
          similarity: Number(row.similarity),
        }));
      }
    } catch (err) {
      console.warn('[Supabase] match_doc_chunks RPC fallback to memory:', err);
    }
  }

  if (localRecords.length === 0) {
    return [];
  }

  const scored: MatchedDocChunk[] = localRecords
    .map((rec) => ({
      id: rec.id,
      sessionId: rec.sessionId,
      notionPageId: rec.notionPageId,
      docTitle: rec.docTitle,
      chunkIndex: rec.chunkIndex,
      content: rec.content,
      similarity: cosineSimilarity(queryEmbedding, rec.embedding),
    }))
    .filter((item) => item.similarity >= matchThreshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, matchCount);

  return scored;
}
