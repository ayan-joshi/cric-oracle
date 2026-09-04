import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import { assertNoSupabaseError, AppError, describeError } from './errors';

/** Public read path -- anon key, restricted to SELECT by RLS. */
const readClient: SupabaseClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false },
});

/** Indexing path -- service-role key, bypasses RLS. */
const writeClient: SupabaseClient = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

export interface DocumentRecord {
  source: string;
  source_type: 'mcc' | 'icc';
  format: string | null;
  law_number: string | null;
  law_title: string | null;
  url: string | null;
  content: string;
  embedding: number[];
}

export interface RetrievedChunk {
  id: number;
  url: string | null;
  source: string;
  law_number: string | null;
  law_title: string | null;
  content: string;
  similarity: number;
  score?: number;
}

export async function insertDocuments(docs: DocumentRecord[]): Promise<void> {
  const BATCH = 50;

  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const { error } = await writeClient.from('documents').insert(batch);
    assertNoSupabaseError(error, 'insertDocuments');
    console.log(`Inserted ${Math.min(i + BATCH, docs.length)}/${docs.length} documents`);
  }
}

/** Dense-only vector search. Used by /query/debug and as a hybrid fallback. */
export async function searchSimilar(
  queryEmbedding: number[],
  limit = config.retrieval.topK,
  filterFormat: string | null = null
): Promise<RetrievedChunk[]> {
  const { data, error } = await readClient.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_threshold: config.retrieval.minSimilarity,
    match_count: limit,
    filter_format: filterFormat,
  });

  assertNoSupabaseError(error, 'match_documents');
  return (data ?? []) as RetrievedChunk[];
}

/**
 * Hybrid search: dense vectors + Postgres full-text, fused server-side with
 * Reciprocal Rank Fusion. Falls back to dense-only if the RPC is unavailable,
 * so a partially-applied schema degrades instead of erroring.
 */
export async function hybridSearch(
  queryText: string,
  queryEmbedding: number[],
  limit = config.retrieval.candidateCount,
  filterFormat: string | null = null,
  weights: { fullText?: number; semantic?: number } = {}
): Promise<RetrievedChunk[]> {
  const { data, error } = await readClient.rpc('hybrid_search', {
    query_text: queryText,
    query_embedding: queryEmbedding,
    match_count: limit,
    filter_format: filterFormat,
    full_text_weight: weights.fullText ?? config.retrieval.fullTextWeight,
    semantic_weight: weights.semantic ?? config.retrieval.semanticWeight,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PGRST202') {
      console.warn('hybrid_search RPC missing, falling back to dense-only search');
      return searchSimilar(queryEmbedding, limit, filterFormat);
    }
    assertNoSupabaseError(error, 'hybrid_search');
  }

  return (data ?? []) as RetrievedChunk[];
}

export async function clearDocuments(): Promise<void> {
  const { error } = await writeClient.from('documents').delete().neq('id', 0);
  assertNoSupabaseError(error, 'clearDocuments');
  console.log('Cleared all documents');
}

/**
 * Deletes only the named sources.
 *
 * Whole-corpus replacement couples every source to the availability of every
 * other one: when lords.org was unreachable, the ICC PDFs could not be
 * refreshed either without destroying the MCC laws. Replacing per source makes
 * re-indexing incremental and lets a partial outage degrade to a partial
 * update instead of blocking all of them.
 */
export async function deleteDocumentsBySources(sources: string[]): Promise<number> {
  if (sources.length === 0) return 0;

  const { count, error } = await writeClient
    .from('documents')
    .delete({ count: 'exact' })
    .in('source', sources);

  assertNoSupabaseError(error, 'deleteDocumentsBySources');
  console.log(`  deleted ${count ?? 0} chunks from ${sources.length} source(s)`);
  return count ?? 0;
}

export async function getDocumentCount(): Promise<number> {
  const { count, error } = await readClient
    .from('documents')
    .select('*', { count: 'exact', head: true });

  assertNoSupabaseError(error, 'getDocumentCount');
  return count ?? 0;
}

export async function getSourceBreakdown(): Promise<Record<string, number>> {
  const { data, error } = await readClient.from('documents').select('source');
  assertNoSupabaseError(error, 'getSourceBreakdown');

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { source: string }[]) {
    counts[row.source] = (counts[row.source] ?? 0) + 1;
  }
  return counts;
}

/** Cheap liveness probe for /health -- distinguishes "DB down" from "schema missing". */
export async function checkDatabase(): Promise<{ ok: boolean; detail: string; indexed?: number }> {
  try {
    const indexed = await getDocumentCount();
    return { ok: true, detail: 'connected', indexed };
  } catch (err) {
    const status = err instanceof AppError ? err.code : 'unknown';
    return { ok: false, detail: `${status}: ${describeError(err)}` };
  }
}

export default readClient;
