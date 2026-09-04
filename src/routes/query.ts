import { Router, Request, Response, NextFunction } from 'express';
import { queryRAG } from '../rag';
import { embedText } from '../embedder';
import { hybridSearch, searchSimilar, getSourceBreakdown } from '../supabase';
import { AppError } from '../errors';
import { config } from '../config';

const router = Router();

/**
 * Every question costs an embedding call plus two-to-three LLM calls, all
 * billed to our key on a public endpoint. A simple per-IP token bucket is the
 * difference between a demo and an open invoice.
 */
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE) || 12;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }

  if (bucket.count >= RATE_LIMIT) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: `Rate limit reached (${RATE_LIMIT} questions/minute). Try again in ${retryAfter}s.`,
      code: 'rate_limited',
    });
  }

  bucket.count++;
  return next();
}

// Periodically drop expired buckets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(ip);
  }
}, 60_000).unref();

// POST /query -- ask a cricket law question
router.post('/', rateLimit, async (req: Request, res: Response, next: NextFunction) => {
  const { question } = req.body ?? {};

  if (typeof question !== 'string' || question.trim().length === 0) {
    return next(new AppError('A non-empty "question" field is required.', 400, 'bad_request'));
  }
  if (question.length > 500) {
    return next(new AppError('Question must be 500 characters or fewer.', 400, 'bad_request'));
  }

  try {
    const result = await queryRAG(question.trim());

    console.log(
      `[query] "${question.trim().slice(0, 60)}" -> ${result.diagnostics.used}/${result.diagnostics.candidates} chunks, ` +
        `${result.diagnostics.latencyMs}ms, web=${result.usedWebSearch}` +
        (result.diagnostics.degraded ? `, degraded=${result.diagnostics.degraded}` : '')
    );

    return res.json({
      answer: result.answer,
      sources: result.sources,
      usedWebSearch: result.usedWebSearch,
      diagnostics: config.nodeEnv === 'production' ? undefined : result.diagnostics,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /query/debug?q=... -- side-by-side dense vs hybrid retrieval
router.get('/debug', async (req: Request, res: Response, next: NextFunction) => {
  const question = String(req.query.q ?? '');
  if (!question) return next(new AppError('q param required', 400, 'bad_request'));

  try {
    const embedding = await embedText(question);
    const [dense, hybrid] = await Promise.all([
      searchSimilar(embedding, 5),
      hybridSearch(question, embedding, 5),
    ]);

    const shape = (m: { similarity: number; score?: number; source: string; law_number: string | null; content: string }) => ({
      similarity: Number(m.similarity?.toFixed(4)),
      score: m.score !== undefined ? Number(m.score.toFixed(5)) : undefined,
      source: m.source,
      law: m.law_number,
      snippet: m.content.slice(0, 200),
    });

    return res.json({ question, dense: dense.map(shape), hybrid: hybrid.map(shape) });
  } catch (err) {
    return next(err);
  }
});

// GET /query/sources -- chunk count per source
router.get('/sources', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json(await getSourceBreakdown());
  } catch (err) {
    return next(err);
  }
});

export default router;
