import OpenAI from 'openai';
import { embedText } from './embedder';
import { searchSimilar } from './supabase';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are CricOracle, an expert AI cricket umpire with complete knowledge of the MCC Laws of Cricket and ICC Playing Conditions for all formats (Test, ODI, T20I).

Your job is to give clear, accurate, authoritative answers to cricket law questions — like a senior ICC panel umpire explaining a ruling.

Rules:
- Always cite the exact law or clause (e.g. "Law 36.1.2", "Law 28.3", "ICC T20I Clause 41.6").
- Give a direct verdict first, then explain the reasoning.
- If the answer differs by format (Test vs ODI vs T20), clearly explain the difference.
- Use plain language — explain as if talking to a player or fan, not a lawyer.
- Keep answers focused: 3-6 sentences for simple rules, up to 10 for complex ones.
- Never say "not covered" unless the topic is completely absent from the context. If partially covered, use what you have.`;

export interface RAGResult {
  answer: string;
  sources: { url: string; snippet: string }[];
}

export async function queryRAG(question: string): Promise<RAGResult> {
  console.log('Embedding question...');
  const queryEmbedding = await embedText(question);

  console.log('Searching for relevant laws...');
  const matches = await searchSimilar(queryEmbedding, 10);

  if (matches.length === 0) {
    return {
      answer: "I couldn't find relevant laws in my database. Please run /crawl first to index the cricket laws.",
      sources: [],
    };
  }

  const context = matches
    .map((m, i) => `[Source ${i + 1} — ${m.url}]\n${m.content}`)
    .join('\n\n---\n\n');

  console.log('Generating answer...');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Context from the Laws of Cricket:\n\n${context}\n\n---\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
  });

  const answer = completion.choices[0].message.content || 'No answer generated.';

  const sources = matches.map((m) => ({
    url: m.url,
    snippet: m.content.slice(0, 150) + '...',
  }));

  return { answer, sources };
}
