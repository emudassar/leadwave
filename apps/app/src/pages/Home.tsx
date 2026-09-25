/**
 * Home.
 *
 * Four numbers, a setup score, and the automations that are actually earning
 * their place. The ordering is deliberate: what happened (stats), what to fix
 * (setup), what is working (top automations), what needs a human (inbox). A
 * dashboard that opens on a chart nobody asked for is a dashboard nobody reads.
 */
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  Inbox,
  MessageSquare,
  MousePointerClick,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, compact, full, percent, timeAgo } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/AppShell';
import { Badge, Button, Card, CardHeader, EmptyState, Meter, Skeleton } from '@/components/ui';
import { TRIGGER_META } from '@/lib/automation-meta';
import type { AutomationListItem, HomeSummary } from '@/types';

// ─── Stat tile ───────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'brand',
  to,
}: {
  label: string;
  value: number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'brand' | 'amber' | 'emerald' | 'sky';
  to?: string;
}): React.ReactElement {
  const tones = {
    brand: 'text-brand-600 bg-brand-600/10 dark:text-brand-300',
    amber: 'text-amber-600 bg-amber-500/12 dark:text-amber-300',
    emerald: 'text-emerald-600 bg-emerald-500/12 dark:text-emerald-300',
    sky: 'text-sky-600 bg-sky-500/12 dark:text-sky-300',
  };

  const body = (
    <Card className="group relative h-full p-4 transition-colors hover:border-line-strong">
      <div className={cn('flex size-8 items-center justify-center rounded-lg', tones[tone])}>
        <Icon className="size-4" />
      </div>
      <p className="stat-figure mt-3 text-[30px] leading-none">{compact(value)}</p>
      <p className="mt-1.5 text-[12.5px] font-medium text-text">{label}</p>
      {sub ? <p className="text-[11.5px] text-text-subtle">{sub}</p> : null}
      {to ? (
        <ArrowUpRight className="absolute right-3 top-3 size-4 text-text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      ) : null}
    </Card>
  );

  return to ? <Link to={to}>{body}</Link> : body;
}

// ─── Setup checklist ─────────────────────────────────────────────────────────

const STEP_LINKS: Record<string, string> = {
  connect_page: '/settings/pages',
  create_automation: '/automations/new',
  first_trigger: '/automations',
  bio_page: '/bio',
};

function SetupCard({ setup }: { setup: HomeSummary['setup'] }): React.ReactElement | null {
  if (setup.score === 100) return null;
  const remaining = setup.steps.filter((s) => !s.done).length;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-4 p-5 pb-3">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight">
            {remaining === 1 ? 'One step left' : `${remaining} steps left`}
          </h3>
          <p className="mt-1 text-[13px] text-text-muted">
            Finish these and LeadWave runs on its own.
          </p>
        </div>
        <span className="stat-figure text-[26px] leading-none text-brand-600 dark:text-brand-300">
          {setup.score}%
        </span>
      </div>
      <div className="px-5">
        <Meter value={setup.score} max={100} />
      </div>
      <ul className="mt-4 divide-y divide-line border-t border-line">
        {setup.steps.map((step) => (
          <li key={step.id}>
            <Link
              to={STEP_LINKS[step.id] ?? '/home'}
              className={cn(
                'flex items-center gap-2.5 px-5 py-2.5 text-[13.5px] transition-colors',
                step.done
                  ? 'text-text-subtle'
                  : 'font-medium text-text hover:bg-surface-sunken',
              )}
            >
              {step.done ? (
                <CheckCircle2 className="size-4.5 shrink-0 text-emerald-500" />
              ) : (
                <Circle className="size-4.5 shrink-0 text-text-subtle" />
              )}
              <span className={cn('flex-1', step.done && 'line-through decoration-1')}>
                {step.label}
              </span>
              {!step.done ? <ArrowRight className="size-4 text-text-subtle" /> : null}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─── Templates ───────────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: 'comment',
    title: 'Comment → DM',
    body: 'Someone types your keyword under a post. They get the link in their inbox, instantly.',
    trigger: 'comment' as const,
  },
  {
    id: 'dm_keyword',
    title: 'Answer the same question, once',
    body: '"Do you ship?" gets the shipping answer before you have read it.',
    trigger: 'dm_keyword' as const,
  },
  {
    id: 'story_reply',
    title: 'Story reply → best sellers',
    body: 'Every reply to a story becomes a carousel of what you want them to buy.',
    trigger: 'story_reply' as const,
  },
];

// ─── Page ────────────────────────────────────────────────────────────────────

export function HomePage(): React.ReactElement {
  const { me, auth, activeAccountId } = useSession();
  const navigate = useNavigate();

  const home = useQuery({
    queryKey: ['home'],
    queryFn: () => api.get<HomeSummary>('/accounts/me/home'),
  });

  const automations = useQuery({
    queryKey: ['automations', activeAccountId],
    queryFn: () =>
      api.get<{ automations: AutomationListItem[] }>('/automations', {
        connectedAccountId: activeAccountId,
      }),
    enabled: Boolean(activeAccountId),
  });

  const firstName = auth.user.name?.split(' ')[0] ?? 'there';
  const stats = home.data?.stats;

  const topAutomations = React.useMemo(() => {
    const list = automations.data?.automations ?? [];
    return [...list]
      .filter((a) => a.status !== 'draft')
      .sort((a, b) => b.runCount - a.runCount)
      .slice(0, 4);
  }, [automations.data]);

  return (
    <PageBody>
      <PageHeader
        title={`${greeting()}, ${firstName}.`}
        description={
          stats && stats.triggersThisWeek > 0
            ? `LeadWave handled ${full(stats.triggersThisWeek)} ${
                stats.triggersThisWeek === 1 ? 'conversation' : 'conversations'
              } for you this week.`
            : 'Nothing has triggered yet this week. Publish an automation and it starts working immediately.'
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/inbox')}>
              <Inbox className="size-4" />
              Inbox
              {stats?.unreadConversations ? (
                <Badge tone="brand" className="ml-0.5">
                  {stats.unreadConversations}
                </Badge>
              ) : null}
            </Button>
            <Button variant="primary" onClick={() => navigate('/automations/new')}>
              <Zap className="size-4" />
              New automation
            </Button>
          </>
        }
      />

      {/* ─── Numbers ─────────────────────────────────────────────────────── */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {home.isLoading || !stats ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[126px]" />)
        ) : (
          <>
            <Stat
              label="Triggers"
              sub="last 7 days"
              value={stats.triggersThisWeek}
              icon={Zap}
              tone="brand"
              to="/automations"
            />
            <Stat
              label="Link clicks"
              sub="last 7 days"
              value={stats.clicksThisWeek}
              icon={MousePointerClick}
              tone="sky"
              to="/automations"
            />
            <Stat
              label="Leads captured"
              sub="last 7 days"
              value={stats.leadsThisWeek}
              icon={Users}
              tone="emerald"
              to="/contacts"
            />
            <Stat
              label="Waiting on you"
              sub="unread conversations"
              value={stats.unreadConversations}
              icon={MessageSquare}
              tone="amber"
              to="/inbox"
            />
          </>
        )}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* ─── What's working ───────────────────────────────────────────── */}
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="What's working"
              description="Your live automations, by how often they have actually fired."
              action={
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/automations">
                    All automations
                    <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              }
            />

            {automations.isLoading ? (
              <div className="space-y-2 px-5 pb-5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : topAutomations.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyState
                  icon={<Zap className="size-5" />}
                  title="Nothing live yet"
                  description="Pick a starting point below — the first one takes about a minute."
                />
              </div>
            ) : (
              <ul className="divide-y divide-line border-t border-line">
                {topAutomations.map((automation) => {
                  const meta = TRIGGER_META[automation.triggerType];
                  const ctr =
                    automation.runCount > 0 ? automation.uniqueClicks / automation.runCount : 0;
                  return (
                    <li key={automation.id}>
                      <Link
                        to={`/automations/${automation.id}`}
                        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-sunken"
                      >
                        <span
                          className={cn(
                            'flex size-8 shrink-0 items-center justify-center rounded-lg',
                            meta.tint,
                          )}
                        >
                          <meta.icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[13.5px] font-medium">
                              {automation.name}
                            </span>
                            {automation.status === 'paused' ? (
                              <Badge tone="warning">Paused</Badge>
                            ) : null}
                          </span>
                          <span className="block truncate text-[11.5px] text-text-subtle">
                            {meta.label}
                            {automation.lastTriggeredAt
                              ? ` · last fired ${timeAgo(automation.lastTriggeredAt)}`
                              : ' · not fired yet'}
                          </span>
                        </span>
                        <span className="hidden shrink-0 gap-5 text-right sm:flex">
                          <span>
                            <span className="block font-mono text-[13px] tabular-nums">
                              {compact(automation.runCount)}
                            </span>
                            <span className="block text-[10.5px] text-text-subtle">triggers</span>
                          </span>
                          <span>
                            <span className="block font-mono text-[13px] tabular-nums">
                              {compact(automation.uniqueClicks)}
                            </span>
                            <span className="block text-[10.5px] text-text-subtle">clickers</span>
                          </span>
                          <span className="w-12">
                            <span
                              className={cn(
                                'block font-mono text-[13px] tabular-nums',
                                ctr >= 0.3 ? 'text-emerald-500' : 'text-text',
                              )}
                            >
                              {percent(Math.min(ctr, 1))}
                            </span>
                            <span className="block text-[10.5px] text-text-subtle">CTR</span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* ─── Starting points ────────────────────────────────────────── */}
          <div>
            <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-text-subtle">
              Start from a proven pattern
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {TEMPLATES.map((template) => {
                const meta = TRIGGER_META[template.trigger];
                return (
                  <button
                    key={template.id}
                    onClick={() => navigate(`/automations/new?trigger=${template.trigger}`)}
                    className="group flex flex-col rounded-xl border border-line bg-surface-raised p-4 text-left transition-all hover:border-brand-600/40 hover:shadow-[var(--shadow-card)]"
                  >
                    <span
                      className={cn(
                        'flex size-8 items-center justify-center rounded-lg',
                        meta.tint,
                      )}
                    >
                      <meta.icon className="size-4" />
                    </span>
                    <span className="mt-3 text-[13.5px] font-semibold">{template.title}</span>
                    <span className="mt-1 flex-1 text-[12.5px] leading-relaxed text-text-muted">
                      {template.body}
                    </span>
                    <span className="mt-3 flex items-center gap-1 text-[12px] font-medium text-brand-600 dark:text-brand-300">
                      Set it up
                      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ─── Right rail ───────────────────────────────────────────────── */}
        <div className="space-y-5">
          {home.data ? <SetupCard setup={home.data.setup} /> : <Skeleton className="h-64" />}

          {/* AI: sell it if they don't have it, meter it if they do. */}
          {me.plan.hasAi ? (
            <Card className="p-5">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-amber-accent" />
                <h3 className="text-[15px] font-semibold tracking-tight">LeadWave AI</h3>
              </div>
              <p className="mt-1 text-[13px] text-text-muted">
                {full(me.credits.remaining)} credits left this cycle.
              </p>
              <Meter
                className="mt-3"
                value={me.credits.used}
                max={me.credits.included + me.credits.bonus}
              />
              <p className="mt-2 text-[11.5px] text-text-subtle">
                One credit is one reply that actually landed. Skips, classification
                and failed sends are free.
              </p>
              <Button variant="secondary" size="sm" className="mt-3.5 w-full" asChild>
                <Link to="/ai">Open AI settings</Link>
              </Button>
            </Card>
          ) : (
            <Card className="overflow-hidden border-brand-600/25">
              <div className="bg-linear-to-br from-brand-600/14 to-cyan-500/10 p-5">
                <Badge tone="ai">
                  <Sparkles className="size-3" />
                  LeadWave AI
                </Badge>
                <h3 className="mt-2.5 text-[15px] font-semibold tracking-tight">
                  Stop answering the same question
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
                  It reads your own shipping, sizing and pricing notes, answers in
                  your voice, and stays quiet when it doesn't know. Every decision
                  it makes is on the record, including the ones where it said
                  nothing.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3.5 w-full"
                  onClick={() => navigate('/settings/billing')}
                >
                  See what it costs
                </Button>
              </div>
            </Card>
          )}

          <Card className="p-5">
            <div className="flex items-center gap-2">
              <TrendingUp className="size-4 text-text-subtle" />
              <h3 className="text-[15px] font-semibold tracking-tight">This cycle</h3>
            </div>
            <dl className="mt-3 space-y-2.5">
              {[
                {
                  label: 'Messages sent',
                  value: full(me.usage.messagesSent),
                  cap: me.plan.limits.messagesPerMonth,
                  used: me.usage.messagesSent,
                },
                {
                  label: 'Contacts',
                  value: full(me.usage.contacts),
                  cap: me.plan.limits.contacts,
                  used: me.usage.contacts,
                },
                {
                  label: 'Leads',
                  value: full(me.usage.leadsCaptured),
                  cap: me.plan.limits.leads,
                  used: me.usage.leadsCaptured,
                },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex items-baseline justify-between text-[12.5px]">
                    <dt className="text-text-muted">{row.label}</dt>
                    <dd className="font-mono tabular-nums">
                      {row.value}
                      {row.cap !== null ? (
                        <span className="text-text-subtle"> / {full(row.cap)}</span>
                      ) : null}
                    </dd>
                  </div>
                  {row.cap !== null ? (
                    <Meter className="mt-1" value={row.used} max={row.cap} />
                  ) : null}
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[11.5px] text-text-subtle">
              Resets{' '}
              {new Date(me.usage.periodEnd).toLocaleDateString(undefined, {
                month: 'long',
                day: 'numeric',
              })}
              . Nothing rolls over, nothing overages.
            </p>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
