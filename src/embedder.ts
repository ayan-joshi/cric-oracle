import OpenAI from 'openai';
import { config } from './config';
import { Chunk } from './chunker';
import { DocumentRecord } from './supabase';

const openai = new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 3, timeout: 30000 });

const BATCH_SIZE = 64;

/**
 * Query embeddings are cached in-process. The example questions on the landing
 * page are asked constantly, and re-embedding identical text is pure waste.
 */
const queryCache = new Map<string, number[]>();
const QUERY_CACHE_MAX = 500;

export async function embedText(text: string): Promise<number[]> {
  const key = text.trim().toLowerCase();
  const cached = queryCache.get(key);
  if (cached) return cached;

  const response = await openai.embeddings.create({
    model: config.models.embedding,
    input: text,
  });

  const embedding = response.data[0].embedding;

  if (queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest !== undefined) queryCache.delete(oldest);
  }
  queryCache.set(key, embedding);

  return embedding;
}

export async function embedChunks(chunks: Chunk[]): Promise<DocumentRecord[]> {
  const results: DocumentRecord[] = [];
  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches}...`);

    const response = await openai.embeddings.create({
      model: config.models.embedding,
      input: batch.map((c) => c.content),
    });

    // The API does not guarantee response order; sort by index before zipping.
    const embeddings = response.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);

    for (let j = 0; j < batch.length; j++) {
      results.push({
        source: batch[j].source,
        source_type: batch[j].source_type,
        format: batch[j].format,
        law_number: batch[j].law_number,
        law_title: batch[j].law_title,
        url: batch[j].url,
        content: batch[j].content,
        embedding: embeddings[j],
      });
    }

    if (i + BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return results;
}
