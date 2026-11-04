# InChat

Real-time messaging on Supabase (Postgres, guest sessions, Realtime, Storage) with a Next.js App Router
front end on Vercel. It is being built alongside the current Express/Socket.io app in this
repository, which stays live until InChat reaches feature parity.

## What works today

- Supabase schema and security as migrations in `supabase/migrations/` (profiles, conversations,
  messages, receipts, attachments, settings; RLS policies; definer RPCs for every write; private
  storage bucket; realtime publication).
- Guest access: no login, email, password or social-account screens. Visitors choose a display name
  and username; the app creates a passwordless Supabase anonymous session so existing RLS policies
  can safely authorize rooms, messages, receipts and attachments.
- CHATS tab: conversation list from `list_my_conversations` with unread counts and mute state.
- The four tabs (Chats, Updates, Communities, Calls) are routed; Updates/Communities/Calls are
  honest placeholders until their phases.

The app runs with **no** Supabase project configured: every page then renders a notice naming the
variables to set instead of an error page, and `npm run build` still succeeds.

## Local setup

```bash
cd inchat
npm ci
cp .env.example .env.local     # then fill in the real values
npm run dev                    # http://localhost:3000
```

| Variable                        | Where it comes from                                   |
| ------------------------------- | ----------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project → Settings → API                      |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page (public key; RLS still applies)              |
| `SUPABASE_SERVICE_ROLE_KEY`     | server-only, never imported by client code             |
| `DATABASE_URL`                  | Supabase → Database → Connection string (migrations)   |

Apply the migrations with the Supabase CLI (`. /supabase/migrations` in the project dir):

```bash
supabase link --project-ref <ref>
supabase db push
```

In the Supabase dashboard, enable **Anonymous Sign-Ins** under Authentication sign-in providers.
No SMTP, email confirmation, password, or social-login provider is needed. The guest session is
created automatically after the visitor chooses a display name and username; room membership and
message permissions continue to be enforced by RLS.

## Verification

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest (chat repositories, realtime, composer and message handling)
npm run verify:sql  # migrations parsed by the real PostgreSQL grammar + rule gate
npm run build       # production build with no credentials present
```

`verify:sql` runs `scripts/check-sql.cjs` twice: first `--self-test`, which proves the
checker itself still detects each planted violation class, then the migration set. The rules
it enforces are the ones Supabase's guidance calls out - `auth.uid()` must be written as
`(select auth.uid())` inside policies and SQL functions so the JWT is read once per query,
every policy names the role it applies to, every function pins its `search_path`, and every
function appears in the privilege array instead of keeping the default PUBLIC execute grant.

`.github/workflows/ci-cd.yml` runs all five as the `InChat (Next.js) quality gates` job. Schema
semantics (RLS row filtering, trigger behaviour, query plans) can only be proven against a live
project; run `supabase db push` plus the RLS probes once credentials exist.
