-- Migration 003 -- strip domain-generic terms from the lexical query.
--
-- Measured on the 28-case golden set (k=6) after migration 002:
--   lexical 0.00 / semantic 1.00 -> recall@6 89.3%  MRR 0.567  precision@6 56.0%
--   lexical 0.50 / semantic 1.00 -> recall@6 82.1%  MRR 0.474  precision@6 51.8%
--   lexical 1.00 / semantic 0.00 -> recall@6 67.9%  MRR 0.439  precision@6 36.3%
--
-- The lexical arm still degraded results monotonically. Cause:
--
--   "What does Law 36.1.2 say?"  ->  'law' | '36.1.2'
--
-- Postgres' english config removes what/does/is as stopwords, but "law" is not
-- a stopword -- and in a corpus of cricket LAWS it appears in nearly every
-- chunk. ts_rank_cd applies no IDF weighting, so it cannot discount a term
-- that matches everything; the OR arm degenerates into "rank all chunks
-- containing the word law", which is noise that RRF then fuses in at full
-- weight.
--
-- AND-semantics (migration 001) was too strict; plain OR (migration 002) is
-- too loose. Dropping the domain-generic terms keeps OR recall while removing
-- the tokens that carry no discriminating signal in THIS corpus.
--
-- Run in the Supabase SQL Editor. Safe to re-run.

-- Terms that appear across the whole corpus and therefore cannot discriminate
-- between chunks. Deliberately corpus-specific: "law" is a stopword here for
-- the same reason "the" is a stopword in English.
create or replace function public.question_to_tsquery(query_text text)
returns tsquery
language sql
immutable
as $question_to_tsquery$
  with cleaned as (
    select regexp_replace(
             query_text,
             '\m(law|laws|clause|clauses|rule|rules|cricket|icc|mcc|say|says|mean|means)\M',
             ' ',
             'gi'
           ) as text
  ),
  -- Fall back to the raw question if stripping removed everything, e.g. a
  -- query that was nothing but generic terms.
  parsed as (
    select coalesce(
             nullif(websearch_to_tsquery('english', cleaned.text)::text, ''),
             websearch_to_tsquery('english', query_text)::text
           ) as q
    from cleaned
  )
  select coalesce(
    nullif(replace(parsed.q, '&', '|'), '')::tsquery,
    websearch_to_tsquery('english', query_text)
  )
  from parsed;
$question_to_tsquery$;
