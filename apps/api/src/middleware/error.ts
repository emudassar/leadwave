import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@leadwave/db';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProduction } from '../env.js';

/**
 * The single place an error turns into a response. Known errors keep their
 * status and machine code; anything else becomes a 500 with a generic message,
 * so an unexpected failure never leaks a stack trace or a SQL fragment.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  const { status, code, message, details } = classify(err);

  if (status >= 500) {
    logger.error({ err, path: req.path, method: req.method }, 'unhandled request error');
  } else {
    logger.debug({ code, path: req.path, status }, 'request rejected');
  }

  res.status(status).json({
    data: null,
    error: { code, message, ...(details ? { details } : {}) },
    message,
  });
}

function classify(err: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      code: 'bad_request',
      message: 'Some fields need attention.',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return { status: 409, code: 'conflict', message: 'That already exists.' };
    }
    if (err.code === 'P2025') {
      return { status: 404, code: 'not_found', message: 'Not found.' };
    }
  }

  if (!isProduction && err instanceof Error) {
    return { status: 500, code: 'internal_error', message: err.message };
  }

  return {
    status: 500,
    code: 'internal_error',
    message: 'Something went wrong on our end.',
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    data: null,
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}.` },
    message: 'Not found.',
  });
}
