import { Router, Request, Response } from 'express';
import { queryRAG } from '../rag';

const router = Router();

// GET /query/search?term=free+hit — text search in chunks
router.get('/search', async (req: Request, res: Response) => {
  const term = String(req.query.term || '');
  if (!term) return res.status(400).json({ error: 'term required' });
  const { default: supabase } = await import('../supabase');
  const { data } = await supabase.from('documents').select('url, content').ilike('content', `%${term}%`).limit(3);
  return res.json((data || []).map(d => ({ url: d.url, snippet: d.content.slice(0, 400) })));
});

// GET /query/sample?source=ICC+T20I+Playing+Conditions — shows a raw chunk
router.get('/sample', async (req: Request, res: Response) => {
  const source = String(req.query.source || 'ICC T20I Playing Conditions');
  const { default: supabase } = await import('../supabase');
  const { data } = await supabase.from('documents').select('content, url').eq('url', source).limit(3);
  return res.json((data || []).map(d => ({ url: d.url, content: d.content.slice(0, 500) })));
});

// GET /query/sources — shows chunk count per source
router.get('/sources', async (_req: Request, res: Response) => {
  const { default: supabase } = await import('../supabase');
  const { data } = await supabase.from('documents').select('url');
  const counts: Record<string, number> = {};
  for (const row of (data || [])) {
    counts[row.url] = (counts[row.url] || 0) + 1;
  }
  return res.json(counts);
});

// GET /query/debug?q=question — shows raw chunks retrieved
router.get('/debug', async (req: Request, res: Response) => {
  const question = String(req.query.q || '');
  if (!question) return res.status(400).json({ error: 'q param required' });
  const { embedText } = await import('../embedder');
  const { searchSimilar } = await import('../supabase');
  const embedding = await embedText(question);
  const matches = await searchSimilar(embedding, 5);
  return res.json(matches.map(m => ({ similarity: m.similarity, url: m.url, snippet: m.content.slice(0, 300) })));
});

// POST /query — ask a cricket law question
router.post('/', async (req: Request, res: Response) => {
  const { question } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'question is required' });
  }

  try {
    const result = await queryRAG(question.trim());
    return res.json(result);
  } catch (err) {
    console.error('Query error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
