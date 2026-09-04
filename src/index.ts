import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { config, describeConfig } from './config';
import { AppError, describeError } from './errors';
import { checkDatabase } from './supabase';
import { checkLLM } from './llm';
import crawlRouter from './routes/crawl';
import queryRouter from './routes/query';

const app = express();

app.set('trust proxy', 1); // Render/Vercel sit behind a proxy; needed for real req.ip
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '../public')));

/**
 * Dependency-aware health check.
 *
 * The outage that motivated this returned 500s from two unrelated causes (a
 * paused database and a missing web-search key) that were indistinguishable
 * from the outside. This endpoint names which dependency is down, and
 * deliberately reports degraded-but-serving as 200: losing the primary answer
 * provider does not stop CricOracle answering from the indexed laws.
 */
app.get('/health', async (_req: Request, res: Response) => {
  const [database, generation] = await Promise.all([checkDatabase(), checkLLM()]);

  const healthy = database.ok;
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? (generation.ok ? 'ok' : 'degraded') : 'unhealthy',
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database, generation },
    config: describeConfig(),
  });
});

app.use('/crawl', crawlRouter);
app.use('/query', queryRouter);

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', code: 'not_found' });
});

// Central error handler -- the single place that converts a thrown value into
// a response. `describeError` is what stops Supabase's plain-object errors
// from being reported as the useless string "[object Object]".
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof AppError ? err.status : 500;
  const code = err instanceof AppError ? err.code : 'internal_error';
  const message = describeError(err);

  console.error(`[error] ${status} ${code}: ${message}`);
  if (!(err instanceof AppError) && err instanceof Error && err.stack) {
    console.error(err.stack);
  }

  res.status(status).json({ error: message, code });
});

function start() {
  try {
    // Touching `config` here forces env validation to run at boot, so a missing
    // variable is a loud startup crash rather than a 500 on the first request.
    const summary = describeConfig();

    app.listen(config.port, () => {
      console.log(`CricOracle listening on port ${config.port}`);
      console.log(`  config: ${JSON.stringify(summary)}`);
      if (!summary.crawlProtected) {
        console.warn('  WARNING: CRAWL_SECRET unset -- /crawl is disabled until you set it.');
      }
      if (!summary.serviceRoleConfigured) {
        console.warn('  WARNING: SUPABASE_SERVICE_ROLE_KEY unset -- indexing will fail once RLS is enabled.');
      }
    });
  } catch (err) {
    console.error(`Startup failed: ${describeError(err)}`);
    process.exit(1);
  }
}

start();

export default app;
