# Hermes Agent: разбор исходников для DSHBOT

- Репозиторий: https://github.com/NousResearch/hermes-agent (шаллоу-клон в `refs/hermes-agent`)
- Ревизия: `main @ df722c88` (коммит от 2026-10-23), релиз v0.22.5 (по условиям задачи; в `pyproject.toml` стоит `version = "0.0.0"`, тег в клоне не найден)
- Дата исследования: 2026-10-23
- Лицензия: MIT (`LICENSE`)
- Метод: только чтение (grep/cat), ничего не запускалось и не устанавливалось.
- Пути указаны относительно корня репозитория Hermes. Номера строк верны для этой ревизии.

---

## 0. Короткий итог (для тех, кто не будет читать всё)

1. Hermes построен вокруг двух инвариантов: (а) системный промпт байт-стабилен в течение разговора ради prompt cache, (б) ядро узкое, возможности живут в плагинах, skills и CLI (`AGENTS.md`, раздел «What Hermes Is»).
2. «Самообучение» это не магия, а три простых механизма: счётчики-нудж (каждые N ходов / N tool-итераций), фоновый форк агента с белым списком инструментов (`memory`, `skill_manage`, чтение файлов), и фоновый «куратор» skills раз в 7 дней. Все промпты лежат в `agent/background_review.py` и `agent/curator.py` и переносятся почти дословно.
3. «Довести до результата» обеспечивают: промпты «не останавливайся» (`TASK_COMPLETION_GUIDANCE`, `OPENAI_MODEL_EXECUTION_GUIDANCE`), `/goal` с отдельной моделью-судьёй (`hermes_cli/goals.py`), verify-on-stop (повторный пинок после правок кода без проверки), kanban-воркеры, обязанные закончить терминальным инструментом.
4. Память маленькая и жёсткая: `MEMORY.md` 2200 символов, `USER.md` 1375 символов, снимок замораживается на старте сессии. Всё остальное восстанавливается через `session_search` (SQLite FTS5, без LLM).
5. Для DeepSeek есть готовый профиль (`plugins/model-providers/deepseek/__init__.py`) и известные грабли: нужно явно задавать `thinking` и возвращать `reasoning_content` в истории.
6. Медленным и тяжёлым Hermes делает не цикл, а периферия: ~2950 файлов Python, Python 3.14, сотни модулей в gateway. Цикл и механизмы обучения сами по себе небольшие и переносятся в TS-плагины.

---

## 1. Что это: версия, стек, структура репозитория

### Стек

- Python (`requires-python = ">=3.11,<3.15"`, целевой 3.14; `pyproject.toml:15`). Все прямые зависимости пинятся точными версиями (`pyproject.toml:19-30`, комментарий про supply-chain после инцидента Mini Shai-Hulud).
- Ядро зависит от `openai`, `httpx`, `rich`, `tenacity`, `ruamel.yaml`, `python-dotenv`; провайдеро-специфичное вынесено в extras.
- TypeScript используется только для UI: `ui-tui/` (терминальный UI на Ink), `apps/desktop/` (Electron), `web/` (дашборд), `website/` (Docusaurus с документацией).
- Состояние: SQLite (`hermes_state*.py`, около 70 файлов-сиблингов), файлы YAML/Markdown в `~/.hermes/`.
- Размер: около 2950 `.py` вне тестов и около 7085 файлов в `tests/`. Это огромная кодовая база; нам нужны идеи, а не код.

### Организация кода: «фасад + сиблинги»

`AGENTS.md` (раздел «Facade + siblings layout»): каждый бывший «god file» превращён в фасад плюс файлы `<stem>_<topic>.py`. Например `run_agent.py` (фасад `AIAgent`) плюс `agent/turn_*.py` (фазы хода). Размер ограничен линтером: файл не больше 2000 строк, функция не больше 300 строк, цикломатическая сложность не больше 20.

### Главные пакеты

| Путь | Роль |
|---|---|
| `run_agent.py` | Фасад `AIAgent` (около 60 параметров конструктора), собран из миксинов |
| `agent/` | Всё ядро: цикл хода (`conversation_loop.py`, `turn_*.py`), промпты (`prompt_builder.py`, `system_prompt.py`), компрессия (`context_compressor*.py`), провайдеры/ретраи (`error_classifier.py`, `retry_utils.py`, `auxiliary_client.py`), память (`memory_manager.py`, `memory_provider.py`), обучение (`background_review.py`, `curator.py`, `review_engine.py`, `learn_prompt.py`) |
| `model_tools.py`, `toolsets.py`, `tools/` | Реестр и реализации инструментов (`tools/registry.py`, `terminal_tool.py`, `delegate_tool.py`, `memory_tool.py`, `skill_manager_tool.py`, `session_search_tool.py`, `cronjob_tools.py`, `kanban_tools.py`, `mcp_tool*.py`) |
| `gateway/` | Мессенджер-шлюз: `run.py` плюс фазы `run_*.py`, сессии `session*.py`, адаптеры `platforms/` (база `base.py`) |
| `plugins/` | Плагины: `platforms/` (telegram, discord, slack, signal, whatsapp, email, matrix и ещё около 20), `model-providers/` (около 40 провайдеров), `memory/`, `context_engine/`, `kanban/` |
| `cron/` | Планировщик: `jobs.py`, `scheduler*.py`, `executions.py`, `incidents.py`, `unreachable_retry.py`, `suggestions.py` |
| `hermes_cli/` | CLI-команды, конфиг (`config_defaults.py`), цели (`goals.py`), канбан (`kanban.py`), плагинный загрузчик |
| `skills/`, `optional-skills/` | Встроенные и необязательные skills (SKILL.md) |
| `hermes_state*.py` | SQLite-хранилище сессий и сообщений, FTS5 |
| `tui_gateway/`, `ui-tui/`, `apps/desktop/`, `web/` | Интерфейсы, JSON-RPC между Python и UI |
| `pm/`, `hermes_platform/` | Менеджер зависимостей/окружения и факты о машине |
| `evals/` | Пробы и регрессии поведения (компакция, провайдеры, cron, goals и т.д.) |
| `SOUL.md` (корень), `docker/SOUL.md` | Дефолтная персона |

---

## 2. Agent loop

### Где цикл

- `agent/conversation_loop.py:1785` — `run_conversation(...)`. Принимает `user_message`, возвращает dict с `final_response` и `messages` (`agent/AGENTS.md`, «Shape»).
- Цикл полностью синхронный (потоки, не asyncio) с проверками прерывания и бюджета. Псевдокод из `agent/AGENTS.md`:

```python
while (api_call_count < self.max_iterations and self.iteration_budget.remaining > 0) \
        or self._budget_grace_call:
    if self._interrupt_requested: break
    response = client.chat.completions.create(model=model, messages=messages, tools=tool_schemas)
    if response.tool_calls: ... append tool results ...
    else: return response.content
```

- Фазы одной итерации разнесены по файлам `agent/turn_*.py`: `turn_preflight`, `turn_iteration_prep`, `turn_request_assembly`, `turn_api_call`, `turn_api_error`, `turn_response_intake`, `turn_empty_response`, `turn_tool_round`, `turn_overflow`, `turn_truncation`, `turn_recovery`, `turn_recovery_autorecover`, `turn_stop_gates`, `turn_liveness`, `turn_final_response`, `turn_finalizer`.
- Бюджет итераций: `agent/iteration_budget.py` (потокобезопасный счётчик). По умолчанию 500 итераций у родителя, у субагента `delegation.max_iterations` = 50 (общая сумма может превышать лимит родителя). Вызовы `execute_code` возвращают итерацию в бюджет (`refund`). После исчерпания даётся одна «грейс-итерация» (`_budget_grace_call`), чтобы получить итоговое резюме.
- Формат сообщений внутри везде OpenAI (`system|user|assistant|tool`), рассуждения в `assistant_msg["reasoning"]`. Три транспорта: `chat_completions`, `codex_responses`, `anthropic_messages` (`website/docs/developer-guide/agent-loop.md`).

### Tool calls: параллельность

- Несколько вызовов за ход исполняются через пул потоков, максимум 8 воркеров: `agent/tool_executor.py:134` (`_MAX_TOOL_WORKERS = 8`).
- Решает планировщик `agent/tool_dispatch_helpers.py`: `_plan_tool_batch_segments`, `_should_parallelize_tool_batch` (строка 261). Параллельно идёт весь батч, только если все вызовы «безопасные»: чтение (`_PARALLEL_SAFE_TOOLS`, строка 33) или файловые операции с непересекающимися путями (`_extract_parallel_scope_paths`). Интерактивные (`_NEVER_PARALLEL_TOOLS`, строка 30: `clarify` и т.п.) и вызовы с неизвестной областью действия образуют барьер.
- Результаты возвращаются в исходном порядке вызовов, независимо от порядка завершения.
- Модели явно говорят батчить: `PARALLEL_TOOL_CALL_GUIDANCE` (`agent/prompt_builder.py:414`). Обоснование в комментарии: каждый лишний раунд пересылает весь контекст, значит батчинг снижает и задержку, и стоимость.
- Агентные инструменты (`todo`, `memory`, `session_search`, `delegate_task`) перехватываются до реестра таблицей `INLINE_TOOL_EXECUTORS` (`agent/inline_tool_executors.py`), без цепочек `if name == ...`.
- Защита от зацикливания: `agent/tool_guardrails.py` (N-й подряд идентичный вызов с идентичным результатом, порог 3, `STALL_GUARD_IDENTICAL_CALL_THRESHOLD`; также циклы A,B,A,B), `agent/repetition_guard.py` (вырожденные повторы в выводе модели).

### Стриминг

- `agent/stream_delivery.py`, `chat_completion_stream_monitor.py`, `auxiliary_stream_watchdog.py`. Колбэки: `stream_delta_callback`, `tool_progress_callback`, `thinking_callback`, `reasoning_callback`, `status_callback`, `step_callback`.
- В gateway на каждый ход свой стрим-«контракт» (`gateway/AGENTS.md`, «Streaming delivery contract»): префикс-стабильные черновики, финал объявляет потребитель, правка сообщения вместо повторной отправки.
- Если провайдер шлёт пустые SSE-кадры, сессия переключается на не-стриминг (`error_classifier.py:25-30`, `chat_completion_helpers._maybe_disable_streaming`).

### Контекст-компакция

- Два уровня (`website/docs/developer-guide/context-compression-and-caching.md`):
  1. Гигиена сессии в gateway при 85% окна (`gateway/run_turn_hygiene.py`), страховка перед запуском агента.
  2. `ContextCompressor` внутри цикла при 50% окна (`hermes_cli/config_defaults.py:603`, `threshold: 0.50`; для окон меньше 512K порог поднимается до 0.75). Класс в `agent/context_compressor.py` (5744 строки).
- Алгоритм: сначала обрезка старых tool results без LLM, затем выбор границ, затем структурное резюме моделью из `auxiliary.compression`. Хвост «lean»: около 2.5% окна (10K–25K токенов) (`config_defaults.py:614`).
- Шаблон резюме (`agent/context_compressor.py:3954-4100`, `_summary_template_sections`): разделы `Goal`, `Constraints & Preferences`, `Completed Actions` (нумерованный список `ACTION target — outcome [tool: name]`), `Active State`, `Blocked`, `Key Decisions`, `Errors & Fixes` (с цитатами поправок пользователя), `Resolved Questions`, `Relevant Files`, `Critical Context`. Итеративное обновление: «PRESERVE all existing information... Move items from In Progress to Completed Actions».
- Префикс резюме защищается от «воскрешения» старых задач (`context_compressor.py:610-665`): «Treat ONLY the latest message as the active task... Reverse signals ('stop', 'undo', 'never mind') must immediately end any in-flight work». История этих формулировок хранится в самом коде (каждая версия выпущена после реального инцидента), что полезно как набор эталонных формулировок.
- Откат при сбое: охлаждение 60s, затем 300s, затем 900s (в `state.db`), затем детерминированное резюме без LLM.
- Микро-компакция (по одному обмену за ход) выключена по умолчанию, ломает кэш каждый ход (`website/docs/developer-guide/micro-compaction.md`).
- Список дел `todo` переживает компакцию: `tools/todo_tool.py` (заголовок `TODO_INJECTION_HEADER`).
- Плагинный движок контекста: `agent/context_engine.py`, конфиг `context.engine`.

### Субагенты и делегирование

- `tools/delegate_tool*.py`, документация `website/docs/user-guide/features/delegation.md`. `delegate_task(goal, context)` или `tasks=[...]` (до 10 параллельных по умолчанию). Субагент стартует с чистым контекстом и знает только `goal` и `context` («Subagents know nothing»). Родитель получает только итоговое резюме.
- Корневые вызовы идут в фоне: возвращается handle, результат приходит новым сообщением (`tools/async_delegation*.py`). Доставка завершений «минимум один раз», с учётом рестарта.
- Опциональный `output_schema`: JSON Schema для ответа, одна коррекционная итерация при несоответствии; сырой текст сохраняется, если и после неё не валидно.
- Можно закрепить отдельную модель/провайдера для детей (`config_defaults.py:1342`, `delegation.model/provider/base_url`).
- Фоновые процессы принадлежат создавшему их агенту и убиваются при закрытии ребёнка.

### Прерывание

- `agent/interrupt_control.py`: мягкое/жёсткое прерывание, очереди steer/redirect. Причины: «explicit stop requested», «user sent a new message», «user interrupt».
- HTTP-запрос идёт в фоновом потоке, основной поток ждёт ответ, событие прерывания или таймаут; при прерывании ответ отбрасывается, в историю частичный ответ не попадает (`agent-loop.md`, «Interruptible API Calls»).
- `busy_input_mode` (`config_defaults.py:844`): что делать с новым сообщением во время работы: `interrupt` (по умолчанию) | `queue` | `steer`.
- `/steer`: сообщение пользователя вставляется отдельной user-строкой после результата инструмента в маркерах `[OUT-OF-BAND USER MESSAGE]` (`prompt_builder.py:565-610`). Системный промпт заранее объясняет модели, что только этот маркер имеет полную силу пользователя (иначе модель отказывалась считая это prompt injection, см. комментарий там же).
- Сторожевой таймер хода `agent/turn_liveness.py`: по умолчанию 600s без активности, опрос каждые 15s, принудительно обрывает «зависший» ход.

---

## 3. Подхват задач и доведение до результата

### Gateway и каналы

- `gateway/run.py` (фасад) плюс `run_startup.py`, `run_inbound*.py`, `run_turn*.py`, `run_busy.py`, `run_goals.py`, `run_watchers.py`, `run_notifications*.py`, `run_shutdown*.py`. Правила: `gateway/AGENTS.md`.
- Адаптеры платформ лежат в `plugins/platforms/`: telegram, discord, slack, signal, whatsapp, whatsapp_cloud, matrix, mattermost, email, sms, irc, line, teams, feishu, dingtalk, wecom, weixin, qqbot, google_chat, bluebubbles, ntfy и др. База: `gateway/platforms/base.py`; руководство: `gateway/platforms/ADDING_A_PLATFORM.md`. Плюс `webhook.py` и OpenAI-совместимый `api_server*.py`.
- Один процесс gateway обслуживает много профилей; каждая сессия имеет ключ, группа делится на сессии по участникам (`group_sessions_per_user: true` в `cli-config.yaml.example`).
- Два барьера сообщений во время работы: базовый адаптер ставит сообщение в `_pending_messages`, раннер перехватывает `/stop`, `/new`, `/queue`, `/status`, `/approve`, `/deny` (`gateway/AGENTS.md`).
- Авторизация: `gateway/authz_mixin.py`, `gateway/pairing.py` (DM-pairing), группы только по участникам.
- Доставка файлов: «Deliverable Mode» (`website/docs/user-guide/features/deliverable-mode.md`). Gateway сам находит абсолютные пути в ответе агента (вне блоков кода) и отправляет как нативные вложения; агенту достаточно написать путь.

### Cron и расписания

- `cron/jobs.py` (хранилище), `cron/scheduler.py` и `scheduler_*.py` (тик). Задачи создаёт агент инструментом `cronjob` или человек через `hermes cron ...` / `/cron` (`cron/AGENTS.md`).
- Форматы расписания: длительность (`30m`), «every 2h», 5-польный cron, ISO one-shot.
- Поля задачи: `skills`, `model`/`provider`, `script` (предварительный скрипт, stdout вливается в промпт; `no_agent=True` делает скрипт всей задачей), `context_from` (вывод задачи A в промпт задачи B), `workdir`, доставка в несколько платформ.
- Wake gate: если последняя строка stdout скрипта — JSON `{"wakeAgent": false}`, LLM вообще не запускается (`cron/scheduler_prompt.py:_parse_wake_gate`). Это очень дешёвый способ мониторинга: сначала скрипт, и только при изменениях будится модель.
- Тишина: ответ ровно `[SILENT]` подавляет доставку (`cron/scheduler_prompt.py:_CRON_HINT`, строки 257-277). Подсказка также запрещает рекурсию («NEVER create or update a cron job because of recurring language in the task prompt») и вводит `[CRON_FAILURE]` в первой строке для пометки провала.
- Надёжность (`cron/AGENTS.md`): сторож неактивности 600s (по простою, а не по стенным часам), `next_run_at` сдвигается ДО запуска (at-most-once при падении), окно догоняния пропущенных запусков равно половине периода (от 120s до 2h), блокировка тика на профиль, при headless-тике без gateway задачи не запускаются, а помечаются ошибкой.
- Инциденты: `cron/incidents.py` группирует ошибки по `(job_id, сигнатура)`, повторный пинг владельцу не чаще `cron.failure_repeat_alert_hours`, состояние `detected → alerted → resolved/closed`.
- Автоповтор только для «не дошли до модели» (сеть/DNS, ноль вызовов API): через 5, 15, 30 минут (`cron/unreachable_retry.py`). Побочных эффектов не было, поэтому повтор безопасен. Общий ретрай упавших задач не делается.
- Предложения: `cron/suggestions.py` — готовые спецификации задач, которые пользователь принимает одним нажатием; ничего не создаётся автоматически (consent-first).
- Сессии cron идут с `skip_memory=True` и `skip_background_review` (форк стоит около 30K токенов за событие без пользы без человека, `agent/turn_finalizer.py:773`).

### Внутрисессионные петли: /goal, /loop, /heartbeat

- `/goal` (Ralph-loop), `hermes_cli/goals.py` (1780 строк), `website/docs/user-guide/features/goals.md`. После каждого хода отдельная модель-судья (`auxiliary.goal_judge`) решает `done | continue | blocked | wait`; при `continue` в ту же сессию подаётся продолжение (`CONTINUATION_PROMPT_TEMPLATE`, строка 60). Бюджет по умолчанию 20 ходов (`DEFAULT_MAX_TURNS`, строка 32).
- Промпт судьи (`goals.py:113-173`), суть: «You are a strict judge... DONE requires the deliverable to actually exist... BLOCKED is a refusal, not a completion... WAIT only if re-poking now would be pure busy-work... CONTINUE is the default when in doubt». Ответ строго JSON одной строкой: `{"verdict": "...", "reason": "..."}`.
- Контракт завершения (`goals.py:287`, `GoalContract`): поля `outcome`, `verification`, `constraints`, `boundaries`, `stop_when`. С контрактом судья говорит DONE только при конкретном свидетельстве (вывод команды, фрагмент файла), «not a claim like done» (`JUDGE_USER_PROMPT_WITH_CONTRACT_TEMPLATE`, строка 214). Контракт можно сгенерировать (`/goal draft`, `DRAFT_CONTRACT_SYSTEM_PROMPT`, строка 239).
- Quality gates (`goals.py:344`, `GoalGate`): shell-команда, которая обязана пройти до признания цели выполненной (таймаут 300s, 3 ретрая); при провале хвост вывода (3000 символов) возвращается агенту (`CONTINUATION_PROMPT_GATE_FAILED_TEMPLATE`, строка 97), судья не вызывается. Это детерминированная проверка результата, а не мнение модели.
- Защитные пределы судьи: 3 подряд ошибки парсинга и 5 подряд транспортных ошибок ставят цель на паузу (строки 43-46), судья fail-open: сломанный судья не должен заклинить цикл.
- Режим WAIT: цель паркуется на фоновом процессе (`/goal wait <pid>`) или на секундах, судья сам может выбрать WAIT, если агент ждёт CI.
- `/loop` (`website/docs/user-guide/features/loops.md`): повтор промпта по таймеру внутри сессии; режим self-paced с экспоненциальным откатом 1 мин → 15 мин, пока ответы не меняются; остановка по `LOOP_COMPLETE` в ответе, `--times N`, `--until <условие>` (судья), лимит `loops.max_ticks` = 100. Активная цель имеет приоритет над петлёй.
- `/heartbeat every 10m ...` (`heartbeat.md`): одно периодическое сообщение на сессию, срабатывает только в простое, пропущенные тики склеиваются в один, в gateway тихий ответ `NO_REPLY`/`[SILENT]` ничего не отправляет; в промпт встроена защита «не придумывай работу».

### Kanban: durable-доска для нескольких агентов

- `hermes_cli/kanban.py`, `tools/kanban_tools.py`, `plugins/kanban/`, `gateway/kanban_watchers*.py`, документация `website/docs/user-guide/features/kanban.md` (1469 строк).
- Каждая задача — строка в `~/.hermes/kanban.db`, каждый воркер — отдельный OS-процесс с собственным профилем/сессией. Диспетчер запускает воркеров с набором `kanban_*` инструментов: `kanban_show`, `kanban_complete`, `kanban_block`, `kanban_request_review`, `kanban_request_changes`, `kanban_heartbeat`, `kanban_comment`, `kanban_create`, `kanban_link`, `kanban_unblock`.
- Проверка «сделано»: воркер обязан закончить ход терминальным инструментом. Если модель «рассказала следующий шаг и остановилась», диспетчер записал бы `protocol_violation`; поэтому есть пинок (`agent/kanban_stop.py`, `agent/turn_stop_gates.py:_kanban_stop_nudge`, до 2 попыток).
- Предупреждение при 90% бюджета итераций (`agent.budget_warning_ratio`); жёсткий лимит, итоговое резюме без инструментов и «автомат» по подряд провалам остаются.
- PR-контракты: `completion_contract` проверяет required checks на GitHub, прежде чем карточку можно закрыть. Коммит или diff сами по себе задачу не закрывают.
- Артефакты (`artifacts=[...]` в `kanban_complete`) доставляются в чат подписчика как нативные вложения.

### Bot Mode (именованные агенты)

- Документация `website/docs/user-guide/bot-mode.md`. «Bot» — это профиль Hermes (`~/.hermes/profiles/<name>/`) со своей ролью, моделью, памятью, skills, SOUL.md и аватаром. Новых примитивов нет, это UI над профилем; `hermes -p <bot> chat` открывает того же агента.
- У каждого бота постоянный «Bot Chat» (вместо `/new` делается `/compact`), рутины (cron), сообщения между ботами и групповые чаты. Код: `gateway/session_bot*.py`, `tools/bot_relay.py`, `tools/bot_mode_dm.py`, `tools/bot_desktop/`, `gateway/hosted_room*.py`.
- Bot Screen (`website/docs/user-guide/features/bot-screen.md`): на headless Linux у каждого бота свой Xfce-рабочий стол (TigerVNC + `computer_use` + браузер), человек может перехватить управление (логин, 2FA, капча) и вернуть. Около 1.1–1.5 ГБ на открытый экран с браузером. Для DSHBOT это второстепенно.

### Ретраи и отчёт владельцу

- Классификатор ошибок API: `agent/error_classifier.py` — таксономия `FailoverReason` (auth, billing, rate_limit, overloaded, server_error, timeout, context_overflow, content_policy_blocked, format_error, role_alternation и десятки других) и подсказки восстановления (повтор, ротация ключа, fallback-модель, сжатие, прерывание).
- Цепочка запасных моделей `fallback_providers`, пулы ключей `agent/credential_pool*.py`. После исчерпания всего и временной недоступности (5xx, 529, таймауты) идёт ожидание и до 5 циклов автоповтора (15/30/60/60/60 с джиттером, `cli-config.yaml.example`, `auto_recovery_cycles`).
- Пустой ответ: `agent/empty_response_guard.py` — после двух подряд детерминированно пустых ответов (ноль выходных токенов, одинаковые модель/провайдер/причина) сразу идём по fallback; если оценка входа одной попытки дороже $0.25, бюджет ретраев с 3 до 1. Защита от оплаты повторов, которые заведомо не помогут.
- Verify-on-stop (`agent/verification_stop.py`, `agent/turn_stop_gates.py`): после правок кода без свежей успешной проверки ходу добавляется user-пинок «Run the relevant verification command now ..., read any failure, repair the code» (до 2 раз, по умолчанию выключено, режим `auto` включает на CLI/TUI и выключает на мессенджерах). Есть и хук `pre_verify`.
- Отчёт: итоговый ответ уходит в чат; для cron — через `deliver`; для kanban — уведомление подписчику; для `/goal` — статусы `⊙ Goal set`, `↻ Continuing`, `✓ Goal achieved`, `⏸ Goal paused`.

### Подтверждение опасных действий

- `tools/approval.py` (+ `approval_*.py`): режим `approvals.mode` = `manual | smart | off` (по умолчанию `smart`, `config_defaults.py:1679-1693`). В режиме smart вспомогательная LLM (`auxiliary.approval`) автоматически одобряет низкорисковые команды. Жёсткие запреты (`approval_detection.detect_hardline_command`, пользовательские deny-правила) действуют даже при yolo. В cron/headless нужное подтверждение отклоняется, а не ждёт.

---

## 4. Learning loop и саморазвитие

Это главная ценность для DSHBOT. Механизм простой и состоит из четырёх частей.

### 4.1 Счётчики-нудж

- Память: каждые `memory.nudge_interval` = 10 пользовательских ходов (`agent/agent_init.py:1303,1332`; `agent/turn_context.py:_tick_memory_nudge`, строка 758).
- Skills: каждые `skills.creation_nudge_interval` tool-итераций (в `cli-config.yaml.example:1180` пример 15; в `agent_init.py:1387` дефолт 10). Счётчик `_iters_since_skill` растёт в `turn_iteration_prep.py:166` только если доступен инструмент `skill_manage`; сбрасывается, когда агент сам вызвал `skill_manage` (`tool_executor.py:749`).
- Проверка триггера в конце хода: `agent/turn_finalizer.py:765`. Условие запуска ревью (строки 773-784): есть финальный ответ, ход не прерван, `skip_background_review` не выставлен, сработал любой из двух триггеров. Ревью запускается ПОСЛЕ доставки ответа и не конкурирует с задачей пользователя.
- Счётчик ходов восстанавливается из истории при возобновлении сессии (`turn_context.py:752-755`).

### 4.2 Фоновый форк-ревьюер

- `agent/background_review.py` (1349 строк), входная точка `spawn_background_review_thread` (строка 1310). Запускается в демон-потоке.
- Форк `AIAgent` с «паритетом кэша» (`build_cache_parity_fork`, строка ~990): тот же рантайм, те же ключи, байт-в-байт тот же системный промпт и `tools[]`, тот же `session_id`, но без записи в БД и без собственных нудж-счётчиков (`_memory_nudge_interval = _skill_nudge_interval = 0`). Если ревью идёт на той же модели, разговор повторяется как тёплое чтение кэша (экономия около 26% по комментарию в коде).
- Если для ревью настроена другая модель (`auxiliary.background_review`), кэш всё равно холодный, поэтому вместо полной истории передаётся компактный дайджест (строка 173 и далее).
- Ограничения: 16 итераций (`_REVIEW_MAX_ITERATIONS`), суммарный входной бюджет 75% окна модели ревью, не больше 600K токенов (строки 173-212).
- Белый список инструментов проверяется на стороне диспетчеризации, а не в схеме, чтобы `tools[]` оставался идентичным (кэш): `memory` (только если сработал именно триггер памяти), `skill_manage`, `skills_list`, `skill_view`, плюс только чтение файлов `read_file`, `search_files` (строка 1085 и далее). Запись файлов и терминал запрещены.
- Стоимость: комментарий в `turn_finalizer.py` оценивает форк около 30K токенов на событие.
- Усвоенный опыт в `agent/background_review.py:1095-1110`: когда `read_file` был запрещён, ревью получало «шторм отказов» (около 142 отказов и 204 нарушений read-before-write за два дня на одном развёртывании) и почти ни один патч не проходил. Мораль: ревьюеру нужен чтение, иначе обучение молча не работает.

### 4.3 Промпты ревью (ключевые, коротко)

Тексты в `agent/background_review.py:365-560`. Три варианта: память, skills, комбинированный.

**Маршрутизация памяти** (`_MEMORY_ROUTING_BLOCK`):
> TWO distinct stores — pick the right one for each fact: USER.md = who the user is (persona, preferences, communication style); MEMORY.md = facts about the ENVIRONMENT (tool quirks, project conventions, config gotchas, paths). One fact goes to ONE store, never both.

**Ревью памяти:**
> Review the conversation above and consider saving to memory if appropriate. ... If nothing is worth saving, just say 'Nothing to save.' and stop.

**Ревью skills** (`_SKILL_REVIEW_PROMPT`, строка 448), суть:
- «Be ACTIVE — most sessions produce at least one skill update... A pass that does nothing is a missed learning opportunity.»
- Сигналы: пользователь поправил стиль, тон, формат, многословность («stop doing X», «this is too verbose» — это первоклассные сигналы для skills, не только для памяти); поправил порядок действий; найден нетривиальный приём или обходной путь; загруженный skill оказался неверным или устаревшим («Patch it NOW»).
- Порядок предпочтения (берётся самый ранний подходящий): 1) обновить уже загруженный skill, 2) обновить существующий «зонтичный» skill, 3) добавить файл поддержки (`references/<тема>.md`, `templates/`, `scripts/`), 4) создать новый skill уровня класса задач. Имя новой записи не должно быть номером PR, текстом ошибки, кодовым именем или «fix-X-today».
- Read-before-write (проверяется кодом: `skill_manage` отказывает без свежего `skill_view` в этом же ревью): «Content quoted earlier in the conversation transcript does NOT count».
- Предпочтения пользователя пишутся в тело SKILL.md, а не только в память: «Memory captures who the user is and the current state; skills capture how to do this class of task for this user».
- «Never delete a skill here»: удаление и слияние только у куратора.

**Что такое skill** (`_LESSON_LAYER_BLOCK`, строка 395) — правила записи уроков:
- Сначала процедура: шаги в порядке выполнения с конкретными командами и точками решения; уроки привязаны к шагу.
- Подвох = обобщаемое правило + одна фраза «почему» (механизм), в повелительном наклонении, не пересказ сессии.
- Без номеров PR/тикетов, дат, цитат пользователя; правило должно стоять без истории.
- Один и тот же урок, выученный дважды, это ОДНО правило: сначала поиск существующего, потом усиление, а не дубль.
- Не дублировать то, что уже в AGENTS.md и схемах инструментов.
- Постоянные правила живут в SKILL.md целиком, `references/` только для редко нужной глубины; не файл на сессию.
- Исправлять неверную фразу на месте, а не дописывать «UPDATE: actually...».

**Что НЕ сохранять** (`_DO_NOT_CAPTURE_BLOCK`, строка 429) — защита от самоотравления:
- сбои окружения (нет бинарника, «command not found», нет ключей) — пользователь исправит, это не правило;
- негативные утверждения об инструментах («browser tools do not work»): они «застывают в отказы, которые агент цитирует против себя месяцами»;
- временные ошибки, исчезнувшие после повтора (урок — паттерн повтора);
- одноразовые рассказы о задаче;
- нерешённые неудачи: нельзя записывать несколько неудачных попыток как «надёжный воркфлоу»; либо «Nothing to save», либо только независимо подтверждённая рабочая альтернатива.

### 4.4 /learn и /refine

- `/learn` (`agent/learn_prompt.py`): превращает указанное (каталог кода, URL документации, «то, что мы только что сделали») в skill обычным ходом агента через `skill_manage`. Стандарты авторства: `description` не длиннее 60 символов, одно предложение с точкой, без маркетинга; порядок разделов: `When to Use`, `Prerequisites`, `How to Run`, `Quick Reference`, `Procedure`, `Pitfalls`, `Verification`; не выдумывать флаги и пути; «Fold-in, don't duplicate». Для больших источников — «knowledge-base» раскладка (тонкий индекс SKILL.md плюс по файлу на главу в `references/`), обрабатывать по одной главе.
- `/refine` (`hermes_cli/commands.py:156`): запустить ревью прямо сейчас.
- `/review` (`agent/review_engine.py`): независимый субагент-ревьюер полного уровня на последних 10 сообщениях; результат возвращается в сессию как обычное завершение делегирования. Пример промпта: «Act as an independent senior reviewer... open the PR, read the diff, run the code or tests where feasible rather than judging from the excerpt alone».

### 4.5 Curator (уход за библиотекой skills)

- `agent/curator.py` (1212 строк), `curator_backup.py`, документация `website/docs/user-guide/features/curator.md`. Запуск по простою, не по cron: прошло `interval_hours` = 168 (7 дней) и агент простаивает `min_idle_hours` = 2. Первый запуск откладывается на целый интервал (время ознакомиться).
- Две фазы:
  1. Детерминированная (без LLM): навык не использовался 14 дней → `stale`; 30 дней → в `~/.hermes/skills/.archive/` (обратимо). Закреплённые (pinned) и используемые cron-задачами пропускаются. Новые неиспользованные получают льготный срок.
  2. LLM-консолидация (по умолчанию ВЫКЛ, `curator.consolidate: false`): форк просматривает навыки, патчит, сливает кластеры в «зонтичные» skills, архивирует (удаление запрещено).
- Телеметрия использования: `tools/skill_usage.py`, файл-сайдкар `~/.hermes/skills/.usage.json` (просмотры, использования, патчи, `created_by: agent`). В frontmatter телеметрия не пишется.
- Ключевые формулировки `CURATOR_REVIEW_PROMPT` (`curator.py:290`):
  > The goal of the skill collection is a LIBRARY OF CLASS-LEVEL INSTRUCTIONS AND EXPERIENTIAL KNOWLEDGE. A collection of hundreds of narrow skills where each one captures one session's specific bug is a FAILURE of the library.
  > ...ask 'would a human maintainer write this as N separate skills, or as one skill with N labeled subsections?' When the latter, merge.
  > 'use=0' is not evidence a skill is valuable ... ALSO not a reason to PRUNE.
  > Moving a file unchanged under references/ is filing, not consolidating.
  > A SKILL.md body over ~24k chars is a consolidation target on its own.
- Целостность пакета: нельзя «сплющить» SKILL.md в чужой `references/`, если у навыка есть свои `scripts/`/`references/`/`templates/`; слияние выполняется через `skill_manage write_file/remove_file/delete` (с журналом), не через shell `mv` (иначе откат восстановит пустой навык).
- Откат: `hermes curator rollback`, режим `--dry-run`.

### 4.6 Оценка качества и защита

- Встроенной метрики качества skills нет. Качество поддерживается косвенно: линтер (`tools/skill_linter.py`, `_attach_lint_findings` в `skill_manager_tool.py`), обязательное read-before-write, телеметрия использования, curator, судья `/goal` с контрактом.
- `tools/skills_guard.py` — регулярный статический скан внешних skills и политика установки по уровню доверия (builtin/trusted/community/agent-created). Для созданных агентом skills `dangerous` даёт «ask» только если включено `skills.guard_agent_created`.
- Сканирование записей памяти на инъекции/утечки: `tools/memory_tool_store.py:_scan_memory_content` через `tools/threat_patterns.py`.
- «Рефлексия» как отдельного шага нет: она реализована как ревью после хода (см. 4.2), плюс судья цели, плюс `/insights`, `agent/insights.py`, `agent/learning_graph.py` (визуализация того, что выучено, для десктопа).
- Важное наблюдение о подводных камнях (`agent/prompt_builder.py:241-256`): формулировка «после сложной задачи (5+ вызовов) сохрани подход как skill» блокировалась серверным фильтром Anthropic для OAuth-подписки и давала ложную ошибку биллинга; текст пришлось переформулировать «эмпирически». Если когда-то пойдёте на Anthropic OAuth, не копируйте старую фразу.

---

## 5. Память

### 5.1 Встроенная (файловая)

- Два файла в `~/.hermes/memories/` (путь через `get_hermes_home()`; реализация `tools/memory_tool.py`, `tools/memory_tool_store.py`):
  - `MEMORY.md` — заметки агента (окружение, конвенции, особенности инструментов), лимит 2200 символов (около 800 токенов);
  - `USER.md` — профиль пользователя (кто он, стиль общения, ожидания), лимит 1375 символов (около 500 токенов).
  - Лимиты: `memory.memory_char_limit` и `memory.user_char_limit` (`cli-config.yaml.example:1031-1033`), оценка 2.75 символа на токен.
- Формат: записи разделены `\n§\n` (`ENTRY_DELIMITER`, `memory_tool_store.py:25`).
- Инструмент `memory`: действия `add | replace | patch | remove`, цель `memory | user`. Схема описывает пакетную операцию `operations[]`: все изменения в одну цель одним вызовом, лимит проверяется по итоговому состоянию, поэтому одним вызовом можно удалить устаревшее и добавить новое (`memory_tool.py:373-400`). При переполнении add отклоняется с показом текущих записей.
- Снимок для системного промпта ЗАМОРАЖИВАЕТСЯ при загрузке сессии (`memory_tool_store.py:177-253`, `_system_prompt_snapshot`): записи во время сессии пишутся на диск, но в промпт попадают только в следующей сессии. Причина — сохранение prefix cache.
- Дрейф: если файл изменили снаружи, запись откладывается и создаётся `.bak.<ts>`, чтобы не затереть чужое (`memory_tool_store.py:54`).

### 5.2 Что и куда писать: ключевая инструкция

Текст в `agent/prompt_builder.py:191-232` (`build_memory_guidance`):
> Skills come first: when you learn something while doing a task — a procedure, a pitfall, and the user's preferences and corrections for that kind of work — record it in the skill ... Memory is the narrow exception for facts that apply to EVERY session regardless of task ... Write entries as declarative facts, not instructions to yourself: 'User prefers concise responses' ✓ — 'Always respond concisely' ✗ (imperative phrasing gets re-read as a directive in later sessions and can override the user's current request). A fact stale within a week belongs in session history.

Схема инструмента добавляет: «SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state».

### 5.3 Поиск по истории: session_search

- `tools/session_search_tool.py`, схема на строке 663. SQLite FTS5 (`hermes_state_fts.py`) с токенизатором для CJK (`native/fts5_cjk/`). БЕЗ вызова LLM («Results are actual DB messages, no LLM»; комментарий про #27590). README обещает «LLM summarization», но в коде это убрано.
- Четыре формы по аргументам: `query` (поиск, топ-N сессий дедуплицировано по цепочке сжатий, верхний результат раскрывается полностью), `session_id + around_message_id` (окно вокруг сообщения), `session_id` (чтение целиком), без аргументов (недавние).
- Нюанс ранжирования: сессии cron занижаются в выдаче, потому что их повторяющаяся лексика забивает BM25 («recall blindness», `session_search_tool.py:25-33`). Системные источники (`kanban`, `subagent`, `tool`) скрыты.
- Подсказка в промпте: «When the user references something from a past conversation... use session_search to recall it before asking them to repeat themselves» (`SESSION_SEARCH_GUIDANCE`, строка 237).

### 5.4 Внешние провайдеры памяти

- ABC `agent/memory_provider.py` (225 строк) и оркестратор `agent/memory_manager.py` (930 строк). Жизненный цикл: контекст провайдера в системный промпт, предзагрузка релевантного перед каждым ходом в фоне, синхронизация завершённого хода после ответа, выгрузка в конце сессии, зеркалирование записей встроенной памяти, свои инструменты провайдера.
- Предзагруженная память вставляется не в системный промпт, а в сообщение пользователя в обёртке `<memory-context>` с пометкой «NOT new user input» (`agent/memory_context.py`, `turn_context.py:116`); на выходе обёртка вычищается из стрима.
- В дереве остались только `retaindb` и `byterover` (удаление запланировано на 2026-10-15, по `plugins/AGENTS.md`). Honcho (Plastic Labs), Hindsight, Mem0, Supermemory, OpenViking, Holographic вынесены в каталог плагинов (`plugin-catalog/`). Honcho даёт «диалектические» выводы о пользователе (peer cards, representation) и изоляцию по пирам (`website/docs/user-guide/features/honcho.md`).
- Новых встроенных провайдеров не принимают («No new in-tree memory providers», `plugins/AGENTS.md`).
- Cron-сессии идут без памяти (`skip_memory=True`).
- Все данные провайдеру проходят через очистку секретов.

---

## 6. Персона и identity

- `SOUL.md` лежит в `HERMES_HOME` (`~/.hermes/SOUL.md`) и является слотом №1 системного промпта; создаётся автоматически и никогда не перезаписывается; из рабочего каталога не читается (`website/docs/user-guide/features/personality.md`). Загрузка: `agent/prompt_builder.py:load_soul_md` (проверка на инъекции «warn + load, never block», усечение с потолком под окно модели).
- Дефолтный `SOUL.md` из корня репо (весь текст):
  > You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask — a one-line question gets a one-line answer, and finished work gets a short report of what changed, what's verified, and what's left, never a replay of the process. No filler ("Great question," "I'd be happy to"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's right, not because the user said it. Depth is earned...
- Персона короткая (одна строка-абзац), характер задаётся стилем коммуникации, а не «ролевой игрой».
- Поверх SOUL.md: `/personality` — именованные пресеты `agent.personalities` в config.yaml (оверлеи уровня сессии); `platform_hints` на каждую платформу (append/replace; `PLATFORM_HINTS` в `prompt_builder.py:674`, подсказка для Telegram: короткие сообщения, форматирование); контекстные файлы проекта (`.hermes.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`, первый найденный побеждает, только из cwd).
- У ботов (профилей) своя SOUL.md; в субагентах SOUL.md не грузится, используется встроенная идентичность.
- Порядок слоёв системного промпта (`agent/system_prompt.py`, `prompt-assembly.md`): `stable` (identity, руководства по инструментам/модели) → `context` (project context, git snapshot, оператор, платформа) → `volatile` (индекс skills, снимок MEMORY, USER, блок провайдера памяти, время/сессия/модель, окружение). Особенность: постоянные части идут первыми, изменчивые в конце, чтобы длинный общий префикс переиспользовался кэшем между сессиями.

---

## 7. Модели, провайдеры, prompt caching, стоимость, скорость

### Провайдеры

- Профили в `plugins/model-providers/` (около 40): openrouter, anthropic, openai-codex, gemini, deepseek, kimi-coding, qwen-oauth, ollama-cloud, bedrock, zai, minimax, nous и др. База `providers/base.py`; описание `website/docs/developer-guide/model-provider-plugin.md`.
- Переключение командой `/model [provider:model]` и `hermes model`, без изменений кода.
- Вспомогательные («aux») задачи могут идти на отдельной дешёвой модели: compression, curator, background_review, goal_judge, approval, title_generation, vision, mcp и др. (`config_defaults.py:779-796`, `agent/auxiliary_client.py:_resolve_auto_route`). Это главный рычаг стоимости: тяжёлое «обучение» и судья не обязаны идти на основной модели.

### DeepSeek (прямо релевантно)

`plugins/model-providers/deepseek/__init__.py`:
- Базовый URL `https://api.deepseek.com/v1`, ключ `DEEPSEEK_API_KEY`, запасные модели `deepseek-v4-pro`, `deepseek-flash`, aux-модель по умолчанию `deepseek-flash`.
- Грабли V4: по умолчанию thinking включён, и тогда `reasoning_content` ОБЯЗАТЕЛЬНО возвращать в следующих ходах (иначе HTTP 400 после первого вызова инструмента). Профиль поэтому всегда ставит `thinking` явно (`always_emit_toggle=True`), а `effort` маппится на `reasoning_effort`. Эффорт `none/false/disabled` превращается в `{"thinking": {"type": "disabled"}}`.
- В `agent/chat_completion_helpers.py:1659-1690`: при повторе истории через DeepSeek V4/Kimi сообщение с tool call без `reasoning_content` отклоняется; код подставляет значение и использует один пробел вместо пустой строки, потому что «DeepSeek V4 Pro tightened validation and rejects empty string».
- Нативный API поддерживает только `response_format: json_object`; `json_schema` даёт гарантированный 400 (комментарий в профиле). Нужно для судьи/структурных ответов.
- Окно: 1,000,000 токенов у v4-семейства (`agent/model_metadata.py:312-317`); на NVIDIA NIM у `deepseek-v4-pro` 262,144.
- `deepseek` входит в `TOOL_USE_ENFORCEMENT_MODELS` (`prompt_builder.py:365`) и в `EXECUTION_GUIDANCE_MODELS` (строка 379): этим моделям добавляют блоки «tool-use enforcement» и «execution discipline». Причина из комментария: в трассах агентных оценок DeepSeek считал финансовую арифметику в прозе, пропускал проверку чтением после внешней записи, «чинил» идентификаторы и объявлял полноту при расхождении счётчиков.

### Prompt caching

- Принцип № 1 (`AGENTS.md`): системный промпт байт-стабилен на протяжении разговора; единственное допустимое изменение контекста это компрессия. Смена набора инструментов, перезагрузка памяти или пересборка промпта посреди сессии запрещены; команды, меняющие системный промпт, откладываются до следующей сессии (опция `--now`).
- Всё, что надо вставить посреди разговора, едет в сообщении пользователя или результате инструмента: skill по слэш-команде как user-сообщение (`agent/skill_commands.py`), подсказки подкаталога `AGENTS.md` в хвост результата инструмента (`agent/subdirectory_hints.py`), смена поверхности и дельта индекса skills как одноразовая заметка (`surface_switch.py`, `skills_index_delta.py`).
- Строгое чередование ролей: никаких двух подряд сообщений одной роли и синтетических user-сообщений посреди цикла (исключение `/steer`).
- Для Anthropic: 4 точки `cache_control` (статичный префикс системы, конец системного, последние 2 сообщения), единый TTL 5 мин или 1 ч (`agent/prompt_caching.py`). Одноразовые запросы без возможности чтения кэша маркерами не размечаются (`is_one_shot_request`): запись дороже чтения, а читать её некому.
- Для DeepSeek (серверный автоматический префикс-кэш) явных маркеров нет; работает правило байт-стабильности. Фоновый ревьюер намеренно использует тот же системный промпт и `tools[]`, чтобы попасть в тот же префикс.
- Статический индекс skills хранится в стабильном слое, снимок памяти в изменчивом, но оба замораживаются на сессию.

### Скорость и стоимость: что помогает и что мешает

Помогает:
- Параллельные tool calls плюс подсказка модели батчить (`PARALLEL_TOOL_CALL_GUIDANCE`).
- Отложенная загрузка схем инструментов: `tool_search`/`tool_describe`/`tool_call` (`tools/tool_search*.py`, `website/docs/user-guide/features/tool-search.md`). MCP и редкие плагинные инструменты прячутся за тремя мостовыми инструментами; схема подтягивается по требованию. Пояснение в `AGENTS.md`: «Every model tool is sent on every API call, so the bar for a new core tool is high».
- Wake gate в cron (скрипт решает, будить ли LLM).
- Обрезка старых результатов инструментов до вызова LLM-резюме; «lean» хвост; лимиты вывода инструментов (`tools/tool_output_limits.py`, `tool_result_storage.py`).
- Вся вспомогательная работа на дешёвой aux-модели.
- Скиллы грузятся по требованию (индекс с описаниями до 60 символов в промпте, тело через `skill_view`).
- Защита от платных повторов: `empty_response_guard`, классификатор ошибок не повторяет детерминированные отказы.

Мешает:
- Размер самого Hermes: сотни модулей, импорт `gateway` тяжёлый; сторожевой таймер старта (`hermes_startup_watchdog.py`) существует из-за случая зависания при импорте. Комментарий в `pyproject.toml` отмечает, что без C-парсера YAML старт занимал около 5 с на 1 vCPU.
- Форк ревьюера около 30K токенов на событие (можно отключить, `auxiliary.background_review.enabled: false`).
- Блок «execution discipline» и «tool-use enforcement» ложится в кэшируемый промпт: платится один раз, но увеличивает префикс.
- Микро-компакция ломает кэш каждый ход (поэтому выключена).
- Холодный старт: нет единого замера в репозитории; из косвенных признаков (запуск через `uv`/PM, Python 3.14, предзагрузка `jiter_preload.py`, ленивые зависимости `tools/lazy_deps.py`) можно считать, что холодный старт заметно медленнее обычного Node-скрипта. Оценка не подтверждена замерами.

---

## 8. Linux и деплой

- Установка: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`; зависимости (Python 3.14, Node.js, ripgrep, ffmpeg) разруливает свой менеджер `pm/` (`hermes pm lock`), файл `uv.lock`.
- Демон: `hermes gateway install` ставит пользовательский systemd-сервис (на macOS launchd); для VPS предлагается системный сервис, чтобы подниматься без linger (`website/docs/user-guide/messaging/index.md:593-650`). Юнит использует `Restart=always`, `KillMode=mixed`, `KillSignal=SIGTERM`; предупреждение: нельзя добавлять `ExecStopPost=/bin/kill -9` — это зацикливает перезапуски.
- `hermes gateway restart` сначала просит gateway дослужить текущие ходы (`SIGUSR1`, бюджет ожидания), потом перезапускает. Опционально сторож systemd (`systemd_watchdog_seconds: 120`), срабатывает только при зависании цикла событий.
- Состояние: `~/.hermes/` (`config.yaml` для настроек, `.env` только для секретов, `logs/`, `skills/`, `memories/`, `state.db`, `kanban.db`, `cron/`), всё через `get_hermes_home()`; профили в `~/.hermes/profiles/<name>/`.
- Docker: `Dockerfile` (Debian trixie, собственная сборка SQLite с FTS5 из-за бага WAL-reset в 3.46.1), `docker-compose.yml`, `docker/` (s6-rc, tini, entrypoint). Образ `nousresearch/hermes-agent`.
- Терминальные бэкенды инструментов: local, Docker, SSH, Modal, Daytona, Vercel Sandbox (+ плагины, например Singularity). Опасные команды в песочнице изолированы.
- Требования по ресурсам: сам gateway в покое около 300 МБ RAM (из `bot-screen.md`, измерено в официальном образе); с экраном и браузером 1.1–1.5 ГБ.
- Надёжность: `hermes_startup_watchdog.py` (респавн при зависании до запуска цикла), `gateway/restart_loop_guard.py`, `lifecycle_ledger.py`, `delivery_ledger.py`, `gateway/memory_monitor.py`, `scale_to_zero.py`.
- Безопасность: `SECURITY.md`, пулы кредов `agent/credential_pool*.py`, `agent/secret_scope.py` (изоляция секретов между профилями, fail-closed в multiplex), `agent/redact.py`, подтверждение опасных команд, DM-pairing, whitelists.
- Для Linux-сервера Hermes работает «из коробки» без десктопа; Electron-приложение и Bot Screen опциональны.

---

## 9. Расширяемость: плагины, инструменты, MCP, skills

### Инструменты

- Реестр `tools/registry.py`: каждый `tools/*.py` вызывает `registry.register(name, toolset, schema, handler, check_fn, requires_env)` при импорте; `model_tools.discover_builtin_tools()` обнаруживает автоматически. Хендлеры возвращают JSON-строку (`tools/AGENTS.md`).
- Группировка по toolset (`toolsets.py`): `terminal`, `file`, `web`, `browser`, `memory`, `skills`, `cronjob`, `delegation`, `kanban`, `messaging`, `code_execution`, `todo`, `session_search`, `vision`, `tts`, `moa` и др. На платформу включается своим набором (Telegram → toolset `messaging`).
- `execute_code` (`tools/code_execution_tool.py`): модель пишет Python-скрипт, вызывающий инструменты по RPC; схлопывает многошаговые пайплайны в один ход, итерации возвращаются в бюджет.
- «Лестница следа» (`AGENTS.md`): сначала расширить существующее, затем CLI-команда + skill, затем сервисный инструмент, затем плагин, затем MCP-сервер в каталоге, и лишь потом новый core-инструмент.
- Отклоняются: хуки без реального потребителя, новый core-инструмент, если справляются терминал и файл или skill, `offset/limit` на инструкционных инструментах (модель читает страницу 1 и пропускает остальное).

### Плагины

- Виды (`plugins/AGENTS.md`): платформы, провайдеры моделей, провайдеры памяти, движки контекста, генерация изображений/видео, провайдеры браузера/веб-поиска/делегирования, cron-провайдеры, дашборд-авторизация, бэкенды терминала, источники секретов.
- Плагин в `~/.hermes/plugins/<name>/` с `plugin.yaml` и `__init__.py`, использует `ctx.register_tool(...)`, хуки и т.д. Правило: «Plugins never touch core» — нужна возможность, расширяют общую поверхность, а не правят ядро.
- Хуки плагинов (`website/docs/user-guide/features/hooks.md`, около 2200 строк): `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `pre_verify`, `transform_tool_result`, `transform_llm_output`, `on_session_start/end/finalize/reset`, `post_compaction`, `agent_loop_stopped`, `subagent_start/stop`, `pre_gateway_dispatch`, `pre_approval_request` и другие. Есть и shell-хуки (JSON по stdin/stdout, код выхода 2 = блокировка, совместимо с Claude Code/Cursor).
- Каталог плагинов `plugin-catalog/*.yaml` с правилами допуска; есть `plugin-catalog/README.md`.

### MCP

- Клиент MCP: `tools/mcp_tool*.py` (транспорты, discovery, OAuth, схема-кэш, health, supervisor). Конфиг `mcp_servers:` в config.yaml (аналог `mcpServers` из `~/.claude.json`), фильтры `tools.include/exclude`. Доверие к серверу записывается на профиль. Hermes также умеет работать MCP-сервером (`mcp-serve`).
- Много MCP-инструментов раздувают контекст; для этого и сделан Tool Search.

### Skills: формат

- Каталог навыка с `SKILL.md` (YAML frontmatter + Markdown) и опциональными `references/`, `templates/`, `scripts/`, `assets/`. Frontmatter (`skills/AGENTS.md`): `name`, `description`, `version`, `author`, `license`, `platforms`, `metadata.hermes.tags/category/related_skills/config`.
- Совместим с экосистемой agentskills.io (README: «Skills Hub agentskills.io»; импорт из `~/.claude`, `~/.codex`, `~/.cursor`, `~/.openclaw` через `hermes import-agent`). Skill-хаб: `tools/skills_hub*.py` (источники github, clawhub, skills.sh, official).
- Правила авторства (проверяются тестом): описание до 60 символов (в индексе системного промпта обрезается до ~57 и «всё после обрезается и никогда не маршрутизируется»), ссылки на нативные инструменты в обратных кавычках, а не на shell-утилиты; блок `Pitfalls` и `Verification`; хелпер-скрипты в `scripts/`.
- Индекс в системном промпте (`prompt_builder.py:1364`): «Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST load it with skill_view(name)... Err on the side of loading». И: «After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps, had wrong commands... update it before finishing».
- Инструмент `skill_manage`: операции `create | patch | write_file | remove_file | delete`, пакетно и атомарно (при ошибке откатываются все затронутые skills). `patch` предпочтительнее полной перезаписи. Описание инструмента: «Write lessons, not logs».
- Встроенные skills в `skills/` по категориям (software-development, research, productivity, devops, ...), необязательные в `optional-skills/`.
- Слэш-команда `/<skill-name>` инжектит тело skill как user-сообщение (`agent/skill_commands.py`), а не в системный промпт.

---

## 10. Вывод для DSHBOT

Контекст: DSHBOT строится на TS-плагинном харнессе DeepSeek Harness под Linux. Цель — автономный бот как Hermes, но быстрее и дешевле OpenClaw. Hermes не нужно портировать целиком; переносим механизмы, которые дают поведение «подхватил, довёл, выучился», и не тащим периферию.

### 10.1 Что переносить (по приоритету)

**P0. Основа поведения (дёшево, даёт эффект сразу)**

1. Руководство «довести до конца» в системном промпте: `TASK_COMPLETION_GUIDANCE` (`agent/prompt_builder.py:386`) и сжатая версия `OPENAI_MODEL_EXECUTION_GUIDANCE` (строка 436) — блоки `tool_persistence`, `mandatory_tool_use`, `act_dont_ask`, `verification`, `external_state_verification`, `literal_preservation`, `missing_context`. Для DeepSeek они прямо включены в Hermes по результатам оценок. Плюс `PARALLEL_TOOL_CALL_GUIDANCE`. Добавить в стабильный слой.
2. Инвариант кэша: системный промпт замораживается на сессию, изменения (память, индекс skills, смена модели) уезжают в user-сообщение или результат инструмента, а не в system. В TS-харнессе это правило слоя `buildSystemPrompt`: слои `stable → context → volatile`, постоянное вперёд.
3. Файловая память `MEMORY.md` (2200) и `USER.md` (1375) с разделителем `§`, пакетным `operations[]` и замороженным снимком. Инструмент `memory` (схема из `memory_tool.py:373`) почти дословно. Обязательно перенести правило «декларативные факты, не императивы» и «задачные знания идут в skills, не в память».
4. `session_search` на SQLite FTS5 без LLM (`better-sqlite3`/`bun:sqlite` с FTS5), четыре формы, занижение cron-сессий в ранжировании. Хранить сообщения сессий в одной БД.
5. Судья цели `/goal`: отдельный дешёвый вызов (DeepSeek flash) с JSON-вердиктом `done|continue|blocked|wait`, контракт `outcome/verification/constraints/boundaries/stop_when`, quality gates (shell-команда, обязана пройти), лимиты ходов 20, fail-open судья, лимиты подряд ошибок парсинга/транспорта. Промпты из `hermes_cli/goals.py:60-262` переносятся почти дословно. Это и есть «доведение до результата».
6. Автономность через cron: `[SILENT]`, wake-gate (`{"wakeAgent": false}`), `context_from`, `_CRON_HINT` без рекурсии, `[CRON_FAILURE]`, сторож по простою, at-most-once (двигать `next_run_at` ДО запуска), группировка ошибок в инциденты с дедупликацией пингов, автоповтор только для «не дошли до модели».

**P1. Самообучение (то, что отличает Hermes)**

7. Счётчики-нудж: память раз в 10 пользовательских ходов, skills раз в 10–15 tool-итераций. Хранить счётчики в БД сессии, восстанавливать при возобновлении. Реализовать как плагин на хук завершения хода.
8. Фоновый ревьюер (после доставки ответа): отдельный вызов с копией истории и белым списком `memory`, `skill_manage`, `skill_view`, `skills_list`, `read_file`, `search_files`; лимит 16 итераций; без записи в БД; результат не попадает в разговор. Перенести три промпта (`_MEMORY_REVIEW_PROMPT`, `_SKILL_REVIEW_PROMPT`, `_COMBINED_REVIEW_PROMPT`) с блоками `_LESSON_LAYER_BLOCK` и `_DO_NOT_CAPTURE_BLOCK`. Особенно ценны правила «не записывать негативные утверждения об инструментах» и «не записывать нерешённые неудачи как воркфлоу»; без них библиотека отравляется.
9. `skill_manage` с обязательным read-before-write (код отказывает без свежего `skill_view` в этой сессии ревью), патчем вместо перезаписи, атомарным пакетом и линтером описания (до 60 символов).
10. Куратор: детерминированная часть (14 дней → stale, 30 → архив, учёт `.usage.json`) включить сразу, LLM-консолидацию оставить опцией, как в Hermes (по умолчанию выкл). Раз в 7 дней при простое 2 часа, первый запуск откладывается. Не удалять, только архивировать.
11. Компакция: порог 50% (у DeepSeek окно 1M, можно ставить по абсолютному числу токенов, например 150–250K, чтобы не платить за огромный префикс), сначала обрезка старых результатов инструментов без LLM, затем структурное резюме по шаблону с разделами `Goal / Constraints / Completed Actions / Active State / Blocked / Key Decisions / Errors & Fixes / Resolved Questions / Relevant Files / Critical Context` и префиксом «REFERENCE ONLY: respond ONLY to the latest user message». Перенести охлаждение сбоя 60/300/900 с, детерминированный запасной вариант.

**P2. Операционка и безопасность**

12. Классификатор ошибок API с таксономией и подсказками восстановления; guard пустых ответов и стоимости повторов; стражи зацикливания (`tool_guardrails`, `repetition_guard`); сторож хода по простою (600 с).
13. Verify-on-stop и «терминальный инструмент» для фоновых задач: если задача из очереди завершилась без `task_complete/task_block`, один-два раза пнуть. Это даёт проверяемое «сделано».
14. Подтверждения опасных действий режимом `smart` (дешёвая aux-модель решает, жёсткие запреты неснимаемы, в cron/headless отказ вместо ожидания).
15. Канбан-очередь задач (SQLite) для владельца: карточки, статусы, воркеры-процессы, терминальные инструменты, комментарии, артефакты в чат. Начать с минимума: `create/show/complete/block/comment`.
16. Gateway Telegram: ограничение по whitelisted-пользователям, режим занятости `interrupt|queue|steer`, `/stop`, `/status`, стриминг правкой сообщения, автодоставка файлов по абсолютным путям из ответа, `[SILENT]` для проактивных сообщений, `/heartbeat`, `/loop`.
17. Агентные работники: `delegate_task` с чистым контекстом, `output_schema`, фоновые результаты; отдельная дешёвая модель для детей.
18. DeepSeek-специфика: всегда явный `thinking` и возврат `reasoning_content` в историю (иначе 400 после первого вызова инструмента), подстановка одного пробела вместо пустой строки, только `response_format: json_object`, aux-модель `deepseek-flash`.

### 10.2 Как это ложится на плагины TS-харнесса (схема)

| Плагин | Механизм | Основание в Hermes |
|---|---|---|
| `prompt-core` | слои stable/context/volatile, руководства completion/parallel/enforcement, SOUL.md | `system_prompt.py`, `prompt_builder.py` |
| `memory-files` | `memory` инструмент, снимок на сессию, лимиты, скан инъекций | `tools/memory_tool*.py` |
| `session-search` | FTS5 по истории | `tools/session_search_tool.py`, `hermes_state_fts.py` |
| `skills` | индекс в промпте, `skill_view`, `skill_manage`, линтер, usage-телеметрия | `tools/skill*.py`, `skills/AGENTS.md` |
| `learn-review` | нудж-счётчики, фоновый форк, промпты ревью | `agent/background_review.py`, `turn_finalizer.py` |
| `curator` | архивация/стейл, опциональная консолидация | `agent/curator.py` |
| `goals` | судья, контракт, gates, WAIT | `hermes_cli/goals.py` |
| `scheduler` | cron, wake-gate, инциденты, SILENT | `cron/*` |
| `compaction` | трёхшаговое сжатие, шаблон резюме | `agent/context_compressor*.py` |
| `guards` | stall-guard, repetition, empty-response, liveness, approvals | `agent/tool_guardrails.py` и др. |
| `gateway-telegram` | long-poll/webhook, busy-mode, доставка файлов | `gateway/*`, `plugins/platforms/telegram` |
| `tasks-board` | очередь задач и воркеры | `hermes_cli/kanban.py`, `tools/kanban_tools.py` |

### 10.3 Что НЕ тащить

- Десктоп (Electron), TUI на Ink, веб-дашборд, Bot Screen (Xfce+VNC), голосовые режимы, wake-word, TTS, «питомцы», skins, i18n-пакеты. Не нужны владельцу-боту на сервере.
- 20+ платформ: достаточно Telegram (плюс, возможно, webhook/API). Остальные добавлять по требованию.
- Мульти-профильный multiplex и вся изоляция секретов между профилями (`secret_scope`, `profile_routing`, `hosted_room*`): огромная сложность ради сценария «много пользователей на одном процессе». Для одного владельца хватит одного профиля, при необходимости несколько процессов.
- Внешние провайдеры памяти (Honcho, Mem0 и пр.) на старте: файловая память плюс FTS5 покрывают задачу и дешевле. Honcho-подобный «пользовательский профиль» можно получить из ревью + USER.md.
- Микро-компакция (выключена даже у авторов), `moa` (mixture of agents), RL/trajectory-инфраструктура, `batch_runner`, ACP-адаптер.
- Облачные тул-шлюзы Nous Portal, биллинг и учёт подписок, множество адаптеров браузера (Camofox, Lightpanda, browser-use cloud). Если браузер нужен, взять один путь (Playwright CLI/CDP).
- Совместимость с тремя транспортами API (Codex Responses, Anthropic Messages, Bedrock): DeepSeek использует chat completions.
- Менеджер зависимостей `pm/`, самообновление, MSIX/Termux-упаковка.
- Платёж за «паритет кэша» с Anthropic (4 точки `cache_control`): у DeepSeek префикс-кэш автоматический, достаточно байт-стабильности.

### 10.4 Как сделать быстрее и дешевле OpenClaw (выводы)

1. Узкое ядро: держать в `tools[]` только рабочее ядро (терминал, файлы, поиск, память, skills, cron, delegate, задачи); остальное через ленивую выдачу схем (аналог Tool Search).
2. Не будить модель зря: wake-gate в cron, `[SILENT]`, тихий heartbeat, судья на дешёвой модели.
3. Всё вспомогательное (ревью, куратор, резюме, судья, approvals) на `deepseek-flash`.
4. Байт-стабильный префикс; изменчивое (время, память) в конце; кэшируемые руководства один раз.
5. Батчинг независимых вызовов и параллельное исполнение чтений.
6. Fail-open везде, где сломанный помощник не должен останавливать основную работу (судья, ревью, куратор, aux-вызовы).
7. Бюджеты: итерации, входные токены ревью, лимит тиков петли, лимит ретраев на пустые ответы.

### 10.5 Риски и подводные камни из Hermes (чтобы не наступить)

- Обучение молча не работает, если ревьюеру запретить чтение (см. 4.2).
- Библиотека skills разрастается узкими записями «один баг на сессию»; без куратора и правил именования («имя уровня класса задач, не номер PR») это быстро портит индекс.
- Записанные негативные факты об инструментах превращаются в самоналоженные отказы; не записывать их.
- Императивные записи в память читаются в следующих сессиях как директивы и перебивают текущий запрос пользователя; писать только декларативно.
- Компакция воскрешает старые задачи; нужен явный префикс «latest user message WINS» и разделы `Historical ...`.
- Вставки посреди цикла (steer, заметки) без маркера воспринимаются моделью как prompt injection; нужен самодекларирующий маркер и пояснение в промпте.
- Суммарная стоимость ревью растёт, если оно идёт на каждом ходе; в cron и headless его отключают.
- Часть документации расходится с кодом (README: «FTS5 session search with LLM summarization», в коде LLM убран; «около 40 инструментов» против фактического набора). Принимать за истину код, а не README.

### 10.6 Что не проверено

- Реальные замеры холодного старта, потребления RAM и стоимости ревью в токенах (только комментарии в коде, например «~30K tokens / event»).
- Работа Telegram-адаптера в деталях (`plugins/platforms/telegram`) читался только на уровне документации и общих контрактов gateway.
- Содержимое `hermes_cli/gateway_automation.py` (триггеры автоматизаций gateway) и Honcho-плагина (вынесен из репо).
- Версия релиза v0.22.5 взята из условий задачи, внутри клона явного тега не найдено.
