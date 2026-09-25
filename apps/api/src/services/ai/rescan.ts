import { prisma } from '@leadwave/db';
import { logger } from '../../lib/logger.js';
import { scanUrl } from './knowledge.js';

/**
 * Re-reads a link-backed knowledge source. Nothing is cached in a way that
 * keeps quoting an old price — a re-scan replaces the content outright.
 */
export async function rescanKnowledgeSource(sourceId: string): Promise<void> {
  const source = await prisma.aiKnowledgeSource.findUnique({ where: { id: sourceId } });
  if (!source || source.type !== 'link' || !source.sourceUrl) return;

  try {
    const { content } = await scanUrl(source.sourceUrl);
    await prisma.aiKnowledgeSource.update({
      where: { id: source.id },
      data: { content, charCount: content.length, lastScannedAt: new Date() },
    });
  } catch (err) {
    // A site that moved or went down should not empty the knowledge base; keep
    // the last good copy and let the user see it is stale.
    logger.warn({ err, sourceId }, 'knowledge re-scan failed; keeping the previous content');
  }
}
