/**
 * Contacts and leads.
 *
 * The export dialog shows the exact row count before you download, because a
 * CSV that turns out to be 12 rows when you expected 400 is a bad afternoon.
 * Opted-out contacts are excluded from every export by the API, and the preview
 * count reflects that — the number you see is the number you get.
 */
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  Mail,
  MessageSquare,
  Phone,
  Search,
  ShieldOff,
  Sparkles,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, downloadUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, compact, full, timeAgo } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/AppShell';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Textarea,
  Tooltip,
} from '@/components/ui';
import type { ContactListItem, ContactNote, ContactStats } from '@/types';

type ExportFormat = 'csv' | 'meta_ads';

export function ContactsPage(): React.ReactElement {
  const { activeAccountId, me, can } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState('');
  const [leadsOnly, setLeadsOnly] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [format, setFormat] = React.useState<ExportFormat>('csv');
  const [noteFor, setNoteFor] = React.useState<ContactListItem | null>(null);
  const [noteDraft, setNoteDraft] = React.useState('');

  const stats = useQuery({
    queryKey: ['contact-stats', activeAccountId],
    queryFn: () => api.get<ContactStats>('/contacts/stats'),
  });

  const contacts = useInfiniteQuery({
    queryKey: ['contacts', activeAccountId, search, leadsOnly],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<{ contacts: ContactListItem[]; nextCursor: string | null }>('/contacts', {
        connectedAccountId: activeAccountId,
        search: search.trim() || undefined,
        hasLead: leadsOnly || undefined,
        limit: 40,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(activeAccountId),
  });

  const exportCounts = useQuery({
    queryKey: ['export-counts', activeAccountId],
    queryFn: () =>
      api.get<{ all: number; emails: number; phones: number }>('/contacts/export/counts', {
        connectedAccountId: activeAccountId,
      }),
    enabled: Boolean(activeAccountId) && exportOpen,
  });

  const notes = useQuery({
    queryKey: ['contact-notes', noteFor?.id],
    queryFn: () => api.get<{ notes: ContactNote[] }>(`/contacts/${noteFor!.id}/notes`),
    enabled: Boolean(noteFor),
  });

  const addNote = useMutation({
    mutationFn: () => api.post(`/contacts/${noteFor!.id}/notes`, { body: noteDraft.trim() }),
    onSuccess: async () => {
      setNoteDraft('');
      await queryClient.invalidateQueries({ queryKey: ['contact-notes', noteFor?.id] });
    },
  });

  const rows = contacts.data?.pages.flatMap((page) => page.contacts) ?? [];
  const metaAdsAllowed = can('meta_ads_export');

  return (
    <PageBody>
      <PageHeader
        title="Contacts"
        description="Everyone who has messaged your Page, and what each automation captured from them."
        actions={
          <Button
            variant="secondary"
            disabled={!activeAccountId}
            onClick={() => setExportOpen(true)}
          >
            <Download className="size-4" />
            Export leads
          </Button>
        }
      />

      {/* ─── Numbers ─────────────────────────────────────────────────────── */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats.isLoading || !stats.data
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[84px]" />)
          : (
              [
                { label: 'Contacts', value: stats.data.contacts, icon: Users, tone: 'brand' },
                { label: 'New this week', value: stats.data.newThisWeek, icon: UserPlus, tone: 'sky' },
                { label: 'Emails', value: stats.data.emailLeads, icon: Mail, tone: 'emerald' },
                { label: 'Phone numbers', value: stats.data.phoneLeads, icon: Phone, tone: 'teal' },
                { label: 'Opted out', value: stats.data.optedOut, icon: ShieldOff, tone: 'slate' },
              ] as const
            ).map((stat) => (
              <Card key={stat.label} className="p-3.5">
                <div className="flex items-center gap-2">
                  <stat.icon className="size-3.5 text-text-subtle" />
                  <p className="text-[11.5px] font-medium text-text-muted">{stat.label}</p>
                </div>
                <p className="stat-figure mt-1.5 text-[24px] leading-none">{compact(stat.value)}</p>
              </Card>
            ))}
      </div>

      {/* ─── Filters ─────────────────────────────────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search names, emails and numbers…"
            className="pl-8.5"
          />
        </div>
        <Button
          variant={leadsOnly ? 'primary' : 'secondary'}
          size="md"
          onClick={() => setLeadsOnly((v) => !v)}
        >
          <Mail className="size-4" />
          Only with a lead
        </Button>
      </div>

      {/* ─── Table ───────────────────────────────────────────────────────── */}
      <Card className="mt-4 overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b border-line bg-surface-sunken/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle md:grid">
          <span>Contact</span>
          <span>Captured</span>
          <span>Last message</span>
          <span>Status</span>
          <span className="w-16" />
        </div>

        {contacts.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Users className="size-5" />}
              title={search ? 'Nobody matches that' : 'No contacts yet'}
              description={
                search
                  ? 'Try part of a name, an email, or a phone number.'
                  : 'The moment someone comments or messages your Page, they show up here — with whatever the automation captured.'
              }
              className="border-0"
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((contact) => (
              <li
                key={contact.id}
                className="grid grid-cols-1 gap-2 px-4 py-2.5 transition-colors hover:bg-surface-sunken md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center md:gap-3"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar
                    src={contact.avatarUrl}
                    name={contact.name}
                    size={32}
                    ring={contact.page.color}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium">{contact.name}</p>
                    <p className="truncate text-[11px] text-text-subtle">
                      {contact.page.pageName} · first seen {timeAgo(contact.firstSeenAt)}
                    </p>
                  </div>
                </div>

                <div className="min-w-0">
                  {contact.leads.length === 0 ? (
                    <span className="text-[12px] text-text-subtle">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {contact.leads.map((lead) => (
                        <button
                          key={lead.value}
                          onClick={() => {
                            void navigator.clipboard.writeText(lead.value);
                            toast.success('Copied to your clipboard.');
                          }}
                          className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-text-muted transition-colors hover:text-text"
                        >
                          {lead.type === 'email' ? (
                            <Mail className="size-3 shrink-0 text-emerald-500" />
                          ) : (
                            <Phone className="size-3 shrink-0 text-teal-500" />
                          )}
                          <span className="truncate">{lead.value}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <span className="text-[12px] text-text-muted">
                  {contact.lastInboundAt ? timeAgo(contact.lastInboundAt) : '—'}
                </span>

                <div className="flex flex-wrap gap-1">
                  {contact.windowOpen ? (
                    <Tooltip content="You can still reply freely — their 24-hour window is open.">
                      <span>
                        <Badge tone="success">Reachable</Badge>
                      </span>
                    </Tooltip>
                  ) : null}
                  {contact.followConfirmed ? (
                    <Tooltip content="They tapped a Follow Gate unlock button. Self-confirmed, not verified by Facebook.">
                      <span>
                        <Badge tone="brand">Follow</Badge>
                      </span>
                    </Tooltip>
                  ) : null}
                  {contact.optedOut ? <Badge tone="danger">Opted out</Badge> : null}
                </div>

                <div className="flex items-center gap-1 justify-self-end">
                  <Tooltip content="Notes">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setNoteFor(contact);
                        setNoteDraft('');
                      }}
                    >
                      <StickyNote className="size-4" />
                    </Button>
                  </Tooltip>
                  {contact.conversationId ? (
                    <Tooltip content="Open the conversation">
                      <Button variant="ghost" size="icon" asChild>
                        <Link to={`/inbox/${contact.conversationId}`}>
                          <MessageSquare className="size-4" />
                        </Link>
                      </Button>
                    </Tooltip>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {contacts.hasNextPage ? (
          <div className="border-t border-line p-3 text-center">
            <Button
              variant="ghost"
              size="sm"
              loading={contacts.isFetchingNextPage}
              onClick={() => contacts.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>

      {/* ─── Export ──────────────────────────────────────────────────────── */}
      <Dialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        title="Export your leads"
        description="Opted-out contacts are never included — the count below is what actually downloads."
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={format === 'meta_ads' && !metaAdsAllowed}
              onClick={() => {
                window.location.href = downloadUrl('/contacts/export', {
                  connectedAccountId: activeAccountId,
                  format,
                });
                setExportOpen(false);
              }}
            >
              <Download className="size-4" />
              Download
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { label: 'All leads', value: exportCounts.data?.all },
                { label: 'Emails', value: exportCounts.data?.emails },
                { label: 'Phone numbers', value: exportCounts.data?.phones },
              ] as const
            ).map((item) => (
              <div key={item.label} className="rounded-lg border border-line p-3 text-center">
                <p className="stat-figure text-[22px] leading-none">
                  {item.value === undefined ? '—' : full(item.value)}
                </p>
                <p className="mt-1 text-[11.5px] text-text-subtle">{item.label}</p>
              </div>
            ))}
          </div>

          <Select
            value={format}
            onValueChange={setFormat}
            options={[
              {
                value: 'csv',
                label: 'CSV',
                description: 'Name, value, source automation, date captured.',
              },
              {
                value: 'meta_ads',
                label: metaAdsAllowed
                  ? 'Meta Ads custom audience'
                  : 'Meta Ads custom audience (Business plan)',
                description: 'Hashed and formatted for a Custom Audience upload.',
              },
            ]}
          />

          {format === 'meta_ads' && !metaAdsAllowed ? (
            <p className="rounded-lg border border-brand-600/25 bg-brand-600/8 p-3 text-[12.5px] leading-relaxed text-text-muted">
              The Meta Ads export is part of the Business plan. The plain CSV works
              on every plan and imports into Ads Manager fine — it just isn't
              pre-hashed for you.
              <Button
                variant="ghost"
                size="sm"
                className="mt-1.5"
                onClick={() => navigate('/settings/billing')}
              >
                <Sparkles className="size-3.5" />
                See Business
              </Button>
            </p>
          ) : null}
        </div>
      </Dialog>

      {/* ─── Notes ───────────────────────────────────────────────────────── */}
      <Dialog
        open={Boolean(noteFor)}
        onOpenChange={(open) => !open && setNoteFor(null)}
        title={noteFor ? `Notes on ${noteFor.name}` : 'Notes'}
        description="Only your team sees these."
      >
        <div className="space-y-3">
          <Textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={3}
            placeholder="Asked about bulk pricing — worth a call."
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!noteDraft.trim()}
            loading={addNote.isPending}
            onClick={() => addNote.mutate()}
          >
            Add note
          </Button>

          <div className="space-y-2 border-t border-line pt-3">
            {notes.isLoading ? (
              <Skeleton className="h-16" />
            ) : notes.data?.notes.length ? (
              notes.data.notes.map((note) => (
                <div key={note.id} className="rounded-lg border border-line p-2.5">
                  <p className="text-[13px] leading-relaxed">{note.body}</p>
                  <p className="mt-1 text-[11px] text-text-subtle">
                    {note.author?.name ?? 'Someone'} · {timeAgo(note.createdAt)}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-center text-[12.5px] text-text-subtle">No notes yet.</p>
            )}
          </div>
        </div>
      </Dialog>

      <p className="mt-4 text-center text-[11.5px] text-text-subtle">
        {me.plan.limits.contacts === null
          ? 'Your plan has no contact limit.'
          : `${full(me.usage.contacts)} of ${full(me.plan.limits.contacts)} contacts used on the ${me.plan.name} plan.`}
      </p>
    </PageBody>
  );
}
