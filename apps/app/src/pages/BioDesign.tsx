/**
 * The bio page editor.
 *
 * Blocks on the left, a live phone rendering of the actual page on the right —
 * the same principle as the automation builder. Reordering writes positions
 * immediately rather than behind a Save button, because a list you have
 * dragged into shape and then lost is the most annoying thing an editor can do.
 */
import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Image as ImageIcon,
  Link2,
  Lock,
  Mail,
  Plus,
  Save,
  Search,
  Trash2,
  Type,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
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
  Textarea,
} from '@/components/ui';
import type { BioBlock, BioBlockType, BioPageDetail } from '@/types';

const BLOCK_META: Record<
  BioBlockType,
  { label: string; description: string; icon: React.ComponentType<{ className?: string }> }
> = {
  link: { label: 'Link', description: 'A big tappable button. Clicks are counted.', icon: Link2 },
  header: { label: 'Heading', description: 'Breaks the page into sections.', icon: Type },
  text: { label: 'Text', description: 'A short paragraph.', icon: Type },
  image: { label: 'Image', description: 'A picture, full width.', icon: ImageIcon },
  video: { label: 'Video', description: 'A YouTube or Facebook embed.', icon: ImageIcon },
  socials: { label: 'Social icons', description: 'A row of small icons.', icon: Users },
  email_capture: {
    label: 'Email capture',
    description: 'A box that drops signups straight into your contacts.',
    icon: Mail,
  },
};

const THEME_BACKDROP: Record<string, string> = {
  clean: 'bg-white text-neutral-900',
  midnight: 'bg-[#0d0d14] text-white',
  sand: 'bg-[#f5efe6] text-[#2b2419]',
  forest: 'bg-[#0f1f18] text-[#e8f3ec]',
  sunset: 'bg-linear-to-b from-[#ff8a4c] to-[#c2255c] text-white',
  mono: 'bg-neutral-100 text-neutral-900',
};

export function BioDesignPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useSession();

  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BioBlock | null>(null);

  const detail = useQuery({
    queryKey: ['bio-page', id],
    queryFn: () => api.get<BioPageDetail>(`/bio/pages/${id}`),
    enabled: Boolean(id),
  });

  const themes = useQuery({
    queryKey: ['bio-themes'],
    queryFn: () =>
      api.get<{ themes: Array<{ id: string; name: string; premium: boolean; locked: boolean }> }>(
        '/bio/themes',
      ),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bio-page', id] });

  const patchPage = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/bio/pages/${id}`, body),
    onSuccess: invalidate,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not save that.'),
  });

  const addBlock = useMutation({
    mutationFn: (type: BioBlockType) =>
      api.post<BioBlock>(`/bio/pages/${id}/blocks`, {
        type,
        title: type === 'link' ? 'New link' : type === 'header' ? 'Section' : null,
        url: type === 'link' ? 'https://example.com' : null,
      }),
    onSuccess: async (block) => {
      await invalidate();
      setAddOpen(false);
      setEditing(block);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not add that block.'),
  });

  const patchBlock = useMutation({
    mutationFn: ({ blockId, body }: { blockId: string; body: Record<string, unknown> }) =>
      api.patch(`/bio/blocks/${blockId}`, body),
    onSuccess: invalidate,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not save that block.'),
  });

  const removeBlock = useMutation({
    mutationFn: (blockId: string) => api.delete(`/bio/blocks/${blockId}`),
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
  });

  const reorder = useMutation({
    mutationFn: (blockIds: string[]) => api.put(`/bio/pages/${id}/blocks/reorder`, { blockIds }),
    onSuccess: invalidate,
  });

  if (detail.isLoading || !detail.data) {
    return (
      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const { page, blocks } = detail.data;
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    const ids = blocks.map((b) => b.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    reorder.mutate(ids);
  };

  return (
    <div className="grid min-h-[calc(100dvh-3.5rem)] lg:grid-cols-[minmax(0,1fr)_400px]">
      {/* ─── Editor ───────────────────────────────────────────────────── */}
      <div className="min-w-0 border-r border-line">
        <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur-md sm:px-6">
          <Button variant="ghost" size="icon" onClick={() => navigate('/bio')}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14.5px] font-semibold">{page.displayName}</p>
            <p className="truncate font-mono text-[11px] text-text-subtle">{page.url}</p>
          </div>
          <Badge tone={page.isPublished ? 'success' : 'neutral'}>
            {page.isPublished ? 'Live' : 'Unpublished'}
          </Badge>
          <Button variant="secondary" size="sm" asChild>
            <a href={page.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              Open
            </a>
          </Button>
          <Button
            variant={page.isPublished ? 'secondary' : 'primary'}
            size="sm"
            loading={patchPage.isPending}
            onClick={() => patchPage.mutate({ isPublished: !page.isPublished })}
          >
            {page.isPublished ? (
              <>
                <EyeOff className="size-3.5" />
                Unpublish
              </>
            ) : (
              <>
                <Eye className="size-3.5" />
                Publish
              </>
            )}
          </Button>
        </div>

        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
          <Tabs defaultValue="content">
            <TabsList>
              <TabsTrigger value="content">Content</TabsTrigger>
              <TabsTrigger value="design">Design</TabsTrigger>
              <TabsTrigger value="seo">SEO</TabsTrigger>
            </TabsList>

            {/* Content */}
            <TabsContent value="content" className="space-y-2.5 pt-5">
              <Card className="p-4">
                <div className="space-y-3">
                  <Field label="Display name">
                    <Input
                      defaultValue={page.displayName}
                      maxLength={60}
                      onBlur={(e) =>
                        e.target.value !== page.displayName &&
                        patchPage.mutate({ displayName: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Bio" hint="Two lines at most. People are scanning, not reading.">
                    <Textarea
                      defaultValue={page.bio ?? ''}
                      maxLength={200}
                      rows={2}
                      onBlur={(e) => patchPage.mutate({ bio: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Avatar URL">
                    <Input
                      defaultValue={page.avatarUrl ?? ''}
                      placeholder="https://…"
                      onBlur={(e) => patchPage.mutate({ avatarUrl: e.target.value || null })}
                    />
                  </Field>
                </div>
              </Card>

              {blocks.length === 0 ? (
                <EmptyState
                  icon={<Link2 className="size-5" />}
                  title="Add your first block"
                  description="A link, a heading, an email capture box. They stack in the order you set here."
                  action={
                    <Button variant="primary" onClick={() => setAddOpen(true)}>
                      Add a block
                    </Button>
                  }
                />
              ) : (
                blocks.map((block, index) => {
                  const meta = BLOCK_META[block.type];
                  return (
                    <Card key={block.id} className={cn('p-3', !block.isVisible && 'opacity-55')}>
                      <div className="flex items-center gap-2.5">
                        <div className="flex flex-col">
                          <button
                            onClick={() => move(index, -1)}
                            disabled={index === 0}
                            className="text-text-subtle disabled:opacity-25"
                            aria-label="Move up"
                          >
                            <ChevronUp className="size-3.5" />
                          </button>
                          <button
                            onClick={() => move(index, 1)}
                            disabled={index === blocks.length - 1}
                            className="text-text-subtle disabled:opacity-25"
                            aria-label="Move down"
                          >
                            <ChevronDown className="size-3.5" />
                          </button>
                        </div>

                        <button
                          onClick={() => setEditing(block)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-subtle">
                            <meta.icon className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[13.5px] font-medium">
                              {block.title || meta.label}
                            </span>
                            <span className="block truncate text-[11.5px] text-text-subtle">
                              {block.type === 'link'
                                ? `${block.url} · ${block.clicks} clicks`
                                : meta.description}
                            </span>
                          </span>
                        </button>

                        <Switch
                          checked={block.isVisible}
                          onCheckedChange={(isVisible) =>
                            patchBlock.mutate({ blockId: block.id, body: { isVisible } })
                          }
                        />
                      </div>
                    </Card>
                  );
                })
              )}

              <Button variant="secondary" className="w-full" onClick={() => setAddOpen(true)}>
                <Plus className="size-4" />
                Add a block
              </Button>
            </TabsContent>

            {/* Design */}
            <TabsContent value="design" className="space-y-4 pt-5">
              <Card className="p-4">
                <p className="mb-3 text-[13px] font-medium">Theme</p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {themes.data?.themes.map((theme) => (
                    <button
                      key={theme.id}
                      disabled={theme.locked}
                      onClick={() => patchPage.mutate({ theme: theme.id })}
                      className={cn(
                        'relative overflow-hidden rounded-lg border-2 p-3 text-left transition-all',
                        page.theme === theme.id ? 'border-brand-600' : 'border-line',
                        theme.locked && 'cursor-not-allowed opacity-55',
                      )}
                    >
                      <div
                        className={cn(
                          'mb-2 h-10 rounded',
                          THEME_BACKDROP[theme.id] ?? 'bg-surface-sunken',
                        )}
                      />
                      <p className="flex items-center gap-1 text-[12px] font-medium">
                        {theme.name}
                        {theme.locked ? <Lock className="size-3" /> : null}
                      </p>
                    </button>
                  ))}
                </div>
              </Card>

              <Card className="p-4 space-y-3">
                <Field label="Accent colour">
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={String(page.themeConfig.accent ?? '#157A70')}
                      onChange={(e) =>
                        patchPage.mutate({
                          themeConfig: { ...page.themeConfig, accent: e.target.value },
                        })
                      }
                      className="h-9.5 w-14 cursor-pointer rounded-md border border-line bg-transparent"
                    />
                    <Input
                      value={String(page.themeConfig.accent ?? '#157A70')}
                      onChange={(e) =>
                        patchPage.mutate({
                          themeConfig: { ...page.themeConfig, accent: e.target.value },
                        })
                      }
                    />
                  </div>
                </Field>
                <Field label="Button shape">
                  <Select
                    value={String(page.themeConfig.buttonShape ?? 'pill')}
                    onValueChange={(buttonShape) =>
                      patchPage.mutate({ themeConfig: { ...page.themeConfig, buttonShape } })
                    }
                    options={[
                      { value: 'pill', label: 'Pill' },
                      { value: 'rounded', label: 'Rounded' },
                      { value: 'square', label: 'Square' },
                    ]}
                  />
                </Field>
                <label className="flex items-center justify-between gap-3 border-t border-line pt-3 text-[13px]">
                  <span>
                    Show the LeadWave badge
                    <span className="block text-[12px] text-text-subtle">
                      {can('remove_branding')
                        ? 'Your plan lets you hide it.'
                        : 'Hiding it is a Pro feature.'}
                    </span>
                  </span>
                  <Switch
                    checked={page.showBranding}
                    disabled={!can('remove_branding')}
                    onCheckedChange={(showBranding) => patchPage.mutate({ showBranding })}
                  />
                </label>
              </Card>
            </TabsContent>

            {/* SEO */}
            <TabsContent value="seo" className="pt-5">
              <Card className="p-4">
                {!can('bio_seo_controls') ? (
                  <div className="mb-4 rounded-lg border border-brand-600/25 bg-brand-600/8 p-3 text-[12.5px] leading-relaxed text-text-muted">
                    <Lock className="mb-1 size-3.5" />
                    SEO controls are part of Pro. Your page still works and is still
                    indexable — you just cannot override the title and description yet.
                  </div>
                ) : null}
                <div className="space-y-3">
                  <Field label="Page title" hint="What shows in a search result and a shared link.">
                    <Input
                      defaultValue={page.seoTitle ?? ''}
                      maxLength={80}
                      disabled={!can('bio_seo_controls')}
                      onBlur={(e) => patchPage.mutate({ seoTitle: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Description">
                    <Textarea
                      defaultValue={page.seoDescription ?? ''}
                      maxLength={200}
                      rows={2}
                      disabled={!can('bio_seo_controls')}
                      onBlur={(e) => patchPage.mutate({ seoDescription: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Preview image URL">
                    <Input
                      defaultValue={page.seoImageUrl ?? ''}
                      placeholder="https://…"
                      disabled={!can('bio_seo_controls')}
                      onBlur={(e) => patchPage.mutate({ seoImageUrl: e.target.value || null })}
                    />
                  </Field>
                  <label className="flex items-center justify-between gap-3 border-t border-line pt-3 text-[13px]">
                    <span>
                      Ask search engines not to index this page
                      <span className="block text-[12px] text-text-subtle">
                        For a private page you only share by link.
                      </span>
                    </span>
                    <Switch
                      checked={page.seoNoIndex}
                      disabled={!can('bio_seo_controls')}
                      onCheckedChange={(seoNoIndex) => patchPage.mutate({ seoNoIndex })}
                    />
                  </label>
                </div>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* ─── Preview ──────────────────────────────────────────────────── */}
      <aside className="hidden bg-surface-sunken/50 lg:block">
        <div className="sticky top-14 px-5 py-6">
          <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            <Eye className="size-3.5" />
            Live preview
          </p>
          <div className="mx-auto w-[300px] rounded-[2.2rem] border-[9px] border-[#15151c] shadow-[var(--shadow-lift)] dark:border-[#26262f]">
            <div
              className={cn(
                'h-[540px] overflow-y-auto rounded-[1.5rem] px-5 py-8',
                THEME_BACKDROP[page.theme] ?? THEME_BACKDROP.clean,
              )}
            >
              <div className="text-center">
                {page.avatarUrl ? (
                  <img
                    src={page.avatarUrl}
                    alt=""
                    className="mx-auto size-16 rounded-full object-cover"
                  />
                ) : (
                  <div className="mx-auto size-16 rounded-full bg-current/10" />
                )}
                <p className="mt-2.5 text-[15px] font-bold">{page.displayName}</p>
                {page.bio ? (
                  <p className="mt-1 text-[12px] leading-relaxed opacity-70">{page.bio}</p>
                ) : null}
              </div>

              <div className="mt-5 space-y-2.5">
                {blocks
                  .filter((block) => block.isVisible)
                  .map((block) => (
                    <BioBlockPreview
                      key={block.id}
                      block={block}
                      accent={String(page.themeConfig.accent ?? '#157A70')}
                      shape={String(page.themeConfig.buttonShape ?? 'pill')}
                    />
                  ))}
              </div>

              {page.showBranding ? (
                <p className="mt-8 text-center text-[10.5px] opacity-50">Made with LeadWave</p>
              ) : null}
            </div>
          </div>
          <p className="mx-auto mt-4 max-w-72 text-center text-[11.5px] leading-relaxed text-text-subtle">
            Every link here gets the same tracked short URL as your DM buttons, so
            one dashboard covers both.
          </p>
        </div>
      </aside>

      {/* ─── Add block ────────────────────────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen} title="Add a block">
        <div className="space-y-2">
          {(Object.keys(BLOCK_META) as BioBlockType[]).map((type) => {
            const meta = BLOCK_META[type];
            return (
              <button
                key={type}
                onClick={() => addBlock.mutate(type)}
                className="flex w-full items-start gap-3 rounded-xl border border-line p-3 text-left transition-colors hover:border-brand-600/40 hover:bg-surface-sunken"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text-subtle">
                  <meta.icon className="size-4.5" />
                </span>
                <span>
                  <span className="block text-[13.5px] font-semibold">{meta.label}</span>
                  <span className="block text-[12.5px] text-text-muted">{meta.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Dialog>

      {/* ─── Edit block ───────────────────────────────────────────────── */}
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing ? BLOCK_META[editing.type].label : 'Block'}
        footer={
          editing ? (
            <>
              <Button
                variant="ghost"
                className="mr-auto text-red-600 dark:text-red-400"
                onClick={() => removeBlock.mutate(editing.id)}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
              <Button variant="primary" onClick={() => setEditing(null)}>
                <Save className="size-4" />
                Done
              </Button>
            </>
          ) : null
        }
      >
        {editing ? (
          <div className="space-y-3.5">
            <Field label="Title">
              <Input
                defaultValue={editing.title ?? ''}
                onBlur={(e) =>
                  patchBlock.mutate({ blockId: editing.id, body: { title: e.target.value } })
                }
              />
            </Field>
            {editing.type !== 'header' ? (
              <Field label="Subtitle">
                <Input
                  defaultValue={editing.subtitle ?? ''}
                  onBlur={(e) =>
                    patchBlock.mutate({ blockId: editing.id, body: { subtitle: e.target.value } })
                  }
                />
              </Field>
            ) : null}
            {editing.type === 'link' || editing.type === 'video' ? (
              <Field
                label="Destination"
                hint={
                  editing.type === 'link'
                    ? 'Changing this keeps the same short link, so the click history carries over.'
                    : undefined
                }
              >
                <Input
                  defaultValue={editing.url ?? ''}
                  onBlur={(e) =>
                    patchBlock.mutate({ blockId: editing.id, body: { url: e.target.value } })
                  }
                />
              </Field>
            ) : null}
            {editing.type === 'image' ? (
              <Field label="Image URL">
                <Input
                  defaultValue={editing.imageUrl ?? ''}
                  onBlur={(e) =>
                    patchBlock.mutate({ blockId: editing.id, body: { imageUrl: e.target.value } })
                  }
                />
              </Field>
            ) : null}

            {editing.type === 'link' ? (
              <div className="rounded-lg bg-surface-sunken p-3">
                <p className="flex items-center gap-1.5 text-[12px] font-medium">
                  <Search className="size-3.5" />
                  {editing.clicks} clicks · {editing.uniqueClicks} different people
                </p>
              </div>
            ) : null}

            {!can('bio_link_scheduling') ? (
              <p className="flex items-center gap-1.5 text-[12px] text-text-subtle">
                <Lock className="size-3.5" />
                Scheduling a link to appear and disappear is a Pro feature.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Show from">
                  <Input
                    type="datetime-local"
                    defaultValue={editing.visibleFrom?.slice(0, 16) ?? ''}
                    onBlur={(e) =>
                      patchBlock.mutate({
                        blockId: editing.id,
                        body: { visibleFrom: e.target.value || null },
                      })
                    }
                  />
                </Field>
                <Field label="Hide after">
                  <Input
                    type="datetime-local"
                    defaultValue={editing.visibleUntil?.slice(0, 16) ?? ''}
                    onBlur={(e) =>
                      patchBlock.mutate({
                        blockId: editing.id,
                        body: { visibleUntil: e.target.value || null },
                      })
                    }
                  />
                </Field>
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function BioBlockPreview({
  block,
  accent,
  shape,
}: {
  block: BioBlock;
  accent: string;
  shape: string;
}): React.ReactElement | null {
  const radius = shape === 'pill' ? '999px' : shape === 'square' ? '4px' : '12px';

  switch (block.type) {
    case 'header':
      return (
        <p className="pt-3 text-center text-[11px] font-bold uppercase tracking-wide opacity-60">
          {block.title}
        </p>
      );
    case 'text':
      return (
        <p className="text-center text-[12px] leading-relaxed opacity-75">{block.title}</p>
      );
    case 'image':
      return block.imageUrl ? (
        <img src={block.imageUrl} alt="" className="w-full rounded-xl object-cover" />
      ) : null;
    case 'socials':
      return (
        <div className="flex justify-center gap-3 pt-1">
          {[Globe, Users, Mail].map((Icon, i) => (
            <span
              key={i}
              className="flex size-8 items-center justify-center rounded-full bg-current/10"
            >
              <Icon className="size-4" />
            </span>
          ))}
        </div>
      );
    case 'email_capture':
      return (
        <div className="rounded-xl border border-current/15 p-3">
          <p className="text-[12.5px] font-semibold">{block.title || 'Get updates'}</p>
          {block.subtitle ? (
            <p className="mt-0.5 text-[11px] opacity-70">{block.subtitle}</p>
          ) : null}
          <div
            className="mt-2 h-8 w-full border border-current/15"
            style={{ borderRadius: radius }}
          />
          <div
            className="mt-1.5 flex h-8 items-center justify-center text-[12px] font-semibold text-white"
            style={{ backgroundColor: accent, borderRadius: radius }}
          >
            {String(block.config.buttonLabel ?? 'Subscribe')}
          </div>
        </div>
      );
    case 'link':
    case 'video':
    default:
      return (
        <div
          className="flex min-h-11 flex-col items-center justify-center px-3 py-2 text-white"
          style={{ backgroundColor: accent, borderRadius: radius }}
        >
          <span className="text-[13px] font-semibold">{block.title || 'Link'}</span>
          {block.subtitle ? (
            <span className="text-[10.5px] opacity-80">{block.subtitle}</span>
          ) : null}
        </div>
      );
  }
}
