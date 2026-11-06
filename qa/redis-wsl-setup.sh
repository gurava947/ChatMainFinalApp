#!/bin/bash
# Assembles a Redis that runs in WSL Ubuntu 24.04 without root: the server's
# .deb plus the shared libraries it links against are unpacked into one tree
# and started through a wrapper that points the loader at that tree.
#
# Two fetch routes, because neither covers every package: `apt-get download`
# needs no root but fails on packages the local index still lists at a
# superseded version, and the archive pool listing is current but its directory
# is not derivable from the package name.
set -u
WORK="$HOME/.local/share/inchat-redis"
ROOT="$WORK/root"
WRAPPER="$WORK/redis"

mkdir -p "$WORK"
cd "$WORK" || exit 1

if [ -x "$WRAPPER" ] && "$WRAPPER" --version 2>&1 | grep -q "Redis server v="; then
  echo "ALREADY_PRESENT: $("$WRAPPER" --version | head -1)"
  exit 0
fi

BASES="http://archive.ubuntu.com/ubuntu http://security.ubuntu.com/ubuntu"

# apt package | pool directory | filename prefix (empty prefix = accept any)
PACKAGES="
redis-server | universe/r/redis | redis-server_7.0.15-1ubuntu0.24.04
redis-tools | universe/r/redis | redis-tools_7.0.15-1ubuntu0.24.04
liblzf1 | | 
libatomic1 | | 
libjemalloc2 | | 
"

rm -rf "$ROOT"
mkdir -p "$ROOT"

from_apt() {
  apt-get download "$1" >/dev/null 2>&1 && ls "$1"_*.deb 2>/dev/null | sort | tail -1
}

from_pool() {
  # Newest amd64 build whose name carries the prefix.
  local dir="$1" prefix="$2" base name
  for base in $BASES; do
    name=$(curl -s "$base/pool/$dir/" | grep -o "[^\"<>]*amd64\.deb" | grep -F "$prefix" | sort -u | tail -1)
    [ -n "$name" ] || continue
    curl -sfL -o "$name" "$base/pool/$dir/$name" && printf '%s' "$name" && return 0
  done
  return 1
}

while IFS='|' read -r pkg dir prefix; do
  pkg=$(echo "$pkg" | xargs)
  [ -n "$pkg" ] || continue
  dir=$(echo "$dir" | xargs)
  prefix=$(echo "$prefix" | xargs)

  deb=$(from_apt "$pkg")
  if [ -z "$deb" ] && [ -n "$dir" ]; then
    deb=$(from_pool "$dir" "${prefix:-$pkg}")
  fi
  if [ -z "$deb" ] || [ ! -s "$deb" ]; then
    echo "MISSING: $pkg"
    continue
  fi
  dpkg-deb -x "$deb" "$ROOT" && echo "extracted: $deb"
done <<HERE
$PACKAGES
HERE

LIBDIRS=""
for candidate in "$ROOT/usr/lib/x86_64-linux-gnu" "$ROOT/lib/x86_64-linux-gnu"; do
  [ -d "$candidate" ] && LIBDIRS="$LIBDIRS$candidate:"
done

for ELF in "$ROOT/usr/bin/redis-server" "$ROOT/usr/bin/redis-check-rdb"; do
  [ -f "$ELF" ] || continue
  TARGET="$ELF"
  if [ "$ELF" = "$ROOT/usr/bin/redis-check-rdb" ]; then
    # argv[0] picks the mode, so the multi-call ELF must not keep the
    # "check-rdb" name or it starts the RDB checker instead of the server.
    cp "$ELF" "$ROOT/usr/bin/redis-server-renamed"
    TARGET="$ROOT/usr/bin/redis-server-renamed"
  fi
  out=$(LD_LIBRARY_PATH="$LIBDIRS" "$TARGET" --version 2>&1 | head -1)
  echo "probe: $(basename "$TARGET") -> $out"
  case "$out" in
    *"Redis server v="*)
      {
        echo '#!/bin/bash'
        echo "export LD_LIBRARY_PATH=\"$LIBDIRS\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\""
        echo "exec \"$TARGET\" \"\$@\""
      } > "$WRAPPER"
      chmod +x "$WRAPPER"
      echo "WORKING: $("$WRAPPER" --version | head -1)"
      exit 0
      ;;
  esac
done

echo "NO_USABLE_BUILD"
exit 1
