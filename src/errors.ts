/**
 * Supabase's JS client never throws -- it returns `{ data, error }` where
 * `error` is a plain object. `String(someObject)` yields "[object Object]",
 * which is how this app previously reported every database failure. These
 * helpers make sure a real message always survives to the logs and the client.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
    readonly code: string = 'internal_error',
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts = [e.message, e.details, e.hint, e.code]
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(' | ');
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unserialisable error object';
    }
  }
  return String(err);
}

/** Turns a Supabase `{ error }` payload into a thrown AppError with real text. */
export function assertNoSupabaseError(error: unknown, operation: string): void {
  if (!error) return;

  const message = describeError(error);
  const code = (error as { code?: string })?.code;

  // PGRST205 = table missing, PGRST202 = function missing. Both mean the
  // schema was never applied, which is a setup problem, not a runtime one.
  if (code === 'PGRST205' || code === 'PGRST202') {
    throw new AppError(
      `Database schema is not set up (${code} during ${operation}): ${message}. ` +
        `Run supabase/schema.sql in the Supabase SQL Editor.`,
      503,
      'schema_missing',
      error
    );
  }

  throw new AppError(`${operation} failed: ${message}`, 500, code ?? 'database_error', error);
}
