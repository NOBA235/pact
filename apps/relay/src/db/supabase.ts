import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PactRecord } from '@pact/shared';

let supabaseInstance: SupabaseClient | null = null;

// In-memory mirror of pacts so webhook lookups and local sessions work with sub-millisecond speed
// and remain fully functional even when cloud Supabase credentials are not configured.
const memoryPacts = new Map<string, PactRecord>();

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseInstance) return supabaseInstance;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    return null;
  }
  supabaseInstance = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return supabaseInstance;
}

export async function recordSessionStart(
  sessionId: string,
  title = 'PACT Live Session',
  telegramChatId?: string
): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;
  try {
    await sb.from('sessions').upsert({
      id: sessionId,
      title,
      telegram_chat_id: telegramChatId ?? null,
      status: 'active',
    });
  } catch (err) {
    console.warn('[Supabase] Non-fatal session upsert warning:', err);
  }
}

export async function recordSessionStop(sessionId: string): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;
  try {
    await sb
      .from('sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', sessionId);
  } catch (err) {
    console.warn('[Supabase] Non-fatal session stop warning:', err);
  }
}

export async function recordDetectedConflict(params: {
  sessionId: string;
  docTitle: string;
  docFact: string;
  spokenClaim: string;
  sourceQuote: string;
  confidence: number;
}): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;
  try {
    await sb.from('conflicts').insert({
      session_id: params.sessionId,
      doc_title: params.docTitle,
      doc_fact: params.docFact,
      spoken_claim: params.spokenClaim,
      source_quote: params.sourceQuote,
      confidence: params.confidence,
    });
  } catch (err) {
    console.warn('[Supabase] Non-fatal conflict insert warning:', err);
  }
}

export async function upsertPactRecord(pact: PactRecord): Promise<PactRecord> {
  memoryPacts.set(pact.id, { ...pact });

  const sb = getSupabaseClient();
  if (sb) {
    try {
      await sb.from('pacts').upsert({
        id: pact.id,
        session_id: pact.sessionId,
        title: pact.title,
        owner: pact.owner,
        due_text: pact.dueText,
        source_quote: pact.sourceQuote,
        speaker_role: pact.speakerRole,
        confidence: pact.confidence,
        status: pact.status,
        notion_page_id: pact.notionPageId ?? null,
        telegram_chat_id: pact.telegramChatId ?? null,
        telegram_message_id: pact.telegramMessageId ?? null,
        confirmed_by: pact.confirmedBy ?? null,
        locked_at: pact.lockedAt ?? null,
        created_at: pact.createdAt,
      });
    } catch (err) {
      console.warn('[Supabase] Non-fatal pact upsert warning:', err);
    }
  }

  return pact;
}

export async function updatePactRecord(
  pactId: string,
  patch: Partial<PactRecord>
): Promise<PactRecord | null> {
  let existing = memoryPacts.get(pactId) ?? null;

  const sb = getSupabaseClient();
  if (!existing && sb) {
    try {
      const { data } = await sb.from('pacts').select('*').eq('id', pactId).maybeSingle();
      if (data) {
        existing = {
          id: String(data.id),
          sessionId: String(data.session_id),
          title: String(data.title),
          owner: String(data.owner),
          dueText: String(data.due_text),
          sourceQuote: String(data.source_quote),
          speakerRole: (data.speaker_role as PactRecord['speakerRole']) ?? 'unknown',
          confidence: Number(data.confidence ?? 0),
          status: data.status as PactRecord['status'],
          notionPageId: data.notion_page_id ?? null,
          telegramChatId: data.telegram_chat_id ?? null,
          telegramMessageId:
            data.telegram_message_id !== null && data.telegram_message_id !== undefined
              ? Number(data.telegram_message_id)
              : null,
          confirmedBy: data.confirmed_by ?? null,
          lockedAt: data.locked_at ?? null,
          createdAt: String(data.created_at),
        };
      }
    } catch (err) {
      console.warn('[Supabase] Non-fatal pact fetch warning:', err);
    }
  }

  if (!existing) return null;

  const updated: PactRecord = {
    ...existing,
    ...patch,
  };
  memoryPacts.set(pactId, updated);

  if (sb) {
    try {
      const dbPatch: Record<string, unknown> = {};
      if (patch.status !== undefined) dbPatch.status = patch.status;
      if (patch.notionPageId !== undefined) dbPatch.notion_page_id = patch.notionPageId;
      if (patch.telegramChatId !== undefined) dbPatch.telegram_chat_id = patch.telegramChatId;
      if (patch.telegramMessageId !== undefined) dbPatch.telegram_message_id = patch.telegramMessageId;
      if (patch.confirmedBy !== undefined) dbPatch.confirmed_by = patch.confirmedBy;
      if (patch.lockedAt !== undefined) dbPatch.locked_at = patch.lockedAt;

      if (Object.keys(dbPatch).length > 0) {
        await sb.from('pacts').update(dbPatch).eq('id', pactId);
      }
    } catch (err) {
      console.warn('[Supabase] Non-fatal pact update warning:', err);
    }
  }

  return updated;
}

export function getPactByIdFromMemory(pactId: string): PactRecord | null {
  return memoryPacts.get(pactId) ?? null;
}

export function listPactsForSession(sessionId: string): PactRecord[] {
  const result: PactRecord[] = [];
  for (const p of memoryPacts.values()) {
    if (p.sessionId === sessionId) {
      result.push(p);
    }
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function listAllPacts(): PactRecord[] {
  return [...memoryPacts.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
