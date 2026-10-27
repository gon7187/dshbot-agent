# OpenClaw: исследование исходников для DSHBOT

- Репозиторий: openclaw/openclaw (MIT), шаллоу-клон в `refs/openclaw`
- Ревизия: `main @ 80b0dce` (80b0dce14c907c1829a15281a0e34014b9461238), релиз v2026.10.6 от 2026-10-22
- Дата исследования: 2026-10-23
- Метод: только чтение (cat/grep/find), ничего не запускалось. Источники: README, AGENTS.md, VISION.md, `docs/`, точечно `src/`, `packages/`, `extensions/`, `test/fixtures/`.
- Оговорка по достоверности: архитектурные факты взяты в основном из документации репо (она подробная и свежая, но это описание, а не проверка кода). Числа по токенам и памяти взяты из зафиксированных в репо снапшотов и отчёта `docs/reference/release-performance-sweep.md`, а не измерены мной. Где есть сомнение, это помечено.

---

## 1. Что такое «2.0» и структура монорепо

### 1.1 «OpenClaw 2.0» - это не номер версии

Версии календарные (`2026.10.6`, `package.json`). «2.0» - внутреннее имя релиза `2026.8.1`: в `docs/releases/2026.8.1.md` есть ключевое слово `OpenClaw 2.0` и ссылка на блог «OpenClaw 2.0, Accidentally». Масштаб того релиза: 16 977 PR, 987 контрибьюторов. Отдельно в 2026.10.5 есть «Skill Workshop 2.0» (не путать).

Ключевые изменения линии 2.0 (по `docs/releases/2026.8.1.md` и `2026.9.5.md`):

- Сессии и транскрипты переехали из файлов в SQLite (`docs/releases/2026.8.1/installation-and-onboarding.md`). Состояние Gateway: общая БД `shared-state` плюс БД на агента `<agentDir>/openclaw-agent.sqlite` (`docs/concepts/multi-agent.md`). Схемы: `docs/reference/database-schemas.md`.
- Перестроенный Control UI (веб), разговор в центре, файлы/одобрения/настройки рядом (`docs/releases/2026.8.1/the-new-web-ui.md`).
- Heartbeat выведен из ядра и заменён обычными «автоматизациями» (cron-задачи со scratch-заметками), см. раздел 3.
- Память: eligible-агент может вспоминать контекст из своих других приватных разговоров (Active Memory), dreaming включён по умолчанию.
- Skills: единый путь создание-проверка-поиск-установка, Skill Workshop (агент пишет скиллы сам).
- Shared sessions: сессия может нести нескольких людей, их «кредиты» и историю (`VISION.md`, `docs/concepts/multi-user.md`, `docs/start/teams.md`, 2026.9.5: conversation sharing, команда специалистов-агентов).
- Виджеты/холст: Gateway сам отдаёт hosted widget documents на `/__openclaw__/canvas/` и рендерер A2UI на `/__openclaw__/a2ui/` (`docs/concepts/architecture.md`), инструмент `show_widget` (`docs/tools/show-widget.md`), порталы (`docs/gateway/portals.md`), dashboards (`docs/web/dashboards`).
- Atomic Updates, hot reload плагинов без рестарта Gateway (2026.9.5).
- Workboard: доски и карточки задач в UI, карточки привязаны к сессиям агентов (`extensions/workboard/README.md`, `packages/workboard-contract`).

### 1.2 Масштаб (число файлов - это уже сигнал)

| Что | Значение | Откуда |
|---|---|---|
| Файлов в репо | ~58 600 | `find . -type f` |
| TS-файлов `src/` (без тестов) | ~15 900 | find |
| TS-файлов `extensions/` | ~6 600 (185 пакетов-плагинов) | `ls extensions` |
| TS/TSX `ui/` | ~3 700 | find |
| `packages/` | 24 внутренних пакета, ~900 TS-файлов | `ls packages` |
| Прямых зависимостей корня | 75 prod + 58 dev | `package.json` |
| Node | `>=24.22.1 <25 \|\| >=26.12.1` | `package.json` engines |

### 1.3 Карта монорепо

- `openclaw.mjs` - единственный bin (`package.json` -> `bin.openclaw`). Рядом куча `*.mjs` рантайм-обвязки: `node-compile-cache.mjs`, `gateway-prewarm.mjs`, `node-runtime-recovery.mjs`, `gateway-shutdown-budget.mjs`, `docker-entrypoint.mjs`.
- `src/` - ядро. Важное: `src/gateway/` (WS/HTTP сервер, авторизация, схемы), `src/agents/` (2134 файла: рантайм агента, инструменты, подсказка, компакция), `src/routing/` (привязка канала к агенту), `src/auto-reply/` (диспетчер входящих, очередь, slash-команды), `src/cron/` (планировщик автоматизаций), `src/memory/`, `src/sessions/`, `src/context-engine/`, `src/daemon/` (systemd/launchd/schtasks), `src/plugins/`, `src/plugin-sdk/`, `src/llm/` (провайдеры), `src/state/` (SQLite-слой), `src/security/`, `src/mcp/`.
- `packages/` - выделенные пакеты: `agent-core` (цикл агента, 1229 строк в `src/agent-loop.ts`), `llm-core`, `ai`, `gateway-protocol`, `gateway-client`, `plugin-sdk`, `sdk`, `worker-runtime` (пул воркеров), `tool-call-repair`, `retry`, `memory-host-sdk`, `workboard-contract` и др.
- `extensions/` - 185 плагинов: каналы (`telegram`, `discord`, `slack`, `whatsapp`, `signal`, `matrix`, `msteams`, `line`, `irc`, `nostr`, `twitch`, `feishu` и т.д.), провайдеры моделей (`openai`, `anthropic`, `deepseek`, `ollama`, `openrouter`, `groq`, `vllm`, `llama-cpp` и т.д.), память (`memory-core`, `memory-lancedb`, `memory-wiki`, `active-memory`), инструменты (`browser`, `exa`, `tavily`, `firecrawl`, `diffs`), `code-mode-quickjs`, `workboard`, `tokenjuice` и другое.
- `skills/` - 51 бандл-скилл (`github`, `tmux`, `weather`, `coding-agent`, `clawhub`, `skill-creator`...), в основном Mac-ориентированные (apple-notes, things-mac, peekaboo).
- `apps/` (нативные приложения), `ui/` (Control UI), `crates/` (Rust), `deploy/`, `qa/`, `docs/`.

Вывод по масштабу: это платформа, а не бот. DSHBOT не должен пытаться её повторять; нужно вытащить узкий набор механизмов (см. раздел 10).

---

## 2. Gateway и runtime агента

### 2.1 Gateway

Источник: `docs/concepts/architecture.md`, `docs/gateway/index.md`.

- Один долгоживущий процесс Node на хост владеет всеми каналами (Telegram через grammY, WhatsApp через Baileys и т.д.), control-plane и HTTP.
- Один мультиплексированный порт (по умолчанию `127.0.0.1:18789`): WebSocket RPC (JSON-фреймы, первый фрейм `connect`, затем `req/res/event`), HTTP API (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/tools/invoke`), Control UI, хуки, плагинные маршруты.
- Клиенты (CLI, веб, мак-приложение) и ноды (iOS/Android/headless с `role: node`) подключаются к тому же WS. Парирование устройств, подпись `connect.challenge`.
- Для побочных методов (`send`, `agent`) нужны idempotency-ключи, сервер хранит короткий dedupe-кэш.
- Блокировка каталога состояния (`docs/gateway/gateway-lock.md`): второй Gateway/`openclaw agent --local` на те же данные не стартует.

### 2.2 От сообщения канала до агента

1. Канальный плагин принимает событие. Пример Telegram: `extensions/telegram/src/` (`bot.ts`, `bot-handlers.*`, `polling-session.ts`, `ingress.ts`). По умолчанию long polling, вебхук опционально (`docs/channels/telegram/transports.md`). Входящие сначала пишутся в durable-ingress в SQLite, затем обрабатываются (после рестарта повторно доставляются; `extensions/telegram/README.md`).
2. Доступ: pairing/allowlist/группы (`dm-access.ts`, `group-access.ts`, `bot-handlers.inbound-authorization.ts`). Неизвестный отправитель в DM получает pairing-код, владелец одобряет `openclaw pairing approve`.
3. Выбор агента - `bindings` (`src/routing/resolve-route.ts`, `bindings.ts`, `route-binding-index.ts`; документ `docs/concepts/agent-bindings.md`). Привязка матчит `channel`, `accountId`, peer (direct/group), guild, team, роли Discord. Привязка выбирает только агента, доступ не выдаёт. Один агент по умолчанию (`main`) - привязки не нужны.
4. Ключ сессии: `agent:<agentId>:main` для всех DM (одна «главная сессия» на агента, `docs/concepts/main-session.md`), отдельные ключи для групп/тредов/cron/сабагентов (`src/routing/session-key.ts`).
5. Диспетчер `src/auto-reply/dispatch.ts`: команды (`/new`, `/status`, `/goal`...) обрабатываются до модели; остальное идёт в очередь.
6. Очередь (`docs/concepts/queue.md`): lane-aware FIFO. Глобальная линия `main`: параллелизм `max(8, CPU*4)`, сабагенты 8 на родителя. Режимы по умолчанию `steer` (сообщение вклинивается в активный ход, пока идут инструменты), также `followup`, `collect`, `interrupt`. Дебаунс 500 мс, cap 20, drop `summarize`. Внутри одной сессии ходы строго сериализованы «session controller».
7. Запуск `agent` RPC: возвращает `{runId, acceptedAt}` сразу, потом `agentCommand` -> `runEmbeddedAgent` (`src/agents/embedded-agent-runner/run.ts`) -> события `lifecycle/assistant/tool` в поток; `agent.wait` ждёт финал (`docs/concepts/agent-loop.md`).
8. Ответ уходит обратно через канальный плагин (`message` tool в Codex-пути; обычный текст в embedded).

### 2.3 Какой движок под капотом

Свой. `docs/agent-runtime-architecture.md`: «OpenClaw owns the built-in agent runtime», внешних agent-фреймворков в зависимостях не осталось. Исторический алиас рантайма `pi` нормализуется в `openclaw` (раньше это был pi-agent), остался сторонним только `@earendil-works/pi-tui` для терминального UI.

- Цикл: `packages/agent-core/src/agent-loop.ts` (+ `agent-loop-tool-execution.ts`, `agent-loop-steering.ts`, `repetition-guard.ts`, `tool-batch-admission.ts`).
- Раннер попытки (attempt loop): `src/agents/embedded-agent-runner/` (выбор модели, fallback, параметры провайдера, компакция, запись транскрипта).
- Транспорт моделей: `src/llm/` (+ `packages/llm-core`, `packages/ai`).
- Инструменты: `src/agents/agent-tools*.ts`, `src/agents/tools/*` (cron, message, nodes, goal, image, pdf, gateway, computer-use...).
- Хуки в цикле: `before_model_resolve`, `before_prompt_build`, `before_agent_reply`, `before/after_tool_call`, `tool_result_persist`, `agent_end`, `before/after_compaction` и др. (`docs/concepts/agent-loop.md`).
- Выбор рантайма: `agentRuntime.id`; `auto` берёт зарегистрированный plugin-харнесс (например `codex`, т.е. нативный Codex app-server) если он поддерживает провайдера, иначе встроенный. OpenAI-маршруты неявно уходят в Codex.
- Журнал записи: каждый ход ставит `activeWriterRunId`; каждая запись транскрипта несёт `expectedWriterRunId`, проверяется в SQLite-транзакции. Устаревший ран не может записать (см. агентный цикл).

Дополнительные страховки цикла (полезны для DSHBOT):

- Три подряд одинаковых ошибки инструмента (тот же tool, args, результат) завершают ход (`docs/tools/loop-detection.md`).
- Guard после компакции: тот же `(tool,args,result)` в окне - аборт.
- Повтор вызова после «malformed tool call» от провайдера: один раз, без повтора побочных эффектов (`docs/concepts/agent-loop.md`).
- `packages/tool-call-repair` чинит кривые вызовы инструментов у слабых моделей.
- Для OpenAI Responses: если `end_turn:false`, цикл просит ещё ответ даже при чисто текстовом ответе.

### 2.4 Субагенты

`docs/tools/subagents.md`, `docs/concepts/subagent-yield-handoff.md`, `docs/tools/swarm.md`.

- Инструмент `sessions_spawn` (описание схемы в снапшоте ~9.9 КБ JSON, см. раздел 7).
- Сабагент - отдельная сессия `agent:<id>:subagent:<uuid>`, по умолчанию «announce»: результат возвращается родителю событием. Контекст не наследуется, если не `context:"fork"`.
- Сабагенты по умолчанию без session/message-инструментов; промпт-режим `minimal` (только `AGENTS.md` из bootstrap, без памяти, без Messaging).
- Вложенность настраивается; можно держать более дешёвую модель для детей: `agents.defaults.subagents.model`.
- Правило из системного промпта: завершение ребёнка не доказывает достижение цели пользователя; не опрашивать `subagents list` в цикле.
- Swarm (`docs/tools/swarm.md`): параллельные воркеры с коллектором, лимит 32 на группу.
- Также ACP-агенты (`docs/tools/acp-agents.md`): внешние кодинг-харнессы (Codex, Claude Code) как «дети».

---

## 3. Подхват задач и доведение до результата

Это самая интересная часть для DSHBOT. В OpenClaw нет единого «task runner»; доводка до результата собрана из нескольких слоёв.

### 3.1 Слой промпта: «Execution Bias» и «Promised Work»

`docs/concepts/system-prompt.md`, секции:

- **Execution Bias**: действовать в ходе на выполнимые запросы, продолжать до готово/заблокировано, проверять живое состояние, верифицировать перед финалом. Запрошенное действие с доступным инструментом считается разрешённым; риск гейтится рантаймом, а не уговорами в промпте.
- **Promised Work**: если модель пообещала будущую/фоновую/делегированную работу, она обязана организовать путь завершения (cron, сабагент, watch) до конца хода, вернуться с результатом или конкретным блокером, и не считать статус `running` завершением.
- Правило по ожиданию: cron для «проверь позже», не `exec sleep` и не polling; `exec/process` только для того, что стартует сейчас; для крупного - `sessions_spawn`.

То есть «доведение» значительно держится на дисциплине промпта плюс на инфраструктуре ниже.

### 3.2 Цели сессии (`/goal`)

`docs/tools/goal.md`. Цель - одна устойчивая задача на сессию. Если цель `active`, рантайм сам продолжает работу после обычного завершения хода (даже если модель выдала финальный текст, а не вызов инструмента). Статусы: `active`, `paused` (ошибка/таймаут, не возобновляется сам), `blocked`, `budget_limited`, `usage_limited`, `complete`. Инструменты модели: `get_goal`, `create_goal` (с `token_budget`), `update_goal` (`src/agents/tools/goal-tools.ts`). Сброс при `/new`. Бюджет токенов считается от свежего снапшота токенов на момент создания цели. Это ближайший аналог «автономно доводить до результата».

### 3.3 Автоматизации (cron) - вместо heartbeat

`docs/automation/cron-jobs.md` (+ `cron-jobs/how-it-works.md`, `schedules.md`, `payloads.md`, `delivery.md`), код `src/cron/`.

- Планировщик живёт в процессе Gateway. Задачи, состояние и история в общей SQLite, переживают рестарт.
- Виды расписания: разовое `--at`, `every`, cron-выражение (библиотека `croner`), динамический темп (pacing), условия-вотчеры (event triggers/stream sources), shortcut `/loop`.
- Payload: `agentTurn` (ход агента), системное событие в main-сессию, `command`, `script`.
- Стили сессии: `main`, `current`, `isolated` (свежая сессия `cron:<jobId>`), `session:<key>` (кастомная). Параметры задачи: `model`, `fallbacks`, `thinking`, `--light-context`, `--tools`, `timeoutSeconds`, `idleOnly`, `wakeMode`.
- Доставка: `announce` в канал/владельцу, webhook, none; уведомления о сбоях; авто-отключение после повторных ошибок.
- Таймауты: сторожевой таймер планировщика 60 мин на агентный ран, 10 мин на command, 5 мин на script; отдельные фазовые таймауты на «setup/startup stall» (cold-start, auth, context-engine).
- Восстановление после рестарта: терминальный результат восстанавливается без повторного выполнения; прерванный agent-turn по расписанию получает один повторный запуск с просьбой «сверить сделанное»; command/script и возможная повторная доставка не воспроизводятся автоматически.
- Просроченные задачи при старте не гонятся сразу (чтобы старт Gateway не упирался в LLM), а переносятся.
- **Защита от пустых ответов**: если первый результат - промежуточный статус («on it», «pulling everything together») и нет детей, отвечающих за итог, раннер переспрашивает один раз за реальным результатом (`how-it-works.md`, «Isolated run hardening»).
- **Продвижение повторов в расписание**: агент сам предлагает превратить повторяющийся запрос в cron-задачу, создаёт её включённой и сразу делает пробный запуск в тот же чат; при провале задача удаляется (`how-it-works.md`).
- Scratch задачи: заметки/чеклист на задачу в БД (`openclaw automations scratch <id>`), `skipIfScratchEmpty`, «тихие результаты» (`NO_REPLY`).

### 3.4 Heartbeat: что от него осталось

`docs/gateway/heartbeat.md` теперь страница-миграция. Периодический heartbeat убран из ядра; `openclaw doctor --fix` превращает его в обычную cron-задачу. `HEARTBEAT.md` как файл workspace «retired» (`docs/reference/templates/HEARTBEAT.md`), инструкции живут в scratch задачи.

Конкретно по умолчанию (`src/cron/default-proactive-job.ts`): при явной настройке создаётся ровно одна задача «Proactive check»:

- расписание every 30 минут (провайдер может задать иную каденцию);
- сессия = главная сессия агента, `idleOnly: true` (ждёт простоя), `wakeMode: "now"`;
- промпт: «Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.»;
- доставка `announce` владельцу; пустой чеклист - пропуск запуска без вызова модели.

Урок: даже у OpenClaw «опрос раз в 30 минут» дорогой по контексту (он идёт в главную сессию, с полной подсказкой), поэтому они добавили `skipIfScratchEmpty` и `idleOnly`.

### 3.5 Standing orders и standing intents

- `docs/automation/standing-orders.md`: «постоянные полномочия» программ - это просто раздел в `AGENTS.md` (Scope, Trigger, Approval gate, Escalation, шаги, чего не делать), а время срабатывания обеспечивает cron-задача, чей промпт ссылается на программу. Дёшево и прозрачно.
- `docs/concepts/standing-intents.md`: «когда в разговоре появится X, напомни Y». Хранится в SQLite агента, проверяется перед допустимыми интерактивными ответами (правило без модели, по ключевым словам); дефолты: cooldown 24 ч, максимум 3 срабатывания, создаёт только владелец (инструмент `intent`).

### 3.6 Фоновые процессы и хуки

- `exec`/`process` фоновые команды: по завершении push-пробуждение (completion wake) возвращает событие в исходный тред (`docs/gateway/background-process.md`, `docs/tools/exec.md`).
- Хуки: `docs/automation/hooks.md` (внутренние HOOK.md-скрипты на события `command:new`, `agent:bootstrap`, `gateway:startup`), `BOOT.md` (чеклист при старте Gateway, хук `boot-md`, по умолчанию выключен), webhooks, Gmail PubSub, `docs/automation/imap.md`, `mcp-events.md`.
- Restart recovery (`docs/gateway/restart-recovery.md`): принятые сообщения переживают управляемый рестарт, недообработанный ход повторяется в начале очереди сессии.

### 3.7 Проверка завершения и отчёт

- Детерминированные проверки: состояние хода `lifecycle: end|error`, `terminalReply`, `terminalReceipt` с `sourceReplyDelivered` (доказательство, что итог дошёл до внешнего чата) - `docs/concepts/agent-loop.md`.
- Для cron: `completion-status` (`src/cron/completion-status.ts`), `delivery-outcomes`, структурные признаки отказа выполнения (`SYSTEM_RUN_DENIED` и т.п.), чтобы заблокированная команда не считалась «зелёным» запуском.
- Из семантики: проверка «сделано ли» остаётся на модели (Execution Bias: «verify before finalizing»), на цели `/goal` (модель сама отмечает `complete`) и на ревью-инструментах (`docs/tools/autoreview.md`, `extensions/autoreview`). Независимого верификатора «артефакт действительно получен» в ядре нет - это слабое место, которое DSHBOT может закрыть.
- Отчёт: `announce` в чат/канал владельца, `progress_card` (план + статус, `docs/tools/progress-card.md`), черновики прогресса (`docs/concepts/progress-drafts.md`), Workboard-карточки с доказательствами.

---

## 4. Память

Источники: `docs/concepts/memory.md`, `memory-architecture.md`, `memory-search.md`, `dreaming.md`, `compaction.md`, `active-memory.md`, `user-model.md`.

### 4.1 Файлы (workspace агента, по умолчанию `~/.openclaw/workspace`)

| Файл | Роль | Инъекция |
|---|---|---|
| `AGENTS.md` | Инструкции, правила, standing orders. Пишет только человек | всегда в начале сессии |
| `SOUL.md` | Характер и тон | всегда |
| `IDENTITY.md` | Имя, аватар, vibe | всегда |
| `USER.md` | Профиль пользователя: директивы с датой наблюдения и статусом active/superseded | всегда, отдельный малый бюджет |
| `MEMORY.md` | Курируемая долгая память: решения, устойчивые факты | в начале сессии (в Codex-пути вместо вставки - указатель на `memory_search`) |
| `BOOTSTRAP.md` | Первый запуск; агент выполняет и удаляет | только новый workspace |
| `memory/YYYY-MM-DD.md` | Дневные заметки, пишет агент по ходу | НЕ в промпт; по запросу `memory_search`/`memory_get`; сегодня и вчера подтягиваются один раз на голый `/new`/`/reset` |
| `DREAMS.md` | Дневник «снов» (сводки консолидации) для человека | никогда в промпт |
| `TOOLS.md` | заметки об инструментах (шаблон 542 байта) | в шаблонах |

Шаблоны: `docs/reference/templates/` (`AGENTS.md` 7,3 КБ, `SOUL.md` 1,7 КБ, `IDENTITY.md` 1,6 КБ, `USER.md` 1,3 КБ, `BOOTSTRAP.md` 7,6 КБ, `TOOLS.md` 0,5 КБ).

### 4.2 Уровни (tier model) и провенанс

`docs/concepts/memory-architecture.md`: инструкции (человек), curated core (`MEMORY.md`, `USER.md`; пишет только консолидация или прямая просьба), эпизодический уровень (дневные заметки, транскрипты), проспективный (standing intents, cron), review (`DREAMS.md`).

Принципы: нет скрытого состояния (всё файлы); «запись - самое сложное», поэтому курирование вынесено из горячего пути в фоновый проход; запись - граница безопасности (провенанс при записи, а не сканирование); фиксированные правила + модель внутри границ; сбои памяти не блокируют ответ (таймаут/фоллбэк на каждом шаге).

Провенанс: каждая запись индекса несёт класс происхождения (`owner`, агент, `untrusted`, `system`), поля в SQLite, которые модель не может править текстом. Сессии cron/heartbeat/сабагентов не производят кандидатов в долгую память. Контент, пришедший из сети (web fetch, браузер), «заражает» остаток хода и считается `untrusted`, в долгую память не продвигается.

### 4.3 Поиск

- Инструменты `memory_search` (параметр `maxResults`) и `memory_get` (лимит символов `memoryGetMaxChars`).
- Индекс: SQLite (FTS/BM25 + векторы), опционально PostgreSQL (экспериментально; `pg_trgm`, `vector`), плагин `memory-lancedb`, `memory-wiki`. Гибридный поиск: вес вектор/текст, чанки Markdown с прикреплением заголовка к следующему чанку.
- Эмбеддинги: провайдер выбираем (`docs/concepts/memory-search.md`), режим `provider: "none"` даёт только ключевой поиск (`fts-only`).
- Индексация транскриптов: коалесцирование уведомлений 5 секунд, фоновый воркер, батч чанков и эмбеддингов в одной транзакции.
- Active Memory (`docs/concepts/active-memory.md`): блокирующий под-агент глубокого вспоминания, запускается только если сообщение спрашивает о прошлом и правило-based память не нашла сильного совпадения («escalate» по умолчанию, чтобы обычные ответы оставались быстрыми).

### 4.4 Как агент пишет память

- По ходу работы дописывает наблюдения в дневной файл (инструкция в сгенерированных workspace-инструкциях).
- Перед компакцией - «memory flush»: отдельный ход, где доступны только `read` и append-only `write`, сохраняет несохранённый контекст в дневную заметку, чтобы компакция его не стёрла (`docs/concepts/compaction.md`).
- Dreaming (`docs/concepts/dreaming.md`): плановая фоновая задача (cron) в три фазы. Light и REM только дедуплицируют/ставят кандидатов; Deep продвигает через два шлюза: (1) правило-ранжирование по сигналам (релевантность вспоминаний, частота, разнообразие запросов, свежесть, повторяемость по дням), `untrusted`/`system` исключаются структурно; (2) модельная консолидация текущего `MEMORY.md` с кандидатами. Результат принимается только если проходит структурную валидацию, укладывается в бюджет файла и не теряет больше ограниченной доли записей; замена файла - оптимистичная конкуренция (хеш до атомарного rename). Прообраз каждой принятой правки сохраняется, сводка пишется в `DREAMS.md`.
- Усечение: лимит на файл 20 000 символов, всего 60 000 символов на bootstrap-файлы (`agents.defaults.bootstrapMaxChars`, `bootstrapTotalMaxChars`). Файл на диске цел, усекается только инъекция, в промпт добавляется короткое уведомление.

### 4.5 Компакция

- Одна модельная заявка на суммаризацию всей старой истории, вход ограничен 160 000 символов (~40 000 токенов) с распределением: новые сообщения целиком (половина бюджета), старые пользовательские реплики обрезаны до 2000 символов (четверть), самое старое (десятая часть), остальное равномерными кусками по 6000 символов (`docs/concepts/compaction.md`).
- Режим `safeguard` по умолчанию: аудит качества сводки (структура, нерешённые просьбы, точные идентификаторы), ограниченное число корректирующих попыток, иначе лучший доступный вариант.
- Пары вызов-результат инструмента не разрываются при выборе точки разреза. Полная история остаётся на диске.
- Отдельные настройки: `agents.defaults.compaction.model`, `thinkingLevel`.
- Планировщик компакции исполняется в воркер-пуле (`packages/worker-runtime`).
- Pruning результатов инструментов: `docs/concepts/session-pruning.md`; потолок результата инструмента зависит от окна: 16 000 символов (<100K токенов), 32 000 (>=100K), 64 000 (>=200K), и не больше 30% окна (`docs/reference/token-use.md`).

---

## 5. Персона и системный промпт

Источник: `docs/concepts/system-prompt.md`, `docs/concepts/soul.md`, `docs/reference/token-use.md`, `src/agents/bootstrap-files.ts`, `src/agents/bootstrap-budget.ts`.

### 5.1 Три слоя сборки

1. `buildAgentSystemPrompt` - чистый рендерер из явных входов.
2. `buildConfiguredAgentSystemPrompt` - применяет конфиг (владелец, TTS, алиасы моделей, режим цитирования памяти, делегирование).
3. Адаптеры рантайма (embedded, CLI, превью, компакция) собирают живые факты (инструменты, песочница, возможности канала, файлы контекста, вклад провайдера).

Поверхность для провайдеров: можно заменить три именованные секции (`interaction_style`, `tool_call_style`, `execution_bias`), добавить стабильный префикс выше границы кэша и динамический суффикс ниже границы (`resolveGpt5SystemPromptContribution`).

### 5.2 Секции промпта (полный режим)

Tooling; Execution Bias; Promised Work; Care; Runtime Context; Skills; OpenClaw Control (config/restart/update); Messaging; Workspace; Documentation; Workspace Files (inject); Sandbox; Assistant Output Directives; UI Presentation; Collapsible Details; Runtime (одна строка: host/OS/node/model/сессия); Reasoning; Silent Replies (`NO_REPLY`). Режимы: `full`, `minimal` (сабагенты: без Memory Recall, Model Aliases, User Identity, Directives, Messaging), `none` (одна идентичная строка).

### 5.3 Граница кэша - центральная идея

Крупный стабильный контент (Project Context = bootstrap-файлы, фиксированная политика, общий Runtime Context) стоит ВЫШЕ внутренней границы prompt-cache. Изменчивое (каталог инструментов, Skills, Memory Recall, Messaging, Runtime, Sandbox) - НИЖЕ. Дата/время/состояние exec/сабагентов идут отдельным типизированным runtime-context сообщением, чтобы не ломать префикс истории. На прямых Anthropic-маршрутах и нативном OpenAI Responses сессия «пинит» обе стороны границы, а обновлённые разделы добавляются как сообщения-инструкции ПОСЛЕ текущего хода (префикс байт-в-байт стабилен). Новые секции или инструменты откладываются до следующей сессии, если владелец не определил явную инвалидацию (`AGENTS.md` репо, раздел «Stable conversation context»). Сводка кэша: `docs/reference/prompt-caching.md`.

### 5.4 Сколько токенов это занимает

Данные из репо (не мои замеры):

- Пример `/context list` в `docs/concepts/context.md`: системный промпт 38 412 символов (~9 600 токенов), из них Project Context 23 901 символ (~5 976 токенов); AGENTS.md ~436 токенов, SOUL.md ~228, IDENTITY.md ~53 (пример показателен для небольшого workspace).
- Зафиксированный снапшот пути Telegram-direct через Codex-харнесс (`test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md`, раздел «Rough Text Token Estimates»):
  - инструкции модели Codex: 21 335 символов (~5 334 токенов);
  - OpenClaw developer instructions: 3 490 символов (~873 токенов);
  - parent-local (SOUL/IDENTITY/USER): 507 символов (~127 токенов);
  - только текст итого: ~6 876 токенов;
  - **JSON динамических инструментов: 80 956 символов (~20 239 токенов)**;
  - итого с инструментами: ~27 115 токенов на запрос до первого слова пользователя.
- Состав этого JSON (`codex-dynamic-tools.telegram-direct.json`, считал по файлу): `openclaw` namespace 36 КБ (в нём automations, gateway, nodes, session_status, sessions_history/list/search/send, subagents, tts, web_fetch, web_search), `sessions_spawn` 9,9 КБ, `message` 3,9 КБ, остальное малое. Всего 5 верхнеуровневых записей, но 12+ вложенных инструментов.
- Для локальной модели (Ollama) профиль урезан до 7 инструментов (`tool_search`, `tool_describe`, `dispatch_action`, `web_search`, `web_fetch`, `memory_search`, `memory_get`), ~5,2 КБ JSON (`test/fixtures/agents/prompt-snapshots/local-ollama/default-tool-surface.json`).

Следствие: без Tool Search/кэширования вход «пустого» запроса у OpenClaw 25-30 тыс. токенов. Кэш это смягчает по цене, но не по латентности холодного старта и не при смене модели/уровня thinking.

---

## 6. Skills, плагины, ClawHub, MCP, каналы

### 6.1 Skills

`docs/tools/skills.md`, `docs/tools/creating-skills.md`.

- Формат: каталог со `SKILL.md` (YAML frontmatter с `name`, `description`, gating по env/конфигу/наличию бинарников + markdown-тело). Скиллы могут содержать скрипты, референсы, ассеты.
- Порядок загрузки (выше приоритет): workspace `skills/`, `<workspace>/.agents/skills`, `~/.agents/skills`, managed `<state>/skills`, workshop (выученные агентом), bundled, extra dirs + плагины. Грубая вложенность до 6 уровней.
- В промпт попадает только компактный СПИСОК (имя + описание), лимит `skills.limits.maxSkillsPromptChars`; тело читается по запросу через `read`. С 2026.10.1 есть поиск по установленным скиллам даже когда список обрезан (читаются файлы до 256 КиБ; поиск покрывает до 16 КиБ на файл).
- Skill Workshop / self-learning (`docs/tools/skill-workshop.md`, `self-learning.md`): агент сам сохраняет процедуры «после трудной многошаговой работы» и правит выученный скилл, который вводил в заблуждение. Каждые 10 итераций модели в сессии ставится фоновый обзор (старт после 30 секунд простоя, по одному, уступает активным ранам; не считаются cron, heartbeat, hook, subagent, memory, Incognito). Любая правка применяется сразу, предыдущая версия сохраняется, есть undo. Не использованные 30 дней выученные скиллы архивируются. Это готовый образец «само-развития».
- Skill-плагины и каталоги: `skills/clawhub`, `skills/skill-creator`.

### 6.2 Плагины

`docs/plugins/building-plugins.md`, `docs/plugins/manifest.md`, `packages/plugin-sdk`, `src/plugin-sdk/AGENTS.md` (лестница выбора поверхности возможностей).

- Плагин = пакет ESM-TypeScript с `openclaw.plugin.json` (id, категории, `activation.onStartup`, `contracts`, `providerEndpoints`, `modelCatalog` и т.д.) и полем `openclaw.extensions` в `package.json`.
- Виды: канал, провайдер модели/медиа/поиска/речи, CLI-backend (запуск локального AI CLI), инструмент, хук, память, харнесс.
- Все API плагинов «экспериментальные»: фиксируйте версию хоста (`docs/plugins/building-plugins.md`).
- Принцип: «Small core, capable plugins» - любая модельная добавка ядра увеличивает контекст, поэтому опциональное выносится в плагины (`AGENTS.md` репо).
- Холодный старт плагинов: `activation.onStartup:false` у DeepSeek-плагина (`extensions/deepseek/openclaw.plugin.json`) означает ленивую активацию.

### 6.3 ClawHub

Каталог сообщества: `openclaw plugins install <pkg>` по умолчанию ставит с ClawHub (`clawhub:`), либо `npm:`. Установка плагинов и скиллов проходит `security.installPolicy` и хук `before_install` (allow/warn/block). Для DSHBOT это ориентир, а не зависимость; доверять стороннему коду нужно осторожно (см. правило проверки риска в глобальных инструкциях).

### 6.4 MCP

`docs/tools/mcp.md`, `docs/cli/mcp`, `src/mcp/`. Серверы MCP (Streamable HTTP, SSE, stdio) в `mcp.servers`; их инструменты идут через те же профили и политики; инструкции сервера обрезаются до 2000 символов на сервер в промпте. Есть и обратная роль: `openclaw mcp serve` отдаёт разговоры каналов как MCP-сервер. MCP Apps (2026.10.1): интерактивные панели рядом с чатом.

### 6.5 Каналы (Telegram как образец)

- 20+ каналов в `extensions/*` и `docs/channels/`. Telegram: grammY (`grammy`, `@grammyjs/transformer-throttler`), long polling по умолчанию, вебхук опционально, темы форумов, реакции, опросы, inline-кнопки, нативные команды, медиа, голосовые, черновые стримы (`draft-stream*.ts`), approval-карточки.
- Входящие идут через durable-очередь ingress в SQLite (пережить рестарт), повтор по receipt (`extensions/telegram/README.md`).
- Исходящее: `outbound-adapter.ts`, `chunk-delivery.ts`, форматирование HTML (`format-html*.ts`), троттлер аккаунта.

---

## 7. Производительность: почему медленно и дорого

Ниже причины с привязкой к местам в репо. Оценки «вес вклада» мои и качественные.

### 7.1 Размер контекста запроса (главный вклад в цену и первый токен)

- ~27 тыс. токенов фиксированного входа на путь Telegram через Codex (раздел 5.4), из них ~20 тыс. - схемы инструментов. Источник: `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/*`.
- В embedded-рантайме проблему лечат экспериментальным **Tool Search** (`docs/tools/tool-search.md`): модель видит лишь `tool_search`, `tool_describe`, `dispatch_action` и ограниченный каталог имён/описаний; каталог масштабируется под окно модели (описания сокращаются раньше, чем исчезают имена). Включён автоматически для embedded и Copilot (если `tools.toolSearch` не задан). Фактически признание, что полный набор схем слишком дорог.
- **Code Mode** (`docs/tools/code-mode.md`): модель видит только `exec` и `wait`, а инструменты вызывает из маленькой JS-программы в песочнице (Node или QuickJS, `extensions/code-mode-quickjs`). Режим `auto` включает его только для моделей, помеченных `codeMode: "preferred"` (у `deepseek-v4-flash`/`pro` в `extensions/deepseek/openclaw.plugin.json` стоит как раз `"codeMode":"preferred"`).
- Bootstrap-файлы: до 60 000 символов (~15 тыс. токенов) в худшем случае (`bootstrapTotalMaxChars`); неудержимо растущий `MEMORY.md` раздувает каждый ход.
- Раздувание от истории: ограничитель результата инструмента 16-64 тыс. символов; компакция одним запросом с входом до ~40 тыс. токенов (дорогая сама по себе).

### 7.2 Постоянные накладные в каждом ходе

- Многослойная подготовка хода: резервирование контроллера сессии, глобальная ёмкость, разрешение модели/auth-профиля, сборка сессии, подписка на события, снапшот скиллов, хуки `before_*`, контекст-движок (`src/context-engine/`). Сам OpenClaw в `docs/concepts/queue.md` пишет, что подготовка «уступает циклу событий после 16 стадий или 8 мс синхронной работы», т.е. проблема блокировки event loop реальна.
- Сериализация записи транскрипта через SQLite-писателя с fencing (`activeWriterRunId`, `expectedWriterRunId`) и воркер-брокер SQLite из 2 писателей; индексация транскрипта для поиска тоже на воркерах. Это надёжно, но тяжело для простого бота.
- Пулы воркеров (`packages/worker-runtime`): compute-пул до 4 воркеров, readers до 2, лимит CPU `max(1, cpus-1)`; по `docs/agent-runtime-architecture.md`, чтение контекста транскрипта имеет локальный дедлайн 3 минуты «для холодного старта на слабом железе» - показатель того, как медленно это бывает.
- Сторожевые таймеры на «setup/startup stalls» cron-раннера (`how-it-works.md`) существуют потому, что холодный старт/auth/context-engine действительно зависают.

### 7.3 Холодный старт Gateway и CLI

- Числа из собственного отчёта `docs/reference/release-performance-sweep.md` (mock-провайдер, не реальный LLM):
  - холодный ход агента v2026.4.14: 9 819 мс; v2026.5.28: 1 908 мс (в 5,1 раза быстрее после работ по оптимизации);
  - теплый ход 7 458 -> 1 870 мс;
  - пиковый RSS агента 686 МБ -> 581 МБ;
  - `readyz` p50 по умолчанию ~1 457 мс, с 50 плагинами ~1 474 мс;
  - плагины в максимуме RSS ~386 МБ;
  - регрессионная яма конца апреля: холодный ход 47-94 с, RSS до 3,6 ГБ (v2026.4.29).
  - Свежее значение для v2026.10.x в репо я не нашёл; тенденцию по сложности системы с мая нужно считать вероятно худшей, но это предположение.
- Размер установки (там же): 361,7 МиБ свежий install, 300 пакетов в графе (пик 1 020 МБ на 2026.5.22); tarball 17,9 МБ, распаковано 81 МБ, 9 082 файла. Это только npm-пакет без `node_modules` плагинов.
- Механизмы ускорения старта, которые сам OpenClaw вынужден держать:
  - `gateway-prewarm.mjs` - «прогревочный» запуск: импортирует `dist/gateway-prewarm.js` с включённым кэшем компиляции Node, чтобы заполнить `NODE_COMPILE_CACHE`, не поднимая Gateway (30 строк, вызывает `enableOpenClawCompileCache`, `flushCompileCache`).
  - `node-compile-cache.mjs` (358 строк): кэш байткода в temp-каталоге, лимит 512 MiB / 4096 файлов / 7 дней, обслуживание раз в час с бюджетом 30 с; **главный поток Gateway сознательно работает БЕЗ кэша** (синхронный flush блокирует event loop), поэтому при унаследованном кэше делается respawn через `execve` (`docs/gateway/index.md`, «Module compile cache»). Кэш воркеров прогревают до переключения релиза.
  - `entry.respawn.ts`, `node-runtime-recovery.mjs`, `cli-parent-lifetime.mjs`: перезапуск процесса при старте.
  - Бенчи старта: `scripts/bench-cli-startup.ts`, переменная `OPENCLAW_GATEWAY_STARTUP_TRACE=1` (`docs/help/debugging.md`).
  - Плагины со `activation.onStartup:false` (ленивая загрузка), `plugin-entry.cli-laziness.test.ts` (тест на лень CLI).
- Heap: `src/daemon/gateway-heap.ts` задаёт `--max-old-space-size` от 2048 до 8192 МиБ в зависимости от доступной памяти (`GATEWAY_HEAP_FLOOR_MIB = 2048`, `GATEWAY_HEAP_CAP_MIB = 8192`). То есть они ожидают, что Gateway естественно занимает гигабайты.

### 7.4 Процессы и зависимости

- Один Node-процесс Gateway + воркеры (worker_threads) + дочерние процессы (exec, браузер Playwright/Chromium, CLI-бэкенды вроде Codex app-server, MCP stdio-серверы, sandbox-контейнеры Docker). `KillMode=mixed`, `OOMPolicy=continue`, для дочерних `oom_score_adj=1000` (`src/daemon/systemd-unit.ts`, `docs/platforms/linux.md`) - явные признаки, что дочерние процессы жрут память.
- Зависимости корня (`package.json`): `@anthropic-ai/sdk`, `openai`, `@google/genai`, `grammy`, `express`, `@modelcontextprotocol/*` (5 пакетов), `@lydell/node-pty`, `@trycua/cua-driver`, `chrome-devtools-mcp`, `linkedom`, `@resvg/resvg-js`, `@silvia-odwyer/photon-node`, `@babel/*`, `esbuild`, `kysely`, `npm` (как зависимость!), `jiti`. Нативные аддоны (resvg, photon, node-pty, SQLite), поэтому есть `scripts/docker/verify-native-addons.sh`.
- Требование к Node: 24.22.1+ или 26.12.1+ (в среде у нас может не быть; релиз 2026.10.6 вышел из-за уязвимостей CA-цепочки Node).
- Dockerfile: многоступенчатая сборка с pnpm, Playwright, бандл-плагины; образ на `node:trixie-slim`; Healthcheck с `start-period=15s` (`Dockerfile`: строка HEALTHCHECK).

### 7.5 Хронический риск: рост сложности

`AGENTS.md` репо сам говорит об усложнении: «Fencing tokens, revocation generations, multi-phase admission... need concrete failure simpler code cannot handle». Много реликтов совместимости (doctor-миграции, схема БД 30/31). 2026.10.6 - 233 PR за патч-релиз. Для DSHBOT вывод: сложность - главный враг скорости, нужен малый ядро с жёсткими бюджетами.

### 7.6 Что OpenClaw уже сделал для скорости (есть чему поучиться)

- Стабильный префикс и пиннинг границы кэша (раздел 5.3).
- Tool Search / Code Mode для уменьшения схем.
- Лёгкие режимы: `--light-context` у cron, `promptMode: minimal` сабагентам, минимальный набор для Ollama.
- Active Memory в режиме escalate (дорогой вызов только по необходимости).
- Пропуск запуска без модели: `skipIfScratchEmpty`, standing intents без LLM, команды `/new` и `/reset` отвечают без вызова модели (`docs/reference/token-use.md`).
- Tokenjuice (`docs/tools/tokenjuice.md`): сжатие шумных результатов `exec/bash` после выполнения.
- Дешёвая модель для сабагентов и компакции.
- Отложенный старт: просроченные cron-задачи не запускаются при старте.

---

## 8. Linux-деплой

Источники: `docs/install/`, `docs/platforms/linux.md`, `src/daemon/systemd-unit.ts`, `Dockerfile`, `docker-compose.yml`, `fly.toml`, `render.yaml`.

- Установка: `curl -fsSL https://openclaw.ai/install.sh | bash` (сам ставит Node) или `npm install -g openclaw@latest --allow-scripts=openclaw`; затем `openclaw onboard --install-daemon`.
- Демон: systemd user-юнит по умолчанию (или system-юнит; `src/daemon/systemd-system.ts`, `systemd-linger.ts` для lingering). Фиксированная политика (`SYSTEMD_FIXED_POLICY`): `Restart=always`, `RestartSec=5`, `RestartPreventExitStatus=78`, `StartLimitBurst=10` / `IntervalSec=300`, `TimeoutStartSec=30`, `TimeoutStopSec` = бюджет drain Gateway, `SuccessExitStatus=0 143`, `OOMPolicy=continue`, `KillMode=mixed`, `After/Wants=network-online.target`.
- Docker: образ на `node:trixie-slim`, пользователь `node`, порт 18789, `HEALTHCHECK` каждые 3 мин, `CMD ["node","openclaw.mjs","gateway"]`; compose монтирует `~/.openclaw` и workspace; sandbox через docker.sock (опционально).
- Raspberry Pi: минимум 1 ГБ RAM / 1 ядро / 500 МБ диска; рекомендуется 2+ ГБ (`docs/install/raspberry-pi.md`). Для VPS руководства Hetzner/Oracle/DO/Fly/Render/Railway/Kubernetes/Ansible/Nix.
- Фактическое: для Gateway с несколькими каналами и браузером реалистично 1-2 ГБ RSS (отчёт по производительности: 581 МБ пик агента на mock) плюс до 8 ГБ потолок heap.
- Конфиг: JSON5 `~/.openclaw/openclaw.json`; hot reload (`gateway.reload.mode="hybrid"`); секреты через SecretRef (`docs/gateway/secrets.md`); состояние `OPENCLAW_STATE_DIR`; бэкапы `docs/install/backups.md`; обновления Atomic Updates; диагностика OTel и Prometheus.
- Наблюдаемость: `openclaw doctor`, `gateway status`, `channels status --probe`, `logs --follow`, `/status`, `/context`, `/usage`.

---

## 9. Безопасность

Источники: `docs/gateway/security/`, `permission-modes.md`, `sandboxing.md`, `sandbox-vs-tool-policy-vs-elevated.md`, `tools/exec-approvals.md`, `SECURITY.md`, `VISION.md`.

- Модель доверия: «trusted gateway, untrusted execution, policy enforced by code» (README). Общий Gateway предназначен для людей, доверяющих друг другу; недоверяющим нужны отдельные Gateway.
- Входящие - недоверенный ввод: DM-каналы по умолчанию требуют pairing; allowlist, mention-gating в группах.
- Три независимых контроля: (1) sandbox (где выполняются инструменты: off / non-main / all; бэкенды Docker, Podman, SSH, OpenShell, Crabbox; доступ к workspace none/ro/rw); (2) политика инструментов (allow/deny, профили); (3) elevated (аварийный выход exec из песочницы).
- Режимы разрешений сессии: `read-only`, `guarded` (человек после allowlist), `workspace` (LLM-ревьюер: allow/deny/ask), `full` (`docs/gateway/permission-modes.md`). `full` требует `operator.admin`.
- Exec approvals (`docs/tools/exec-approvals.md`): allowlist исполняемых + привязка к реальному пути/хешу содержимого, карточки одобрения в каналах, `/approve <id> allow-once|deny`; свободный текст «да» не авторизует. Три подряд отказа ревьюера эскалируют к человеку.
- Принцип промпта: «риск гейтится в рантайме, а не в тексте промпта»; промпт не заставляет модель заранее отказываться.
- Секреты: SecretRef, отдельная маскированная выдача кредов, инструмент `secrets`; логи сырые, редактирование только на выходе (`AGENTS.md` репо).
- Защита памяти от отравления: провенанс, `untrusted` не продвигается (раздел 4.2).
- Установка плагинов: `security.installPolicy`, хук `before_install`.
- Дефолтная оговорка: «Tools run on the host for the main session unless you configure sandboxing» (README). То есть по умолчанию выполнение на хосте, песочница выключена.

---

## 10. Вывод для DSHBOT

### 10.1 Что взять (механизмы, а не код)

1. **Workspace-файлы как единственная память и персона.** `AGENTS.md` (правила и standing orders, пишет человек), `SOUL.md` + `IDENTITY.md` (персона, ~0,5 КБ), `USER.md` (директивы с датой и статусом superseded), `MEMORY.md` (курируемый короткий), `memory/YYYY-MM-DD.md` (дневник, не в промпте). Жёсткие лимиты на файл и суммарно (у DSHBOT поставить заметно меньше, чем 20K/60K символов).
2. **Граница кэша промпта.** Стабильный префикс (персона, правила) всегда одинаков байт-в-байт; всё изменчивое (время, список задач, факты) - только в конец или отдельным сообщением. Обновления каталога инструментов/скиллов не должны перестраивать префикс в середине сессии. Это особенно важно для DeepSeek: его кэш префикса даёт cacheRead на два порядка дешевле (`extensions/deepseek/openclaw.plugin.json`: input 0,14, cacheRead 0,0028 $ за 1M токенов у v4-flash), но работает только при неизменном префиксе.
3. **Cron-автоматизации в SQLite как единый механизм «проактивности».** Без отдельного heartbeat-процесса. Задача = расписание + промпт + scratch-чеклист + сессия + доставка. Важные детали из OpenClaw: `idleOnly`, `skipIfScratchEmpty` (не вызывать модель, если нечего делать), `NO_REPLY`, перенос просроченных задач при старте вместо мгновенного запуска, одноразовые задачи с `deleteAfterRun`, авто-отключение после N ошибок, один повторный запуск прерванного хода с просьбой «сверить сделанное».
4. **Цели (`/goal`) с токен-бюджетом и статусами** `active/paused/blocked/budget_limited/complete`: рантайм сам продолжает ход, пока цель активна. Бюджет останавливает «бесконечную» работу. Добавить обязательное доказательство завершения (см. 10.3).
5. **Правило «Promised Work»**: любое обещание «сделаю позже» обязано превращаться в зарегистрированную задачу (cron/watch), иначе нельзя завершать ход. Лучше проверять кодом: при финальном ответе, содержащем обещание без созданной задачи, рантайм возвращает ход.
6. **Standing orders = раздел `AGENTS.md` + cron.** Дёшево, понятно, правится человеком.
7. **Очередь сообщений по сессиям с режимами** `steer/followup/collect/interrupt` и дебаунсом 500 мс; ход в сессии строго по одному.
8. **Durable ingress**: входящее сообщение сначала фиксируется в БД, потом обрабатывается; после падения повторяется. Идемпотентность по `update_id`.
9. **Telegram**: long polling по умолчанию, pairing/allowlist владельца, HTML-форматирование с чанкованием, черновой стрим ответа, inline-кнопки одобрения.
10. **Страховки цикла**: три одинаковые ошибки инструмента - стоп; детектор повтора после компакции; ремонт кривых tool-вызовов; потолки результата инструмента (доля окна).
11. **Self-learning скиллов с undo**: фоновый обзор после N итераций, правка с сохранением предыдущей версии, архив неиспользуемых. Хороший шаблон «сам развивается» (см. 10.4).
12. **Провенанс памяти**: запись из недоверенного источника (веб, чужие сообщения) не продвигается в `MEMORY.md`. Минимально достаточно метки происхождения в индексе.
13. **Sandbox/режимы разрешений**: `read-only / guarded / workspace / full` и привязка одобрения к точному запросу.
14. **Skills как SKILL.md** со списком (имя+описание) в промпте и телом по запросу. Совместимость форматов с `~/.agents/skills` полезна: можно переиспользовать уже имеющиеся у владельца скиллы.

### 10.2 Что сделать иначе ради скорости и дешевизны

| Узкое место OpenClaw | Решение для DSHBOT |
|---|---|
| ~20 тыс. токенов схем инструментов в каждом запросе, ~27 тыс. токенов фиксированного входа | Жёсткий бюджет: цель постоянного префикса не больше 3-5 тыс. токенов. Базовых инструментов 6-8 (read, write/edit, exec, memory_search, schedule, send, spawn), остальное - деферред по запросу (`tool_search`) или скиллы. Не копировать «толстые» схемы вроде `sessions_spawn` на 9,9 КБ; схемы писать лаконично. |
| Огромное ядро: 15,9 тыс. TS-файлов `src`, 185 плагинов, 300+ зависимостей, 360 МиБ install | Малое ядро: один процесс, один SQLite-файл, Telegram как единственный канал сначала. Плагины - TS-модули харнесса, а не пакеты с манифестами и ClawHub. Ноль нативных аддонов на старте (кроме `better-sqlite3` либо встроенного `node:sqlite`/`bun:sqlite`). |
| Холодный старт: компиляционный кэш, respawn, прогрев, 1,5 с `readyz`, RSS 400-600 МБ, heap до 8 ГБ | Бот должен стартовать за долю секунды: ленивые импорты, никакого сканирования 185 плагинов, никакого doctor/migration при старте, отсутствие respawn. Бюджет по памяти: десятки мегабайт RSS на простое. Рассмотреть Bun или предкомпиляцию, если харнесс допускает. |
| Многослойная подготовка хода (резервирование, снапшоты, хуки, контекст-движок, fencing, воркеры SQLite) | Один путь хода: `message -> сессия (1 строка в БД) -> промпт -> цикл -> ответ`. Сериализация через простой per-session mutex в памяти; идемпотентность по ключу сообщения. Fencing токены и multi-phase admission не делать (OpenClaw сам считает это избыточным для большинства случаев, `AGENTS.md`: «Choose good compromises»). |
| Компакция: отдельный запрос на ~40 тыс. токенов входа, аудит качества | Компактить раньше и дешевле: порог по доле окна, фиксированный формат сводки, дешёвая модель; хранить «рабочую память задачи» структурно (цель, шаги, артефакты) в БД, чтобы сводка не требовалась для долгих задач. Pre-compaction flush оставить (дёшево). |
| Active Memory с блокирующим подагентом | Сначала FTS5/BM25 по markdown-чанкам без эмбеддингов (быстро, офлайн); векторы добавить позже и только если качества не хватает. Вспоминание по триггерам без LLM. |
| Dreaming (три фазы + модельная консолидация) | Одна ночная задача: сжать дневные заметки в `MEMORY.md` дешёвой моделью, с проверкой «не потеряно больше X% записей», с сохранением предыдущей версии. |
| Реакция по таймеру: каждые 30 минут вызов модели с полным контекстом | Сначала детерминированная проверка без модели: есть ли просроченные задачи, новые события, непустой чеклист. Модель вызывать только при наличии работы (`skipIfScratchEmpty` как правило по умолчанию). Для периодических проверок использовать компактный контекст (`light-context`), а не главную сессию. |
| Большое число провайдеров и нормализаций | Один провайдер (DeepSeek) через харнесс; фоллбэк-цепочку добавить позже. Использовать кэш префикса DeepSeek как первичный механизм экономии. |
| Модельные ревьюеры exec (`workspace` mode) | Для личного бота: allowlist + deny-list + подтверждение владельца в Telegram кнопкой только для опасного; без LLM-ревьюера (лишняя латентность и цена). |

### 10.3 Чего в OpenClaw не хватает (DSHBOT может сделать лучше)

- **Независимая проверка завершения.** В ядре «готово» определяет модель (Execution Bias «verify before finalizing», `/goal complete`). DSHBOT: для каждой задачи при создании фиксируются критерии приёмки (команда проверки, файл, ответ внешней системы); перед `complete` рантайм сам выполняет проверку и прикладывает вывод к отчёту. Модель не может закрыть задачу без прохождения проверки или явного `blocked` с причиной.
- **Явная очередь задач с состояниями** (`queued/running/blocked/done/failed`) в БД как первичная сущность, а не побочный эффект cron + goal + subagent + workboard. Один владелец состояния.
- **Бюджет на задачу** (токены, деньги, время, число шагов) на уровне задачи, а не только сессии.
- **Структурный журнал решений** (почему агент выбрал X) для само-обучения, дешёвый: строки в БД, а не транскрипты.

### 10.4 Как организовать «само-развитие» без раздувания

1. Выученные скиллы как файлы `SKILL.md` в `workspace/skills-learned/` с версиями и undo (аналог Workshop), но запуск обзора по итогам завершённой задачи, а не «каждые 10 итераций».
2. Обзор делает дешёвая модель в фоне, когда бот простаивает; не мешает ответам.
3. Любое самоизменение инструкций (`AGENTS.md`, `SOUL.md`) только как предложение владельцу (дифф в Telegram, одобрение кнопкой). OpenClaw разрешает агенту править `SOUL.md` с уведомлением («If you change this file, tell the user»), что рискованно.
4. Метрики эффективности навыка (сколько раз применён, успех/ошибка) и архивирование неиспользуемых через 30 дней - берём как есть.

### 10.5 Предлагаемый минимальный состав DSHBOT v0 (ориентир, не требование)

- Процесс: один демон (systemd user unit, `Restart=always`, ограничение `MemoryMax`), один SQLite (сессии, сообщения, очередь задач, cron, индекс памяти FTS5).
- Канал: Telegram (long polling + durable ingress + pairing владельца).
- Цикл: на DeepSeek Harness; стабильный префикс <= 4 тыс. токенов.
- Инструменты (ядро): `read`, `write/edit`, `exec` (с allowlist и подтверждением), `memory_search`/`memory_get`, `task` (create/update/complete с критериями приёмки), `schedule` (cron/at), `send`, `spawn` (сабагент с минимальным промптом).
- Автономность: очередь задач + планировщик с `idleOnly`/`skipIfEmpty` + цели с бюджетом + проверка приёмки.
- Память: `MEMORY.md` + дневные файлы + FTS5; ночная консолидация; провенанс.
- Позже: skills с self-learning, MCP, вторичные каналы, векторный поиск.

### 10.6 Что осталось непроверенным

- Реальные текущие цифры латентности v2026.10.x (в репо есть только отчёт по v2026.5.x и снапшоты промпта).
- Точный размер промпта embedded-рантайма с Tool Search (снапшот есть для Codex-пути и для Ollama).
- Содержимое `src/agents/embedded-agent-runner/run.ts` и `src/gateway/*` читалось только по документации и именам файлов, построчного разбора кода не делал.
- Поведение плагинов сообщества (ClawHub) и их риски не проверялись; к установке чужого кода применять правило проверки риска.

---

## Приложение: ключевые пути

- Обзор: `README.md`, `VISION.md`, `AGENTS.md`, `docs/releases/2026.8.1.md`
- Архитектура: `docs/concepts/architecture.md`, `docs/agent-runtime-architecture.md`, `docs/concepts/agent-loop.md`, `docs/concepts/queue.md`, `docs/concepts/session.md`, `docs/concepts/main-session.md`
- Промпт: `docs/concepts/system-prompt.md`, `docs/concepts/context.md`, `docs/reference/token-use.md`, `docs/reference/prompt-caching.md`, `docs/reference/templates/*`
- Автономность: `docs/automation/cron-jobs.md`, `docs/automation/cron-jobs/how-it-works.md`, `docs/automation/standing-orders.md`, `docs/concepts/standing-intents.md`, `docs/tools/goal.md`, `docs/gateway/heartbeat.md`, `src/cron/default-proactive-job.ts`
- Память: `docs/concepts/memory.md`, `memory-architecture.md`, `memory-search.md`, `dreaming.md`, `compaction.md`, `active-memory.md`
- Скиллы и плагины: `docs/tools/skills.md`, `skill-workshop.md`, `self-learning.md`, `docs/plugins/building-plugins.md`, `docs/tools/mcp.md`, `docs/tools/tool-search.md`, `docs/tools/code-mode.md`
- Производительность: `docs/reference/release-performance-sweep.md`, `gateway-prewarm.mjs`, `node-compile-cache.mjs`, `docs/gateway/index.md`, `src/daemon/gateway-heap.ts`, `test/fixtures/agents/prompt-snapshots/*`
- Деплой: `src/daemon/systemd-unit.ts`, `Dockerfile`, `docker-compose.yml`, `docs/platforms/linux.md`, `docs/install/*`
- Безопасность: `docs/gateway/permission-modes.md`, `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md`, `docs/tools/exec-approvals.md`, `docs/gateway/security/`
- Telegram: `extensions/telegram/README.md`, `extensions/telegram/src/`, `docs/channels/telegram/transports.md`
- DeepSeek-плагин (пригодится как справка по ценам и режимам): `extensions/deepseek/openclaw.plugin.json`
