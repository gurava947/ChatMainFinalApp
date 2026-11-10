# Architecture: signaling, TURN, and the free-tier budget

This page describes the call path as deployed on Vercel Hobby with the existing
Redis (Upstash Free) as the only shared store. There is no paid signaling
vendor, no second realtime service, and media is never proxied through the
server.

## Signaling: live relay first, mailbox second

Socket.io remains the signaling transport. `src/sockets/calls.js` validates each
signal, checks that the recipient still holds a seat in the same room, and
relays it live with `io.to(peer.socketId).emit(...)`. The Redis adapter
(`chat-socketio`) carries room membership across isolates.

A Vercel isolate can freeze or recycle between the live emit and the peer
actually receiving it, so every `call:offer`, `call:answer`, and `call:ice` is
also copied into a short-lived Redis mailbox:

```text
key:   chat:call:signal:{callId}:{recipientUserId}
type:  LIST of JSON envelopes
ttl:   60 seconds, refreshed on every append
cap:   128 entries (LTRIM -128 -1)

envelope: {
  kind: "description" | "candidate",
  description?: { type, sdp },
  candidate?: RTCIceCandidateInit,
  room, fromSocketId, fromUserId, fromDisplayName, ts
}
```

A new description starts a new ICE generation: the append script deletes the
old list in the same atomic write, so candidates gathered for a previous offer
are never replayed against a new one. `deriveMailbox()` reads the list back as
`{ description, candidates[], fromSocketId, fromUserId, expiresAt }`; the
candidates are the ones appended after the newest description.

`call:resume { callId }` reads the same key for the asking user. The handler
authorizes against the call record (same room, live status, participant), then
emits `call:mailbox` with the peer's **current** socket id resolved from
presence. The client applies the replayed description through the same
offer/answer path it uses for live signals and feeds the candidates through the
same ICE queue. `call:end` and `call:reject` clear both participants' mailboxes;
anything else expires after 60 seconds. A mailbox write failure is logged and
counted but never fails the live signal.

The mailbox is a replay buffer, not a message queue: it holds one SDP generation
per recipient, it is keyed by user id so a reconnect changes the socket but not
the box, and it stores no media.

## Vercel transport: verified, with polling as the fallback

Checked against production on 2026-11-10:

```bash
vercel curl "/socket.io/?EIO=4&transport=websocket" \
  --deployment https://chat-main-final-app.vercel.app -- \
  -D - -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
# HTTP/1.1 101 Switching Protocols

vercel curl "/socket.io/?EIO=4&transport=polling" \
  --deployment https://chat-main-final-app.vercel.app
# 0{"sid":"...","upgrades":["websocket"],"pingInterval":25000,...}
```

WebSocket upgrades are served, so the server keeps
`transports: ['polling', 'websocket']` and the client keeps the engine default
(polling handshake, then upgrade). **Forced polling is not enabled.**

If a future deployment or proxy stops serving the upgrade, polling still works
but has a hard cap: `vercel.json` sets `maxDuration: 60` on `api/index.js`, so a
long-poll cannot outlive the function, and every poll GET/POST is a separate
invocation against the Hobby allowance. Watch
`chat_call_setups_total{transport="polling"}` and the Vercel invocation counter;
a sustained polling share is the signal to either fix the upgrade path or
accept the invocation cost. Do not add a paid signaling service to work around
it.

## TURN: short-lived credentials, explicit relay-less failure

`src/utils/rtc-config.js` mints coturn REST credentials with HMAC-SHA1:
`username = "{expiresAt}:{userId}"`, `expiresAt = now + 600s`, credential
derived from `TURN_SHARED_SECRET` (server-only, minimum 16 characters). The
browser receives the username/credential for 10 minutes and never the shared
secret. With no `TURN_URLS`/`TURN_SHARED_SECRET`, the client falls back to
`stun:stun.l.google.com:19302` only.

What fails without TURN:

- Symmetric NAT on either side (common on mobile carriers and corporate LANs).
- Networks that block UDP or allow only TCP/443 egress.
- Any pair where STUN discovers no usable direct candidate pair.

Those calls fail with the explicit client message: "The media path could not
connect. This network may require a TURN relay; check the deployment ICE/TURN
configuration." The recovery ladder exhausts ICE restart and rebuild first, so
the message appears only after the direct path is genuinely gone.

Detection:

- `chat_call_media_path_total{path}` gives the relay ratio:
  `relay / (relay + direct)`. A rising ratio means more calls depend on TURN.
- `chat_call_setups_total{outcome="failed",transport}` counts setups that never
  reached media, split by signaling transport.
- `chat_call_resume_total{outcome}` and `chat_signal_mailbox_total{op}` show
  whether reconnects are replaying signals or hitting an empty/error mailbox.

The operational choice is binary: self-host coturn (or another relay) and set
`TURN_URLS` + `TURN_SHARED_SECRET`, or explicitly accept that restrictive-NAT
calls fail. There is no paid signaling or media proxy in either branch.

Decision (2026-11-10): a relay is deployed. coturn runs on a self-hosted
Ubuntu EC2 instance in Mumbai under the AWS Free plan credits, configured with
`use-auth-secret` + `static-auth-secret` (the same secret stored as
`TURN_SHARED_SECRET` in Vercel production; `TURN_URLS` points at its public IP
on port 3478) and `denied-peer-ip` covering the RFC1918 and loopback ranges so
the relay cannot be aimed at private networks. Two AWS specifics matter: the
instance only sees its private IP, so `turnserver.conf` carries
`external-ip=<public-ip>/<private-ip>` or every relay candidate advertises an
unreachable address; and the security group must open TCP+UDP 3478 plus the
relay UDP range (49152-49252 here). Verified end-to-end from a real browser on
the public internet: production `/api/rtc-config` returned short-lived
credentials and ICE gathering produced a `typ relay` candidate on the public
IP. The Free plan expires six months after signup (~2027-05); if the instance
goes away the app degrades to STUN-only and restrictive-NAT calls fail with
the explicit message above — re-provision coturn anywhere and the same two env
vars restore the relay.

## Free-tier budget

Allowances verified 2026-11-10 against [Vercel Hobby](https://vercel.com/docs/plans/hobby)
and [Upstash Redis pricing](https://upstash.com/pricing/redis). Hobby is
non-commercial/personal use; exceeding a limit generally pauses the feature
until the 30-day window rolls.

| Resource | Free allowance | Warn (70%) | Alarm (90%) |
| --- | --- | --- | --- |
| Vercel function invocations | 1,000,000 / month | 700,000 | 900,000 |
| Vercel Active CPU | 4 CPU-hrs (14,400 CPU-s) | 2.8 CPU-hrs | 3.6 CPU-hrs |
| Vercel Provisioned Memory | 360 GB-hrs (1,296,000 GB-s) | 252 GB-hrs | 324 GB-hrs |
| Vercel Fast Origin Transfer | 10 GB / month | 7 GB | 9 GB |
| Vercel Fast Data Transfer (CDN) | 100 GB / month | 70 GB | 90 GB |
| Vercel CDN requests | 1,000,000 / month | 700,000 | 900,000 |
| Upstash Redis commands | 500,000 / month | 350,000 | 450,000 |
| Upstash Redis data size | 250 MB | 175 MB | 225 MB |
| Upstash Redis bandwidth | 10 GB / month | 7 GB | 9 GB |

`maxDuration` is 60s in `vercel.json` (Hobby allows up to 300s, but the call
path does not need more). Static assets are immutable-cached, so repeat visits
draw on CDN transfer rather than origin transfer.

Redis command budget: a call writes one mailbox entry per offer/answer/ICE
candidate (typically 6-12), one clear on end/reject, zero-to-two resume reads,
plus the call-history record/index writes. Signaling alone is roughly 20-40
commands per call; presence heartbeats, history reads, and rate-limit windows
are the larger share. At 500K commands/month the alarm threshold is reached
long before storage is, so command rate is the metric to watch.

Scrape `/metrics` (Bearer `METRICS_TOKEN` in production) and aggregate across
replicas; counters are per-process. Example queries:

```promql
# TURN relay ratio over the last hour
sum(rate(chat_call_media_path_total{path="relay"}[1h]))
/
sum(rate(chat_call_media_path_total{path=~"relay|direct"}[1h]))

# Failed setups by signaling transport
sum by (transport) (rate(chat_call_setups_total{outcome="failed"}[1h]))

# Mailbox errors and reconnect retries
sum(rate(chat_signal_mailbox_total{op="error"}[15m]))
sum(rate(chat_signal_mailbox_total{op="read"}[15m]))
```

## Phase 5 gates

1. A call between two different networks connects through the mailbox and,
   when the direct path fails, through TURN. The e2e suite exercises a signaling
   drop mid-call and asserts both sides return to connected with one history row.
2. No paid signaling service appears in the deployment; cost stays inside the
   Hobby + Upstash Free allowances above.
3. This document lists what fails without TURN and how to detect it.