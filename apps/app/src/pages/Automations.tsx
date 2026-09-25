/**
 * The automations list.
 *
 * Every row carries the three numbers that decide whether an automation is
 * worth keeping — how often it fired, how many different people clicked, and
 * the rate between them. Clicks alone flatter you: one enthusiastic person
 * tapping six times is not six customers, which is why unique clickers is the
 * number given the most visual weight.
 */
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Copy,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  Workflow,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, compact, percent, timeAgo } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/AppShell';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@/components/ui';
import { STATUS_META, TRIGGER_META } from '@/lib/automation-meta';
import type { AutomationListItem, AutomationStatus } from '@/types';

type Filter = 'all' | AutomationStatus;

export function AutomationsPage(): React.ReactElement {
  const { activeAccountId, me } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [filter, setFilter] = React.useState<Filter>('all');
  const [search, setSearch] = React.useState('');
  const [pendingDelete, setPendingDelete] = React.useState<AutomationListItem | null>(null);

  const list = useQuery({
    queryKey: ['automations', activeAccountId],
    queryFn: () =>
      api.get<{ automations: AutomationListItem[] }>('/automations', {
        connectedAccountId: activeAccountId,
      }),
    enabled: Boolean(activeAccountId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['automations', activeAccountId] });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'publish' | 'pause' | 'duplicate' }) =>
      api.post<{ id: string }>(`/automations/${id}/${action}`),
    onSuccess: async (_data, variables) => {
      await invalidate();
      toast.success(
        variables.action === 'publish'
          ? 'Live — it starts working on the next comment.'
          : variables.action === 'pause'
            ? 'Paused. Runs already waiting will still finish.'
            : 'Duplicated as a draft.',
      );
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'That did not work.');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/automations/${id}`),
    onSuccess: async () => {
      await invalidate();
      setPendingDelete(null);
      toast.success('Deleted.');
    },
  });

  const automations = list.data?.automations ?? [];

  const counts = React.useMemo(
    () => ({
      all: automations.length,
      live: automations.filter((a) => a.status === 'live').length,
      paused: automations.filter((a) => a.status === 'paused').length,
      draft: automations.filter((a) => a.status === 'draft').length,
    }),
    [automations],
  );

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return automations.filter((automation) => {
      if (filter !== 'all' && automation.status !== filter) return false;
      if (!term) return true;
      return (
        automation.name.toLowerCase().includes(term) ||
        automation.keywords.some((keyword) => keyword.toLowerCase().includes(term))
      );
    });
  }, [automations, filter, search]);

  const limit = me.plan.limits.automations;
  const atLimit = limit !== null && automations.length >= limit;

  return (
    <PageBody>
      <PageHeader
        title="Automations"
        description="Each one is a trigger and the messages that follow it. Publish, and it runs whether you are online or not."
        actions={
          <Tooltip
            content={
              atLimit
                ? `The ${me.plan.name} plan allows ${limit} automations. Upgrade for unlimited.`
                : null
            }
          >
            <span>
              <Button
                variant="primary"
                disabled={atLimit || !activeAccountId}
                onClick={() => navigate('/automations/new')}
              >
                <Plus className="size-4" />
                New automation
              </Button>
            </span>
          </Tooltip>
        }
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList className="border-b-0">
            {(['all', 'live', 'paused', 'draft'] as const).map((value) => (
              <TabsTrigger key={value} value={value} className="capitalize">
                {value}
                <span className="ml-1.5 font-mono text-[11px] text-text-subtle">
                  {counts[value]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search names and keywords…"
            className="pl-8.5"
          />
        </div>
      </div>

      <div className="mt-4">
        {list.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[74px]" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Workflow className="size-5" />}
            title={
              automations.length === 0 ? 'No automations yet' : 'Nothing matches that filter'
            }
            description={
              automations.length === 0
                ? 'Start with a comment automation — someone types your keyword under a post and the link lands in their inbox seconds later.'
                : 'Try a different status or clear the search.'
            }
            action={
              automations.length === 0 ? (
                <Button variant="primary" onClick={() => navigate('/automations/new')}>
                  <Zap className="size-4" />
                  Build the first one
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFilter('all');
                    setSearch('');
                  }}
                >
                  Clear filters
                </Button>
              )
            }
          />
        ) : (
          <ul className="space-y-2">
            {visible.map((automation) => {
              const meta = TRIGGER_META[automation.triggerType];
              const status = STATUS_META[automation.status];
              const ctr =
                automation.runCount > 0
                  ? Math.min(automation.uniqueClicks / automation.runCount, 1)
                  : 0;

              return (
                <li key={automation.id}>
                  <Card className="flex items-center gap-3 p-3.5 transition-colors hover:border-line-strong">
                    <Link
                      to={`/automations/${automation.id}`}
                      className="flex min-w-0 flex-1 items-center gap-3"
                    >
                      <span
                        className={cn(
                          'flex size-10 shrink-0 items-center justify-center rounded-lg',
                          meta.tint,
                        )}
                      >
                        <meta.icon className="size-5" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-semibold">
                            {automation.name}
                          </span>
                          <Badge tone={status.tone}>
                            {automation.status === 'live' ? (
                              <span className="size-1.5 rounded-full bg-emerald-500" />
                            ) : null}
                            {status.label}
                          </Badge>
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-subtle">
                          <span>{meta.short}</span>
                          {automation.keywords.length > 0 ? (
                            <>
                              <span>·</span>
                              <span className="flex flex-wrap gap-1">
                                {automation.keywords.slice(0, 3).map((keyword) => (
                                  <code
                                    key={keyword}
                                    className="rounded bg-surface-sunken px-1 py-px font-mono text-[10.5px] text-text-muted"
                                  >
                                    {keyword}
                                  </code>
                                ))}
                                {automation.keywords.length > 3 ? (
                                  <span>+{automation.keywords.length - 3}</span>
                                ) : null}
                              </span>
                            </>
                          ) : null}
                          <span>·</span>
                          <span>
                            {automation.lastTriggeredAt
                              ? `fired ${timeAgo(automation.lastTriggeredAt)}`
                              : `edited ${timeAgo(automation.updatedAt)}`}
                          </span>
                        </span>
                      </span>
                    </Link>

                    <div className="hidden shrink-0 items-center gap-6 pr-2 text-right md:flex">
                      <Tooltip content="How many times this automation started a run.">
                        <div>
                          <p className="font-mono text-[14px] tabular-nums">
                            {compact(automation.runCount)}
                          </p>
                          <p className="text-[10.5px] text-text-subtle">triggers</p>
                        </div>
                      </Tooltip>
                      <Tooltip content="Different people who tapped a link. The same person twice counts once.">
                        <div>
                          <p className="font-mono text-[14px] tabular-nums">
                            {compact(automation.uniqueClicks)}
                          </p>
                          <p className="text-[10.5px] text-text-subtle">clickers</p>
                        </div>
                      </Tooltip>
                      <Tooltip content="Unique clickers divided by triggers.">
                        <div className="w-12">
                          <p
                            className={cn(
                              'font-mono text-[14px] tabular-nums',
                              ctr >= 0.3 ? 'text-emerald-500' : undefined,
                            )}
                          >
                            {automation.runCount > 0 ? percent(ctr) : '—'}
                          </p>
                          <p className="text-[10.5px] text-text-subtle">CTR</p>
                        </div>
                      </Tooltip>
                    </div>

                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <Button variant="ghost" size="icon" aria-label="More">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          sideOffset={6}
                          className="z-50 w-52 rounded-xl border border-line bg-surface-raised p-1.5 shadow-[var(--shadow-lift)]"
                        >
                          {automation.status === 'live' ? (
                            <DropdownMenu.Item
                              onSelect={() => act.mutate({ id: automation.id, action: 'pause' })}
                              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-sunken"
                            >
                              <Pause className="size-4 text-text-subtle" />
                              Pause
                            </DropdownMenu.Item>
                          ) : (
                            <DropdownMenu.Item
                              onSelect={() => act.mutate({ id: automation.id, action: 'publish' })}
                              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-sunken"
                            >
                              <Play className="size-4 text-emerald-500" />
                              Publish
                            </DropdownMenu.Item>
                          )}
                          <DropdownMenu.Item
                            onSelect={() => act.mutate({ id: automation.id, action: 'duplicate' })}
                            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-sunken"
                          >
                            <Copy className="size-4 text-text-subtle" />
                            Duplicate
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="my-1 h-px bg-line" />
                          <DropdownMenu.Item
                            onSelect={() => setPendingDelete(automation)}
                            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-red-600 outline-none data-[highlighted]:bg-red-500/10 dark:text-red-400"
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this automation?"
        description={
          <>
            <strong className="text-text">{pendingDelete?.name}</strong> and its click
            history go with it. Contacts and leads it already captured stay where they
            are.
          </>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
            >
              Delete it
            </Button>
          </>
        }
      />
    </PageBody>
  );
}
