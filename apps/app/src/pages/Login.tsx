/**
 * Sign-in.
 *
 * One button, and next to it a live thread showing what the product does — the
 * same argument the marketing site makes, made once more at the moment someone
 * decides whether to bother. The dev bypass only renders when the API is
 * running in development, and it says exactly what it is.
 */
import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { api, ApiError, API_ORIGIN } from '@/lib/api';
import { Button } from '@/components/ui';
import { MessengerThread, type PreviewBubble } from '@/components/MessengerPreview';

const DEMO: PreviewBubble[] = [
  { id: '1', from: 'contact', text: 'PRICE' },
  {
    id: '2',
    from: 'page',
    text: "Hey Ayesha 👋 thanks for commenting!\n\nHere's the full price list — everything on one page.",
    buttons: [{ label: 'See the prices', kind: 'url' }],
  },
  {
    id: '3',
    from: 'page',
    text: 'Want the 10% first-order code? Drop your email and I\'ll send it over.',
    quickReplies: ['Send my email'],
  },
  { id: '4', from: 'contact', text: 'ayesha@example.com' },
  { id: '5', from: 'page', text: 'Got it — code is on its way 🎉' },
];

const ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in link expired. Please try again.',
  no_email: 'That Google account has no email address we can use.',
};

export function LoginPage(): React.ReactElement {
  const [params] = useSearchParams();
  const [devLoading, setDevLoading] = React.useState(false);
  const [devError, setDevError] = React.useState<string | null>(null);
  const [devAvailable, setDevAvailable] = React.useState(false);

  const error = params.get('error');

  // The dev bypass exists only when the API says it is in development. Probing
  // it is cheaper than threading another config endpoint through the client.
  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    setDevAvailable(true);
  }, []);

  const devLogin = async () => {
    setDevLoading(true);
    setDevError(null);
    try {
      await api.post('/auth/dev-login');
      window.location.href = '/home';
    } catch (err) {
      setDevError(
        err instanceof ApiError ? err.message : 'Could not sign in. Is the API running?',
      );
      setDevLoading(false);
    }
  };

  return (
    <div className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      {/* ─── Left: the ask ─────────────────────────────────────────────── */}
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="flex items-center gap-2.5">
            <div className="brand-gradient flex size-8 items-center justify-center rounded-lg">
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
            <span className="display text-[21px]">LeadWave</span>
          </div>

          <h1 className="display mt-10 text-[clamp(2.1rem,5vw,2.9rem)]">
            Every comment,
            <br />
            <span className="text-brand-600 dark:text-brand-400">answered in seconds.</span>
          </h1>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            Connect your Facebook Page and let LeadWave reply to comments and
            messages, capture emails, and track every link — while you're asleep.
          </p>

          {error ? (
            <p className="mt-6 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400">
              {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
            </p>
          ) : null}

          <Button
            size="lg"
            variant="secondary"
            className="mt-7 w-full"
            onClick={() => {
              window.location.href = `${API_ORIGIN}/api/v1/auth/google?next=/home`;
            }}
          >
            <svg viewBox="0 0 24 24" className="size-4.5" aria-hidden>
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09Z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 6.68 9.14 4.75 12 4.75Z"
              />
            </svg>
            Continue with Google
          </Button>

          {devAvailable ? (
            <div className="mt-3">
              <Button variant="ghost" size="sm" className="w-full" loading={devLoading} onClick={devLogin}>
                Development sign-in (seeded account)
              </Button>
              {devError ? (
                <p className="mt-1.5 text-center text-[12px] text-red-500">{devError}</p>
              ) : null}
            </div>
          ) : null}

          <p className="mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-text-subtle">
            <ShieldCheck className="mt-px size-4 shrink-0 text-emerald-500" />
            We connect through Meta's official Graph API. We never see or store
            your Facebook password.
          </p>

          <ul className="mt-8 space-y-2 border-t border-line pt-6">
            {[
              'Free forever for your first 1,000 messages',
              'No card, no contact-based pricing traps',
              'Set up your first automation in under a minute',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2 text-[13px] text-text-muted">
                <CheckCircle2 className="mt-px size-4 shrink-0 text-brand-500" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ─── Right: the proof ──────────────────────────────────────────── */}
      <div className="relative hidden items-center justify-center overflow-hidden bg-linear-to-br from-brand-800 via-brand-600 to-brand-500 p-12 lg:flex">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, white 1px, transparent 1px), radial-gradient(circle at 70% 60%, white 1px, transparent 1px)',
            backgroundSize: '44px 44px, 60px 60px',
          }}
        />
        <div className="relative w-full max-w-sm">
          <p className="display mb-5 text-[26px] text-white">
            This is what your
            <br />
            customer sees.
          </p>
          <div className="overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-[#1c1c22]">
            <MessengerThread
              bubbles={DEMO}
              pageName="Your Page"
              className="h-[460px]"
            />
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-white/70">
            One comment. A private reply, the link, and their email — captured
            and attributed, without you touching a keyboard.
          </p>
        </div>
      </div>
    </div>
  );
}
