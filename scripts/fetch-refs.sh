#!/usr/bin/env bash
# Стягивает референсные репозитории в refs/ на ревизии из refs/refs.lock (только чтение, код не исполняется).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
grep -v '^#' "$root/refs/refs.lock" | while read -r name url rev; do
  [ -n "$name" ] || continue
  dir="$root/refs/$name"
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  git -C "$dir" fetch -q --depth 1 origin "$rev"
  git -C "$dir" checkout -q --detach FETCH_HEAD
  echo "$name @ $(git -C "$dir" rev-parse --short HEAD)"
done
