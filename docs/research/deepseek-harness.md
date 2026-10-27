# DeepSeek Harness: разбор для DSHBOT

- Репозиторий: https://github.com/deepseek-ai/deepseek-harness (shallow clone в `refs/deepseek-harness`)
- Ревизия: `687f282e8625c6b8d11ff58211a90524be2e4317` (master), дата коммита 2026-10-17, merge PR #6408, релиз `dsh-0.2.1-rc.2`
- Дата исследования: 2026-10-23
- Лицензия: MIT (Copyright 2026 DeepSeek)
- Метод: только чтение (grep/cat/rg). Ничего из репо не запускалось, зависимости не ставились. По большинству пакетов прочитаны README и docs, не исходники; места, где читался код, указаны с `файл:строка`.

Все пути ниже относительны корня `refs/deepseek-harness`.

---

## 1. Что это

`@deepseek-ai/dsh`, версия 0.2.1-rc.2. Статус: developer preview. README прямо предупреждает: "THERE WILL BE COMPATIBILITY-BREAKING CHANGES". SAFETY.md называет проект экспериментальным, без аудита безопасности.

Стек:

- TypeScript (ESM, strict), монорепо на pnpm 11.28.5, Node `^22.19 || >=24`.
- В lockfile около 1725 пакетов (тяжёлое дерево: web, Electron-десктоп, vendored Cordis).
- Есть Python-часть: `python/sdk` (пакет `deepseek-harness-sdk`).
- Нативка: `native/` (Landlock-лаунчер и flock-биндинг), см. раздел 8.

Корневой `package.json`: `@deepseek-ai/dsh-root`.

Раскладка:

| Каталог | Содержимое |
|---|---|
| `apps/` | cli, desktop, desktop-host, plugin-market-generator, web |
| `packages/` | core, api, typert, llm, session, session-query, compaction, context, subagent, jobs, goal, schedule, skill, mcp, sandbox, shell, fs, web, interaction, preset, boot, bundle, host, client, experimental, extensions, credentials, storage, sdk, acp и др. |
| `python/` | Python SDK |
| `native/` | Rust/C++ надстройки (Landlock, flock) |
| `vendor/` | Cordis и сопутствующие библиотеки, перенесены в скоуп `@deepseek-ai/*` |
| `benchmarks/` | CI-гейты производительности |
| `docs/` | архитектура, подсистемы, cookbook, user guide |
| `.agents/` | инструкции для агентов, работающих над репо |

Запуск:

```
npx @deepseek-ai/dsh web                  # UI на 127.0.0.1:3080
dsh --profile headless "task"             # одна задача и выход
```

Правила разработки из `AGENTS.md` (он же `CLAUDE.md`), важные для нас как для потребителя:

- регистрации живут как effects (снимаются при dispose);
- поведение добавляют плагинами, а не правкой цикла;
- оба SDK проецируют один и тот же цикл;
- нет захардкоженных настроек;
- публичные API до-стабильные: при изменении правятся все потребители. Для DSHBOT это значит, что апгрейды версий будут ломающими, версию надо пинить.

---

## 2. Cordis: шина событий и модель плагинов

Принцип: "everything is a plugin". Cordis вендорится в `vendor/` и переименован в `@deepseek-ai/cordis` (4.0.0-rc.7) и `cordis-plugin-loader` (1.0.0-rc.5). Рядом: include, group, timer, hmr, cosmokit, schemastery, logger-console. Файлы: `docs/cordis-primer.md`, `docs/cordis-tutorial/01..07*.md`.

### Формы плагина

Три варианта: функция `apply(ctx, config)`, объект с `apply`, либо подкласс `Service`.

Минимальный плагин:

```ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'hello'
export function apply(ctx: Context) { console.log('hello') }
```

### Сервисы и DI

```ts
export class GreeterService extends Service {
  constructor(ctx: Context) { super(ctx, 'greeter') }
  greet(w: string) { /* ... */ }
}
declare module '@deepseek-ai/cordis' {
  interface Context { greeter: GreeterService }
}
```

Потребитель объявляет зависимость: `export const inject = ['greeter']`. Пока сервиса нет, плагин стоит в PENDING и сам стартует, когда сервис появится.

### Жизненный цикл

Состояния fiber: PENDING, LOADING, ACTIVE, UNLOADING, DISPOSED, плюс FAILED. Всё, что плагин регистрирует (`ctx.on`, `ctx.effect`, инструменты, сервисы), снимается автоматически при выгрузке. Это даёт горячую замену без утечек.

### Конфиг

Валидация через schemastery:

```ts
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
})
export function apply(ctx, config) { /* ... */ }
```

Поля `.volatile()` меняются на лету без перезапуска плагина. YAML-конфиг допускает `!!js` только в полях `config` и `disabled`. Событие: `ctx.on('loader/volatile-update', ...)`.

### Режимы событий

emit, waterfall (слушатель обязан вызвать `next()`), parallel, serial, bail. Waterfall удобен для перехватов (permission, pre-step); serial используется для `agent/turn-stopping`.

### Профили и бандлы

Шипящиеся профили: `web`, `headless`, `sdk`, `sdk-minimal`, `acp`. Пакеты бандлов лежат в `packages/bundle/*`; базовый набор строк (llm, session, sandbox-policy, approval, permission presets, tool-bash, tool-fs, skills, goal, plan-mode, token-meter, compaction-basic, subagent spawn/fork, ptc, workflow, spill, tool-result-pruner, web search/fetch, mcp-resources, otel, agent-loop с `agents: []` и др.) описан в `packages/bundle/base/cordis.patch.yml`.

Манифест бандла (в `package.json`):

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Патч:

```yaml
- insert:
    - id: dshbot-runner
      name: '@dshbot/runner'
      config: { ... }
- id: hmr
  disabled: true
```

Порядок слоёв: бандлы, затем `cordis.patch.yml` профиля, затем home-патч, затем `--patch` из CLI. Строки адресуются по `id`: патч либо заменяет `config` целиком, либо вставляет (`insert`). Профиль — каталог `$DSH_HOME/profiles/<name>` с `dsh.profile.bundles`.

Управление: `dsh plugin --profile X add file:...` (ставит через pnpm), `--dump-config` показывает итоговое дерево. `dsh-hmr` перезагружает плагины на лету; в base он включён при наличии `profileContext`, в headless/sdk/acp выключен.

### Куда класть новое поведение

Таблица "Where new behavior goes" в `docs/architecture.md`:

| Нужно | Точка расширения |
|---|---|
| адаптер модели | `ctx.llm` |
| инструмент | `ctx.tools` |
| слэш-команда | `ctx.commands` |
| фоновые задачи | `ctx.jobs` |
| входящие вебхуки | `ctx.webhookRuntime` |
| файловая система / песочница | `ctx.fs`, `ctx.sandbox` |
| перехват этапов цикла | события `agent/*`, `tools/*` |
| вброс сообщения в агента | `agent.inject()` |
| долговечное состояние | декларативное слияние `SessionEventMap` |
| цели | `ctx.goals` |
| форк агента | `ctx.agents.create({ sessionId, seed, meta })` |
| свой бэкенд хранения сессий | реализация `SessionPersistence` |

### Примеры из tutorial 07 и cookbook

Инструмент:

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
ctx.tools.register(defineTool({
  name: 'greet',
  description: '...',
  parameters: { name: { type: 'string', required: true, description: '...' } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  async execute(args, exec) { return `Hello, ${args.name}!` },
}))
```

Наблюдатель и гейт прав (`docs/cookbook/extension-cookbook.md`):

```ts
ctx.on('tools/result', (exec, result) => { /* лог */ })

ctx.on('tools/pre-execute', async (exec, next) => {
  if (!(await isAllowed(exec))) return { kind: 'deny', reason: '...' }
  return next()
})
```

Секция системного промпта:

```ts
ctx.systemPrompt.section({ name: 'tool:bash', order: 100, text: '...' })
```

Таймеры доступны через vendored `timer` как `ctx.setInterval/setTimeout/interval/timeout/debounce/throttle` (`vendor/timer/src/index.ts:4-15`), поэтому таймеры плагина тоже снимаются вместе с ним.

---

## 3. Цикл агента

Пакет `packages/core/agent-loop` (README, `src/tool-calls.ts`, `src/index.ts:308-370`). Интерфейс `Agent` живёт в `packages/core/agent` (`src/types.ts`, `runtime-types.ts` примерно 164-395). Сводка по жизненному циклу: `docs/agent-lifecycle.md`.

### Интерфейс Agent

| Метод | Назначение |
|---|---|
| `followup(msg)` | поставить сообщение в очередь после текущего хода |
| `steer(msg)` | перенаправить агента посреди хода |
| `inject(msg)` | вбросить сообщение без обязательного пробуждения |
| `send(msg, target, wakeup)` | адресная отправка |
| `cancel(cause, { keepInbox })` | прервать ход |
| `whenIdle()` | промис до простоя |
| `runMaintenance(task)` | служебная задача вне пользовательского хода |
| `status` | `'idle' \| 'running'` |
| `inbox`, `session`, `ctx` | входящая очередь, сессия, контекст |

Создание и возобновление:

```ts
const handle = await ctx.agents.create({
  sessionId, meta: { cwd }, agentOptions: { provider, model }, setup,
})
await ctx.agents.resume({ resumeSessionId, /* ... */ })
handle.dispose()
```

Агентов можно описать декларативно: `agents: [{ id, provider, model, reasoningEffort, maxTokens, cwd, sessionId, resumeSessionId }]` в конфиге `agent-loop`. Повторное монтирование с тем же `sessionId` продолжает историю.

### Последовательность хода

model, затем tools, затем снова model, пока модель не перестанет вызывать инструменты:

1. `turn/start`
2. забор входящих (inbox claim)
3. сборка системного промпта
4. `agent/pre-step` (waterfall: можно отклонить или впустить)
5. `step/start`, `agent/request`, `prepareCall`, `llm/stream`
6. `assistant/message`
7. для каждого вызова: `tool/call`, затем `tools/pre-execute`, `tools/execute`, `tools/post-execute`, затем `tool/result`
8. `step/end`
9. `agent/turn-stopping` (serial: плагин может продлить ход)
10. `turn/end`

Прочие события: `agent/created`, `agent/disposed`, `agent/status`, `agent/inbox/*`, `agent/request-error`, `agent/error`, `agent/assistant-stream` (живые кадры для UI/каналов).

### Стриминг

Кадры приходят в `agent/assistant-stream`:

```ts
ctx.on('agent/assistant-stream', ({ frame }) => {
  if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') render(frame.chunk.text)
})
```

### Параллельные инструменты

`maxParallelToolCalls` по умолчанию 10, volatile (`packages/core/agent-loop/src/index.ts:308-370`). Инструменты, помеченные parallel-safe, выполняются одновременно, exclusive-инструменты работают как барьеры.

### Остановка и охранники

- `cancel` останавливает ход; `keepInbox` сохраняет непрочитанное.
- Охранники из `packages/guard`: `repeat-tool-reminder` (пороги 3/5/8 повторов), `timeout-policy`.
- Принцип "Model-visible тождественно logged": всё, что видит модель, записано в лог.

### Субагенты

- spawn и fork (в процессе, можно продолжать);
- провайдеры acp/sdk/codex/claude-code (разовые);
- `ralph` и экспериментальный `agent-team` (`packages/experimental`);
- события `subagent/*`, ожидание `subagents.waitForChildren`.

### Цели

`packages/goal`, `tool-goal`, `command-goal`, `goal-round-driver`: одна долговечная цель на сессию, раунды продолжения идут автоматически. Это ближайшее готовое к "брать задачу и доводить до результата".

---

## 4. Провайдеры моделей

### DeepSeek (основной)

Пакеты `packages/llm/llm-deepseek` и `llm-deepseek-api-key`, провайдер `deepseek-official`. README, `src/models.ts`, `src/translate.ts:36,159`.

- Транспорт: Messages API в стиле Anthropic по адресу `https://api.deepseek.com/anthropic` (`/v1/messages`, `/v1/files`). Не OpenAI chat.
- Каталог по умолчанию: `deepseek-flash` (название DeepSeek-V4.1-Flash, текст и картинки, `systemPromptUpdate: in-history`, `toolUpdate: addition-only`) и `deepseek-v4-pro` (только текст). Контекст 1 000 000, maxTokens 256 000.
- Нестыковка: в доках и примерах SDK встречается id `deepseek-v4-flash`, а в каталоге `deepseek-flash`. Использовать id из `src/models.ts`.
- Режим рассуждений: off/low/high/max (по умолчанию high), уходит как `output_config.effort`; `off` отправляет `thinking.type: disabled`.
- Дефолт агента: `agent-default-model` = deepseek-official / deepseek-flash.
- Ключ: `DEEPSEEK_API_KEY`, база `DEEPSEEK_BASE_URL`.
- `llm-deepseek-account`: вход по токену аккаунта.

### Мультипровайдер

`packages/llm/llm-pi-ai`: адаптер для openai, anthropic, moonshotai, zai и др., плюс собственные шлюзы с протоколами `openai-completions`, `openai-responses`, `anthropic-messages`. `llm-retry` обеспечивает повторы. Руководство: `docs/user/guide/providers.md`. Значит OpenAI-совместимый бэкенд подключается без кода, анти-lock-in есть.

### API вызова

```ts
ctx.llm.stream({ provider, model, messages })   // чанки: block-start, text-delta, reasoning-delta, usage, finish
ctx.llm.prepareCall(...)
```

Это то, чем пользоваться для собственных вызовов вроде рефлексии, минуя цикл агента.

### Кэш промпта

Используется автоматический префиксный KV-кэш DeepSeek. Harness сам бережёт стабильность префикса: обновления системного промпта дописываются в историю (`in-history`), инструменты только добавляются (`addition-only`), форк-потомки делят историю с родителем, сводка компакции переиспользует префикс. Для DSHBOT это правило: не менять начало промпта между ходами, любые динамические вещи (память, время) класть в конец или в сообщения.

### Учёт токенов и стоимости

`TokenUsage` в `packages/llm/llm/src/types.ts` (около 171-190):

```
inputTokens (некэшированные), outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens
```

`packages/llm/token-meter` считает токены и давление контекста (эвристика примерно 4 символа на токен, якорь — usage от провайдера). Таблицы цен и учёта в деньгах я не нашёл: **стоимость в USD/руб придётся считать своим плагином** по usage-чанкам (cacheRead отдельно, это ключ к экономии против OpenClaw).

### Трассы рассуждений

Чанк `reasoning-delta`; для повторной подачи цепочки рассуждений в историю хранится подпись (passback). Headless-раннер печатает рассуждения в stderr. Протокол отправки в API: `docs/deepseek-llm-api-wire-extensions.md`.

---

## 5. Сессии и лог

Источник истины: append-only типизированный лог `SessionEvent`; история для модели выводится из него (`deriveMessages`). Документы: `docs/subsystems/session.md`, `docs/subsystems/persistence.md`, `docs/session-format-status.md`, `docs/persistence-catalog.md`.

### Формат

- `SESSION_FORMAT_VERSION = 4` (`packages/core/session/src/types.ts:90`).
- Хранилище по умолчанию: `session-persistence-jsonl`, JSONL со сжатием zstd (`compression: 'none'` даёт чистый текст). Файлы `session.v4.jsonl[.zst]` (кадры zstd с контрольными суммами) в `$DSH_HOME/sessions` (`root: dshHomePath('sessions')` в базовом патче).
- Версии неизменяемы, миграции соседних поколений `session-format-vN-to-vN+1`.
- Single-writer lease (одна запись на сессию), восстановление после обрыва хвоста (torn tail).

### Типы событий

turn/*, step/*, сообщения user/assistant/system/developer, tool/call, tool/result, request/header, request/context, compaction/*, goal/change, schedule/change, approval/asked|decided, model/selection, permission/preset, sandbox/mode, session/title, subagent/*, team/*, hook/*, job/*, image/offload, llm/retry.

### Свои записи в сессию

```ts
appendPluginRecord(session, 'plugin:dshbot-memory', data)   // packages/core/session/src/index.ts:492-522
pluginRecordOf(...)
```

Но вызывать их разрешено только из `packages/experimental/` (гейт `verify-plugin-record-callers`). Обходы: объявить своё событие через слияние `SessionEventMap` либо хранить состояние DSHBOT отдельно (SQLite через `storage-sqlite`/`storage-domain` или свой файл).

### Возобновление и форк

- `agents.resume` и SDK `session/resume`.
- Форк на границе хода.
- Открытый ход при возобновлении закрывается как прерванный.

### Компакция

`packages/compaction/*` (`compaction-basic`):

- автосводка по порогу (`thresholdRatio`, `retainRatio`, `modelPolicies`);
- ручная `/compact`;
- повтор после переполнения контекста;
- `tool-result-pruner` (обрезка результатов инструментов, 8192 символа), `image-offload`.

### Хранилища и поиск

- `storage-json` / `storage-sqlite` / `storage-domain` (долговечный KV).
- `session-query-sqlite` с полнотекстовым поиском: по умолчанию выключен (`openAt: never`).
- `session-projection` и кэш.

---

## 6. Headless и демон

Короткий ответ: **готового долгоживущего headless-демона с очередью задач нет.** Есть четыре режима:

### 6.1 `headless` (разовый)

`packages/bundle/headless/src/index.ts` (420 строк). Одна задача на процесс: печатает ответ и выходит; `--json` печатает события, `--session-id` продолжает сессию. Код выхода 0 успех, 1 ошибка. Портов не открывает. Учётные данные: env, затем `cwd/.env`, затем `$DSH_HOME/.env`.

Его исходник — готовый образец для собственного долгоживущего раннера:

```ts
static inject = ['agentDefaultModel', 'agents', 'sessions']
await ctx.get('loader')?.await()
const handle = await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
installModelSelection(agentCtx, { current: selection, assembled: undefined })
agent.followup(createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
}))
await agent.whenIdle()           // плюс subagents.waitForChildren
await sessions.flush(agent.session)
appExit(code)
```

`createUserMessage` — `packages/llm/llm/src/message.ts:246`; источники сообщения `MessageSourceMap` (`user`, `model`, `tool`, `system-prompt`) — `message.ts:110`.

### 6.2 `sdk` (JSON-RPC по stdio)

Профиль `sdk` = `dsh-sdk-app` + `dsh-sdk-jsonrpc-server` (`packages/sdk/{protocol,client,server}`). Построчный JSON-RPC 2.0 по stdio, живёт до shutdown или разрыва.

- Методы: `initialize`, `session/prompt`, `session/resume`, `session/wait`, `session/working-directory/get|set`, `shutdown`.
- Уведомления: `session.event`, `session.status`, `subagent.started`, `subagent.finished`.
- **Нет метода cancel и закрытия сессии**: прервать ход можно только убив рантайм. Запросы сервер-клиент не используются.
- Клиент TS: `DeepSeekHarness` / `HarnessClient` (`packages/sdk/client`). Python SDK `python/sdk` поднимает встроенный runtime wheel; `dsh_home` обязателен явно (никогда не `~/.dsh`). Документы: `python/sdk/README.md`, `docs/user/guide/python-sdk.md`.

### 6.3 `acp` (Agent Client Protocol)

Профиль `acp`, `packages/acp`: stdio, много сессий, cancel, ответы на запросы разрешений, подключение MCP, выбор модели. Если нужен внешний процесс-оркестратор, ACP функциональнее SDK.

### 6.4 `web`

`dsh web`: долгоживущий HTTP-сервер (`packages/host/webserver`, порт по умолчанию 3080, опционально TLS, флаги `--public-url`, `--trusted-host`, `--no-open`, `--port`). API через Typert Gateway (`/api/remote.mux`, WebSocket), токен запуска плюс подписанная кука, политики `remote-access` для не-владельцев. Публичного документированного API для внешних клиентов нет (`docs/api-gateway.md`, `docs/user/guide/public-deployments.md`).

### Остановка

SIGTERM даёт 5 секунд на дренаж, выход 0, второй сигнал форсирует выход (`apps/cli/reference/README.md`, около строки 127). Документов про systemd и очередь задач нет; роль очереди выполняет inbox агента (`followup/steer/inject`).

---

## 7. Что уже есть и чего нет

### Есть

| Возможность | Где | Заметки |
|---|---|---|
| Скиллы | `packages/skill/*` (`dsh-skill`) | корни `.dsh/skills`, `.agents/skills`, `~/.dsh/skills`, `~/.agents`; `SKILL.md` с frontmatter; наблюдение за файлами. Наши глобальные скиллы подхватятся |
| MCP | `packages/mcp/mcp-client`, `mcp-resources` | stdio/HTTP, инструменты `mcp__<server>__<tool>`; `docs/user/guide/mcp-memory.md` про MCP-память (Memorix, MCP Reference Memory, Engram) |
| Расписание | `packages/schedule` | once/every/daily/weekly/cron, напоминание приходит followup в исходную сессию; инструменты `schedule_create|list|update|delete`; доставка at-least-once. **Требует Web Host** (`static inject = ['agents','sessions','storageDomain','sessionController','sessionPersistence']`, `packages/schedule/schedule/src/index.ts`), в чистом headless/SDK не работает |
| Цели | `goal`, `tool-goal`, `command-goal`, `goal-round-driver` | автопродолжение раундами |
| Субагенты | `packages/subagent/*` | см. раздел 3 |
| Задачи | `ctx.jobs.start`, workflow/PTC | фоновые jobs |
| Персона | `packages/preset/persona` (`dsh-persona`), `personaPrefix` в `system-prompt`, `ctx.systemPrompt.section` | пресеты в `packages/bundle/web-app/presets` (minimal, ptc, standard); персона привязана к агенту |
| Хуки | свои плагины на `tools/pre-execute` и др.; экспериментальные мосты `hooks-claude-code`, `hooks-codex` (только command hooks) | |
| Подтверждения | `ctx.approval`, waterfall ответчиков `approval/request` | ответчиком может быть машина или Telegram; политики `ask`/`never`; пресеты read-only, workspace-write, danger-full-access; экспериментальный `auto-review` |
| Контекст | `agent-instructions` (AGENTS.md/CLAUDE.md, до 64 KiB), `session-reference`, `session-query` | экспериментальные `session-search` и `tool-session-query` (межсессионный поиск, по умолчанию выключен) |
| Вебхуки | экспериментальные `dsh-webhook` (`ctx.webhookRuntime.register(rule)`, создаёт Workspace-сессии), `webhook-github` | отдельный порт приёма |
| Прочее | `ask_user_question`, plan mode, todo, web_search/web_fetch, `lsp`, `terminal`, `ssh`, экспериментальные `browser-use`/`computer-use`, `tool-cordis` | `tool-cordis` даёт модели обзор API рантайма |

### Нет (писать в DSHBOT)

1. Telegram и любые чат-каналы: grep находит только случайные упоминания.
2. Встроенной долговременной памяти: только MCP-серверы памяти и поиск по сессиям.
3. Цикла саморефлексии.
4. Самопереписывания кода через git. `cordis-host-runner` создаёт динамические определения только в процессе, внутри realm `node:vm`, и **ни один инструмент модели их не создаёт**. Постоянство возможно через Plugin Manager (`plugin_manager`, режим Creator, нужно подтверждение; код Host выполняется в процессе вне песочницы) и установку бандла; HMR умеет перезагрузить.
5. Демона с очередью задач.
6. Cancel в SDK.
7. Учёта стоимости в деньгах.
8. Расписания без Web Host.
9. Сетевых ограничений (песочница их не накладывает).

---

## 8. Производительность

- `native/` содержит только Landlock-лаунчер и flock-биндинг (пакет `@deepseek-ai/node-addon-system`); ускорения шины событий или цикла там нет (`native/README.md`).
- `BENCHMARK.md` — лишь указатель на минимальный вариант `jsonrpc-agent` в Python SDK. Заявлений про холодный старт и накладные расходы шины в репо я не нашёл.
- Каталог `benchmarks/` — CI-гейты (`benchmarks/AGENTS.md`, `benchmarks/*/README.md`):
  - agent-continuation: продолжение с каталогом и инструментами, ожидание 900 мс на hosted CI (1125 мс с запасом 1,25x), история запроса 297 мс;
  - session-corpus: список 3000 сессий, поиск и форк на 1000;
  - active-stream-reconnect, conversation-fold, long-session-browser, terminal-io, user-text, session-open.
- Вывод: гейты защищают от регрессий и дают порядок величин (сотни миллисекунд на продолжение), но это не сравнение с OpenClaw. Своё измерение (холодный старт профиля, RSS, задержка до первого токена) надо снять до заявлений "быстрее OpenClaw". Тяжёлое дерево зависимостей (1725 пакетов, web/desktop приложения) ударит по размеру установки; для лёгкого демона собирать профиль только из нужных бандлов (`sdk-minimal` как отправная точка).
- Главный рычаг стоимости — префиксный кэш (раздел 4), а не скорость рантайма.

---

## 9. Безопасность

### SAFETY.md

Проект экспериментальный, аудита нет, не готов для продакшена. Рекомендация: запускать в одноразовой VM или контейнере с минимальными правами и бэкапами. Песочница и подтверждения снижают риск, но изоляции не гарантируют.

### Разрешения

Пресеты `permission-presets`: read-only, workspace-write, danger-full-access. Политика подтверждений `ask`/`never`. `ctx.approval` с waterfall ответчиков позволяет вставить автоматический ответчик. Документы: `docs/subsystems/approval.md`, `packages/interaction/{permission-presets,user-approval}/README.md`.

### Песочница

`sandbox-local` (`docs/subsystems/sandbox.md`):

- Linux: bwrap, затем Landlock (`native/system`);
- macOS: Seatbelt; Windows: ACL;
- режимы read-only / workspace-write / danger-full-access;
- ограничивает только файловые эффекты: **сеть и видимость процессов вне песочницы**;
- fail-closed: при недоступности ошибка `SANDBOX_UNAVAILABLE`;
- это ограничение в том же мире, а не VM;
- таймаут `bash-sandbox` по умолчанию 60 с.

### Телеметрия и приватность (важно)

Включено по умолчанию:

- `session-log-deepseek` отправляет поле `dsh_session_log` (до 8 MiB на запрос, инкрементальный суффикс) на официальный API/baseURL вне входа модели. Отключается `enabled: false` или `disabled: true` для строки. README: `packages/session/session-log-deepseek/README.md`.
- `plugin-package-inventory-deepseek` шлёт `dsh_plugin_packages`.
- Заголовки `x-deepseek-harness-user-id` (анонимный UUID), `x-deepseek-harness-session-id`, `x-deepseek-harness-compact`, User-Agent.
- OTel `session-telemetry-otel` в режиме `FEEDBACK_ONLY` на `dsh-otel-collector.deepseeksvc.com`; отключается `DSH_TELEMETRY_DISABLED`.

Всё это описано в `docs/deepseek-llm-api-wire-extensions.md`. Для DSHBOT: отключить эти строки в собственном патче с первого дня, особенно если сессии содержат клиентские данные.

### Прочее

- Установленный через Plugin Manager код Host работает в процессе и вне песочницы: это основной риск для самопереписывания.
- Секреты: `packages/credentials`; ключ из env и `.env`.

---

## 10. Выводы для DSHBOT

### Как встраивать

Собирать собственный профиль/бандл поверх `@deepseek-ai/dsh-base`, а не использовать `headless` (он завершается после одной задачи). Внутри бандла свой плагин-раннер по образцу `packages/bundle/headless/src/index.ts`: долгоживущий процесс, который создаёт или возобновляет агента (`ctx.agents.create/resume`), подаёт задачи через `agent.followup/steer/inject`, ждёт `whenIdle()`, сбрасывает `sessions.flush`. Процесс держат живым источники задач (Telegram long-polling, таймер, HTTP-приёмник) и запускают под systemd с дренажом по SIGTERM. Альтернатива: внешний оркестратор поверх `acp` (есть cancel и разрешения) или `sdk` (нет cancel).

Эскиз плагина:

```ts
export const name = 'dshbot-runner'
export const inject = ['agents', 'sessions', 'agentDefaultModel']
export function apply(ctx, config) {
  ctx.setInterval(() => pollTaskQueue(), config.pollMs)   // задачи
  ctx.on('agent/assistant-stream', ({ frame }) => { /* стрим в Telegram */ })
  ctx.on('agent/turn-stopping', async (...) => { /* рефлексия */ })
}
```

### Точки расширения под цели

| Цель | Что использовать |
|---|---|
| Задачи и очередь | inbox агента (`followup`), `goal` и `goal-round-driver`, собственный таймер или SQLite-очередь в `storage-sqlite`; встроенное `schedule` только с Web Host |
| Память | MCP-сервер памяти (`mcp-client`), секция `ctx.systemPrompt.section` с выжимкой, `agent.inject` для подкладывания фактов, `session-query`/`session-search` для поиска по истории. Помнить про кэш: память класть в конец, не в префикс |
| Рефлексия | события `agent/turn-stopping` (serial) и `turn/end`, `agent.runMaintenance(task)`, свои вызовы `ctx.llm.stream` |
| Самопереписывание | bash/fs-инструменты в git-рабочем каталоге с ветками и тестами; для кода плагинов — бандл, `dsh plugin add`, HMR; ответчик `approval/request` как политика (человек или авто-ревью). Модель-инструмента для динамических определений нет, её надо писать |
| Характер | `dsh-persona` и секции системного промпта; право отказаться реализуется инструкцией плюс гейтом на `agent/pre-step` или `tools/pre-execute`; рабочие задачи выполнять при этом всё равно |
| Telegram | плагин-канал: входящие в `ctx.agents.get(sessionId)?.followup(createUserMessage({content:[{type:'text',text}], source:{kind:'user'}}))`, исходящие из `agent/assistant-stream`, ответчик на `approval/request` через inline-кнопки |
| Стоимость | плагин на usage-чанках с таблицей цен, отдельный учёт cacheRead |

### Чего не хватает (сводка)

Telegram-канала, долговременной памяти, рефлексии, git-самопереписывания, демона с очередью, cancel в SDK, учёта денег, независимого от Web Host расписания, сетевой изоляции.

### Риски

1. API developer preview, ожидаемы ломающие изменения; версию пинить, обновления делать осознанно. Вендоренный Cordis в rc-версиях.
2. Экспериментальные пакеты (webhook, hooks-*, session-search, agent-team, auto-review) без гарантий; запись plugin-record закрыта гейтом для не-experimental кода.
3. Тяжёлое дерево зависимостей (Node 22.19+, pnpm, около 1725 пакетов, web/Electron); собирать минимальный профиль.
4. Телеметрия по умолчанию включена (session-log, inventory, OTel): отключать `session-log-deepseek`, `plugin-package-inventory-deepseek`, `otel`, `session-telemetry-otel` или ставить `DSH_TELEMETRY_DISABLED`. Это обязательный шаг перед работой с клиентскими данными.
5. Песочница покрывает файлы, но не сеть; автономный бот с bash и доступом в сеть требует VM/контейнера и ограниченных ключей. Самопереписывание с Plugin Manager выполняет код вне песочницы.
6. Миграции формата сессий (сейчас v4) при апгрейде.
7. Расхождение id модели (`deepseek-flash` против `deepseek-v4-flash`) в доках.
8. Заявления о скорости и цене относительно OpenClaw пока нечем подкрепить: в репо нет сравнительных цифр.

### Что проверить в первую очередь

1. Прототип раннера: профиль на `sdk-minimal`, плагин с `agents.create` и `followup`, замер холодного старта и RSS.
2. Подтвердить, что строки телеметрии отключаются патчем и трафик к `deepseeksvc.com` исчезает.
3. Измерить долю cacheRead на многоходовой сессии с динамической памятью.
4. Решить, где живёт состояние DSHBOT (SQLite через `storage-sqlite` или свой файл), поскольку `appendPluginRecord` недоступен.
