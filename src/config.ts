import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in .env (local) or in your host's environment settings (production).`
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Generation runs on Claude when a key is present, otherwise on OpenAI.
 * ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL are the standard variables the
 * Anthropic SDK itself reads; CLAUDE_API_KEY is accepted as an alias.
 * Leave ANTHROPIC_BASE_URL unset to use the official API.
 */
const anthropicApiKey = optional('ANTHROPIC_API_KEY') ?? optional('CLAUDE_API_KEY');

export const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV ?? 'development',

  // Required: embeddings are OpenAI-only (Anthropic has no embeddings API),
  // so retrieval cannot run without this key regardless of the answer provider.
  openaiApiKey: required('OPENAI_API_KEY'),

  anthropicApiKey,
  anthropicBaseUrl: optional('ANTHROPIC_BASE_URL'),
  anthropicEnabled: Boolean(anthropicApiKey),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  // Writes bypass RLS and need the service-role key. Falls back to the anon
  // key so local dev works before RLS has been applied.
  supabaseServiceKey: optional('SUPABASE_SERVICE_ROLE_KEY') ?? required('SUPABASE_ANON_KEY'),

  crawlSecret: optional('CRAWL_SECRET'),

  models: {
    embedding: 'text-embedding-3-small',
    embeddingDimensions: 1536,

    // Answers get the strong model; rewrite/rerank are mechanical sub-tasks
    // that run on every query, so they get the cheap fast one.
    claudeAnswer: process.env.CLAUDE_ANSWER_MODEL ?? 'claude-opus-5',
    claudeUtility: process.env.CLAUDE_UTILITY_MODEL ?? 'claude-haiku-4-5',
    effort: (process.env.CLAUDE_EFFORT ?? 'medium') as 'low' | 'medium' | 'high',

    openaiAnswer: process.env.OPENAI_ANSWER_MODEL ?? 'gpt-4o-mini',
    openaiUtility: process.env.OPENAI_UTILITY_MODEL ?? 'gpt-4o-mini',
  },

  retrieval: {
    // Over-fetch, then let the reranker cut down to topK.
    candidateCount: Number(process.env.RETRIEVAL_CANDIDATES) || 20,
    topK: Number(process.env.RETRIEVAL_TOP_K) || 6,
    minSimilarity: Number(process.env.RETRIEVAL_MIN_SIMILARITY) || 0.05,
    // RRF fusion weights, chosen by measurement (npm run eval -- --sweep).
    //
    // Measured at k=20, the candidate depth that actually feeds the reranker:
    //   lexical 0.00 / semantic 1.00 -> recall@20  96.4%
    //   lexical 1.00 / semantic 1.00 -> recall@20 100.0%
    //
    // Equal weights win. Judged at k=6 the opposite looked true, but nothing
    // consumes 6 raw retrieval results -- retrieval feeds 20 candidates to a
    // reranker whose job is fixing order, so ordering metrics at k=6 penalise
    // hybrid for a failure the next stage repairs. Recall is the only property
    // no downstream stage can recover: a chunk absent from the candidate set
    // can never be reranked into it, nor cited by the model.
    fullTextWeight: Number(process.env.RETRIEVAL_FULLTEXT_WEIGHT) || 1.0,
    semanticWeight: Number(process.env.RETRIEVAL_SEMANTIC_WEIGHT) || 1.0,
  },
} as const;

export function describeConfig(): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    answerProvider: config.anthropicEnabled ? 'anthropic' : 'openai',
    answerModel: config.anthropicEnabled ? config.models.claudeAnswer : config.models.openaiAnswer,
    embeddingModel: config.models.embedding,
    anthropicBaseUrl: config.anthropicBaseUrl ?? 'default (api.anthropic.com)',
    crawlProtected: Boolean(config.crawlSecret),
    serviceRoleConfigured: Boolean(optional('SUPABASE_SERVICE_ROLE_KEY')),
  };
}
