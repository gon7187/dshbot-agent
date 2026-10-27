# Базовые агентские функции: что есть у референсов и чего нет у DSHBOT (2026-10-23)

Сводка по OpenClaw, Hermes Agent и Ouroboros против того, что даёт DeepSeek Harness. Источник — `refs/` (только чтение) и разборы в `docs/research/`. Код референсов построчно не читали.

На момент сводки бот умеет только разговаривать: инструментов нет, `memory`, `scheduler` и `tasks` в демон не подключены.

## Матрица

Все пакеты харнесса ниже опубликованы как 0.2.1-rc.3 и **не входят** в проверенный набор из `harness-deps-review.md`: каждый требует своей проверки риска.

| Функция | Референсы | Харнесс |
|---|---|---|
| Web-поиск | OpenClaw `extensions/{brave,exa,tavily,searxng,…}`; Hermes `tools/web_tools.py`; Ouroboros `tools/search.py` | `dsh-tool-web` (`web_search`) + провайдер `dsh-web-search-exa` / `-deepseek` / `-perplexity` |
| Чтение страницы | OpenClaw `web-readability`; Hermes `web_extract` + `url_safety.py` (SSRF, DNS pinning); Ouroboros `browse_page` | `dsh-web-fetch-http` (только публичные IP, pinning соединения, редиректы same-origin, лимиты размера) + `dsh-tool-web` (`web_fetch`, HTML → markdown) |
| Браузер | у всех трёх | `dsh-browser-use`, playwright-mcp — alpha, отложить |
| Шелл и подтверждения | OpenClaw `exec-approvals` (allowlist по пути и хэшу, «да» текстом не считается); Hermes `approval.py` (hardline deny, cron отказывает, а не ждёт); Ouroboros `shell_guards.py` | `dsh-tool-bash` + `dsh-bash-sandbox` (bwrap/Landlock, только файлы, сеть не режет); подпроцессы чистят окружение от учётных данных; эскалация через `ctx.approval` |
| Файлы | у всех трёх (patch, fuzzy match, write guards) | `dsh-tool-fs` (`read`, `write`, `edit`, `read_image`), `dsh-tool-fs-search` (`glob`, `grep`, ripgrep) |
| Фоновые задачи | OpenClaw `bash-process-*`; Hermes `process_registry`; Ouroboros `start_task`/`wait_task` | `dsh-jobs-local` + `dsh-tool-jobs`; `dsh-tool-bash` регистрирует команды как job |
| Субагенты | у всех трёх | `dsh-subagent` + `-spawn-in-process` + `dsh-tool-subagent` |
| Cron, напоминания | у всех трёх | `dsh-schedule` требует Web Host — **не годится**; у DSHBOT свой `scheduler` |
| Память, поиск по сессиям | у всех трёх | готового нет (экспериментальные выключены); у DSHBOT свой `memory` |
| Навыки | у всех трёх | `dsh-skill` грузит навыки (в том числе `~/.agents/skills`); создание и курирование — нет |
| Самоправка кода | только Ouroboros (`prepare_self_change`, `promote_to_stable`, откат) | нет; `plugin_manager` харнесса исполняет код вне песочницы — не включать |
| Файлы, фото, голос в Telegram | у всех трёх | в харнессе Telegram нет; `dsh-attachment` хранит вложения. **В `packages/telegram` нет `getFile`, `sendDocument`, `sendPhoto`, `sendVoice`, `update.ts` читает только текст и подпись** |
| Зрение | у всех трёх | `read_image` и вложения; `deepseek-flash` принимает картинки, `deepseek-v4-pro` — нет |
| Речь в текст | у всех трёх | `dsh-experimental-speech-to-text` (alpha, локально) |
| Синтез речи, генерация картинок | у всех трёх | нет |
| MCP-клиент | у всех трёх | `dsh-mcp-client`, `dsh-mcp-resources` |
| Подтверждения | у всех трёх | `dsh-user-approval` (`ctx.approval`, fail-closed); у DSHBOT уже есть кнопки и `guard.checkCommand` |
| Бюджет | у всех трёх | `dsh-token-meter` считает токены, не деньги; у DSHBOT `guard.costOf` |

## Принцип подключения

Модельные пакеты харнесса не монтировать как есть: каждый добавляет схему и раздел промпта, а префикс должен быть маленьким и байт-стабильным. Брать сервисы (`ctx.web`, `ctx.shell`, `ctx.sandbox`, `ctx.jobs`, `ctx.approval`) и строить поверх свои компактные инструменты. Ядро — не больше 8 инструментов (DESIGN).

## Порядок задач

1. Проверка риска пакетов инструментов.
2. Шов инструментов в `runner` + хук `tools/pre-execute` в `guard` + тест стабильности схем.
3. `exec`: шелл через `ctx.shell` в песочнице, окружение без секретов, `checkCommand` → кнопки подтверждения, фон через `ctx.jobs`.
4. `read`/`edit`: корни рабочих каталогов, защищённые пути, read-before-write.
5. Настоящий `/stop` и таймаут хода (`agent.cancel`, убийство job).
6. `web`: поиск и fetch с SSRF-защитой, страницы в рамке «недоверенные данные».
7. Подключение `memory` (инструменты `memory`/`recall`, снимок в хвосте промпта).
8. Подключение `scheduler` (напоминания, wake gate, `[SILENT]`; плановые ходы не ждут подтверждений, а отказывают).
9. Подключение `tasks` (сессия задачи, приёмка, судья).
10. Файлы в Telegram в обе стороны, фото в зрение.
11. Голос в текст.
12. Субагенты.
13. `learn`: ревью опыта, навыки, куратор.
14. `evolve`: кандидат, гейт, адопция, откат.

Позже: MCP, браузер, синтез речи, генерация картинок, GitHub.

## Не проверено

Дифф rc.3 против исходников rc.2; размер схем инструментов в токенах; работает ли `dsh-bash-sandbox` на этой машине (bwrap/Landlock); вычищает ли подпроцессный слой именно `DEEPSEEK_API_KEY` и `TELEGRAM_BOT_TOKEN`.
