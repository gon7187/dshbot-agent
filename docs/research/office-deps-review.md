# Office generators: dependency review

Задача: инструмент `office` создаёт DOCX, XLSX и PPTX чистыми JS-библиотеками и правит XLSX в новый
файл. Craft CLI и LibreOffice на сервере нет и не будет; чтение офисных файлов остаётся за извлечением
вложений (`packages/app/src/attachments-worker.mjs`, unpdf/mammoth/read-excel-file) — второй парсер
текста в `packages/tools-office` не заводится.

## Выбранные пакеты

| Пакет | Версия | Опубликован | Лицензия | Install-скрипт | Нативный бинарник | Зачем |
| --- | --- | --- | --- | --- | --- | --- |
| `docx` | 9.9.0 | 2026-10-07 | MIT | нет | нет | DOCX: заголовки, runs с bold/italic, списки, таблицы, разрыв страницы |
| `write-excel-file` | 4.1.1 | 2026-04-22 | MIT | нет | нет | XLSX: листы, типы ячеек, даты, формулы, ширины колонок, жирная шапка, закреплённая первая строка |
| `pptxgenjs` | 4.0.1 | 2025-06-26 | MIT | нет | нет | PPTX: слайды, текст, списки, таблицы, картинки |

Все три версии опубликованы не позже чем за 14 дней до изменения (проверка на 2026-10-24: `docx`
9.9.0 — 17 дней, `write-excel-file` 4.1.1 — около 6 месяцев, `pptxgenjs` 4.0.1 — больше года).
Версии точные (`save-exact=true`), пакеты стоят в `dependencies`, а не в `devDependencies`: демон
работает с production-установкой.

### Почему не xlsx 0.18.5 и не SheetJS с CDN

`xlsx@0.18.5` из npm уязвим (CVE-2023-30533, prototype pollution). SheetJS 0.20.x существует только
на `cdn.sheetjs.com`, то есть вне публичного npm-реестра и его integrity-контура. `write-excel-file`
даёт нужные возможности (включая `type: 'Formula'` и `stickyRowsCount`) из обычного реестра и является
парой к уже используемому `read-excel-file@9.3.12` из #124.

## Транзитивные зависимости

Закрытие по `package-lock.json` (все записи без `hasInstallScript`, без `.node`):

- `docx@9.9.0`: `@types/node`, `hash.js@1.1.7`, `jszip@3.10.1`, `nanoid@6.0.1` (вложенная копия),
  `xml@1.0.1`, `xml-js@1.6.11`.
- `write-excel-file@4.1.1`: `fflate@0.8.3`.
- `pptxgenjs@4.0.1`: `@types/node`, `https@1.0.0`, `image-size@1.2.1`, `jszip@3.10.1`;
  `image-size` тянет `queue@6.0.2`.

`jszip` уже был в закрытии #124. Ни в одном пакете закрытия нет install-скриптов, нативных
расширений (`binding.gyp`/`.node`), `dsh-base`, `otel`, analytics, `craft`, `libreoffice`, `soffice`.
Гейт: `tests/gates/office-deps.test.ts`.

## Как устроено

- `packages/tools-office/src/index.ts` — инструмент `office`, проверка имени и пути, запуск worker
  с `resourceLimits` и таймаутом 120 с (таймер демона, поэтому тест с фейковыми часами его двигает).
  Путь входа и каталог `workspace/outbox/<дата>` проверяются по `realpath`: симлинк наружу отклоняется
  ошибкой инструмента. `ownerSessionId` (в демоне — `MAIN_SESSION_ID`) закрывает вызов всем сессиям,
  кроме main владельца: субагент, гость или задание получают ошибку, а не файл.
- `packages/tools-office/src/office-worker.mjs` — генерация в `worker_threads`: docx, write-excel-file,
  pptxgenjs. `edit_xlsx` читает книгу через общий `packages/app/src/xlsx-read.mjs` — тот же
  `read-excel-file`, то же извлечение #124, тот же ZIP-guard и те же лимиты; отдельного парсера в
  `tools-office` нет (гейт `tests/gates/office-deps.test.ts`).
- `packages/app/src/zip-guard.mjs` — общий разбор центрального каталога ZIP (лимиты 100 МБ/50 МБ,
  отказ ZIP64, многотомных, префиксов и неоднозначного EOCD); импортируется и извлечением вложений,
  и чтением XLSX.
- `packages/app/src/xlsx-read.mjs` — единственный вызов `read-excel-file` в демоне: текст для
  извлечения вложений и значения листов для `edit_xlsx`. Книга за лимитами извлечения (5000 строк,
  256 колонок) для правки отклоняется ошибкой, а не обрезается молча.
- `read` не парсит ничего сам: `createOfficeTool` получает `extract` из `AttachmentIntake.extractFile`,
  то есть тот же worker, те же лимиты и та же пометка об усечении, что у приёма вложений.
- Файлы пишутся только в `DSHBOT_HOME/workspace/outbox/<YYYY-MM-DD>/`; имя очищается от пути,
  управляющих символов и запрещённых Windows символов, расширение задаёт действие.

## Проверка

- `npm ls docx write-excel-file pptxgenjs` — точные версии, без посторонних пакетов.
- `npx vitest run packages/app/office-tool.test.ts` — поведение инструмента целиком.
- `npx vitest run packages/app/office-tool-paths.test.ts` — отказ при симлинке каталога даты,
  outbox, входного файла и картинки, и отказ всем сессиям кроме main владельца.
- `npx vitest run tests/gates/office-deps.test.ts` — закрепление, lock, закрытие, отсутствие второго
  парсера (в том числе чтения книги для `edit_xlsx`) и shell-out в Craft/LibreOffice.
