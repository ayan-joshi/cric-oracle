# CricOracle 🏏

An AI cricket umpire that answers questions about cricket laws — LBW, free hits, Mankad, helmet penalties, format differences between Test/ODI/T20I — with a direct verdict, an exact law citation, and the source passages it used.

It is a **hybrid-retrieval RAG system**: dense vector search and lexical full-text search run in parallel inside Postgres, get fused by Reciprocal Rank Fusion, and are reranked by an LLM before a single word is generated.

Every retrieval claim below is measured by `npm run eval` against a 28-case golden set, not asserted.

**Live demo:** https://cric-oracle.vercel.app/

---

## Measured performance

Against `eval/dataset.json` — 28 graded questions, each annotated with the MCC Law numbers a correct answer must be grounded in.

**Retrieval, at candidate depth (k=20 — the set handed to the reranker):**

| Retriever | recall@20 |
|---|---|
| Dense only | 96.4% |
| **Hybrid (RRF, 1:1)** | **100.0%** |

**Answers** (28 cases, LLM-judged):

| Metric | Score |
|---|---|
| Groundedness — every claim supported by retrieved passages | 80.4% |
| Correctness — the cricket ruling is right | 87.5% |
| Cited a specific Law or Clause | 100.0% |

**Where hybrid earns its place** — exact citation lookups, the query type dense vectors are structurally bad at:

| Case | Dense | Hybrid |
|---|---|---|
| `cite-law-38-3` | miss | **#2** |
| `cite-law-41-6` | #5 | **#1** |
| `cite-law-21-no-ball` | #6 | **#2** |

---

## Why hybrid retrieval

Pure vector search is the default in most RAG tutorials, and it is systematically bad at a query type this corpus attracts.

Embeddings capture *meaning*, so "when is a batter out leg before?" retrieves the LBW law beautifully. But **"what does Law 36.1.2 say?"** is a *lexical* query: `36.1.2` is a near-meaningless token to an embedding model, which will happily return Law 3, Law 6, or anything about dismissals. Conversely, pure keyword search fails colloquial questions — "Mankad" appears nowhere in the MCC Laws.

So CricOracle runs both and fuses them:

```
                    ┌─ dense (pgvector HNSW, cosine) ──┐
question → rewrite ─┤                                  ├─ RRF → rerank → answer
                    └─ lexical (tsvector GIN, ts_rank) ┘
```

**Reciprocal Rank Fusion** scores each document as `Σ 1/(k + rank_in_that_list)`, using only *ranks*, never scores. Cosine similarity (0–1, clustered near 0.7–0.9) and `ts_rank_cd` (unbounded, corpus-dependent) are on incomparable scales and cannot be meaningfully averaged. Ranks are scale-free, need no per-corpus normalisation, and degrade gracefully when one retriever returns nothing.

---

## Three things the eval caught that intuition got wrong

The harness paid for itself immediately. Each of these shipped as a migration under `supabase/`.

**1. `LIMIT` without `ORDER BY` (migration 002).** The lexical CTE ranked every match with `row_number()`, then `LIMIT 40` kept an *arbitrary* subset — routinely discarding the top-ranked lexical hits before fusion. Measured as a 13-point recall regression. Hybrid was *worse* than dense and looked like a feature.

**2. AND-semantics on natural-language questions (migration 002).** `websearch_to_tsquery` joins terms with AND, so `"When is a batsman out LBW?"` became `batsman & lbw` — requiring a chunk to contain every term. Most chunks matched nothing. Fixed by OR-joining; `ts_rank_cd` still ranks by how many terms matched. AND suits keyword search boxes, not questions.

**3. A corpus-specific stopword (migration 003).** After the OR fix, `"What does Law 36.1.2 say?"` became `'law' | '36.1.2'`. Postgres strips *what/does/is*, but **`law` is not a stopword** — and in a corpus of cricket *Laws* it matches nearly every chunk. `ts_rank_cd` applies no IDF weighting, so it cannot discount a term that matches everything. Stripping domain-generic terms (`law`, `clause`, `rule`, `cricket`, …) left `'36.1.2'` alone. In this corpus, "law" is a stopword for the same reason "the" is in English.

**And one methodological error of my own:** I spent all three migrations judging at recall@6 and concluding hybrid hurt. But nothing consumes 6 raw retrieval results — retrieval hands **20 candidates to a reranker whose entire job is fixing order**. Measuring at k=6 penalised hybrid for bad *ordering*, precisely the failure the next stage repairs. At k=20 the ranking reverses and hybrid hits 100%.

> Recall is the only property no downstream stage can recover. A chunk absent from the candidate set can never be reranked into it, and can never be cited by the model. Match the metric to the pipeline stage.

---

## The pipeline

### Phase 1 — Indexing (`npm run index`)

```
lords.org (42 laws) ─┐
                     ├→ crawl → clause-aware chunk → embed → Supabase (pgvector + tsvector)
ICC PDFs (3 formats)─┘
```

1. **Crawl** — 44 MCC law pages plus 3 ICC Playing Conditions PDFs, retaining canonical URL, law number, title and format.
2. **Chunk** — splits on *clause boundaries* (`36.1.2 The bowler delivers…`), falling back to paragraphs then sentences. Target ~320 words, ceiling 450, 60-word overlap.
3. **Contextual headers** — every chunk is prefixed with its own provenance before embedding:
   ```
   [Law 36 - Leg Before Wicket | MCC Laws of Cricket]
   36.1 Out LBW. The striker is out LBW if all the circumstances…
   ```
   A bare fragment like *"the ball must not bounce more than once"* is nearly unretrievable. Under a header naming its law it matches both the vector query and the lexical query. **98% of chunks now carry a law/clause number** (previously 0%).
4. **Embed** — `text-embedding-3-small`, 1536-dim, batched 64 at a time.
5. **Store** — one row per chunk with embedding, tsvector and metadata.

### Phase 2 — Query

1. **Rewrite** — user phrasing → corpus vocabulary. `"is mankad legal"` → `"run out non-striker leaving ground before bowler releases ball Law 38"`. Also detects a format filter and whether the question needs live data.
2. **Hybrid retrieve** — dense + lexical + RRF in one Postgres function, over-fetching 20 candidates.
3. **Rerank** — one listwise LLM pass narrows 20 → 6. Listwise beats pointwise because the model compares passages against each other rather than guessing absolute relevance.
4. **Answer** — grounded in numbered passages, with inline `[n]` citations mapped to the source list in the UI.

Retrieval over-fetches for **recall**; the reranker recovers **precision**.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express + TypeScript |
| Answers | Claude (`claude-opus-5`), OpenAI `gpt-4o-mini` automatic fallback |
| Rewrite / rerank / judge | Claude Haiku 4.5 — cheap, runs on every query |
| Embeddings | OpenAI `text-embedding-3-small` |
| Vector search | Supabase Postgres + pgvector, HNSW index |
| Lexical search | Postgres `tsvector` + GIN index |
| Fusion | Reciprocal Rank Fusion, in-database |
| Live data | Claude server-side `web_search` |
| Frontend | Plain HTML/CSS/JS, no build step |

**On the provider split:** answers run on Claude, but embeddings stay on OpenAI because **Anthropic has no embeddings endpoint**. `OPENAI_API_KEY` is required even when Claude generates every answer. If `ANTHROPIC_API_KEY` is unset or failing, generation falls back to OpenAI transparently and the site keeps answering.

---

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
```

**1. Apply the schema.** Supabase Dashboard → SQL Editor → New query. Run in order:
```
supabase/schema.sql
supabase/002_fix_hybrid_search.sql
supabase/003_tsquery_domain_stopwords.sql
```
All are idempotent and non-destructive.

**2. Index.**
```bash
npm run index -- --dry-run     # crawl + chunk only, writes nothing
npm run index                  # full pipeline
npm run index -- --only=icc    # re-index one source family
```

**3. Run.**
```bash
npm run dev                    # http://localhost:3000
```

---

## Evaluation

```bash
npm run eval                   # retrieval only — embeddings only, cheap
npm run eval -- --sweep        # RRF weight sweep
npm run eval -- --answers      # end-to-end + LLM judge
EVAL_K=20 npm run eval -- --sweep   # measure at candidate depth
```

Reports dense and hybrid **side by side**, flagging each case `[hybrid saved]` or `[hybrid lost]`. Without that comparison, "we added hybrid search" is a claim rather than a result.

The judge runs on the cheap utility model deliberately — grading answers with the model that wrote them biases the score.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Per-dependency status: database, generation provider, config |
| `POST /query` | `{ "question": "..." }` → answer, numbered sources, diagnostics |
| `GET /query/debug?q=...` | Dense vs hybrid side by side — reach for this when an answer looks wrong |
| `GET /query/sources` | Chunk count per source |
| `GET /crawl/status` | Indexed chunk count |
| `POST /crawl` | Remote re-index; requires `x-crawl-secret`. Prefer `npm run index`. |

---

## Operational design notes

Learned the hard way, now enforced in code:

- **`/health` names the failing dependency.** An outage once returned 500s from two unrelated causes — a paused Supabase project and a missing web-search key — indistinguishable from outside.
- **Errors carry real text.** The Supabase client never throws; it returns `{data, error}` where `error` is a plain object, so `String(err)` yields `"[object Object]"`. `describeError()` unpacks message/details/hint/code, and a missing schema returns a `503` naming the file to run.
- **`/crawl` fails closed.** The guard was `if (secret && header !== secret) reject` — an unset `CRAWL_SECRET` silently left a full re-crawl, and thousands of billed embedding calls, open to anyone.
- **RLS enforces the read/write split.** Anon key gets `SELECT` only; indexing uses the service-role key. Authorization lives in the database, which fails closed, not in application code, which failed open.
- **A partial crawl must never replace the corpus.** When lords.org was unreachable the crawler still returned 3 ICC PDFs — non-empty, so a naive `length === 0` check passed, and the swap would have deleted all 42 MCC Laws. `assertCorpusComplete()` aborts before anything is cleared.
- **Replace per source, not wholesale.** Whole-corpus replacement couples every source to the availability of every other one. `--only=icc` refreshes the PDFs while lords.org is down.
- **Late swap.** Crawl and embed complete *before* old rows are deleted, so a mid-run failure leaves the site working.
- **Rate limiting on `/query`.** Every question costs an embedding plus two-to-three LLM calls on a public endpoint.
- **Web search is never a hard dependency.** It is offered only when the rewrite step judges the question to need live data; its failure never blocks a grounded answer.
- **Indexing is a CLI, not an HTTP request.** A multi-minute job behind a platform request timeout could be killed mid-swap.

---

## Project layout

```
src/
  config.ts     env validation, fails fast at boot; measured retrieval defaults
  llm.ts        provider layer — Claude primary, OpenAI fallback
  rag.ts        rewrite → hybrid retrieve → rerank → answer
  supabase.ts   read/write client split, typed errors, per-source deletes
  crawler.ts    scraping + PDF parsing, metadata, completeness guard
  chunker.ts    clause-aware chunking + contextual headers
  embedder.ts   batched embeddings, query cache
  eval.ts       retrieval + answer evaluation, RRF weight sweep
  reindex.ts    npm run index
  errors.ts     AppError + Supabase error unpacking
supabase/
  schema.sql                        tables, HNSW + GIN, RPCs, RLS
  002_fix_hybrid_search.sql         ORDER BY + OR-semantics fixes
  003_tsquery_domain_stopwords.sql  corpus-specific stopwords
eval/
  dataset.json  28 graded questions with expected law numbers
```

---

## Known limitations

- **The MCC half of the corpus is stale.** 160 of 757 chunks were indexed by the old pipeline: no contextual headers, no `law_number` metadata. lords.org is currently unreachable from the development network, so those 42 laws cannot be re-crawled. Retrieval metrics should improve again once they are — every citation test case targets an MCC law.
- **Groundedness is 80.4%**, meaning roughly one answer in five contains a claim the retrieved passages do not fully support. The judge flags these individually in `npm run eval -- --answers`.
- **No streaming.** Answers arrive in one block; a long Opus response feels slow.
- **Rate limiting is per-process and in-memory.** Fine for one instance, wrong across replicas.
