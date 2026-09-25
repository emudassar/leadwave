import { z } from 'zod';

/**
 * Environment is validated once, at boot. A missing or malformed value stops
 * the process with a readable list rather than surfacing as a confusing
 * undefined three layers deep at 2am.
 *
 * Integration credentials are optional: the product should boot and run without
 * a Meta app or a Gemini key so a developer can work on the parts that don't
 * need them. Each feature checks its own credentials when it is actually used.
 */

const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes) — try `openssl rand -hex 32`');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:4321'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  SHORTLINK_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** Run the queue workers inside the API process — for hosts without a free
   * tier for a separate background-worker service. */
  RUN_EMBEDDED_WORKER: z.coerce.boolean().default(false),

  SESSION_SECRET: hex64,
  ENCRYPTION_KEY: hex64,

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_SHEETS_CLIENT_ID: z.string().optional(),
  GOOGLE_SHEETS_CLIENT_SECRET: z.string().optional(),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_LOGIN_CONFIG_ID: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1).default('leadwave-dev-verify'),
  META_GRAPH_VERSION: z.string().default('v21.0'),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_FAST: z.string().default('gemini-2.5-flash-lite'),
  GEMINI_MODEL_STANDARD: z.string().default('gemini-2.5-flash'),

  BILLING_PROVIDER: z.enum(['paddle', 'lemonsqueezy', 'manual']).default('manual'),
  PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PADDLE_API_KEY: z.string().optional(),
  PADDLE_WEBHOOK_SECRET: z.string().optional(),
  PADDLE_CLIENT_TOKEN: z.string().optional(),
  PADDLE_PRICE_PRO_MONTHLY: z.string().optional(),
  PADDLE_PRICE_PRO_YEARLY: z.string().optional(),
  PADDLE_PRICE_GROWTH_MONTHLY: z.string().optional(),
  PADDLE_PRICE_GROWTH_YEARLY: z.string().optional(),
  PADDLE_PRICE_BUSINESS_MONTHLY: z.string().optional(),
  PADDLE_PRICE_BUSINESS_YEARLY: z.string().optional(),

  LEMONSQUEEZY_API_KEY: z.string().optional(),
  LEMONSQUEEZY_STORE_ID: z.string().optional(),
  LEMONSQUEEZY_WEBHOOK_SECRET: z.string().optional(),
  LEMONSQUEEZY_VARIANT_PRO_MONTHLY: z.string().optional(),
  LEMONSQUEEZY_VARIANT_PRO_YEARLY: z.string().optional(),
  LEMONSQUEEZY_VARIANT_GROWTH_MONTHLY: z.string().optional(),
  LEMONSQUEEZY_VARIANT_GROWTH_YEARLY: z.string().optional(),
  LEMONSQUEEZY_VARIANT_BUSINESS_MONTHLY: z.string().optional(),
  LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY: z.string().optional(),

  UPLOAD_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),

  ADMIN_EMAILS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`);
    console.error(`\nInvalid environment:\n${lines.join('\n')}\n`);
    console.error('Copy .env.example to .env and fill in the blanks.\n');
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

export const adminEmails = new Set(
  env.ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

/** Whether an optional integration is configured well enough to be used. */
export const configured = {
  googleAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  googleSheets: Boolean(env.GOOGLE_SHEETS_CLIENT_ID && env.GOOGLE_SHEETS_CLIENT_SECRET),
  meta: Boolean(env.META_APP_ID && env.META_APP_SECRET),
  gemini: Boolean(env.GEMINI_API_KEY),
  paddle: Boolean(env.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET),
  lemonsqueezy: Boolean(env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_WEBHOOK_SECRET),
};
