// Prompts of the background experience review.
//
// Translated and adapted from Hermes Agent `agent/background_review.py`
// (catalogued in docs/research/prompts.md §7.1-7.4): the lesson shape, the
// "do not capture" block, the preference order and read-before-write keep the
// incidents that produced them, but the names and storage are DSHBOT's.
// The prompt goes into the review request only; it never becomes part of the
// stable prefix.

export interface ReviewContext {
  /** Last owner message of the turn that triggered the review. */
  userText: string
  /** Answer that was already delivered to the owner. */
  reply: string
  /** Current compact index, so the review sees what exists without a list call. */
  skillsIndex?: string
}

/** Stable first line of the review prompt; useful in logs. */
export const REVIEW_PROMPT_HEAD = 'Ты — фоновое ревью опыта DSHBOT.'

const LESSON_LAYER_BLOCK = `## Что такое навык

Навык — инструкция для класса задач по меркам владельца: процедура, инструменты и команды, их порядок, предпочтения к результату и ловушки.
- Сначала процедура: упорядоченные шаги, конкретные команды, вызовы и точки решений; уроки и ловушки привяжи к шагам.
- Ловушка — общее правило в повелительной форме и одна фраза о механизме, не история сессии. Не включай номера задач и PR, даты и цитаты владельца.
- Перед добавлением поищи урок в навыке и файлах поддержки: уточни или усиль вместо дубля. Ошибку исправь на месте, не дописывай UPDATE.`

const DO_NOT_CAPTURE_BLOCK = `## Чего НЕ сохранять

- Отказы окружения (отсутствующие бинарники, пакеты, учётки, ошибки установки и путей) и отрицательные утверждения о возможностях инструментов: окружение можно починить.
- Временные ошибки, решённые в сессии; если помог повтор, сохраняй шаблон повтора, а не сбой.
- Пересказ одной задачи и нерешённые неудачи: попытки без рабочего способа и с предложением ручной проверки — не надёжный процесс.
- При сбое из-за установки сохраняй исправление (установку, конфигурацию, переменную окружения) в существующем навыке установки или диагностики, а не утверждение о поломке инструмента.`

const PREFERENCE_ORDER_BLOCK = `## Порядок действий

Выбери первое подходящее действие:
1. Обнови загруженный или относящийся к классу задачи навык.
2. Обнови существующий зонтичный навык: сначала skills_list, затем skill_view.
3. Добавь файл поддержки под существующий зонтик.
4. Создай навык уровня класса, если класс не покрыт; имя — класс задач, не текущий случай.

Достаточные сигналы: поправка владельца к стилю, тону, формату, подробности, порядку или подходу; просьба «запомни»; повторная ошибка с понятным механизмом; рабочий приём, экономящий время.

Read-before-write проверяется кодом: перед patch, write_file или remove_file существующего навыка вызови skill_view(name) в ЭТОМ ревью. При ошибке read-before-write вызови skill_view и повтори запись по одному разу, без цикла. Никогда не удаляй навык.`

const MEMORY_BLOCK = `## Память

Выбери одно хранилище на факт, никогда не оба:
- target="user" (USER.md): личность владельца, предпочтения, стиль общения и работы, личные детали и ожидания.
- target="memory" (MEMORY.md): факты о среде — инструменты, соглашения проекта, конфигурация, важные пути и адреса.

Записи декларативные, не инструкции. Процедуры и ловушки класса задач — в навык, не в память. Память вставляется в каждый ход: держи её маленькой; при переполнении одним пакетом можно удалить устаревшее и добавить новое.
Не сохраняй очевидное, легко переоткрываемое, сырые дампы, прогресс задачи, журнал действий и временный TODO.`

/** Builds the one user message of the review. */
export function buildExperienceReviewPrompt(context: ReviewContext): string {
  const parts: string[] = [
    REVIEW_PROMPT_HEAD,
    '',
    'Разбери последний ход и обнови навыки или память, если оправдано. Будь активен: большинство сессий дают обновление, но «Nothing to save.» — честный ответ, если сохранять нечего.',
    '',
    LESSON_LAYER_BLOCK,
    '',
    DO_NOT_CAPTURE_BLOCK,
    '',
    PREFERENCE_ORDER_BLOCK,
    '',
    MEMORY_BLOCK,
    '',
    '## Как закончить',
    '',
    'Лимит — 16 итераций инструментов. В конце ответь коротким текстом: что обновил или почему ничего не сохранено. Если сохранять нечего, ответь ровно «Nothing to save.».',
    '',
    '## Материал для разбора',
    '',
    'Последнее сообщение владельца:',
    '<<<',
    context.userText,
    '>>>',
    '',
    'Доставленный ответ:',
    '<<<',
    context.reply,
    '>>>',
  ]
  if (context.skillsIndex !== undefined && context.skillsIndex.trim() !== '') {
    parts.push('', 'Текущий индекс навыков:', context.skillsIndex)
  }
  return parts.join('\n')
}
