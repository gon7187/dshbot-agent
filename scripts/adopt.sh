#!/usr/bin/env bash
# ExecStartPre of dshbot.service (DESIGN §8.3): adopt an accepted candidate or roll
# back a live checkout that keeps crashing.
#
# The daemon writes DSHBOT_HOME/adopt.json and exits 42 when the owner presses
# Accept. The service then starts again, this script moves the branch `live` to the
# adopted sha and consumes adopt.json. A start that survives 60 s without a crash is
# tagged `stable` by the daemon and resets the fuse. Three starts that never became
# healthy within 120 s mean the adopted code is broken: the branch goes back to
# `stable` and a rollback notice is left for the daemon to send to the owner.
#
# State lives in DSHBOT_HOME/evolve-state as key=value lines, so no JSON parser is
# needed here. Nothing from the checkout is executed; only git and coreutils run.

set -u

home="${DSHBOT_HOME:-}"
if [ -z "$home" ]; then
  echo "adopt.sh: DSHBOT_HOME is required" >&2
  exit 1
fi

state_file="$home/evolve-state"
adopt_file="$home/adopt.json"
rollback_file="$home/rollback.json"
adopt_notice_file="$home/adopt-notice.json"
window=120
fuse=3

mkdir -p "$home" || {
  echo "adopt.sh: cannot create DSHBOT_HOME $home" >&2
  exit 1
}

state_get() {
  [ -f "$state_file" ] || return 0
  sed -n "s/^$1=//p" "$state_file" | tail -n 1
}

now="$(date +%s)"
started="$(state_get started_at)"
healthy="$(state_get healthy)"
crashes="$(state_get crashes)"
stable="$(state_get stable)"

# `stable` is the last commit that survived the health timer: the daemon writes it into
# the state and tags it. A state without the line (written by an older daemon, or a
# hand-made one) must not turn the current HEAD into the new baseline: HEAD is the code
# of a rollout that has not been healthy yet, and rolling back to it would roll back to
# the broken commit. So the git tag is the authority; only an installation without a
# tag (the first start after install) falls back to HEAD and tags it.
# A stale sha (the repository was re-created, the object is gone) is not a rollback
# target either: drop it and resolve the baseline again instead of failing every start.
if [ -n "$stable" ] && ! git cat-file -e "${stable}^{commit}" 2>/dev/null; then
  stable=""
fi
if [ -z "$stable" ]; then
  stable="$(git rev-parse --verify 'stable^{commit}' 2>/dev/null || true)"
fi
if [ -z "$stable" ]; then
  stable="$(git rev-parse --verify HEAD 2>/dev/null || true)"
  if [ -n "$stable" ]; then
    git tag -f stable "$stable" >/dev/null 2>&1 || true
  fi
fi

sha=""
candidate=""
if [ -f "$adopt_file" ]; then
  sha="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9A-Fa-f]\{7,64\}\)".*/\1/p' "$adopt_file" | head -n 1)"
  candidate="$(sed -n 's/.*"candidate"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$adopt_file" | head -n 1)"
  # The candidate id is only used in the owner notice; never let a hand-edited
  # adopt.json put quotes or shell text into the JSON written below.
  case "$candidate" in
    '' | *[!a-z0-9-]*) candidate="" ;;
  esac
  if [ -z "$sha" ]; then
    echo "adopt.sh: $adopt_file carries no sha" >&2
    exit 1
  fi
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "adopt.sh: unknown commit $sha in $adopt_file" >&2
    exit 1
  fi
fi

# A previous service start that never reached the health timer died: count it.
# An adoption start is a planned restart and resets the fuse instead.
if [ -n "$sha" ]; then
  crashes=""
else
  if [ -n "$started" ] && [ "$healthy" != "1" ]; then
    crashes="${crashes:+$crashes,}$now"
  fi
fi

# Keep only crashes inside the 120 s window.
filtered=""
oldest=$((now - window))
for stamp in ${crashes//,/ }; do
  case "$stamp" in
    '' | *[!0-9]*) continue ;;
  esac
  if [ "$stamp" -ge "$oldest" ]; then
    filtered="${filtered:+$filtered,}$stamp"
  fi
done
crashes="$filtered"

count=0
if [ -n "$crashes" ]; then
  IFS=',' read -r -a stamps <<<"$crashes"
  count="${#stamps[@]}"
fi

if [ -z "$sha" ] && [ "$count" -ge "$fuse" ] && [ -n "$stable" ]; then
  before="$(git rev-parse --verify HEAD 2>/dev/null || true)"
  if git checkout -f -B live "$stable" >/dev/null 2>&1; then
    printf '{"at":%s,"from":"%s","stable":"%s"}\n' "$now" "$before" "$stable" >"$rollback_file"
    # The rollback undoes the last adoption: its notice must not be reported as
    # an applied change by the process that starts now.
    rm -f "$adopt_notice_file"
    crashes=""
  else
    echo "adopt.sh: rollback to stable $stable failed" >&2
    exit 1
  fi
fi

if [ -n "$sha" ]; then
  before="$(git rev-parse --verify HEAD 2>/dev/null || true)"

  # Dependencies of the adopted commit may differ. The running node_modules is
  # moved aside (never deleted) before `npm ci`, so a failed installation can
  # put the exact previous directory back without network.
  lock_changed=0
  if [ -n "$before" ] && ! git diff --quiet "$before" "$sha" -- package-lock.json 2>/dev/null; then
    lock_changed=1
  fi
  modules_saved=0
  if [ "$lock_changed" = 1 ] && [ -d node_modules ]; then
    rm -rf node_modules.prev
    if mv node_modules node_modules.prev; then
      modules_saved=1
    else
      echo "adopt.sh: cannot move node_modules aside" >&2
      exit 1
    fi
  fi

  if ! git checkout -f -B live "$sha" >/dev/null 2>&1; then
    if [ "$modules_saved" = 1 ]; then
      rm -rf node_modules
      mv node_modules.prev node_modules || true
    fi
    echo "adopt.sh: checkout of $sha into live failed" >&2
    exit 1
  fi

  dependencies_ok=1
  if [ "$lock_changed" = 1 ]; then
    if npm ci; then
      if [ "$modules_saved" = 1 ]; then
        rm -rf node_modules.prev
      fi
    else
      dependencies_ok=0
    fi
  fi

  if [ "$dependencies_ok" = 1 ]; then
    rm -f "$adopt_file"
    # The daemon reports the adoption to the owner once and consumes this file;
    # the next ordinary start has nothing to say.
    printf '{"at":%s,"candidate":"%s","sha":"%s"}\n' "$now" "$candidate" "$sha" >"$adopt_notice_file" ||
      echo "adopt.sh: cannot write $adopt_notice_file" >&2
    crashes=""
  else
    # The new dependencies did not install: remove only the partial directory,
    # restore the saved one and start on the previous code. A fresh `npm ci` of
    # the previous commit is only the fallback when no saved directory existed.
    rm -rf node_modules
    if [ -n "$before" ]; then
      if ! git checkout -f -B live "$before" >/dev/null 2>&1; then
        echo "adopt.sh: rollback to $before after dependency failure failed" >&2
        exit 1
      fi
    fi
    if [ "$modules_saved" = 1 ]; then
      mv node_modules.prev node_modules || {
        echo "adopt.sh: cannot restore saved node_modules" >&2
        npm ci || echo "adopt.sh: cannot reinstall previous dependencies" >&2
      }
    else
      npm ci || echo "adopt.sh: cannot reinstall previous dependencies" >&2
    fi
    rm -f "$adopt_file" "$adopt_notice_file"
    printf '{"at":%s,"from":"%s","stable":"%s","reason":"dependencies"}\n' \
      "$now" "$sha" "${before:-$stable}" >"$rollback_file" ||
      echo "adopt.sh: cannot write $rollback_file" >&2
    crashes=""
  fi
fi

tmp="$state_file.tmp"
{
  printf 'started_at=%s\n' "$now"
  printf 'healthy=0\n'
  printf 'crashes=%s\n' "$crashes"
  printf 'stable=%s\n' "$stable"
} >"$tmp" || {
  echo "adopt.sh: cannot write $state_file" >&2
  exit 1
}
mv -f "$tmp" "$state_file" || exit 1

exit 0
