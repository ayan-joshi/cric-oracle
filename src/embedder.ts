import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 20;

export async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

export async function embedChunks(
  chunks: { url: string; content: string }[]
): Promise<{ url: string; content: string; embedding: number[] }[]> {
  const results: { url: string; content: string; embedding: number[] }[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content);

    console.log(
      `Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}...`
    );

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    });

    const embeddings = response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);

    for (let j = 0; j < batch.length; j++) {
      results.push({
        url: batch[j].url,
        content: batch[j].content,
        embedding: embeddings[j],
      });
    }

    if (i + BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
