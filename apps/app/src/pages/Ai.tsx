/**
 * LeadWave AI.
 *
 * Five tabs, and the first one is the receipts. That ordering is the argument:
 * an AI that answers your customers is only worth having if you can see every
 * decision it made, including the ones where it decided to say nothing. The
 * skip breakdown is given the same weight as the replies, because "it stayed
 * quiet 43 times and charged you nothing for it" is the reassurance people
 * actually need before they switch it on.
 */
import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BookOpen,
  Bot,
  CheckCircle2,
  ExternalLink,
  FileText,
  Globe,
  Link2,
  Loader2,
  MessageCircle,
  MinusCircle,
  Pause,
  Play,
  Plus,
  Save,
  Sparkles,
  Target,
  Trash2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { AI_LIMITS } from '@leadwave/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, compact, full, humanize, percent, timeAgo } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/AppShell';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  Meter,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
} from '@/components/ui';
import type {
  AiActivityEvent,
  AiBehavior,
  AiGoal,
  AiSettingsResponse,
  AiUsage,
  GoalType,
  KnowledgeResponse,
} from '@/types';

const SKIP_COPY: Record<string, string> = {
  not_replyable_label: 'Nothing to answer — a greeting, an emoji or small talk.',
  keyword_automation_handled: 'One of your keyword automations already replied.',
  outside_messaging_window: "Messenger's 24-hour window had closed.",
  human_replied_recently: 'You replied yourself, so the AI stood down.',
  thread_muted: 'The AI is muted in that thread.',
  globally_paused: 'The AI was paused.',
  no_credits: 'Out of credits for this cycle.',
  not_text: 'The message had no text to read.',
  outbound: 'It was your own message.',
  own_comment: 'The comment came from your own Page.',
  already_replied_to_commenter: 'That person already got a reply on that post.',
  out_of_scope_post: 'The post is outside the scope you set.',
  hourly_budget_exhausted: "The Page's shared send budget was spent.",
  no_knowledge: "It did not know the answer, so it said nothing.",
  model_declined: 'The model chose not to answer.',
  send_failed: 'The send itself failed.',
};

const GOAL_COPY: Record<GoalType, { label: string; description: string; criteria: string }> = {
  share_link: {
    label: 'Share a link',
    description: 'When the conversation makes it natural, offer the link.',
    criteria: 'Counted successful only when the tracked link is actually clicked.',
  },
  capture_lead: {
    label: 'Capture a lead',
    description: 'Ask for an email or a number, once, when it fits.',
    criteria: 'Counted successful only when a valid value is saved on the contact.',
  },
  grow_followers: {
    label: 'Ask for a follow',
    description: 'Invite them to follow the Page.',
    criteria: 'Counted only on a self-confirmed tap — Facebook exposes no follow signal.',
  },
};

const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'behavior', label: 'Behaviour', icon: Wand2 },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'activity', label: 'Activity', icon: MessageCircle },
] as const;

export function AiPage(): React.ReactElement {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeAccountId, me } = useSession();

  const active = TABS.some((t) => t.id === tab) ? tab! : 'overview';
  const accountId = activeAccountId;
  const scoped = { connectedAccountId: accountId };

  const settings = useQuery({
    queryKey: ['ai-settings', accountId],
    queryFn: () => api.get<AiSettingsResponse>('/ai/settings', scoped),
    enabled: Boolean(accountId),
  });

  const usage = useQuery({
    queryKey: ['ai-usage', accountId],
    queryFn: () => api.get<AiUsage>('/ai/usage', scoped),
    enabled: Boolean(accountId),
  });

  const patchSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch('/ai/settings', { connectedAccountId: accountId, ...body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-settings', accountId] }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not save that.'),
  });

  if (!me.plan.hasAi) return <AiUpsell />;

  if (!accountId) {
    return (
      <PageBody>
        <EmptyState
          icon={<Bot className="size-5" />}
          title="Connect a Page first"
          description="LeadWave AI answers on behalf of a specific Page, using that Page's own knowledge."
          action={
            <Button variant="primary" onClick={() => navigate('/settings/pages')}>
              Connect a Page
            </Button>
          }
        />
      </PageBody>
    );
  }

  const s = settings.data?.settings;

  return (
    <PageBody>
      <PageHeader
        title="LeadWave AI"
        description="It answers from what you have told it, in your voice, and stays quiet when it does not know. Every decision is on the record below."
        actions={
          s ? (
            <Tooltip content="Stops every AI reply on this Page immediately. Your keyword automations keep running.">
              <span>
                <Button
                  variant={s.globallyPaused ? 'primary' : 'secondary'}
                  onClick={() => patchSettings.mutate({ globallyPaused: !s.globallyPaused })}
                >
                  {s.globallyPaused ? (
                    <>
                      <Play className="size-4" />
                      Resume the AI
                    </>
                  ) : (
                    <>
                      <Pause className="size-4" />
                      Pause everything
                    </>
                  )}
                </Button>
              </span>
            </Tooltip>
          ) : null
        }
      />

      {settings.data && !settings.data.modelAvailable ? (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/6 p-4">
          <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-300">
            The AI model is not configured
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
            Set <code className="font-mono">GEMINI_API_KEY</code> in the API's
            environment. Until then you can write knowledge and set goals, but
            nothing will generate.
          </p>
        </Card>
      ) : null}

      {s?.globallyPaused ? (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/6 px-4 py-3">
          <p className="text-[13px] text-amber-700 dark:text-amber-300">
            The AI is paused on this Page. Nothing is being generated or charged.
          </p>
        </Card>
      ) : null}

      <Tabs
        value={active}
        onValueChange={(value) => navigate(value === 'overview' ? '/ai' : `/ai/${value}`)}
        className="mt-6"
      >
        <TabsList>
          {TABS.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              <span className="flex items-center gap-1.5">
                <item.icon className="size-3.5" />
                {item.label}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="pt-5">
          <OverviewTab usage={usage.data} settings={settings.data} onToggle={patchSettings.mutate} />
        </TabsContent>
        <TabsContent value="knowledge" className="pt-5">
          <KnowledgeTab accountId={accountId} />
        </TabsContent>
        <TabsContent value="behavior" className="pt-5">
          <BehaviorTab accountId={accountId} />
        </TabsContent>
        <TabsContent value="goals" className="pt-5">
          <GoalsTab accountId={accountId} />
        </TabsContent>
        <TabsContent value="activity" className="pt-5">
          <ActivityTab accountId={accountId} />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({
  usage,
  settings,
  onToggle,
}: {
  usage?: AiUsage;
  settings?: AiSettingsResponse;
  onToggle: (body: Record<string, unknown>) => void;
}): React.ReactElement {
  if (!usage || !settings) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-56" />
        ))}
      </div>
    );
  }

  const s = settings.settings;
  const cap = usage.credits.included + usage.credits.bonus;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* Switches */}
      <Card className="p-5">
        <h3 className="text-[15px] font-semibold tracking-tight">What it handles</h3>
        <div className="mt-2 divide-y divide-line">
          <div className="flex items-start justify-between gap-3 py-3">
            <div>
              <p className="text-[13.5px] font-medium">Reply to messages</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-muted">
                Only questions, buying intent and support issues. Greetings and
                small talk are left alone.
              </p>
            </div>
            <Switch
              checked={s.repliesEnabled}
              onCheckedChange={(v) => onToggle({ repliesEnabled: v })}
            />
          </div>
          <div className="flex items-start justify-between gap-3 py-3">
            <div>
              <p className="text-[13.5px] font-medium">Reply to comments</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-muted">
                A short public reply, posted {AI_LIMITS.commentDelayMinMinutes}–
                {AI_LIMITS.commentDelayMaxMinutes} minutes later so it does not
                read like a bot.
              </p>
            </div>
            <Switch
              checked={s.commentsEnabled}
              onCheckedChange={(v) => onToggle({ commentsEnabled: v })}
            />
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-surface-sunken p-3">
          <p className="text-[12px] leading-relaxed text-text-muted">
            Your keyword automations always go first. The AI is only considered
            when nothing else claimed the message — nobody ever gets two replies.
          </p>
        </div>
      </Card>

      {/* Credits */}
      <Card className="p-5">
        <h3 className="text-[15px] font-semibold tracking-tight">Credits</h3>
        <p className="stat-figure mt-3 text-[34px] leading-none">
          {full(usage.credits.remaining)}
        </p>
        <p className="mt-1 text-[12.5px] text-text-muted">
          left of {full(cap)} this cycle
        </p>
        <Meter className="mt-3" value={usage.credits.used} max={cap} />
        <dl className="mt-4 space-y-1.5 text-[12.5px]">
          <div className="flex justify-between">
            <dt className="text-text-muted">Message replies (30d)</dt>
            <dd className="font-mono tabular-nums">{full(usage.last30Days.messageReplies)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Comment replies (30d)</dt>
            <dd className="font-mono tabular-nums">{full(usage.last30Days.commentReplies)}</dd>
          </div>
        </dl>
        <p className="mt-3 border-t border-line pt-3 text-[11.5px] leading-relaxed text-text-subtle">
          One credit is one reply that actually landed. Reading a message,
          classifying it, deciding to stay quiet, a send that failed, and every
          goal evaluation are all free.
        </p>
      </Card>

      {/* Skips — the trust-building number */}
      <Card className="p-5">
        <div className="flex items-center gap-2">
          <MinusCircle className="size-4 text-text-subtle" />
          <h3 className="text-[15px] font-semibold tracking-tight">When it stayed quiet</h3>
        </div>
        <p className="stat-figure mt-3 text-[34px] leading-none">{full(usage.skipTotal)}</p>
        <p className="mt-1 text-[12.5px] text-text-muted">
          decisions not to reply — all free
        </p>

        {usage.skipBreakdown.length === 0 ? (
          <p className="mt-4 text-[12.5px] text-text-subtle">
            Nothing skipped yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {usage.skipBreakdown.slice(0, 6).map((skip) => {
              const share = usage.skipTotal > 0 ? skip.count / usage.skipTotal : 0;
              return (
                <li key={skip.reason}>
                  <div className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 text-text-muted">
                      {SKIP_COPY[skip.reason] ?? humanize(skip.reason)}
                    </span>
                    <span className="font-mono tabular-nums text-text-subtle">{skip.count}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full rounded-full bg-brand-500/60"
                      style={{ width: `${Math.max(share * 100, 2)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Goals summary */}
      {usage.goals.length ? (
        <Card className="lg:col-span-3">
          <CardHeader
            title="Goals"
            description="Counted from our own instrumentation — clicks, saved fields, confirmed taps. Never self-reported by the model."
            action={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/ai/goals">Manage</Link>
              </Button>
            }
          />
          <div className="grid gap-px overflow-hidden border-t border-line bg-line sm:grid-cols-3">
            {usage.goals.map((goal) => {
              const rate = goal.attempted > 0 ? goal.successful / goal.attempted : 0;
              return (
                <div key={goal.id} className="bg-surface-raised p-4">
                  <div className="flex items-center gap-2">
                    <Target className="size-3.5 text-text-subtle" />
                    <p className="text-[13px] font-medium">
                      {GOAL_COPY[goal.type as GoalType]?.label ?? humanize(goal.type)}
                    </p>
                    <Badge tone={goal.status === 'live' ? 'success' : 'neutral'} className="ml-auto">
                      {goal.status}
                    </Badge>
                  </div>
                  <p className="stat-figure mt-2.5 text-[26px] leading-none">
                    {percent(rate)}
                  </p>
                  <p className="mt-1 text-[11.5px] text-text-subtle">
                    {full(goal.successful)} of {full(goal.attempted)} attempts landed
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

const SOURCE_ICON = { link: Globe, text: FileText, interview: MessageCircle };

function KnowledgeTab({ accountId }: { accountId: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<'link' | 'text'>('text');
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [url, setUrl] = React.useState('');

  const knowledge = useQuery({
    queryKey: ['ai-knowledge', accountId],
    queryFn: () => api.get<KnowledgeResponse>('/ai/knowledge', { connectedAccountId: accountId }),
  });

  const scan = useMutation({
    mutationFn: () => api.post<{ title: string; content: string }>('/ai/knowledge/scan', { url }),
    onSuccess: (data) => {
      setTitle(data.title);
      setContent(data.content);
      toast.success('Read the page — check it over before you save.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not read that page.'),
  });

  const save = useMutation({
    mutationFn: () =>
      api.post('/ai/knowledge', {
        connectedAccountId: accountId,
        type,
        title: title.trim(),
        content: content.trim(),
        sourceUrl: type === 'link' ? url : null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-knowledge', accountId] });
      setOpen(false);
      setTitle('');
      setContent('');
      setUrl('');
      toast.success('Saved. The AI can answer from it immediately.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save.'),
  });

  const toggle = useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      api.patch(`/ai/knowledge/${id}`, { connectedAccountId: accountId, isEnabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-knowledge', accountId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/ai/knowledge/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-knowledge', accountId] }),
  });

  const data = knowledge.data;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-text-muted">
            This — and only this — is what the AI is allowed to answer from.
          </p>
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            Add knowledge
          </Button>
        </div>

        {knowledge.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : !data?.sources.length ? (
          <EmptyState
            icon={<BookOpen className="size-5" />}
            title="Nothing to answer from yet"
            description="Paste your shipping page, your price list, your sizing notes. Without this the AI will correctly refuse to answer anything — which is safe, and useless."
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                Add the first one
              </Button>
            }
          />
        ) : (
          data.sources.map((source) => {
            const Icon = SOURCE_ICON[source.type];
            return (
              <Card key={source.id} className={cn('p-4', !source.isEnabled && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-subtle">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[13.5px] font-semibold">{source.title}</p>
                      <Badge tone="neutral">{humanize(source.type)}</Badge>
                    </div>
                    <p className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-text-muted">
                      {source.content}
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-text-subtle">
                      <span>{full(source.charCount)} characters</span>
                      {source.sourceUrl ? (
                        <>
                          <span>·</span>
                          <a
                            href={source.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:text-text"
                          >
                            {new URL(source.sourceUrl).hostname}
                            <ExternalLink className="size-3" />
                          </a>
                        </>
                      ) : null}
                      {source.lastScannedAt ? (
                        <>
                          <span>·</span>
                          <span>scanned {timeAgo(source.lastScannedAt)}</span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      checked={source.isEnabled}
                      onCheckedChange={(isEnabled) => toggle.mutate({ id: source.id, isEnabled })}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove.mutate(source.id)}
                      aria-label="Delete"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>

      <Card className="h-fit p-5">
        <h3 className="text-[15px] font-semibold tracking-tight">Capacity</h3>
        {data ? (
          <>
            <div className="mt-3 space-y-3">
              <div>
                <div className="flex justify-between text-[12.5px]">
                  <span className="text-text-muted">Sources</span>
                  <span className="font-mono tabular-nums">
                    {data.usage.sources} / {data.usage.maxSources}
                  </span>
                </div>
                <Meter className="mt-1" value={data.usage.sources} max={data.usage.maxSources} />
              </div>
              <div>
                <div className="flex justify-between text-[12.5px]">
                  <span className="text-text-muted">Characters</span>
                  <span className="font-mono tabular-nums">
                    {compact(data.usage.characters)} / {compact(data.usage.maxCharacters)}
                  </span>
                </div>
                <Meter
                  className="mt-1"
                  value={data.usage.characters}
                  max={data.usage.maxCharacters}
                />
              </div>
            </div>
            <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-text-subtle">
              Editing knowledge costs {data.creditCost === 0 ? 'nothing' : `${data.creditCost} credits`}.
              You only pay when a reply is actually delivered.
            </p>
          </>
        ) : (
          <Skeleton className="mt-3 h-32" />
        )}
      </Card>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add knowledge"
        description="Facts the AI can quote. Write it the way you would explain it to a new employee."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!title.trim() || !content.trim()}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="size-4" />
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <Select
            value={type}
            onValueChange={setType}
            options={[
              { value: 'text', label: 'Write it myself' },
              { value: 'link', label: 'Read it from a page', description: 'We fetch and summarise it.' },
            ]}
          />

          {type === 'link' ? (
            <Field label="Page address">
              <div className="flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://yourshop.com/shipping"
                />
                <Button
                  variant="secondary"
                  disabled={!url.trim()}
                  loading={scan.isPending}
                  onClick={() => scan.mutate()}
                >
                  {scan.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                  Read it
                </Button>
              </div>
            </Field>
          ) : null}

          <Field label="Title" hint="How you'll recognise it in this list.">
            <Input
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Shipping & returns"
            />
          </Field>

          <Field
            label="What it should know"
            hint={`${content.length} characters. Plain sentences beat bullet points — the model reads it, not a person.`}
          >
            <Textarea
              value={content}
              rows={9}
              onChange={(e) => setContent(e.target.value)}
              placeholder="We ship in 1–2 days to Karachi, Lahore and Islamabad, 3–5 days elsewhere. Free over Rs 3,000. Returns within 7 days with tags on."
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

// ─── Behaviour ───────────────────────────────────────────────────────────────

function BehaviorTab({ accountId }: { accountId: string }): React.ReactElement {
  const queryClient = useQueryClient();

  const behavior = useQuery({
    queryKey: ['ai-behavior', accountId],
    queryFn: () => api.get<AiBehavior>('/ai/behavior', { connectedAccountId: accountId }),
  });

  const [draft, setDraft] = React.useState<AiBehavior | null>(null);
  React.useEffect(() => {
    if (behavior.data && !draft) setDraft(behavior.data);
  }, [behavior.data, draft]);

  const save = useMutation({
    mutationFn: () =>
      api.patch('/ai/behavior', {
        connectedAccountId: accountId,
        role: draft?.role ?? null,
        brandVoice: draft?.brandVoice ?? null,
        guardrails: draft?.guardrails ?? [],
        languageMode: draft?.languageMode,
        fixedLanguage: draft?.fixedLanguage ?? null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-behavior', accountId] });
      toast.success('Saved.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save.'),
  });

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ brandVoice: string }>('/ai/behavior/generate-voice', {
        connectedAccountId: accountId,
      }),
    onSuccess: (data) => {
      setDraft((prev) => (prev ? { ...prev, brandVoice: data.brandVoice } : prev));
      toast.success('Drafted — edit it until it sounds like you.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not generate that.'),
  });

  if (!draft) return <Skeleton className="h-96" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card className="p-5">
        <div className="space-y-4">
          <Field
            label="Who it is"
            hint="One line. This is the single biggest influence on how replies read."
          >
            <Input
              value={draft.role ?? ''}
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              placeholder="Friendly shop assistant for a Karachi streetwear label"
            />
          </Field>

          <Field
            label="How it sounds"
            hint={`${(draft.brandVoice ?? '').length} / 1000`}
          >
            <Textarea
              value={draft.brandVoice ?? ''}
              rows={6}
              maxLength={1000}
              onChange={(e) => setDraft({ ...draft, brandVoice: e.target.value })}
              placeholder="Warm and quick. Short sentences, one emoji at most, never pushy."
            />
          </Field>

          <Button
            variant="secondary"
            size="sm"
            loading={generate.isPending}
            onClick={() => generate.mutate()}
          >
            <Wand2 className="size-4" />
            Draft it from my knowledge
          </Button>

          <Field
            label="Your own rules"
            hint="Added on top of the built-in ones. One per line."
          >
            <Textarea
              value={draft.guardrails.join('\n')}
              rows={4}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  guardrails: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean),
                })
              }
              placeholder={'Never promise a delivery date we have not confirmed.\nNever discount more than 10% without a human.'}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Language">
              <Select
                value={draft.languageMode}
                onValueChange={(languageMode) => setDraft({ ...draft, languageMode })}
                options={[
                  {
                    value: 'match_sender',
                    label: 'Match whoever wrote',
                    description: 'Roman Urdu in, Roman Urdu out.',
                  },
                  { value: 'fixed', label: 'Always one language' },
                ]}
              />
            </Field>
            {draft.languageMode === 'fixed' ? (
              <Field label="Which one">
                <Input
                  value={draft.fixedLanguage ?? ''}
                  maxLength={40}
                  onChange={(e) => setDraft({ ...draft, fixedLanguage: e.target.value })}
                  placeholder="English"
                />
              </Field>
            ) : null}
          </div>

          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" />
            Save behaviour
          </Button>
        </div>
      </Card>

      <Card className="h-fit p-5">
        <h3 className="text-[15px] font-semibold tracking-tight">Always on</h3>
        <p className="mt-1 text-[12.5px] text-text-muted">
          These cannot be turned off, on any plan.
        </p>
        <ul className="mt-3 space-y-2">
          {behavior.data?.systemGuardrails.map((rule) => (
            <li key={rule} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
              <CheckCircle2 className="mt-px size-3.5 shrink-0 text-emerald-500" />
              <span className="text-text-muted">{rule}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ─── Goals ───────────────────────────────────────────────────────────────────

function GoalsTab({ accountId }: { accountId: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<GoalType>('share_link');
  const [url, setUrl] = React.useState('');
  const [field, setField] = React.useState<'email' | 'phone'>('email');

  const goals = useQuery({
    queryKey: ['ai-goals', accountId],
    queryFn: () =>
      api.get<{ goals: AiGoal[]; maxLive: number }>('/ai/goals', {
        connectedAccountId: accountId,
      }),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/ai/goals', {
        connectedAccountId: accountId,
        type,
        config: type === 'share_link' ? { url } : type === 'capture_lead' ? { field } : {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-goals', accountId] });
      setOpen(false);
      setUrl('');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not add it.'),
  });

  const patch = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'live' | 'paused' }) =>
      api.patch(`/ai/goals/${id}`, { connectedAccountId: accountId, status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-goals', accountId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/ai/goals/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-goals', accountId] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="max-w-xl text-[13px] leading-relaxed text-text-muted">
          A goal is something the AI works towards when the conversation allows it —
          never at the cost of answering the actual question. Success is measured
          by what we can observe, not by what the model claims.
        </p>
        <Button
          variant="primary"
          size="sm"
          disabled={(goals.data?.goals.length ?? 0) >= 3}
          onClick={() => setOpen(true)}
        >
          <Plus className="size-4" />
          Add a goal
        </Button>
      </div>

      {goals.isLoading ? (
        <Skeleton className="h-40" />
      ) : !goals.data?.goals.length ? (
        <EmptyState
          icon={<Target className="size-5" />}
          title="No goals yet"
          description="Without one, the AI simply answers questions — which is a perfectly good setting to leave it on."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {goals.data.goals.map((goal) => {
            const copy = GOAL_COPY[goal.type];
            const rate = goal.attempted > 0 ? goal.successful / goal.attempted : 0;
            return (
              <Card key={goal.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[13.5px] font-semibold">{copy.label}</p>
                    <p className="mt-0.5 text-[12px] text-text-muted">{copy.description}</p>
                  </div>
                  <Badge tone={goal.status === 'live' ? 'success' : 'neutral'}>{goal.status}</Badge>
                </div>

                <p className="stat-figure mt-4 text-[28px] leading-none">{percent(rate)}</p>
                <p className="mt-1 text-[11.5px] text-text-subtle">
                  {full(goal.successful)} landed of {full(goal.attempted)} attempts
                </p>
                <Meter className="mt-2" value={goal.successful} max={goal.attempted || 1} />

                <p className="mt-3 border-t border-line pt-2.5 text-[11.5px] leading-relaxed text-text-subtle">
                  {goal.successCriteria || copy.criteria}
                </p>

                <div className="mt-3 flex gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    onClick={() =>
                      patch.mutate({
                        id: goal.id,
                        status: goal.status === 'live' ? 'paused' : 'live',
                      })
                    }
                  >
                    {goal.status === 'live' ? (
                      <>
                        <Pause className="size-3.5" />
                        Pause
                      </>
                    ) : (
                      <>
                        <Play className="size-3.5" />
                        Resume
                      </>
                    )}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => remove.mutate(goal.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add a goal"
        description="At most three, and one of each kind."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={type === 'share_link' && !url.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Add it
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <Select
            value={type}
            onValueChange={setType}
            options={(Object.keys(GOAL_COPY) as GoalType[]).map((value) => ({
              value,
              label: GOAL_COPY[value].label,
              description: GOAL_COPY[value].description,
            }))}
          />
          {type === 'share_link' ? (
            <Field label="The link" hint="Minted as a tracked short link, so clicks are attributable.">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://yourshop.com/pricing"
              />
            </Field>
          ) : null}
          {type === 'capture_lead' ? (
            <Field label="What to ask for">
              <Select
                value={field}
                onValueChange={setField}
                options={[
                  { value: 'email', label: 'Email address' },
                  { value: 'phone', label: 'Phone number' },
                ]}
              />
            </Field>
          ) : null}
          <p className="rounded-lg bg-surface-sunken p-3 text-[12px] leading-relaxed text-text-muted">
            {GOAL_COPY[type].criteria}
          </p>
        </div>
      </Dialog>
    </div>
  );
}

// ─── Activity ────────────────────────────────────────────────────────────────

function ActivityTab({ accountId }: { accountId: string }): React.ReactElement {
  const [includeSkips, setIncludeSkips] = React.useState(true);

  const activity = useQuery({
    queryKey: ['ai-activity', accountId, includeSkips],
    queryFn: () =>
      api.get<{ events: AiActivityEvent[]; nextCursor: string | null }>('/ai/activity', {
        connectedAccountId: accountId,
        includeSkips,
        limit: 50,
      }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-text-muted">
          Every decision, in order. The skips are here on purpose.
        </p>
        <label className="flex items-center gap-2 text-[12.5px]">
          Show the ones it skipped
          <Switch checked={includeSkips} onCheckedChange={setIncludeSkips} />
        </label>
      </div>

      {activity.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : !activity.data?.events.length ? (
        <EmptyState
          icon={<Activity className="size-5" />}
          title="Nothing yet"
          description="Once the AI is switched on, every reply and every deliberate silence lands here."
        />
      ) : (
        <ul className="space-y-2">
          {activity.data.events.map((event) => {
            const skipped = event.kind.endsWith('_skip');
            return (
              <li key={event.id}>
                <Card className={cn('p-3.5', skipped && 'border-dashed')}>
                  <div className="flex items-start gap-3">
                    <Avatar
                      src={event.contact?.avatarUrl}
                      name={event.contact?.name}
                      size={30}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium">
                          {event.contact?.name ?? 'Someone'}
                        </span>
                        <Badge tone={skipped ? 'neutral' : 'ai'}>
                          {skipped ? (
                            <MinusCircle className="size-2.5" />
                          ) : (
                            <Sparkles className="size-2.5" />
                          )}
                          {humanize(event.kind)}
                        </Badge>
                        {event.label ? <Badge tone="neutral">{humanize(event.label)}</Badge> : null}
                        {event.goal ? (
                          <Badge tone={event.goalSucceeded ? 'success' : 'brand'}>
                            <Target className="size-2.5" />
                            {event.goalSucceeded ? 'goal landed' : 'goal attempted'}
                          </Badge>
                        ) : null}
                        <span className="ml-auto text-[11px] text-text-subtle">
                          {timeAgo(event.createdAt)}
                        </span>
                      </div>

                      {event.triggerText ? (
                        <p className="mt-1.5 text-[12.5px] italic text-text-subtle">
                          “{event.triggerText}”
                        </p>
                      ) : null}

                      {skipped ? (
                        <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-muted">
                          {SKIP_COPY[event.skipReason ?? ''] ?? humanize(event.skipReason ?? '')}{' '}
                          <span className="text-text-subtle">· 0 credits</span>
                        </p>
                      ) : (
                        <>
                          <p className="mt-1.5 text-[13px] leading-relaxed">{event.replyText}</p>
                          <p className="mt-1 text-[11px] text-text-subtle">
                            {event.creditsCharged} credit{event.creditsCharged === 1 ? '' : 's'}
                            {event.conversationId ? (
                              <>
                                {' · '}
                                <Link
                                  to={`/inbox/${event.conversationId}`}
                                  className="underline-offset-2 hover:underline"
                                >
                                  open the thread
                                </Link>
                              </>
                            ) : null}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Upsell ──────────────────────────────────────────────────────────────────

function AiUpsell(): React.ReactElement {
  const navigate = useNavigate();
  return (
    <PageBody>
      <div className="mx-auto max-w-2xl py-10 text-center">
        <Badge tone="ai" className="mx-auto">
          <Sparkles className="size-3" />
          LeadWave AI
        </Badge>
        <h1 className="display mt-4 text-[clamp(2rem,5vw,2.8rem)]">
          It answers the questions
          <br />
          you keep answering.
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-[14.5px] leading-relaxed text-text-muted">
          Sizing, shipping, "is this still available" — answered in your voice,
          from your own notes, within seconds. And when it does not know, it says
          nothing rather than inventing something.
        </p>

        <div className="mt-8 grid gap-3 text-left sm:grid-cols-3">
          {[
            {
              title: 'It only knows what you tell it',
              body: 'No web browsing, no guessing. If the answer is not in your knowledge, it stays quiet.',
            },
            {
              title: 'Your automations come first',
              body: 'The AI is only considered when no keyword automation claimed the message. Nobody gets two replies.',
            },
            {
              title: 'One credit, one delivered reply',
              body: 'Classification, skips and failed sends cost nothing. You are charged after it lands, never before.',
            },
          ].map((item) => (
            <Card key={item.title} className="p-4">
              <p className="text-[13.5px] font-semibold">{item.title}</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-muted">{item.body}</p>
            </Card>
          ))}
        </div>

        <Button
          variant="primary"
          size="lg"
          className="mt-8"
          onClick={() => navigate('/settings/billing')}
        >
          See what it costs
        </Button>
      </div>
    </PageBody>
  );
}
