# ProQure

AI-assisted procurement platform for UK trades contractors. A multi-tenant SaaS where
engineers, buyers, managers and operators raise requests, gather and compare supplier
quotes, run hire and orders, and generate handover packs — with each company's data
isolated in its own tenant.

- **App:** https://app.proqure.co.uk
- **Marketing site:** https://proqure.co.uk
- **Status:** Live (multi-month trial)

## Stack

- **Frontend** — React 18 + Vite, a single-file app (`procurement-dashboard.jsx`), shipped as an installable PWA (iOS + Android)
- **Backend** — Vercel serverless functions (`api/`)
- **Data & auth** — Supabase (Postgres + Auth); tenant isolation enforced by Postgres row-level security
- **Email** — Resend (outbound transactional + inbound reply capture)
- **Payments** — Stripe
- **AI** — OpenRouter, via a server-side proxy

## Repository layout

| Path | What it is |
|------|------------|
| `procurement-dashboard.jsx` | The application (one large React component) |
| `App.jsx`, `main.jsx`, `index.html` | App shell, entry point, PWA meta |
| `api/*.js` | Serverless functions (see table below) |
| `lib/notify-mail.js` | Shared email helper |
| `notify-policy.js` | Notification category rules |
| `feature-flags.js` | Feature registry / per-tenant overrides |
| `public/` | PWA manifest, service worker, icons, splash screens, offline page, `admin.html` |
| `db/` | Database migrations — the live security model in version control (see `db/README.md`) |
| `vercel.json` | Response headers, CORS, cron schedule |

## Deploy

The app **auto-deploys on push to `main`** via Vercel (~30s). Changes are made through the
GitHub web UI — pencil-edit for existing files, *Add file → Create new file* for new ones —
and committed as complete whole files. There is no separate release step.

## Serverless functions

| Endpoint | Purpose |
|----------|---------|
| `ai` | Proxies AI requests to OpenRouter; per-plan budget cap + trial-expiry gate |
| `licence` | Self-serve trial signup (honeypot, optional key, Turnstile, disposable-mail + IP throttle) |
| `create-checkout-session` / `create-portal-session` | Stripe checkout + billing portal (MFA-gated) |
| `stripe-webhook` | Stripe → `proqure_billing` sync (server-only) |
| `send-email` | Outbound mail via Resend |
| `inbound` / `resend-webhook` | Inbound supplier replies + Resend delivery events |
| `notifications` | Admin Centre notifications (MFA-gated) |
| `notify-digest` / `notify-sweep` / `retention-sweep` | Scheduled crons (digest 08:00, sweep 07:00, retention 03:00) |
| `admin` / `admin-metrics` / `admin-health` | Admin console (email allow-list + MFA + rate-limit) |

## Environment variables

Configured in Vercel — names only, no values.

**Server-side only (secret):**
`SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` (per plan + add-on blocks),
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `CRON_SECRET`, `LICENCE_SIGNUP_KEY`,
`TURNSTILE_SECRET_KEY`, `ADMIN_CONSOLE_EMAILS`, `INBOUND_CAPTURE_DOMAIN`,
`INBOUND_SKIP_VERIFY`

**Client-exposed (`VITE_` prefix — non-secret by design):**
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_INBOUND_CAPTURE_DOMAIN`

Only the Supabase URL, the anon key and the inbound-capture domain are exposed to the
browser; every provider secret stays server-side.

## Security model

Tenant isolation and the within-tenant role rules are enforced **in the database**
(row-level security, SECURITY DEFINER guard functions, and triggers), not only in the
app. The complete model is reproducible from `db/` — see `db/README.md`. The browser
holds only the Supabase anon key plus the signed-in user's JWT; it never holds a
provider secret and never calls the privileged database RPCs directly.

## Local development

```bash
npm install
npm run dev      # Vite dev server
npm run build    # production build
```

Running locally needs the environment variables above and a Supabase project; without
them the serverless functions short-circuit safely rather than erroring.
