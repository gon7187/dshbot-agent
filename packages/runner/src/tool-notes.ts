// Notes about the rakes of tools: `<DSHBOT_HOME>/tool-notes.json`.
//
// A call that failed in an owner turn and the same tool that later passed in
// the same turn with other arguments is a failed-and-fixed pair: the arguments,
// not a temporary failure, were the problem. The note keeps the tool, the first
// line of the error and what was changed, so the model can send the working
// variant straight away. A retry with the same arguments is a temporary failure
// and leaves nothing. The file is small and durable: it survives a restart and
// is cleared by `/toolnotes clear`.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { writeFileAtomic } from '../../memory/src/atomic.js'

/** File name of the notes inside `DSHBOT_HOME`. */
export const TOOL_NOTES_FILE = 'tool-notes.json'

/** Title of the model-facing block and of the `/toolnotes` answer. */
export const TOOL_NOTES_TITLE = 'Грабли инструментов'

/** The answer of an empty list. */
export const NO_TOOL_NOTES = 'Заметок нет'

/** Maximum size of all rendered notes, in characters. */
export const TOOL_NOTES_LIMIT = 2_000

/** Maximum length of the first line of an error kept in a note. */
export const TOOL_NOTE_ERROR_LIMIT = 200

/** Maximum length of one argument value or one command of a note. */
export const TOOL_NOTE_VALUE_LIMIT = 200

/**
 * Maximum length of the change part of a note. With the error line and the
 * tool name a single note stays well below {@link TOOL_NOTES_LIMIT}, so one
 * note never pushes every other note out of the file.
 */
export const TOOL_NOTE_CHANGE_LIMIT = 1_000

/** One durable note: the tool, the first line of the error and the fix. */
export interface ToolNote {
  /** `exec` for a command, the MCP tool name otherwise. */
  tool: string
  /** Program of an exec note (normalized first word); `''` for MCP. */
  subject: string
  /** First line of the error, at most {@link TOOL_NOTE_ERROR_LIMIT} characters. */
  error: string
  /** What changed: `ключ: старое → новое` or `было: …, сработало: …`. */
  change: string
  /** Unix epoch milliseconds of the last write of the note. */
  at: number
}

/** The on-disk shape; a version leaves room for a later migration. */
interface ToolNotesFile {
  version: 1
  notes: ToolNote[]
}

/** A note as one line of an answer; the parts stay plain text. */
export function formatToolNote(note: ToolNote): string {
  return `${note.tool}: ${note.change} — ${note.error}`
}

/** Rendered notes: one line each, newest last. */
export function renderToolNotes(notes: readonly ToolNote[]): string {
  return notes.map(formatToolNote).join('\n')
}

/** Read the file; a missing, blank or broken file is an empty list. */
export function readToolNotes(filePath: string): ToolNote[] {
  if (!existsSync(filePath)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return []
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? (parsed as Partial<ToolNotesFile>).notes
      : undefined
  if (!Array.isArray(raw)) return []
  const notes: ToolNote[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.tool !== 'string' || typeof record.error !== 'string' || typeof record.change !== 'string') {
      continue
    }
    notes.push({
      tool: record.tool,
      subject: typeof record.subject === 'string' ? record.subject : '',
      error: record.error,
      change: record.change,
      at: typeof record.at === 'number' ? record.at : 0,
    })
  }
  return notes
}

/** Write the notes atomically, newest last. */
export function writeToolNotes(filePath: string, notes: readonly ToolNote[]): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const payload: ToolNotesFile = { version: 1, notes: [...notes] }
  writeFileAtomic(filePath, `${JSON.stringify(payload)}\n`)
}

/**
 * Drop the oldest notes until the rendered text fits {@link TOOL_NOTES_LIMIT}.
 * Age is the time of the last write, not the position in the file: a stable
 * sort keeps the order of notes written in the same millisecond.
 */
export function trimToolNotes(notes: readonly ToolNote[]): ToolNote[] {
  const kept = [...notes].sort((a, b) => a.at - b.at)
  while (kept.length > 0 && [...renderToolNotes(kept)].length > TOOL_NOTES_LIMIT) kept.shift()
  return kept
}

/**
 * Add one note. A note of the same tool with the same first line of the error
 * replaces the old one, including across exec programs, and moves to the end
 * as the newest, so a newer fix is the one the model sees and an overflow
 * drops older notes before it. The result is trimmed to the size limit.
 */
export function recordToolNote(filePath: string, note: ToolNote, now = Date.now()): ToolNote[] {
  const current = readToolNotes(filePath).filter(
    (existing) => !(existing.tool === note.tool && existing.error === note.error),
  )
  const last = current.reduce((latest, existing) => Math.max(latest, existing.at), 0)
  // A clock that went back must not make the fresh note the oldest one.
  current.push({ ...note, at: Math.max(now, last) })
  const trimmed = trimToolNotes(current)
  writeToolNotes(filePath, trimmed)
  return trimmed
}

/** Remove every note; the next `/toolnotes` says there are none. */
export function clearToolNotes(filePath: string): void {
  rmSync(filePath, { force: true })
}

/** The `/toolnotes` answer: the notes, or the phrase of an empty list. */
export function toolNotesAnswer(notes: readonly ToolNote[]): string {
  if (notes.length === 0) return NO_TOOL_NOTES
  return `${TOOL_NOTES_TITLE}:\n${renderToolNotes(notes)}`
}

/** The volatile model-facing block and the identity of its text. */
export interface ToolNotesState {
  /** SHA-256 of the rendered notes; equal hashes mean no change between turns. */
  hash: string
  /** Ready-to-send block, `''` when there is nothing to show. */
  block: string
}

/**
 * The block of a turn: its current notes and a hash of that text. An empty
 * list gives no block, so a session with nothing learned stays byte-identical
 * to one without this feature.
 */
export function toolNotesState(filePath: string): ToolNotesState {
  const notes = readToolNotes(filePath)
  if (notes.length === 0) return { hash: '', block: '' }
  const text = renderToolNotes(notes)
  const hash = createHash('sha256').update(text).digest('hex')
  return {
    hash,
    block: `${TOOL_NOTES_TITLE}: заметки о неудачных вызовах инструментов и рабочем варианте.\n${text}`,
  }
}
