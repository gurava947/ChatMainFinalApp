# Operations

Short runbook for the Express + Socket.io app in this repository. Anything that
needs a value lives in `.env.example`; this page explains what the values buy.

## Running locally

Two processes, two origins:

```bash
# terminal 1 - API + sockets on http://127.0.0.1:3000
cp .env.example .env
# set USE_MEMORY_STORE=true for a Redis-free single process
npm install
npm start

# terminal 2 - React client on http://127.0.0.1:5173
npm --prefix client install
npm run dev:client
```

Vite proxies `/api` and `/socket.io` to port 3000, so the browser sees one
origin in development. For a production-shaped check, `npm run build` writes
`client/dist`, and `npm start` serves it from the same port as the API.

A memory-store process holds rooms in its own heap: two instances started
without Redis cannot see each other's rooms. Cross-instance fan-out, presence
and the shared limiter need `REDIS_URL` (Upstash TCP or any managed Redis).

## Browser E2E

`npm run test:e2e` builds `client/dist`, starts the server on
`127.0.0.1:3101` with `USE_MEMORY_STORE=true`, and drives two isolated Chromium
contexts through the whole path: create a room, mint a pairing code, take the
second seat, exchange messages, reload for history, then place an audio call and
assert both sides reach "Audio connected". Chromium's fake media devices supply
the microphone. Traces and video for failures land in `test-results/`; the CI
`e2e` job uploads them as an artifact.

## Sessions

- `POST /api/sessions` sets `inchat_session=<userId>.<token>` as `HttpOnly`,
  `SameSite=Lax`, `Path=/`, `Max-Age=SESSION_TTL_S`, and `Secure` when
  `NODE_ENV=production`. The token does not appear in the JSON body, so page
  scripts cannot read it. Clients that authenticate with headers instead of a
  cookie jar opt in with `X-Session-Transport: token` and receive it in the
  body on that one response.
- `DELETE /api/sessions/current` expires the cookie (204). The client calls it
  before clearing local state.
- API clients that cannot store cookies may send `X-Session-Id` and
  `X-Session-Token` instead. This is a tooling and test path, not a second
  product surface.
- Socket.io reads the same cookie during the handshake; the auth payload
  carries the room, not the credential.

Rotating the secret is a session invalidation event: `SESSION_TTL_S` bounds how
long an issued token lives, and the store owns the token record.

## Rate limits

| Variable | Scope |
| --- | --- |
| `RATE_LIMIT_API_MAX` | all HTTP routes per address |
| `RATE_LIMIT_SEND_MAX` | message sends per member |
| `RATE_LIMIT_SESSION_MAX` | session creation per address |
| `RATE_LIMIT_SOCKET_CONNECT_MAX` | socket handshakes per address |
| `RATE_LIMIT_ACCESS_MAX` | pairing-code attempts per room **and** address |

The pairing-code budget is deliberately separate from the generic API budget:
guessing a wrong code is cheap for the attacker, and a shared bucket would let
one room's attacker exhaust another room's budget. Claims and re-entries of a
room you already belong to do not spend it, so the default of 30 per minute is
generous for real members and small for enumeration.

## Metrics

`GET /metrics` returns Prometheus text. In production the endpoint is closed
unless `METRICS_TOKEN` is set (16+ characters); it then requires
`Authorization: Bearer <token>`. In development and test it stays open, which
keeps the test suite and local scraping simple.

| Metric | Type | Labels |
| --- | --- | --- |
| `chat_http_requests_total` | counter | `method`, `route`, `status` |
| `chat_messages_sent_total` | counter | - |
| `chat_socket_connections_total` | counter | - |
| `chat_active_sockets` | gauge | - |
| `chat_media_uploads_total` | counter | - |

`route` is the Express route template (`/api/rooms/:room/messages`), never the
concrete id, so label cardinality stays bounded by the route table. Unmatched
requests are labelled `unmatched`.

Example scrape config:

```yaml
scrape_configs:
  - job_name: inchat
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['chat.example.com']
```

Scale on `chat_active_sockets` (or connections per pod) rather than CPU if the
cost you are tracking is connection count. Counter/gauge values are
per-process; aggregate across replicas in the query.

## Health

- `GET /healthz` - process is up.
- `GET /readyz` - Redis (or the in-memory store) answers; wire this to the
  readiness probe and keep `/healthz` on liveness so a Redis blip does not
  restart every pod.
