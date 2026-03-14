import { Router, Request, Response } from 'express';
import { crawlLaws } from '../crawler';
import { chunkAllPages } from '../chunker';
import { embedChunks } from '../embedder';
import { insertDocuments, clearDocuments, getDocumentCount } from '../supabase';

const router = Router();

// POST /crawl — crawl, chunk, embed, and store (admin only)
router.post('/', async (req: Request, res: Response) => {
  const secret = process.env.CRAWL_SECRET;
  if (secret && req.headers['x-crawl-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('\n=== Starting indexing pipeline ===');

    // Check if already indexed
    const existing = await getDocumentCount();
    if (existing > 0) {
      console.log(`Clearing ${existing} existing documents...`);
      await clearDocuments();
    }

    // Step 1: Crawl
    console.log('Step 1: Crawling laws.mcc.org.uk...');
    const pages = await crawlLaws();

    if (pages.length === 0) {
      return res.status(500).json({ error: 'No pages crawled. Check the crawler URL.' });
    }

    // Step 2: Chunk
    console.log('Step 2: Chunking pages...');
    const chunks = chunkAllPages(pages);

    // Step 3: Embed
    console.log('Step 3: Embedding chunks...');
    const embedded = await embedChunks(chunks);

    // Step 4: Store
    console.log('Step 4: Storing in Supabase...');
    await insertDocuments(embedded);

    console.log('=== Indexing complete ===\n');

    return res.json({
      success: true,
      stats: {
        pages: pages.length,
        chunks: chunks.length,
        documents: embedded.length,
      },
    });
  } catch (err) {
    console.error('Crawl error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// GET /crawl/status — how many docs are indexed
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const count = await getDocumentCount();
    return res.json({ indexed: count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
