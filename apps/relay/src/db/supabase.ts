import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseInstance: SupabaseClient | null = null;

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

export async function recordSessionStart(sessionId: string, title = 'PACT Live Session'): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;
  try {
    await sb.from('sessions').upsert({
      id: sessionId,
      title,
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
