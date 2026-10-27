# Проверка риска зависимостей DeepSeek Harness (2026-10-23)

Статическая проверка перед тем, как DSHBOT начнёт зависеть от пакетов харнесса. Ничего не устанавливалось и не исполнялось.

## Набор

Версии: дист-тег `next`, 0.2.1-rc.3 (опубликован 2026-10-23). Тег `latest` указывает на разнобой старых rc, его не берём. Исходники в `refs/deepseek-harness` — 0.2.1-rc.2, дифф с rc.3 не смотрели.

- `@deepseek-ai/dsh-agent`, `dsh-agent-loop`, `dsh-agent-default-model`, `dsh-llm`, `dsh-llm-deepseek`, `dsh-llm-deepseek-api-key`, `dsh-session`, `dsh-system-prompt` — 0.2.1-rc.3
- `@deepseek-ai/cordis` 4.0.5, `@deepseek-ai/cordis-plugin-loader` 1.0.6. Нескоупный `cordis` — другой пакет, не путать.

## Дерево

- 64 пакета, все с registry.npmjs.org, без git-, tarball- и file-зависимостей.
- Пакетов с install-скриптами нет, устаревших нет, `npm audit` — 0 уязвимостей (только по известным advisory).
- Нативный код: `node-addon-require-builtin` 0.1.9 с готовыми `.node` под платформы (на Linux — `node-addon-require-builtin-linux-x64-gnu`), нужен `dsh-sandbox` для Landlock и flock. Бинарь не дизассемблировали.
- `dsh-base`, `dsh`, `dsh-headless`, otel, session-log, inventory и web в дерево не входят.

## Сеть и телеметрия

- Единственные `fetch(` — в `dsh-llm-deepseek/lib/index.js` (запросы `${baseURL}/messages` и список моделей, `redirect: "error"`). Хост — `api.deepseek.com` или заданный `baseURL`.
- К каждому запросу модели прикладываются заголовки `x-deepseek-harness-user-id` (анонимный UUID), `x-deepseek-harness-session-id`, `x-deepseek-harness-compact` и `user-agent`. Выключателя нет: это уходит в DeepSeek вместе с самим запросом.
- UUID создаётся в `$DSH_HOME/.anonymous-user-id` (по умолчанию `~/.dsh`).
- Кода otel, posthog, sentry и аналитики в дереве нет, строки `deepseeksvc` нет.
- `DSH_TELEMETRY_DISABLED` (любое непустое значение) выключает строку `session-telemetry-otel` в `dsh-app-boot`; в нашем наборе её и так нет.

## Происхождение

Мейнтейнеры `imccyu` и `tianyicui-deepseek`, репозиторий — организация deepseek-ai на GitHub. Подписи реестра npm есть, provenance-аттестаций нет. Всё — release candidate за последние ~9 дней, API нестабилен.

## Решение: можно, с ограничениями

- Только перечисленный набор; `dsh-base`, `dsh` и `dsh-headless` не подключать.
- Точные версии и закоммиченный lockfile; `ignore-scripts=true` остаётся.
- `DSH_HOME` — отдельный каталог бота; `DSH_TELEMETRY_DISABLED=1` выставлен страховкой.
- Исходящий трафик бота — только `api.deepseek.com` и `api.telegram.org`.
- Повторная проверка при каждом обновлении версий.

Пределы: проверка по grep, полный код 57 пакетов не читали, обфусцированные или динамически собранные адреса могли пропустить, трафик в работе не снимали.
