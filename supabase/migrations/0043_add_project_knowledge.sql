-- Project knowledge: files added to a project become searchable by every chat in that project.
-- Text is extracted on upload (PDF, Word, Excel, PowerPoint, OpenDocument, code, archives), split
-- into overlapping chunks and indexed two ways: Postgres full-text (always) and pgvector embeddings
-- (when an embedding provider key is configured). Search fuses both rankings, so exact names,
-- numbers and ids match lexically while paraphrased questions match semantically.

create extension if not exists vector;

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.assistant_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  mime text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  status text not null default 'processing' check (status in ('processing', 'ready', 'error')),
  error text,
  chunk_count integer not null default 0,
  char_count integer not null default 0,
  embedded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists project_files_project_idx on public.project_files (project_id, created_at desc);

-- No policies: backend only
alter table public.project_files enable row level security;

create table if not exists public.project_chunks (
  id bigserial primary key,
  file_id uuid not null references public.project_files(id) on delete cascade,
  project_id uuid not null references public.assistant_projects(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  tsv tsvector generated always as (to_tsvector('simple', content)) stored,
  -- 1536 dims: OpenAI text-embedding-3-small natively; Gemini gemini-embedding-001 with outputDimensionality 1536.
  embedding vector(1536),
  embed_model text
);

create index if not exists project_chunks_project_idx on public.project_chunks (project_id);
create index if not exists project_chunks_tsv_idx on public.project_chunks using gin (tsv);
create index if not exists project_chunks_embedding_idx on public.project_chunks using hnsw (embedding vector_cosine_ops);

-- No policies: backend only
alter table public.project_chunks enable row level security;

-- Hybrid search: reciprocal-rank fusion of full-text rank and vector similarity (k = 60, the usual
-- RRF constant). Either side may be absent (no embedding provider → text only).
create or replace function public.search_project_chunks(
  p_project uuid,
  p_query text,
  p_embedding vector(1536) default null,
  p_embed_model text default null,
  p_limit integer default 8
)
returns table (chunk_id bigint, file_id uuid, filename text, chunk_index integer, content text, score double precision)
language sql
stable
security definer
set search_path = public
as $$
  with lexical as (
    select c.id, row_number() over (order by ts_rank_cd(c.tsv, q) desc) as r
    from public.project_chunks c, websearch_to_tsquery('simple', p_query) q
    where c.project_id = p_project and c.tsv @@ q
    order by ts_rank_cd(c.tsv, q) desc
    limit 40
  ),
  semantic as (
    select c.id, row_number() over (order by c.embedding <=> p_embedding) as r
    from public.project_chunks c
    where p_embedding is not null and c.project_id = p_project and c.embedding is not null and c.embed_model = p_embed_model
    order by c.embedding <=> p_embedding
    limit 40
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score
    from (select id, r from lexical union all select id, r from semantic) u
    group by id
  )
  select c.id, c.file_id, f.filename, c.chunk_index, c.content, fused.score
  from fused
  join public.project_chunks c on c.id = fused.id
  join public.project_files f on f.id = c.file_id
  order by fused.score desc
  limit greatest(1, least(p_limit, 30))
$$;

revoke all on function public.search_project_chunks(uuid, text, vector, text, integer) from public, anon, authenticated;
grant execute on function public.search_project_chunks(uuid, text, vector, text, integer) to service_role;
