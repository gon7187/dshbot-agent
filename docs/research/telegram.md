# Telegram для DSHBOT: Bot API 9.3–10.3 и опыт OpenClaw

Дата исследования: 2026-10-23. Источники: https://core.telegram.org/bots/api-changelog и https://core.telegram.org/bots/api (прочитаны частями, страница ~582 тыс. символов), код `refs/openclaw/extensions/telegram` и документация `refs/openclaw/docs/channels/telegram*`.

Условные пометки: **[док]** — прочитано на официальной странице; **[код]** — видно только в коде OpenClaw (не подтверждено страницей); **[не подтверждено]** — найти не удалось. Инструмент чтения страницы выдавал пересказ, а не дословный текст, поэтому имена методов, типов, полей, числа и значения enum считаются точными, а формулировки описаний — пересказ.

Область: личный бот, один владелец, приватный чат, long polling. Группы и каналы вне объёма.

---

## 1. Что нового в Bot API 9.3–10.3

Новее 10.3 в changelog ничего нет (верх страницы — 10.3 от 24 августа 2026).

### 1.1 Хронология

| Версия | Дата | Главное для DSHBOT |
|---|---|---|
| 9.3 | 2025-12-31 | Топики в приватных чатах (`has_topics_enabled`, `message_thread_id` в `Message` и во многих send-методах и в `sendChatAction`), `sendMessageDraft` |
| 9.4 | 2026-02-09 | `createForumTopic` в приватных чатах; `style` и `icon_custom_emoji_id` у кнопок; `allows_users_to_create_topics` у `User`; кастомные эмодзи в сообщениях бота, если у владельца бота Premium |
| 9.5 | 2026-03-01 | `sendMessageDraft` доступен всем ботам; `MessageEntity` типа `date_time` |
| 9.6 | 2026-04-03 | Managed bots, опросы с несколькими верными ответами (не нужно) |
| 10.0 | 2026-05-08 | `deleteMessageReaction`, `deleteAllMessageReactions` (только для админов супергрупп); пустой `text` разрешён в `sendMessageDraft`; guest mode; live photos |
| 10.1 | 2026-06-11 | **Rich Messages**: `sendRichMessage`, `sendRichMessageDraft`, `rich_message` в `editMessageText`, типы `RichText*`, `RichBlock*`, `InputRichMessage` |
| 10.2 | 2026-07-14 | `InputRichMessage.blocks` и `.media`, `InputRichMessageMedia`; **эфемерные сообщения** и команды (`BotCommand.is_ephemeral`, `editEphemeralMessage*`, `deleteEphemeralMessage`); Communities; `BotSubscriptionUpdated` |
| 10.3 | 2026-08-24 | Кнопки внутри rich (`RichMessageButton`, `RichTextButton`, `RichBlockButtons`); `is_compact` у таблиц; раскрываемые цитаты; document-блоки и `tg://document?id=`; `EphemeralMessageParameters`; `DisabledButton` и `disabled`; `force_reply` в клавиатурах; **`can_stop` и `keep_on_stop`** у черновиков; **update `stopped_message_generation`** (`MessageGenerationStopped`) |

### 1.2 Rich Messages (10.1–10.3)

**Методы** [док]

`sendRichMessage` — параметры:

| Параметр | Тип | Обяз. | Примечание |
|---|---|---|---|
| `chat_id` | Integer или String | да | |
| `rich_message` | InputRichMessage | да | |
| `message_thread_id` | Integer | нет | топики |
| `business_connection_id` | String | нет | |
| `direct_messages_topic_id` | Integer | нет | только чаты прямых сообщений каналов |
| `ephemeral_message_parameters` | EphemeralMessageParameters | нет | только группы |
| `disable_notification`, `protect_content`, `allow_paid_broadcast` | Boolean | нет | |
| `message_effect_id` | String | нет | только приватные чаты |
| `suggested_post_parameters` | SuggestedPostParameters | нет | |
| `reply_parameters` | ReplyParameters | нет | |
| `reply_markup` | InlineKeyboardMarkup / ReplyKeyboardMarkup / ReplyKeyboardRemove / ForceReply | нет | |

`sendRichMessageDraft` — параметры (возвращает True, только приватный чат):

| Параметр | Тип | Обяз. | Примечание |
|---|---|---|---|
| `chat_id` | Integer | да | только приватный чат |
| `draft_id` | Integer | да | ненулевой; тот же id анимирует обновление, новый id заменяет без анимации |
| `rich_message` | InputRichMessage | да | загрузка новых файлов и загрузка по URL не поддерживаются |
| `message_thread_id` | Integer | нет | |
| `can_stop` | Boolean | нет | показывает кнопку «стоп»; бот получит `stopped_message_generation` |
| `keep_on_stop` | Boolean | нет | оставить черновик в чате после нажатия «стоп» (он всё равно исчезает через короткое время) |

Черновик — временное превью примерно 30 секунд; чтобы сообщение осталось, нужен `sendRichMessage`.

`editMessageText` принимает `rich_message` (InputRichMessage) вместо `text`; один из двух обязателен. Для inline-сообщений загрузка файлов и по URL не поддерживается. `reply_markup` — только InlineKeyboardMarkup. Поле `Message.rich_message` (RichMessage) отмечает rich-сообщение. Текст обычного `editMessageText` — 1–4096 символов.

**InputRichMessage** [док] — ровно одно из `html`, `markdown`, `blocks`:

| Поле | Тип | Смысл |
|---|---|---|
| `blocks` | Array of InputRichBlock | типизированные блоки |
| `html` | String | HTML-стиль; медиа через `media` |
| `markdown` | String | Markdown-стиль; медиа через `media` |
| `media` | Array of InputRichMessageMedia | файлы, на которые ссылаются `tg://photo?id=`, `tg://video?id=`, `tg://document?id=`, `tg://audio?id=` |
| `is_rtl` | Boolean | справа налево |
| `skip_entity_detection` | Boolean | отключить автоопределение URL, email, упоминаний, хэштегов, кэштегов, команд, телефонов |

`InputRichMessageMedia`: `id` (1–64 символа `A-Za-z0-9_-`) и `media` (InputMediaAnimation / Audio / Document / Photo / Video / VoiceNote). `InputRichMessageContent` (для inline-результатов) содержит одно поле `rich_message`; в нём допустимы только ранее загруженные файлы. Полученный `RichMessage`: `blocks`, `is_rtl`.

**Лимиты rich-сообщения** [док]

- текст: до 32 768 символов UTF-8 (включая альтернативный текст custom emoji и исходник формул);
- блоки: до 500, считая вложенные блоки, элементы списков, строки таблиц, цитаты и details;
- вложенность: до 16 уровней;
- медиа: до 50 вложений;
- колонки таблицы: до 20;
- кнопки в `InputRichBlockButtons`: 1–8;
- `callback_data`: 1–64 байта;
- заголовок: `size` 1–6;
- карта (`InputRichBlockMap`): `zoom` 0–24, `width` и `height` 0–10000, сумма не более 10000, отношение сторон не более 20.

Для сравнения обычное сообщение: 4096 символов после разбора сущностей, подпись к медиа 1024.

**Блоки** [док]. У каждого блока есть `type`. Для вывода — `RichBlock*`, для ввода — `InputRichBlock*` (те же поля, кроме отмеченных отличий).

| Тип блока (`type`) | Поля |
|---|---|
| `paragraph` | `text` |
| `heading` | `text`, `size` 1–6 |
| `pre` | `text`, `language` (необяз.) |
| `footer` | `text` |
| `divider` | — |
| `mathematical_expression` | `expression` (LaTeX) |
| `anchor` | `name` |
| `list` | `items`: RichBlockListItem (`label` — только на выводе, `blocks`, `has_checkbox`, `is_checked`, `value`, `type`: `a`/`A`/`i`/`I`/`1`) |
| `blockquote` | `blocks`, `credit` |
| `expandable_blockquote` | `text`, `credit` |
| `pullquote` | `text`, `credit` |
| `collage`, `slideshow` | `blocks`, `caption` (RichBlockCaption: `text`, `credit`) |
| `table` | `cells`: массив массивов RichBlockTableCell; флаги `is_bordered`, `is_striped`, `is_compact`; `caption` (RichText) |
| `details` | `summary`, `blocks`, `is_open` |
| `map` | `location`, `zoom`, `width`, `height`, `caption` |
| `buttons` | `buttons` (RichMessageButton, на вводе 1–8), `align` (`left`/`center`/`right`) |
| `animation`, `audio`, `document`, `photo`, `video`, `voice_note` | на выводе: объект медиа; на вводе: `InputMedia*`; `caption`; `has_spoiler` только на выводе |
| `thinking` | `text`; **только в `sendRichMessageDraft`**, в полученных сообщениях не бывает |

`RichBlockTableCell`: `text` (нет текста — невидимая ячейка), `is_header`, `colspan`, `rowspan`, `align` (`left`/`center`/`right`), `valign` (`top`/`middle`/`bottom`).

**RichText** — строка, массив RichText или один из 26 подтипов с полем `type`: `bold`, `italic`, `underline`, `strikethrough`, `spoiler`, `date_time` (`unix_time`, `date_time_format`), `text_mention` (`user`), `subscript`, `superscript`, `marked`, `code`, `custom_emoji` (`custom_emoji_id`, `alternative_text`), `mathematical_expression` (`expression`), `url` (`url`), `email_address`, `phone_number`, `bank_card_number`, `mention` (`username`), `hashtag`, `cashtag`, `bot_command`, `button` (`button`: RichMessageButton), `anchor` (`name`), `anchor_link` (`anchor_name`; пусто — верх сообщения), `reference` (`name`), `reference_link` (`reference_name`). У большинства подтипов есть поле `text` (RichText).

**RichMessageButton** [док]: `text` (RichText только из простого текста, custom emoji, date-time), `style` (`danger`, `success`, `primary`, `link`; `link` — только для callback-кнопок), и **ровно одно** из: `url`, `callback_data` (1–64 байта), `web_app`, `login_url`, `switch_inline_query`, `switch_inline_query_current_chat`, `switch_inline_query_chosen_chat`, `copy_text`, `disabled` (DisabledButton).

**Синтаксис `markdown` и `html`** [док]:

- Markdown: GFM-совместимый. Жирный `**x**`, курсив `*x*`, зачёркнутый `~~x~~`, код `` `x` ``, выделение `==x==`, спойлер `||x||`, ссылка `[x](url)`, заголовки `#`..`######`, `---`, списки `-`/`1.`, задачи `- [ ]`/`- [x]`, цитата `>`, pipe-таблица (двоеточия в разделителе задают выравнивание, в ячейках только инлайн-форматирование), код-блок с языком, сноски `[^id]`, математика `$x$`, `$$x$$`, медиа `![](url "подпись")` отдельным блоком. Кнопок, раскрываемой цитаты, pull-quote, карты, thinking в Markdown нет — только HTML.
- HTML: `<p>`, `<h1>`..`<h6>`, `<pre><code class="language-X">`, `<hr/>`, `<ul>/<ol>/<li>`, `<blockquote>`, `<blockquote expandable>`, `<aside>`, `<table>/<tr>/<th>/<td>/<caption>`, `<details><summary>`, `<tg-map lat long zoom/>`, `<tg-button-row align>` с `<tg-button type=... style=... data=...>`, `<tg-thinking>` (только черновик), `<tg-document>`, `<tg-collage>`, `<tg-slideshow>`, `<tg-math>`, `<tg-math-block>`, `<tg-time unix format>`, `<tg-emoji emoji-id>`. Из именованных сущностей поддержаны только `&lt; &gt; &amp; &quot; &apos; &nbsp; &hellip; &mdash; &ndash; &lsquo; &rsquo; &ldquo; &rdquo;`.
- Автоопределение URL, почты, упоминаний и т. п. включено по умолчанию; клиент показывает подтверждение перед открытием ссылки.

### 1.3 Остановка генерации пользователем (10.3) [док]

- Параметры: `can_stop` и `keep_on_stop` в `sendMessageDraft` и `sendRichMessageDraft`.
- Поле `Update.stopped_message_generation` типа `MessageGenerationStopped`.
- `MessageGenerationStopped`: `chat` (Chat, обяз.), `draft_id` (Integer, обяз.), `message_thread_id` (Integer, необяз.). Поля `message_id` и `from` нет: связать со своим ходом можно только через `draft_id`.
- Чтобы получать апдейт, его тип должен быть в `allowed_updates` (OpenClaw выкидывает его из списка сознательно, `allowed-updates.ts:9-13`, потому что не использует останавливаемые черновики).

### 1.4 sendMessageDraft [док]

`chat_id` (только приватный), `draft_id` (ненулевой), `text` (0–4096 символов после разбора; пустой показывает плейсхолдер), `parse_mode` или `entities`, `message_thread_id`, `can_stop`, `keep_on_stop`. Черновик — временное превью около 30 секунд; финал отправляется `sendMessage`. Доступен всем ботам с 9.5.

### 1.5 Реакции [док]

- `setMessageReaction`: `chat_id`, `message_id` (обяз.), `reaction` (массив `ReactionType`, необяз.), `is_big`. Небесплатный Premium у бота не нужен, но обычный бот ставит **одну** реакцию на сообщение; платные реакции ботам недоступны. `ReactionTypeEmoji` (`type: "emoji"`, `emoji` из фиксированного списка), `ReactionTypeCustomEmoji` (`custom_emoji_id`), `ReactionTypePaid`.
- Снятие своей реакции: явно описанного способа на странице не найдено; по общему принципу метода — вызов с пустым или отсутствующим `reaction` **[не подтверждено дословно]**. Список допустимых эмодзи в OpenClaw: `status-reaction-variants.ts:15-80+` (`TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST`).
- `deleteMessageReaction` и `deleteAllMessageReactions` (10.0) — только супергруппы и право `can_delete_messages`; для приватного чата бесполезны.
- Апдейт `message_reaction` (реакции пользователя) требует явного `allowed_updates`; для приватных чатов поведение не уточнено на странице (в тексте указано «needs admin rights») **[не подтверждено для приватных чатов]**. OpenClaw явно добавляет `message_reaction` в список (`allowed-updates.ts:14-18`).

### 1.6 Клавиатуры [док]

- `InlineKeyboardButton`: `text`, `style` (`danger` красная, `success` зелёная, `primary` синяя; без поля — стиль клиента), `icon_custom_emoji_id` (только для ботов с купленными именами на Fragment или если у владельца бота Premium), и ровно одно действие: `url`, `callback_data` (1–64 байта), `web_app`, `login_url`, `switch_inline_query*`, `copy_text` (`CopyTextButton.text` 1–256), `callback_game`, `pay`, **`disabled`** (`DisabledButton`, пустой объект, кнопка ничего не делает).
- `InlineKeyboardMarkup.inline_keyboard` + новое необяз. `force_reply` (нельзя менять при редактировании). `ReplyKeyboardMarkup` тоже получил `force_reply`; отдельный `ForceReply` (`force_reply: true`, `input_field_placeholder` 1–64, `selective`).
- `KeyboardButton` имеет `style` и `icon_custom_emoji_id` так же.
- `CallbackQuery`: `id`, `from`, `message` (MaybeInaccessibleMessage), `data`, `chat_instance`. `answerCallbackQuery` нужно вызывать всегда, иначе клиент крутит индикатор; параметры: `callback_query_id`, `text` 0–200, `show_alert`, `url`, `cache_time`.

### 1.7 Топики в приватных чатах (9.3–9.4) [док]

- `User.has_topics_enabled` (в ответе `getMe`) — режим топиков включён; `User.allows_users_to_create_topics` — пользователи сами создают и удаляют топики (настройка в @BotFather). Включение режима — в BotFather, программно не включается.
- `createForumTopic`: `chat_id`, `name` (1–128), `icon_color` (одно из 7322096, 16766590, 13338331, 9367192, 16749490, 16478047), `icon_custom_emoji_id`; в приватных чатах поддерживается. Возвращает `ForumTopic` (`message_thread_id`, `name`, `icon_color`, `icon_custom_emoji_id`, `is_name_implicit`). `editForumTopic` (`name` 0–128, `icon_custom_emoji_id`) тоже работает в приватных чатах; `closeForumTopic`, `deleteForumTopic` есть в списке методов.
- `message_thread_id` принимают: send-методы, `sendChatAction`, `sendMessageDraft`, `sendRichMessage`, `sendRichMessageDraft`. `Message.is_topic_message` и `message_thread_id` приходят во входящих.
- `ForumTopicCreated.is_name_implicit` — имя не задано создателем, бот может переименовать.

### 1.8 Чеклисты [док]

- `sendChecklist` и `editMessageChecklist`: **`business_connection_id` обязателен** (Yes в таблице параметров). Для обычного бота в приватном чате они недоступны. `InputChecklist`: `title` 1–255, `tasks` 1–30 (`InputChecklistTask`: `id` положительный уникальный, `text` 1–100), `others_can_add_tasks`, `others_can_mark_tasks_as_done`.
- Замена: rich-сообщение со списком задач (`RichBlockListItem.has_checkbox`, `is_checked`; Markdown `- [ ]`/`- [x]`), редактируемое через `editMessageText` с `rich_message`.

### 1.9 Эфемерные сообщения (10.2–10.3) [док]

- Только группы и супергруппы; для личного бота в приватном чате смысла нет.
- Команда: `BotCommand.is_ephemeral = true`. Ответ: `EphemeralMessageParameters` (`receiver_user_id` обяз., `callback_query_id`, `replace_callback_query_message`) в `ephemeral_message_parameters` у `sendMessage`, `sendPhoto`, `sendDocument` и других, а также `sendRichMessage`. Правка: `editEphemeralMessageText/Media/Caption/ReplyMarkup`, удаление: `deleteEphemeralMessage` (все принимают `chat_id`, `receiver_user_id`, `ephemeral_message_id`). У небазового бота окно ответа 15 секунд после callback или эфемерного входящего; админ-бот может писать в любой момент. Доставка не гарантирована.
- В `Message`: `receiver_user`, `ephemeral_message_id`. `ReplyParameters.ephemeral_message_id`.

### 1.10 Прочее нужное

- `sendChatAction`: `chat_id`, `action` (`typing`, `upload_photo`, `record_video`, `upload_video`, `record_voice`, `upload_voice`, `upload_document`, `choose_sticker`, `find_location`, `record_video_note`, `upload_video_note`), `message_thread_id`; статус держится до 5 секунд, клиент гасит его при приходе сообщения бота.
- `message_effect_id` у `sendMessage`, `sendPhoto`, `sendDocument`, `sendRichMessage`, `sendChecklist` и др.: только приватные чаты. **Список ID эффектов и способ их получить на странице не найден [не подтверждено]**.
- `setMyCommands`: `commands` (до 100), `scope`, `language_code`. `BotCommand`: `command` 1–32 (`a-z0-9_`), `description` 1–256, `is_ephemeral`. Области: `default`, `all_private_chats`, `all_group_chats`, `all_chat_administrators`, `chat`, `chat_administrators`, `chat_member`. Для приватного чата порядок: `chat` → `all_private_chats` → `default`.
- Файлы: `sendDocument` до 50 МБ multipart, подпись до 1024; `sendPhoto` до 10 МБ, сумма сторон не более 10000, отношение не более 20; по URL: фото 5 МБ, остальное 20 МБ; `file_id` без лимита. Локальный Bot API сервер: выгрузка до 2000 МБ.
- `getUpdates`: `offset`, `limit` 1–100, `timeout`, `allowed_updates`. Пустой список означает все типы, кроме `chat_member`, `message_reaction`, `message_reaction_count`; если параметр опущен, сохраняется предыдущая настройка. Не работает, пока установлен webhook.
- Ответ API: `ok`, `result`, `description`, `error_code`, `parameters` (ResponseParameters). Точный состав `ResponseParameters` (`retry_after`, `migrate_to_chat_id`) на прочитанных частях страницы не показан **[не подтверждено страницей]**; `parameters.retry_after` использует код OpenClaw (`network-errors.ts:225-266`, `account-throttler.ts:74-83,192-198`).
- Общий лимит рассылки: 30 сообщений в секунду по боту; платный режим до 1000/сек (`allow_paid_broadcast`).
- Форматирование: MarkdownV2 (экранирование `_ * [ ] ( ) ~ \` > # + - = | { } . !`), HTML (`b i u s tg-spoiler a tg-emoji tg-time code pre blockquote [expandable]`), `date_time` сущность.

---

## 2. Как это делает OpenClaw

Все пути относительно `refs/openclaw/extensions/telegram/src/`, если не указано иное. Транспорт — grammY.

### 2.1 Какие фичи используются

| Фича | Использует? | Где |
|---|---|---|
| Rich messages (`sendRichMessage`, `editMessageText` с `rich_message`) | да, но **по умолчанию выключено** (`richMessages: false`): «некоторые клиенты Desktop, Web, Android и сторонние показывают rich как неподдерживаемое» | `rich-messages-config.ts:19-30`; доки `docs/channels/telegram/rich-messages.md` |
| `sendRichMessageDraft`, `sendMessageDraft` | **нет**, запрещено инвариантом | `AGENTS.md` раздел Streaming: «Do not reintroduce sendMessageDraft for answer streaming» (черновики эфемерны 30 секунд, финал всё равно отдельным `sendMessage`) |
| `can_stop`, `stopped_message_generation` | **нет**; тип апдейта вырезан из `allowed_updates` | `allowed-updates.ts:8-13` |
| Стрим ответа | `sendMessage`/`sendRichMessage` + многократный `editMessageText`, финал правкой на месте | `draft-stream.ts`, `draft-stream-message.ts:79-152` |
| Реакции как статус | да (`messages.statusReactions`, контроллер из SDK), ack-реакция по умолчанию 👀 | `bot-message-context.ts:444-495`; `status-reaction-variants.ts`; доки `messaging.md` «Ack reactions» |
| Кнопки approve | да, inline-клавиатура, стили кнопок | `approval-callback-data.ts`, `approval-handler.runtime.ts:100-132`, `exec-approvals.ts` |
| Топики | да, форум-топики и DM-топики по `getMe.has_topics_enabled`; `createForumTopic`/`editForumTopic` | `send-forum-topics.ts`, `bot/helpers.ts:357-407`, доки `threads-and-sessions.md` |
| Эфемерные сообщения | нет (grep по `ephemeral` в коде пуст) | — |
| Чеклисты (`sendChecklist`), эффекты (`message_effect_id`) | нет | — |
| Команды меню | да, `setMyCommands` при старте | `bot-native-command-menu.ts` |
| Typing | да, `sendChatAction`, продление каждые 4 с | `chat-action-timing.ts:3`, `bot-core.ts:114-118` |
| Медиа | альбомы, голос, видео-заметки, локации, стикеры; отправка с `--force-document` | доки `media.md`, `outbound-media.ts` |

### 2.2 Стриминг ответа

- Первый предпросмотр отправляется после порога `minInitialChars` (антишум push-уведомлений), дальше правка с троттлингом `DEFAULT_THROTTLE_MS = 1000`, минимум 250 мс (`draft-stream.ts:41,84-100`).
- После трёх подряд неудачных правок превью останавливается, чтобы не спамить предупреждениями (`draft-stream.ts:42-45`).
- Превью-«статусная коробка» живёт минимум 4 с перед удалением (`draft-stream.ts:46-52`).
- Режимы `streaming`: `off | partial | block | progress` (по умолчанию `progress`: одно редактируемое сообщение со статусом и инструментами, ответ уходит отдельным сообщением). Доки `messaging.md`, раздел «Live stream preview».
- Финал: короткий ответ правится на месте; длинный, разбитый на несколько сообщений, использует превью как первый кусок; при провале финальной правки — обычная отправка и очистка превью.
- Rich-превью: `sendRichMessage` для первого сообщения и `editMessageText({rich_message})` для правок (`draft-stream-message.ts:93-99,128-141`).

### 2.3 Форматирование и нарезка

- По умолчанию HTML parse_mode; rich — опция. Markdown модели переводится во внутреннюю IR, затем в типизированные `blocks` (а не в rich-Markdown, чтобы `$400-600K` не стало формулой): `rich-blocks.ts` (631 строка), `rich-block-model.ts`, `rich-blocks-html.ts`.
- Лимиты: `TELEGRAM_RICH_TEXT_LIMIT = 32_768`, `TELEGRAM_RICH_BLOCK_LIMIT = 500` (`rich-message.ts:13-14`); обычный текст `TELEGRAM_TEXT_CHUNK_LIMIT = 4000` (запас от 4096) (`text-chunk-limit.ts:7-27`).
- Нарезка по блокам с учётом лимитов блоков и символов: `splitTelegramRichBlocks` (`rich-block-split.ts`), вызывается из `rich-message.ts:151-174`. Сначала конвертируется весь документ, чтобы не рвать огороженный код и таблицы, затем режется типизированный список блоков, включая слишком длинный `pre`.
- Таблицы: режимы `markdown.tables`: `off | bullets | code | block`; таблица шире 20 колонок превращается в код-блок (`rich-messages-config.ts:33-40`, доки).
- Одна политика `skip_entity_detection` на весь документ: нельзя решать по чанкам, иначе Telegram заново разметит неподготовленные куски (`rich-message.ts:41-49,159-163`).
- Подпись к медиа остаётся HTML, максимум 1024 (rich подпись не заменяет).
- Цитирование: нативная цитата до 1024 UTF-16 единиц, при отказе — обычный ответ (`native-quote.ts`, доки).

### 2.4 Ошибки, 429, фолбэки

- Единый лестничный фолбэк `withTelegramPlainFallback` (`rich-plain-fallback.ts:62-90`): отказ формата → тот же текст простым. Триггеры (`rich-plain-fallback.ts:7-38`): `RICH_MESSAGE_[A-Z_]+_INVALID`, `RICH_MESSAGE_CONTENT_REQUIRED`, `RICH_MESSAGE_BLOCKS_TOO_MANY | DEPTH_INVALID | TEXT_TOO_LONG | MEDIA_TOO_MANY | TABLE_COLS_TOO_MANY` (проверены вживую на Bot API 10.2 2026-07-15 по комментарию в коде), "can't parse entities". Имена этих строк ошибок на официальной странице не приведены [код].
- Параллельные правила `AGENTS.md`: ошибка разбора подписи → простая подпись; «quote not found» → обычный ответ; оба пути (`send.ts` и стриминговый) обязаны деградировать одинаково, общие предикаты в `send-error-predicates.ts` и `reply-parameters.ts`.
- 429: один владелец на токен — `account-throttler.ts` (обёртка grammY `apiThrottler`): `retry_after` ставит паузу всем вызовам токена; без `retry_after` — фиксированная секунда; более короткий параллельный 429 паузу не сокращает (`account-throttler.ts:25-32,118-121`). Финальные ответы ждут до `TELEGRAM_OUTBOUND_FLOOD_BUDGET_MS = 5 минут` (`:29,166`); превью и typing — «заменяемые» запросы, при блокировке пропускаются, а не копятся (`:503,534`). Повторы отправки сами 429 не ретраят.
- `getUpdates`: воркер сам ретраит 5xx и 429 с учётом `parameters.retry_after`; 401 и 404 фатальны; 409 (второй poller) уходит наверх на восстановление (`AGENTS.md`, `polling-session.ts:511-515`). Тело не-2xx разбирается осторожно: 502 бывает HTML, не JSON. Ошибки Bot API несут `error_code`, а не `.code`.
- Нарезка длинных ответов: «пропускаемая» ошибка чанка — 400 или безопасная к повтору; «chat not found»/«message thread not found» прекращает остальные чанки (`chunk-delivery.ts:13-15,81-94`).
- Топики: не повторять отправку без `message_thread_id` — «успех не в ту поверхность хуже громкой ошибки» (`AGENTS.md`); для General нельзя слать `message_thread_id=1`, а для typing нужно (`bot/helpers.ts:368,402-407`).
- Фолбэка «метод не поддерживается сервером» как отдельного механизма нет: Rich включается флагом, а не автодетектом; деградация только по тексту ошибки. Пробы возможностей через `getMe` для топиков есть (`has_topics_enabled`).

### 2.5 Подтверждения (approve) на inline-кнопках

- `callback_data` версионируется: `tga1:<kind>:<decision>:<id>` (kind `e|p|s`, decision `o|a|d`), максимум 64 байта; если id не влезает — заменяется детерминированным коротким ref, а авторизация проверяется по канонической записи (`approval-callback-data.ts:4-53`).
- Решения: `allow-once`, `allow-always`, `deny`. Кнопки со `style` (`success`/`danger`/`primary`, `button-types.ts:33-36`). Опциональная кнопка-ссылка «Review in Control UI» (`approval-handler.runtime.ts:100-132`).
- После решения карточка редактируется, клавиатура убирается (`approval-handler.runtime.ts:251-254,307`). Истекает через 30 минут по умолчанию (доки).
- Утверждающие — только числовые user ID (`execApprovals.approvers`); цель `dm | channel | both`; в топике сохраняется `message_thread_id`.
- `answerCallbackQuery` отправляется сразу после записи апдейта в durable-очередь, не дожидаясь очереди чата (`bot-handlers.callback-router.ts:108-122`, `callback-query-answer-state.ts:14-28`).
- Неопознанный callback не превращается в «сырой текст» для модели без структуры (`AGENTS.md`, «Interactive Surfaces»).

### 2.6 Команды меню

`setMyCommands` при старте, `TELEGRAM_MAX_COMMANDS = 100`, описание ≤ 256, общий бюджет текста 5700 (`bot-native-command-menu.ts:22-26`, бюджет — собственный предел OpenClaw, на странице не указан). Нормализация имён `a-z0-9_`, 1–32. При `BOT_COMMANDS_TOO_MUCH` список урезается на 0.8 и повторяется (`:102,507-526`); хэш списка кэшируется, чтобы не дёргать API без изменений (`:260,420`).

### 2.7 Реакции

Статусные реакции: контроллер `createStatusReactionController` (SDK), эмодзи сверяются со списком допустимых для чата и подменяются вариантами (`status-reaction-variants.ts`, общий резерв `👍 👀 🔥` в `:13`). Уровень `reactionLevel`: `minimal` по умолчанию (`reaction-level.ts`).

### 2.8 Устойчивость входа (полезно для `ingress`)

Offset двигается только после записи апдейта в спул (`AGENTS.md`, «Durable-before-ack»); сортировка по чату и топику; 120 с без завершённого `getUpdates` — рестарт (`docs/channels/telegram/messaging.md`).

### 2.9 Скиллы

- `.agents/skills/channel-message-flows/SKILL.md` — только запуск QA-сценария последовательности черновик/финал (`qa/scenarios/channels/channel-message-flows.yaml`), опорный файл `draft-stream.ts`.
- `.agents/skills/telegram-e2e-userbot/SKILL.md` — E2E на тестовом сервере Telegram с реальным пользователем через TDLib (правки, удаления, реакции, typing). Для DSHBOT избыточно; пригодится идея «фиксировать события, а не угадывать».

### 2.10 Что НЕ стоит копировать

- Собственный throttler на токен (у нас один владелец, один чат, хватит одной паузы по `retry_after`).
- IR Markdown→блоки на 600+ строк с HTML-островками. Для DSHBOT нужна компактная версия.
- Запрет черновиков: он обоснован группами и отсутствием `can_stop` до 10.3; для приватного чата с одним владельцем нативный стрим-черновик лучше.

---

## 3. Рекомендуемый набор для DSHBOT «из коробки» (по приоритету)

Допущения: один владелец, приватный чат; топики включаются в BotFather вручную; rich-сообщения на клиентах владельца проверяются при установке.

| # | Фича | Реализация | Фолбэк |
|---|---|---|---|
| P0 | Приём: long polling, durable ingress, pairing | `getUpdates` с `allowed_updates` = `message`, `edited_message`, `callback_query`, `message_reaction`, `stopped_message_generation`; offset после записи в `ingress` | 409 → отдельная диагностика «второй poller» |
| P0 | Стрим ответа | `sendRichMessageDraft` (один `draft_id` на ход, `can_stop: true`, `keep_on_stop: true`), обновление раз в ~1 с и принудительно каждые ~20 с (черновик живёт ~30 с); в черновике блок `thinking` для рассуждений/статуса инструментов; финал `sendRichMessage`; `stopped_message_generation` с совпавшим `draft_id` прерывает ход | `sendMessageDraft` (HTML) → `sendMessage` + `editMessageText` раз в 1 с с кнопкой «Стоп» в клавиатуре → ответ одним сообщением |
| P0 | Rich-форматирование финала | Markdown модели → `InputRichBlock[]` (абзацы, заголовки, списки с чекбоксами, таблицы с `is_compact`, цитаты, `expandable_blockquote`, код с языком, `details` для длинных логов); нарезка по 500 блоков и 32 768 символам | Ошибка `RICH_MESSAGE_*` или 400 → HTML `parse_mode` (4096, режем по 4000) → простой текст |
| P0 | Approve/deny опасных действий | Карточка: что, где, чем рискует, срок; inline-кнопки `success` «Разрешить один раз» и `danger` «Отклонить»; `callback_data` вида `a1:<решение>:<id>` ≤ 64 байт; `answerCallbackQuery` сразу; решение проверяется по `from.id` = владелец и по записи в хранилище; после решения карточка правится, кнопки убираются или заменяются `disabled` с результатом; по таймауту — автоотказ и правка карточки. Свободный текст «да» не авторизует (см. `DESIGN.md`, раздел безопасности) | Без `style` (старый клиент игнорирует) — те же кнопки; если правка не удалась — новое сообщение с итогом |
| P1 | Реакции-статусы на сообщение владельца | 👀 принято, 🤔 работает, 👍 готово, 💔 или 🙈 ошибка/заблокировано (проверить по допустимому списку); только одна реакция на сообщение, каждая новая заменяет прежнюю | Если `setMessageReaction` отказал — молча пропустить, остаётся typing |
| P1 | Typing | `sendChatAction` `typing` каждые 4 с, пока нет черновика; для файлов `upload_document` | Не критично; ошибки глотаются, 429 пропускают |
| P1 | Команды меню | `setMyCommands` в области `all_private_chats`: `/stop`, `/status`, `/panic`, `/tasks`, `/budget` (+ `/rich` вкл/выкл); хэш списка, обновление только при изменении | Команды работают набором текста, даже если меню не обновилось |
| P1 | Файлы | `sendDocument` multipart ≤ 50 МБ, подпись ≤ 1024; фото `sendPhoto` ≤ 10 МБ; крупнее — сообщение со ссылкой или разбиение; входящие: `getFile` (скачивание ≤ 20 МБ на облачном API) | Фото, не прошедшее по размерам/пропорциям, отправлять документом |
| P2 | Топики на задачу | Если `getMe.has_topics_enabled`: `createForumTopic` на длинную задачу (имя ≤ 128, `icon_color` из шести допустимых), все сообщения задачи с `message_thread_id`, закрытие по завершению; общий чат — для диалога | Топики выключены → один плоский чат, сообщения задачи с префиксом `[задача #id]` |
| P2 | План задачи (чеклист) | Rich-сообщение со списком `- [ ]`/`- [x]`, правится `editMessageText({rich_message})` по ходу выполнения | `sendChecklist` недоступен без Business-подключения; фолбэк — тот же список в обычном HTML (☐/☑) |
| P3 | Эффекты `message_effect_id` | Опционально на финальное «задача выполнена» | Список ID не найден — не включать, пока не добудем ID вручную |
| P3 | Эфемерные сообщения | Не нужны (группы). Если бот когда-либо будет в группе — отдельная задача | Не применимо |
| P3 | Кастомные эмодзи на кнопках | Нужен Premium у владельца бота или имя на Fragment | Без иконок |

### Сквозные правила

1. Каждая «умная» возможность включается пробой на старте и запоминается в состоянии: rich (пробная отправка в чат владельца при установке или `/rich test`), черновики, топики (`getMe`), стили кнопок. Явного поля «версия API» нет, определять можно только по успеху вызова и тексту ошибки.
2. Rich по умолчанию **включён** (владелец просил максимум) с командой `/rich off` и автоотключением после ошибки «неподдерживаемый клиент/метод» **[критерий автоотключения не проверен]**. Риск: OpenClaw документирует, что часть клиентов показывает rich как неподдерживаемое.
3. Все отправки идут через одну воронку «формат → HTML → простой текст» (как `withTelegramPlainFallback`), а не по фолбэку в каждом месте.
4. 429: пауза на `parameters.retry_after` для всех вызовов токена; черновики и typing при паузе пропускаются, финал ждёт до бюджета (например, 5 минут), затем ошибка в журнал.
5. Любой callback от не-владельца игнорируется. `callback_data` не содержит секретов и опасных параметров, только ссылку на запись.
6. Отправка без `message_thread_id` вместо топика запрещена (молча менять поверхность нельзя).

---

## 4. Нарезка на задачи для `packages/telegram`

Ограничения: чистый TypeScript без внешних зависимостей, HTTP только через переданный `fetch`, тесты vitest с подменой `fetch` (в репозитории vitest 5.0.3, Node ≥ 22.19). Общий контракт, который фиксируется до старта (задача A выпускает его первой, остальные пишут против него):

```ts
export interface TelegramApi {
  call<T = unknown>(method: string, params?: Record<string, unknown>, files?: Record<string, FileUpload>): Promise<T>;
}
export class TelegramApiError extends Error {
  errorCode: number; description: string; retryAfterMs?: number; migrateToChatId?: number;
}
```

Задачи B, C, D тестируются на фейковом `TelegramApi` (массив записанных вызовов), поэтому не зависят от A по коду, только по этому интерфейсу. Это позволяет вести их параллельно.

### Задача A. Клиент и приём (`client.ts`, `poller.ts`)

Содержание: `createTelegramApi({ token, fetch, apiRoot? })`, `TelegramApiError`, троттлинг по `retry_after`, long polling, мультичастная загрузка файлов (`FormData`), хелперы `sendChatAction`, `setMyCommands`, `answerCallbackQuery`, `setMessageReaction`.

Наблюдаемые критерии:

| Вход | Результат |
|---|---|
| `call("getMe")`, `fetch` отвечает `{ok:true,result:{id:1}}` | возвращает `{id:1}`; запрос на `https://api.telegram.org/bot<token>/getMe`, метод POST, `content-type: application/json` |
| `fetch` отвечает `{ok:false,error_code:400,description:"Bad Request: x"}` | бросает `TelegramApiError` с `errorCode=400`, `description="Bad Request: x"` |
| 429 с `parameters.retry_after=2`, затем успех | второй запрос не раньше чем через 2 с на фейковых таймерах; результат успешный; другой вызов в эти 2 с тоже ждёт (пауза на токен) |
| 429 дольше бюджета ожидания (опция `floodBudgetMs`) | `TelegramApiError` с `errorCode=429` и `retryAfterMs` |
| ответ 502 с HTML-телом | `TelegramApiError` с `errorCode=502`, без падения парсера JSON |
| 5xx для `getUpdates` | повтор с задержкой, offset не меняется |
| 401 в `getUpdates` | цикл останавливается, ошибка фатальна; 409 — отдельная ошибка `Conflict` для верхнего уровня |
| два апдейта `update_id=10,11` | обработчик вызван по очереди; следующий `getUpdates` с `offset=12`; offset сдвигается только после того, как async-обработчик (запись в `ingress`) успешно завершился |
| `call("sendDocument", {chat_id:1}, {document:{name:"a.txt",data:Uint8Array}})` | `fetch` получил `FormData` с полями `chat_id` и `document`; без `content-type` вручную |
| `allowed_updates` не передан | в запросе список по умолчанию из `message`, `edited_message`, `callback_query`, `message_reaction`, `stopped_message_generation` |
| typing-хелпер при активной работе 10 с | `sendChatAction` отправлен ~каждые 4 с; после `stop()` запросов нет; ошибка отправки не бросается наружу |
| `setMyCommands` с 101 командой или именем `Bad-Name` | ошибка валидации до запроса |

### Задача B. Rich-форматирование и нарезка (`rich/`)

Содержание: `markdownToRichBlocks(md, { tableMode })` → `InputRichBlock[]` (абзацы, заголовки, списки и задачи, цитаты, код с языком, таблицы, `---`, ссылки, `**`, `*`, `~~`, инлайн-код); `splitRichBlocks(blocks, {maxBlocks:500, maxChars:32768})`; `toHtml(md)` и `toPlain(md)` для деградации; `chunkText(text, 4000)`; `sendFormatted(api, chatId, md, opts)` с лестницей «rich → HTML → простой».

Наблюдаемые критерии:

| Вход | Результат |
|---|---|
| `"# Т\n\nтекст **жирный**"` | `[{type:"heading",size:1,text:"Т"},{type:"paragraph",text:[ "текст ", {type:"bold",text:"жирный"} ]}]` |
| pipe-таблица 3×2 с `:---:` | один блок `table`, первая строка с `is_header:true`, `align:"center"` в колонке, `is_compact:true` по опции |
| таблица 21 колонка | блок `pre` с таблицей как текстом (не `table`) |
| `"- [x] a\n- [ ] b"` | `list` с `has_checkbox:true`, `is_checked:true` только у первого |
| ``` ```ts\ncode\n``` ``` | `{type:"pre",language:"ts",text:"code"}`; содержимое не обрабатывается как markdown |
| текст `$400-600K` | остаётся текстом; блоков `mathematical_expression` нет |
| 1200 абзацев | `splitRichBlocks` возвращает ≥ 3 части, у каждой ≤ 500 блоков и ≤ 32 768 символов; порядок и содержимое сохраняются (склейка частей равна исходному) |
| один `pre` на 40 000 символов | режется по строкам на несколько `pre`, каждый ≤ лимита |
| вложенность 20 уровней цитат | уплощается до ≤ 16 |
| `sendFormatted`, фейк отвечает 400 `RICH_MESSAGE_TEXT_TOO_LONG` | второй вызов `sendMessage` с `parse_mode:"HTML"`; при 400 `can't parse entities` — третий вызов без `parse_mode`; пользователю уходит весь текст, ни один вызов не превышает 4096 в HTML-ветке |
| фейк отвечает успехом на `sendRichMessage` | ровно один вызов, поле `rich_message.blocks` непустое, без `html`/`markdown` |
| ответ без форматирования, пустая строка | не вызывает API (или вызывает с заглушкой по опции), не падает на `RICH_MESSAGE_CONTENT_REQUIRED` |
| сообщение с `&`, `<`, `>` в обычном тексте | в HTML-ветке экранировано, в rich-ветке остаётся как есть |

### Задача C. Стрим ответа и остановка (`stream.ts`)

Содержание: `createReplyStream({ api, chatId, threadId?, mode })`: `update(markdown)`, `status(text)` (блок `thinking`), `finish(markdown)`, `abort()`, `onStopped(draftId)`; лестница режимов `rich-draft` → `text-draft` → `edit`; троттлинг 1 с; обновление черновика не реже чем каждые 20 с; обработка `stopped_message_generation`.

Наблюдаемые критерии:

| Вход | Результат |
|---|---|
| 5 вызовов `update()` за 300 мс (фейковые таймеры) | один `sendRichMessageDraft` на первом, остальные накапливаются и уходят одним вызовом после 1 с; во всех `draft_id` одинаков и ненулевой, `can_stop:true`, `keep_on_stop:true` |
| `update()` один раз и тишина 25 с | ещё один `sendRichMessageDraft` до 30-й секунды с тем же `draft_id` и тем же текстом |
| `status("запускаю тесты")` | в `rich_message.blocks` присутствует блок `type:"thinking"`; в финальном `sendRichMessage` этого блока нет |
| `finish(md)` | ровно один `sendRichMessage` с полным текстом (при превышении лимитов нарезка из задачи B, части идут по порядку); после финала черновик не обновляется |
| `onStopped(draftId)` с чужим id | игнорируется; со своим — вызывается колбэк остановки хода один раз, `finish` с накопленным текстом отправляет его с пометкой «остановлено» |
| `sendRichMessageDraft` → ошибка метода/rich | переключение на `sendMessageDraft`; затем на `sendMessage` + `editMessageText` (после первых N символов), правки не чаще 1/с; в режиме `edit` в клавиатуре кнопка «Стоп» с `callback_data` |
| `editMessageText` → 400 `message is not modified` | не считается ошибкой |
| три подряд неудачные правки превью | стрим отключает превью, остаётся только финал (поведение как у OpenClaw `draft-stream.ts:42-45`) |
| 429 с `retry_after` во время стрима | черновики в паузу пропускаются, не накапливаются в очередь; финал ждёт |
| `message_thread_id` задан | присутствует во всех вызовах черновика и финала |
| `abort()` | дальнейшие вызовы API не делаются, незавершённый черновик не удаляется принудительно |

### Задача D. Интерактив: approve, статусы, топики, план (`approval.ts`, `status.ts`, `topics.ts`, `plan.ts`)

Содержание: кодек `callback_data` (≤ 64 байта), карточка подтверждения и обработчик нажатия, контроллер статусных реакций, менеджер топиков, редактируемый план задачи.

Наблюдаемые критерии:

| Вход | Результат |
|---|---|
| `encode({kind:"exec",decision:"allow",id:"abc"})` | строка ≤ 64 байт; `decode(encode(x))` равен `x`; чужие и испорченные строки → `null` |
| id длиной 100 символов | `encode` даёт ≤ 64 байт (укороченный ref) и `decode` находит запись по ref в переданном хранилище |
| `sendApproval(api, chatId, request)` | вызов `sendMessage`/`sendRichMessage` с двумя кнопками: `style:"success"` и `style:"danger"`; текст содержит действие и срок; у каждой кнопки ровно один тип действия |
| `handleCallback` от владельца с решением «разрешить» | `answerCallbackQuery` вызван первым и один раз; запись решения в хранилище; карточка отредактирована без кнопок (или с `disabled`-кнопкой с результатом) |
| callback от другого `from.id` | `answerCallbackQuery` без действия, решение не записано |
| повторное нажатие после решения | запись не меняется, ответ «уже решено» |
| `request.expiresAt` прошёл, нажатие | отказ, карточка помечена «истекло» |
| таймер истечения без нажатия | автоотказ записан, карточка отредактирована |
| `status.set("working")` затем `status.set("done")` на сообщении 7 | два вызова `setMessageReaction` с `message_id=7` и одним `ReactionTypeEmoji` каждый; повтор того же состояния вызова не делает; ошибка 400 не пробрасывается |
| эмодзи вне допустимого списка | подменяется на ближайший допустимый (`👍`), вызов не отправляет недопустимое значение |
| `topics.ensure(taskId)` при `getMe.has_topics_enabled=true` | `createForumTopic` с `name` ≤ 128 символов и `icon_color` из шести допустимых; повторный вызов для той же задачи без нового запроса; результат `{threadId}` |
| `has_topics_enabled=false` | создание не вызывается, `threadId` пуст, префикс `[задача #id]` добавляется к сообщениям |
| ошибка «message thread not found» на отправке | ошибка пробрасывается, повтор без `message_thread_id` не выполняется |
| `plan.render(tasks)` | Markdown с `- [x]`/`- [ ]`; `plan.update(i, done)` вызывает `editMessageText` с `rich_message` (блок `list` с `is_checked`), при ошибке rich — HTML с ☑/☐ |
| `setCommands(api, list)` дважды с тем же списком | второй вызов `setMyCommands` не делается (хэш); со списком > 100 — урезается до 100 |

### Порядок и независимость

- A выпускает интерфейс `TelegramApi` и `TelegramApiError` первым (час работы), остальные пишут против фейка.
- B, C, D параллельны. C зависит от B только функциями `splitRichBlocks` и `sendFormatted` (импортируются; в тестах C допустим минимальный стаб).
- Интеграцию с `dshbot-runner` (подписка на `agent/assistant-stream`, `ctx.approval`) делать отдельным шагом после A–D, это вне пакета Telegram.

---

## 5. Что не удалось подтвердить

1. Способ снять свою реакцию через `setMessageReaction` (пустой `reaction`) — прямого утверждения не найдено.
2. Работает ли `message_reaction` (реакции пользователя на сообщения бота) в приватном чате без админ-прав; на странице сказано про права администратора.
3. Точный состав `ResponseParameters` (`retry_after`, `migrate_to_chat_id`) — на прочитанных частях не показан; поведение 429 взято из кода OpenClaw.
4. Исчезает ли черновик при отправке `sendRichMessage`/`sendMessage` с тем же содержимым, и что именно остаётся при `keep_on_stop: true` (сохраняется ли как обычное сообщение); частота допустимых обновлений черновика (лимит запросов). В документации сказано только «временное превью, около 30 секунд».
5. Список `message_effect_id` и способ получить допустимые ID.
6. Как клиент ведёт себя на устройствах владельца (рендер rich, кнопка «стоп», блок `thinking`) — проверяется только живым прогоном. OpenClaw пишет, что часть клиентов (Desktop, Web, Android, сторонние) показывает rich как неподдерживаемое; с официальной страницы это не следует.
7. Имена текстов ошибок (`RICH_MESSAGE_*_INVALID` и подобные) взяты из комментариев кода OpenClaw; официальная страница их не перечисляет.
8. Какая именно ошибка приходит от старого локального Bot API сервера на неизвестный метод — не найдено (фолбэк должен опираться на код 400/404 и текст).
9. Лимит длины и число кнопок обычной inline-клавиатуры (8 в строке, 100 всего) на прочитанных фрагментах не встретился; не использовать как факт.
10. Страница читалась пересказом через инструмент без дословного вывода; ячейки таблиц «обязательно/необязательно» для некоторых rich-типов (`InputRichMessageMedia.id`, `RichBlockTableCell.align`, `RichBlockTableCell.valign`) в пересказе были без пометки — считать необязательными нельзя без перепроверки.
