-- PACT Supabase Schema (PostgreSQL + pgvector)
-- Enforces ephemeral audio privacy: zero raw audio columns exist in any table.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Sessions Table
CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'PACT Live Session',
  telegram_chat_id text,
  notion_page_ids text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

-- 2. Synced Notion Deal Document Chunks (1536-dim cloud embeddings: text-embedding-3-small)
CREATE TABLE IF NOT EXISTS public.doc_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  notion_page_id text NOT NULL,
  doc_title text NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_session_id
  ON public.doc_chunks(session_id);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding_hnsw
  ON public.doc_chunks USING hnsw (embedding vector_cosine_ops);

-- 3. Bilateral Commitments (Pacts)
CREATE TABLE IF NOT EXISTS public.pacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  title text NOT NULL,
  owner text NOT NULL,
  due_text text NOT NULL,
  source_quote text NOT NULL,
  speaker_role text NOT NULL DEFAULT 'unknown' CHECK (speaker_role IN ('self', 'other', 'unknown')),
  confidence double precision NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'locked', 'declined', 'dismissed')),
  notion_page_id text,
  telegram_chat_id text,
  telegram_message_id bigint,
  confirmed_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pacts_session_id
  ON public.pacts(session_id);

-- 4. Detected Factual Contradictions (Conflicts)
CREATE TABLE IF NOT EXISTS public.conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  doc_title text NOT NULL,
  doc_fact text NOT NULL,
  spoken_claim text NOT NULL,
  source_quote text,
  confidence double precision NOT NULL DEFAULT 0,
  dismissed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conflicts_session_id
  ON public.conflicts(session_id);

-- 5. Semantic Vector Similarity Search RPC for Contradiction Radar
CREATE OR REPLACE FUNCTION public.match_doc_chunks(
  query_embedding vector(1536),
  match_session_id uuid,
  match_threshold float DEFAULT 0.35,
  match_count int DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  session_id uuid,
  notion_page_id text,
  doc_title text,
  chunk_index integer,
  content text,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    dc.id,
    dc.session_id,
    dc.notion_page_id,
    dc.doc_title,
    dc.chunk_index,
    dc.content,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM public.doc_chunks dc
  WHERE dc.session_id = match_session_id
    AND 1 - (dc.embedding <=> query_embedding) >= match_threshold
  ORDER BY dc.embedding <=> query_embedding ASC
  LIMIT match_count;
$$;
