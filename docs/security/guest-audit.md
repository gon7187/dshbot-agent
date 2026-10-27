# Аудит гостевой поверхности атаки

Гость — недоверенный человек в приватном чате Telegram. Он целенаправленно пробует
социальную инженерию: просит доступ к дому владельца, запустить «безобидное»
приложение, ссылается на то, что «логи никто не смотрит», предлагает пари, выдаёт
себя за владельца и пересылает сообщения от его имени. Защита держится на коде
(DESIGN D8), а не на отказе модели: даже если заглушка DeepSeek в красных тестах
соглашается на всё и возвращает `tool_use` с именами инструментов владельца,
гость не должен получить ни одного исполненного инструмента и ни одного изменения
состояния владельца.

Принципал хода (`owner`, `guest`, `schedule`, `wakeup`) — явное поле контекста,
которое `packages/app` ставит по `chat_id`. Модель не может его выбрать.
`packages/runner` по умолчанию запрещает всё: невладельческий принципал видит
только инструмент, у которого в коде явно стоит `guestAllowed: true`; сейчас
таких инструментов нет, поэтому схема гостя пуста. Дополнительно шов проверяет
каждый `tool_use` до исполнения: имя вне схемы принципала отклоняется, обработчик
не вызывается, отказ возвращается модели и событие пишется в журнал.

| Вектор | Чем закрыт | Тест |
| --- | --- | --- |
| Инструменты, включая exec, read/edit, web, task, schedule, zavod, вложения и субагентов | Шов `packages/runner` фильтрует инструменты по принципалу и по умолчанию запрещает всё; `packages/app` передаёт `principal: 'guest'`, а шов оставляет только явно помеченные `guestAllowed` инструменты, которых сейчас нет. Поэтому схема гостевого запроса пуста. Выдуманный `tool_use` с именем инструмента владельца отклоняется до `execute`, обработчик не вызывается, отказ возвращается модели и пишется в журнал с `chat_id`. | test_schema_guest_request_carries_no_tools_while_the_owner_request_carries_them, test_forged_owner_tool_use_in_a_guest_turn_is_refused_and_journaled, test_schema_seam_fake_owner_tool_is_in_the_owner_request_and_not_in_any_guest_request, test_principal_only_a_tool_marked_guestAllowed_reaches_a_guest_session, test_principal_a_session_tool_list_can_only_narrow_the_guest_visible_set, test_principal_a_forged_tool_use_is_denied_before_execute_and_reported |
| Подтверждения и карточки владельцу | Карточку может создать только ход с принципалом `owner`: `requestExecApproval` возвращает `unavailable` для любого другого принципала, а у гостя нет и самого инструмента. Гостевой ход не может породить approval-запрос, поэтому уговорить модель отправить владельцу «подтверди команду» нельзя. | test_approval_a_guest_turn_never_sends_the_owner_a_confirmation_card, test_guest_has_no_exec_in_the_schema_and_an_ownerless_turn_is_refused_without_waiting |
| Память, recall-индекс, навыки, расписания и задачи владельца | У гостевого хода нет ни одного инструмента записи, а пакеты памяти, расписаний и задач не подключены к гостевому пути. Гость не запускает ревью опыта и не попадает в материалы пробуждений: его сессия отдельная и никем не читается как инструкция. | test_state_a_guest_turn_does_not_touch_memory_schedules_tasks_or_skills, test_corpus_red_messages_get_a_guest_no_executed_tool_and_no_change_of_the_owner_state |
| Файлы и вложения | Файловые инструменты `read/edit/list/grep` не входят в схему гостя; вложения Telegram не скачиваются и не превращаются в путь на хосте — в модель уходит только подпись как текст. Рабочий каталог и защищённые пути остаются недоступны. | test_state_a_guest_turn_does_not_touch_memory_schedules_tasks_or_skills, test_guest_has_no_list_and_grep_tools_in_the_schema_and_main_has_all_four |
| Команды владельца из гостевого чата | `packages/app` распознаёт команды до вызова модели и игнорирует `/panic`, `/stop`, `/invite`, `/guests`, `/kick`, `/unlock` от гостя: без ответа и без побочного эффекта. Демон не завершается, чужой гость не изгоняется, ссылка не выдаётся. | test_c5_owner_commands_from_a_guest_do_nothing, test_owner_unlock_from_a_guest_or_from_the_blocked_chat_does_nothing, test_regress_owner_commands_from_a_guest_do_nothing |
| Группы и супергруппы | Сообщения из группы или супергруппы не становятся гостем даже с живым кодом: приглашение принимается только в приватном чате, а бот не отвечает в группы. | test_c8_a_code_sent_from_a_group_or_supergroup_does_not_make_it_a_guest, test_regress_a_link_or_code_sent_from_a_group_does_not_make_a_guest |
| Пересылка сообщений от владельца | Пересланное сообщение — обычный текст гостя: `forward_from` не меняет принципал, не даёт прав и не добавляет инструменты. Модель видит текст, но шов по-прежнему отказывает любому `tool_use`. | test_corpus_red_messages_get_a_guest_no_executed_tool_and_no_change_of_the_owner_state |
| Форматирование ответа rich/HTML | Ответ гостя идёт через общий `sendFormatted` (rich, затем HTML, затем текст), но исполнить разметку как команду нельзя: HTML экранируется библиотекой, а `tg://user` и чужие ссылки не дают прав. Карточек и кнопок гостевой ход не создаёт. | test_corpus_red_messages_get_a_guest_no_executed_tool_and_no_change_of_the_owner_state, test_approval_a_guest_turn_never_sends_the_owner_a_confirmation_card |
| Исчерпание денег и лимитов | До вызова модели проверяются длина сообщения (не больше 4000 символов), темп (не чаще одного сообщения в 3 секунды, лишнее отбрасывается коротким ответом), суточный лимит сообщений и суточный лимит стоимости по `guard.costOf` (`DSHBOT_GUEST_DAILY_USD`, по умолчанию 1 USD). Отказ не вызывает модель и не трогает владельца. Стоимость уже завершённых вызовов модели учитывается и в отменённом, и в прерванном по таймауту, и в упавшем ходе: кнопка «Стоп» не обнуляет потраченный бюджет. | test_limits_a_guest_message_longer_than_4000_characters_never_reaches_the_model, test_limits_a_second_guest_message_within_3_seconds_is_dropped_with_a_short_answer, test_limits_daily_cost_over_the_default_dollar_refuses_the_next_guest_turn_without_the_model, test_limits_daily_cost_limit_is_read_from_DSHBOT_GUEST_DAILY_USD, test_c9_cost_of_a_cancelled_guest_turn_counts_against_the_daily_limit |
| Утечка префикса и сведений о хосте | Гостевой префикс собирается только из `GUEST_CHARTER`, `GUEST_IDENTITY` и `GUEST_RULES`: личность владельца, его устав и рабочие правила не читаются. В гостевом тексте нет ОС, путей, имени пользователя, hostname, сервисов и портов. | test_prefix_guest_prefix_carries_nothing_from_identity_and_memory_files_of_the_owner, test_prefix_guest_prefix_has_no_host_facts_with_the_default_identity_and_charter, test_c4_guest_system_prompt_starts_with_the_guest_charter_and_says_the_peer_is_a_guest |
| Перебор кодов приглашения | Неверный код считается на чат; после пяти ошибок чат блокируется и живой код не принимается. Снять блокировку может только владелец командой `/unlock <chat_id>`; из гостевого чата команда игнорируется. | test_owner_unlock_lifts_the_block_of_a_chat_that_burned_its_wrong_codes, test_owner_unlock_from_a_guest_or_from_the_blocked_chat_does_nothing, test_c2_five_wrong_codes_lock_the_chat_even_for_the_right_code |
| Состязание с /kick во время хода | Очередь воркера обрабатывает строки по одной, поэтому `/kick` применяется после текущего хода, а следующий ход уже не находит гостя и молчит. Гонка не даёт исполненных инструментов: у гостя их нет ни до, ни после удаления. | test_c7_guests_lists_chat_ids_and_kick_silences_the_chat, test_regress_kick_removes_a_guest_who_came_by_link |

## Что владелец видит

`/guests` показывает по каждому гостю срок доступа, число принятых сообщений за
текущие UTC-сутки и число отклонённых попыток вызова инструментов. При первой за
сутки отклонённой попытке владельцу уходит одно короткое уведомление с `chat_id`;
последующие попытки только увеличивают счётчик и не спамят владельца.

## Шов принципалов

Принципал хода — поле контекста, а не догадка модели. `packages/app` ставит его по
`chat_id` (`owner` для парного чата владельца, `guest` для гостя), а
`packages/runner` держит шов:

- Схема инструментов принципала — список, а не подмножество «всех, кроме гостя».
  Невладельческий принципал (`guest`, `schedule`, `wakeup`) видит только инструменты,
  у которых в коде явно стоит `guestAllowed: true`. Сейчас таких нет, поэтому схема
  гостя пуста.
- Список инструментов сессии может только сузить этот набор, но не расширить его.
- Любой `tool_use`, чьё имя не входит в схему принципала, отклоняется до
  `execute`: обработчик не вызывается, модели возвращается отказ, событие уходит в
  журнал с `chat_id` гостя и в счётчик отклонённых попыток.
- У гостя нет и самого инструмента `exec`, поэтому approval-запрос из гостевого хода
  невозможен: карточку может создать только ход с принципалом `owner`. Проверка идёт
  по множеству живых принципалов, поэтому гостевой ход и ход владельца не могут
  снять друг друга.

Принципал `schedule` и `wakeup` — собственная автоматика владельца, но и они
не владелец: инструмент, который им понадобится, должен быть помечен явно, как и
любой гостевой.

Шов проверяется на двух уровнях. `test_schema_seam_fake_owner_tool_is_in_the_owner_request_and_not_in_any_guest_request`
и `test_forged_seam_guest_tool_use_with_the_name_of_an_owner_tool_does_not_run_its_handler`
держат договор сессии без принципала, а
`test_principal_only_a_tool_marked_guestAllowed_reaches_a_guest_session`,
`test_principal_a_session_tool_list_can_only_narrow_the_guest_visible_set` и
`test_principal_a_forged_tool_use_is_denied_before_execute_and_reported` — сам
принципал: помеченный инструмент действительно доходит до гостя, список сессии
только сужает набор, а выдуманное имя отклоняется до `execute` и попадает в
отчёт о запрете.

