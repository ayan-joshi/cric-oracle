/**
 * Local indexing CLI:  npm run index
 *
 * Indexing used to run only through POST /crawl, which is a poor fit: the
 * pipeline takes several minutes, and platform request timeouts (Render's
 * included) can kill the HTTP connection mid-run, leaving the corpus cleared
 * but not repopulated. Running it as a script removes the HTTP layer from a
 * job that never needed it. The route still exists for remote re-indexing.
 *
 * Flags:
 *   --dry-run        crawl and chunk, print the plan, embed nothing, write nothing
 *   --only=mcc|icc   re-index just one source family, leaving the other intact
 *   --allow-partial  skip the corpus-completeness check (dangerous: replaces
 *                    the corpus with whatever happened to be reachable)
 */

import { crawlLaws, assertCorpusComplete, SourceDocument } from './crawler';
import { chunkAllDocuments } from './chunker';
import { embedChunks } from './embedder';
import {
  insertDocuments,
  deleteDocumentsBySources,
  getDocumentCount,
  getSourceBreakdown,
} from './supabase';
import { describeError } from './errors';

function parseOnly(): 'mcc' | 'icc' | null {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  const value = arg.split('=')[1];
  if (value !== 'mcc' && value !== 'icc') {
    throw new Error(`--only must be "mcc" or "icc", got "${value}"`);
  }
  return value;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const allowPartial = process.argv.includes('--allow-partial');
  const only = parseOnly();
  const startedAt = Date.now();

  console.log(`\n=== CricOracle indexing ${dryRun ? '(dry run) ' : ''}${only ? `[${only} only] ` : ''}===\n`);

  console.log('Step 1: crawling...');
  const crawled = await crawlLaws(only);
  if (crawled.length === 0) throw new Error('No documents crawled -- check the source URLs.');

  const documents: SourceDocument[] = only ? crawled.filter((d) => d.source_type === only) : crawled;

  if (documents.length === 0) {
    throw new Error(`Crawl returned no ${only} documents -- nothing to re-index.`);
  }

  // Abort before anything is deleted if the crawl came back incomplete.
  // A scoped run only has to be complete for the scope it claims to replace.
  if (allowPartial) {
    console.warn('\n  WARNING: --allow-partial set, completeness check skipped.');
    console.warn('  This will REPLACE the targeted sources with whatever was crawled.\n');
  } else if (only === 'icc') {
    if (documents.length < 3) {
      throw new Error(
        `Refusing to replace ICC sources: only ${documents.length}/3 ICC documents were reachable. ` +
          `Existing rows left untouched.`
      );
    }
  } else if (only === 'mcc') {
    assertCorpusComplete([...documents, { source_type: 'icc' } as SourceDocument]);
  } else {
    assertCorpusComplete(documents);
  }

  console.log('\nStep 2: chunking...');
  const chunks = chunkAllDocuments(documents);
  if (chunks.length === 0) throw new Error('Crawl produced no usable chunks.');

  const withLawNumber = chunks.filter((c) => c.law_number).length;
  const words = chunks.reduce((sum, c) => sum + c.content.split(/\s+/).length, 0);
  console.log(
    `\n  ${chunks.length} chunks, ${Math.round(words / chunks.length)} words avg, ` +
      `${withLawNumber} (${Math.round((withLawNumber / chunks.length) * 100)}%) carry a law/clause number`
  );

  if (dryRun) {
    console.log('\nDry run -- nothing embedded, nothing written.\n');
    console.log('Sample chunk:\n');
    console.log(chunks[Math.floor(chunks.length / 2)].content.slice(0, 600));
    console.log('');
    return;
  }

  console.log('\nStep 3: embedding...');
  const embedded = await embedChunks(chunks);

  // Swap late and per source: the existing corpus stays queryable through
  // crawling and embedding, and only the sources actually re-crawled are
  // replaced. A failure before this point leaves everything as it was.
  console.log('\nStep 4: replacing indexed sources...');
  const before = await getDocumentCount();
  const sources = [...new Set(documents.map((d) => d.source))];
  await deleteDocumentsBySources(sources);
  await insertDocuments(embedded);

  const breakdown = await getSourceBreakdown();
  const after = await getDocumentCount();
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  console.log(`\n=== Done in ${seconds}s (${before} -> ${after} chunks) ===`);
  for (const [source, count] of Object.entries(breakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${source}`);
  }
  console.log('\nNext: npm run eval\n');
}

main().catch((err) => {
  console.error(`\nIndexing failed: ${describeError(err)}\n`);
  process.exit(1);
});
