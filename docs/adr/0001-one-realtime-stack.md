# 0001 - Keep one realtime stack in production

- Status: accepted
- Date: 2026-11-09

## Context

The repository contains two applications:

1. `src/` + `client/` - Express 4, Socket.io 4 with the Redis adapter, a React
   client, guest sessions, two-seat rooms and WebRTC call signalling.
2. `inchat/` - a Next.js 16 + Supabase rewrite with Postgres, RLS, Storage and
   Realtime.

Both implement the same product. Running both against real traffic would mean
two session models, two authorization paths, two rate-limit implementations and
two places to fix every bug. The review that produced this repository's backlog
also showed the Supabase path cannot be exercised in the current environment
(no Docker, no local Supabase CLI, no database or object-storage endpoint), so
its migrations, RLS policies and Realtime subscriptions are reasoned about but
untested here.

## Decision

`src/` + `client/` is the production stack. `inchat/` stays in the repository as
a working prototype and a migration reference, but it is not deployed and does
not receive production-only changes.

The Express stack keeps Redis for fan-out and ephemeral history, local disk (or
an RWX volume) for media, and HTTP-only cookies for the guest session. Postgres
persistence and object storage are explicitly deferred until a deployment needs
them; both have a seam (`store` interface, `media` service) where they can be
added without changing client contracts.

## Consequences

- One set of client contracts, one authorization path, one set of tests.
- History is cache-only: rows survive as long as Redis retention allows, not
  forever. A durable store is a new implementation of the existing `store`
  interface, not a rewrite.
- Media shares a filesystem between replicas. Multi-node deployments need a
  ReadWriteMany volume; object storage remains the long-term answer.
- `inchat/` may drift. Treat it as a design reference, and delete it when a
  migration is either committed to or abandoned rather than letting it rot
  silently.
