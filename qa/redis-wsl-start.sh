#!/bin/bash
# Starts the unpacked Redis on every interface so the Windows host can reach it
# through the WSL address. No persistence: this is a test fixture, and RDB
# snapshots would only hide how little survives a restart.
set -u
exec "$HOME/.local/share/inchat-redis/redis" \
  --bind 0.0.0.0 \
  --port "${REDIS_PORT:-6379}" \
  --protected-mode no \
  --save '' \
  --appendonly no \
  --maxmemory-policy noeviction \
  --dir /tmp
