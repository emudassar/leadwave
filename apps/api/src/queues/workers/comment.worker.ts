import { prisma, type ConnectedAccount, type Prisma } from '@leadwave/db';
import {
  PRIVATE_REPLY_WINDOW_DAYS,
  pickVariant,
  type AutomationDefinition,
  type Plan,
} from '@leadwave/shared';
import { tryDecrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { matchCommentTrigger, startRun } from '../../services/dispatcher.js';
import { replyToComment } from '../../services/graph.js';
import {
  buildCarouselMessage,
  buildTextMessage,
  renderText,
} from '../../services/message-builder.js';
import { deliverPrivateReply } from '../../services/send.js';
import { upsertContact } from '../../services/inbound.js';
import { linkResolver, loadAutomationLinks } from '../../services/shortlinks.js';
import { checkCommentReplyBudget, withLock } from '../../services/rate-limit.js';
import { hasFeature } from '@leadwave/shared';
import { enqueueAiComment, type CommentJob } from '../index.js';
import { AI_LIMITS, randomInt } from '@leadwave/shared';

/**
 * Comment → DM.
 *
 * Facebook's private-reply endpoint is the primitive here: it opens a Messenger
 * thread from a public comment. Meta allows exactly one private reply per
 * comment, ever, and only while the comment is under 7 days old — which is why
 * the dedupe ledger and the Retrigger window look the way they do.
 *
 * Because the private reply *is* the first message, this worker sends step 0
 * itself and hands the rest of the run to the executor.
 */

export async function processComment(job: CommentJob): Promise<void> {
  const account = await prisma.connectedAccount.findUnique({
    where: { id: job.connectedAccountId },
    include: { workspace: true },
  });
  if (!account || account.status === 'disabled') return;

  // The ledger is the source of truth for "have we already handled this?".
  // A lock on top of it stops two workers racing on a redelivered webhook.
  const handled = await withLock(`comment:${job.commentId}`, 60, async () => {
    const existing = await prisma.commentReply.findFirst({
      where: { commentId: job.commentId },
      select: { id: true },
    });
    if (existing) return 'duplicate' as const;

    return runCommentAutomation(account, job);
  });

  if (handled === null) {
    logger.debug({ commentId: job.commentId }, 'comment already being processed elsewhere');
  }
}

type CommentOutcome = 'duplicate' | 'handled' | 'no_match' | 'too_old' | 'blocked';

async function runCommentAutomation(
  account: ConnectedAccount & { workspace: { plan: string } },
  job: CommentJob,
): Promise<CommentOutcome> {
  const plan = account.workspace.plan as Plan;

  // Meta refuses a private reply to a comment older than 7 days. Checking here
  // saves a guaranteed-to-fail API call and gives Retrigger an honest count.
  if (job.commentCreatedAt) {
    const age = Date.now() - new Date(job.commentCreatedAt).getTime();
    if (age > PRIVATE_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return 'too_old';
    }
  }

  const match = await matchCommentTrigger(account.id, job.postId, job.commentText);

  if (!match) {
    // No keyword automation wanted it, so LeadWave AI may consider a public
    // reply. The AI worker re-checks every precondition of its own.
    await maybeQueueAiComment(account, job);
    return 'no_match';
  }

  const definition = match.definition;
  const firstStep = definition.steps[0];
  if (!firstStep || (firstStep.type !== 'send_message' && firstStep.type !== 'product_carousel')) {
    logger.warn({ automationId: match.automation.id }, 'automation does not start with a message');
    return 'blocked';
  }

  const links = await loadAutomationLinks(match.automation.id);
  const build = {
    firstName: null,
    lastName: null,
    pageName: account.pageName,
    resolveUrl: linkResolver(links),
  };

  const message =
    firstStep.type === 'send_message'
      ? buildTextMessage(
          {
            stepId: firstStep.id,
            text: firstStep.text,
            buttons: firstStep.buttons,
            quickReplies: firstStep.quickReplies,
          },
          build,
        )
      : buildCarouselMessage(firstStep.id, firstStep.cards, build);

  const outcome = await deliverPrivateReply({
    account,
    commentId: job.commentId,
    message,
    plan,
    workspaceId: account.workspaceId,
  });

  if (outcome.status === 'failed') {
    if (outcome.retryable) throw new Error(outcome.message);
    logger.info(
      { commentId: job.commentId, reason: outcome.reason },
      'private reply not sent',
    );
    return 'blocked';
  }

  // Record the reply before anything else can fail. An extra ledger row is
  // harmless; a missing one would let the same person be messaged twice.
  await prisma.commentReply.create({
    data: {
      connectedAccountId: account.id,
      commentId: job.commentId,
      postId: job.postId,
      commenterId: job.commenterId,
      kind: 'private_reply',
      automationId: match.automation.id,
      commentText: job.commentText.slice(0, 1000),
      commentCreatedAt: job.commentCreatedAt ? new Date(job.commentCreatedAt) : null,
    },
  });

  if (outcome.status === 'duplicate') return 'duplicate';

  // The private reply gives us the Messenger PSID, which is the id everything
  // downstream is keyed on.
  const psid = outcome.psid;
  if (!psid) {
    logger.warn({ commentId: job.commentId }, 'private reply returned no recipient id');
    return 'handled';
  }

  const { contact, conversation } = await upsertContact(account, psid);

  // A private reply opens the standard 24-hour messaging window, so the rest of
  // the automation is free to send.
  const now = new Date();
  await prisma.$transaction([
    prisma.contact.update({
      where: { id: contact.id },
      data: { lastInboundAt: now, lastOutboundAt: now },
    }),
    prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'outbound',
        status: 'sent',
        source: job.retriggerRunId ? 'retrigger' : 'automation',
        text: firstStep.type === 'send_message' ? renderText(firstStep.text, build) : null,
        payload: message as Prisma.InputJsonValue,
        automationId: match.automation.id,
        idempotencyKey: `private-reply:${job.commentId}`,
        sentAt: now,
      },
    }),
    prisma.commentReply.updateMany({
      where: { commentId: job.commentId, kind: 'private_reply' },
      data: { contactId: contact.id },
    }),
  ]);

  await publicReply(account, job, definition, match.automation.id, build.pageName);

  // Step 0 has already gone out, so the run picks up from step 1.
  if (definition.steps.length > 1) {
    const runId = await startRun({
      match,
      account,
      contact: { ...contact, lastInboundAt: now },
      conversation,
      sourceType: job.retriggerRunId ? 'retrigger' : 'comment',
      sourcePostId: job.postId,
      sourceCommentId: job.commentId,
      isBackfill: Boolean(job.retriggerRunId),
    });

    if (runId) {
      await prisma.automationRun.update({ where: { id: runId }, data: { stepIndex: 1 } });
    }
  }

  return 'handled';
}

/**
 * The public reply under the comment. It is social proof that compounds —
 * every visible reply shows the next reader that the keyword works — so the
 * variants are rotated to keep 400 of them from reading like one bot.
 */
async function publicReply(
  account: ConnectedAccount,
  job: CommentJob,
  definition: AutomationDefinition,
  automationId: string,
  pageName: string,
): Promise<void> {
  if (definition.trigger.type !== 'comment') return;
  const config = definition.trigger.publicReply;
  if (!config.enabled || config.variants.length === 0) return;

  const budget = await checkCommentReplyBudget(account.pageId);
  if (!budget.allowed) return;

  const token = tryDecrypt(account.accessTokenCipher);
  if (!token) return;

  const variant = pickVariant(config.variants);
  if (!variant) return;

  const text = renderText(variant, { pageName });

  try {
    const result = await replyToComment(job.commentId, token, text);
    await prisma.commentReply.create({
      data: {
        connectedAccountId: account.id,
        commentId: job.commentId,
        postId: job.postId,
        commenterId: job.commenterId,
        kind: 'public_reply',
        automationId,
        externalReplyId: result.id,
        replyText: text,
      },
    });
  } catch (err) {
    // A failed public reply must never lose the DM that already went out.
    logger.warn({ err, commentId: job.commentId }, 'public comment reply failed');
  }
}

/**
 * Hands the comment to LeadWave AI, but only when it is genuinely in scope.
 * Queueing is not permission — the AI worker re-checks everything — but there
 * is no point queueing work that is certain to be skipped.
 */
async function maybeQueueAiComment(
  account: ConnectedAccount & { workspace: { plan: string } },
  job: CommentJob,
): Promise<void> {
  const plan = account.workspace.plan as Plan;
  if (!hasFeature(plan, 'ai_comments')) return;

  // Backfilled comments are historical; the AI only speaks to live traffic.
  if (job.retriggerRunId) return;

  const settings = await prisma.aiSettings.findUnique({
    where: { connectedAccountId: account.id },
  });
  if (!settings?.commentsEnabled || settings.globallyPaused) return;

  if (settings.commentScope === 'selected_posts' && !settings.scopedPostIds.includes(job.postId)) {
    return;
  }

  if (settings.commentScope === 'recent_posts' && job.commentCreatedAt) {
    const age = Date.now() - new Date(job.commentCreatedAt).getTime();
    if (age > AI_LIMITS.defaultCommentScopeDays * 24 * 60 * 60 * 1000) return;
  }

  // One reply per commenter per post, ever.
  if (job.commenterId) {
    const already = await prisma.commentReply.findFirst({
      where: {
        postId: job.postId,
        commenterId: job.commenterId,
        kind: 'ai_public_reply',
      },
      select: { id: true },
    });
    if (already) return;
  }

  // A human-feeling delay, spread across the hour, so a post with 200 comments
  // does not get 200 replies in thirty seconds.
  const delayMs =
    randomInt(AI_LIMITS.commentDelayMinMinutes, AI_LIMITS.commentDelayMaxMinutes) * 60 * 1000;

  await enqueueAiComment(
    {
      connectedAccountId: account.id,
      commentId: job.commentId,
      postId: job.postId,
      commenterId: job.commenterId,
      commentText: job.commentText,
    },
    delayMs,
  );
}
