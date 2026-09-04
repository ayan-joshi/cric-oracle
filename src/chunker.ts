import { SourceDocument } from './crawler';

export interface Chunk {
  source: string;
  source_type: 'mcc' | 'icc';
  format: 'test' | 'odi' | 't20i' | null;
  law_number: string | null;
  law_title: string | null;
  url: string;
  content: string;
}

const TARGET_WORDS = 320;   // aim per chunk
const MAX_WORDS = 450;      // hard ceiling before we force a split
const OVERLAP_WORDS = 60;   // trailing context carried into the next chunk

/**
 * Matches a numbered clause at the start of a line: "36.1.2 The bowler...",
 * "41.6 Bowling of dangerous...". Both the MCC pages and the ICC PDFs use this
 * convention, and it is the single most useful structural signal in the corpus.
 */
const CLAUSE_HEADING = /^[ \t]*(\d{1,2}(?:\.\d{1,2})+)[ \t.)]+\S/;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Splits a document into the smallest units we are willing to keep whole.
 * Prefers clause boundaries, falls back to paragraphs, then to sentences.
 */
function segment(text: string): string[] {
  const lines = text.split('\n');
  const clauseStarts = lines.filter((l) => CLAUSE_HEADING.test(l)).length;

  // Clause-based segmentation, when the document actually is clause-structured.
  if (clauseStarts >= 3) {
    const segments: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (CLAUSE_HEADING.test(line) && current.length > 0) {
        segments.push(current.join('\n').trim());
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) segments.push(current.join('\n').trim());
    return splitOversized(segments.filter((s) => s.length > 0));
  }

  // Paragraph fallback.
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length > 1) return splitOversized(paragraphs);

  // Single blob (common for badly-extracted PDF text): fall back to sentences.
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  return splitOversized(sentences ? sentences.map((s) => s.trim()) : [text.trim()]);
}

/** Any segment longer than MAX_WORDS is hard-split so it can never blow a chunk. */
function splitOversized(segments: string[]): string[] {
  const out: string[] = [];

  for (const seg of segments) {
    const words = seg.split(/\s+/).filter(Boolean);
    if (words.length <= MAX_WORDS) {
      out.push(seg);
      continue;
    }
    for (let i = 0; i < words.length; i += MAX_WORDS) {
      out.push(words.slice(i, i + MAX_WORDS).join(' '));
    }
  }

  return out;
}

/** First clause number appearing in a chunk, used for citation metadata. */
function clauseNumberIn(text: string): string | null {
  for (const line of text.split('\n')) {
    const match = line.match(CLAUSE_HEADING);
    if (match) return match[1];
  }
  return null;
}

/**
 * Every chunk is prefixed with its own provenance before being embedded.
 * A bare fragment like "the ball must not bounce more than once" is nearly
 * unretrievable; the same text under "Law 21 - No ball (MCC Laws of Cricket)"
 * matches both the vector query and the lexical query for "no ball law".
 */
function contextHeader(doc: SourceDocument, clauseNumber: string | null): string {
  const parts: string[] = [];

  if (doc.source_type === 'mcc') {
    const number = clauseNumber ?? doc.law_number;
    parts.push(number ? `Law ${number} - ${doc.law_title}` : String(doc.law_title));
    parts.push('MCC Laws of Cricket');
  } else {
    parts.push(clauseNumber ? `Clause ${clauseNumber}` : String(doc.law_title));
    parts.push(doc.source);
    if (doc.format) parts.push(`Format: ${doc.format.toUpperCase()}`);
  }

  return `[${parts.join(' | ')}]`;
}

export function chunkDocument(doc: SourceDocument): Chunk[] {
  const segments = segment(doc.content);
  if (segments.length === 0) return [];

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferWords = 0;

  const flush = () => {
    if (buffer.length === 0) return;

    const body = buffer.join('\n\n').trim();
    if (body.length < 40) return; // drop scraps

    const clauseNumber = clauseNumberIn(body);
    chunks.push({
      source: doc.source,
      source_type: doc.source_type,
      format: doc.format,
      law_number: clauseNumber ?? doc.law_number,
      law_title: doc.law_title,
      url: doc.url,
      content: `${contextHeader(doc, clauseNumber)}\n${body}`,
    });
  };

  for (const seg of segments) {
    const segWords = wordCount(seg);

    if (bufferWords > 0 && bufferWords + segWords > TARGET_WORDS) {
      flush();

      // Carry the tail of the previous chunk forward so a rule split across a
      // boundary is still fully present in at least one chunk.
      const tail = buffer.join('\n\n').split(/\s+/).slice(-OVERLAP_WORDS).join(' ');
      buffer = tail.length > 0 ? [tail] : [];
      bufferWords = wordCount(tail);
    }

    buffer.push(seg);
    bufferWords += segWords;
  }

  flush();
  return chunks;
}

export function chunkAllDocuments(docs: SourceDocument[]): Chunk[] {
  const all: Chunk[] = [];

  for (const doc of docs) {
    const chunks = chunkDocument(doc);
    all.push(...chunks);
    console.log(`  ${chunks.length.toString().padStart(4)} chunks  <-  ${doc.law_title ?? doc.source}`);
  }

  console.log(`Created ${all.length} chunks from ${docs.length} documents`);
  return all;
}
