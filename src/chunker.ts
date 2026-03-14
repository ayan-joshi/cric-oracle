import { CrawledPage } from './crawler';

export interface Chunk {
  url: string;
  content: string;
}

const CHUNK_SIZE = 350;      // words per chunk — balance between context and precision
const CHUNK_OVERLAP = 70;    // large overlap so neighbouring content shares context

function splitIntoWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function wordsToText(words: string[]): string {
  return words.join(' ');
}

export function chunkPage(page: CrawledPage): Chunk[] {
  const words = splitIntoWords(page.content);

  if (words.length === 0) return [];

  // If the page is short enough, keep it as one chunk
  if (words.length <= CHUNK_SIZE) {
    return [{ url: page.url, content: page.content }];
  }

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + CHUNK_SIZE, words.length);
    const chunkWords = words.slice(start, end);
    const content = wordsToText(chunkWords);

    chunks.push({ url: page.url, content });

    // Move forward by CHUNK_SIZE - CHUNK_OVERLAP so chunks overlap slightly
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks;
}

export function chunkAllPages(pages: CrawledPage[]): Chunk[] {
  const allChunks: Chunk[] = [];

  for (const page of pages) {
    const chunks = chunkPage(page);
    allChunks.push(...chunks);
  }

  console.log(`Created ${allChunks.length} chunks from ${pages.length} pages`);
  return allChunks;
}
