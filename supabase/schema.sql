-- CricOracle vector store schema / migration
-- Run in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
--
-- Idempotent and NON-DESTRUCTIVE: safe to run against a fresh project or
-- against the existing table (id, url, content, embedding) without losing rows.

-- Free-tier instances default to a 32 MB maintenance_work_mem, which is not
-- enough headroom to build the HNSW index. maintenance_work_mem is USERSET,
-- so raising it for this session needs no elevated privileges.
set maintenance_work_mem = '64MB';

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 1. Base table (no-op if it already exists)
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id        bigserial primary key,
  url       text,
  content   text not null,
  embedding vector(1536)
);

-- ---------------------------------------------------------------------------
-- 2. Metadata columns added by this migration.
--    "add column if not exists" is what makes this re-runnable, and what the
--    first draft of this file got wrong -- it assumed a clean slate and then
--    failed with 42703 because "fts" did not exist on the pre-existing table.
-- ---------------------------------------------------------------------------
alter table public.documents add column if not exists source      text;
alter table public.documents add column if not exists source_type text;
alter table public.documents add column if not exists format      text;
alter table public.documents add column if not exists law_number  text;
alter table public.documents add column if not exists law_title   text;
alter table public.documents add column if not exists created_at  timestamptz not null default now();

-- Backfill for rows indexed before this migration: the old "url" column held
-- the citation name, not a link.
update public.documents
   set source = url
 where source is null;

update public.documents
   set source_type = case when coalesce(source, '') like 'ICC%' then 'icc' else 'mcc' end
 where source_type is null;

update public.documents
   set format = case
                  when coalesce(source, '') like '%Test%' then 'test'
                  when coalesce(source, '') like '%ODI%'  then 'odi'
                  when coalesce(source, '') like '%T20I%' then 't20i'
                  else null
                end
 where source_type = 'icc' and format is null;

-- ---------------------------------------------------------------------------
-- 3. Full-text column.
--
--    Deliberately NOT a "generated always as (...) stored" column. That form
--    forces a full table rewrite, which on a free-tier instance blows past
--    maintenance_work_mem (32 MB) and fails with SQLSTATE 54000. A plain
--    nullable column is a catalog-only change (instant, no rewrite); a trigger
--    keeps it current and a batched backfill populates existing rows.
-- ---------------------------------------------------------------------------
alter table public.documents add column if not exists fts tsvector;

create or replace function public.documents_fts_refresh()
returns trigger
language plpgsql
as $documents_fts_refresh$
begin
  new.fts := to_tsvector('english', coalesce(new.content, ''));
  return new;
end
$documents_fts_refresh$;

drop trigger if exists documents_fts_refresh_trg on public.documents;
create trigger documents_fts_refresh_trg
  before insert or update of content on public.documents
  for each row execute function public.documents_fts_refresh();

-- Backfill existing rows in batches so no single statement needs much memory.
do $backfill$
declare
  updated int;
begin
  loop
    update public.documents
       set fts = to_tsvector('english', coalesce(content, ''))
     where id in (
       select id from public.documents where fts is null limit 200
     );
    get diagnostics updated = row_count;
    exit when updated = 0;
  end loop;
end
$backfill$;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

-- Dense retrieval. HNSW over IVFFlat: no training step, no rebuild after bulk
-- insert, and better recall at this corpus size.
create index if not exists documents_embedding_hnsw
  on public.documents using hnsw (embedding vector_cosine_ops);

-- Lexical retrieval -- carries the exact-citation queries ("Law 36.1.2") that
-- dense vectors are systematically bad at.
create index if not exists documents_fts_gin
  on public.documents using gin (fts);

create index if not exists documents_law_number_idx on public.documents (law_number);
create index if not exists documents_format_idx     on public.documents (format);

-- ---------------------------------------------------------------------------
-- 5. Dense-only search (used by /query/debug and as a hybrid fallback).
--    Dropped first because the return signature changed from the original.
-- ---------------------------------------------------------------------------
drop function if exists public.match_documents(vector, float, int);
drop function if exists public.match_documents(vector, float, int, text);

create function public.match_documents(
  query_embedding vector(1536),
  match_threshold float default 0.05,
  match_count     int   default 10,
  filter_format   text  default null
)
returns table (
  id         bigint,
  url        text,
  source     text,
  law_number text,
  law_title  text,
  content    text,
  similarity float
)
language sql
stable
as $match_documents$
  select d.id,
         d.url,
         d.source,
         d.law_number,
         d.law_title,
         d.content,
         1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where d.embedding is not null
    and 1 - (d.embedding <=> query_embedding) > match_threshold
    and (filter_format is null or d.format is null or d.format = filter_format)
  order by d.embedding <=> query_embedding
  limit match_count;
$match_documents$;

-- ---------------------------------------------------------------------------
-- 6. Hybrid search: dense + full-text, fused with Reciprocal Rank Fusion.
--
--    RRF scores a document as sum(1 / (k + rank_in_each_list)). It needs no
--    score normalisation between retrievers -- cosine similarity and ts_rank
--    are on incomparable scales -- and it degrades gracefully when one
--    retriever returns nothing at all. k = 60 follows Cormack et al.
-- ---------------------------------------------------------------------------
-- Converts a natural-language question into an OR-joined tsquery.
--
-- websearch_to_tsquery joins terms with AND, so "When is a batsman out LBW?"
-- becomes 'batsman & lbw' and a chunk must contain every term. Most law chunks
-- then match nothing, and the lexical arm contributes noise that RRF weights
-- equally with the dense arm. OR-joining restores recall; ts_rank_cd still
-- ranks by how many terms matched and how close together they are.
-- AND-semantics suits keyword search boxes, not natural-language questions.
create or replace function public.question_to_tsquery(query_text text)
returns tsquery
language sql
immutable
as $question_to_tsquery$
  select coalesce(
    nullif(replace(websearch_to_tsquery('english', query_text)::text, '&', '|'), '')::tsquery,
    websearch_to_tsquery('english', query_text)
  );
$question_to_tsquery$;

drop function if exists public.hybrid_search(text, vector, int, int, float, float, text);

create function public.hybrid_search(
  query_text       text,
  query_embedding  vector(1536),
  match_count      int   default 10,
  rrf_k            int   default 60,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  filter_format    text  default null
)
returns table (
  id         bigint,
  url        text,
  source     text,
  law_number text,
  law_title  text,
  content    text,
  similarity float,
  score      float
)
language sql
stable
as $hybrid_search$
with
candidate_limit as (
  select greatest(match_count * 4, 40) as n
),
tsq as (
  select public.question_to_tsquery(query_text) as q
),
full_text as (
  select d.id,
         row_number() over (order by ts_rank_cd(d.fts, tsq.q) desc, d.id) as rank_ix
  from public.documents d, tsq
  where d.fts @@ tsq.q
    and (filter_format is null or d.format is null or d.format = filter_format)
  -- ORDER BY before LIMIT. Without it the LIMIT keeps an arbitrary subset of
  -- matches and discards the highest-ranked ones, which measured as a 13-point
  -- recall@6 regression on the golden set.
  order by ts_rank_cd(d.fts, tsq.q) desc, d.id
  limit (select n from candidate_limit)
),
semantic as (
  select d.id,
         row_number() over (order by d.embedding <=> query_embedding) as rank_ix
  from public.documents d
  where d.embedding is not null
    and (filter_format is null or d.format is null or d.format = filter_format)
  order by d.embedding <=> query_embedding
  limit (select n from candidate_limit)
)
select d.id,
       d.url,
       d.source,
       d.law_number,
       d.law_title,
       d.content,
       1 - (d.embedding <=> query_embedding) as similarity,
       coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
       coalesce(1.0 / (rrf_k + semantic.rank_ix),  0.0) * semantic_weight as score
from full_text
full outer join semantic on full_text.id = semantic.id
join public.documents d on d.id = coalesce(full_text.id, semantic.id)
order by score desc
limit match_count;
$hybrid_search$;

-- ---------------------------------------------------------------------------
-- 7. Row Level Security.
--
--    The public site reads with the anon key, so anon gets SELECT and nothing
--    else. Indexing (/crawl) uses the service-role key, which bypasses RLS.
--    This is what stops a leaked anon key from wiping or poisoning the corpus,
--    and it replaces the fail-open "if (secret)" check in the /crawl route.
-- ---------------------------------------------------------------------------
alter table public.documents enable row level security;

drop policy if exists "documents are publicly readable" on public.documents;
create policy "documents are publicly readable"
  on public.documents for select
  to anon, authenticated
  using (true);

-- Sanity output
select count(*)                                     as indexed_chunks,
       count(*) filter (where source_type = 'mcc')  as mcc_chunks,
       count(*) filter (where source_type = 'icc')  as icc_chunks,
       count(*) filter (where embedding is null)    as missing_embeddings
  from public.documents;
