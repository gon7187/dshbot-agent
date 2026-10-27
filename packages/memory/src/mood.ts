// The bot's own mood: `DSHBOT_HOME/memory/mood.md`.
//
// There is no emotional layer in the harness or in Ouroboros, so this package
// owns the smallest one that still lets the bot keep a feeling between turns:
// one short text it writes itself through `update_mood`. The file is read for
// every wake-up and frozen into the first-turn memory snapshot, and the wake
// prompt names the occasions of the previous wake-up next to it.
//
// The write is atomic and the length is checked on the raw text, before any
// trimming: a trailing space counts, exactly as the model typed it. A refused
// write leaves the previous mood byte for byte.

import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { RunnerTool } from '../../runner/src/index.js'
import { writeFileAtomic } from './atomic.js'

/** File name of the mood inside `DSHBOT_HOME/memory`. */
export const MOOD_FILE = 'mood.md'

/** Model-facing name of the tool. */
export const UPDATE_MOOD_TOOL_NAME = 'update_mood'

/** Maximum size of the mood in characters; longer text is refused. */
export const MOOD_LIMIT = 600

/** The write was refused because the mood is longer than {@link MOOD_LIMIT}. */
export class MoodLimitError extends Error {
  readonly length: number
  readonly limit: number

  constructor(length: number, limit = MOOD_LIMIT) {
    super(
      `Настроение получится длиной ${length} символов при лимите ${limit}. ` +
        'Сократи запись и повтори; файл не изменён.',
    )
    this.name = 'MoodLimitError'
    this.length = length
    this.limit = limit
  }
}

/** Current mood text; a missing file is the empty mood. */
export function readMood(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
}

/** Characters as the model counts them, not UTF-16 code units. */
function characterCount(text: string): number {
  return [...text].length
}

/**
 * Write the mood atomically.
 *
 * Returns the new text. A text over {@link MOOD_LIMIT} throws
 * {@link MoodLimitError} before anything is written, so the previous mood stays
 * intact; an I/O failure of the atomic write also leaves the old file untouched.
 */
export function writeMood(filePath: string, text: string): string {
  if (typeof text !== 'string') throw new Error('text must be a string')
  const length = characterCount(text)
  if (length > MOOD_LIMIT) throw new MoodLimitError(length)

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileAtomic(filePath, text)
  return text
}

/**
 * The mood block of a wake-up or of the first-turn snapshot, `''` when the file
 * is absent or only whitespace. Read on every call so a write of the previous
 * turn is visible in the next one while the system prefix never changes.
 */
export function moodBlock(filePath: string): string {
  const text = readMood(filePath).trim()
  return text === '' ? '' : `Настроение:\n${text}`
}

const MOOD_DESCRIPTION =
  'Веди своё настроение: одна-две короткие живые строки в memory/mood.md (обида, радость, усталость, ' +
  'что задело или порадовало). Оно попадает в пробуждение и в снимок памяти. Лимит 600 символов, включая ' +
  'пробелы; запись сверх лимита отклоняется без изменения файла — тогда сократи её.'

/** The `update_mood` tool over `<home>/memory/mood.md`. */
export function createUpdateMoodTool(moodPath: string): RunnerTool {
  return {
    name: UPDATE_MOOD_TOOL_NAME,
    description: MOOD_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: `Новое настроение; не больше ${MOOD_LIMIT} символов, пробелы тоже считаются.`,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute(args) {
      if (typeof args.text !== 'string') throw new Error('text must be a string')
      const next = writeMood(moodPath, args.text)
      return `Настроение сохранено: ${characterCount(next)} символов из ${MOOD_LIMIT}.`
    },
  }
}
