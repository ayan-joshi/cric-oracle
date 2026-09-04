import { Router, Request, Response, NextFunction } from 'express';
import { crawlLaws, assertCorpusComplete, IncompleteCrawlError } from '../crawler';
import { chunkAllDocuments } from '../chunker';
import { embedChunks } from '../embedder';
import { insertDocuments, clearDocuments, getDocumentCount, getSourceBreakdown } from '../supabase';
import { AppError } from '../errors';
import { config } from '../config';

const router = Router();

/** Only one indexing run at a time -- concurrent runs would duplicate the corpus. */
let indexingInProgress = false;

/**
 * Fail CLOSED.
 *
 * The previous guard was `if (secret && header !== secret) reject`, so an unset
 * CRAWL_SECRET silently left the endpoint open -- anyone could trigger a full
 * re-crawl plus thousands of embedding calls billed to our OpenAI key. A
 * missing secret is now a misconfiguration, not an open door.
 */
function requireCrawlSecret(req: Request, _res: Response, next: NextFunction) {
  if (!config.crawlSecret) {
    return next(
      new AppError(
        'Indexing is disabled: CRAWL_SECRET is not configured on this server.',
        503,
        'crawl_disabled'
      )
    );
  }
  if (req.headers['x-crawl-secret'] !== config.crawlSecret) {
    return next(new AppError('Unauthorized', 401, 'unauthorized'));
  }
  return next();
}

// POST /crawl -- crawl, chunk, embed, and store (admin only)
router.post('/', requireCrawlSecret, async (_req: Request, res: Response, next: NextFunction) => {
  if (indexingInProgress) {
    return next(new AppError('An indexing run is already in progress.', 409, 'already_running'));
  }
  indexingInProgress = true;

  try {
    console.log('\n=== Starting indexing pipeline ===');

    console.log('Step 1: Crawling MCC laws and ICC playing conditions...');
    const documents = await crawlLaws();
    if (documents.length === 0) {
      throw new AppError('No documents crawled -- check the source URLs.', 502, 'crawl_empty');
    }

    // Abort before the destructive swap if a source was unreachable. A crawl
    // that returns only the ICC PDFs is non-empty but would still delete every
    // MCC law on insert.
    try {
      assertCorpusComplete(documents);
    } catch (err) {
      if (err instanceof IncompleteCrawlError) {
        throw new AppError(err.message, 502, 'crawl_incomplete');
      }
      throw err;
    }

    console.log('Step 2: Chunking...');
    const chunks = chunkAllDocuments(documents);
    if (chunks.length === 0) {
      throw new AppError('Crawl produced no usable chunks.', 502, 'chunk_empty');
    }

    console.log('Step 3: Embedding...');
    const embedded = await embedChunks(chunks);

    // Swap late: the old corpus stays queryable through crawling and embedding,
    // so a failure in those stages leaves the site working instead of empty.
    console.log('Step 4: Replacing corpus...');
    const previous = await getDocumentCount();
    if (previous > 0) await clearDocuments();
    await insertDocuments(embedded);

    console.log('=== Indexing complete ===\n');

    return res.json({
      success: true,
      stats: {
        documents: documents.length,
        chunks: chunks.length,
        replaced: previous,
        bySource: await getSourceBreakdown(),
      },
    });
  } catch (err) {
    return next(err);
  } finally {
    indexingInProgress = false;
  }
});

// GET /crawl/status -- how many chunks are indexed
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [indexed, bySource] = await Promise.all([getDocumentCount(), getSourceBreakdown()]);
    return res.json({ indexed, bySource, indexing: indexingInProgress });
  } catch (err) {
    return next(err);
  }
});

export default router;
