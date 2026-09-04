import { config } from './config';
import { embedText } from './embedder';
import { hybridSearch, RetrievedChunk } from './supabase';
import { describeError } from './errors';
import { complete, parseJson } from './llm';

const SYSTEM_PROMPT = `You are CricOracle, an expert AI cricket umpire with complete knowledge of the MCC Laws of Cricket and ICC Playing Conditions for all formats (Test, ODI, T20I).

You answer from the numbered CONTEXT passages supplied with each question. Those passages are the authority.

Rules:
- Lead with a direct verdict, then explain the reasoning.
- Cite the law or clause you relied on (e.g. "Law 36.1.2", "ICC T20I Clause 41.6") AND the passage number it came from, like [2]. Only cite passage numbers that actually appear in the CONTEXT.
- If the CONTEXT does not settle the question, say so plainly rather than inventing a law. Use web search, if you have it, for live data (points tables, results, recent news) and for league rules (IPL, BBL, CPL) that are not in the MCC/ICC documents.
- If the answer differs by format (Test vs ODI vs T20), explain the difference.
- Plain language, for a player or fan, not a lawyer.
- 3-6 sentences for simple rules, up to 10 for complex ones.`;

const REWRITE_PROMPT = `You rewrite cricket questions into search queries for a corpus of MCC Laws of Cricket and ICC Playing Conditions.

Return JSON: {"query": string, "format": "test"|"odi"|"t20i"|null, "needsLiveData": boolean}

- "query": rewrite the user's colloquial phrasing into the terminology the law text actually uses, keeping the key nouns. Example: "is mankad legal" -> "run out non-striker leaving ground before bowler releases ball Law 38". Include a likely Law number if you are confident.
- "format": set only if the user explicitly asks about one format, otherwise null.
- "needsLiveData": true for questions about current results, standings, squads, or league-specific rules that a fixed law book cannot answer.`;

export interface Citation {
  n: number;
  source: string;
  law: string | null;
  url: string | null;
  snippet: string;
}

export interface RAGResult {
  answer: string;
  sources: Citation[];
  usedWebSearch: boolean;
  diagnostics: {
    rewrittenQuery: string;
    formatFilter: string | null;
    candidates: number;
    used: number;
    provider: string;
    model: string;
    latencyMs: number;
    degraded?: string;
  };
}

/**
 * Step 1 -- query rewriting.
 * Users ask "is mankad legal?"; the corpus says "run out ... non-striker".
 * Bridging that vocabulary gap before retrieval matters more than any
 * downstream prompt tuning. Falls back to the raw question on any failure.
 */
async function rewriteQuery(
  question: string
): Promise<{ query: string; format: string | null; needsLiveData: boolean }> {
  try {
    const result = await complete(
      { system: REWRITE_PROMPT, user: question, maxTokens: 200, json: true },
      'utility'
    );

    const parsed = parseJson<{ query?: string; format?: string | null; needsLiveData?: boolean }>(
      result.text
    );
    if (!parsed) return { query: question, format: null, needsLiveData: false };

    const format = ['test', 'odi', 't20i'].includes(String(parsed.format))
      ? String(parsed.format)
      : null;

    return {
      query: parsed.query?.trim() || question,
      format,
      needsLiveData: parsed.needsLiveData === true,
    };
  } catch (err) {
    console.warn('Query rewrite failed, using raw question:', describeError(err));
    return { query: question, format: null, needsLiveData: false };
  }
}

/**
 * Step 3 -- reranking.
 * Hybrid search optimises for recall by over-fetching; precision is recovered
 * here. One listwise pass is cheaper and markedly better than pointwise
 * scoring, because the model compares passages against each other rather than
 * guessing an absolute relevance number. On failure we keep the fusion order,
 * which is already reasonable.
 */
async function rerank(
  question: string,
  candidates: RetrievedChunk[],
  topK: number
): Promise<RetrievedChunk[]> {
  if (candidates.length <= topK) return candidates;

  const listing = candidates
    .map((c, i) => `[${i}] ${c.content.slice(0, 400).replace(/\s+/g, ' ')}`)
    .join('\n\n');

  try {
    const result = await complete(
      {
        system:
          'You rank passages by how directly they answer the question. ' +
          `Return JSON {"order": number[]} listing the ${topK} most useful passage indices, best first. Indices only, no prose.`,
        user: `Question: ${question}\n\nPassages:\n${listing}`,
        maxTokens: 200,
        json: true,
      },
      'utility'
    );

    const order = parseJson<{ order?: unknown }>(result.text)?.order;
    if (!Array.isArray(order)) return candidates.slice(0, topK);

    const seen = new Set<number>();
    const ranked: RetrievedChunk[] = [];

    for (const idx of order) {
      const i = Number(idx);
      if (Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i)) {
        seen.add(i);
        ranked.push(candidates[i]);
      }
      if (ranked.length >= topK) break;
    }

    // Top up from fusion order if the model returned too few valid indices.
    for (let i = 0; i < candidates.length && ranked.length < topK; i++) {
      if (!seen.has(i)) ranked.push(candidates[i]);
    }

    return ranked;
  } catch (err) {
    console.warn('Rerank failed, keeping fusion order:', describeError(err));
    return candidates.slice(0, topK);
  }
}

function buildContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const label = c.law_number ? `Law/Clause ${c.law_number}` : (c.law_title ?? 'Passage');
      return `[${i + 1}] (${c.source} - ${label})\n${c.content}`;
    })
    .join('\n\n---\n\n');
}

function toCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((c, i) => ({
    n: i + 1,
    source: c.source,
    law: c.law_number ? `Law ${c.law_number}` : c.law_title,
    url: c.url && /^https?:\/\//.test(c.url) ? c.url : null,
    snippet: c.content.replace(/^\[[^\]]*\]\n?/, '').slice(0, 220).trim() + '...',
  }));
}

export async function queryRAG(question: string): Promise<RAGResult> {
  const startedAt = Date.now();
  let degraded: string | undefined;

  // 1. Rewrite the question into corpus vocabulary.
  const { query, format, needsLiveData } = await rewriteQuery(question);

  // 2. Hybrid retrieval (dense + lexical, fused with RRF inside Postgres).
  const embedding = await embedText(query);
  const candidates = await hybridSearch(query, embedding, config.retrieval.candidateCount, format);

  // 3. Rerank down to the passages actually worth spending context on.
  const topChunks = await rerank(question, candidates, config.retrieval.topK);

  const context = topChunks.length > 0 ? buildContext(topChunks) : null;

  const userContent = context
    ? `CONTEXT (numbered passages from the Laws of Cricket and ICC Playing Conditions):\n\n${context}\n\n---\n\nQuestion: ${question}`
    : `Question: ${question}\n\nNote: no relevant passages were retrieved from the indexed laws. Say clearly if you cannot ground the answer.`;

  // 4. Answer. Web search is offered only when the rewrite step judged the
  //    question to need live data, or when retrieval came back empty -- there
  //    is no reason to pay for it on "when is a batsman out LBW".
  const wantWebSearch = config.anthropicEnabled && (needsLiveData || topChunks.length === 0);

  let result;
  try {
    result = await complete(
      { system: SYSTEM_PROMPT, user: userContent, maxTokens: 1200, webSearch: wantWebSearch },
      'answer'
    );
  } catch (err) {
    // Both providers failed -- surface it rather than returning a fake answer.
    throw new Error(`Answer generation failed: ${describeError(err)}`);
  }

  if (wantWebSearch && !result.usedWebSearch && result.provider === 'openai') {
    degraded = 'question needed live data but ran on the OpenAI fallback, which has no web search';
  }

  return {
    answer: result.text || 'No answer generated.',
    // Only surface passages the model was actually given.
    sources: toCitations(topChunks),
    usedWebSearch: result.usedWebSearch,
    diagnostics: {
      rewrittenQuery: query,
      formatFilter: format,
      candidates: candidates.length,
      used: topChunks.length,
      provider: result.provider,
      model: result.model,
      latencyMs: Date.now() - startedAt,
      ...(degraded ? { degraded } : {}),
    },
  };
}
