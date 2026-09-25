import { z } from 'zod';
import { configured, env } from '../../env.js';
import { logger } from '../../lib/logger.js';

/**
 * The Gemini client.
 *
 * Every model call in LeadWave goes through here, for three reasons: one place
 * knows the API shape, one place enforces timeouts and retries, and — most
 * importantly — one place constrains the model to a JSON schema. The callers
 * downstream (classifiers, generators, knowledge extraction) get typed objects
 * back, never free-form prose they have to parse hopefully.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GenerationUsage {
  model: string;
  promptTokens: number;
  outputTokens: number;
}

export interface GenerateOptions {
  /** 'fast' for classifiers and the free tools, 'standard' for generation. */
  tier?: 'fast' | 'standard';
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Retries on 429/5xx. Classifiers use 1; user-facing generation uses 2. */
  retries?: number;
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

function modelFor(tier: 'fast' | 'standard'): string {
  return tier === 'fast' ? env.GEMINI_MODEL_FAST : env.GEMINI_MODEL_STANDARD;
}

export function isGeminiConfigured(): boolean {
  return configured.gemini;
}

/** Plain text generation. Used where the output is prose, not a decision. */
export async function generateText(
  prompt: string,
  options: GenerateOptions = {},
): Promise<{ text: string; usage: GenerationUsage }> {
  const result = await callGemini(prompt, options, undefined);
  return { text: result.text.trim(), usage: result.usage };
}

/**
 * Schema-constrained generation.
 *
 * `responseSchema` makes Gemini emit JSON matching the shape, and the zod
 * schema validates it again on our side — a model that returns something
 * unexpected produces a clean error rather than a corrupt row.
 */
export async function generateStructured<S extends z.ZodTypeAny>(
  prompt: string,
  schema: S,
  responseSchema: Record<string, unknown>,
  options: GenerateOptions = {},
): Promise<{ data: z.infer<S>; usage: GenerationUsage }> {
  const result = await callGemini(prompt, options, responseSchema);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new GeminiError('Model returned malformed JSON', 502, true);
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    logger.warn(
      { issues: validated.error.issues, raw: result.text.slice(0, 500) },
      'gemini output failed schema validation',
    );
    throw new GeminiError('Model output did not match the expected shape', 502, true);
  }

  return { data: validated.data, usage: result.usage };
}

async function callGemini(
  prompt: string,
  options: GenerateOptions,
  responseSchema: Record<string, unknown> | undefined,
): Promise<{ text: string; usage: GenerationUsage }> {
  if (!configured.gemini) {
    throw new GeminiError('GEMINI_API_KEY is not configured.', 503, false);
  }

  const tier = options.tier ?? 'standard';
  const model = modelFor(tier);
  const retries = options.retries ?? 2;

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? (responseSchema ? 0 : 0.7),
      maxOutputTokens: options.maxOutputTokens ?? 1024,
      ...(responseSchema
        ? { responseMimeType: 'application/json', responseSchema }
        : {}),
    },
    // Classification has to be able to label abuse and spam, which means the
    // model must be allowed to read them without refusing outright.
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };

  if (options.systemInstruction) {
    body.systemInstruction = { parts: [{ text: options.systemInstruction }] };
  }

  let lastError: GeminiError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(Math.min(2 ** attempt * 500, 4_000));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

    try {
      const res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY!,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new GeminiError(
          `Gemini responded ${res.status}: ${text.slice(0, 200)}`,
          res.status,
          retryable,
        );
        if (!retryable) throw lastError;
        continue;
      }

      const json = (await res.json()) as GeminiResponse;

      if (json.promptFeedback?.blockReason) {
        throw new GeminiError(
          `Blocked by safety filters: ${json.promptFeedback.blockReason}`,
          400,
          false,
        );
      }

      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) {
        lastError = new GeminiError('Gemini returned an empty response', 502, true);
        continue;
      }

      return {
        text,
        usage: {
          model,
          promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof GeminiError) {
        if (!err.retryable) throw err;
        lastError = err;
        continue;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new GeminiError('Gemini request timed out', 504, true);
        continue;
      }
      lastError = new GeminiError(
        err instanceof Error ? err.message : 'Gemini request failed',
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new GeminiError('Gemini request failed', 502, true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Schema helpers ──────────────────────────────────────────────────────────

/** Gemini's responseSchema dialect is a subset of OpenAPI, not JSON Schema. */
export const responseSchema = {
  object: (properties: Record<string, unknown>, required: string[]) => ({
    type: 'OBJECT',
    properties,
    required,
  }),
  string: (description?: string) => ({ type: 'STRING', ...(description ? { description } : {}) }),
  enum: (values: readonly string[], description?: string) => ({
    type: 'STRING',
    enum: [...values],
    ...(description ? { description } : {}),
  }),
  boolean: (description?: string) => ({ type: 'BOOLEAN', ...(description ? { description } : {}) }),
  number: (description?: string) => ({ type: 'NUMBER', ...(description ? { description } : {}) }),
  array: (items: unknown, description?: string) => ({
    type: 'ARRAY',
    items,
    ...(description ? { description } : {}),
  }),
};
