/**
 * Link-in-bio: the list of pages, and the numbers for each.
 *
 * The same click tracking as the DM buttons, which is the whole argument for
 * having it here rather than paying for a separate tool: one place where a tap
 * is a tap, whether it happened in a message or on your bio page.
 */
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Link2,
  MousePointerClick,
  Plus,
  Sparkles,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, compact, full, percentValue, timeAgo } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/AppShell';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Tooltip,
} from '@/components/ui';
import type { BioAnalytics, BioPageSummaryItem } from '@/types';

export function BioPage(): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { me } = useSession();

  const [open, setOpen] = React.useState(false);
  const [handle, setHandle] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');

  const pages = useQuery({
    queryKey: ['bio-pages'],
    queryFn: () => api.get<{ pages: BioPageSummaryItem[]; maxPages: number }>('/bio/pages/me'),
  });

  const availability = useQuery({
    queryKey: ['bio-handle', handle],
    queryFn: () =>
      api.get<{ available: boolean }>('/bio/pages/handle-available', { handle: handle.trim() }),
    enabled: handle.trim().length >= 2,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/bio/pages', {
        handle: handle.trim().toLowerCase(),
        displayName: displayName.trim() || handle.trim(),
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['bio-pages'] });
      setOpen(false);
      navigate(`/bio/${data.id}/design`);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not create that page.'),
  });

  const list = pages.data?.pages ?? [];
  const maxPages = pages.data?.maxPages ?? 1;
  const atLimit = list.length >= maxPages;

  return (
    <PageBody>
      <PageHeader
        title="Link in bio"
        description="One link for your Facebook and Instagram bio, with the same per-link click tracking you get on your DM buttons."
        actions={
          <Tooltip
            content={atLimit ? `The ${me.plan.name} plan includes ${maxPages} bio page${maxPages === 1 ? '' : 's'}.` : null}
          >
            <span>
              <Button variant="primary" disabled={atLimit} onClick={() => setOpen(true)}>
                <Plus className="size-4" />
                New page
              </Button>
            </span>
          </Tooltip>
        }
      />

      <div className="mt-6 space-y-4">
        {pages.isLoading ? (
          <Skeleton className="h-52" />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Link2 className="size-5" />}
            title="No bio page yet"
            description="Pick a handle and you have a live page in about thirty seconds — links, an email capture box, and click counts on every one."
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                Create your page
              </Button>
            }
          />
        ) : (
          list.map((page) => <BioPageCard key={page.id} page={page} />)
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Create a bio page"
        description="The handle is the address people will see. You can change everything else later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={handle.trim().length < 2 || availability.data?.available === false}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create it
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <Field
            label="Handle"
            hint="Letters, numbers and dashes."
            error={
              availability.data && !availability.data.available
                ? 'That handle is taken.'
                : null
            }
          >
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 font-mono text-[13px] text-text-subtle">/u/</span>
              <Input
                value={handle}
                maxLength={32}
                onChange={(e) => setHandle(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase())}
                placeholder="yourbrand"
              />
              {handle.trim().length >= 2 && availability.data?.available ? (
                <Check className="size-4 shrink-0 text-emerald-500" />
              ) : null}
            </div>
          </Field>
          <Field label="Display name">
            <Input
              value={displayName}
              maxLength={60}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your brand"
            />
          </Field>
        </div>
      </Dialog>
    </PageBody>
  );
}

function BioPageCard({ page }: { page: BioPageSummaryItem }): React.ReactElement {
  const summary = useQuery({
    queryKey: ['bio-summary', page.id],
    queryFn: () => api.get<BioAnalytics>(`/bio/pages/${page.id}/summary`),
  });

  const copyUrl = () => {
    void navigator.clipboard.writeText(page.url);
    toast.success('Link copied.');
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold tracking-tight">
              {page.displayName}
            </h3>
            <Badge tone={page.isPublished ? 'success' : 'neutral'}>
              {page.isPublished ? 'Live' : 'Unpublished'}
            </Badge>
          </div>
          <button
            onClick={copyUrl}
            className="mt-1 inline-flex items-center gap-1.5 font-mono text-[12px] text-text-muted transition-colors hover:text-text"
          >
            {page.url}
            <Copy className="size-3" />
          </button>
          <p className="mt-1 text-[11.5px] text-text-subtle">
            {page.blockCount} block{page.blockCount === 1 ? '' : 's'} · edited{' '}
            {timeAgo(page.updatedAt)}
          </p>
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" size="sm" asChild>
            <a href={page.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              View
            </a>
          </Button>
          <Button variant="primary" size="sm" asChild>
            <Link to={`/bio/${page.id}/design`}>Edit page</Link>
          </Button>
        </div>
      </div>

      {summary.isLoading ? (
        <Skeleton className="m-4 mt-0 h-24" />
      ) : summary.data ? (
        <>
          <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-5">
            {(
              [
                { label: 'Views', value: compact(summary.data.views), icon: Eye },
                { label: 'Views (30d)', value: compact(summary.data.recentViews), icon: BarChart3 },
                { label: 'Clicks', value: compact(summary.data.totalClicks), icon: MousePointerClick },
                { label: 'Click rate', value: percentValue(summary.data.ctr), icon: Sparkles },
                { label: 'Emails', value: compact(summary.data.leads), icon: Users },
              ] as const
            ).map((stat) => (
              <div key={stat.label} className="bg-surface-raised px-4 py-3">
                <div className="flex items-center gap-1.5 text-text-subtle">
                  <stat.icon className="size-3" />
                  <p className="text-[11px]">{stat.label}</p>
                </div>
                <p className="stat-figure mt-1 text-[22px] leading-none">{stat.value}</p>
              </div>
            ))}
          </div>

          {summary.data.links.length ? (
            <div className="border-t border-line p-4">
              <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                Which link people actually tap
              </p>
              <ul className="space-y-2">
                {summary.data.links.slice(0, 5).map((link) => (
                  <li key={link.id}>
                    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate">{link.title}</span>
                      <span className="shrink-0 font-mono tabular-nums text-text-muted">
                        {full(link.clicks)}
                        <span className="text-text-subtle">
                          {' '}
                          · {full(link.uniqueClicks)} people
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                      <div
                        className={cn('h-full rounded-full bg-brand-600')}
                        style={{ width: `${Math.max(link.shareOfClicks * 100, 2)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
