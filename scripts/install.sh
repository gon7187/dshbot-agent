#!/usr/bin/env bash
# Однокомандный установщик DSHBOT.
#
#   scripts/install.sh                # интерактивно: спросит токен, ключ и режим
#   scripts/install.sh --yes          # без вопросов, значения из окружения
#   scripts/install.sh --uninstall    # снять службы и удалить код, данные сохранить
#   scripts/install.sh --purge        # дополнительно удалить данные и dshbot.env
#
# Источник кода — каталог репозитория, из которого запущен скрипт, либо
# DSHBOT_INSTALL_SRC. Приложение ставится в DSHBOT_HOME/app (по умолчанию
# ~/.local/share/dshbot/app) как git-клон с ветвью live; службы — обычные файлы
# в ~/.config/systemd/user/, а не симлинки в репозиторий. Поэтому установка
# переживает удаление или перемещение исходного checkout. Remote origin
# приложения берётся из origin источника или DSHBOT_INSTALL_ORIGIN: через него
# работают /update и отправка принятых правок в main.
#
# Повторный запуск обновляет приложение, ставит зависимости заново и
# перезапускает службу. Существующий dshbot.env не меняется.

set -u

readonly UNIT_NAMES=(dshbot.service dshbot-doctor.service)
# Пути шаблонов deploy/*.service, которые установщик заменяет фактическими.
readonly SHIM_NODE='%h/.local/share/mise/shims/node'
readonly TEMPLATE_DATA='%h/.local/share/dshbot'

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'предупреждение: %s\n' "$*" >&2
}

die() {
  printf 'ошибка: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat <<'EOF'
Установка DSHBOT одной командой.

  scripts/install.sh              интерактивная установка или обновление
  scripts/install.sh --yes        без вопросов (значения из окружения)
  scripts/install.sh --uninstall  остановить и удалить службы и код,
                                  сохранить память и dshbot.env
  scripts/install.sh --purge      то же плюс удалить память и dshbot.env
                                  (после подтверждения словом «удалить»)
  scripts/install.sh --migrate=openclaw|hermes|none
                                  перенести данные из установленного OpenClaw
                                  или Hermes без вопроса о выборе источника;
                                  none — не предлагать миграцию
  scripts/install.sh --help       эта справка

После успешной установки установщик ищет каталоги OpenClaw ($OPENCLAW_STATE_DIR
или ~/.openclaw) и Hermes ($HERMES_HOME или ~/.hermes) и предлагает перенести
данные. Без --migrate при --yes или без TTY миграция не запускается:
печатается готовая команда dshbot-migrate для ручного запуска.
С --migrate=openclaw|hermes сразу идёт пробный прогон; применение — после
подтверждения, а вместе с --yes — без вопросов. Без TTY и без --yes
показывается только план и готовая команда.

Переменные окружения:
  TELEGRAM_BOT_TOKEN  токен бота Telegram
  DEEPSEEK_API_KEY    ключ DeepSeek
  DSHBOT_ISOLATION    container (bwrap) или host (по умолчанию host)
  DSHBOT_HOME         каталог данных (по умолчанию ~/.local/share/dshbot)
  DSHBOT_INSTALL_SRC  каталог с исходниками (по умолчанию корень этого репозитория)
  DSHBOT_INSTALL_ORIGIN  адрес remote origin приложения для самообновления
                      (по умолчанию origin источника)

Подробности: docs/INSTALL.md
EOF
}

action=install
assume_yes=false
migrate_set=false
migrate_choice=
while [ "$#" -gt 0 ]; do
  argument=$1
  shift
  case "$argument" in
    --yes | -y) assume_yes=true ;;
    --uninstall) action=uninstall ;;
    --purge) action=purge ;;
    --help | -h) action=help ;;
    --migrate=*)
      migrate_choice=${argument#--migrate=}
      migrate_set=true
      ;;
    --migrate)
      [ "$#" -gt 0 ] || die "--migrate требует значение: openclaw, hermes или none (см. --help)"
      migrate_choice=$1
      migrate_set=true
      shift
      ;;
    *) die "неизвестный аргумент: $argument (см. --help)" ;;
  esac
done

if [ "$action" = help ]; then
  usage
  exit 0
fi

# Неизвестный выбор отклоняется до любых изменений установки: иначе опечатка
# молча превратилась бы в обычную установку без миграции.
if [ "$migrate_set" = true ]; then
  case "$migrate_choice" in
    openclaw | hermes | none) ;;
    *)
      die "неизвестное значение --migrate='$migrate_choice'. Допустимые значения: openclaw, hermes, none."
      ;;
  esac
fi

# --- пути ---------------------------------------------------------------------------------------

[ -n "${HOME:-}" ] || die "не задан HOME: некуда ставить приложение и настройки"
home_dir=${HOME%/}
# dshbot.env и юниты всегда в ~/.config, XDG_CONFIG_HOME не учитывается: доктор
# читает ~/.config/dshbot/dshbot.env, а файловые инструменты бота прячут именно
# ~/.config/dshbot. Файл с ключами в другом месте стал бы доступен боту.
config_home=$home_dir/.config
default_data=$home_dir/.local/share/dshbot
env_file=$config_home/dshbot/dshbot.env
unit_dir=$config_home/systemd/user

data_dir=$default_data
if [ -n "${DSHBOT_HOME:-}" ]; then
  data_dir=$DSHBOT_HOME
  while [ "${data_dir%/}" != "$data_dir" ]; do
    data_dir=${data_dir%/}
  done
fi
app_dir=$data_dir/app

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd) ||
  die "не удалось определить каталог установщика"
default_src=$(cd -- "$script_dir/.." >/dev/null 2>&1 && pwd) ||
  die "не удалось определить корень репозитория"
src=${DSHBOT_INSTALL_SRC:-$default_src}

# --- проверка предусловий -----------------------------------------------------------------------

node_major=0
node_minor=0

parse_min_node() {
  local engines min rest
  [ -f "$src/package.json" ] || return 0
  engines=$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/package.json" | head -n 1)
  [ -n "$engines" ] || return 0
  min=${engines#>=}
  min=${min#\^}
  min=${min#~}
  min=${min# }
  node_major=${min%%.*}
  rest=${min#*.}
  node_minor=${rest%%[!0-9]*}
  case "$node_major" in '' | *[!0-9]*) node_major=0 ;; esac
  case "$node_minor" in '' | *[!0-9]*) node_minor=0 ;; esac
}

check_prerequisites() {
  [ -f "$src/package.json" ] ||
    die "не найден package.json в каталоге исходников $src. Запустите установщик из checkout DSHBOT или задайте DSHBOT_INSTALL_SRC."
  have node || die "не найден node. Установите Node.js не ниже версии из engines в package.json."
  have git || die "не найден git. Установите git и повторите установку."

  local version current_major current_minor rest
  version=$(node --version 2>/dev/null) || die "не удалось запустить node (--version)."
  version=${version#v}
  version=${version%%[[:space:]]*}
  current_major=${version%%.*}
  rest=${version#*.}
  current_minor=${rest%%.*}
  case "$current_major" in '' | *[!0-9]*) current_major=0 ;; esac
  case "$current_minor" in '' | *[!0-9]*) current_minor=0 ;; esac
  parse_min_node
  if [ "$current_major" -lt "$node_major" ] ||
    { [ "$current_major" -eq "$node_major" ] && [ "$current_minor" -lt "$node_minor" ]; }; then
    die "версия node $version ниже требуемой $node_major.$node_minor (engines в package.json). Обновите Node.js."
  fi

  if [ "$isolation" = container ]; then
    have bwrap ||
      die "режим container требует bwrap, но bwrap не найден в PATH. Установите bubblewrap или выберите DSHBOT_ISOLATION=host."
  elif ! have bwrap; then
    warn "bwrap не найден: режим host работает без песочницы, инструменты записи ограничены только правами пользователя."
  fi

  have systemctl || die "не найден systemctl: установщик ставит пользовательскую службу systemd."
}

# Настоящий путь исполняемого файла; ненулевой код, если файла нет или он не
# исполняется.
executable_real_path() {
  local real
  real=$(readlink -f -- "$1" 2>/dev/null) || return 1
  [ -n "$real" ] && [ -x "$real" ] || return 1
  printf '%s\n' "$real"
}

# Есть ли node вне HOME (и DSHBOT_HOME): гостевая песочница эти каталоги
# маскирует, поэтому mise и nvm под HOME гостевому exec не видны. Кандидаты те
# же, что выбирает guestNodeBinary в packages/tools-exec: node демона, PATH и
# системные каталоги.
guest_exec_node_outside_home() {
  local home_real data_real candidate real dir
  local -a candidates=()
  home_real=$(canonical_dir "$home_dir" 2>/dev/null) || home_real=$home_dir
  data_real=$(canonical_dir "$data_dir" 2>/dev/null) || data_real=$data_dir

  [ -n "${node_bin:-}" ] && candidates+=("$node_bin")
  local old_ifs=$IFS
  IFS=:
  for dir in ${PATH:-}; do
    [ -n "$dir" ] || continue
    candidates+=("$dir/node")
  done
  IFS=$old_ifs
  candidates+=(/usr/local/bin/node /usr/bin/node /bin/node)

  for candidate in "${candidates[@]}"; do
    [ -n "$candidate" ] || continue
    real=$(executable_real_path "$candidate") || continue
    case "$real" in
      "$home_real" | "$home_real"/* | "$data_real" | "$data_real"/*) continue ;;
    esac
    return 0
  done
  return 1
}

# Каталог данных попадает в юниты systemd и в rm -rf каталога приложения при
# --uninstall, поэтому принимается только абсолютный путь без сегментов . и ..
# и без символов, которые systemd толкует по-своему (пробелы, кавычки, \ % $).
# Путь по умолчанию в юнитах записан через %h и проверки не требует.
check_data_dir() {
  [ "$data_dir" != "$default_data" ] || return 0
  case "$data_dir" in
    /?*) ;;
    *) die "DSHBOT_HOME должен быть абсолютным путём к каталогу данных, не корнем (получено: '${DSHBOT_HOME:-}')." ;;
  esac
  case "$data_dir/" in
    */./* | */../*) die "DSHBOT_HOME не должен содержать сегменты . и .. (получено: $data_dir)." ;;
  esac
  case "$data_dir" in
    *[[:space:]\"\'\\%\$]*)
      die "DSHBOT_HOME содержит пробел, кавычку или один из символов \\ % \$, которые systemd толкует по-своему: $data_dir. Выберите путь без них." ;;
  esac
  [ "$data_dir" != "$home_dir" ] ||
    die "DSHBOT_HOME не может совпадать с домашним каталогом ($home_dir): бот получил бы запись во весь HOME."
}

# --- приложение ---------------------------------------------------------------------------------

is_git_work_tree() {
  git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

has_live_branch() {
  git -C "$1" rev-parse --verify --quiet refs/heads/live >/dev/null 2>&1
}

fetch_source() {
  git -C "$1" fetch --no-tags "$src" HEAD >/dev/null 2>&1 ||
    die "не удалось получить исходники из $src. Проверьте путь DSHBOT_INSTALL_SRC и доступ к git."
}

# Адрес origin без учётных данных: https://user:token@host/repo.git ->
# https://host/repo.git. Адрес хранится в .git/config приложения и печатается
# установщиком, поэтому логин и токен из него удаляются. Учётные данные живут
# только в authority (между :// и первым /, ? или #); @ в пути, запросе и
# фрагменте (file:///srv/upstream@mirror.git) и адреса без схемы (локальный
# путь, git@host:owner/repo.git) остаются как есть. Имя пользователя ssh
# (ssh://git@host/repo.git) нужно для входа и не секретно: у ssh удаляется
# только пароль.
strip_origin_credentials() {
  local url=$1 scheme rest authority userinfo host
  case "$url" in
    *://*) ;;
    *) printf '%s\n' "$url"; return 0 ;;
  esac
  scheme=${url%%://*}
  case "$scheme" in
    '' | [!A-Za-z]* | *[!A-Za-z0-9+.-]*) printf '%s\n' "$url"; return 0 ;;
  esac
  rest=${url#*://}
  authority=${rest%%[/?#]*}
  case "$authority" in
    *@*) ;;
    *) printf '%s\n' "$url"; return 0 ;;
  esac
  userinfo=${authority%@*}
  host=${authority##*@}
  case "$scheme" in
    ssh | git+ssh | ssh+git)
      case "$userinfo" in
        *:*) host=${userinfo%%:*}@$host ;;
        *) printf '%s\n' "$url"; return 0 ;;
      esac
      ;;
  esac
  printf '%s://%s%s\n' "$scheme" "$host" "${rest#"$authority"}"
}

# Относительный путь origin (например ../remote.git или ./remote:mirror.git)
# задан относительно каталога источника. В приложении тот же текст указывал бы
# на другой каталог, поэтому путь заранее разрешается в абсолютный от базового
# каталога. Двоеточие само по себе не делает адрес удалённым: как и git, считаем
# удалёнными адрес со схемой (://) и scp-форму host:path, где двоеточие стоит
# раньше первого /. Путь, начинающийся с /, ./ или ../, либо путь, где / стоит
# раньше первого :, остаётся локальным и разрешается в абсолютный.
absolute_origin_path() {
  local url=$1 base=$2 dir name head
  case "$url" in
    '' | /*) printf '%s\n' "$url"; return 0 ;;
    *://*) printf '%s\n' "$url"; return 0 ;;
  esac
  head=${url%%/*}
  case "$head" in
    *:*) printf '%s\n' "$url"; return 0 ;;
  esac
  name=$(basename -- "$url") || { printf '%s\n' "$url"; return 0; }
  dir=$(CDPATH='' cd -- "$base/$(dirname -- "$url")" 2>/dev/null && pwd -P) ||
    { printf '%s\n' "$url"; return 0; }
  printf '%s/%s\n' "${dir%/}" "$name"
}

# remote.origin.url источника, если источник — git-репозиторий с origin.
source_origin() {
  local url
  is_git_work_tree "$src" || return 1
  url=$(git -C "$src" config --local --get remote.origin.url 2>/dev/null) || return 1
  [ -n "$url" ] || return 1
  printf '%s\n' "$url"
}

# Адрес, который получит origin приложения: DSHBOT_INSTALL_ORIGIN важнее
# origin источника. Ненулевой код означает, что адреса нет.
desired_origin() {
  local address base
  base=$src
  if [ -n "${DSHBOT_INSTALL_ORIGIN:-}" ]; then
    address=$DSHBOT_INSTALL_ORIGIN
    base=${PWD:-$src}
  else
    address=$(source_origin) || return 1
  fi
  [ -n "$address" ] || return 1
  address=$(strip_origin_credentials "$address")
  address=$(absolute_origin_path "$address" "$base")
  [ -n "$address" ] || return 1
  printf '%s\n' "$address"
}

print_origin_help() {
  say "У приложения нет remote origin: самообновление (/update и отправка правок в main) будет недоступно."
  say "Добавьте origin позже командой:"
  say "  git -C \"$app_dir\" remote add origin <адрес>"
  say "Адрес можно задать переменной DSHBOT_INSTALL_ORIGIN при повторном запуске установщика."
}

# Origin приложения нужен /update и отправке правок в main. Существующий origin
# не меняется. Связанный worktree (.git — файл) использует общий конфиг чужого
# репозитория, поэтому его remote установщик не трогает (h3 в #89).
configure_origin() {
  local current address
  [ -d "$app_dir/.git" ] || return 0
  current=$(git -C "$app_dir" config --local --get remote.origin.url 2>/dev/null) || current=
  [ -z "$current" ] || return 0
  if ! address=$(desired_origin); then
    print_origin_help
    return 0
  fi
  if git -C "$app_dir" remote add origin "$address" >/dev/null 2>&1; then
    say "origin приложения: $address (для /update и отправки правок в main)."
  else
    warn "не удалось добавить origin $address в $app_dir; самообновление будет недоступно."
    print_origin_help
  fi
}

# Origin приложения — https на github.com. Ненулевой код, если это не так.
# Эволюция и синхронизация запускают git с GIT_CONFIG_GLOBAL=/dev/null
# (packages/evolve/src/index.ts, gitEnvironment), поэтому глобальный helper от
# `gh auth setup-git` им не виден: нужен helper в локальном конфиге приложения.
github_https_origin() {
  local url scheme rest authority host
  url=$(git -C "$app_dir" config --local --get remote.origin.url 2>/dev/null) || return 1
  [ -n "$url" ] || return 1
  case "$url" in
    *://*) ;;
    *) return 1 ;;
  esac
  scheme=${url%%://*}
  rest=${url#*://}
  authority=${rest%%[/?#]*}
  host=${authority##*@}
  host=${host%%:*}
  [ "${scheme,,}" = https ] || return 1
  [ "${host,,}" = github.com ] || return 1
  printf '%s\n' "$url"
}

print_github_helper_help() {
  say "origin приложения — GitHub по https, а gh не найден или не авторизован: /update и отправка правок в main не смогут войти в GitHub."
  say "Установите GitHub CLI и авторизуйтесь, затем повторите установку:"
  say "  gh auth login"
  say "  scripts/install.sh --yes"
}

# Локальный credential helper gh. Глобальная настройка `gh auth setup-git`
# не переживает GIT_CONFIG_GLOBAL=/dev/null, поэтому helper пишется в конфиг
# самого приложения. Связанный worktree (.git — файл) не трогается: его конфиг
# общий с чужим репозиторием, как и в configure_origin.
configure_github_credentials() {
  local gh_bin gh_dir helper quote quoted value
  [ -d "$app_dir/.git" ] || return 0
  github_https_origin >/dev/null || return 0

  # Путь к gh из PATH, приведённый к абсолютному, но без раскрытия ссылки:
  # диспетчеры вроде /snap/bin/gh -> /usr/bin/snap выбирают программу по имени,
  # под которым их запустили, и цель ссылки вместо gh запустила бы сам snap.
  gh_bin=$(command -v gh 2>/dev/null) || gh_bin=
  case "$gh_bin" in
    '' | /*) ;;
    *)
      if gh_dir=$(CDPATH='' cd -- "$(dirname -- "$gh_bin")" 2>/dev/null && pwd -L); then
        gh_bin=${gh_dir%/}/$(basename -- "$gh_bin")
      else
        gh_bin=
      fi
      ;;
  esac
  if [ -z "$gh_bin" ] || [ ! -f "$gh_bin" ] || [ ! -x "$gh_bin" ]; then
    print_github_helper_help
    return 0
  fi
  if ! "$gh_bin" auth status >/dev/null 2>&1; then
    print_github_helper_help
    return 0
  fi

  # git запускает helper с «!» через sh -c, поэтому путь с пробелом или другим
  # особым для shell символом берётся в одинарные кавычки, а одинарная кавычка
  # внутри них записывается как '\''. Так записывается любой путь, включая
  # перевод строки.
  case "$gh_bin" in
    *[!A-Za-z0-9_./+:@,-]*)
      quote="'\\''"
      quoted=${gh_bin//"'"/"$quote"}
      helper="!'$quoted' auth git-credential"
      ;;
    *) helper="!$gh_bin auth git-credential" ;;
  esac
  # Значения читаются с --null: перевод строки в пути не должен ломать сверку.
  while IFS= read -r -d '' value; do
    [ "$value" = "$helper" ] && return 0
  done < <(git -C "$app_dir" config --local --null --get-all credential.https://github.com.helper 2>/dev/null)

  if git -C "$app_dir" config --local --add credential.https://github.com.helper "$helper" >/dev/null 2>&1; then
    say "GitHub credential helper записан в конфиг приложения: $helper"
  else
    warn "не удалось записать GitHub credential helper в $app_dir; /update и отправка правок в main могут требовать ручной настройки gh."
  fi
}

create_app() {
  git init -q "$app_dir" >/dev/null 2>&1 ||
    die "не удалось создать git-репозиторий в $app_dir"
  fetch_source "$app_dir"
  git -C "$app_dir" checkout -q -B live FETCH_HEAD >/dev/null 2>&1 ||
    die "не удалось переключить $app_dir на ветвь live"
}

move_app_aside() {
  local stamp backup index
  stamp=$(date +%Y%m%d-%H%M%S)
  backup=$data_dir/app.prev-$stamp
  index=1
  while [ -e "$backup" ]; do
    backup=$data_dir/app.prev-$stamp-$index
    index=$((index + 1))
  done
  mv -- "$app_dir" "$backup" ||
    die "не удалось сохранить посторонний каталог $app_dir в $backup"
  say "Каталог приложения не похож на установку DSHBOT; он сохранён без изменений: $backup"
}

update_app() {
  local dirty old_live new_tip tag index
  dirty=$(git -C "$app_dir" status --porcelain 2>/dev/null) ||
    die "не удалось проверить состояние рабочего дерева $app_dir"
  if [ -n "$dirty" ]; then
    die "в рабочем дереве $app_dir есть незакоммиченные изменения. Установка остановлена, ничего не изменено. Сохраните или отмените правки (git -C \"$app_dir\" status) и повторите запуск."
  fi

  old_live=$(git -C "$app_dir" rev-parse --verify refs/heads/live 2>/dev/null) || old_live=
  fetch_source "$app_dir"
  new_tip=$(git -C "$app_dir" rev-parse --verify FETCH_HEAD 2>/dev/null) || new_tip=
  [ -n "$new_tip" ] || die "не удалось определить новую вершину в $src"

  if [ -n "$old_live" ] && [ "$old_live" != "$new_tip" ] &&
    ! git -C "$app_dir" merge-base --is-ancestor "$old_live" "$new_tip" >/dev/null 2>&1; then
    tag=pre-install-$(date +%Y%m%d-%H%M%S)
    index=1
    while git -C "$app_dir" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null 2>&1; do
      tag=pre-install-$(date +%Y%m%d-%H%M%S)-$index
      index=$((index + 1))
    done
    git -C "$app_dir" tag "$tag" "$old_live" >/dev/null 2>&1 ||
      die "не удалось сохранить локальные правки тегом $tag в $app_dir"
    say "Локальные правки из $app_dir сохранены тегом $tag (старая ветвь live)."
  fi

  git -C "$app_dir" checkout -q -f -B live "$new_tip" >/dev/null 2>&1 ||
    die "не удалось обновить $app_dir до $new_tip"
}

install_app() {
  mkdir -p "$data_dir" || die "не удалось создать каталог данных $data_dir"

  if [ ! -e "$app_dir" ]; then
    create_app
    fresh_install=true
  elif is_git_work_tree "$app_dir" && has_live_branch "$app_dir"; then
    update_app
    fresh_install=false
  else
    move_app_aside
    create_app
    fresh_install=true
  fi

  say "Устанавливаю зависимости (npm ci) в $app_dir ..."
  ( cd "$app_dir" && npm ci ) || die "npm ci завершился с ошибкой в $app_dir"
  configure_origin
  configure_github_credentials
}

# --- настройки и юниты --------------------------------------------------------------------------

write_env_file() {
  if [ -f "$env_file" ]; then
    chmod 600 "$env_file" 2>/dev/null || true
    say "Файл настроек уже существует, оставляю без изменений: $env_file"
    return 0
  fi
  mkdir -p "$(dirname -- "$env_file")" ||
    die "не удалось создать каталог настроек $(dirname -- "$env_file")"
  (
    umask 077
    {
      printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token"
      printf 'DEEPSEEK_API_KEY=%s\n' "$key"
      printf 'DSHBOT_ISOLATION=%s\n' "$isolation"
    } >"$env_file"
  ) || die "не удалось записать $env_file"
  chmod 600 "$env_file" || die "не удалось выставить права 600 на $env_file"
  say "Записан файл настроек: $env_file (права 600)"
}

install_units() {
  local template unit name line tmp unit_node unit_data first rest
  local templates
  mkdir -p "$unit_dir" || die "не удалось создать каталог юнитов $unit_dir"
  # Шаблоны берутся из только что обновлённого приложения: юниты соответствуют
  # коду ветви live. В юнитах % — спецификатор systemd, его нужно удваивать.
  unit_node=${node_bin//%/%%}
  unit_data=$TEMPLATE_DATA
  [ "$data_dir" = "$default_data" ] || unit_data=$data_dir
  shopt -s nullglob
  templates=("$app_dir"/deploy/*.service)
  shopt -u nullglob
  [ "${#templates[@]}" -gt 0 ] || die "в $app_dir/deploy не найдены юниты служб (*.service)"
  for template in "${templates[@]}"; do
    [ -f "$template" ] || continue
    name=$(basename -- "$template")
    unit=$unit_dir/$name
    if [ -d "$unit" ] && [ ! -L "$unit" ]; then
      die "на месте юнита $unit лежит каталог; уберите его и повторите установку"
    fi
    # Прежние установки подключали deploy/*.service симлинком в каталог
    # приложения. Запись через него испортила бы отслеживаемый шаблон, поэтому
    # юнит собирается во временном файле рядом и заменяет симлинк или старый
    # файл переименованием.
    tmp=$(mktemp "$unit_dir/.$name.XXXXXX") ||
      die "не удалось создать временный файл в $unit_dir"
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line//"$SHIM_NODE"/"$unit_node"}
      line=${line//"$TEMPLATE_DATA"/"$unit_data"}
      # ExecStart основного юнита начинается с лаунчера, а не с node. Записываем
      # первым закреплённый node: установленная копия dshbot-launch.mjs запускает
      # dshbot-run.sh и сохраняет выбор host/container.
      case "$line" in
        ExecStart=*)
          rest=${line#ExecStart=}
          first=${rest%%[[:space:]]*}
          case "$first" in
            */scripts/dshbot-run.sh)
              rest=${rest#"$first"}
              line="ExecStart=$unit_node $unit_data/dshbot-launch.mjs $first$rest"
              ;;
          esac
          ;;
      esac
      printf '%s\n' "$line"
    done <"$template" >"$tmp" || {
      rm -f -- "$tmp"
      die "не удалось записать юнит $unit"
    }
    if ! chmod 644 "$tmp" || ! mv -f -- "$tmp" "$unit"; then
      rm -f -- "$tmp"
      die "не удалось установить юнит $unit"
    fi
  done
  say "Установлены юниты в $unit_dir из $app_dir/deploy"
}

# Исполняемый мост между закреплённым node в ExecStart и dshbot-run.sh:
# systemd запускает node с известным путём, а лаунчер по-прежнему решает,
# запускать демон на хосте или в bwrap. Код возврата и сигналы передаются.
install_launch_shim() {
  local shim=$data_dir/dshbot-launch.mjs tmp
  tmp=$shim.tmp
  cat >"$tmp" <<'EOF' || die "не удалось записать $shim"
  // Запускает dshbot-run.sh из ExecStart основного юнита. Юнит указывает первым
  // закреплённый node (тот же, что записан в Environment и миграции), поэтому
  // сам лаунчер передаётся этим файлом.
  import { spawn } from 'node:child_process'
  
  const [script, ...args] = process.argv.slice(2)
  if (script === undefined) {
    console.error('dshbot-launch: не указан путь к dshbot-run.sh')
    process.exit(64)
  }
  const child = spawn(script, args, { stdio: 'inherit', env: process.env })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
    process.on(signal, () => {
      try { child.kill(signal) } catch { /* процесс уже завершился */ }
    })
  }
  child.on('error', (error) => {
    console.error(`dshbot-launch: не удалось запустить ${script}: ${error.message}`)
    process.exit(65)
  })
  child.on('exit', (code, signal) => {
    if (signal === null) {
      process.exit(code ?? 1)
    }
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) process.removeAllListeners(name)
    try { process.kill(process.pid, signal) } catch { process.exit(128) }
  })
EOF
  chmod 644 "$tmp" && mv -f -- "$tmp" "$shim" ||
    { rm -f -- "$tmp"; die "не удалось установить $shim"; }
}

# --- службы -------------------------------------------------------------------------------------

# Файл юнита или симлинк прежней ручной установки, в том числе висячий.
remove_unit_file() {
  local unit=$unit_dir/$1
  if [ -L "$unit" ] || [ -f "$unit" ]; then
    rm -f -- "$unit" || die "не удалось удалить юнит $unit"
  fi
}

stop_disable_units() {
  local name
  if ! have systemctl; then
    warn "systemctl не найден: удаляю только файлы юнитов"
    for name in "${UNIT_NAMES[@]}"; do
      remove_unit_file "$name"
    done
    return 0
  fi
  for name in "${UNIT_NAMES[@]}"; do
    systemctl --user stop "$name" >/dev/null 2>&1 || true
    systemctl --user disable "$name" >/dev/null 2>&1 || true
    remove_unit_file "$name"
  done
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

start_service() {
  systemctl --user daemon-reload ||
    warn "systemctl --user daemon-reload завершился с ошибкой"
  if [ "$fresh_install" = true ]; then
    systemctl --user enable --now dshbot.service ||
      die "не удалось включить и запустить dshbot.service"
  else
    systemctl --user restart dshbot.service ||
      die "не удалось перезапустить dshbot.service"
  fi
  say "Служба dshbot.service запущена (systemctl --user status dshbot.service)."
}

print_linger_hint() {
  local user_name linger
  have loginctl || return 0
  user_name=${USER:-}
  [ -n "$user_name" ] || user_name=$(id -un 2>/dev/null || true)
  [ -n "$user_name" ] || return 0
  linger=$(loginctl show-user "$user_name" --property=Linger 2>/dev/null || true)
  case "$linger" in
    *Linger=no* | *Linger=n/a*)
      say "Чтобы бот работал в фоне после выхода из системы, включите lingering (нужен sudo):"
      say "  sudo loginctl enable-linger $user_name"
      say "Без этого пользовательская служба останавливается после завершения последней сессии входа."
      ;;
  esac
}

# InvocationID текущего процесса dshbot.service. Журнал после --purge или
# повторной установки хранит код привязки прошлого процесса, и показывать его
# нельзя: новый процесс выдаёт другой код. Пустой ответ (старый systemd, служба
# ещё не стартовала) означает, что ограничимся отметкой времени запуска.
service_invocation() {
  local value
  have systemctl || return 0
  value=$(systemctl --user show -p InvocationID --value dshbot.service 2>/dev/null) || return 0
  value=${value%%[[:space:]]*}
  case "$value" in
    '' | *[!A-Za-z0-9]*) return 0 ;;
  esac
  printf '%s' "$value"
}

# Аргументы journalctl, ограничивающие выборку текущим запуском службы:
# InvocationID, если systemd его отдал, и время старта как страховка. Время
# снимается до systemctl start/restart, поэтому старые записи не попадут.
journal_query() {
  local args=(--user -u dshbot.service --no-pager -n 200)
  [ -z "$since_epoch" ] || args+=(--since "@$since_epoch")
  [ -z "$invocation" ] || args+=("_SYSTEMD_INVOCATION_ID=$invocation")
  journalctl "${args[@]}" 2>/dev/null
}

journal_command() {
  printf 'journalctl --user -u dshbot.service -n 200 --no-pager'
  [ -z "$since_epoch" ] || printf ' --since @%s' "$since_epoch"
  [ -z "$invocation" ] || printf ' _SYSTEMD_INVOCATION_ID=%s' "$invocation"
}

show_pairing() {
  local line code deadline
  if [ "$assume_yes" = true ]; then
    say "Код привязки владельца бот пишет в журнал, когда вы впервые напишете ему в личку."
    say "Напишите боту в личные сообщения (личку) любое сообщение и посмотрите код командой:"
    say "  $(journal_command)"
    say "Команда показывает только записи текущего запуска службы, поэтому код прошлой установки не попадёт в вывод."
    say "Код — последнее слово в строке «pairing code for private chat ...»."
    say "Отправьте этот код боту в личку одним сообщением — так бот станет вашим владельцем."
    return 0
  fi

  say "Напишите боту в личные сообщения (личку) любое сообщение: бот ответит подсказкой,"
  say "а одноразовый код привязки появится в журнале службы."
  say "Жду код привязки текущего запуска службы в journalctl до 120 секунд..."
  deadline=$(($(date +%s) + 120))
  code=
  while :; do
    line=$(journal_query | grep -i 'pairing code' | tail -n 1 || true)
    if [ -n "$line" ] && [[ $line =~ ([A-Za-z0-9]{4,})[[:space:]]*$ ]]; then
      code=${BASH_REMATCH[1]}
      break
    fi
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 1
  done

  if [ -n "$code" ]; then
    say "Код привязки владельца: $code"
    say "Отправьте боту в личку одно сообщение с этим кодом ($code) — после этого бот станет вашим владельцем."
  else
    warn "код привязки не появился в журнале за 120 секунд. Это нормально, если бот ещё не получил сообщение."
    say "Напишите боту в личку и посмотрите код командой:"
    say "  $(journal_command)"
  fi
}

# --- предложение миграции -----------------------------------------------------------------------

# Каталог состояния источника. Значение OPENCLAW_STATE_DIR/HERMES_HOME главнее
# стандартного каталога в $HOME — так же, как у самого dshbot-migrate.
source_state_dir() {
  case "$1" in
    openclaw)
      if [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
        printf '%s' "$OPENCLAW_STATE_DIR"
      else
        printf '%s' "$home_dir/.openclaw"
      fi
      ;;
    hermes)
      if [ -n "${HERMES_HOME:-}" ]; then
        printf '%s' "$HERMES_HOME"
      else
        printf '%s' "$home_dir/.hermes"
      fi
      ;;
  esac
}

source_display_name() {
  case "$1" in
    openclaw) printf 'OpenClaw' ;;
    hermes) printf 'Hermes' ;;
  esac
}

# Существующий каталог источника или ненулевой код: файл с тем же именем
# установкой OpenClaw/Hermes не считается.
detect_migration_source() {
  local candidate
  candidate=$(source_state_dir "$1")
  [ -n "$candidate" ] && [ -d "$candidate" ] || return 1
  printf '%s' "$candidate"
}

# Готовая команда ручного запуска. dshbot-migrate запускает `node` из PATH,
# поэтому каталог закреплённого node (тот же, что записан в юниты) ставится
# первым в PATH: после установки node может отсутствовать в PATH.
print_migration_command() {
  local source=$1 path=$2 node_dir
  node_dir=$(dirname -- "$node_bin")
  printf '  PATH=%q:"$PATH" %q %q --from %q --home %q --env-file %q --include-secrets\n' \
    "$node_dir" "$app_dir/scripts/dshbot-migrate" "$source" "$path" "$data_dir" "$env_file"
}

print_manual_migration() {
  say "Миграцию из $(source_display_name "$1") можно запустить позже:"
  print_migration_command "$1" "$2"
}

# Запуск установленной копии миграции тем же node, что записан в юниты.
# --include-secrets переносит значения ключей в хранилище и env-файл; сам
# dshbot-migrate маскирует их в плане, отчёте и ошибках.
run_migration_tool() {
  local source=$1 path=$2
  shift 2
  "$node_bin" --import "$app_dir/packages/app/register.mjs" -- \
    "$app_dir/packages/migrate/src/cli.ts" "$source" \
    --from "$path" --home "$data_dir" --env-file "$env_file" \
    --include-secrets "$@" </dev/null
}

migration_tty() {
  [ -t 0 ] && [ -t 1 ]
}

ask_yes_no() {
  local prompt=$1 answer
  printf '%s' "$prompt"
  IFS= read -r answer || answer=
  printf '\n'
  # Не полагаемся на ${answer,,} для кириллицы: в locale C она не меняет регистр.
  case "$answer" in
    да | д | Да | Д | ДА | yes | y | Yes | Y | YES) return 0 ;;
  esac
  return 1
}

# Пробный прогон, показ плана и применение после подтверждения. Любая ошибка
# миграции только сообщается: установка DSHBOT к этому моменту уже выполнена.
# Без TTY и без --yes план показывается, а вопрос о применении считается
# неотвеченным: применение не запускается.
migrate_now() {
  local source=$1 path=$2 status
  say "Пробный прогон миграции из $(source_display_name "$source"): план, ничего не записывается ..."
  run_migration_tool "$source" "$path" --dry-run
  status=$?
  case "$status" in
    0) ;;
    1)
      say "Пробный прогон нашёл конфликты в плане (код 1): при применении существующие значения останутся без изменений."
      ;;
    *)
      warn "миграция не удалась: пробный прогон dshbot-migrate завершился с кодом $status; установка DSHBOT уже выполнена, бот остаётся установленным."
      return 0
      ;;
  esac

  if [ "$assume_yes" = false ]; then
    if ! migration_tty; then
      say "Без терминала подтверждение применения не спрашивается: миграция не применяется."
      print_manual_migration "$source" "$path"
      return 0
    fi
    if ! ask_yes_no "Применить миграцию из $(source_display_name "$source")? [да/нет] (нет): "; then
      print_manual_migration "$source" "$path"
      return 0
    fi
  fi

  # Применение только при остановленной службе: работающий бот держит state.db
  # и настройки открытыми. После миграции do_install всё равно запускает службу.
  if ! systemctl --user stop dshbot.service >/dev/null 2>&1 ||
    systemctl --user is-active --quiet dshbot.service >/dev/null 2>&1; then
    warn "не удалось остановить dshbot.service: миграция из $(source_display_name "$source") не применяется, пока бот работает. Остановите службу (systemctl --user stop dshbot.service), выполните команду ниже и запустите службу снова."
    print_manual_migration "$source" "$path"
    return 0
  fi
  say "Применяю миграцию из $(source_display_name "$source") ..."
  run_migration_tool "$source" "$path" --yes
  status=$?
  if [ "$status" -ne 0 ]; then
    warn "миграция не удалась: dshbot-migrate завершился с кодом $status; установка DSHBOT уже выполнена, бот остаётся установленным."
  else
    say "Миграция из $(source_display_name "$source") завершена."
  fi
}

# Предложение после успешной установки. Без --migrate=<источник> при --yes или
# без TTY миграция не запускается: печатается готовая команда для ручного
# запуска. Явный источник сразу ведёт к пробному прогону (migrate_now).
offer_migration() {
  local source path answer chosen chosen_path
  local -a found=() found_paths=()

  [ "$migrate_choice" = none ] && return 0

  if [ -n "$migrate_choice" ]; then
    if ! path=$(detect_migration_source "$migrate_choice"); then
      warn "каталог $(source_display_name "$migrate_choice") не найден ($(source_state_dir "$migrate_choice")); миграция не запускается."
      return 0
    fi
    say "Найден каталог $(source_display_name "$migrate_choice"): $path"
    migrate_now "$migrate_choice" "$path"
    return 0
  fi

  for source in openclaw hermes; do
    if path=$(detect_migration_source "$source"); then
      found+=("$source")
      found_paths+=("$path")
      say "Найден каталог $(source_display_name "$source"): $path"
    fi
  done
  [ "${#found[@]}" -gt 0 ] || return 0

  if [ "${#found[@]}" -eq 1 ]; then
    if [ "$assume_yes" = true ] || ! migration_tty; then
      print_manual_migration "${found[0]}" "${found_paths[0]}"
    elif ask_yes_no "Перенести данные в DSHBOT сейчас? [да/нет] (нет): "; then
      migrate_now "${found[0]}" "${found_paths[0]}"
    else
      print_manual_migration "${found[0]}" "${found_paths[0]}"
    fi
    return 0
  fi

  if [ "$assume_yes" = true ] || ! migration_tty; then
    print_manual_migration "${found[0]}" "${found_paths[0]}"
    print_manual_migration "${found[1]}" "${found_paths[1]}"
    return 0
  fi

  printf 'Что перенести сейчас? [openclaw/hermes/нет] (нет): '
  IFS= read -r answer || answer=
  printf '\n'
  case "${answer,,}" in
    openclaw | oc | 1) chosen=openclaw ;;
    hermes | h | 2) chosen=hermes ;;
    *) chosen= ;;
  esac
  if [ -z "$chosen" ]; then
    print_manual_migration "${found[0]}" "${found_paths[0]}"
    print_manual_migration "${found[1]}" "${found_paths[1]}"
    return 0
  fi
  if [ "$chosen" = openclaw ]; then
    chosen_path=${found_paths[0]}
  else
    chosen_path=${found_paths[1]}
  fi
  migrate_now "$chosen" "$chosen_path"
}

# --- сценарии -----------------------------------------------------------------------------------

do_install() {
  token=${TELEGRAM_BOT_TOKEN:-}
  key=${DEEPSEEK_API_KEY:-}
  isolation=${DSHBOT_ISOLATION:-}

  if [ "$assume_yes" = false ]; then
    if [ -z "$token" ]; then
      printf 'Токен бота Telegram (TELEGRAM_BOT_TOKEN): '
      IFS= read -rs token || token=
      printf '\n'
    fi
    if [ -z "$key" ]; then
      printf 'Ключ DeepSeek (DEEPSEEK_API_KEY): '
      IFS= read -rs key || key=
      printf '\n'
    fi
    if [ -z "$isolation" ]; then
      printf 'Режим изоляции DSHBOT_ISOLATION [container/host] (host): '
      IFS= read -r isolation || isolation=
    fi
  fi

  isolation=${isolation:-host}
  case "$isolation" in
    container | host) ;;
    *) die "неизвестное значение DSHBOT_ISOLATION='$isolation'. Допустимые значения: container, host." ;;
  esac

  check_prerequisites
  check_data_dir

  [ -n "$token" ] ||
    die "не задан токен бота Telegram (TELEGRAM_BOT_TOKEN). Передайте его в окружении или запустите установщик без --yes и введите."
  [ -n "$key" ] ||
    die "не задан ключ DeepSeek (DEEPSEEK_API_KEY). Передайте его в окружении или запустите установщик без --yes и введите."

  node_bin=$(node --input-type=commonjs -e 'process.stdout.write(process.execPath)' 2>/dev/null) ||
    die "не удалось определить путь к исполняемому файлу node"
  [ -n "$node_bin" ] && [ -x "$node_bin" ] ||
    die "не удалось получить настоящий путь к node (получено: '$node_bin')"
  case "$node_bin" in
    */mise/shims/*) die "node указывает на шим mise ($node_bin); нужен настоящий двоичный файл node." ;;
    *[[:space:]\"\'\\\$]*)
      die "путь к node содержит пробел, кавычку или символ \\ \$: $node_bin. systemd разберёт такой ExecStart неверно; поставьте Node.js в каталог без них." ;;
  esac

  # Гостевой exec запускает прокси песочницы и команду на Node вне HOME;
  # установка без такого Node не ломается, но гость не сможет выполнить ни
  # одной команды. Не спрашиваем и не меняем установку: печатаем подсказку.
  if ! guest_exec_node_outside_home; then
    warn "exec гостя нужен Node вне HOME: mise и nvm под домашним каталогом гостевой песочнице не видны. Поставьте системный node пакетным менеджером (например, sudo apt-get install nodejs) или укажите путь к Node вне HOME; без него каждый exec гостя отклоняется понятной ошибкой."
  fi

  say "Ставлю DSHBOT из $src в $app_dir"
  fresh_install=true
  install_app
  write_env_file
  install_launch_shim
  install_units
  offer_migration
  # Отметка времени до start/restart: код привязки прошлого процесса уже лежит
  # в журнале и не должен быть принят за код нового запуска.
  since_epoch=$(date +%s 2>/dev/null) || since_epoch=
  start_service
  invocation=$(service_invocation)
  print_linger_hint
  show_pairing
  say "Готово."
}

do_uninstall() {
  check_data_dir
  say "Останавливаю и удаляю службы DSHBOT ..."
  stop_disable_units
  if [ -e "$app_dir" ] || [ -L "$app_dir" ]; then
    rm -rf -- "$app_dir" || die "не удалось удалить каталог приложения $app_dir"
  fi
  say "Каталог приложения удалён: $app_dir"
  say "Данные сохранены: $data_dir"
  say "Файл настроек сохранён: $env_file"
  say "Для полного удаления запустите: scripts/install.sh --purge"
}

# Абсолютный путь каталога без символических ссылок и сегментов . и ..;
# ненулевой код, если каталога нет.
canonical_dir() {
  (CDPATH='' cd -P -- "$1" >/dev/null 2>&1 && pwd -P)
}

# Каталог данных для --purge. Защита сравнивает и удаляет канонический путь:
# иначе HOME/../имя или симлинк на HOME прошли бы проверку строк и попали в rm -rf.
purge_target() {
  local raw home_real protected
  if [ "${DSHBOT_HOME+x}" = x ]; then
    raw=$DSHBOT_HOME
  else
    raw=$default_data
  fi
  [ -n "$raw" ] ||
    die "отказ: DSHBOT_HOME пуст. Укажите непустой каталог данных; удалять пустой путь запрещено."
  case "$raw" in
    /*) ;;
    *) die "отказ: DSHBOT_HOME должен быть абсолютным путём (получено: $raw). Удаление запрещено." ;;
  esac
  purge_data=$(canonical_dir "$raw") ||
    die "отказ: каталог данных $raw не найден. Удалять нечего."
  [ -n "$purge_data" ] && [ "$purge_data" != / ] ||
    die "отказ: DSHBOT_HOME ($raw) указывает на корень файловой системы (/). Удаление запрещено."
  home_real=$(canonical_dir "$home_dir") || home_real=$home_dir
  for protected in "$home_dir" "$home_real"; do
    [ "$purge_data" != "$protected" ] ||
      die "отказ: DSHBOT_HOME ($raw) совпадает с домашним каталогом ($purge_data). Удаление запрещено."
    case "$protected/" in
      "$purge_data"/*)
        die "отказ: DSHBOT_HOME ($purge_data) содержит домашний каталог ($protected). Удаление запрещено." ;;
    esac
  done
  [ -f "$purge_data/state.db" ] ||
    die "отказ: в $purge_data нет state.db, это не каталог данных DSHBOT. Удаление запрещено."

  # Сам DSHBOT_HOME может быть ссылкой на каталог данных: она удаляется
  # вместе с ним, иначе осталась бы висячей и помешала новой установке.
  purge_link=$raw
  while [ "${purge_link%/}" != "$purge_link" ]; do
    purge_link=${purge_link%/}
  done
  [ -L "$purge_link" ] || purge_link=
}

do_purge() {
  local answer
  purge_target

  say "Будут удалены:"
  say "  данные бота (DSHBOT_HOME): $purge_data"
  [ -z "$purge_link" ] || say "  ссылка на них: $purge_link"
  say "  файл настроек: $env_file"

  if [ "$assume_yes" = false ]; then
    printf 'Чтобы подтвердить удаление, введите слово «удалить»: '
    IFS= read -r answer || answer=
    if [ "$answer" != "удалить" ]; then
      say "Удаление отменено: введено не слово «удалить»."
      exit 1
    fi
  fi

  say "Останавливаю и удаляю службы DSHBOT ..."
  stop_disable_units
  rm -rf -- "$purge_data" || die "не удалось удалить каталог данных $purge_data"
  if [ -n "$purge_link" ]; then
    rm -f -- "$purge_link" || die "не удалось удалить ссылку $purge_link"
  fi
  rm -f -- "$env_file" || die "не удалось удалить файл настроек $env_file"
  say "Удалено: $purge_data"
  [ -z "$purge_link" ] || say "Удалено: $purge_link"
  say "Удалено: $env_file"
}

case "$action" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  purge) do_purge ;;
esac
