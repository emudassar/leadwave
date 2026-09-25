import express, { type Express, type Request } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env, isDevelopment } from './env.js';
import { logger } from './lib/logger.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiRouter } from './routes/index.js';
import { publicRouter } from './routes/public.js';
import { webhookRouter } from './webhooks/index.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy in production, so req.ip and secure cookies work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The short-link redirect and the public bio page are meant to be
      // embedded and opened from anywhere, including in-app browsers.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req: { url?: string }) =>
          req.url === '/health' || req.url === '/api/v1/health',
      },
    }),
  );

  const allowedOrigins = new Set([env.APP_URL, env.WEB_URL, env.SHORTLINK_URL]);
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests arrive without an Origin.
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin) || isDevelopment) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed.`));
      },
      credentials: true,
    }),
  );

  /**
   * Meta signs webhook payloads over the exact bytes it sent, so the raw body
   * has to survive JSON parsing. Everything else uses the normal parser.
   */
  app.use(
    express.json({
      limit: '2mb',
      verify(req: Request & { rawBody?: Buffer }, _res, buf) {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', uptime: process.uptime() } });
  });

  // Webhooks authenticate by signature, not by session.
  app.use('/webhooks', webhookRouter);

  // Short links and public bio pages — no session required.
  app.use('/', publicRouter);

  app.use('/api/v1', attachUser, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
