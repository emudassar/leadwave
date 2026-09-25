import pino from 'pino';
import { env, isDevelopment } from '../env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isDevelopment
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'accessToken',
      'access_token',
      'refreshToken',
      '*.accessTokenCipher',
      '*.refreshTokenCipher',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
