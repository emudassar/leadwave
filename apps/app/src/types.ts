/**
 * The API's response shapes.
 *
 * Written against the live endpoints rather than inferred from Prisma, because
 * what a route selects and what a table holds are not the same thing — and the
 * route is what the screen actually receives.
 */
import type { Feature, Plan, PlanLimits } from '@leadwave/shared';

export type { Feature, Plan, PlanLimits };

// ─── Workspace ───────────────────────────────────────────────────────────────

export type AccountStatus = 'active' | 'needs_reconnect' | 'disabled';
export type WorkspaceRole = 'admin' | 'manager' | 'viewer';

export interface ConnectedAccount {
  id: string;
  pageId: string;
  pageName: string;
  pageUsername: string | null;
  pagePictureUrl: string | null;
  pageUrl: string | null;
  status: AccountStatus;
  statusDetail: string | null;
  color: string;
  webhookSubscribedAt: string | null;
  createdAt: string;
}

export interface Credits {
  included: number;
  bonus: number;
  used: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
  hasAi: boolean;
}

export interface Me {
  workspace: {
    id: string;
    name: string;
    timezone: string;
    plan: Plan;
    persona: string | null;
    onboardedAt: string | null;
    role: WorkspaceRole;
  };
  connectedAccounts: ConnectedAccount[];
  plan: {
    id: Plan;
    name: string;
    features: Feature[];
    limits: PlanLimits;
    hasAi: boolean;
  };
  usage: {
    messagesSent: number;
    leadsCaptured: number;
    contacts: number;
    connectedPages: number;
    seats: number;
    periodStart: string;
    periodEnd: string;
  };
  credits: Credits;
  subscription: {
    status: string;
    interval: string;
    currency: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    provider: string;
  } | null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface AuthMe {
  user: SessionUser;
  workspace: {
    id: string;
    name: string;
    plan: Plan;
    timezone: string;
    role: WorkspaceRole;
    onboardedAt: string | null;
  } | null;
}

// ─── Founder analytics (admin only) ─────────────────────────────────────────

export interface AdminAnalytics {
  overview: {
    totalUsers: number;
    totalWorkspaces: number;
    newUsers7d: number;
    newUsers30d: number;
    mrrUsd: number;
    arrUsd: number;
    activeSubscriptions: number;
    trialingSubscriptions: number;
  };
  planBreakdown: Array<{ plan: Plan; workspaces: number; mrrUsd: number }>;
  signups: Array<{ date: string; users: number; workspaces: number }>;
  mrrHistory: Array<{ date: string; mrrUsd: number; totalUsers: number }>;
  recentSignups: Array<{
    id: string;
    name: string | null;
    email: string;
    createdAt: string;
    plan: Plan;
  }>;
}

export interface HomeSummary {
  stats: {
    triggersThisWeek: number;
    clicksThisWeek: number;
    leadsThisWeek: number;
    unreadConversations: number;
    livePages: number;
    liveAutomations: number;
  };
  setup: {
    steps: Array<{ id: string; label: string; done: boolean }>;
    score: number;
  };
}

// ─── Automations ─────────────────────────────────────────────────────────────

export type TriggerType =
  | 'comment'
  | 'story_reply'
  | 'story_reaction'
  | 'story_mention'
  | 'dm_keyword'
  | 'ice_breaker'
  | 'welcome';

export type AutomationStatus = 'draft' | 'live' | 'paused';

export interface AutomationListItem {
  id: string;
  name: string;
  triggerType: TriggerType;
  status: AutomationStatus;
  keywords: string[];
  runCount: number;
  clicks: number;
  uniqueClicks: number;
  lastTriggeredAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface AutomationDetail {
  id: string;
  connectedAccountId: string;
  name: string;
  status: AutomationStatus;
  triggerType: TriggerType;
  definition: import('@leadwave/shared').AutomationDefinition;
  publishedAt: string | null;
  updatedAt: string;
}

export interface AutomationInsights {
  since: string;
  retentionDays: number | null;
  triggered: number;
  completed: number;
  messagesSent: number;
  clicks: number;
  uniqueClicks: number;
  ctr: number;
  leads: number;
  gateUnlocks: number;
  gateUnlockKind: string;
  followUps: Record<string, number>;
}

export interface ClickIntel {
  totalClicks: number;
  links: Array<{
    id: string;
    slug: string;
    targetUrl: string;
    stepId: string | null;
    cardId: string | null;
    buttonIndex: number | null;
    clicks: number;
    uniqueClicks: number;
    shareOfClicks: number;
  }>;
  devices: Record<string, number>;
}

// ─── Inbox ───────────────────────────────────────────────────────────────────

export interface LabelChip {
  id: string;
  name: string;
  color: string;
}

export interface ConversationListItem {
  id: string;
  contact: { id: string; name: string; avatarUrl: string | null };
  page: { id: string; pageName: string; color: string };
  lastMessageAt: string;
  preview: string | null;
  unreadCount: number;
  isPinned: boolean;
  isArchived: boolean;
  hasAiActivity: boolean;
  aiMuted: boolean;
  windowOpen: boolean;
  labels: LabelChip[];
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus =
  | 'pending'
  | 'scheduled'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'held'
  | 'canceled';
export type MessageSource =
  | 'contact'
  | 'automation'
  | 'ai'
  | 'human'
  | 'follow_up'
  | 'scheduled'
  | 'retrigger';

/** What actually went to Messenger, so the inbox can render what they saw. */
export interface MessagePayload {
  type?: 'button_template' | 'generic_template' | 'quick_replies' | 'attachment';
  buttons?: Array<{ type: string; title: string; url?: string; payload?: string }>;
  quickReplies?: Array<{ title: string; payload?: string }>;
  cards?: Array<{
    title: string;
    subtitle?: string;
    imageUrl?: string | null;
    buttons?: Array<{ type: string; title: string; url?: string }>;
  }>;
  imageUrl?: string | null;
}

export interface InboxMessage {
  id: string;
  direction: MessageDirection;
  status: MessageStatus;
  source: MessageSource;
  text: string | null;
  payload: MessagePayload | null;
  isAiGenerated: boolean;
  automation: { id: string; name: string } | null;
  sender: { id: string; name: string | null; avatarUrl: string | null } | null;
  scheduledFor: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface ConversationContext {
  id: string;
  contact: {
    id: string;
    name: string;
    avatarUrl: string | null;
    locale: string | null;
    firstSeenAt: string;
    optedOut: boolean;
    followConfirmed: boolean;
  };
  page: { id: string; name: string; color: string };
  window: {
    open: boolean;
    expiresAt: string | null;
    humanAgentAvailable: boolean;
    canSend: boolean;
  };
  ai: { muted: boolean; hasActivity: boolean };
  leads: Array<{ id: string; type: 'email' | 'phone'; value: string; capturedAt: string }>;
  noteCount: number;
  recentAutomations: Array<{ id: string; name: string; status: string; startedAt: string }>;
}

export interface SavedReply {
  id: string;
  connectedAccountId: string;
  title: string;
  body: string;
  shortcut: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export interface ContactListItem {
  id: string;
  name: string;
  avatarUrl: string | null;
  page: { id: string; pageName: string; color: string };
  conversationId: string | null;
  leads: Array<{ type: 'email' | 'phone'; value: string }>;
  followConfirmed: boolean;
  optedOut: boolean;
  windowOpen: boolean;
  firstSeenAt: string;
  lastInboundAt: string | null;
}

export interface ContactStats {
  contacts: number;
  newThisWeek: number;
  emailLeads: number;
  phoneLeads: number;
  followsConfirmed: number;
  optedOut: number;
}

export interface ContactNote {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string | null; avatarUrl: string | null } | null;
}

// ─── LeadWave AI ─────────────────────────────────────────────────────────────

export interface AiLimits {
  maxReplyChars: number;
  maxCommentReplyChars: number;
  commentDelayMinMinutes: number;
  commentDelayMaxMinutes: number;
  humanTakeoverHours: number;
  messagingWindowHours: number;
  defaultCommentScopeDays: number;
  maxCommentRepliesPerCommenterPerPost: number;
  followGoalWindowDays: number;
  maxKnowledgeSources: number;
  maxKnowledgeCharsPerAccount: number;
  maxKnowledgeCharsPerSource: number;
  interviewMinQuestions: number;
  interviewMaxQuestions: number;
  maxLiveGoals: number;
  maxGoalsPerReply: number;
  threadContextTurns: number;
}

export interface AiSettingsResponse {
  settings: {
    repliesEnabled: boolean;
    commentsEnabled: boolean;
    globallyPaused: boolean;
    role: string | null;
    brandVoice: string | null;
    guardrails: string[];
    languageMode: 'match_sender' | 'fixed';
    fixedLanguage: string | null;
    commentScope: 'recent_posts' | 'selected_posts';
    scopedPostIds: string[];
  };
  systemGuardrails: string[];
  limits: AiLimits;
  modelAvailable: boolean;
}

export interface AiUsage {
  credits: Credits;
  last7Days: { messageReplies: number; commentReplies: number };
  last30Days: { messageReplies: number; commentReplies: number };
  skipBreakdown: Array<{ reason: string; count: number }>;
  skipTotal: number;
  goals: Array<{
    id: string;
    type: string;
    status: string;
    attempted: number;
    successful: number;
  }>;
}

export interface AiBehavior {
  role: string | null;
  brandVoice: string | null;
  guardrails: string[];
  systemGuardrails: string[];
  languageMode: 'match_sender' | 'fixed';
  fixedLanguage: string | null;
}

export interface KnowledgeSource {
  id: string;
  connectedAccountId: string;
  type: 'link' | 'text' | 'interview';
  title: string;
  content: string;
  charCount: number;
  sourceUrl: string | null;
  lastScannedAt: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeResponse {
  sources: KnowledgeSource[];
  usage: { sources: number; maxSources: number; characters: number; maxCharacters: number };
  creditCost: number;
}

export type GoalType = 'share_link' | 'capture_lead' | 'grow_followers';

export interface AiGoal {
  id: string;
  type: GoalType;
  status: 'live' | 'paused';
  config: Record<string, unknown>;
  attempted: number;
  successful: number;
  successCriteria: string;
  createdAt: string;
}

export interface AiActivityEvent {
  id: string;
  kind: 'message_reply' | 'comment_reply' | 'comment_funnel' | 'message_skip' | 'comment_skip';
  label: string | null;
  skipReason: string | null;
  triggerText: string | null;
  replyText: string | null;
  goal: { id: string; type: string } | null;
  goalSucceeded: boolean;
  creditsCharged: number;
  conversationId: string | null;
  contact: { id: string; name: string; avatarUrl: string | null } | null;
  postId: string | null;
  commentId: string | null;
  canDeleteComment: boolean;
  createdAt: string;
}

// ─── Link-in-bio ─────────────────────────────────────────────────────────────

export type BioBlockType =
  | 'link'
  | 'header'
  | 'text'
  | 'image'
  | 'video'
  | 'socials'
  | 'email_capture';

export interface BioBlock {
  id: string;
  type: BioBlockType;
  position: number;
  isVisible: boolean;
  title: string | null;
  subtitle: string | null;
  url: string | null;
  imageUrl: string | null;
  config: Record<string, unknown>;
  visibleFrom: string | null;
  visibleUntil: string | null;
  clicks: number;
  uniqueClicks: number;
}

export interface BioPageSummaryItem {
  id: string;
  handle: string;
  displayName: string;
  isPublished: boolean;
  theme: string;
  blockCount: number;
  views: number;
  url: string;
  updatedAt: string;
}

export interface BioPageDetail {
  page: {
    id: string;
    handle: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    theme: string;
    themeConfig: Record<string, unknown>;
    isPublished: boolean;
    showBranding: boolean;
    seoTitle: string | null;
    seoDescription: string | null;
    seoImageUrl: string | null;
    seoNoIndex: boolean;
    url: string;
  };
  blocks: BioBlock[];
}

export interface BioAnalytics {
  views: number;
  recentViews: number;
  totalClicks: number;
  ctr: number;
  leads: number;
  devices: Record<string, number>;
  links: Array<{
    id: string;
    title: string;
    url: string;
    clicks: number;
    uniqueClicks: number;
    shareOfClicks: number;
    shortUrl: string | null;
  }>;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface MembersResponse {
  members: Array<{
    id: string;
    role: WorkspaceRole;
    joinedAt: string;
    user: { id: string; email: string; name: string | null; avatarUrl: string | null };
    isYou: boolean;
  }>;
  invites: Array<{ id: string; email: string; role: WorkspaceRole; expiresAt: string }>;
  seatLimit: number;
}

export interface BillingPlansResponse {
  provider: string;
  configured: boolean;
  clientToken: string;
  environment: string;
  plans: Array<{
    id: Plan;
    name: string;
    tagline: string;
    priceMonthlyUsd: number;
    priceYearlyUsd: number;
    features: Feature[];
    limits: PlanLimits;
  }>;
}

export interface IntegrationsResponse {
  integrations: Array<{
    id: string;
    type: string;
    isEnabled: boolean;
    config: Record<string, unknown>;
    connectedAccountId: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }>;
  available: Record<string, { configured: boolean; requiresPlan: Plan }>;
}

export interface MetaConfig {
  configured: boolean;
  appId: string;
  configId: string;
  permissions: string[];
  webhookUrl: string;
}

export interface Paged<T> {
  nextCursor: string | null;
  items: T[];
}
