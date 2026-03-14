import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export interface Document {
  id?: number;
  url: string;
  content: string;
  embedding: number[];
}

export async function insertDocuments(docs: Document[]): Promise<void> {
  const BATCH = 50;

  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const { error } = await supabase.from('documents').insert(batch);

    if (error) {
      console.error('Insert error:', error.message);
      throw error;
    }

    console.log(`Inserted ${Math.min(i + BATCH, docs.length)}/${docs.length} documents`);
  }
}

export async function searchSimilar(
  queryEmbedding: number[],
  limit = 5
): Promise<{ url: string; content: string; similarity: number }[]> {
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_threshold: 0.05,
    match_count: limit,
  });

  if (error) {
    console.error('Search error:', error.message);
    throw error;
  }

  console.log(`Vector search returned ${data?.length ?? 0} results`);
  return data || [];
}

export async function clearDocuments(): Promise<void> {
  const { error } = await supabase.from('documents').delete().neq('id', 0);
  if (error) throw error;
  console.log('Cleared all documents');
}

export async function getDocumentCount(): Promise<number> {
  const { count, error } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

export default supabase;
