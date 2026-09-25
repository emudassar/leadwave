import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError, badRequest } from './errors.js';

/**
 * Every response has the same envelope: `{ data }` on success, `{ error }` on
 * failure. The SPA's fetch layer relies on that being true without exception.
 */

export interface SuccessEnvelope<T> {
  data: T;
  message?: string;
}

export interface ErrorEnvelope {
  data: null;
  error: { code: string; message: string; details?: unknown };
  message: string;
}

export function ok<T>(res: Response, data: T, message?: string): void {
  const body: SuccessEnvelope<T> = message ? { data, message } : { data };
  res.json(body);
}

export function created<T>(res: Response, data: T, message?: string): void {
  res.status(201);
  ok(res, data, message);
}

export function noContent(res: Response): void {
  res.status(204).end();
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req as T, res, next).catch(next);
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, source: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      `Invalid ${source}.`,
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    );
  }
  return result.data;
}

export const parseBody = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> =>
  parse(schema, req.body, 'request body');

export const parseQuery = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> =>
  parse(schema, req.query, 'query parameters');

export const parseParams = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> =>
  parse(schema, req.params, 'URL parameters');

// ─── Shared query shapes ─────────────────────────────────────────────────────

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const idParamSchema = z.object({ id: z.string().min(1) });

/** Cursor pagination over a list already fetched with `limit + 1` rows. */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: items.at(-1)?.id ?? null };
}

export { ApiError };
