/**
 * Onboarding: what kind of business, then connect a Page.
 *
 * Deliberately two steps and no more. The persona answer is one tap and it is
 * what makes the first automation suggestion land; the Page connection is the
 * only thing without which nothing works at all. Everything else — AI, bio
 * page, team — is discoverable later and does not belong in front of someone
 * who has not seen the product do anything yet.
 */
import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Building2,
  Check,
  GraduationCap,
  Loader2,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Users,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Avatar, Badge, Button, EmptyState } from '@/components/ui';
import type { MetaConfig } from '@/types';

const PERSONAS = [
  { id: 'creator', label: 'Creator', description: 'I post, people comment', icon: Sparkles },
  { id: 'ecommerce', label: 'Online store', description: 'I sell products', icon: ShoppingBag },
  { id: 'local_business', label: 'Local business', description: 'Salon, clinic, restaurant', icon: Store },
  { id: 'coach', label: 'Coach or consultant', description: 'I book calls', icon: GraduationCap },
  { id: 'agency', label: 'Agency', description: 'I run this for clients', icon: Users },
  { id: 'other', label: 'Something else', description: 'I\'ll figure it out', icon: Building2 },
] as const;

interface HandoffPage {
  id: string;
  name: string;
  username: string | null;
  picture: string | null;
  category: string | null;
  alreadyConnected: boolean;
}

export function OnboardingPage(): React.ReactElement {
  const { me, auth } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const handoff = params.get('fb_handoff');
  const fbError = params.get('fb_error');

  const [persona, setPersona] = React.useState<string | null>(me.workspace.persona);
  const [step, setStep] = React.useState<1 | 2>(
    me.workspace.persona || handoff ? 2 : 1,
  );
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const metaConfig = useQuery({
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
    // Pre-tick every Page they have not connected yet — the common case is
    // "all of them", and unticking is easier than hunting for checkboxes.
    const list = pages.data?.pages;
    if (!list) return;
    setSelected(new Set(list.filter((p) => !p.alreadyConnected).map((p) => p.id)));
  }, [pages.data]);

  const savePersona = useMutation({
    mutationFn: (value: string) => api.post('/accounts/onboarding/persona', { persona: value }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', 'me'] });
      setStep(2);
    },
  });

  const startConnect = useMutation({
    mutationFn: () => api.get<{ url: string }>('/meta/auth/fb/start'),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const connect = useMutation({
    mutationFn: () =>
      api.post<{ results: Array<{ pageId: string; name: string; status: string; detail?: string }> }>(
        '/meta/auth/fb/connect',
        { handoff, pageIds: [...selected] },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', 'me'] });
      setParams({});
      navigate('/home');
    },
  });

  const configured = metaConfig.data?.configured ?? false;

  return (
    <div className="min-h-dvh bg-surface">
      <header className="flex h-14 items-center justify-between border-b border-line px-5">
        <div className="flex items-center gap-2.5">
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
        </div>
        <p className="text-[12.5px] text-text-subtle">{auth.user.email}</p>
      </header>

      <div className="mx-auto w-full max-w-2xl px-5 py-12">
        {/* Progress */}
        <div className="mb-9 flex items-center gap-3">
          {[1, 2].map((n) => (
            <React.Fragment key={n}>
              <div
                className={cn(
                  'flex size-7 items-center justify-center rounded-full text-[12px] font-semibold transition-colors',
                  step >= n
                    ? 'bg-brand-600 text-white'
                    : 'border border-line bg-surface-raised text-text-subtle',
                )}
              >
                {step > n ? <Check className="size-4" /> : n}
              </div>
              {n === 1 ? (
                <div
                  className={cn(
                    'h-px flex-1 transition-colors',
                    step > 1 ? 'bg-brand-600' : 'bg-line',
                  )}
                />
              ) : null}
            </React.Fragment>
          ))}
        </div>

        {step === 1 ? (
          <>
            <h1 className="display text-[clamp(1.8rem,4.5vw,2.4rem)]">
              What are you
              <br />
              growing?
            </h1>
            <p className="mt-3 text-[14px] leading-relaxed text-text-muted">
              One tap. It decides which automation we suggest first and how
              LeadWave AI is told to sound.
            </p>

            <div className="mt-7 grid gap-2.5 sm:grid-cols-2">
              {PERSONAS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setPersona(option.id)}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all',
                    persona === option.id
                      ? 'border-brand-600 bg-brand-600/8 ring-2 ring-brand-600/20'
                      : 'border-line bg-surface-raised hover:border-line-strong',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-lg',
                      persona === option.id
                        ? 'bg-brand-600 text-white'
                        : 'bg-surface-sunken text-text-subtle',
                    )}
                  >
                    <option.icon className="size-4.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{option.label}</span>
                    <span className="block text-[12.5px] text-text-muted">
                      {option.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <Button
              size="lg"
              variant="primary"
              className="mt-7 w-full sm:w-auto"
              disabled={!persona}
              loading={savePersona.isPending}
              onClick={() => persona && savePersona.mutate(persona)}
            >
              Continue
              <ArrowRight className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <h1 className="display text-[clamp(1.8rem,4.5vw,2.4rem)]">
              Connect your
              <br />
              Facebook Page.
            </h1>
            <p className="mt-3 text-[14px] leading-relaxed text-text-muted">
              LeadWave works on Pages, not personal profiles. You'll approve the
              permissions on Facebook's own screen — we never see your password.
            </p>

            {fbError ? (
              <p className="mt-5 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400">
                {fbError}
              </p>
            ) : null}

            {handoff ? (
              <div className="mt-7">
                {pages.isLoading ? (
                  <div className="flex items-center gap-2 text-[13px] text-text-muted">
                    <Loader2 className="size-4 animate-spin" />
                    Reading your Pages…
                  </div>
                ) : pages.isError ? (
                  <EmptyState
                    title="That connection expired"
                    description={
                      pages.error instanceof ApiError
                        ? pages.error.message
                        : 'Please start the connection again.'
                    }
                    action={
                      <Button variant="primary" onClick={() => setParams({})}>
                        Try again
                      </Button>
                    }
                  />
                ) : (
                  <>
                    <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-text-subtle">
                      Pick the Pages to connect
                    </p>
                    <div className="space-y-2">
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
                                  : 'border-line bg-surface-raised hover:border-line-strong',
                            )}
                          >
                            <Avatar src={page.picture} name={page.name} size={38} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13.5px] font-medium">
                                {page.name}
                              </span>
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
                                  isSelected
                                    ? 'border-brand-600 bg-brand-600 text-white'
                                    : 'border-line-strong',
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
                      size="lg"
                      variant="primary"
                      className="mt-5 w-full sm:w-auto"
                      disabled={selected.size === 0}
                      loading={connect.isPending}
                      onClick={() => connect.mutate()}
                    >
                      Connect {selected.size > 1 ? `${selected.size} Pages` : 'this Page'}
                      <ArrowRight className="size-4" />
                    </Button>
                    {connect.isError ? (
                      <p className="mt-2 text-[12.5px] text-red-500">
                        {(connect.error as Error).message}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            ) : (
              <div className="mt-7">
                <Button
                  size="lg"
                  variant="primary"
                  disabled={!configured}
                  loading={startConnect.isPending}
                  onClick={() => startConnect.mutate()}
                >
                  <svg viewBox="0 0 24 24" className="size-4.5 fill-current" aria-hidden>
                    <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96H15.83c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z" />
                  </svg>
                  Continue with Facebook
                </Button>

                {!configured ? (
                  <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/8 p-4">
                    <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-300">
                      Facebook isn't configured yet
                    </p>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
                      Set <code className="font-mono">META_APP_ID</code> and{' '}
                      <code className="font-mono">META_APP_SECRET</code> in the API's
                      environment, then reload this page. Everything else in the
                      dashboard works without them.
                    </p>
                  </div>
                ) : null}

                <ul className="mt-7 space-y-2.5 border-t border-line pt-6">
                  {[
                    'We only ask for the permissions needed to read comments and send messages.',
                    'You can disconnect a Page at any time, and we delete its token immediately.',
                    'Nothing is ever posted from your Page unless an automation you published says so.',
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-2 text-[13px] text-text-muted">
                      <ShieldCheck className="mt-px size-4 shrink-0 text-emerald-500" />
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {me.connectedAccounts.length > 0 ? (
              <button
                onClick={() => navigate('/home')}
                className="mt-6 text-[13px] text-text-subtle underline-offset-4 hover:underline"
              >
                Skip — go to the dashboard
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
