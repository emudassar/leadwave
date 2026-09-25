/**
 * Growth.
 *
 * The founder's own dashboard, not a workspace's: is anyone signing up, is
 * anyone paying. Admin-only — the API refuses this to anyone else, and the
 * nav item is hidden the same way, but this page checks too so a direct link
 * never flashes real numbers at the wrong person.
 */
import * as React from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CreditCard, TrendingUp, Users2, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, full, usd } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/AppShell';
import { Badge, Card, CardHeader, Skeleton } from '@/components/ui';
import type { AdminAnalytics, Plan } from '@/types';

// ─── Theme ───────────────────────────────────────────────────────────────────

/** Charts draw into an SVG, so they need the resolved hex, not a CSS var —
 *  this tracks the `dark` class the header's own theme toggle sets. */
function useIsDark(): boolean {
  const [isDark, setIsDark] = React.useState(() =>
    document.documentElement.classList.contains('dark'),
  );

  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

// Validated categorical order (blue, orange, aqua, yellow) — fixed, never cycled.
const PLAN_COLOR: Record<Plan, { light: string; dark: string }> = {
  free: { light: '#2a78d6', dark: '#3987e5' },
  pro: { light: '#eb6834', dark: '#d95926' },
  growth: { light: '#1baf7a', dark: '#199e70' },
  business: { light: '#eda100', dark: '#c98500' },
};

const PLAN_LABEL: Record<Plan, string> = {
  free: 'Free',
  pro: 'Pro',
  growth: 'Growth',
  business: 'Business',
};

function planColor(plan: Plan, isDark: boolean): string {
  return isDark ? PLAN_COLOR[plan].dark : PLAN_COLOR[plan].light;
}

// ─── Stat tile ───────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'brand',
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'brand' | 'amber' | 'emerald' | 'sky';
}): React.ReactElement {
  const tones = {
    brand: 'text-brand-600 bg-brand-600/10 dark:text-brand-300',
    amber: 'text-amber-600 bg-amber-500/12 dark:text-amber-300',
    emerald: 'text-emerald-600 bg-emerald-500/12 dark:text-emerald-300',
    sky: 'text-sky-600 bg-sky-500/12 dark:text-sky-300',
  };

  return (
    <Card className="h-full p-4">
      <div className={cn('flex size-8 items-center justify-center rounded-lg', tones[tone])}>
        <Icon className="size-4" />
      </div>
      <p className="stat-figure mt-3 text-[30px] leading-none">{value}</p>
      <p className="mt-1.5 text-[12.5px] font-medium text-text">{label}</p>
      {sub ? <p className="text-[11.5px] text-text-subtle">{sub}</p> : null}
    </Card>
  );
}

// ─── Chart tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  label,
  payload,
  formatter,
}: {
  active?: boolean;
  label?: string;
  payload?: Array<{ name: string; value: number; color: string }>;
  formatter: (value: number) => string;
}): React.ReactElement | null {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-raised px-3 py-2 shadow-[var(--shadow-card)]">
      <p className="text-[11px] font-medium text-text-subtle">
        {label ? new Date(label).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
      </p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-1.5 text-[12.5px] font-medium text-text">
          <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />
          {formatter(entry.value)}
        </p>
      ))}
    </div>
  );
}

function axisTick(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function AdminPage(): React.ReactElement {
  const { auth } = useSession();
  const isDark = useIsDark();

  const analytics = useQuery({
    queryKey: ['admin', 'analytics'],
    queryFn: () => api.get<AdminAnalytics>('/admin/analytics'),
    enabled: auth.user.isAdmin,
  });

  if (!auth.user.isAdmin) return <Navigate to="/home" replace />;

  const data = analytics.data;
  const brand = isDark ? '#78cfc2' : '#157a70';
  const amber = isDark ? '#fbbf24' : '#f59e0b';

  return (
    <PageBody>
      <PageHeader
        title="Growth"
        description="Whether LeadWave itself is gaining users and revenue — signups, MRR, and the plan mix behind it."
      />

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {analytics.isLoading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[126px]" />)
        ) : (
          <>
            <Stat
              label="MRR"
              value={usd(data.overview.mrrUsd)}
              sub={`${usd(data.overview.arrUsd)} ARR`}
              icon={CreditCard}
              tone="brand"
            />
            <Stat
              label="Total users"
              value={full(data.overview.totalUsers)}
              sub={`+${full(data.overview.newUsers7d)} this week`}
              icon={Users2}
              tone="sky"
            />
            <Stat
              label="Paying workspaces"
              value={full(data.overview.activeSubscriptions)}
              sub={`${full(data.overview.trialingSubscriptions)} on trial`}
              icon={Zap}
              tone="emerald"
            />
            <Stat
              label="New signups"
              value={full(data.overview.newUsers30d)}
              sub="last 30 days"
              icon={TrendingUp}
              tone="amber"
            />
          </>
        )}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Signups" description="New accounts created, last 90 days." />
          <div className="h-64 px-2 pb-4">
            {analytics.isLoading || !data ? (
              <Skeleton className="h-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.signups} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="signupsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={brand} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={brand} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke={isDark ? '#22303a' : '#dfe9e7'} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={axisTick}
                    tick={{ fontSize: 11, fill: isDark ? '#74868f' : '#6c7c86' }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: isDark ? '#74868f' : '#6c7c86' }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <Tooltip
                    content={<ChartTooltip formatter={(v) => `${full(v)} signup${v === 1 ? '' : 's'}`} />}
                  />
                  <Area
                    type="monotone"
                    dataKey="users"
                    name="Signups"
                    stroke={brand}
                    strokeWidth={2}
                    fill="url(#signupsFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="MRR" description="Monthly recurring revenue, tracked daily from today." />
          <div className="h-64 px-2 pb-4">
            {analytics.isLoading || !data ? (
              <Skeleton className="h-full" />
            ) : data.mrrHistory.length < 2 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                <p className="text-[26px] font-semibold tabular-nums text-text">
                  {usd(data.overview.mrrUsd)}
                </p>
                <p className="max-w-56 text-[12.5px] text-text-subtle">
                  Trend starts appearing once this has run for a couple of days.
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.mrrHistory} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mrrFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={amber} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={amber} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke={isDark ? '#22303a' : '#dfe9e7'} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={axisTick}
                    tick={{ fontSize: 11, fill: isDark ? '#74868f' : '#6c7c86' }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis
                    tickFormatter={(v: number) => usd(v)}
                    tick={{ fontSize: 11, fill: isDark ? '#74868f' : '#6c7c86' }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <Tooltip content={<ChartTooltip formatter={(v) => usd(v)} />} />
                  <Area
                    type="monotone"
                    dataKey="mrrUsd"
                    name="MRR"
                    stroke={amber}
                    strokeWidth={2}
                    fill="url(#mrrFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader title="Plan mix" description="Paying workspaces by plan, and what each tier is worth." />
          <div className="h-56 px-2 pb-4">
            {analytics.isLoading || !data ? (
              <Skeleton className="h-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.planBreakdown}
                  layout="vertical"
                  margin={{ top: 4, right: 24, left: 8, bottom: 0 }}
                >
                  <CartesianGrid horizontal={false} stroke={isDark ? '#22303a' : '#dfe9e7'} />
                  <XAxis type="number" allowDecimals={false} hide />
                  <YAxis
                    type="category"
                    dataKey="plan"
                    tickFormatter={(v: Plan) => PLAN_LABEL[v]}
                    tick={{ fontSize: 12, fill: isDark ? '#a3b4bd' : '#47555f' }}
                    axisLine={false}
                    tickLine={false}
                    width={64}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0]!.payload as AdminAnalytics['planBreakdown'][number];
                      return (
                        <div className="rounded-lg border border-line bg-surface-raised px-3 py-2 shadow-[var(--shadow-card)]">
                          <p className="text-[12.5px] font-medium text-text">
                            {PLAN_LABEL[row.plan]} · {full(row.workspaces)} workspace
                            {row.workspaces === 1 ? '' : 's'}
                          </p>
                          <p className="text-[11.5px] text-text-subtle">{usd(row.mrrUsd)}/mo</p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="workspaces" radius={[0, 4, 4, 0]} maxBarSize={22}>
                    {data.planBreakdown.map((row) => (
                      <Cell key={row.plan} fill={planColor(row.plan, isDark)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          {data ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line px-5 py-3">
              {data.planBreakdown.map((row) => (
                <span key={row.plan} className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: planColor(row.plan, isDark) }}
                  />
                  {PLAN_LABEL[row.plan]}
                </span>
              ))}
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader title="Recent signups" description="The last 10 accounts created." />
          {analytics.isLoading || !data ? (
            <div className="space-y-2 px-5 pb-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : data.recentSignups.length === 0 ? (
            <p className="px-5 pb-5 text-[13px] text-text-subtle">Nobody has signed up yet.</p>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {data.recentSignups.map((user) => (
                <li key={user.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-text">
                      {user.name ?? user.email}
                    </span>
                    <span className="block truncate text-[11.5px] text-text-subtle">{user.email}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={user.plan === 'free' ? 'neutral' : 'brand'}>{PLAN_LABEL[user.plan]}</Badge>
                    <span className="w-20 text-right text-[11.5px] text-text-subtle">
                      {new Date(user.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </PageBody>
  );
}
