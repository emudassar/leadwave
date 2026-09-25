/**
 * The frame every screen sits in: a rail on the left, a Page switcher and the
 * plan meter on top.
 *
 * Two things live in the header on purpose. The Page switcher, because the
 * whole app is scoped to one Page and hiding that in Settings makes an agency
 * with ten clients miserable. And the credit / message meter, because running
 * out mid-campaign with no warning is the single worst experience this product
 * can give someone.
 */
import * as React from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  BarChart3,
  Bot,
  ChevronDown,
  Home,
  Inbox,
  Link2,
  LogOut,
  Menu,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Sun,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, compact, full, initials, limitLabel } from '@/lib/utils';
import { Avatar, Badge, Button, Meter, Tooltip } from '@/components/ui';

const NAV = [
  { to: '/home', label: 'Home', icon: Home },
  { to: '/automations', label: 'Automations', icon: Workflow },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/ai', label: 'LeadWave AI', icon: Bot, ai: true },
  { to: '/bio', label: 'Link in bio', icon: Link2 },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

// ─── Theme ───────────────────────────────────────────────────────────────────

function useTheme(): [string, () => void] {
  const [theme, setTheme] = React.useState<string>(() => {
    try {
      return window.localStorage.getItem('leadwave.theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      window.localStorage.setItem('leadwave.theme', theme);
    } catch {
      // Nothing to do; the class is already applied for this session.
    }
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

// ─── Page switcher ───────────────────────────────────────────────────────────

function PageSwitcher(): React.ReactElement {
  const { accounts, activeAccount, setActiveAccountId, me } = useSession();
  const navigate = useNavigate();
  const limit = me.plan.limits.connectedPages;
  const atLimit = limit !== null && accounts.length >= limit;

  if (!activeAccount) {
    return (
      <Button size="sm" variant="primary" onClick={() => navigate('/settings/pages')}>
        <Plus className="size-4" />
        Connect a Page
      </Button>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex items-center gap-2 rounded-lg border border-line bg-surface-raised py-1.5 pl-1.5 pr-2.5 text-left transition-colors hover:border-line-strong">
          <Avatar
            src={activeAccount.pagePictureUrl}
            name={activeAccount.pageName}
            size={26}
            ring={activeAccount.color}
          />
          <span className="hidden min-w-0 sm:block">
            <span className="block max-w-36 truncate text-[13px] font-medium leading-tight">
              {activeAccount.pageName}
            </span>
            <span className="block text-[10.5px] leading-tight text-text-subtle">
              {activeAccount.status === 'active' ? 'Connected' : 'Needs reconnect'}
            </span>
          </span>
          <ChevronDown className="size-3.5 text-text-subtle" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-xl border border-line bg-surface-raised p-1.5 shadow-[var(--shadow-lift)]"
        >
          <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            Your Pages · {accounts.length} of {limitLabel(limit)}
          </p>
          {accounts.map((account) => (
            <DropdownMenu.Item
              key={account.id}
              onSelect={() => setActiveAccountId(account.id)}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 outline-none',
                'data-[highlighted]:bg-surface-sunken',
                account.id === activeAccount.id && 'bg-brand-600/8',
              )}
            >
              <Avatar
                src={account.pagePictureUrl}
                name={account.pageName}
                size={30}
                ring={account.color}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{account.pageName}</span>
                <span className="block truncate text-[11px] text-text-subtle">
                  @{account.pageUsername ?? account.pageId}
                </span>
              </span>
              {account.status !== 'active' ? (
                <Tooltip content={account.statusDetail ?? 'Reconnect this Page'}>
                  <AlertTriangle className="size-4 text-amber-accent" />
                </Tooltip>
              ) : null}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1.5 h-px bg-line" />
          <DropdownMenu.Item
            onSelect={() => navigate('/settings/pages')}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-sunken"
          >
            <Plus className="size-4 text-text-subtle" />
            {atLimit ? 'Add a Page — needs a bigger plan' : 'Connect another Page'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ─── Usage meter ─────────────────────────────────────────────────────────────

function UsageMeter(): React.ReactElement | null {
  const { me } = useSession();
  const navigate = useNavigate();
  const messageLimit = me.plan.limits.messagesPerMonth;
  const showMessages = messageLimit !== null;
  const showCredits = me.credits.hasAi;

  if (!showMessages && !showCredits) return null;

  const used = showMessages ? me.usage.messagesSent : me.credits.used;
  const cap = showMessages ? messageLimit : me.credits.included + me.credits.bonus;
  const label = showMessages ? 'messages' : 'AI credits';
  const remaining = Math.max(0, cap - used);
  const tight = cap > 0 && remaining / cap <= 0.15;

  return (
    <Tooltip
      content={
        <span>
          {full(used)} of {full(cap)} {label} used this cycle. Resets{' '}
          {new Date(me.usage.periodEnd).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}
          .
        </span>
      }
    >
      <button
        onClick={() => navigate('/settings/billing')}
        className="hidden w-40 flex-col gap-1 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-sunken lg:flex"
      >
        <span className="flex items-baseline justify-between text-[11px]">
          <span className="font-medium text-text-muted">{label}</span>
          <span className={cn('font-mono tabular-nums', tight ? 'text-amber-accent' : 'text-text-subtle')}>
            {compact(remaining)} left
          </span>
        </span>
        <Meter value={used} max={cap} />
      </button>
    </Tooltip>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const { auth, me } = useSession();
  const [theme, toggleTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  React.useEffect(() => setMobileOpen(false), [location.pathname]);

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => {});
    window.location.href = '/login';
  };

  const upgradeable = me.workspace.plan !== 'business';

  return (
    <div className="flex min-h-dvh bg-surface">
      {/* ─── Rail ─────────────────────────────────────────────────────────── */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-line bg-surface-raised transition-transform lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2 px-4">
          <div className="brand-gradient flex size-7 items-center justify-center rounded-lg">
            <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
              <path
                d="M6 20c3-5 5-5 8 0s5 5 8 0"
                stroke="#fff"
                strokeWidth="2.8"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </div>
          <span className="display text-[19px]">LeadWave</span>
          <button
            className="ml-auto lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X className="size-5 text-text-muted" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 px-2.5 py-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors',
                  isActive
                    ? 'bg-brand-600/10 text-brand-600 dark:text-brand-300'
                    : 'text-text-muted hover:bg-surface-sunken hover:text-text',
                )
              }
            >
              <item.icon className="size-4.5" />
              {item.label}
              {'ai' in item && item.ai && !me.plan.hasAi ? (
                <Badge tone="ai" className="ml-auto">
                  New
                </Badge>
              ) : null}
            </NavLink>
          ))}
          {auth.user.isAdmin ? (
            <NavLink
              to="/growth"
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors',
                  isActive
                    ? 'bg-brand-600/10 text-brand-600 dark:text-brand-300'
                    : 'text-text-muted hover:bg-surface-sunken hover:text-text',
                )
              }
            >
              <BarChart3 className="size-4.5" />
              Growth
            </NavLink>
          ) : null}
        </nav>

        {upgradeable ? (
          <div className="m-2.5 rounded-xl border border-brand-600/25 bg-linear-to-br from-brand-600/12 to-cyan-500/10 p-3.5">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Sparkles className="size-4 text-amber-accent" />
              You're on {me.plan.name}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {me.plan.hasAi
                ? 'Add team seats, Google Sheets and 10 Pages on Business.'
                : 'Let LeadWave AI answer the questions you keep answering yourself.'}
            </p>
            <Button
              variant="primary"
              size="sm"
              className="mt-2.5 w-full"
              onClick={() => navigate('/settings/billing')}
            >
              See plans
            </Button>
          </div>
        ) : null}

        <div className="border-t border-line p-2.5">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-surface-sunken">
                <Avatar src={auth.user.avatarUrl} name={auth.user.name ?? auth.user.email} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {auth.user.name ?? initials(auth.user.email)}
                  </span>
                  <span className="block truncate text-[11px] text-text-subtle">
                    {me.workspace.name}
                  </span>
                </span>
                <ChevronDown className="size-3.5 text-text-subtle" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                side="top"
                sideOffset={6}
                className="z-50 w-56 rounded-xl border border-line bg-surface-raised p-1.5 shadow-[var(--shadow-lift)]"
              >
                <div className="px-2.5 py-2">
                  <p className="truncate text-[13px] font-medium">{auth.user.email}</p>
                  <p className="text-[11px] capitalize text-text-subtle">
                    {me.workspace.role} · {me.plan.name} plan
                  </p>
                </div>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  onSelect={toggleTheme}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-sunken"
                >
                  {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  {theme === 'dark' ? 'Light theme' : 'Dark theme'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => navigate('/settings')}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-sunken"
                >
                  <Settings className="size-4" />
                  Workspace settings
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={signOut}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-red-600 outline-none data-[highlighted]:bg-red-500/10 dark:text-red-400"
                >
                  <LogOut className="size-4" />
                  Sign out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </aside>

      {mobileOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      {/* ─── Main ─────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md">
          <button className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5 text-text-muted" />
          </button>
          <PageSwitcher />
          <div className="ml-auto flex items-center gap-2">
            <UsageMeter />
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
            </Button>
            <Button variant="primary" size="sm" onClick={() => navigate('/automations/new')}>
              <Plus className="size-4" />
              <span className="hidden sm:inline">New automation</span>
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

/** Standard page chrome — title, subtitle, actions — so screens line up. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="display text-[clamp(1.6rem,3.2vw,2.1rem)]">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8', className)}>
      {children}
    </div>
  );
}
