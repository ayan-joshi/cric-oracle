# CricOracle
### "Ask anything about Cricket Laws — get answers like an AI Umpire"

> Build date: Saturday, 14 March 2026
> Stack: TypeScript + Express + OpenAI + Supabase pgvector
> Data source: laws.mcc.org.uk (The 42 Official Laws of Cricket)

---

## What Are We Building?

A **RAG (Retrieval-Augmented Generation)** system that:
1. Crawls the official MCC Laws of Cricket website
2. Converts every law/rule into vectors and stores them in Supabase
3. Lets you ask natural language questions like:
   - *"When is a batsman out LBW?"*
   - *"What happens if the ball hits a fielder's helmet?"*
   - *"How many times can a bowler bowl in an innings?"*
4. Returns precise answers grounded in the actual law text — not hallucinated

---

## Core Concept: What is RAG?

```
WITHOUT RAG:
User: "When is a batsman out obstructing the field?"
GPT:  "A batsman can be out obstructing the field when..." (may hallucinate)

WITH RAG:
User: "When is a batsman out obstructing the field?"
System: [finds Law 37 from our database]
GPT:  "According to Law 37: Either batsman is out if..." (grounded in real text)
```

RAG = Give the LLM the right book page BEFORE asking it to answer.

---

## The 3 Core Concepts to Learn

### 1. Embeddings (Text → Numbers)
An embedding converts text into a list of numbers (a vector) that captures meaning.

```
"Batsman is out LBW"      → [0.12, -0.34, 0.87, ...]  1536 numbers
"Leg before wicket rule"  → [0.11, -0.31, 0.85, ...]  very similar!
"How to bake a cake"      → [0.91,  0.67, -0.12, ...]  very different
```

Similar meaning = similar numbers. This is how we find relevant content.

### 2. Vector Search (Find Similar Meaning)
Instead of keyword search (ctrl+F), we search by meaning.

```sql
-- Find the 5 law chunks most similar to the user's question
SELECT content, 1 - (embedding <=> query_embedding) AS similarity
FROM documents
ORDER BY embedding <=> query_embedding
LIMIT 5;
```

The `<=>` operator in Postgres (via pgvector) = cosine distance between two vectors.

### 3. Augmented Generation (Context + LLM)
We inject the retrieved law text into the prompt before sending to GPT.

```
System: You are an expert cricket umpire. Answer using ONLY the context below.
Context: [Law 36 text] [Law 37 text] [Law 38 text]
User: When is a batsman out obstructing the field?
```

GPT now answers from the actual laws, not from memory.

---

## Full Architecture

```
INDEX PIPELINE (runs once on startup)
──────────────────────────────────────
laws.mcc.org.uk
    │
    ▼
[Crawler] cheerio + axios
    │  fetches all law pages, strips HTML
    ▼
[Chunker] splits each law into ~500 word chunks
    │  (why? LLMs have context limits, smaller = more precise retrieval)
    ▼
[Embedder] OpenAI text-embedding-3-small
    │  converts each chunk → 1536-dimension vector
    ▼
[Supabase] stores { id, url, content, embedding }
    │
    ✓ Done — site is indexed

QUERY PIPELINE (every user question)
──────────────────────────────────────
User types: "Can a fielder field with a helmet?"
    │
    ▼
[Embedder] converts question → vector
    │
    ▼
[Supabase] finds top 5 most similar chunks (pgvector cosine search)
    │
    ▼
[Prompt Builder] stuffs chunks as context into GPT prompt
    │
    ▼
[OpenAI gpt-4o-mini] generates grounded answer
    │
    ▼
User sees answer with source law reference
```

---

## Tech Stack & Why

| Tool | Role | Why |
|------|------|-----|
| **TypeScript** | Language | Type safety, great for learning structure |
| **Express** | Backend server | Simple, minimal, industry standard |
| **Cheerio + Axios** | Web crawler | jQuery-like HTML parsing, easy to learn |
| **OpenAI API** | Embeddings + Chat | Best embedding quality, cheap gpt-4o-mini |
| **Supabase pgvector** | Vector database | Free, Postgres-based, production-grade |
| **HTML/CSS/JS** | Frontend | Pure, no framework — see exactly what's happening |

---

## Project Structure (what we'll build)

```
cricoracle/
├── plan.md                  ← you are here
├── .env                     ← API keys (never commit this)
├── .gitignore
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts             ← Express server entry point
│   ├── crawler.ts           ← crawls laws.mcc.org.uk
│   ├── chunker.ts           ← splits text into chunks
│   ├── embedder.ts          ← OpenAI embeddings
│   ├── supabase.ts          ← DB client + vector search
│   ├── rag.ts               ← query pipeline (embed → search → generate)
│   └── routes/
│       ├── index.ts         ← GET /          (serves frontend)
│       ├── crawl.ts         ← POST /crawl    (triggers indexing)
│       └── query.ts         ← POST /query    (answers questions)
└── public/
    ├── index.html           ← chat UI
    ├── style.css
    └── app.js
```

---

## Supabase Setup (do this before Saturday)

Run this SQL in your Supabase SQL editor:

```sql
-- Enable the pgvector extension
create extension if not exists vector;

-- Create the documents table
create table documents (
  id bigserial primary key,
  url text,
  content text,
  embedding vector(1536)
);

-- Create an index for fast similarity search
create index on documents
using ivfflat (embedding vector_cosine_ops)
with (lists = 100);
```

---

## Build Order (Saturday)

```
Step 1 → Project setup (package.json, tsconfig, folder structure)   ~15 min
Step 2 → Supabase table + pgvector setup                            ~10 min
Step 3 → Write the crawler (fetch + parse laws.mcc.org.uk)          ~20 min
Step 4 → Write the chunker (split text intelligently)               ~15 min
Step 5 → Write the embedder (OpenAI API call)                       ~15 min
Step 6 → Store in Supabase (insert chunks + vectors)                ~15 min
Step 7 → Write the query pipeline (embed → search → generate)       ~20 min
Step 8 → Build the Express routes                                   ~15 min
Step 9 → Build the chat UI                                          ~20 min
Step 10→ Test it! Ask cricket law questions                         ~15 min
Step 11→ Deploy to Render                                           ~20 min
```

Total: ~3 hours including learning pauses

---

## What You Will Learn

- [ ] How embeddings represent meaning as numbers
- [ ] Why we chunk text (context windows, retrieval precision)
- [ ] How cosine similarity finds "close" vectors
- [ ] How pgvector brings vector search into Postgres
- [ ] The difference between semantic search vs keyword search
- [ ] How to build a web crawler with cheerio
- [ ] How to structure an Express TypeScript backend
- [ ] How prompt engineering grounds LLM answers in real data
- [ ] The full RAG pipeline end-to-end

---

## Before Saturday Checklist

- [ ] Create OpenAI account → add $2 → save API key
- [ ] Create Supabase project → run the SQL above → save URL + anon key
- [ ] Have Node.js installed (check: `node -v`)
- [ ] Have a code editor ready (VS Code)

---

## Cost Estimate

```
Crawling + indexing Laws of Cricket  → ~$0.001
100 test questions                   → ~$0.03
Total for entire project             → < $0.05
```

Your $2 OpenAI credit will last months.

---

> "RAG is not magic — it's a library card. You tell the AI which page to read before answering."
