-- Migration 002 -- fix two defects in hybrid_search found by `npm run eval`.
--
-- Baseline on the 22-case golden set (k=6), before this fix:
--   dense    recall@6 90.9%   MRR 0.717   precision@6 53.8%
--   hybrid   recall@6 77.3%   MRR 0.587   precision@6 45.5%
--
-- Hybrid retrieval was measurably WORSE than dense-only. Two causes:
--
-- 1. The full_text CTE applied LIMIT without ORDER BY. row_number() ranked
--    every lexical match, but the LIMIT then kept an arbitrary 40 of them, so
--    the top-ranked lexical hits were frequently discarded before fusion.
--
-- 2. websearch_to_tsquery() joins terms with AND. "When is a batsman out LBW?"
--    became 'batsman & lbw', requiring a chunk to contain every term. Most law
--    chunks matched nothing, so the lexical arm contributed near-noise that RRF
--    then weighted equally with the dense arm, displacing good results.
--
--    Rewriting the query to OR ('batsman | lbw') restores recall, and
--    ts_rank_cd still ranks by how many terms matched and how close they are.
--    That is the correct shape for natural-language questions; AND-semantics
--    suits keyword search boxes.
--
-- Run in the Supabase SQL Editor. Safe to re-run.

set maintenance_work_mem = '64MB';

-- Converts a natural-language question into an OR-joined tsquery.
-- websearch_to_tsquery does the parsing, stemming and stopword removal; we
-- only relax the boolean operator. Phrase operators (<->) are preserved.
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
  -- ORDER BY before LIMIT: without it the LIMIT keeps an arbitrary subset and
  -- throws away the highest-ranked lexical matches.
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
