# GroupChat — real-time group chat (Node.js · Express · Socket.io · Redis)

[![ci-cd](https://github.com/gurava947/ChatMainFinalApp/actions/workflows/ci-cd.yml/badge.svg?branch=main)](https://github.com/gurava947/ChatMainFinalApp/actions/workflows/ci-cd.yml)

A production-shaped group chat: multi-replica Socket.io servers sharing room state through Redis,
Nginx in front, containerised, autoscaled on Kubernetes, and delivered by a CI/CD pipeline.

The supplied InChat React UI preserves the branded desktop/mobile layout and connects guest session
creation, room history, presence, live messages, gallery/file uploads, location cards, voice notes and
one-to-one audio/video calls to the room backend. It has no account login: a room holds at most two
people — the guest who created it and one partner admitted with a pairing code — and every read, write
and socket join is checked against that room's roster on the server. See
[Rooms, seats and pairing codes](#rooms-seats-and-pairing-codes).
The conversation UI also provides a fit-to-viewport image/video viewer with a minimize action, an audio
waveform player with seeking, playback-speed and download controls, message search by content/type/date,
calendar-day separators, and single-sent/double-delivered/double-read message ticks.
The light/dark switch is persisted locally; dark mode uses deep-black surfaces with contrasting text,
controls, receipt colors and icon states.

## Quick start

```bash
npm ci
# Build the supplied InChat React UI into client/dist/:
npm --prefix client ci
npm run build:client
# Single-process only, and deliberately a development run: the two-seat cap needs
# a shared store to mean anything, and production refuses to boot without one.
NODE_ENV=development USE_MEMORY_STORE=true PORT=3000 npm start
# open http://localhost:3000; the first guest to name a room owns it and is handed a pairing code
# for the second seat. With one process the roster lives in memory, so use a real Redis before
# running more than a single instance.
# For UI development, run `NODE_ENV=development CORS_ORIGIN=http://localhost:5173 USE_MEMORY_STORE=true PORT=3000 npm start`
# in one terminal and `npm run dev:client` in another.

npm run lint && npm test
# Browser E2E: builds client/dist, boots the server on 3101, uses fake media devices
npx playwright install chromium && npm run test:e2e
```

Full stack with Redis, two app replicas and Nginx (needs Docker):

```bash
docker compose up --build
# app via proxy: http://localhost:8080  (redirects to https://localhost:8443)
# self-signed cert is generated at build time inside nginx/Dockerfile
```

To run the app against a real Redis:

```bash
docker compose up -d redis
REDIS_URL=redis://localhost:6379/0 npm start
```

## Directory layout

```
.
├── src/
│   ├── server.js               # bootstrap: http server, Socket.io, Redis adapter, graceful shutdown
│   ├── app.js                  # Express app: security, CORS, rate limits, static, routes
│   ├── config/
│   │   ├── env.js              # zod-validated environment (fails fast on bad config)
│   │   ├── logger.js           # pino, redacts authorization/cookie headers
│   │   └── redis.js            # ioredis primary + pub + sub handles
│   ├── constants.js            # Redis key helpers + socket event names
│   ├── middleware/
│   │   ├── security.js         # helmet + CSP
│   │   ├── rate-limit.js       # express-rate-limit (Redis store) + socket connect/send windows
│   │   └── error-handler.js
│   ├── routes/
│   │   ├── health.js           # /healthz (liveness) and /readyz (store check)
│   │   ├── api.js              # /api/sessions, /api/rooms/:room/messages, /presence, /api/media
│   │   └── media.js            # /media/:id download with HTTP range streaming
│   ├── services/
│   │   ├── chat-service.js     # join/leave, message fan-out, read receipts, presence sweep
│   │   └── media-service.js    # multer upload, magic-number MIME sniffing, expiry sweep
│   ├── store/
│   │   ├── redis-store.js      # messages (list), presence (zset+hash), receipts (set), windows (Lua)
│   │   ├── memory-store.js     # single-process stand-in for local runs
│   │   └── index.js
│   ├── sockets/
│   │   ├── index.js            # session middleware, message/typing/seen/disconnect handlers, heartbeat
│   │   └── calls.js            # same-room WebRTC invite, SDP and ICE signaling
│   └── utils/
│       ├── validate.js         # zod schemas + text sanitiser
│       └── media.js            # mime allowlist, kind classification, safe Content-Disposition
├── client/                     # supplied InChat React/Vite UI, wired to guest room APIs and Socket.IO
├── legacy-ui/                  # logo, and the no-framework client served when client/dist is not built
├── tests/
│   ├── unit/                   # sanitiser, memory store, Redis command shapes (fake client),
│   │                           # and jsdom suites that drive the real client scripts (client-*.test.js)
│   └── integration/            # HTTP API, Socket.io end-to-end, media upload/download, live-Redis contract
├── Dockerfile                  # 4 stages: deps → verify → prod-deps → runtime
├── render.yaml                 # Render blueprint (free web service, Docker runtime, health check)
├── docker-compose.yml          # redis + 2 app replicas (shared uploads volume) + nginx
├── nginx/                      # nginx.conf, conf.d/groupchat.conf, Dockerfile (WS, TLS, cache)
└── k8s/                        # namespace, configmap, secret, redis, storage, app, scaling, networking
```

## How the pieces fit

**Scaling.** Every replica attaches `@socket.io/redis-adapter`, so `io.to(room)` publishes through
Redis and reaches sockets on other pods. Room membership lives in Redis, not in process memory, so
the LoadBalancer/HPA can put a client on any replica.

**Presence.** Each socket is a member of a Redis sorted set scored by last-seen time, refreshed by a
heartbeat every `SOCKET_HEARTBEAT_MS`. A pod that crashes never fires `disconnect`, so entries expire
after `PRESENCE_TTL_MS` and a sweep removes them. `connections` counts sockets, `onlineUsers` counts
distinct identities — one person with three tabs is one user.

**Message history.** Every write takes a room sequence from `INCR chat:messages:seq:<room>` and is stored
as the score of a ZSET member, so ordering comes from the shared store rather than from a clock two
replicas disagree with. A room keeps the newest `MESSAGE_HISTORY_MAX` rows and they live for
`MESSAGE_RETENTION_S`, refreshed on every write — an idle room does not expire its own conversation, which
is what the old `LPUSH`/`LTRIM`/`EXPIRE` cache did. `MESSAGE_CACHE_SIZE` is only how far a linear scan
(poll lookups, id probes) may walk. A history read is one page of `HISTORY_PAGE_SIZE` rows, oldest first,
and `?before=<seq>` returns the page underneath it; the client's "Load older" button uses that cursor.
History still lives in Redis, not a database — swap in a durable store if rows must outlive retention.

**Read receipts.** Each reader's id is added to a per-message Redis set (`SADD` + `EXPIRE` in one Lua
script, so only the *first* read of a message by a user produces a receipt). The receipt is broadcast to
the room with `socket.to(room)`, which excludes the reader, and history reads hydrate `seenBy` so a
reconnect shows the same ticks. On the client an `IntersectionObserver` marks a message seen only when it
is ≥40 % visible in a focused, uncloaked tab, and receipts are batched (≤50 per flush) to keep chatter down.

**Attachments.** The plus icon posts multipart files to `/api/media`; the server stores them under a
server-generated UUID filename (the client's name never touches the filesystem), sniffs the real type
from the first bytes, and keeps metadata in Redis with a TTL plus an expiry index that a sweep drains.
Sending then references those ids, and the send path re-checks that every id belongs to the sender.
Downloads stream from `/media/:id` with manual `Range` support so video and audio seek. Because
`<img>`/`<video>` cannot attach an `X-Session-Id` header, media URLs are unguessable capability links
guarded by the sniffed-type allowlist, `Content-Disposition`, and a `Content-Security-Policy: sandbox`
response — SVG and HTML always download as `attachment`.

**Location and voice.** The plus menu offers photo/video selection, file selection and browser location
sharing. Location is sent only after the guest chooses the action and approves the browser permission;
the room receives coordinates and a user-initiated OpenStreetMap link. The microphone control records a
voice note in the browser, uploads it through the same media pipeline, and sends it as an audio attachment
with bounded duration metadata. The UI accepts up to five files per message; the server's configured
per-file limit and media TTL still apply.

**Audio/video calls.** The phone and camera controls list other guests currently online in the same room
and start a one-to-one call. Socket.IO relays only bounded call signaling (invite, accept, SDP and ICE)
between socket IDs whose sessions are present in that room; audio/video tracks use browser WebRTC directly
between the two guests. The current deployment uses STUN for connection discovery and does not include a
TURN relay. Calls can therefore fail on restrictive corporate networks or symmetric NAT; production
deployments needing broader reach should provision a TURN service and protect its short-lived credentials
server-side. Camera and microphone access require HTTPS (or localhost) and explicit browser permission.

**Traffic control.** Three layers: Nginx `limit_req`/`limit_conn` at the edge, `express-rate-limit`
with a Redis store on `/api/*`, and fixed-window counters (atomic Lua `INCR`+`PEXPIRE`) for socket
connection attempts, per-user sends and receipt marks. The socket send limit answers with an ack
`{ok:false, error:"rate_limited"}`.

**Security.** Helmet CSP (`script-src 'self'`, no inline), explicit CORS origin allowlist, zod
validation on every payload, control characters and complete HTML tags removed server-side, and the
client rendering all message text through `textContent` — never `innerHTML`. Text messages are capped at
50 000 characters (JSON bodies at 1 MB, socket frames at 1 MB); uploads are capped by `MEDIA_MAX_BYTES`
per file and `MEDIA_MAX_PER_MESSAGE` per message, and the declared MIME never overrides the sniffed one.

**HTTP surface.**

| Route | Purpose | Auth |
| --- | --- | --- |
| `GET /healthz` | liveness, no external dependency | public |
| `GET /readyz` | readiness, checks the store | public |
| `POST /api/sessions` | mints a public user id and session bearer token | rate limited |
| `GET /api/sessions/:userId` | lets the authenticated client validate and reuse its identity | `X-Session-Id`, `X-Session-Token` |
| `GET /api/rooms/:room/access` | does this session hold a seat? | session headers |
| `POST /api/rooms/:room/access` | claims a room (no credential) or takes its free seat (with a pairing code) | session headers, pairing code, rate limited |
| `GET /api/rooms/:room/roster` | the room's two seats, for a member | session headers, member only |
| `POST /api/rooms/:room/invite` | replaces the pairing code, dropping any legacy shared password | session headers, owner only, rate limited |
| `GET /api/rooms/:room/messages` | cached history | `X-Session-Id`, `X-Session-Token` |
| `POST /api/rooms/:room/messages` | write path mirroring the socket | `X-Session-Id`, `X-Session-Token` |
| `GET /api/rooms/:room/media` | attachment list behind Recents / Media / Folders | session headers, own self room only |
| `GET /api/rooms/:room/presence` | live roster | session headers |
| `GET /api/me/self` | the caller's private "Note to self" room id | session headers |
| `GET /api/me/note` | the personal note (`{text, updatedAt}`) | session headers |
| `PUT /api/me/note` | replaces the personal note | session headers |
| `GET /api/events` | socket event catalogue + active store, for ops | public |
| `POST /api/media` | multipart upload, returns attachment ids + URLs | session headers |
| `GET /media/:id` | attachment download, supports `Range` | unguessable id |

**Socket events.** Client→server: `message`, `typing`, `stop_typing`, `room:join`, `message:seen`,
`poll:vote`, `call:invite`, `call:accept`, `call:reject`, `call:offer`, `call:answer`, `call:ice`,
`call:restart` and `call:end`. The handshake carries the public user id and the separate bearer token; the id alone is not
an authentication credential. Tokens are random, expire with their session, and only their SHA-256
digests are stored server-side. The client must retain its token to restore its guest session.
Sessions created before this change have no token and must be recreated on the next visit; their
user-specific data remains attached to the old public id and is not transferred automatically.
Server→client: `new_message`, `history`, `presence`, `user_joined`, `user_left`, `typing`,
`stop_typing`, `message_seen`, `poll_voted`, `call:incoming`, `call:accepted`, `call:declined`,
`call:offer`, `call:answer`, `call:ice`, `call:restart`, `call:end` and `system`. Handshake `auth` carries
`{ userId, sessionToken, room, roomCredential? }`.

Every `/api/rooms/:room/*` route runs `assertRoomAccess`, which reads the room's roster, and the socket
path authorizes through the same roster at the handshake and on `room:join` — a socket is never trusted
because it asked before its first packet. That is what keeps another user's `self-<uuid>` room
unreadable and unwritable, and what refuses a third seat; the socket additionally enforces a
`room mismatch` guard, because a socket may only write to the room it joined.

## Rooms, seats and pairing codes

A room's roster is its only membership record:

```
{ room, owner, guest, invite: { salt, hash }, version, createdAt, updatedAt, legacySecret?, migrated }
```

- **Two seats.** `ROOM_MAX_MEMBERS = 2`, counted as `owner` plus at most one `guest`. Both slots live in
  one record, so the cap is a compare-and-set on `version` rather than a read-then-write two replicas
  can both win. Concurrent claimants are retried `ROSTER_CAS_ATTEMPTS` times and the loser gets
  `room_busy` (409) instead of a second seat.
- **Pairing codes.** 8 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — no `0/O` or `1/I/L`, so a
  code read off a screen survives being typed. The server stores only a scrypt hash with a per-room
  salt, never the code. A code is shown exactly once, at the claim, and the owner re-mints it on demand
  from the room's settings; nothing writes it to browser storage. Case and spacing are normalised before
  hashing, so `qcye2y9j` and `QCYE 2Y9J` are the same invitation.
- **Every entry point is the same door.** `POST /api/rooms/:room/access`, the socket handshake's
  auto-join, and `room:join` all call `authorizeRoom`. Reads, writes, presence, receipts, calls and
  status all call `assertRoomAccess`. There is no path that seats a user or serves a room's history
  without consulting the roster.
- **Rotation kills the old secret.** `POST /api/rooms/:room/invite` is owner-only, replaces the invite
  hash, and drops `legacySecret` with it — a leaked code costs one click, not a new room.
- **Migration.** A room that already has history, or a legacy shared password, is claimed by the first
  guest to ask for it: they become the owner, `migrated` is set, and the old shared password is kept as
  `legacySecret` so the *one* remaining seat can still be filled without a code nobody wrote down. The
  answer carries `legacy: true` so the client can say so. Rotating the invite retires it. Rooms that
  were previously open to anybody are no longer readable without a seat.
- **Enumeration.** A room name cannot be probed for membership: `GET /api/rooms/:room/roster` answers
  the same 403 `not_a_member` to a stranger that the room's history does, and only the two seats can
  ask. What does leak is that *claiming* an unused name succeeds where claiming a name that is already
  occupied by a full room returns `room_is_full` — that is inherent to owner-claims-a-new-room, and
  `limiters.writes` bounds how fast anybody can walk it. Refusals distinguish `pairing_code_required`
  from `invalid_pairing_code` because telling a partner "you forgot the code" versus "this room is
  taken" is worth more than the one bit of information an attacker gains.
- **The cap is only real on a shared store, so production requires one.** `USE_MEMORY_STORE=true` keeps
  each process its own roster, so two replicas each hand out two seats and the limit silently doubles.
  That is a misconfiguration, not a degraded mode, so `src/config/env.js` throws at startup when
  `NODE_ENV=production` has no `REDIS_URL` instead of booting and serving traffic with an unenforceable
  cap. A cold start that fails loudly is a visible signal; a room that admits a third person is a
  private-conversation breach nobody notices. `/healthz` reports `sharedStore`, and the UI refuses to
  pretend otherwise.
- **What this does not claim.** Nothing here is end-to-end encrypted. The server holds plaintext
  message text, and pairing codes protect *access*, not content, from the operator. A room's
  conversation is readable by whoever runs the backend.

**Message shapes.** A message is `{ id, room, userId, displayName, text, ts, attachments[], content?,
clientId }`, where `content` is one of:

| `content.type` | Fields | Notes |
| --- | --- | --- |
| `poll` | `question`, `options[]`, `multiple` | votes live in `chat:poll:<messageId>`; history replays the tally |
| `location` | `lat`, `lng`, `accuracy`, `label` | rendered as an OpenStreetMap *link*, not an iframe, so the CSP stays closed |
| `contact` | `name`, `phones[]`, `emails[]` | `tel:` / `mailto:` actions only |
| `event` | `title`, `start`, `end`, `allDay`, `location`, `description` | `end` must be after `start`; the card offers a generated `.ics` file |
| `voice` | `durationMs`, `peaks[]` | requires one audio attachment |

Structured fields run through the same sanitiser as text, so markup is stripped inside a poll option or
an event title too. `clientId` is the idempotency key: a send is claimed with `SET … NX PX` in
`chat:idem:<userId>:<clientId>`, so a retry after a dropped ack returns the stored message with
`duplicate: true` instead of writing it twice.

**Shutdown.** SIGTERM drains: `io.close()` then `server.close()`, with a 10 s cap and a `preStop`
sleep of 8 s in the pod spec so Service endpoints drop the pod before it stops answering.

## Kubernetes

```bash
kubectl apply -k k8s/            # or per-file: namespace, configmap, secret, redis, app, scaling, networking
kubectl -n groupchat get pods,svc,hpa
```

Two app replicas behind a ClusterIP, an optional LoadBalancer, HPA on CPU 60%/memory 75%
(2→12 pods, slow scale-down because sockets are long-lived), a PDB with `minAvailable: 1`,
NetworkPolicies that expose Redis only to the app, and an Ingress with WebSocket upgrade headers.
`k8s/secret.yaml` holds a placeholder — replace it with Sealed Secrets or External Secrets before
you use this anywhere real.

`k8s/storage.yaml` is the ReadWriteMany volume mounted at `/app/uploads`. It is not optional once
attachments are enabled: the root filesystem is read-only, and a pod must be able to read a file another
pod wrote. Point `storageClassName` at an NFS/CephFS/EFS/Filestore class — an RWO block volume will
schedule onto one pod only and every download from the other replica will 404.

## CI/CD (`.github/workflows/ci-cd.yml`)

`quality` (lint, tests, npm audit) and `redis-contract` (the Redis tests against a live service
container) run in parallel. `image` builds with buildx + layer cache, scans the source tree and the
built image with Trivy (fails on CRITICAL/HIGH), and pushes to GHCR with provenance and SBOM.
`cluster-access` then asks whether a cluster is configured; `deploy` runs on pushes to `main` only when
that probe says yes, pins the pod spec to the pushed image **digest**, applies the kustomization, waits
for `rollout status`, smoke-tests `/healthz`, `/readyz` and session creation through the Service, and
rolls back on failure. With no cluster secret the two jobs report **skipped**, not failed - GitHub has
nowhere to deploy to and says so on the run page.

Required secrets: `KUBE_CONFIG_BASE64` (only for the Kubernetes path). `GITHUB_TOKEN` covers GHCR push.

**What GitHub hosts here, and what it cannot.** GitHub runs the pipeline and stores the deployable
artifact: the image lands at `ghcr.io/gurava947/inchatapp/groupchat-realtime:latest` (plus a
`sha-<commit>` tag per push). It does not run the app - Pages only serves static files, and this needs
long-lived WebSockets, Redis and a writable uploads directory. So `deploy` stays skipped until a
`KUBE_CONFIG_BASE64` secret exists, and the runtime is one of:

```bash
docker compose up --build          # anything with Docker; nginx gives you https://<host>:8443
kubectl apply -k k8s/              # a real cluster, RWX storage class set in k8s/storage.yaml
# or the hosted path with no infrastructure of your own: see "Personal deploy" below
```

## Personal deploy (Render + Upstash, no cluster needed)

`render.yaml` is a Render blueprint: connect the repository once and Render reads the service
definition from the repo, so the deploy stays under the same version control as the code.

1. <https://console.upstash.com> → *Create Redis* (free plan) → copy the **Redis URL**, which looks
   like `rediss://default:xxxx@sgp-1-23.upstash.io:6379`. TLS (`rediss://`) is what ioredis expects.
2. <https://dashboard.render.com> → *New → Blueprint* → connect `gurava947/ChatMainFinalApp`. Render lists the
   service in `render.yaml` and asks for `REDIS_URL` because it is marked `sync: false`.
3. Paste the Upstash URL, deploy, open the `https://<name>.onrender.com` link in two tabs. The two tabs
   share rooms, presence and receipts through Upstash even though they land on the same process, and a
   second instance would too - that is the point of the Redis-backed state.

Caveats worth knowing before you rely on it:

- The free Render instance sleeps after ~15 min idle, so the first request cold-starts and any open
  socket reconnects a second later.
- Its disk is ephemeral: attachments are lost on redeploy or restart, while their Redis metadata expires
  after `MEDIA_TTL_S`. Enough for testing; use object storage for anything real.
- Upstash's free plan caps daily requests, and the Socket.io adapter publishes typing and presence
  traffic through it. If you hit the cap, the service has to stop answering until the quota resets -
  `USE_MEMORY_STORE=true` is not an escape hatch on a production deploy, it is refused at startup. Run a
  development-mode instance locally instead if you need to probe the app without Redis.

## Vercel deploy (the path running at `inchat-alpha.vercel.app`)

Vercel can host this, but only with the pieces that make a WebSocket possible there: Fluid compute (the
elastic runtime, required for `@vercel/node` WebSockets), a single function that owns the `http.Server`,
and Redis for anything that has to survive more than one instance.

```bash
vercel link
vercel project update --framework other --node-version 22.x --fluid-compute   # no framework preset
vercel integration add upstash                                                  # creates a database; check which names it writes
vercel deploy --prod
```

What the repo does to fit that model:

- `api/index.js` is the only function. It calls `createRuntime({ listen: false })`, which builds the
  Express app, the Socket.io server and the Redis pools **synchronously** and exports the plain
  `http.Server`; an await at module load is what turns into the `500 FUNCTION_INVOCATION_FAILED` page,
  because the function times out before it can accept the upgrade.
- `vercel.json` rewrites `/(.*)` to that function and keeps `maxDuration: 60`. The rewrite hands the
  original path to Express, so `/api/*`, `/healthz`, `/media/:id` and `/socket.io` all route normally,
  and the SPA in `client/dist` is what answers `/`.
- The static folder is named `legacy-ui/` and **must not be called `public/`**: Vercel serves a root
  `public/` from its own filesystem layer *before* rewrites, so `/` would answer with the old
  no-framework page and the React app would be unreachable even though the function is healthy.
- The production project uses the repository-root Express/Socket.IO backend and Vite frontend, not the
  separate, still-in-development Next.js app under `inchat/`. In Vercel **Settings → Build and
  Development Settings**, set **Root Directory** to `.` (repository root), **Framework Preset** to
  **Other**, **Install Command** to `npm ci --omit=dev && cd client && npm ci`, **Build Command** to
  `npm run build:client`, and **Output Directory** to `client/dist`. The install command depends on
  that root: if the log says `cd: client: No such file or directory`, Vercel is building from the
  wrong root (or using a dashboard override), not a missing folder in this commit. `client/` and its
  committed lockfile are present at the repository root.
- `dist/` is generated and not in git. The root install omits backend development tools; the client
  install includes its locked Vite build dependencies. Set the Vercel Node.js version to 22.x to match
  the root `package.json`.
- No `.npmrc` or `cache-dir` setting is tracked in the repository. The `Unknown env config "cache-dir"`
  npm warning is separate from the missing-directory failure; if it persists, remove the unsupported
  `npm_config_cache-dir` setting from the Vercel project/team environment or build configuration.
- WebSockets are the first transport; a socket lives at most `maxDuration`, then the client reconnects
  and repaints the transcript from Redis. Presence and rooms are rebuilt on that reconnect.
- `REDIS_URL` is what makes two tabs the same conversation, and on Vercel it is also what makes a room
  hold two people. `NODE_ENV` is `production` there, so a deploy without `REDIS_URL` fails at module
  load rather than falling back to the per-instance in-memory store - the function answers
  `500 FUNCTION_INVOCATION_FAILED` until the variable is set. That is the intended failure: the
  fallback used to serve traffic while quietly letting a second isolate seat a third guest. Whichever
  way the database is provisioned, the variable this app reads is `REDIS_URL` in TCP form — see the next
  bullet before blaming the platform.
- Adding Upstash by hand instead of through the integration: `REDIS_URL` has to be the TCP form. The
  console shows `https://<db>.upstash.io` + a REST token first, and those two values
  (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) are read by nothing in `src/`. Measured against a
  live Upstash database with `node scripts/verify-upstash-rest.mjs`: REST answers `PING`, `SET/GET`,
  `HSET/HGETALL`, `ZADD`, `ZREVRANGEBYSCORE … LIMIT`, `INCR`, `SADD`, `EXPIRE`, `SCRIPT LOAD`, `EVALSHA`
  and `PUBLISH`, and refuses `MULTI`, `EXEC` and `SUBSCRIBE` with `501`. The store pipelines a send and
  the Socket.io adapter listens on a subscription, so REST is not a smaller deployment of this app - it is
  a different, incomplete one. What is needed is a value in the form the *Redis CLI* panel prints:
  `rediss://default:<password>@<db>.upstash.io:6379`. On the database used for these measurements that
  password turned out to be the same string the REST console shows, which Upstash accepts on both protocols
  - do not reject a working `rediss://` URL on the theory that the two secrets must differ, and do not
  conclude from it that REST is usable either. Booting with only the REST variable names is refused, so
  the failure says this instead of leaving a `500` with no variable in its message.
- Only `/tmp` is writable, so `UPLOAD_DIR` defaults to `/tmp/uploads` and `MEDIA_MAX_BYTES` to 4 MB on
  Vercel; `CORS_ORIGIN` is derived from `VERCEL_URL`/`VERCEL_PROJECT_PRODUCTION_URL` when unset.
- Cold starts are absorbed rather than returned as errors: `/api` and `/media` check the store on every
  request (`awaitStore`, 5 s ceiling) and answer `503 store_unavailable` when it cannot be reached. The
  check is per request, not per instance, because a function isolate that is frozen between invokes loses
  its Redis sockets; readiness latched at startup would keep a woken instance answering 503 forever. A
  connection failure that lands mid-request is reported as the same retryable `503`, and socket acks carry
  `store_unavailable` so the offline outbox backs off instead of giving up on the message.

To have Vercel build from the repository instead of `vercel deploy --prod` from a working copy, connect it
once in the dashboard - *Project → Settings → Git → Connect to GitHub* → `gurava947/ChatMainFinalApp`, production
branch `main` (the `vercel git connect` CLI does the same thing). Everything the platform needs
(`api/index.js` and `vercel.json`) is in the repo, so a git-driven deploy behaves exactly like the CLI
one. The **Root Directory** and secrets are project-level settings, not repository files. Set `REDIS_URL`
to the TCP connection string before the first deploy, whether the database came from the integration or
from the Upstash console by hand; without it the function cannot load and every request answers
`500 FUNCTION_INVOCATION_FAILED`. Never commit the live Redis URL.

For video calls across restrictive NAT/firewalls, also provision a coturn-compatible TURN service and set
`TURN_URLS` plus its REST-auth `TURN_SHARED_SECRET` in Vercel Environment Variables (Production and Preview).
The app issues ten-minute per-session credentials from `/api/rtc-config`; never put the shared secret in a
`VITE_*` variable or commit it. Without a TURN service the app falls back to STUN, which can work on
permissive networks but cannot relay media through every firewall.

Same ephemeral-disk caveat as Render - attachments live in `/tmp` and vanish with the instance, so point
`MEDIA_*` at object storage before relying on them. For an always-on socket server with no such
constraints, use the Render or Docker/Kubernetes path above.

## Configuration

See `.env.example` for every variable. Notables: `REDIS_URL` (required unless `USE_MEMORY_STORE=true`,
and required even with that set when `NODE_ENV=production`, because the memory store cannot enforce a
room's two seats across processes; on Render it is filled in from the blueprint prompt and
`CORS_ORIGIN` is derived from
`RENDER_EXTERNAL_HOSTNAME`, on Vercel the Upstash integration provides it and `CORS_ORIGIN` is derived
from `VERCEL_URL`), `CORS_ORIGIN` (comma-separated allowlist), `TRUST_PROXY_HOPS` (1 behind Nginx, 2 behind CDN + LB —
get this wrong and both the rate limiter and logs key off the proxy IP), the four rate limits, and the
media block: `UPLOAD_DIR`, `MEDIA_MAX_BYTES` (per file), `MEDIA_MAX_PER_MESSAGE`, `MEDIA_TTL_S`
(how long an attachment stays downloadable). Raising `MEDIA_MAX_BYTES` also means raising
`client_max_body_size` in `nginx/` and `proxy-body-size` in `k8s/networking.yaml`.

## Client notes

No build step, no framework. The composer sends `message` with optimistic render, promotes the node to
the server id on ack, and drives the tick states `⏱ pending → ✓ sent → ✓✓ delivered → ✓✓ seen`.
Long messages collapse after 12 lines with a **Show more** toggle. The theme button flips between the
two shipped themes only (`html[data-theme=dark|light]`, remembered in `localStorage`, defaulting to the
OS preference); message sounds are WebAudio, in-app toasts cover background tabs, and the browser
Notification API is opt-in through the header toggle.

The plus icon opens a bottom sheet - Camera, Document, Poll, Location, Contact, Event - and deliberately
has no Gallery entry, because the file picker already is the gallery and a phone screen cannot spare the
row. Camera and mic have their own buttons beside the input. Camera shots are drawn to a canvas and
re-encoded to JPEG; with **HD media** off (the menu toggle, default) images are downscaled to 1600 px on
the `createImageBitmap` + canvas path first. Voice notes use `MediaRecorder` with a `getUserMedia`
fallback list, a live level meter, and a waveform of at most 48 peaks. Location uses
`navigator.geolocation` and shares a map *link* rather than an embedded frame. Events download a
generated `.ics`.

**Note to self** (`GET /api/me/self`) is a room keyed to the session uuid that only its owner can join;
the header labels it "Note to self" instead of showing the id. The **personal note** is a separate
server-side document (`chat:note:<userId>`, no TTL) so it survives a cleared transcript.

**Offline outbox.** A send that fails on transport trouble, `rate_limited` or `store_unavailable` is kept in
`localStorage['chat:outbox']` under its `clientId` and retried with exponential backoff (1 s base, ×2 per
attempt, 20 s ceiling, 6 attempts, 10-minute lifetime matched to the server's idempotency window). The
bubble stays in place with `⏱ queued` and is promoted by the eventual ack, so a reconnect replays the
queue exactly once; other rooms' entries are untouched, and a non-retryable rejection fails fast instead
of burning the retries.

## Chat settings (P2) — what "per viewer" means here

Rooms have two roles and two seats: the guest who claimed the room is its `owner` and is the only one
who can hand out or replace a pairing code, but that grants no moderation over the conversation itself.
Neither role can delete or edit another guest's messages. Entry is a code from
`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, 8 characters, stored server-side only as a salted scrypt hash; a
guest who presents it is seated for the lifetime of their session. A room with history or a legacy
shared password is claimed by whoever asks for it first, and `GET /api/rooms/:room/roster` says who
holds the seats. Rosters and access grants are stored in Redis (or only in process memory with
`USE_MEMORY_STORE=true`). The four settings a guest can change are stored
**per viewer** under `chat:roomsettings:<userId>:<room>` (plus `chat:blocked:<userId>`) and applied by the
server, not by a client-side courtesy:

- **Block** — `POST /api/me/blocks`. History reads filter the author out, and the live fan-out excludes the
  blocker's personal room (`ChatService.emitLiveMessage` builds `io.to(room).except("u:<userId>")` from the
  shared presence set), so a blocked author's messages never reach that device on **any** replica. Socket
  handles are per-process, which is why the filter is expressed in rooms and not by walking sockets.
  Unblocking re-reads history, which is what brings back the rows the wire had skipped.
- **Clear chat for me** — `POST /api/rooms/:room/clear` stores a `clearedAt` watermark. Old rows stop
  rendering for that viewer; new messages still arrive. Nothing is erased for anybody else.
- **Delete selected messages for me** — `POST /api/rooms/:room/messages/hide` records message ids. Filtered
  before delivery marking, so a hidden row earns no receipt either.
- **Delete chat** — `DELETE /api/rooms/:room`. For a shared room this drops this viewer's settings and the
  device's room entry; the room itself and every other guest's history are untouched. Only **Note to self**
  rooms (`self-<uuid>`, which the session provably owns) are emptied outright via `store.dropRoom`.
- **Chat theme** — `PUT /api/rooms/:room/settings/theme`, allowlisted to the six shipped palettes and
  applied as `chat-theme-*` on the room panel. It is a per-viewer look, not a room-wide skin.

After a guest joins, a hand-written client can still read the room: the server never sends blocked rows
to that viewer's sockets, but any authorized member can read it. Room-level moderation would need roles,
which this app does not have yet.

`scripts/verify-chat-settings-live.js` runs this contract against a live server (16 checks, two guests),
and `tests/integration/chat-settings.test.js` plus `tests/unit/client-chat-settings.test.js` cover it in CI.

## Profiles (P3) — note, picture, and who else can see them

A profile is assembled on read from the keys the session already owns — the note document
(`chat:note:<userId>`), the picture pointer (`chat:avatar:<userId>`) and the session display name — and
`/api/me/profile` returns `{ userId, displayName, note, avatar }`. Neither key has a TTL, so both outlive the
message window.

- **About note** — `PUT /api/me/note` (unchanged from before). The note and the picture are separate keys, so
  saving one never touches the other.
- **Profile picture** — `PUT /api/me/avatar` takes the normal upload route and keeps the first image part;
  anything that is not an image is rejected with the server reason (`a profile picture must be an image`) and
  the rejected bytes are deleted. The pointer stored on the profile is `{ mediaId, mime, size, updatedAt }`,
  and the media record itself is re-saved with a 30-day TTL instead of the short attachment TTL, sliding
  forward whenever the owner reads their own profile — so an active user does not lose their face, while an
  abandoned guest leaves nothing behind forever.
- **Replacing** a picture deletes the previous file; the old `/media/<id>` URL goes 404 immediately.
  **Removing** (`DELETE /api/me/avatar`) drops the pointer and the bytes, and reports
  `{ removed: false }` if there was nothing to remove. The note survives both.
- **Other people's profiles** — `GET /api/profiles?ids=<uuid,…>` (session required, capped at
  `PROFILE_LOOKUP_MAX = 60`, uuid-validated). It returns `{ userId, displayName, avatar }` for every id
  asked, with `null` for unknowns, so the client never has to invent an avatar. The chat list asks for the
  senders it has not seen yet and caches them per room.

`<img>` is only rendered when the server actually has a picture; otherwise the initial fallback is used, so
a guest without an upload never sees a broken image. There is no account system: the "profile" belongs to
the guest session uuid, which means clearing device storage creates a new identity — the same trade-off the
rest of the app makes, documented under *Audited limitations*.

`scripts/verify-profile-live.js` runs this contract against a live server (15 checks, two guests, real
multipart uploads), and `tests/integration/profile.test.js` plus `tests/unit/client-profile-menu.test.js`
cover it in CI.

## Notifications and calls (P5, P6)

- **Desktop notifications** (`client/src/notifications.js`) — permission is asked once, on the first
  message that deserves one, never on load. The rules are device-side and testable: a message notifies
  only when it is not mine, the tab is hidden or another room is open, the room is not muted, the sender
  is not blocked, and the room's quiet hours are not running. `unreadFor` counts what the badge shows.
  Alerts cover the room that is currently open plus incoming calls, because the app keeps one socket per
  open room — a message in a room you have not opened on this device cannot be pushed to you, it is
  counted when the room list is read.
- **Call window** (`client/src/callWindow.js`) — the floating window is one of four modes
  (`docked`, `floating`, `minimised`, `fullscreen`) kept in `localStorage`, so a refresh puts it back where
  you left it. Geometry is pure functions: `clampToViewport` keeps a dragged window on screen even when
  the window shrinks, `resizedFrame` enforces a minimum, `frameStyle` turns the frame into CSS. Signalling
  was already WebRTC through `src/sockets/calls.js` and is untouched.

## Call history (P7)

One record per call id, shared by both guests; the `direction` field is what makes the same row read as
*out* for the caller and *in* for the receiver.

- `GET /api/calls` → `{ calls: [...] }` newest first, capped at `CALL_HISTORY_MAX = 50`, records expire
  after `CALL_RECORD_TTL_SECONDS` (30 days).
- `DELETE /api/calls` clears **this session's index only**. The shared record still shows for the peer —
  a guest cannot erase somebody else's log. Verified: Ben's clear emptied his list and left both of
  Asha's rows (with his name on them) intact.
- A call that was never connected is written as `missed` for the callee and `declined` when it was
  actively turned down; `callHistory.js` turns those into "No answer" / "Missed" / "Declined" per side.
- **Call back** opens the room first, then rings through that room's socket, because calls travel with a
  room. If presence does not report the peer within 5s the row explains there is nobody to call.

Durations read from `durationMs` on the record: `callDurationLabel` floors *after* dividing, so a 12 919 ms
call is `0:12`, and an unconnected call has no duration at all.

## Statuses — the 24-hour Updates tab (P8)

A status is one card that dies on its own. `GET/POST/DELETE /api/statuses` plus
`POST /api/statuses/:id/view` and `GET /api/statuses/:id/viewers`; `STATUS_TTL_SECONDS = 24h`,
`STATUS_MAX_PER_USER = 6`, `STATUS_TEXT_MAX_CHARS = 200`, and the colour must be one of `STATUS_COLORS`
(anything else is a 400, which the client palette is tested against so the picker can only offer
acceptable values).

- **Text card** — a zod discriminated union `{ kind: 'text', text, color }`; the text goes through the same
  `sanitizeText` the messages use.
- **Media card** — `{ kind: 'image' | 'video', mediaId }`, reusing the existing upload route. The server
  re-checks that the media belongs to the session and that its sniffed kind matches, so a video cannot be
  posted as an image. If the file has already been swept, the card says so instead of pointing at a dead URL.
- **Who saw it** is the author's data: `GET /api/statuses/:id/viewers` answers 403 for everyone else.
  A view is recorded the first time a card is opened, and never for the author's own preview.
- **Live** — `status_created` / `status_removed` are global broadcasts, so a card appears and disappears on
  every open Updates tab without a reload. The tab holds a socket with no room in the handshake
  (`connectFeed`), which is the only connection that can hear the global channel.
- Statuses are **guest-wide, not room-scoped**: there is no contact graph or account system, so "who can
  see my status" can only mean "every other guest on this deployment". Rooms do not gate the feed.

## Shorts

`/shorts` is not a separate store. It reads the history of the rooms already on this device
(`GET /api/rooms/:room/messages`, the first 12 rooms), keeps the `video/*` attachments, dedupes them by
media id, and plays only the clip that is in frame — muted, until the reader presses *Sound on*, because a
browser will not start an audible clip that no click asked for. History rows carry only the attachment id,
so the playable URL is built as `/media/<id>` (the same contract `MessageAttachment` uses). When there are
no videos the page says so; nothing is invented.

`client/src/shortsFeed.js` holds that harvest as pure functions, and
`tests/unit/client-shorts.test.js` pins the ordering, dedupe, cap and the empty state.



- Redis: enable auth + TLS (`rediss://`) and put it behind a managed HA offering; the sample runs
  single-node with no password.
- Identity: guest sessions are protected by a random bearer token separate from the public UUID. The
  browser receives it once as an HttpOnly, SameSite=Lax cookie and never in the response body, so page
  scripts cannot read it. API tooling opts in with `X-Session-Transport: token` and may then present
  `X-Session-Id` + `X-Session-Token`. This is not a verified login - add real authentication
  (OIDC/JWT) if accounts are required.
- Durability: history is cache-only. Add a database write path if messages must survive eviction.
- Attachments: files live on the local disk (or the RWX volume) with a TTL. Object storage (S3/GCS
  with signed URLs) is the right move once volume size or egress matters, and virus scanning belongs in
  front of any file a user can download.
- TLS: replace the build-time self-signed certificate with cert-manager/Let's Encrypt.
- Observability: `/metrics` publishes Prometheus counters (HTTP by route template, messages sent,
  socket connections, uploads) and a live socket gauge, enough to drive an HPA on connection count.
  Production requires `METRICS_TOKEN` before the endpoint answers; scrape with
  `Authorization: Bearer <token>`. See `docs/operations.md` for the scrape config and the pairing-code
  rate limit.

**Deliberately not here.** Kafka and end-to-end encryption are not implemented. Redis already carries
the fan-out that a queue would, and the send path is idempotent, so a future Kafka bridge can be added
as a consumer of `new_message` without touching clients. Calls are browser-to-browser WebRTC: the
server only relays SDP and ICE over the authenticated socket, and media never touches it. That works
without extra infrastructure on the same network; a TURN service (`TURN_URLS` + `TURN_SHARED_SECRET`)
is what makes it work across restrictive NATs. If E2EE becomes a requirement, build it on an
established scheme (libsignal/MLS) - not on a hand-rolled cipher.

## Audited limitations (from the P0/P1 review)

These are documented rather than papered over. None of them needed an architectural change, and the
fixes below are the ones that did.

**B1 - delivery receipts are real now.** A tick used to advance to "delivered" whenever more than one
socket was online, which told the sender something the server had never observed. Delivery is now a
receipt like "seen": the receiving device emits `message:delivered` when `new_message` reaches it, a
history read (`GET /api/rooms/:room/messages` or a socket join) counts as delivery for the reader, and a
read implies delivery because those bytes demonstrably reached the device. `store.markDelivered` returns
whether the user was newly recorded, so repeated reports are absorbed instead of re-broadcast. Online
presence can no longer produce a delivery tick - see `tests/integration/delivery.test.js` and
`scripts/verify-delivery-live.js`, which assert that a silent online peer is never marked delivered.

**B2 - room history is a bounded cache, not a transcript.** `MESSAGE_CACHE_SIZE` keeps the newest 200
messages per room in Redis (default TTL `MESSAGE_TTL_SECONDS`), and both the HTTP route and a socket join
hand back at most 50 of them. Old messages are evicted silently: a room that has been busy for days will
show the recent tail, not the whole conversation, and a rejoin cannot scroll further back. This is a
storage decision, not a bug in the read path - a durable transcript needs the database write path listed
under "Before calling it production", plus paging on the route. Receipts (`deliveredTo`, `seenBy`) ride
along with whatever history is still cached, so they disappear with the message, not before it.

**B3 - the guest menu performs real actions.** "My profile & about" reads and writes the server-side note
at `/api/me/note` (survives a reload, scoped to the session), "Rooms on this device" copies a room id or
removes it from `localStorage` only, and "Sign out of this device" clears the guest keys behind an
explicit confirm. Removing a room does not delete it for anyone else, and the sheet says so.

**B5 - the in-memory store is single-replica.** `USE_MEMORY_STORE=true` keeps rooms, presence, receipts
and room rosters in one process's Maps: restart the server and everything is gone, two replicas cannot
see each other, and the socket adapter is likewise in-memory. `k8s/`, `docker-compose.yml` and the
Render/Vercel paths all expect Redis, so this mode is for local work only - and `NODE_ENV=production`
refuses to start without a `REDIS_URL` rather than trusting that only one process will ever run. The
startup log says the mode out loud rather than letting the first restart be the discovery.

**Other things worth knowing.** `GET /api/events` is unauthenticated on purpose (it publishes event names
and size limits, nothing user-owned). Calling is WebRTC signalling relayed over sockets with STUN only -
no TURN, so peers behind symmetric NAT cannot connect. The call log (P7) keeps the last 50 records for
30 days, which is a history of *calls*, not a recording of them: nothing about the audio or video is
stored. Guests are identified by an unguessable session UUID, not an account password. A room is reachable
only by the two guests its roster names, over HTTPS/WSS in production; the status feed is the one surface
that is deliberately shared across a guest's rooms rather than gated by a seat.
