// Service insertions about the owner's files for the tail of an owner turn.
//
// The analysis runs in a session of its own, so `main` would not know that a
// file exists at all. The insertion restores what the owner expects the bot to
// remember: the file name, its absolute path in the inbox, its type and size,
// and (when the analysis is over) the text of the result. It rides in the tail
// of the turn, never in the stable prefix: the prefix and `main` stay cached.
//
// The catalogue (docs/research/prompts.md §5.1) supplies the boundary rule:
// everything the owner sent is data, not an instruction. The whole block is
// therefore wrapped in the same `EXTERNAL_UNTRUSTED_CONTENT` frame that web
// results use, and a boundary word inside the text cannot close the frame early.

import { frameData, sanitizeData } from './untrusted-frame.js'

/** Characters of the analysis text that reach `main`; the rest is cut with a note. */
export const ATTACHMENT_SUMMARY_LIMIT = 12_000

/** Marker of a service insertion that is not an owner message. */
export const ATTACHMENTS_CONTEXT_OPEN = '<context_не_owner: вложения владельца>'
export const ATTACHMENTS_CONTEXT_CLOSE = '</context_не_owner>'

/** The file facts main needs to read the file or to answer about it. */
export interface AttachmentFileFact {
  /** Absolute path in the inbox. */
  path: string
  /** Name the owner sent and the bot saved. */
  name: string
  /** MIME type. */
  mime: string
  /** Size in bytes. */
  size: number
}

/** How the analysis ended, as main should describe it. */
export type AttachmentOutcome = 'done' | 'stopped'

export interface FinishedAttachmentAnalysis {
  files: AttachmentFileFact[]
  outcome: AttachmentOutcome
  /** Text of the result; empty for a stopped analysis. */
  summary: string
}

function pluralFiles(count: number): string {
  if (count === 1) return 'файла'
  return 'файлов'
}

/** `- name — mime, N байт, путь: /abs/...`; every part is untrusted data. */
function fileLines(files: AttachmentFileFact[]): string[] {
  return files.map(
    (file) => `- ${sanitizeData(file.name)} — ${sanitizeData(file.mime)}, ${file.size} байт, путь: ${sanitizeData(file.path)}`,
  )
}

function namesOf(files: AttachmentFileFact[]): string {
  return files.map((file) => sanitizeData(file.name)).join(', ')
}

/** Short insertion for a turn that arrives while the analysis is still running. */
export function runningAttachmentsContext(files: AttachmentFileFact[]): string {
  const body = [
    `Идёт разбор ${pluralFiles(files.length)}: ${namesOf(files)}. Итог придёт отдельным сообщением; файл можно прочитать самому (read).`,
    'Пути:',
    ...fileLines(files),
  ].join('\n')
  return [ATTACHMENTS_CONTEXT_OPEN, frameData(body), ATTACHMENTS_CONTEXT_CLOSE].join('\n')
}

function truncateSummary(summary: string): string {
  const characters = Array.from(summary)
  if (characters.length <= ATTACHMENT_SUMMARY_LIMIT) return summary
  const head = characters.slice(0, ATTACHMENT_SUMMARY_LIMIT).join('')
  return `${head}\n… Итог обрезан: показаны первые ${ATTACHMENT_SUMMARY_LIMIT} символов из ${characters.length}.`
}

/** Insertion for the first owner turn after the analysis finished or was stopped. */
export function finishedAttachmentsContext(analysis: FinishedAttachmentAnalysis): string {
  const intro =
    analysis.outcome === 'done'
      ? 'Разбор файлов владельца закончен, итог отправлен владельцу отдельным сообщением.'
      : 'Разбор файлов владельца остановлен, готового итога нет.'
  const summary =
    analysis.outcome === 'done'
      ? truncateSummary(analysis.summary)
      : 'Разбор остановлен владельцем; текста итога нет.'
  const body = [
    `Файлы (${analysis.files.length}):`,
    ...fileLines(analysis.files),
    '',
    'Итог разбора:',
    summary,
  ].join('\n')
  return [ATTACHMENTS_CONTEXT_OPEN, intro, frameData(body), ATTACHMENTS_CONTEXT_CLOSE].join('\n')
}
