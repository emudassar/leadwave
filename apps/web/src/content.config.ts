import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Two collections, because they answer two different questions.
 *
 * `usecases` is "what does it do" — one page per capability.
 * `audiences` is "is it for me" — one page per kind of business, which is the
 * question most people actually arrive with. Creators lead the order because
 * they are the largest group and the one the product was shaped around.
 */

const shared = {
  title: z.string(),
  /** The <title> and the H1 can differ; search intent and reading flow are not the same. */
  heading: z.string(),
  description: z.string(),
  eyebrow: z.string(),
  order: z.number().default(50),
  /** Shown on the card and repeated as the page's key points. */
  highlights: z.array(z.string()).min(2).max(5),
};

const usecases = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/usecases' }),
  schema: z.object({ ...shared, group: z.literal('capability').default('capability') }),
});

const audiences = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/audiences' }),
  schema: z.object({
    ...shared,
    /** `creator` covers creators, sellers and marketers; `local` the rest. */
    group: z.enum(['creator', 'local']),
  }),
});

export const collections = { usecases, audiences };
