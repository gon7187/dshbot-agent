# Проверка риска пакетов инструментов DeepSeek Harness (2026-10-23)

Продолжение `harness-deps-review.md`. Статическая проверка rc.3: `npm view`, `npm pack`, lock без установки, одна пробная команда bwrap. Ничего не устанавливалось.

## Набор (все 0.2.1-rc.3, поверх уже проверенного)

- Шелл: `dsh-tool-bash`, `dsh-bash-local`, `dsh-bash-sandbox`, `dsh-shell`, `dsh-shell-env`, `dsh-subprocess`, `dsh-subprocess-local`, `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-fs-sandbox`.
- Фоновые задачи: `dsh-jobs`, `dsh-jobs-local`, `dsh-tool-jobs`.
- Файлы: `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-fs-local`.
- Web: `dsh-web`, `dsh-web-fetch-http`, `dsh-tool-web`, `dsh-web-search-deepseek` (`dsh-web-search-exa` — только если понадобится отдельный поиск).
- Вложения: `dsh-attachment`, `dsh-attachment-local`.
- Субагенты: `dsh-subagent`, `dsh-subagent-spawn-in-process`, `dsh-tool-subagent`.

Провайдеры сервисов (`ctx.shell`, `ctx.web` и др.) — peer-зависимости, их перечислять в package.json явно.

## Дерево

+108 пакетов, всё с registry.npmjs.org, `npm audit` — 0. Заметные сторонние: `undici`, `ipaddr.js`, `turndown`, `diff`, `@vscode/ripgrep` (бинарь `rg` приходит готовым в optional-пакете платформы, ничего не скачивает), `sharp`, `node-pty`, `koffi` (только Windows), `chokidar`.

Install-скрипты у трёх: `dsh-subprocess-local` (chmod помощника node-pty), `node-pty` (сборка только если нет готового бинаря), `koffi`. На Linux x64 с `ignore-scripts=true` ничего не ломается, обходы не нужны.

## Сеть и телеметрия

otel, аналитики и подобного нет. Сеть только в web-пакетах:

- `web-search-deepseek` → `https://api.deepseek.com/anthropic/v1/messages`, ключ `DEEPSEEK_API_KEY`, один ход модели на поиск. Хост переопределяется `DEEPSEEK_SEARCH_BASE_URL` — эта переменная не должна быть доступна модели и внешнему вводу.
- `web-search-exa` → `https://api.exa.ai/search`, ключ `EXA_API_KEY`, запросы уходят третьей стороне.
- `web-fetch-http` → любой URL от модели.

## Безопасность

- **Окружение шелла** чистится по denylist `/KEY|PASSWORD|SECRET|TOKEN/i` плюс все `DSH_*` (`dsh-subprocess/lib/index.js:32,50-52`). `DEEPSEEK_API_KEY` и `TELEGRAM_BOT_TOKEN` убираются; секреты с другими именами (`DATABASE_URL`, `*_DSN`) — нет. Явный `env` вызывающего вливается после очистки и может вернуть удалённое.
- **Песочница bwrap** (`dsh-sandbox-local/lib/index.js:22-37`): `--ro-bind / /`, `--unshare-pid`, запись только в рабочий корень и tmpfs `/tmp`. **Чтение всей машины и сеть открыты.** Файлы с секретами (`~/.config/dshbot/dshbot.env`, `~/.ssh`, `~/.gnupg`, профили браузеров) из песочницы читаются — их нужно маскировать отдельно. Если ни bwrap, ни Landlock не работают, команда отклоняется, а не выполняется без песочницы.
- **SSRF в `web-fetch-http`**: только глобальные unicast-адреса, DNS закреплён на проверенном ответе, редиректы same-origin до 5, лимиты 5 МБ / 100 000 символов / 30 с, только http(s). При активном прокси проверка имени пропускается — прокси не задавать.
- **`dsh-user-approval`** — fail-closed: без отвечающего результат `unavailable`.
- Команды на Linux запускаются как scope `systemd-run --user`.

## Хост

bwrap 0.13.1, ядро 7.2.8, Landlock включён, user namespaces доступны; пробный запуск профиля прошёл.

## Происхождение

Мейнтейнеры `imccyu`, `tianyicui-deepseek`; подписи реестра есть, provenance-аттестаций нет. `node-pty` и `@vscode/ripgrep` — аккаунты Microsoft.

## Решения

- Шелл — можно с ограничениями: песочница `workspace-write` или `read-only`; явный `env` без секретов; маскировать каталоги с секретами в профиле песочницы; сеть считать открытой, опасное — через `guard.checkCommand` и кнопки.
- Файлы — можно; ограничение чтения проверить при сборке инструмента.
- Фоновые задачи — можно.
- Web — можно с ограничениями: fetch через `web-fetch-http`, поиск через `web-search-deepseek`, прокси не задавать, `DEEPSEEK_SEARCH_BASE_URL` фиксирован, страницы — в рамке недоверенных данных.
- Вложения — можно с ограничениями (`sharp` — нативная библиотека, бинарь не смотрели).
- Субагенты — можно с ограничениями: код не читали; проверить, откуда `dsh-skill` грузит навыки.

Пределы: проверка по grep; подробно читались `dsh-subprocess`, `sandbox-local`, `web-fetch-http`, `user-approval` и оба поисковых провайдера; `tool-fs`, `subagent`, `attachment` — поверхностно; нативные бинари и трафик не смотрели.

## MCP: граф памяти и клиент (2026-10-23)

Выбор владельца — граф памяти на `@modelcontextprotocol/server-memory` как есть (`docs/research/memory-options.md`). Статическая проверка `npm pack`, ничего не устанавливалось.

- Пакеты: `@modelcontextprotocol/server-memory` 2.0.0 (integrity `sha512-h+oxQCpK…Rurw==`), `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/client` 2.3.1, `@modelcontextprotocol/core` 2.3.1, `zod` ^4.2. Мейнтейнеры — команда MCP (в том числе аккаунты Anthropic). `engines` у server-memory — Node ≥ 24, на хосте 26.8.1.
- Install-скриптов нет. `prepare` у server-memory срабатывает только при установке из git, не из реестра.
- server-memory (951 строка `dist/index.js`): только `fs` — один JSONL-файл графа, атомарная запись через временный файл и rename, файловый замок. Сети, `child_process` и чтения переменных, кроме `MEMORY_FILE_PATH`, нет. Без `MEMORY_FILE_PATH` пишет в каталог пакета (и мигрирует там `memory.json`), поэтому путь задаётся всегда, абсолютный.
- `fetch` в server и client — только HTTP-транспорты и OAuth (`jose`, `eventsource`, `pkce-challenge`); при stdio не используются. URL в коде — `$id` JSON-схем и примеры из документации.
- stdio-транспорт клиента запускает сервер через `cross-spawn` с окружением из allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) плюс явно переданное — ключи бота не утекают, если их не передать явно.

Решение: можно с ограничениями — только stdio; точные версии; `MEMORY_FILE_PATH` абсолютный внутри `DSHBOT_HOME/memory/`; в `env` сервера ничего, кроме `MEMORY_FILE_PATH`. Пределы: транзитивные зависимости клиента (`jose`, `eventsource`, `pkce-challenge`, `cross-spawn`) построчно не читались.

## Пакеты команд сессии: компакция и токен-метр (2026-10-24)

Набор `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-compaction-tool-result-pruner` и `@deepseek-ai/dsh-token-meter` линии 0.2.1-rc.3, поверх уже проверенного набора. Проверка по манифестам и lock, затем установка с `--ignore-scripts`.

- Install-скриптов у трёх пакетов и их транзитивных зависимостей (`dsh-compaction`, `dsh-commands`, `dsh-llm-retry`, `dsh-util-values`, `dsh-compaction-image-offload`, `schemastery`, `zod`) нет; `ignore-scripts=true` не меняется.
- Сети нет: компакция зовёт уже смонтированный `ctx.llm` через `ctx.llm.stream()`, то есть тот же провайдер и тот же `DEEPSEEK_BASE_URL`, что и обычный ход; своих URL, HTTP-клиентов и чтения переменных окружения у пакетов нет.
- Телеметрии нет: пакеты не шлют отчётов и не читают `DSH_TELEMETRY_*`; `dsh-base`, `session-log-deepseek` и `otel` не подключаются, в графе зависимостей их нет. `dsh-token-meter` считает токены локально, `dsh-compaction-tool-result-pruner` режет старые результаты инструментов без вызова модели.
- Риск: суммаризация — это один дополнительный платный запрос к модели при `/compact`, поэтому команда доступна только владельцу и не запускается из хода гостя. Замена истории пишется в журнал сессии штатными событиями `compaction/*`, сессия `main` сохраняет свой id.
- Точные версии и registry: все три пакета и их `@deepseek-ai`-зависимости стоят в `dependencies` с версией `0.2.1-rc.3` и разрешаются только с `registry.npmjs.org`; гейт `tests/gates/runner-deps.test.ts` и `tests/gates/session-commands-deps.test.ts` это проверяют.

Пределы: код компакции читался по типам и README, не построчно; провайдерский вызов суммаризации проверен заглушкой в `packages/app/session-commands.test.ts`.

## Голосовые сообщения: локальное распознавание речи (2026-10-24)

Задача — понимать голосовые сообщения владельца без отправки аудио наружу. Сначала проверялся пакет харнесса `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` (0.1.7-alpha.1, `ctx.speechToText`): SenseVoiceSmall в ONNX на sherpa-onnx. В открытом варианте модели список языков — `auto`, `zh`, `en`, `yue`, `ja`, `ko`; русского среди них нет. Источник списка: https://github.com/FunAudioLLM/SenseVoice (карточка модели и README FunAudioLLM/SenseVoiceSmall). Для русской речи нужен другой набор весов, поэтому SenseVoice отклонён ещё до замеров, а не по качеству на русском.

### Выбранная модель и почему

Выбран Whisper small в ONNX: у него русский есть в списке языков и он работает на CPU через тот же sherpa-onnx. Закреплён экспорт `csukuangfj/sherpa-onnx-whisper-small`, ревизия `8f3c18b358db4d1f2fc1eae49d75cd20989e4309`; файлы `small-encoder.int8.onnx` (112442483 байт, SHA-256 `4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9`), `small-decoder.int8.onnx` (262226114 байт, SHA-256 `acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee`) и `small-tokens.txt` (816730 байт, SHA-256 `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126`) лежат в `DSHBOT_HOME/models`. Размер и хэш каждого файла — константы в коде (`packages/voice/src/model.ts`), а не дайджест сервера и не локальный манифест; несовпавший файл удаляется, распознавание отказывает. Скачивание идёт только по URL с этой ревизией (huggingface.co, при сбое hf-mirror.com), повторно модель не скачивается.

### Замер на реальной русской фразе

Песочница завода не пускает на huggingface.co, поэтому замер шёл не на закреплённом экспорте sherpa и не на его int8-файлах: те же веса `openai/whisper-small` взяты в ONNX-экспорте transformers.js (`sts-whisper-small` 1.0.0, q8) и прогнаны через `onnxruntime-node` 1.30.0 на CPU. Это явная замена: числа ниже характеризуют веса Whisper small, а не побитово тот экспорт, который скачивает демон. Русская фраза синтезирована локально eSpeak NG (`text2wav` 0.0.14), потому что микрофона и сети к корпусу записей в песочнице нет; это не студийная запись, а реальный русский звук.

Два коротких прогона на синтезированной речи:

- Сказано: «Сегодня хорошая погода.» — распознано: «Сегодня хорошая погода.» Совпали все 3 слова.
- Сказано: «Включи свет на кухне.» — распознано: «Включить свет на кухне.» Совпали 3 слова из 4: глагол «включи» распознан как «включить».
- Итог по двум записям: 6 слов из 7, точность по словам 86 %, WER 14 %. На одной слитной записи той же фразы («Сегодня хорошая погода. Включи свет на кухне.») модель дала «Сегодня хорошая погода. Включить смертный кухн.» — 4 слова из 7, и это показывает предел синтезированной речи espeak, а не закреплённого экспорта. Поэтому реальная запись владельца проверяется отдельным тестом `test_voice_real_model_recognizes_a_russian_recording`, который пропускается без модели на диске и без `DSHBOT_VOICE_RU_SAMPLE`/`DSHBOT_VOICE_RU_PHRASE`.

### Пакеты и их риск

Новые зависимости — точные версии из registry.npmjs.org, только `dependencies` (демон работает с `NODE_ENV=production`):

- `sherpa-onnx-node@2.0.0` — обёртка sherpa-onnx. Install-скриптов нет; нативный бинарь приходит готовым в optional-пакете платформы (`sherpa-onnx-linux-x64@2.0.0` и ещё пять платформ в lock, ставится только подходящая). Внутри платформенного пакета — `onnxruntime` 1.28.2, отдельного `onnxruntime-node` нет: у него есть postinstall, и тянуть его ради того же рантайма не нужно. Своего сетевого кода у пакета нет, телеметрии нет; модель качает наш код.
- `ogg-opus-decoder@1.7.5` — WASM-декодер Ogg Opus (libopus + `opus-decoder`, `@wasm-audio-decoders/*`, `codec-parser`). Install-скриптов, сети и телеметрии нет, работает в памяти.
- `@audio/decode-mp4@1.3.1` — чистый JS-демуксер MP4/M4A/MOV, аудиокодеки (`@audio/decode-aac`, `-mp3`, `-flac`, `-opus`, `-ac3`, `-eac3`, `-dts`, `-amr`) подгружаются по требованию; нужен для аудио-кружков (`video_note`) и m4a. Install-скриптов, сети и телеметрии нет.
- `@audio/decode-mp3@1.3.1` — WASM-декодер MP3 (`mpg123-decoder`) для аудиофайлов в mp3. Install-скриптов, сети и телеметрии нет.

Закрытие speech-стека — 25 пакетов в lock; ни у одного нет install-скрипта, поэтому `.npmrc` с `ignore-scripts=true` не меняется. Все записи разрешаются с `registry.npmjs.org` и несут integrity (это проверяет `tests/gates/speech-deps.test.ts`). Нативные бинари sherpa-onnx не разбирались побайтово: доверие к ним такое же, как к любому prebuilt-пакету, и они исполняются в процессе демона (не в песочнице bwrap) — это осознанная цена локального распознавания на CPU.

Уточнение lock-файла (круг 3, 2026-10-24): манифест `sherpa-onnx-node@2.0.0` объявляет `sherpa-onnx-win-arm64@2.0.0`, но registry.npmjs.org публикует для этого optional-пакета только `0.0.0-stage` и `1.13.8`. Запрос метаданных версии `2.0.0` и её tarball возвращают 404; проверка выполнена через registry, а не по локальному кэшу. Перегенерация lock оставляет ссылку без записи пакета, из-за чего чистая установка отвергает lock. Поэтому только из `optionalDependencies` записи `sherpa-onnx-node` в lock удалена недоступная платформа Windows ARM64; версии runtime-зависимостей и остальные шесть платформ сохранены. Integrity для несуществующего tarball не выдумывается, Windows ARM64 этим lock не поддерживается. Чистый `npm ci --ignore-scripts` после исправления установил 207 пакетов с кодом 0; число пакетов speech-стека независимо пересчитано по замыканию lock.

Сеть: единственный новый исходящий запрос — скачивание трёх файлов модели с huggingface.co (запасной hf-mirror.com) по закреплённой ревизии. Аудио никуда не уходит: распознавание идёт в worker-потоке демона, модель лежит на диске. Без сети и без модели владелец получает понятный отказ, демон продолжает работать.

Телеметрии нет: ни sherpa-onnx-node, ни декодеры не шлют отчётов и не читают переменные с токенами.

Пределы: README и манифесты пакетов, lock и распакованные tarballs (включая JS-обёртку sherpa и WASM-декодеры) читались выборочно; нативные `.node`/`.so` и трафик не аудировались. Замер точности — на синтезированной русской речи в песочнице, не на записи владельца; закреплённый экспорт sherpa в песочнице недоступен.

## Браузер: Playwright MCP и системный Chromium (2026-10-24)

Набор для инструмента `browser` (страницы, которые рисуют текст JavaScript): `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 0.2.1-rc.3 (seam browser-use линии харнесса), `@playwright/mcp` 0.0.80 (сервер Playwright MCP, закреплённая версия) и `playwright-core` 1.63.0-alpha-2026-08-31 (ровно та версия, которую просит Playwright MCP). Все три стоят в `dependencies` с точными версиями из registry.npmjs.org; гейты `tests/gates/browser-deps.test.ts` и `tests/gates/runner-deps.test.ts` это проверяют.

### Что реально запускается (уточнение круга 2)

Инструмент `packages/tools-browser` запускает Chromium напрямую через `playwright-core` и **не** поднимает MCP-сервер. `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` — cordis-плагин (`apply(ctx, config)`): он вставляет в контекст `browserUse`, `agents`, `tools`, `systemPrompt` и `workingDirectory`, а затем запускает `@playwright/mcp/cli.js` через `mountSessionMcp`. В режиме запуска seam передаёт `--isolated`, то есть Playwright MCP заводит свой временный профиль, а не `DSHBOT_HOME/browser-profile`; другой режим — `--cdp-endpoint` (attach), который задача прямо запрещает. Кроме того, через seam нельзя повесить проверку адреса на каждый запрос страницы (подресурс, фрейм, редирект), нельзя ограничить действие и страницу своим таймаутом и нельзя гарантировать закрытие зависшей страницы при остановке демона — а это критерии задачи. Поэтому seam и Playwright MCP закреплены и проверены как целевой путь, но в текущей реализации MCP-сервер не стартует: нет дочернего процесса `@playwright/mcp`, нет переменных `PLAYWRIGHT_MCP_*` в окружении и никакие ключи бота в MCP не передаются. Инструмент использует тот же движок, что и Playwright MCP 0.0.80 (`playwright-core` ровно его версии), и сам запускает системный Chromium со своим профилем `DSHBOT_HOME/browser-profile`.

### Транзитивные зависимости в lock

Проверены по `package-lock.json` (все с registry.npmjs.org, `dev` не выставлен):

- `@deepseek-ai/dsh-experimental-browser-use-runtime` 0.2.1-rc.3 — прямая зависимость seam; тянет `@deepseek-ai/schemastery ~3.18.5`, остальное — peer-зависимости харнесса. Своего сетевого кода и install-скриптов нет; при неактивном seam не исполняется.
- `@deepseek-ai/dsh-browser-use` 0.2.1-rc.3 — peer seam и runtime, лежит в lock; install-скриптов и телеметрии нет, сам наружу не ходит.
- `@deepseek-ai/dsh-mcp-client` 0.2.1-rc.3 — peer runtime, лежит в lock. Зависимости: `@deepseek-ai/dsh-util-values`, `@deepseek-ai/schemastery`, `@modelcontextprotocol/client` 2.2.0. Это stdio-клиент MCP: `cross-spawn` запускает сервер с урезанным окружением (allowlist `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), сеть — только HTTP-транспорт и OAuth (`eventsource`, `eventsource-parser`, `jose`, `pkce-challenge`), при stdio не используется; телеметрии нет, install-скриптов нет. В текущем пути не запускается.
- `@modelcontextprotocol/client` 2.2.0 и `@modelcontextprotocol/core` 2.2.0 — вложенная копия под `node_modules/@deepseek-ai/dsh-mcp-client/node_modules/`, отдельная от корневой 2.3.1 (её использует граф памяти). Код тот же класс stdio/HTTP-клиента; сети и телеметрии сверх описанного нет, install-скриптов нет.
- `playwright` 1.63.0-alpha-2026-08-31 — зависимость `@playwright/mcp`; это драйвер без браузера, install-скриптов нет, сам в сеть не ходит. `playwright-core` той же версии — движок, который использует и MCP, и наш инструмент.

- Install-скриптов у трёх основных пакетов и перечисленных зависимостей нет: у `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`, `@playwright/mcp` и `playwright-core` install-скриптов нет, у `playwright` тоже. `ignore-scripts=true` не менялся, поэтому браузер никогда не скачивается при установке. `playwright-chromium`, `@playwright/browser-chromium`, `puppeteer` и `puppeteer-core` в дерево не попадают.
- Chromium берётся только системный: `DSHBOT_BROWSER_PATH`, иначе поиск `chromium`/`chromium-browser`/`google-chrome`/`chrome` в `PATH`. Без браузера инструмент отвечает понятным отказом, демон продолжает работать.
- Сеть: Chromium отправляет запросы через принадлежащий инструменту HTTP-прокси на случайном порту `127.0.0.1`; прокси использует только встроенные `node:http` и `node:net`, новых зависимостей нет. Адрес проверяется до запуска браузера и перед **каждым** HTTP-запросом и HTTPS CONNECT: loopback, частные, link-local (включая IPv4-mapped IPv6 вида `::ffff:7f00:1`, NAT64 и 6to4) отклоняются до соединения той же проверкой, что начальный URL. Соединение открывается с проверенным IP без повторного DNS-разрешения; HTTPS проходит туннелем без расшифровки. Это закрывает HTTP-редиректы навигации, фреймов, скриптов, картинок и fetch/XHR, для которых закреплённый Playwright не вызывает обработчик route повторно. Разрешённые редиректы обрабатывает Chromium, сохраняя конечный URL, cookies и базу относительных ссылок. Неявное исключение loopback из прокси выключено (`<-loopback>`), service workers заблокированы, обычные WebSocket upgrades отклоняются; защищённые WebSocket используют проверенный CONNECT. `file:` запрещён при проверке URL и запросов; Chromium также не допускает такой HTTP-редирект. Тестовое разрешение локального origin демон не передаёт. Профиль — `DSHBOT_HOME/browser-profile`, headless, без CDP/attach к браузеру владельца. WebRTC принудительно переводится на `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, чтобы страница не искала локальную сеть в обход прокси. Прокси и его сокеты закрываются вместе с браузером, включая простой, ошибку запуска и `forceStop()`.
- Телеметрии нет: ни Playwright MCP, ни `playwright-core` не шлют отчётов и не читают переменные с токенами.
- Риск: браузер исполняет чужой JavaScript. Поэтому он только у владельца, ленивый (схема не в каждом запросе main), текст страницы возвращается в рамке EXTERNAL_UNTRUSTED_CONTENT как недоверенные данные. URL, title и body очищаются вместе до добавления доверенных границ: служебные токены чата и поддельные маркеры начала/конца рамки заменяются. Каждое действие и каждая страница ограничены таймаутом, а процесс закрывается по простою `DSHBOT_BROWSER_IDLE_MS` (в том числе после зависшего вызова) и при остановке демона; `stop()` не ждёт очередь, а `forceStop()` добивает процессы профиля, если остановка не уложилась в бюджет.

Пределы: манифесты, lock и код seam-пакета читались; сам Playwright MCP 0.0.80 — по типам и README, его минифицированный `coreBundle` целиком не аудировался. В круге 3 проверен участок закреплённого `playwright-core`, автоматически продолжающий редиректы без route, и добавлены тесты настоящего Chromium на цепочки редиректов HTTP/HTTPS, отсутствие исходящих соединений к запрещённым адресам и очистку title/URL/body. Проверены также CONNECT и закрытие сокетов прокси; TLS-трафик не расшифровывался. Код `@modelcontextprotocol/client` 2.2.0 построчно не читался (он в текущем пути не исполняется).

## MCP-клиент: серверы владельца из mcp.json (2026-10-24)

Набор для инструментов MCP-серверов владельца: `@deepseek-ai/dsh-mcp-client` 0.2.1-rc.3 (мост к серверам: имена `mcp__<server>__<tool>`, stdio и Streamable HTTP) и `@deepseek-ai/dsh-mcp-resources` 0.2.1-rc.3 (общие инструменты чтения ресурсов `list_mcp_resources`/`read_mcp_resource`). Транспорт SSE берётся из того же корневого `@modelcontextprotocol/client` 2.3.1 (`SSEClientTransport`), отдельной зависимости не добавляет. Оба стоят в `dependencies` точными версиями из registry.npmjs.org; `tests/gates/mcp-deps.test.ts` и `tests/gates/runner-deps.test.ts` это проверяют.

### Пакеты и что они тянут

`dsh-mcp-client` зависит от `@deepseek-ai/dsh-util-values` 0.2.1-rc.3, `@deepseek-ai/schemastery` ~3.18.5 и `@modelcontextprotocol/client` 2.2.0 (своя вложенная копия рядом с корневой 2.3.1; в замыкание входит и `@modelcontextprotocol/core` 2.2.0). `dsh-mcp-resources` зависит только от `@deepseek-ai/dsh-util-values` 0.2.1-rc.3; остальное — peer-зависимости харнесса, уже закреплённые в наборе. В дереве lock также лежат `@modelcontextprotocol/server` 2.3.1 и `@modelcontextprotocol/server-memory` 2.0.0 (клиент и сервер памяти графа прошлых задач), их замыкание учтено в гейте. Install-скриптов ни у одного пакета замыкания нет; `ignore-scripts=true` не менялся. Все записи разрешаются с `registry.npmjs.org` и несут integrity.

### Сеть, телеметрия, окружение

Своего сетевого кода у этих пакетов нет: наружу ходит только выбранный владельцем транспорт. Streamable HTTP и SSE обращаются к `url` из `mcp.json` (плюс его `headers`), stdio запускает `command`/`args` из файла. Телеметрии и отчётов нет, токены окружения пакеты не читают. Install-скриптов нет.

Бот использует не cordis-плагин `apply`, а общий контракт имён и собственный stdio-транспорт (`packages/tools-mcp/src/transport.ts`): плагин харнесса берёт окружение из `scrubbedParentEnv()` (allowlist `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` и всё, что не похоже на секрет), а критерий требует строго PATH, HOME, LANG и `env` сервера. Поэтому транспорт спавнит процесс ровно с этими ключами, а `TELEGRAM_BOT_TOKEN`/`DEEPSEEK_API_KEY` и прочие ключи демона в него не попадают по построению. Инструменты сервера становятся ленивыми инструментами раннера (`lazy: true`), а не схемой в каждом запросе; destructive-пометка `annotations.destructiveHint` ведёт к карточке подтверждения владельца.

### Риск и пределы

Сервер MCP — чужой код, который исполняется отдельным процессом с урезанным окружением; упавший или не стартовавший сервер не роняет демон, его инструменты отвечают понятной ошибкой, остальные серверы работают. Пределы: манифесты, lock и код клиента читались выборочно; минифицированный `lib/index.js` пакетов целиком не аудировался, сетевой трафик Streamable HTTP и SSE не перехватывался. Список серверов — только `<DSHBOT_HOME>/mcp.json`, который бот не пишет; файл перечитывается командой владельца `/mcp reload`.

## Почта по IMAP: инструмент `mail` (2026-10-25)

Новых зависимостей нет. IMAP-клиент и разбор MIME написаны в `packages/tools-mail` на `node:tls` и встроенных модулях Node (`node:fs`, `node:path`, `node:crypto`), поэтому ни `imapflow`, ни `node-imap`, ни `mailparser`, ни `nodemailer` в дерево не попадают. `package.json` и `package-lock.json` не менялись; `ignore-scripts=true` не трогали. `tests/gates/mail-deps.test.ts` проверяет отсутствие сторонней почтовой библиотеки и то, что исходники пакета импортируют только `node:` и локальные модули.

### Что именно делает код

`connectImap` открывает TCP только через `tls.connect` с `rejectUnauthorized: true` и штатным хранилищем доверия Node; `NODE_EXTRA_CA_CERTS` демона действует, а `tls: false`, `secure: false` или `ssl: false` в `mail.json` отклоняются до сокета. Сертификат, который не проверяется, обрывает соединение до отправки `LOGIN`: пароль не попадает ни на сервер, ни в ответ, ни в журнал. Пароль читается из переменной окружения, названной в `password_env`; в ответ инструмента и в файлы DSHBOT_HOME он не пишется. Отправки нет по построению: клиент умеет только `LOGIN`, `SELECT INBOX`, `UID SEARCH`, `UID FETCH` и `LOGOUT`, а не `APPEND`/`STORE`/`COPY`/`SMTP`.

### Риск и пределы

Разбор писем — свой: заголовки RFC 2047, перенос `base64`/`quoted-printable`, multipart, HTML в текст. Доверять содержимому письма нельзя, поэтому ответы `list` и `read` целиком лежат в рамке `EXTERNAL_UNTRUSTED_CONTENT` со случайной границей на вызов, а слово границы внутри письма обезвреживается. Пределы: IMAP-расширения (IDLE, CONDSTORE, серверный поиск по телу) не реализованы и не нужны; поведение настоящего Яндекс-сервера проверялось только через локальный TLS-сервер в тестах, живой ящик в этой проверке не использовался.

## Провайдеры моделей: `dsh-llm-pi-ai` и хранилище входов (2026-10-27)

Задача — подключать к боту провайдеров кроме DeepSeek родными модулями харнесса той же линии 0.2.1-rc.3, без форка и без чужих SDK. Установка: `npm install --save-exact` с `ignore-scripts=true`, +86 пакетов, всё с `registry.npmjs.org` и с integrity.

Прямые зависимости:

- `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.3` — мультипровайдерный адаптер `dsh-llm` поверх `@earendil-works/pi-ai` 1.1.x. Держит каталоги провайдеров, маршруты, вход по ключу и OAuth, запись входа в `llm-pi-ai/<provider>` и обновление токенов под межпроцессным замком хранилища. Своего сетевого кода не добавляет: запросы идут теми же глобальными `fetch`/SDK провайдера, что и в pi-ai.
- `@deepseek-ai/dsh-credentials-local@0.2.1-rc.3` — файловое хранилище учёток `DSHBOT_HOME/dsh/.credentials.yaml` (переопределяется параметром `path`). Файл создаётся и заменяется атомарно с `0600`; при старте и перезагрузке отказывает файлу, читаемому группой или остальными. Секреты не попадают в `process.env` и не логируются; в диагностике YAML нет значений.
- `@deepseek-ai/dsh-authorization@0.2.1-rc.3` — шов входа `ctx.authorization`: регистрация потоков, `begin`/`cancel`, `notify`/`prompt` только тому интерфейсу, который начал вход. Сам поток пишет запись через `ctx.credentials`; шов подтверждает, что запись действительно закоммичена, и отличает отказ владельца (`cancelled`) от поломки провайдера.

Транзитивные peer-зависимости шва и адаптера (`dsh-credentials`, `dsh-attachment`, `dsh-fs`, `dsh-launch-environment`, `dsh-timeout`, `dsh-atomic-write`, `dsh-home-paths`, `chokidar`, `yaml`) ставятся npm автоматически из lock; точные версии зафиксированы.

### Install-скрипты

В дереве pi-ai два новых пакета с install-скриптами; оба внесены в `INSTALL_SCRIPTS_ALLOWED` в `tests/gates/deps.test.ts` с пояснением:

- `@google/genai@2.21.0` — `preinstall`/`prepare`/`prepack`; в опубликованном tarball `scripts/prepare.js` нет, `prepare` срабатывает только при установке из git.
- `protobufjs@7.6.6` — `postinstall` запускает `scripts/postinstall.js` из пакета. Скрипт только читает `package.json` самого protobufjs и родительского проекта и, если поле `versionScheme` задано, печатает в stderr предупреждение о несовместимой схеме версий зависимости; файлов не пишет, сеть и процессы не трогает. Для работы библиотеки он не нужен, поэтому его пропуск при `ignore-scripts=true` ничего не ломает.

`ignore-scripts=true` в `.npmrc` не менялся, поэтому ни один хук не исполняется. `koffi` и `node-pty` остаются в списке по прежней проверке.

### Хранение и границы

Запись входа лежит в `DSHBOT_HOME/dsh/`, то есть внутри каталога бота, который файловые инструменты уже скрывают целиком (кроме `workspace`, `app` и `candidates`), а `exec` маскирует пустым tmpfs. `host_exec` на локальном алиасе читает машину, поэтому его вывод дополнительно очищается значениями записей хранилища: команда `cat` файла учёток возвращает текст без ключа. `DEEPSEEK_API_KEY` остаётся ключом окружения маршрута `deepseek-official` и в файл не пишется.

### Риск и пределы

Провайдеры получают сеть и платные запросы только после явного входа владельца; моделей без сохранённой записи нет в каталоге ролей. Keychain-хранилища у пакета нет: файл читается процессом того же UID, поэтому защита от инструментов агента — это маскирование каталога и очистка вывода, а не граница ОС. Пределы: код `@earendil-works/pi-ai` целиком не аудировался, OAuth-потоки провайдеров проверены только через подменённый локальный маршрут zai; живые входы OpenAI/ChatGPT, z.ai и остальных не выполнялись.
