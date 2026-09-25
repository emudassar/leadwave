/**
 * Settings: workspace, Pages, team, billing, integrations.
 *
 * The plan table is generated from the same `PLAN_DEFINITIONS` the API enforces,
 * so the pricing page and the gate that stops you can never disagree. Where a
 * feature is locked, the UI says which plan unlocks it rather than hiding it —
 * a greyed row with a reason converts and an invisible one just confuses.
 */
import * as React from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Building2,
  Check,
  CreditCard,
  ExternalLink,
  Facebook,
  Link2,
  Loader2,
  Lock,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { FEATURES, PLAN_DEFINITIONS, hasFeature, type Feature, type Plan } from '@leadwave/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, full, humanize, limitLabel, timeAgo } from '@/lib/utils';
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
  Select,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@/components/ui';
import type {
  BillingPlansResponse,
  IntegrationsResponse,
  MembersResponse,
  MetaConfig,
  WorkspaceRole,
} from '@/types';

const TABS = [
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'pages', label: 'Facebook Pages', icon: Facebook },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'billing', label: 'Plan & billing', icon: CreditCard },
  { id: 'integrations', label: 'Integrations', icon: Plug },
] as const;

/** Feature rows, grouped the way someone comparing plans actually thinks. */
const FEATURE_GROUPS: Array<{ title: string; features: Feature[] }> = [
  {
    title: 'Triggers',
    features: [
      'trigger_comment',
      'trigger_story',
      'trigger_dm_keyword',
      'trigger_ice_breaker',
      'trigger_next_post',
    ],
  },
  {
    title: 'What you can send',
    features: [
      'action_product_carousel',
      'action_follow_gate',
      'action_lead_capture_email',
      'action_lead_capture_phone',
      'action_follow_up',
      'multiple_button_links',
      'schedule_messages',
    ],
  },
  {
    title: 'Tools',
    features: ['retrigger', 'lifetime_analytics', 'remove_branding'],
  },
  {
    title: 'Link in bio',
    features: [
      'bio_page',
      'bio_link_scheduling',
      'bio_seo_controls',
      'bio_premium_themes',
      'bio_multiple_pages',
    ],
  },
  { title: 'LeadWave AI', features: ['ai_replies', 'ai_comments', 'ai_goals', 'ai_knowledge'] },
  { title: 'Team & data', features: ['team_seats', 'google_sheets', 'meta_ads_export'] },
];

const FEATURE_LABELS: Partial<Record<Feature, string>> = {
  trigger_comment: 'Comment → DM',
  trigger_story: 'Story replies and reactions',
  trigger_dm_keyword: 'Keyword auto-reply',
  trigger_ice_breaker: 'Ice breakers',
  trigger_next_post: 'Watch every post, including future ones',
  action_product_carousel: 'Product carousel',
  action_follow_gate: 'Follow Gate',
  action_lead_capture_email: 'Capture emails',
  action_lead_capture_phone: 'Capture phone numbers',
  action_follow_up: 'Follow-up nudge',
  multiple_button_links: 'Three links in one message',
  retrigger: 'Re-run on old posts',
  schedule_messages: 'Schedule messages',
  lifetime_analytics: 'Lifetime analytics',
  remove_branding: 'Remove LeadWave branding',
  bio_page: 'Link-in-bio page',
  bio_link_scheduling: 'Scheduled links',
  bio_seo_controls: 'SEO controls',
  bio_premium_themes: 'Premium themes',
  bio_multiple_pages: 'Multiple bio pages',
  ai_replies: 'AI replies to messages',
  ai_comments: 'AI replies to comments',
  ai_goals: 'AI goals',
  ai_knowledge: 'AI knowledge base',
  team_seats: 'Team seats',
  google_sheets: 'Google Sheets sync',
  meta_ads_export: 'Meta Ads audience export',
};

export function SettingsPage(): React.ReactElement {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Facebook's callback comes back here, so the connect flow lands on Pages.
  const active = React.useMemo(() => {
    if (params.get('fb_handoff') || params.get('fb_error')) return 'pages';
    if (params.get('upgraded')) return 'billing';
    return TABS.some((t) => t.id === tab) ? tab! : 'workspace';
  }, [tab, params]);

  return (
    <PageBody>
      <PageHeader title="Settings" />

      <Tabs
        value={active}
        onValueChange={(value) =>
          navigate(value === 'workspace' ? '/settings' : `/settings/${value}`)
        }
        className="mt-6"
      >
        <TabsList className="overflow-x-auto">
          {TABS.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <item.icon className="size-3.5" />
                {item.label}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="workspace" className="pt-5">
          <WorkspaceTab />
        </TabsContent>
        <TabsContent value="pages" className="pt-5">
          <PagesTab />
        </TabsContent>
        <TabsContent value="team" className="pt-5">
          <TeamTab />
        </TabsContent>
        <TabsContent value="billing" className="pt-5">
          <BillingTab />
        </TabsContent>
        <TabsContent value="integrations" className="pt-5">
          <IntegrationsTab />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}

// ─── Workspace ───────────────────────────────────────────────────────────────

function WorkspaceTab(): React.ReactElement {
  const { me, auth } = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(me.workspace.name);
  const [timezone, setTimezone] = React.useState(me.workspace.timezone);

  const save = useMutation({
    mutationFn: () => api.patch('/accounts/me', { name, timezone }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', 'me'] });
      toast.success('Saved.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save.'),
  });

  const zones =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [me.workspace.timezone, 'UTC'];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5">
        <h3 className="text-[15px] font-semibold tracking-tight">Workspace</h3>
        <div className="mt-4 space-y-3.5">
          <Field label="Name">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Time zone"
            hint="Used for scheduling, analytics day boundaries and Sheets timestamps."
          >
            <Select
              value={timezone}
              onValueChange={setTimezone}
              options={zones.slice(0, 400).map((zone) => ({ value: zone, label: zone }))}
            />
          </Field>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={me.workspace.role !== 'admin'}
            onClick={() => save.mutate()}
          >
            <Save className="size-4" />
            Save
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="text-[15px] font-semibold tracking-tight">You</h3>
        <div className="mt-4 flex items-center gap-3">
          <Avatar src={auth.user.avatarUrl} name={auth.user.name ?? auth.user.email} size={44} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-medium">{auth.user.name ?? 'No name set'}</p>
            <p className="truncate text-[12.5px] text-text-subtle">{auth.user.email}</p>
          </div>
          <Badge tone="brand" className="ml-auto capitalize">
            {me.workspace.role}
          </Badge>
        </div>
        <dl className="mt-5 space-y-2 border-t border-line pt-4 text-[12.5px]">
          <div className="flex justify-between">
            <dt className="text-text-muted">Plan</dt>
            <dd className="font-medium">{me.plan.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Pages connected</dt>
            <dd className="font-mono tabular-nums">
              {me.usage.connectedPages} / {limitLabel(me.plan.limits.connectedPages)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Cycle ends</dt>
            <dd>{new Date(me.usage.periodEnd).toLocaleDateString()}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

// ─── Pages ───────────────────────────────────────────────────────────────────

interface HandoffPage {
  id: string;
  name: string;
  username: string | null;
  picture: string | null;
  category: string | null;
  alreadyConnected: boolean;
}

function PagesTab(): React.ReactElement {
  const { me, accounts } = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const handoff = params.get('fb_handoff');
  const fbError = params.get('fb_error');

  const config = useQuery({
    queryKey: ['meta', 'config'],
    queryFn: () => api.get<MetaConfig>('/meta/auth/fb/config'),
  });

  const pages = useQuery({
    queryKey: ['meta', 'handoff', handoff],
    queryFn: () => api.get<{ pages: HandoffPage[] }>(`/meta/auth/fb/pages/${handoff}`),
    enabled: Boolean(handoff),
    retry: false,
  });

  React.useEffect(() => {
    const list = pages.data?.pages;
    if (list) setSelected(new Set(list.filter((p) => !p.alreadyConnected).map((p) => p.id)));
  }, [pages.data]);

  const start = useMutation({
    mutationFn: () => api.get<{ url: string }>('/meta/auth/fb/start'),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not start.'),
  });

  const connect = useMutation({
    mutationFn: () =>
      api.post('/meta/auth/fb/connect', { handoff, pageIds: [...selected] }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', 'me'] });
      setParams({});
      toast.success('Connected.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not connect.'),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.delete(`/meta/connected-accounts/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', 'me'] });
      toast.success('Disconnected. Its access token has been deleted.');
    },
  });

  const limit = me.plan.limits.connectedPages;

  return (
    <div className="space-y-4">
      {fbError ? (
        <Card className="border-red-500/25 bg-red-500/6 p-4 text-[13px] text-red-600 dark:text-red-400">
          {fbError}
        </Card>
      ) : null}

      {handoff ? (
        <Card className="p-5">
          <h3 className="text-[15px] font-semibold tracking-tight">Pick the Pages to connect</h3>
          {pages.isLoading ? (
            <Loader2 className="mt-4 size-4 animate-spin text-text-subtle" />
          ) : pages.isError ? (
            <p className="mt-2 text-[13px] text-text-muted">
              That connection expired. Start it again below.
            </p>
          ) : (
            <>
              <div className="mt-3 space-y-2">
                {pages.data?.pages.map((page) => {
                  const isSelected = selected.has(page.id);
                  return (
                    <button
                      key={page.id}
                      disabled={page.alreadyConnected}
                      onClick={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(page.id)) next.delete(page.id);
                          else next.add(page.id);
                          return next;
                        })
                      }
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                        page.alreadyConnected
                          ? 'cursor-default border-line bg-surface-sunken opacity-70'
                          : isSelected
                            ? 'border-brand-600 bg-brand-600/8'
                            : 'border-line hover:border-line-strong',
                      )}
                    >
                      <Avatar src={page.picture} name={page.name} size={36} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">{page.name}</span>
                        <span className="block truncate text-[12px] text-text-subtle">
                          {page.category ?? `@${page.username ?? page.id}`}
                        </span>
                      </span>
                      {page.alreadyConnected ? (
                        <Badge tone="success">Connected</Badge>
                      ) : (
                        <span
                          className={cn(
                            'flex size-5 items-center justify-center rounded-md border',
                            isSelected ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong',
                          )}
                        >
                          {isSelected ? <Check className="size-3.5" /> : null}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <Button
                variant="primary"
                className="mt-4"
                disabled={selected.size === 0}
                loading={connect.isPending}
                onClick={() => connect.mutate()}
              >
                Connect {selected.size > 1 ? `${selected.size} Pages` : 'this Page'}
              </Button>
            </>
          )}
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Connected Pages"
          description={`${accounts.length} of ${limitLabel(limit)} on the ${me.plan.name} plan.`}
          action={
            <Button
              variant="primary"
              size="sm"
              disabled={!config.data?.configured || me.workspace.role !== 'admin'}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              <Plus className="size-4" />
              Connect a Page
            </Button>
          }
        />

        {accounts.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              icon={<Facebook className="size-5" />}
              title="No Pages connected"
              description="LeadWave works on Facebook Pages, not personal profiles."
              className="border-0"
            />
          </div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {accounts.map((account) => (
              <li key={account.id} className="flex items-center gap-3 px-5 py-3.5">
                <Avatar
                  src={account.pagePictureUrl}
                  name={account.pageName}
                  size={40}
                  ring={account.color}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[13.5px] font-medium">{account.pageName}</p>
                    {account.status === 'active' ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Tooltip content={account.statusDetail ?? 'Reconnect this Page'}>
                        <span>
                          <Badge tone="warning">
                            <AlertTriangle className="size-2.5" />
                            {humanize(account.status)}
                          </Badge>
                        </span>
                      </Tooltip>
                    )}
                  </div>
                  <p className="truncate text-[11.5px] text-text-subtle">
                    @{account.pageUsername ?? account.pageId}
                    {account.webhookSubscribedAt
                      ? ` · receiving events since ${timeAgo(account.webhookSubscribedAt)}`
                      : ' · not receiving events yet'}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  {account.pageUrl ? (
                    <Button variant="ghost" size="icon" asChild>
                      <a href={account.pageUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={me.workspace.role !== 'admin'}
                    onClick={() => disconnect.mutate(account.id)}
                    aria-label="Disconnect"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {config.data && !config.data.configured ? (
        <Card className="border-amber-500/30 bg-amber-500/6 p-4">
          <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-300">
            Facebook is not configured on this deployment
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
            Set <code className="font-mono">META_APP_ID</code> and{' '}
            <code className="font-mono">META_APP_SECRET</code>, and point your Meta app's
            webhook at <code className="font-mono">{config.data.webhookUrl}</code>.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

// ─── Team ────────────────────────────────────────────────────────────────────

function TeamTab(): React.ReactElement {
  const { me, can } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<WorkspaceRole>('manager');

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<MembersResponse>('/accounts/me/members'),
  });

  const invite = useMutation({
    mutationFn: () => api.post('/accounts/me/invites', { email: email.trim(), role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      setOpen(false);
      setEmail('');
      toast.success('Invited.');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not invite.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/accounts/me/members/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members'] }),
  });

  if (!can('team_seats')) {
    return (
      <Card className="p-8 text-center">
        <Lock className="mx-auto size-5 text-text-subtle" />
        <h3 className="mt-3 text-[16px] font-semibold tracking-tight">
          Team seats are part of Business
        </h3>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-text-muted">
          Up to five people, each with their own sign-in, working the same inbox.
          Managers can reply and edit automations; viewers can only look.
        </p>
        <Button variant="primary" className="mt-4" onClick={() => navigate('/settings/billing')}>
          <Sparkles className="size-4" />
          See Business
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Team"
        description={`${members.data?.members.length ?? 0} of ${members.data?.seatLimit ?? me.plan.limits.teamSeats} seats used.`}
        action={
          <Button
            variant="primary"
            size="sm"
            disabled={me.workspace.role !== 'admin'}
            onClick={() => setOpen(true)}
          >
            <Plus className="size-4" />
            Invite
          </Button>
        }
      />

      {members.isLoading ? (
        <Skeleton className="m-5 mt-0 h-32" />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {members.data?.members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-5 py-3">
              <Avatar
                src={member.user.avatarUrl}
                name={member.user.name ?? member.user.email}
                size={34}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">
                  {member.user.name ?? member.user.email}
                  {member.isYou ? <span className="text-text-subtle"> (you)</span> : null}
                </p>
                <p className="truncate text-[11.5px] text-text-subtle">{member.user.email}</p>
              </div>
              <Badge tone="neutral" className="capitalize">
                {member.role}
              </Badge>
              {!member.isYou && me.workspace.role === 'admin' ? (
                <Button variant="ghost" size="icon" onClick={() => remove.mutate(member.id)}>
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </li>
          ))}

          {members.data?.invites.map((pending) => (
            <li key={pending.id} className="flex items-center gap-3 px-5 py-3 opacity-70">
              <Avatar name={pending.email} size={34} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px]">{pending.email}</p>
                <p className="text-[11.5px] text-text-subtle">
                  Invited · expires {timeAgo(pending.expiresAt)}
                </p>
              </div>
              <Badge tone="warning">Pending</Badge>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Invite someone"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!email.includes('@')}
              loading={invite.isPending}
              onClick={() => invite.mutate()}
            >
              Send the invite
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
            />
          </Field>
          <Field label="Role">
            <Select
              value={role}
              onValueChange={setRole}
              options={[
                {
                  value: 'manager',
                  label: 'Manager',
                  description: 'Replies in the inbox and edits automations.',
                },
                { value: 'viewer', label: 'Viewer', description: 'Read-only.' },
                { value: 'admin', label: 'Admin', description: 'Everything, including billing.' },
              ]}
            />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}

// ─── Billing ─────────────────────────────────────────────────────────────────

function BillingTab(): React.ReactElement {
  const { me } = useSession();
  const [interval, setInterval] = React.useState<'month' | 'year'>('month');

  const plans = useQuery({
    queryKey: ['billing-plans'],
    queryFn: () => api.get<BillingPlansResponse>('/billing/plans'),
  });

  const checkout = useMutation({
    mutationFn: (plan: Plan) => api.post<{ url?: string }>('/billing/checkout', { plan, interval }),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
      else toast.error('Checkout is not configured on this deployment yet.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not start checkout.'),
  });

  const portal = useMutation({
    mutationFn: () => api.post<{ url?: string }>('/billing/portal'),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'No subscription to manage yet.'),
  });

  const list = plans.data?.plans ?? [];

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            Current plan
          </p>
          <p className="display mt-1 text-[26px]">{me.plan.name}</p>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {me.subscription?.cancelAtPeriodEnd
              ? `Cancels on ${new Date(me.subscription.currentPeriodEnd ?? '').toLocaleDateString()}.`
              : me.subscription?.currentPeriodEnd
                ? `Renews ${new Date(me.subscription.currentPeriodEnd).toLocaleDateString()}.`
                : 'No card on file.'}
          </p>
        </div>
        {me.subscription?.provider !== 'manual' ? (
          <Button variant="secondary" loading={portal.isPending} onClick={() => portal.mutate()}>
            Manage billing
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}
      </Card>

      <div className="flex items-center justify-center gap-3">
        <span className={cn('text-[13px]', interval === 'month' ? 'font-medium' : 'text-text-muted')}>
          Monthly
        </span>
        <Switch
          checked={interval === 'year'}
          onCheckedChange={(v) => setInterval(v ? 'year' : 'month')}
        />
        <span className={cn('text-[13px]', interval === 'year' ? 'font-medium' : 'text-text-muted')}>
          Yearly
        </span>
        <Badge tone="success">2 months free</Badge>
      </div>

      <div className="grid gap-3 lg:grid-cols-4">
        {list.map((plan) => {
          const isCurrent = plan.id === me.workspace.plan;
          const price = interval === 'year' ? plan.priceYearlyUsd : plan.priceMonthlyUsd;
          const featured = plan.id === 'growth';

          return (
            <Card
              key={plan.id}
              className={cn(
                'relative flex flex-col p-5',
                featured && 'border-brand-600/50 ring-1 ring-brand-600/20',
              )}
            >
              {featured ? (
                <Badge tone="ai" className="absolute -top-2.5 left-5">
                  <Sparkles className="size-3" />
                  Most popular
                </Badge>
              ) : null}

              <p className="text-[15px] font-semibold tracking-tight">{plan.name}</p>
              <p className="mt-0.5 min-h-8 text-[12.5px] leading-relaxed text-text-muted">
                {plan.tagline}
              </p>

              <p className="mt-3 flex items-baseline gap-1">
                <span className="display text-[32px]">${price}</span>
                <span className="text-[12.5px] text-text-subtle">
                  /{interval === 'year' ? 'yr' : 'mo'}
                </span>
              </p>

              <Button
                variant={isCurrent ? 'secondary' : featured ? 'primary' : 'outline'}
                className="mt-4 w-full"
                disabled={isCurrent || plan.id === 'free' || me.workspace.role !== 'admin'}
                loading={checkout.isPending && checkout.variables === plan.id}
                onClick={() => checkout.mutate(plan.id)}
              >
                {isCurrent ? 'Your plan' : plan.id === 'free' ? 'Free forever' : `Upgrade to ${plan.name}`}
              </Button>

              <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-[12px]">
                {(
                  [
                    ['Pages', limitLabel(plan.limits.connectedPages)],
                    ['Messages', limitLabel(plan.limits.messagesPerMonth)],
                    ['Contacts', limitLabel(plan.limits.contacts)],
                    ['AI credits', plan.limits.aiCreditsPerMonth ? full(plan.limits.aiCreditsPerMonth) : '—'],
                    ['Team seats', String(plan.limits.teamSeats)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-text-muted">{label}</dt>
                    <dd className="font-mono tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          );
        })}
      </div>

      {/* Feature matrix */}
      <Card className="overflow-x-auto">
        <CardHeader
          title="Everything, side by side"
          description="Generated from the same table the API enforces, so this is never out of date."
        />
        <table className="w-full min-w-3xl border-t border-line text-[12.5px]">
          <thead>
            <tr className="bg-surface-sunken/60">
              <th className="px-5 py-2 text-left font-medium text-text-muted">Feature</th>
              {(Object.keys(PLAN_DEFINITIONS) as Plan[]).map((plan) => (
                <th key={plan} className="w-24 px-3 py-2 text-center font-medium">
                  {PLAN_DEFINITIONS[plan].name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURE_GROUPS.map((group) => (
              <React.Fragment key={group.title}>
                <tr>
                  <td
                    colSpan={5}
                    className="border-t border-line px-5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-text-subtle"
                  >
                    {group.title}
                  </td>
                </tr>
                {group.features
                  .filter((feature) => FEATURES.includes(feature))
                  .map((feature) => (
                    <tr key={feature} className="border-t border-line/60">
                      <td className="px-5 py-1.5 text-text-muted">
                        {FEATURE_LABELS[feature] ?? humanize(feature)}
                      </td>
                      {(Object.keys(PLAN_DEFINITIONS) as Plan[]).map((plan) => (
                        <td key={plan} className="px-3 py-1.5 text-center">
                          {hasFeature(plan, feature) ? (
                            <Check className="mx-auto size-3.5 text-emerald-500" />
                          ) : (
                            <span className="text-text-subtle">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      {plans.data && !plans.data.configured ? (
        <p className="text-center text-[12px] text-text-subtle">
          Billing is not configured on this deployment — checkout will not open until{' '}
          <code className="font-mono">{plans.data.provider.toUpperCase()}</code> credentials
          are set.
        </p>
      ) : null}
    </div>
  );
}

// ─── Integrations ────────────────────────────────────────────────────────────

function IntegrationsTab(): React.ReactElement {
  const { me, activeAccountId, can } = useSession();
  const queryClient = useQueryClient();

  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.get<IntegrationsResponse>('/integrations'),
  });

  const connect = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>('/integrations/google-sheets/connect', {
        connectedAccountId: activeAccountId,
      }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not connect Sheets.'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/integrations/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/integrations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations'] }),
  });

  const sheets = integrations.data?.available.google_sheets;
  const connected = integrations.data?.integrations.filter((i) => i.type === 'google_sheets') ?? [];
  const allowed = can('google_sheets');

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-300">
            <Link2 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold tracking-tight">Google Sheets</h3>
              {!allowed ? (
                <Badge tone="brand">
                  <Lock className="size-2.5" />
                  Business
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-text-muted">
              Every captured lead appended to a spreadsheet the moment it lands —
              with the automation that captured it, so attribution survives the
              export.
            </p>

            {connected.length === 0 ? (
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                disabled={!allowed || !sheets?.configured || me.workspace.role !== 'admin'}
                loading={connect.isPending}
                onClick={() => connect.mutate()}
              >
                <Plus className="size-4" />
                Connect Google Sheets
              </Button>
            ) : (
              <div className="mt-3 space-y-2">
                {connected.map((integration) => (
                  <div key={integration.id} className="rounded-lg border border-line p-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={integration.isEnabled ? 'success' : 'neutral'}>
                        {integration.isEnabled ? 'Syncing' : 'Paused'}
                      </Badge>
                      {integration.lastSyncAt ? (
                        <span className="text-[11.5px] text-text-subtle">
                          last synced {timeAgo(integration.lastSyncAt)}
                        </span>
                      ) : null}
                      <Switch
                        className="ml-auto"
                        checked={integration.isEnabled}
                        onCheckedChange={(isEnabled) =>
                          patch.mutate({ id: integration.id, body: { isEnabled } })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => remove.mutate(integration.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <Field className="mt-2.5" label="Spreadsheet" hint="Paste the sheet's URL or its id.">
                      <Input
                        defaultValue={String(integration.config.spreadsheetId ?? '')}
                        placeholder="https://docs.google.com/spreadsheets/d/…"
                        onBlur={(e) =>
                          patch.mutate({
                            id: integration.id,
                            body: { spreadsheetId: e.target.value },
                          })
                        }
                      />
                    </Field>
                    {integration.lastError ? (
                      <p className="mt-2 flex items-center gap-1.5 text-[12px] text-red-500">
                        <AlertTriangle className="size-3.5" />
                        {integration.lastError}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {allowed && sheets && !sheets.configured ? (
              <p className="mt-2 flex items-center gap-1.5 text-[12px] text-text-subtle">
                <RefreshCw className="size-3.5" />
                Set <code className="font-mono">GOOGLE_SHEETS_CLIENT_ID</code> and{' '}
                <code className="font-mono">GOOGLE_SHEETS_CLIENT_SECRET</code> to enable this.
              </p>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
