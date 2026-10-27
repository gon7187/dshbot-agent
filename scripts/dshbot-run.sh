#!/usr/bin/env bash
# Launcher of the DSHBOT daemon: the single place that decides how the process is
# isolated. The systemd unit starts it as
#
#   scripts/dshbot-run.sh <node> --import ./packages/app/register.mjs ./packages/app/src/main.ts
#
# DSHBOT_ISOLATION (from dshbot.env):
#   host (or empty, or unset)  run the command directly, as before;
#   container                  run it inside bwrap with a user namespace: uid 0
#                              inside (fake root, no capability but CAP_SETFCAP),
#                              the ordinary launching user outside. DSHBOT_HOME
#                              is writable, the application root and the node
#                              toolchain are read-only, HOME and /tmp are
#                              private, the network is shared (Telegram and the
#                              model API need it). A /etc/resolv.conf symlink
#                              into /run still resolves: only the directory of
#                              its real target is mounted, read-only. The exec
#                              tool of the daemon keeps starting its own nested
#                              bwrap.
#
# There is no silent fallback: container mode without a working bwrap exits 77,
# the same code as /panic, and the unit stays down until the owner fixes it.

set -u

# Same code as /panic: RestartPreventExitStatus=77 keeps a broken setup down.
readonly EXIT_UNAVAILABLE=77

fail() {
  printf 'dshbot-run.sh: %s\n' "$*" >&2
  exit "$EXIT_UNAVAILABLE"
}

isolation="${DSHBOT_ISOLATION:-}"
case "$isolation" in
  '' | host | container)
    ;;
  *)
    fail "неизвестное значение DSHBOT_ISOLATION='$isolation'. Допустимые значения: container, host."
    ;;
esac

if [ "$#" -eq 0 ]; then
  printf 'dshbot-run.sh: не задана команда для запуска\n' >&2
  exit 64
fi

case "$isolation" in
  '' | host)
    exec "$@"
    ;;
esac

# --- container mode -----------------------------------------------------------------------------

bwrap_program="$(command -v bwrap 2>/dev/null || true)"
if [ -z "$bwrap_program" ]; then
  fail "режим container требует bwrap, но bwrap не найден в PATH. Установите bubblewrap; запуск без контейнера запрещён."
fi

# The application root is the parent of this script's directory (the launcher
# lives in <app>/scripts). It is mounted read-only, so a candidate cannot rewrite
# the running code from inside the container.
script_path="${BASH_SOURCE[0]}"
script_path="$(readlink -f -- "$script_path" 2>/dev/null || printf '%s' "$script_path")"
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd -P)" || fail "не удалось определить каталог лаунчера"
app_root="$(cd -- "$script_dir/.." && pwd -P)" || fail "не удалось определить каталог приложения"

dshbot_home="${DSHBOT_HOME:-}"
if [ -z "$dshbot_home" ]; then
  fail "режим container требует DSHBOT_HOME: нечего монтировать в контейнер."
fi
case "$dshbot_home" in
  /*) ;;
  *) dshbot_home="$(cd -- "$dshbot_home" && pwd -P)" || fail "DSHBOT_HOME не найден: $dshbot_home" ;;
esac
mkdir -p -- "$dshbot_home" || fail "не удалось создать DSHBOT_HOME: $dshbot_home"

dshbot_home_real="$(cd -- "$dshbot_home" && pwd -P)" || fail "DSHBOT_HOME недоступен: $dshbot_home"
home="${HOME:-}"
home_real=""
if [ -n "$home" ] && [ -d "$home" ]; then
  home_real="$(cd -- "$home" && pwd -P)" || home_real=""
fi

cmd=("$@")
first="${cmd[0]}"

# True when the path is one of the roots with a fixed mode inside (HOME,
# DSHBOT_HOME, the application root) or a directory above one of them: a
# read-only bind of it would expose the private HOME or shadow the writable one.
covers_fixed_root() {
  local path="$1" root
  [ "$path" = "/" ] && return 0
  for root in "$home" "$home_real" "$dshbot_home" "$dshbot_home_real" "$app_root"; do
    [ -n "$root" ] || continue
    case "$root/" in
      "$path"/*) return 0 ;;
    esac
  done
  return 1
}

# A node shim (mise, nvm) is a small forwarder outside the system directories:
# mise's shim is a link to the mise binary itself, which reads its installs and
# config from HOME, and the container does not expose HOME. Resolve a bare name
# through PATH the way the shell would, ask the program for the real executable
# (process.execPath) and start that one inside; the toolchain mount below
# follows the real node, not the shim.
real_node=""
case "$(basename -- "$first")" in
  node | nodejs)
    node_program="$first"
    case "$node_program" in
      */*) ;;
      *) node_program="$(command -v -- "$node_program" 2>/dev/null || true)" ;;
    esac
    if [ -n "$node_program" ] && [ -x "$node_program" ]; then
      real_node="$("$node_program" -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
      if [ -n "$real_node" ]; then
        real_node="$(readlink -f -- "$real_node" 2>/dev/null || true)"
      fi
    fi
    if [ -z "$real_node" ] || [ ! -f "$real_node" ] || [ ! -x "$real_node" ]; then
      fail "режим container: не удалось найти настоящий бинарник node для '$first' (запуск '$first -e process.execPath' не дал пути к исполняемому файлу)."
    fi
    cmd[0]="$real_node"
    ;;
esac

# Directories mounted read-only in addition to the system ones: the node
# toolchain and the owner's DSHBOT_CONTAINER_RO list.
ro_dirs=()
add_ro_dir() {
  local path="$1" existing
  [ -n "$path" ] || return 0
  [ -e "$path" ] || return 0
  for existing in "${ro_dirs[@]}"; do
    [ "$existing" = "$path" ] && return 0
  done
  ro_dirs+=("$path")
}

# The toolchain is the installation prefix of the real node (<prefix>/bin/node),
# so npm and npx next to it, which link into <prefix>/lib, work for MCP servers
# too. A prefix or a directory that would cover HOME, DSHBOT_HOME or the
# application root (a node in ~/bin or straight in HOME) is narrowed down to the
# binary's directory and then to the binary itself; a node under the system
# directories is already visible.
node_bin_dir=""
if [ -n "$real_node" ]; then
  node_bin_dir="$(dirname -- "$real_node")"
  toolchain=""
  candidates=()
  [ "$(basename -- "$node_bin_dir")" = bin ] && candidates+=("$(dirname -- "$node_bin_dir")")
  candidates+=("$node_bin_dir" "$real_node")
  for candidate in "${candidates[@]}"; do
    if ! covers_fixed_root "$candidate"; then
      toolchain="$candidate"
      break
    fi
  done
  case "$toolchain" in
    /usr/* | /etc/* | /opt/* | /nix/* | /usr | /opt | /nix) ;;
    *) add_ro_dir "$toolchain" ;;
  esac
fi

ro_config="${DSHBOT_CONTAINER_RO:-}"
if [ -n "$ro_config" ]; then
  IFS=':' read -r -a ro_entries <<<"$ro_config"
  for entry in "${ro_entries[@]}"; do
    [ -n "$entry" ] || continue
    case "$entry" in
      /*) ro_path="$entry" ;;
      *) ro_path="$app_root/$entry" ;;
    esac
    while [ "$ro_path" != "/" ] && [ "${ro_path%/}" != "$ro_path" ]; do
      ro_path="${ro_path%/}"
    done
    if [ ! -e "$ro_path" ]; then
      printf "dshbot-run.sh: предупреждение: путь DSHBOT_CONTAINER_RO не существует и пропущен: %s\n" "$entry" >&2
      continue
    fi
    # The private HOME, the writable home and the read-only application root
    # have fixed modes; a broad entry that covers one of them (directly or
    # through a symlink) would contradict the contract, so skip it instead of
    # silently exposing HOME or changing their permissions.
    if covers_fixed_root "$ro_path" || covers_fixed_root "$(readlink -f -- "$ro_path" 2>/dev/null || printf '%s' "$ro_path")"; then
      printf "dshbot-run.sh: предупреждение: путь DSHBOT_CONTAINER_RO охватывает HOME, DSHBOT_HOME или каталог приложения и пропущен: %s\n" "$entry" >&2
      continue
    fi
    add_ro_dir "$ro_path"
  done
fi

# The profile. The root of the sandbox starts empty, so every visible path is
# listed here explicitly.
#
# Capabilities: uid 0 inside is a fake root without them. CAP_SYS_ADMIN would
# let the daemon remount the read-only binds (the application root, the
# DSHBOT_CONTAINER_RO paths) writable or unmount them, and in the unit's layout
# the application lives inside the writable DSHBOT_HOME. Everything is dropped
# except CAP_SETFCAP: since Linux 5.12 a process may map uid 0 of its own user
# namespace into a child one only with it, and the nested bwrap of the exec tool
# maps exactly that. The bounding set keeps only CAP_SETFCAP too, so neither
# exec as uid 0 nor file capabilities give back anything else, and binds copied
# into a nested user namespace stay locked read-only by the kernel.
profile=("$bwrap_program")
profile+=(--unshare-user --uid 0 --gid 0 --cap-drop ALL --cap-add CAP_SETFCAP)
profile+=(--die-with-parent --unshare-pid --proc /proc --dev /dev --tmpfs /tmp)

for system_dir in /usr /etc /opt /nix; do
  [ -e "$system_dir" ] && profile+=(--ro-bind "$system_dir" "$system_dir")
done
# Merged-/usr distributions keep /bin, /sbin, /lib* as symlinks into /usr. Mirror
# the link inside; a real directory is mounted read-only like the rest.
for system_link in /bin /sbin /lib /lib32 /lib64; do
  [ -e "$system_link" ] || continue
  if [ -L "$system_link" ]; then
    target="$(readlink -- "$system_link")" || continue
    profile+=(--symlink "$target" "$system_link")
  else
    profile+=(--ro-bind "$system_link" "$system_link")
  fi
done

# DNS: on many machines /etc/resolv.conf is a symlink into /run
# (../run/systemd/resolve/stub-resolv.conf of systemd-resolved,
# /run/NetworkManager/resolv.conf, ../run/resolvconf/resolv.conf). /run is not
# mounted in the container, so the link would dangle and the daemon could not
# resolve api.telegram.org or the model API. Mount only the directory the link
# really points to, read-only, and fall back to the file itself when that
# directory is all of /run: the rest of /run stays private.
if [ -e /etc/resolv.conf ] || [ -L /etc/resolv.conf ]; then
  resolver_real="$(readlink -f -- /etc/resolv.conf 2>/dev/null || true)"
  case "$resolver_real" in
    /run/*)
      resolver_dir="$(dirname -- "$resolver_real")"
      if [ "$resolver_dir" = "/run" ]; then
        # A resolver right in /run: bind the file, not the whole directory.
        profile+=(--ro-bind-try "$resolver_real" "$resolver_real")
      else
        profile+=(--ro-bind-try "$resolver_dir" "$resolver_dir")
      fi
      ;;
  esac
fi

# HOME inside is private and empty: files of the owner outside DSHBOT_HOME
# (~/.ssh, ~/secret.txt) do not exist in the container.
if [ -n "$home" ] && [ "$home" != "/" ] && [ -d "$home" ]; then
  profile+=(--tmpfs "$home")
fi

profile+=(--bind "$dshbot_home" "$dshbot_home")
profile+=(--ro-bind "$app_root" "$app_root")
for ro_dir in "${ro_dirs[@]}"; do
  profile+=(--ro-bind "$ro_dir" "$ro_dir")
done
# The directory of the real node joins PATH, so children of the daemon (MCP
# servers, helper scripts) find `node`/`npx` of the same installation.
if [ -n "$node_bin_dir" ]; then
  profile+=(--setenv PATH "$node_bin_dir:${PATH:-/usr/local/bin:/usr/bin:/bin}")
fi
profile+=(--chdir "$app_root" --)

# Fail loudly when bwrap cannot create the user namespace (for example user
# namespaces are disabled or a seccomp policy forbids them): the command must
# not run outside the container. The probe runs the exact profile with /bin/true.
probe_error="$("${profile[@]}" /bin/true 2>&1 >/dev/null)"
probe_status=$?
if [ "$probe_status" -ne 0 ]; then
  detail="${probe_error:-без сообщения}"
  fail "режим container: bwrap не смог создать контейнер с user namespace (код $probe_status): $detail. Запуск без контейнера запрещён."
fi

exec "${profile[@]}" "${cmd[@]}"
