/**
 * The unified inbox.
 *
 * Three columns: threads, the conversation, and the context you need before you
 * type — which Page, how long the window is open, what the automations already
 * said, what was captured.
 *
 * The 24-hour window countdown sits above the composer rather than in a tooltip
 * because it is the difference between a message that sends and a message that
 * silently doesn't. When it has closed, the composer says so and explains the
 * one thing that can still be done, instead of failing after you hit send.
 */
import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Archive,
  BellOff,
  Bot,
  CalendarClock,
  Check,
  ChevronLeft,
  Clock,
  Inbox as InboxIcon,
  Mail,
  MoreHorizontal,
  Phone,
  Pin,
  Search,
  Send,
  Sparkles,
  Tag,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, clockTime, dayLabel, timeAgo, truncate, windowCountdown } from '@/lib/utils';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@/components/ui';
import type {
  ConversationContext,
  ConversationListItem,
  InboxMessage,
  LabelChip,
  SavedReply,
} from '@/types';

type Filter = 'all' | 'unread' | 'ai' | 'archived';

// ─── Message bubble ──────────────────────────────────────────────────────────

const SOURCE_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> } | undefined
> = {
  automation: { label: 'Automation', icon: Zap },
  ai: { label: 'LeadWave AI', icon: Sparkles },
  follow_up: { label: 'Follow-up nudge', icon: Clock },
  scheduled: { label: 'Scheduled', icon: CalendarClock },
  retrigger: { label: 'Retrigger', icon: Zap },
};

function MessageRow({ message }: { message: InboxMessage }): React.ReactElement {
  const outbound = message.direction === 'outbound';
  const meta = SOURCE_META[message.source];
  const failed = message.status === 'failed' || message.status === 'held';

  return (
    <div className={cn('flex flex-col gap-1', outbound ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[75%] whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2 text-[14px] leading-[1.4]',
          outbound
            ? message.isAiGenerated
              ? 'bg-linear-to-br from-brand-500 to-cyan-600 text-white'
              : 'messenger-gradient text-white'
            : 'bg-surface-sunken text-text',
          failed && 'opacity-60 ring-1 ring-red-500/40',
        )}
      >
        {message.text}
      </div>

      {message.payload?.buttons?.length ? (
        <div className={cn('flex max-w-[75%] flex-wrap gap-1.5', outbound && 'justify-end')}>
          {message.payload.buttons.map((button, i) => (
            <span
              key={i}
              className="rounded-full border border-messenger/50 px-2.5 py-0.5 text-[11.5px] font-medium text-messenger"
            >
              {button.title}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 px-1 text-[10.5px] text-text-subtle">
        {meta ? (
          <span className="flex items-center gap-1">
            <meta.icon className="size-3" />
            {meta.label}
            {message.automation ? ` · ${truncate(message.automation.name, 28)}` : ''}
          </span>
        ) : null}
        {message.sender?.name ? <span>{message.sender.name}</span> : null}
        {message.status === 'scheduled' && message.scheduledFor ? (
          <span className="text-amber-accent">
            sends {new Date(message.scheduledFor).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        ) : (
          <span>{clockTime(message.createdAt)}</span>
        )}
        {failed ? (
          <Tooltip content={message.failureReason ?? 'Not delivered'}>
            <span className="text-red-500">not delivered</span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

// ─── Thread list row ─────────────────────────────────────────────────────────

function ThreadRow({
  conversation,
  active,
  onSelect,
}: {
  conversation: ConversationListItem;
  active: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors',
        active
          ? 'border-brand-600 bg-brand-600/8'
          : 'border-transparent hover:bg-surface-sunken',
      )}
    >
      <div className="relative shrink-0">
        <Avatar
          src={conversation.contact.avatarUrl}
          name={conversation.contact.name}
          size={38}
          ring={conversation.page.color}
        />
        {conversation.windowOpen ? (
          <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-surface-raised bg-emerald-500" />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 truncate text-[13.5px]',
              conversation.unreadCount > 0 ? 'font-semibold' : 'font-medium',
            )}
          >
            {conversation.contact.name}
          </p>
          <span className="shrink-0 text-[10.5px] text-text-subtle">
            {timeAgo(conversation.lastMessageAt)}
          </span>
        </div>
        <p
          className={cn(
            'truncate text-[12.5px]',
            conversation.unreadCount > 0 ? 'text-text' : 'text-text-subtle',
          )}
        >
          {conversation.preview ?? 'No messages yet'}
        </p>
        <div className="mt-1 flex items-center gap-1">
          {conversation.isPinned ? <Pin className="size-3 text-text-subtle" /> : null}
          {conversation.hasAiActivity ? (
            <Sparkles className="size-3 text-brand-500" />
          ) : null}
          {conversation.aiMuted ? <BellOff className="size-3 text-text-subtle" /> : null}
          {conversation.labels.slice(0, 2).map((label) => (
            <span
              key={label.id}
              className="rounded-full px-1.5 py-px text-[9.5px] font-medium"
              style={{ backgroundColor: `${label.color}22`, color: label.color }}
            >
              {label.name}
            </span>
          ))}
          {conversation.unreadCount > 0 ? (
            <span className="ml-auto flex size-4.5 items-center justify-center rounded-full bg-brand-600 text-[10px] font-semibold text-white">
              {conversation.unreadCount}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function InboxPage(): React.ReactElement {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeAccountId, activeAccount, can } = useSession();

  const [filter, setFilter] = React.useState<Filter>('all');
  const [search, setSearch] = React.useState('');
  const [draft, setDraft] = React.useState('');
  const [labelId, setLabelId] = React.useState<string | null>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  const threads = useQuery({
    queryKey: ['conversations', activeAccountId, filter, labelId, search],
    queryFn: () =>
      api.get<{ conversations: ConversationListItem[]; nextCursor: string | null }>(
        '/conversations',
        {
          connectedAccountId: activeAccountId,
          filter,
          labelId,
          search: search.trim() || undefined,
          limit: 40,
        },
      ),
    enabled: Boolean(activeAccountId),
    // The inbox is the one screen where being a minute out of date is wrong.
    refetchInterval: 20_000,
  });

  const labels = useQuery({
    queryKey: ['labels', activeAccountId],
    queryFn: () => api.get<{ labels: LabelChip[] }>('/inbox/labels', {
      connectedAccountId: activeAccountId,
    }),
    enabled: Boolean(activeAccountId),
  });

  const savedReplies = useQuery({
    queryKey: ['saved-replies', activeAccountId],
    queryFn: () =>
      api.get<{ savedReplies: SavedReply[] }>('/inbox/saved-replies', {
        connectedAccountId: activeAccountId,
      }),
    enabled: Boolean(activeAccountId),
  });

  const conversations = threads.data?.conversations ?? [];
  const activeId = conversationId ?? conversations[0]?.id ?? null;

  const context = useQuery({
    queryKey: ['conversation-context', activeId],
    queryFn: () => api.get<ConversationContext>(`/conversations/${activeId}/context`),
    enabled: Boolean(activeId),
  });

  const messages = useQuery({
    queryKey: ['messages', activeId],
    queryFn: () =>
      api.get<{ messages: InboxMessage[]; nextCursor: string | null }>(
        `/conversations/${activeId}/messages`,
        { limit: 60 },
      ),
    enabled: Boolean(activeId),
    refetchInterval: 15_000,
  });

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.data?.messages.length, activeId]);

  // Opening a thread clears its badge; do it once per thread, not per render.
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/conversations/${id}/mark-read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  });

  React.useEffect(() => {
    const thread = conversations.find((c) => c.id === activeId);
    if (thread && thread.unreadCount > 0) markRead.mutate(thread.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const send = useMutation({
    mutationFn: (text: string) => api.post(`/conversations/${activeId}/messages`, { text }),
    onSuccess: async () => {
      setDraft('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', activeId] }),
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not send.');
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pin' | 'archive' | 'ai-mute' }) =>
      api.post(`/conversations/${id}/${action}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation-context', activeId] }),
      ]);
    },
  });

  const windowOpen = context.data?.window.canSend ?? false;

  const grouped = React.useMemo(() => {
    const list = messages.data?.messages ?? [];
    const groups: Array<{ day: string; items: InboxMessage[] }> = [];
    for (const message of list) {
      const day = dayLabel(message.createdAt);
      const last = groups.at(-1);
      if (last?.day === day) last.items.push(message);
      else groups.push({ day, items: [message] });
    }
    return groups;
  }, [messages.data]);

  if (!activeAccountId) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<InboxIcon className="size-5" />}
          title="Connect a Page first"
          description="The inbox shows the Messenger threads for the Pages you have connected."
          action={
            <Button variant="primary" onClick={() => navigate('/settings/pages')}>
              Connect a Page
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid h-[calc(100dvh-3.5rem)] grid-cols-1 md:grid-cols-[290px_minmax(0,1fr)] xl:grid-cols-[290px_minmax(0,1fr)_280px]">
      {/* ─── Threads ──────────────────────────────────────────────────── */}
      <div
        className={cn(
          'flex min-h-0 flex-col border-r border-line',
          activeId ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="space-y-2.5 border-b border-line p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people and messages"
              className="h-8.5 pl-8.5 text-[13px]"
            />
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <TabsList className="border-b-0">
              {(['all', 'unread', 'ai', 'archived'] as const).map((value) => (
                <TabsTrigger key={value} value={value} className="px-2 py-1.5 text-[12px] capitalize">
                  {value === 'ai' ? 'AI' : value}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {labels.data?.labels.length ? (
            <div className="flex flex-wrap gap-1">
              {labels.data.labels.map((label) => (
                <button
                  key={label.id}
                  onClick={() => setLabelId(labelId === label.id ? null : label.id)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium transition-opacity',
                    labelId === label.id ? 'opacity-100' : 'opacity-55 hover:opacity-90',
                  )}
                  style={{ backgroundColor: `${label.color}22`, color: label.color }}
                >
                  {label.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads.isLoading ? (
            <div className="space-y-1 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="p-6 text-center text-[13px] leading-relaxed text-text-subtle">
              {search
                ? 'Nothing matches that search.'
                : filter === 'unread'
                  ? 'Nothing unread. Enjoy it.'
                  : 'No conversations yet. They appear here the moment someone messages your Page.'}
            </p>
          ) : (
            conversations.map((conversation) => (
              <ThreadRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                onSelect={() => navigate(`/inbox/${conversation.id}`)}
              />
            ))
          )}
        </div>
      </div>

      {/* ─── Thread ───────────────────────────────────────────────────── */}
      <div className={cn('flex min-h-0 flex-col', activeId ? 'flex' : 'hidden md:flex')}>
        {!activeId ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <EmptyState
              icon={<InboxIcon className="size-5" />}
              title="Pick a conversation"
              description="Everything your Page receives lands here — automations, AI replies and the ones that need you."
              className="border-0"
            />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => navigate('/inbox')}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Avatar
                src={context.data?.contact.avatarUrl}
                name={context.data?.contact.name}
                size={34}
                ring={context.data?.page.color}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold">
                  {context.data?.contact.name ?? '…'}
                </p>
                <p className="truncate text-[11.5px] text-text-subtle">
                  {context.data?.page.name}
                  {context.data?.ai.hasActivity ? ' · AI has replied here' : ''}
                </p>
              </div>

              {context.data ? (
                <Tooltip
                  content={
                    windowOpen
                      ? 'Messenger lets you reply freely for 24 hours after their last message.'
                      : 'The 24-hour window has closed. Only a tagged message or a reply from them can reopen it.'
                  }
                >
                  <span>
                    <Badge tone={windowOpen ? 'success' : 'danger'}>
                      <Clock className="size-3" />
                      {windowCountdown(context.data.window.expiresAt)}
                    </Badge>
                  </span>
                </Tooltip>
              ) : null}

              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={6}
                    className="z-50 w-52 rounded-xl border border-line bg-surface-raised p-1.5 shadow-[var(--shadow-lift)]"
                  >
                    {(
                      [
                        { action: 'pin', label: 'Pin to the top', icon: Pin },
                        { action: 'archive', label: 'Archive', icon: Archive },
                        {
                          action: 'ai-mute',
                          label: context.data?.ai.muted ? 'Let the AI reply here' : 'Mute the AI here',
                          icon: Bot,
                        },
                      ] as const
                    ).map((item) => (
                      <DropdownMenu.Item
                        key={item.action}
                        onSelect={() => toggle.mutate({ id: activeId, action: item.action })}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-surface-sunken"
                      >
                        <item.icon className="size-4 text-text-subtle" />
                        {item.label}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {messages.isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className={cn('h-10', i % 2 ? 'ml-auto w-1/2' : 'w-2/3')} />
                  ))}
                </div>
              ) : (
                grouped.map((group) => (
                  <div key={group.day} className="space-y-2.5">
                    <div className="flex items-center gap-3">
                      <span className="h-px flex-1 bg-line" />
                      <span className="text-[10.5px] font-medium uppercase tracking-wide text-text-subtle">
                        {group.day}
                      </span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                    {group.items.map((message) => (
                      <MessageRow key={message.id} message={message} />
                    ))}
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>

            {/* ─── Composer ─────────────────────────────────────────────── */}
            <div className="border-t border-line p-3">
              {!windowOpen ? (
                <div className="mb-2.5 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 p-2.5 text-[12px] leading-relaxed text-text-muted">
                  <Clock className="mt-px size-3.5 shrink-0 text-amber-accent" />
                  <span>
                    The 24-hour window has closed, so Facebook will not deliver an
                    ordinary reply. It reopens the moment they message you again.
                  </span>
                </div>
              ) : null}

              {savedReplies.data?.savedReplies.length ? (
                <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
                  {savedReplies.data.savedReplies.slice(0, 6).map((reply) => (
                    <button
                      key={reply.id}
                      onClick={() => setDraft(reply.body)}
                      className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11.5px] text-text-muted transition-colors hover:border-brand-600/40 hover:text-text"
                    >
                      {reply.shortcut ?? reply.title}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (draft.trim()) send.mutate(draft.trim());
                    }
                  }}
                  disabled={!windowOpen || !can('trigger_dm_keyword')}
                  rows={1}
                  placeholder={windowOpen ? 'Write a reply…  (Enter to send)' : 'Window closed'}
                  className="max-h-32 min-h-9.5 flex-1 resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-[14px] outline-none placeholder:text-text-subtle focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60"
                />
                <Button
                  variant="primary"
                  size="icon"
                  disabled={!draft.trim() || !windowOpen}
                  loading={send.isPending}
                  onClick={() => send.mutate(draft.trim())}
                  aria-label="Send"
                >
                  <Send className="size-4" />
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] text-text-subtle">
                Replying here mutes LeadWave AI in this thread for 48 hours — a
                person has taken over.
              </p>
            </div>
          </>
        )}
      </div>

      {/* ─── Context rail ─────────────────────────────────────────────── */}
      <aside className="hidden min-h-0 overflow-y-auto border-l border-line p-4 xl:block">
        {context.data ? (
          <>
            <div className="text-center">
              <Avatar
                src={context.data.contact.avatarUrl}
                name={context.data.contact.name}
                size={56}
                className="mx-auto"
              />
              <p className="mt-2 text-[14px] font-semibold">{context.data.contact.name}</p>
              <p className="text-[11.5px] text-text-subtle">
                First seen {timeAgo(context.data.contact.firstSeenAt)}
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                {context.data.contact.followConfirmed ? (
                  <Tooltip content="They tapped the unlock button on a Follow Gate. Facebook gives no follow signal, so this is self-confirmed.">
                    <span>
                      <Badge tone="brand">Follow self-confirmed</Badge>
                    </span>
                  </Tooltip>
                ) : null}
                {context.data.contact.optedOut ? <Badge tone="danger">Opted out</Badge> : null}
                {context.data.ai.muted ? <Badge tone="neutral">AI muted</Badge> : null}
              </div>
            </div>

            {context.data.leads.length ? (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                  Captured
                </p>
                <ul className="space-y-1.5">
                  {context.data.leads.map((lead) => (
                    <li
                      key={lead.id}
                      className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px]"
                    >
                      {lead.type === 'email' ? (
                        <Mail className="size-3.5 text-emerald-500" />
                      ) : (
                        <Phone className="size-3.5 text-teal-500" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                        {lead.value}
                      </span>
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(lead.value);
                          toast.success('Copied.');
                        }}
                        className="text-text-subtle hover:text-text"
                        aria-label="Copy"
                      >
                        <Check className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {context.data.recentAutomations.length ? (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                  Automations that ran
                </p>
                <ul className="space-y-1.5">
                  {context.data.recentAutomations.map((run) => (
                    <li key={run.id} className="rounded-lg border border-line px-2.5 py-2">
                      <p className="truncate text-[12.5px] font-medium">{run.name}</p>
                      <p className="text-[11px] text-text-subtle">
                        {run.status} · {timeAgo(run.startedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-5 rounded-lg border border-line p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                <Tag className="size-3" />
                Sending window
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-muted">
                {context.data.window.open
                  ? `Open — ${windowCountdown(context.data.window.expiresAt)}. Anything you send now goes straight through.`
                  : context.data.window.humanAgentAvailable
                    ? 'Closed to ordinary replies, but the human-agent allowance is still available for up to 7 days.'
                    : 'Closed. They have to message you again before anything can be delivered.'}
              </p>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <Skeleton className="mx-auto size-14 rounded-full" />
            <Skeleton className="h-4" />
            <Skeleton className="h-20" />
          </div>
        )}
      </aside>
    </div>
  );
}
