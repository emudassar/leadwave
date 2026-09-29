# LeadWave — where we are

Facebook Messenger automation SaaS. A clone of [reachlee.co](https://www.reachlee.co)'s
feature set, rebuilt for **Facebook Pages / Messenger** instead of Instagram, with the AI
layer running on the **Gemini API**.

The full plan lives at `C:\Users\M.s\.claude\plans\you-have-to-make-streamed-petal.md`.

---

## Status: everything is built and running locally

| | State |
|---|---|
| Workspace, tooling, Prisma schema | ✅ Done |
| Shared package (plans, automation schema, matching, messaging rules, AI constants) | ✅ Done |
| API server + all REST routes | ✅ Done |
| Runtime (executor, send pipeline, webhooks, queues, all workers) | ✅ Written — queues need Redis |
| LeadWave AI on Gemini | ✅ Done and live — `GEMINI_API_KEY` set, verified with a real call |
| Billing (Paddle + Lemon Squeezy adapters) | ✅ Done — needs credentials to check out |
| **Local Postgres** | ✅ Running, no install and no account needed |
| **Database migrated + seeded** | ✅ Done |
| **Dashboard SPA (`apps/app`)** | ✅ Done — every screen, verified in a browser |
| **Founder analytics (`/growth`, admin-only)** | ✅ Done — MRR, signups, plan mix, verified in a browser |
| **Marketing site (`apps/web`)** | ✅ Done — 34 pages, builds clean |
| **End-to-end test against Facebook** | ❌ Blocked on Meta credentials (see below) |

**Verified right now:** `pnpm vitest run` → 36/36. Typecheck clean on shared, api and app.
`astro build` → 20 pages. And, new since the last handoff, **18/18 API endpoints answering
correctly against a real Postgres with real seeded data.**

---

## Running it

Four terminals, in this order. The first two have to be up before the others are useful.

```bash
pnpm db:up        # Postgres on :5432 — keep this running
```

```bash
pnpm dev:api      # API on :4000
```

```bash
pnpm dev:app      # dashboard on :5173
```

```bash
pnpm dev:web      # marketing site on :4321
```

Then open http://localhost:5173 and click **Development sign-in (seeded account)**.

### How the database works now

This machine has no Postgres, no Docker and no WSL, and every free hosted tier wants an
account before it hands you a connection string. So the project runs **real PostgreSQL
18.4 out of `.localdb/`**, downloaded by npm as the `embedded-postgres` package. Nothing to
install, no account, and `DATABASE_URL` in `.env` already points at it.

```bash
pnpm db:init      # first run only — initdb + create the database
pnpm db:up        # start it (foreground)
pnpm db:down      # stop it
pnpm db:seed      # reset and refill the demo workspace
```

`initdb` is forced to UTF-8 in `scripts/dev-postgres.mjs`. On Windows it otherwise inherits
the system code page and the first emoji in a seeded message dies with a `22P05` error.

If `pnpm db:up` fails with *"pre-existing shared memory block is still in use"*, a previous
postgres is still alive: `Get-Process postgres | Stop-Process -Force`, then start it again.

### Signing in without Google OAuth

`POST /api/v1/auth/dev-login` signs in the seeded admin. It is guarded by `isDevelopment`
in `apps/api/src/routes/auth.ts`, in the same file as the real Google flow so the guard is
impossible to miss. The dashboard shows the button only on a Vite dev build.

### What the seed builds

A Growth-plan workspace that looks like a fortnight of real use: a connected Page, four
automations (comment→DM with a Follow Gate, email capture and a nudge; a keyword reply; a
story carousel; a draft), 140 contacts, 40 full threads, ~90 runs, tracked links with
clicks, 58 leads, AI settings, knowledge, goals and 60 AI events including skips, and a
published bio page. It clears itself first, so running it twice is the same as once.

---

## Nothing left blocked

**Redis** was the last blocker and is resolved as of 2026-09-21 — an Upstash free-tier
database, verified with a real SET/GET. `pnpm dev:worker` should now actually process the
queues (webhook processing, follow-ups, Retrigger, AI pipeline), the send rate-limit
buckets work, and the OAuth `state` used by the Google, Facebook and Sheets connect flows
has somewhere to live.

---

## What's built, and where

```
leadwave/
├─ scripts/dev-postgres.mjs     Local Postgres, no install, no account
├─ packages/
│  ├─ shared/src/
│  │   plans.ts          Every plan limit + feature gate. Single source of truth.
│  │   automation.ts     Trigger + step-tree zod schema, structural validation.
│  │   matching.ts       Keyword matching, email/phone parsing, merge fields. (tested)
│  │   messaging.ts      Messenger's 24h window, message tags, send budgets, Graph errors.
│  │   ai/constants.ts   Classifier labels, credit rules, all AI limits.
│  └─ db/prisma/
│      schema.prisma     ~35 models. Migrated.
│      seed.ts           The demo workspace.
├─ apps/api/src/
│  ├─ routes/       auth (+ dev-login), meta, automations, conversations, contacts,
│  │                accounts, ai, bio, integrations, billing, admin, public
│  ├─ services/     graph, send, executor, dispatcher, inbound, shortlinks, leads,
│  │                entitlements, rate-limit, message-builder, analytics,
│  │                ai/{gemini,classify,generate,context,credits,knowledge},
│  │                billing/{provider,paddle,lemonsqueezy}, integrations/google-sheets
│  ├─ queues/       index.ts + workers/{webhook,comment,followup,retrigger,ai,goals,maintenance}
│  └─ webhooks/     messenger.ts (signature verify + dedupe + enqueue)
├─ apps/app/src/    Vite + React + Tailwind v4 + Radix dashboard
│  ├─ components/   ui/index.tsx (all primitives), AppShell, MessengerPreview
│  ├─ lib/          api.ts, session.tsx, utils.ts, automation-meta.tsx
│  └─ pages/        Login, Onboarding, Home, Automations, AutomationBuilder,
│                   Inbox, Contacts, Ai, Bio, BioDesign, Settings, Admin (Growth)
└─ apps/web/src/    Astro marketing site, 34 pages
   ├─ components/   Nav, Footer, Phone (Messenger mockup), Dashboard, Pricing, Faq
   ├─ content/usecases/    8 Markdown pages — one per capability
   ├─ content/audiences/  18 Markdown pages — one per kind of business
   └─ pages/        index, for/[slug], pricing, faq, use-cases/[slug],
                    privacy, terms, data-deletion
```

### Design decisions made while building the front end

- **The Messenger preview is the product's main argument, so it renders the real thing.**
  Messenger's own 18px bubbles, blue-violet outbound gradient, button templates as a card
  with hairline-divided blue rows, 240px generic-template carousel, outlined quick-reply
  pills. `apps/app/src/components/MessengerPreview.tsx` on the dashboard,
  `apps/web/src/components/Phone.astro` on the site. It matters because the usual way an
  automation goes wrong is copy that reads fine in a form field and looks broken in a
  thread.
- **Pricing is generated from `PLAN_DEFINITIONS`** on both the marketing site and the
  settings screen. The price table and the gate that stops you cannot disagree, because
  there is one copy of the table.
- **Locked features are shown greyed with the plan that unlocks them**, never hidden. A
  greyed row with a reason converts; an invisible one confuses.
- **The 24-hour window countdown sits above the inbox composer**, not in a tooltip. It is
  the difference between a message that sends and one that silently does not.
- **The AI overview leads with the skips.** "It stayed quiet 43 times and charged you
  nothing" is the number that decides whether someone trusts it enough to switch it on.
- **Palette: deep teal `#157A70`, not violet.** Every tool in this category has landed on
  the same indigo-violet, and picking teal also keeps Messenger's blue unambiguous — blue
  in this product always means Messenger, never LeadWave. Amber `#E2952C` is the accent for
  the one urgent thing on a screen.
- **Headings are set at 1.1 line-height**, not the 0.95 the genre defaults to. Anton at
  0.95 collides with itself the moment a heading wraps, which it does on every phone.
- **Body copy is a solid colour, never an opacity of the ink.** Text at 65% over a tinted
  band is a different, muddier colour than the same text on white; `--color-body` and
  `--color-muted` are fixed values so a paragraph reads identically on every background.
- **The marketing site's sections alternate paper → mist → paper → sand**, two very
  low-saturation tints (`#F4F8F7`, `#FAF7F2`), with white `.panel` cards on top. Scrolling
  has a rhythm without any band being loud enough to fight its own content.
- **The homepage shows the dashboard**, drawn in markup rather than screenshotted
  (`apps/web/src/components/Dashboard.astro`). It stays sharp on any display, reflows on a
  phone instead of becoming an unreadable thumbnail, and cannot drift out of date the way
  an exported PNG does.
- **Type**: Anton for display (uppercase), Geist for body, Geist Mono for numbers — all
  free from Google Fonts.
- **The logo mark is brand teal, never Messenger blue.** Two gradients exist and they mean
  different things: `brand-gradient` (through `#10635C`) is LeadWave, `messenger-gradient`
  is Messenger's own blue-violet and appears only inside the mockups. Anything carrying the
  wave icon uses the first.
- **Two content collections, because they answer two questions.** `usecases` is "what does
  it do", one page per capability. `audiences` is "is it for me", one page per kind of
  business — which is the question most people actually arrive with. The order is fixed by
  `order:` in the frontmatter and creators lead it: they are the largest group and the one
  the product was shaped around. The homepage list and `/for/` both read from the
  collection, so they cannot drift apart.

### Backend decisions from the earlier pass, unchanged

- **Everything outbound goes through `services/send.ts`.** Window check, plan quota, shared
  per-Page budget and idempotency are enforced once, so an AI reply can never be sent where
  an ordinary message could not.
- **Precedence:** a run waiting on a reply claims it first → then keyword automations → and
  only if neither fired is the AI considered. Nobody gets two replies.
- **Credits:** 1 credit = 1 AI reply that landed. Classification, skips, failed sends, goals
  and knowledge edits are 0. Charged *after* delivery.
- **Comment → DM:** the private reply *is* step 0, which is why `validateDefinition`
  requires an automation to start with a message or carousel.
- **Follow Gate:** confirmed by tap, recorded and labelled `self_confirmed` everywhere so
  analytics never overclaim.
- **Billing:** `BillingProvider` adapter. Paddle default (Payoneer payouts work in
  Pakistan); Lemon Squeezy via `BILLING_PROVIDER=lemonsqueezy`.
- **`/growth` (admin-only) is the founder's own dashboard, not a workspace's.**
  Signups and plan mix are always derivable from `createdAt` columns, but MRR
  is a snapshot of `Subscription` with no memory of what it was yesterday — so
  the 10-minute maintenance sweep now also upserts one `MetricSnapshot` row
  per UTC day. That's what makes the MRR-over-time chart real (from
  2026-09-21 onward) instead of reconstructed.

---

## Bugs found and fixed while wiring the front end to the real API

- `GET /accounts/me/home` 500'd — `automationRun.count` scoped through a `connectedAccount`
  relation that does not exist on that model. Now goes through `automation`.
- `Button asChild` passed two children to Radix's `Slot`, which accepts one, so every
  button-as-link crashed its subtree. It no longer injects the spinner in `asChild` mode.
- The bio page showed a click rate of **38470%**. `/bio/pages/:id/summary` returns `ctr`
  already as a percentage; the UI was multiplying by 100 again. There is now a separate
  `percentValue()` formatter for API values that are already percentages.
- The marketing site's reveal-on-scroll used an `IntersectionObserver`, which never fires
  for elements you jump past — an anchor link or a fast flick left whole sections
  permanently invisible. Replaced with a clock-throttled scroll sweep, and the hidden state
  now lives behind `.js [data-reveal]:not(.is-visible)` so nothing can be hidden when the
  script does not run.
- `dev-login` signed in whichever user row was oldest, which after a reseed was the seeded
  *manager*, not the admin. It now prefers a workspace admin.
- Seed data had more unique clickers than triggers and more bio clicks than bio views,
  which made every rate read as 100%+. Ratios are realistic now.

---

## Next steps, in order

Every credential in the list below is done as of 2026-09-21 except Paddle's webhook URL,
which is a placeholder. What's left:

1. **Get ngrok running** (`ngrok http 4000` or similar) and:
   - Point Meta's webhook at `https://<ngrok>.ngrok-free.app/webhooks/messenger`
     (developers.facebook.com → Leadwave app → Messenger → Webhooks)
   - Update the Paddle notification destination's URL to
     `https://<ngrok>.ngrok-free.app/webhooks/billing` (sandbox-vendors.paddle.com →
     Developer Tools → Notifications)
2. Start `pnpm dev:worker` now that Redis is live.
3. **The 12-step end-to-end walkthrough** in the plan file: comment on a test post, watch
   the private reply arrive, tap the gate, send an email, check the click lands.
4. **Deploy** — the API and worker are plain Node; the dashboard is static; the site is
   static. Any of Railway, Render or Fly will take them.

---

## Credentials still needed in `.env`

Everything below is optional to *run*; each feature checks its own credentials and says so
plainly when they are missing.

- ~~`GEMINI_API_KEY`~~ — done 2026-09-18, AI layer live
- ~~`META_APP_ID` / `META_APP_SECRET` / `META_LOGIN_CONFIG_ID`~~ — done 2026-09-21, app
  "Leadwave" (App ID `1369532522003456`), Facebook Login for Business configuration
  "leadwave-page-connect" created with a **user access token** (not system-user — no
  business portfolio set up yet)
- ~~`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`~~ — done 2026-09-21. New GCP project
  `leadwave-509306`, OAuth consent screen (External, Testing, `mudassar63663@gmail.com`
  added as a test user — Google accounts other than his won't be able to sign in until
  the app is published/verified), Web application client "LeadWave web" with redirect
  `http://localhost:4000/api/v1/auth/google/callback` and JS origin
  `http://localhost:5173`.
- ~~`GOOGLE_SHEETS_CLIENT_ID` / `SECRET`~~ — done 2026-09-21. Separate client "LeadWave
  Sheets integration" in the same GCP project, redirect
  `http://localhost:4000/api/v1/integrations/google-sheets/callback`. Google Sheets API
  and Google Drive API both enabled on the project (the code requests
  `drive.file` alongside `spreadsheets`).
- ~~`PADDLE_*`~~ — done 2026-09-21. Sandbox account, 3 products (LeadWave Pro/Growth/
  Business) each with a monthly + yearly price matching `PLAN_DEFINITIONS` exactly ($9/90,
  $14/140, $29/290). API key verified live against `sandbox-api.paddle.com/products`.
  Webhook destination created with all 7 events the code handles (6 subscription.* +
  transaction.payment_failed) — **its URL is a placeholder**
  (`https://leadwave-placeholder.ngrok-free.app/webhooks/billing`) since there's no public
  tunnel yet. Once ngrok is running for the Meta webhook, update this destination's URL in
  the Paddle dashboard (Developer Tools → Notifications) to the real ngrok URL +
  `/webhooks/billing` — the webhook secret itself doesn't change when the URL does.
- ~~`REDIS_URL`~~ — done 2026-09-21. Upstash free-tier database "leadwave" (Ohio,
  us-east-2, TLS). Verified with a real SET/GET against it. `pnpm dev:worker` and the
  queue workers, send rate-limit buckets, and Meta/Google/Sheets OAuth `state` should all
  work now — no more need to run `pnpm infra:up`/Docker/WSL for Redis.

**2026-09-29: Upstash free tier (500k commands/month) ran out 3 days after going live**,
with no user traffic. Cause: BullMQ's idle defaults (5s long-poll + 30s stalled check) × 12
queues. Fixed in `apps/api/src/queues/runtime.ts` (`IDLE_OPTIONS`: `drainDelay` 300s,
`stalledInterval` 5 min; commit e43ec51, local, not pushed yet). Plan: move `REDIS_URL` to a
**Render Key Value, Free plan, Oregon, maxmemory `noeviction`** (BullMQ requires it). Render's
form defaults to the $10 plan, so pick $0 explicitly. The free plan has no persistence:
delayed jobs (follow-ups, gate timeouts) are lost if it restarts; the 10-min maintenance
sweep re-expires lost gates.

Note: as of 2026-09-18, Google deprecated `gemini-2.5-flash-lite` for new API keys.
`GEMINI_MODEL_FAST` now uses `gemini-flash-lite-latest` (resolves to `gemini-3.5-flash-lite`)
instead. Updated in both `.env` and `.env.example`.

Note on Meta permissions: the Facebook Login for Business configuration wizard only offers
4 permissions for a **user-token, General** configuration — `pages_show_list`,
`pages_messaging`, `pages_manage_metadata`, `business_management`. It does not offer
`pages_read_engagement`, `pages_manage_engagement` or `pages_read_user_content`, which the
code's `PERMISSIONS` array in `apps/api/src/routes/meta.ts` used to request — trimmed to
match on 2026-09-21. If the comment→DM automation's Graph API calls for reading/replying to
comments start failing with a permissions error during the end-to-end walkthrough, this is
the first place to check — it may mean those calls need to move to a system-user
configuration once a business portfolio exists, or that the equivalent capability now rides
on `pages_manage_metadata` under the current Graph API version (`v21.0`).

`SESSION_SECRET`, `ENCRYPTION_KEY`, `META_WEBHOOK_VERIFY_TOKEN` and `DATABASE_URL` are
already generated and correct.
