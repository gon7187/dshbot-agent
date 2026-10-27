// Working notes of the bot between turns: `DSHBOT_HOME/scratchpad.md`.
//
// Unlike the identity, the scratchpad is volatile: it is read again before
// every owner and wake-up turn, but the block rides in the tail only when the
// text changed since the last delivered turn (and on the first turn of a
// session, after `/new` and after a compaction). It never enters the stable
// system prefix. `update_scratchpad` replaces the file or appends to it,
// refuses a result over the size limit without touching the old file, and
// always writes through `writeFileAtomic`, so a failed write keeps the previous
// notes.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { RunnerTool } from '../../runner/src/index.js'
import { writeFileAtomic } from './atomic.js'

/** File name of the scratchpad inside `DSHBOT_HOME`. */
export const SCRATCHPAD_FILE = 'scratchpad.md'

/** Model-facing name of the tool. */
export const UPDATE_SCRATCHPAD_TOOL_NAME = 'update_scratchpad'

/** Maximum size of the file in characters; a write that would cross it is refused. */
export const SCRATCHPAD_LIMIT = 3_000

export type ScratchpadMode = 'replace' | 'append'

/** The write was refused because the resulting scratchpad would be too long. */
export class ScratchpadLimitError extends Error {
  readonly length: number
  readonly limit: number

  constructor(length: number, limit = SCRATCHPAD_LIMIT) {
    super(
      `Блокнот получится длиной ${length} символов при лимите ${limit}. ` +
        'Сожми заметки (сократи или уплотни) и повтори запись; файл не изменён.',
    )
    this.name = 'ScratchpadLimitError'
    this.length = length
    this.limit = limit
  }
}

/** Current scratchpad text; a missing file is the empty scratchpad. */
export function readScratchpad(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
}

/** Count characters as the model does, not UTF-16 code units. */
function characterCount(text: string): number {
  return [...text].length
}

/** The text a write leaves in the file, without writing it. */
export function composeScratchpad(current: string, mode: ScratchpadMode, text: string): string {
  if (mode === 'replace') return text
  if (current === '') return text
  return current.endsWith('\n') ? current + text : `${current}\n${text}`
}

/**
 * Write the scratchpad atomically.
 *
 * Returns the new text. A text over {@link SCRATCHPAD_LIMIT} throws
 * {@link ScratchpadLimitError} before anything is written, so the previous
 * notes stay intact; an I/O failure of the atomic write rethrows the original
 * error and leaves the old file untouched as well.
 */
export function writeScratchpad(filePath: string, mode: ScratchpadMode, text: string): string {
  if (mode !== 'replace' && mode !== 'append') {
    throw new Error("mode must be 'replace' or 'append'")
  }
  if (typeof text !== 'string') throw new Error('text must be a string')

  const current = readScratchpad(filePath)
  const next = composeScratchpad(current, mode, text)
  const length = characterCount(next)
  if (length > SCRATCHPAD_LIMIT) throw new ScratchpadLimitError(length)

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileAtomic(filePath, next)
  return next
}

/**
 * The volatile scratchpad block of a turn: its current text plus a hash of that
 * text. Equal hashes mean the notes did not change between two turns, so the
 * caller can skip the block and keep the session history short. A missing or
 * blank file is the empty state: no block, and it is stable against a missing
 * file as well.
 */
export interface ScratchpadState {
  /** SHA-256 of the trimmed text; the same bytes give the same hash. */
  hash: string
  /** Ready-to-send block, `''` when there is nothing to show. */
  block: string
}

/** Current state of the scratchpad: the text to send and the identity of that text. */
export function scratchpadState(filePath: string): ScratchpadState {
  const text = readScratchpad(filePath).trim()
  const hash = createHash('sha256').update(text).digest('hex')
  return { hash, block: text === '' ? '' : `Блокнот (scratchpad.md), рабочие заметки между ходами:\n${text}` }
}

/**
 * The volatile scratchpad block of a turn: the current notes, or `''` when the
 * file is absent or blank. It is read on every call so a write made in the
 * previous turn is visible in the next one, while the system prefix never
 * changes. Callers that skip an unchanged block use {@link scratchpadState}.
 */
export function scratchpadBlock(filePath: string): string {
  return scratchpadState(filePath).block
}

const SCRATCHPAD_DESCRIPTION =
  'Рабочие заметки бота между ходами (scratchpad.md в DSHBOT_HOME). Они переживают рестарт и сжатие контекста и ' +
  'попадают в ход владельца или пробуждения, когда текст изменился с прошлого раза, а также в первом ходе сессии. ' +
  'mode=replace заменяет блокнот целиком, mode=append ' +
  'дописывает текст в конец. Обновляй блокнот после существенного шага, а не по таймеру: текущее дело, гипотезу, ' +
  'обещание. Не дублируй журнал и историю переписки: здесь только короткие рабочие заметки. Лимит 3000 символов; ' +
  'запись сверх лимита отклоняется без изменения файла, тогда сократи или уплотни заметки.'

/** The `update_scratchpad` tool over `<home>/scratchpad.md`. */
export function createUpdateScratchpadTool(scratchpadPath: string): RunnerTool {
  return {
    name: UPDATE_SCRATCHPAD_TOOL_NAME,
    description: SCRATCHPAD_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'replace — заменить блокнот целиком, append — дописать текст в конец.',
        },
        text: {
          type: 'string',
          description: `Текст заметки; итоговый размер блокнота не больше ${SCRATCHPAD_LIMIT} символов.`,
        },
      },
      required: ['mode', 'text'],
      additionalProperties: false,
    },
    execute(args) {
      const mode = args.mode
      if (mode !== 'replace' && mode !== 'append') throw new Error("mode must be 'replace' or 'append'")
      if (typeof args.text !== 'string') throw new Error('text must be a string')
      const next = writeScratchpad(scratchpadPath, mode, args.text)
      const verb = mode === 'replace' ? 'заменён' : 'дополнен'
      return `Блокнот ${verb}: ${characterCount(next)} символов из ${SCRATCHPAD_LIMIT}.`
    },
  }
}
