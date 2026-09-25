import { prisma, type Prisma } from '@leadwave/db';
import {
  AI_LIMITS,
  CREDIT_COST,
  hasFeature,
  isReplyableComment,
  isReplyableMessage,
  type Plan,
  type SkipReason,
} from '@leadwave/shared';
import { tryDecrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { classifyComment, classifyMessage } from '../../services/ai/classify.js';
import { generateCommentReply, generateReply } from '../../services/ai/generate.js';
import {
  buildBrandContext,
  businessSummary,
  recentTurns,
  selectGoal,
  withGoalLink,
} from '../../services/ai/context.js';
import { chargeCredits, hasCreditsRemaining } from '../../services/ai/credits.js';
import { replyToComment } from '../../services/graph.js';
import { checkCommentReplyBudget } from '../../services/rate-limit.js';
import { deliver, deliverPrivateReply } from '../../services/send.js';
import { enqueueGoalEvaluation, type AiCommentJob, type AiPipelineJob } from '../index.js';

/**
 * LeadWave AI.
 *
 * Every precondition is re-checked here rather than trusted from whoever queued
 * the job — being queued is not permission to reply. The ordering below is the
 * product promise made executable: mechanical checks first (all free), then the
 * intent gate (also free), and only then is anything generated or sent.
 *
 * Skips are logged in full and cost nothing. That is what lets the Overview
 * page show "the credits you did not spend" honestly.
 */

// ─── Inbound messages ────────────────────────────────────────────────────────

export async function processAiMessage(job: AiPipelineJob): Promise<void> {
  const account = await prisma.connectedAccount.findUnique({
    where: { id: job.connectedAccountId },
    include: { workspace: true },
  });
  if (!account) return;

  const plan = account.workspace.plan as Plan;
  const log = (skipReason: SkipReason, extra?: Record<string, unknown>) =>
    recordSkip({
      connectedAccountId: account.id,
      contactId: job.contactId,
      conversationId: job.conversationId,
      kind: 'message_skip',
      skipReason,
      ...extra,
    });

  if (!hasFeature(plan, 'ai_replies')) return;

  const settings = await prisma.aiSettings.findUnique({
    where: { connectedAccountId: account.id },
  });
  if (!settings?.repliesEnabled) return;
  if (settings.globallyPaused) return void (await log('globally_paused'));

  const message = await prisma.message.findUnique({
    where: { id: job.messageId },
    include: {
      conversation: { include: { contact: true } },
    },
  });
  if (!message || message.direction !== 'inbound') return;

  const { conversation } = message;
  const { contact } = conversation;

  // ── Mechanical checks. All free. ──
  if (!message.text?.trim()) return void (await log('not_text'));
  if (conversation.aiMutedAt) return void (await log('thread_muted'));
  if (contact.optedOutAt || contact.isBlocked) return void (await log('outbound'));

  // A human replying takes the thread over for 48 hours. No configuration, and
  // replying again resets the clock.
  if (contact.lastHumanReplyAt) {
    const silenceUntil = new Date(
      contact.lastHumanReplyAt.getTime() + AI_LIMITS.humanTakeoverHours * 60 * 60 * 1000,
    );
    if (new Date() < silenceUntil) return void (await log('human_replied_recently'));
  }

  // A keyword automation that matched this message already handled it.
  const handledByAutomation = await prisma.automationRun.findFirst({
    where: {
      contactId: contact.id,
      startedAt: { gte: new Date(message.createdAt.getTime() - 5_000) },
    },
    select: { id: true },
  });
  if (handledByAutomation) return void (await log('keyword_automation_handled'));

  if (!(await hasCreditsRemaining(account.workspaceId, plan))) {
    return void (await log('no_credits'));
  }

  const brand = await buildBrandContext(account);
  if (!brand || !brand.knowledge.trim()) return void (await log('no_knowledge'));

  const turns = await recentTurns(conversation.id);

  // ── The intent gate. Still free. ──
  let classification;
  try {
    const result = await classifyMessage({
      text: message.text,
      recentTurns: turns,
      businessContext: businessSummary(brand),
    });
    classification = result.classification;
  } catch (err) {
    logger.warn({ err, messageId: message.id }, 'ai classification failed');
    return;
  }

  if (!isReplyableMessage(classification.label)) {
    await recordSkip({
      connectedAccountId: account.id,
      contactId: contact.id,
      conversationId: conversation.id,
      kind: 'message_skip',
      skipReason: 'not_replyable_label',
      label: classification.label,
      triggerText: message.text,
    });
    return;
  }

  // ── Generation. Still nothing charged. ──
  const selected = await selectGoal(account.id, classification.label);
  const brandWithGoal = withGoalLink(brand, selected?.directive ?? null);

  let generated;
  try {
    generated = await generateReply({
      brand: brandWithGoal,
      label: classification.label,
      language: classification.language,
      message: message.text,
      recentTurns: turns,
      goal: selected?.directive ?? null,
      contactFirstName: contact.firstName,
    });
  } catch (err) {
    logger.warn({ err, messageId: message.id }, 'ai generation failed');
    return;
  }

  if (!generated.reply) {
    await recordSkip({
      connectedAccountId: account.id,
      contactId: contact.id,
      conversationId: conversation.id,
      kind: 'message_skip',
      skipReason: 'model_declined',
      label: classification.label,
      triggerText: message.text,
      note: generated.declineReason,
    });
    return;
  }

  // ── The receipt is written before the send, so the reply and its log entry
  //    can never diverge. Credits are charged only once it lands. ──
  const event = await prisma.aiEvent.create({
    data: {
      connectedAccountId: account.id,
      contactId: contact.id,
      conversationId: conversation.id,
      kind: 'message_reply',
      label: classification.label,
      triggerText: message.text.slice(0, 1000),
      replyText: generated.reply,
      goalId: selected?.goal.id ?? null,
      creditsCharged: 0,
      modelMeta: generated.usage as unknown as Prisma.InputJsonValue,
    },
  });

  const outcome = await deliver({
    account,
    contact,
    conversationId: conversation.id,
    message: { text: generated.reply },
    text: generated.reply,
    source: 'ai',
    plan,
    workspaceId: account.workspaceId,
    isAiGenerated: true,
    aiEventId: event.id,
    idempotencyKey: `ai:${message.id}`,
    showTyping: true,
  });

  if (outcome.status !== 'sent' && outcome.status !== 'duplicate') {
    // Nothing reached the person, so nothing is charged.
    await prisma.aiEvent.update({
      where: { id: event.id },
      data: { kind: 'message_skip', skipReason: 'send_failed' },
    });
    return;
  }

  await chargeCredits({
    workspaceId: account.workspaceId,
    amount: CREDIT_COST.messageReply,
    reason: 'message_reply',
    aiEventId: event.id,
  });
  await prisma.aiEvent.update({
    where: { id: event.id },
    data: { creditsCharged: CREDIT_COST.messageReply },
  });

  if (selected) {
    await prisma.aiGoal.update({
      where: { id: selected.goal.id },
      data: { attemptedCount: { increment: 1 } },
    });
    // Success is measured later, from our own instrumentation — a click, a
    // captured field, a confirmed follow — never self-reported by the model.
    await enqueueGoalEvaluation(event.id, 60 * 60 * 1000);
    if (selected.goal.type === 'grow_followers') {
      await enqueueGoalEvaluation(event.id, AI_LIMITS.followGoalWindowDays * 24 * 60 * 60 * 1000);
    }
  }
}

// ─── Public comment replies ──────────────────────────────────────────────────

export async function processAiComment(job: AiCommentJob): Promise<void> {
  const account = await prisma.connectedAccount.findUnique({
    where: { id: job.connectedAccountId },
    include: { workspace: true },
  });
  if (!account) return;

  const plan = account.workspace.plan as Plan;
  if (!hasFeature(plan, 'ai_comments')) return;

  const log = (skipReason: SkipReason, extra?: Record<string, unknown>) =>
    recordSkip({
      connectedAccountId: account.id,
      kind: 'comment_skip',
      skipReason,
      postId: job.postId,
      commentId: job.commentId,
      triggerText: job.commentText,
      ...extra,
    });

  const settings = await prisma.aiSettings.findUnique({
    where: { connectedAccountId: account.id },
  });
  if (!settings?.commentsEnabled) return;
  if (settings.globallyPaused) return void (await log('globally_paused'));

  // A keyword automation may have claimed this comment during the 2–20 minute
  // delay. If so, the AI stays out.
  const handled = await prisma.commentReply.findFirst({
    where: { commentId: job.commentId },
    select: { id: true, kind: true },
  });
  if (handled) return void (await log('keyword_automation_handled'));

  // One AI reply per commenter per post, ever.
  if (job.commenterId) {
    const already = await prisma.commentReply.findFirst({
      where: { postId: job.postId, commenterId: job.commenterId, kind: 'ai_public_reply' },
      select: { id: true },
    });
    if (already) return void (await log('already_replied_to_commenter'));
  }

  if (!(await hasCreditsRemaining(account.workspaceId, plan))) {
    return void (await log('no_credits'));
  }

  const budget = await checkCommentReplyBudget(account.pageId);
  if (!budget.allowed) return void (await log('hourly_budget_exhausted'));

  const brand = await buildBrandContext(account);
  if (!brand || !brand.knowledge.trim()) return void (await log('no_knowledge'));

  let classification;
  try {
    const result = await classifyComment({
      text: job.commentText,
      businessContext: businessSummary(brand),
    });
    classification = result.classification;
  } catch (err) {
    logger.warn({ err, commentId: job.commentId }, 'ai comment classification failed');
    return;
  }

  // Negative and spam are never replied to — the AI cannot be baited into an
  // argument under a post.
  if (!isReplyableComment(classification.label)) {
    await log('not_replyable_label', { label: classification.label });
    return;
  }

  const token = tryDecrypt(account.accessTokenCipher);
  if (!token) return;

  // Buying intent becomes a public breadcrumb plus a private message carrying
  // the link. One funnel, one credit.
  const shareGoal = classification.hasBuyIntent
    ? await selectGoal(account.id, 'buy_intent')
    : null;
  const pairedPrivate = Boolean(shareGoal?.directive.link);

  let generated;
  try {
    generated = await generateCommentReply({
      brand,
      comment: job.commentText,
      language: classification.language,
      pairedWithPrivateReply: pairedPrivate,
    });
  } catch (err) {
    logger.warn({ err, commentId: job.commentId }, 'ai comment generation failed');
    return;
  }

  if (!generated.reply) return void (await log('model_declined', { label: classification.label }));

  let externalReplyId: string | null = null;
  try {
    const posted = await replyToComment(job.commentId, token, generated.reply);
    externalReplyId = posted.id;
  } catch (err) {
    logger.warn({ err, commentId: job.commentId }, 'ai public reply failed to post');
    await log('send_failed', { label: classification.label });
    return;
  }

  await prisma.commentReply.create({
    data: {
      connectedAccountId: account.id,
      commentId: job.commentId,
      postId: job.postId,
      commenterId: job.commenterId,
      kind: 'ai_public_reply',
      externalReplyId,
      commentText: job.commentText.slice(0, 1000),
      replyText: generated.reply,
    },
  });

  const event = await prisma.aiEvent.create({
    data: {
      connectedAccountId: account.id,
      kind: pairedPrivate ? 'comment_funnel' : 'comment_reply',
      label: classification.label,
      triggerText: job.commentText.slice(0, 1000),
      replyText: generated.reply,
      postId: job.postId,
      commentId: job.commentId,
      externalReplyId,
      goalId: shareGoal?.goal.id ?? null,
      creditsCharged: CREDIT_COST.commentReply,
      modelMeta: generated.usage as unknown as Prisma.InputJsonValue,
    },
  });

  // The private message with the actual link, sent through the same private
  // reply path a comment automation would use.
  if (pairedPrivate && shareGoal?.directive.link) {
    await deliverPrivateReply({
      account,
      commentId: job.commentId,
      message: { text: `Here's the link you asked for: ${shareGoal.directive.link}` },
      plan,
      workspaceId: account.workspaceId,
    }).catch((err: unknown) => {
      logger.warn({ err, commentId: job.commentId }, 'paired private reply failed');
    });

    await prisma.aiGoal.update({
      where: { id: shareGoal.goal.id },
      data: { attemptedCount: { increment: 1 } },
    });
    await enqueueGoalEvaluation(event.id, 60 * 60 * 1000);
  }

  await chargeCredits({
    workspaceId: account.workspaceId,
    amount: CREDIT_COST.commentReply,
    reason: pairedPrivate ? 'comment_funnel' : 'comment_reply',
    aiEventId: event.id,
  });
}

// ─── Receipts ────────────────────────────────────────────────────────────────

async function recordSkip(input: {
  connectedAccountId: string;
  contactId?: string | null;
  conversationId?: string | null;
  kind: 'message_skip' | 'comment_skip';
  skipReason: SkipReason;
  label?: string;
  triggerText?: string;
  postId?: string;
  commentId?: string;
  note?: string | null;
}): Promise<void> {
  await prisma.aiEvent.create({
    data: {
      connectedAccountId: input.connectedAccountId,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      kind: input.kind,
      label: input.label ?? null,
      skipReason: input.skipReason,
      triggerText: input.triggerText?.slice(0, 1000) ?? null,
      replyText: input.note ?? null,
      postId: input.postId ?? null,
      commentId: input.commentId ?? null,
      // Always zero. Classification is free; only sends are metered.
      creditsCharged: 0,
    },
  });
}
