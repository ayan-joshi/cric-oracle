# CricOracle 🏏

An AI cricket umpire that answers questions about cricket laws with the authority of a senior ICC panel umpire. Ask it anything — LBW rules, free hits, Mankad, helmet penalties, format differences between Test/ODI/T20I — and it gives you a direct verdict with exact law citations.

**Live demo:** https://cric-oracle.vercel.app/

---

## What It Does

- Covers all 42 MCC Laws of Cricket (2017 Code, 3rd Edition 2022)
- Covers ICC Playing Conditions for all three formats — Test, ODI, T20I
- Gives authoritative answers with exact clause citations (e.g. "Law 36.1.2", "ICC T20I Clause 41.6")
- Explains format differences where they exist
- Plain language — written for players and fans, not lawyers

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express + TypeScript |
| AI (Embeddings) | OpenAI `text-embedding-3-small` |
| AI (Answers) | OpenAI `gpt-4o-mini` |
| Vector Database | Supabase (PostgreSQL + pgvector) |
| Web Scraping | Axios + Cheerio |
| PDF Parsing | pdf-parse |
| Frontend | Plain HTML + CSS + JavaScript |

---

## How It Works — The RAG Pipeline

CricOracle uses **RAG (Retrieval-Augmented Generation)**. This is a technique where instead of asking an AI to answer from memory (which can hallucinate), you first fetch the real relevant documents, then ask the AI to answer using only those documents as context.

The full pipeline has two phases:

### Phase 1 — Indexing (one-time setup)

```
Data Sources → Crawler → Chunker → Embedder → Supabase (pgvector)
```

1. **Crawl** — fetches all 44 individual law pages from lords.org (one per law) + downloads 3 ICC PDF documents (Test, ODI, T20I Playing Conditions)
2. **Chunk** — splits each document into overlapping 350-word chunks (with 70-word overlap so no rule gets cut off at a boundary)
3. **Embed** — converts each chunk into a 1536-dimensional vector using OpenAI's embedding model
4. **Store** — saves all vectors + original text into Supabase using the pgvector extension

### Phase 2 — Query (every question)

```
User Question → Embed → Vector Search → Top 10 Chunks → GPT-4o-mini → Answer
```

1. The user's question is embedded into the same 1536-dimensional vector space
2. Supabase finds the 10 most similar chunks using cosine similarity (`match_threshold: 0.05`)
3. Those 10 chunks are passed as context to GPT-4o-mini
4. GPT answers using only that context — grounded, cited, accurate

---

## Project Structure

```
cricoracle/
├── src/
│   ├── index.ts          # Express server entry point
│   ├── crawler.ts        # Scrapes lords.org + downloads ICC PDFs
│   ├── chunker.ts        # Splits documents into overlapping chunks
│   ├── embedder.ts       # OpenAI embedding API calls
│   ├── rag.ts            # Vector search + GPT answer generation
│   ├── supabase.ts       # Supabase client, insert/search/clear
│   └── routes/
│       ├── crawl.ts      # POST /crawl, GET /crawl/status
│       └── query.ts      # POST /query + debug routes
├── public/
│   ├── index.html        # Frontend UI
│   ├── style.css         # Styling
│   └── app.js            # Frontend JS (fetch + render)
├── package.json
├── tsconfig.json
└── .env                  # OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
```

---

## Data Sources

### MCC Laws of Cricket (lords.org)
44 pages scraped directly from lords.org — one page per law topic:
- Preamble (Spirit of Cricket)
- Laws 1–42 (The Players → Players' Conduct)
- Appendices

Each page is static HTML with the full law text. Scraping individual pages ensures every clause is captured completely — including rules like Law 28.3 (fielder's helmet on the ground) that can be missed in bulk PDF extraction.

### ICC Playing Conditions (PDFs)
3 official PDFs downloaded from icc-cricket.com:
- ICC Test Match Playing Conditions
- ICC ODI Playing Conditions
- ICC T20I Playing Conditions

These contain format-specific modifications to the base MCC laws — powerplay rules, free hit rules, DLS method, field restriction circles, etc.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/crawl/status` | Returns count of indexed chunks |
| `POST` | `/crawl` | Runs full indexing pipeline |
| `POST` | `/query` | Ask a cricket question, returns answer |
| `GET` | `/query/debug?q=question` | Returns raw chunks retrieved for a question |
| `GET` | `/query/sources` | Returns chunk count per source |
| `GET` | `/query/search?term=free+hit` | Text search in indexed chunks |
| `GET` | `/query/sample?source=ICC+T20I+Playing+Conditions` | Shows a raw chunk from a source |

---

## Database Schema (Supabase)

```sql
create table documents (
  id bigserial primary key,
  url text,
  content text,
  embedding vector(1536)
);

create index on documents using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function match_documents(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table(id bigint, url text, content text, similarity float)
language sql stable as $$
  select id, url, content,
    1 - (embedding <=> query_embedding) as similarity
  from documents
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

---

## Setup & Run

### Prerequisites
- Node.js 18+
- Supabase project with pgvector enabled
- OpenAI API key

### Install
```bash
npm install
```

### Environment variables
Create a `.env` file:
```
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
PORT=3001
```

### Run (development)
```bash
npm run dev
```

### Build + Run (production)
```bash
npm run build
npm start
```

### Index the laws (one-time)
Visit `http://localhost:3001` and click **Index Laws**. Takes ~5 minutes. Only needs to be done once — data persists in Supabase.

---

## Key Design Decisions

**Why individual law pages instead of one big PDF?**
The MCC publishes a single PDF but extracting text from it can miss content or misalign sections. Scraping individual pages from lords.org gives clean, complete text per law — every clause is guaranteed present.

**Why chunk size 350 words with 70-word overlap?**
Too large (500+) and a chunk covers multiple unrelated rules — the wrong part gets retrieved. Too small (100-) and you lose context for the answer. Overlap ensures rules that span a chunk boundary aren't split.

**Why cosine similarity and not keyword search?**
Keyword search fails for paraphrased questions. "What happens if the ball hits a hat on the ground?" should match Law 28.3 (fielder's helmet) — but "hat" never appears in the law. Cosine similarity on embeddings captures semantic meaning, not exact words.

**Why gpt-4o-mini and not gpt-4o?**
gpt-4o-mini is 95% as capable at this task (answering from provided context) at ~20x lower cost. The hard work of finding relevant information is done by the vector search — the LLM just needs to synthesize and cite.

**Why match_threshold: 0.05?**
A higher threshold (0.7+) is common in general RAG systems but cricket law questions can be highly specific. A low threshold ensures we don't miss relevant chunks — it's better to retrieve 10 chunks and let the LLM ignore irrelevant ones than to miss the right chunk entirely.

---

## What I Learned Building This

### RAG (Retrieval-Augmented Generation)
The core pattern for building AI apps that need to answer questions about specific documents. Without RAG, LLMs hallucinate or give outdated answers. With RAG, the LLM is grounded in real source material. Every serious AI product (customer support bots, legal research, documentation assistants) uses some version of this.

### Vector Embeddings
Text converted to numbers in a high-dimensional space (1536 numbers per piece of text here) where similar meanings are mathematically close together. This is what makes semantic search possible — you're not matching words, you're matching meaning.

### pgvector + Supabase
PostgreSQL can do vector similarity search via the pgvector extension. Supabase exposes this through their `rpc()` client. The `ivfflat` index (Inverted File with Flat quantization) makes similarity search fast even with thousands of vectors by clustering them into groups (lists=100 here).

### Chunking Strategy
Documents must be split into smaller pieces before embedding. The key tradeoff: smaller chunks = more precise retrieval but less context per chunk. Larger chunks = more context but risk retrieving chunks that contain the answer buried in unrelated content. Overlap prevents rules from being split across chunks.

### Web Scraping with Cheerio
Cheerio is a server-side jQuery implementation for parsing HTML. Used axios to fetch pages and cheerio to extract text — removing nav/header/footer elements, then extracting the main content from a priority list of CSS selectors.

### PDF Parsing
pdf-parse extracts raw text from PDFs. PDF text extraction is imperfect — it can introduce extra whitespace, miss formatting, or misorder columns. Always clean the output with regex (collapsing multiple newlines/spaces) before chunking.

### TypeScript in Node.js
ts-node-dev for development (compiles + runs + restarts on change), tsc for production build to dist/. The strict mode catches type errors that would silently fail in JavaScript.

### Express routing
Separating routes into their own Router files (crawl.ts, query.ts) instead of putting everything in index.ts. Each router is mounted at a prefix — `app.use('/crawl', crawlRouter)`.

### System prompt engineering
The quality of an LLM's answer is heavily influenced by the system prompt. Key techniques used here:
- Role assignment: "You are a senior ICC panel umpire"
- Format instructions: "Give verdict first, then reasoning"
- Citation requirement: "Always cite the exact law or clause"
- Length control: "3-6 sentences for simple rules, up to 10 for complex"
- Fallback handling: "Never say 'not covered' unless completely absent"

### Environment Variables
Secrets (API keys, database URLs) are stored in `.env` files that are never committed to git. The dotenv package loads them at runtime. Production environments (Railway, Render) let you set these in their dashboard.

---

## Tricky Questions to Test

| Question | Tests |
|---|---|
| What happens if the ball hits a fielder's helmet on the ground? | Law 28.3 — penalty runs |
| Can a batsman be out LBW if the ball pitches outside leg stump? | Law 36 — LBW criteria |
| What is the free hit rule in T20? | ICC T20I Playing Conditions |
| Is Mankad run out legal? | Law 38 — run out |
| Can a batsman be stumped off a wide ball? | Law 39 — stumped |
| What if both batsmen reach the same end? | Law 38 — who is out |
| How many fielders can be outside the circle in the powerplay in ODIs? | ICC ODI Playing Conditions |
| Can a fielder use their cap to field the ball? | Law 28 — fielder's clothing |
| What happens if a batsman hits the ball twice? | Law 34 — hit the ball twice |
| Can a runner be given out obstructing the field? | Law 37 — obstructing the field |
