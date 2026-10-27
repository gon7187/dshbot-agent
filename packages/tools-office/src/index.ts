// `office` — DOCX, XLSX and PPTX of the owner, built by pure-JS libraries.
//
// The bot runs on a server without an external office suite (no CLI helper and
// no re-implementation of the formats by hand). Reading of office files stays
// in the extraction of attachments (`attachments.ts`, worker with limits).
// This package only generates new files and edits XLSX into a new file.
// Generation itself runs in `office-worker.mjs` under a hard
// deadline and a memory limit, exactly like the extraction: a hanging library
// must not take the daemon with it.
//
// Every file lands in `DSHBOT_HOME/workspace/outbox/<YYYY-MM-DD>/` with a
// sanitized name. The answer carries the absolute path, which the owner turn
// can send through `save_output`/`sendDocument`.

import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

import { frameData } from '../../app/src/untrusted-frame.js'
import type { RunnerImageInput, RunnerTool, RunnerToolContext } from '../../runner/src/index.js'

/** Hard limit on one generation worker, the same idea as an extraction. */
export const OFFICE_TIMEOUT_MS = 120_000

/** Memory limits of one generation worker. */
export const OFFICE_WORKER_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 8,
} as const

const CREATE_ACTIONS = {
  create_docx: 'docx',
  create_xlsx: 'xlsx',
  create_pptx: 'pptx',
} as const

type CreateAction = keyof typeof CREATE_ACTIONS
export type OfficeAction = CreateAction | 'edit_xlsx' | 'read'

/** One selected page of a page-aware read, with its text (empty for a scan). */
export interface OfficeExtractionPage {
  page: number
  text: string
}

/** One scan page rendered for the recognition model. */
export interface OfficeExtractionImage {
  page: number
  mediaType: RunnerImageInput['mediaType']
  data: Uint8Array
}

/** Extraction of attachments, injected so there is one parser in the daemon. */
export interface OfficeExtraction {
  ok: boolean
  kind?: 'text' | 'scan' | 'audio' | 'unsupported'
  text?: string
  error?: string
  /** Page-aware read of a PDF: every selected page with the text of its layer. */
  pages?: OfficeExtractionPage[]
  /** Pages without a text layer, rendered for the same model that sees attachment scans. */
  images?: OfficeExtractionImage[]
  failedPages?: Array<{ page: number; reason: string }>
  pageCount?: number
  /** The model-facing note of a page-aware read (the total, the cap of the scan pages). */
  note?: string
}

export interface OfficeToolDeps {
  /** `DSHBOT_HOME`; files go to `workspace/outbox/<date>/`. */
  home: string
  /**
   * The extraction of attachments (`AttachmentIntake.extractFile`). The office
   * `read` action delegates here: same worker, same limits, same truncation
   * note, same page renderer.
   */
  extract: (file: { path: string; name: string; pages?: string }) => Promise<OfficeExtraction>
  /**
   * Resolve a path of the `read` action through the ordinary file roots and the
   * hidden list of the daemon. Defaults to the old workspace-only check.
   */
  resolveReadFile?: (raw: unknown) => string
  /**
   * Recognize one scan page with the model that accepts images (the same model
   * an attachment scan reaches). A failure becomes a note of that page, not a
   * failed read of the whole document.
   */
  recognizePage?: (image: OfficeExtractionImage, signal?: AbortSignal) => Promise<string>
  /**
   * Durable session of the owner's main chat. The tool is owner-only, so a
   * delegated child, a guest, a scheduled task or an experience review gets an
   * error instead of a file. Defaults to `main`.
   */
  ownerSessionId?: string
}

export interface OfficeWorkerAnswer {
  ok: boolean
  error?: string
}

function within(root: string, candidate: string): boolean {
  const rest = relative(resolve(root), resolve(candidate))
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/** Local date directory, the same one the attachment outbox uses. */
export function officeDateDirectory(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * One safe file name of the requested format. Path components (`/`, `\`), a
 * drive/absolute prefix, control characters and the characters Windows refuses
 * can never survive; the format extension is always the one of the action.
 */
export function sanitizeOfficeName(raw: unknown, extension: string, fallback = 'document'): string {
  const leaf = (typeof raw === 'string' ? raw : '').replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f<>":|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  const current = extname(cleaned)
  const stem = (current === '' ? cleaned : cleaned.slice(0, -current.length))
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 150)
  const safeStem = stem === '' || stem === '.' ? fallback : stem
  return `${safeStem}.${extension}`
}

function uniquePath(directory: string, name: string): string {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  let candidate = name
  let index = 2
  // Every directory entry is occupied, including a symlink with no target.
  // The worker still creates exclusively: another writer can win after this check.
  while (lstatSync(join(directory, candidate), { throwIfNoEntry: false }) !== undefined) {
    candidate = `${stem}-${index}${extension}`
    index += 1
  }
  return join(directory, candidate)
}

/**
 * A real file under `workspace`; `..`, absolute escapes and symlinks that lead
 * out of the workspace are refused. The real path is returned, so every later
 * check and every reader works on the same target the OS will open.
 */
export function resolveWorkspaceFile(home: string, raw: unknown, what = 'path'): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`${what}: пустой путь`)
  const workspace = join(home, 'workspace')
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw)
  if (!within(workspace, candidate)) throw new Error(`${what}: файл должен лежать в workspace`)
  let file: string
  try {
    file = realpathSync(candidate)
  } catch {
    throw new Error(`${what}: файл не найден: ${raw}`)
  }
  let root: string
  try {
    root = realpathSync(workspace)
  } catch {
    throw new Error(`${what}: рабочая папка не найдена`)
  }
  if (!within(root, file)) throw new Error(`${what}: ссылка выводит файл за пределы workspace`)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${what}: файл не найден: ${raw}`)
  return file
}

/**
 * The date directory of the outbox, created only if its real path stays inside
 * the outbox. A ready symlink `workspace/outbox/<date>` (or `workspace/outbox`
 * itself) that points outwards is refused instead of redirecting the write.
 */
function prepareOutbox(home: string, now: number): { directory: string; workspace: string; date: string } {
  const workspace = join(home, 'workspace')
  let workspaceReal: string
  try {
    workspaceReal = realpathSync(workspace)
  } catch {
    throw new Error('outbox: рабочая папка не найдена')
  }
  const outbox = join(workspace, 'outbox')
  mkdirSync(outbox, { recursive: true })
  let outboxReal: string
  try {
    outboxReal = realpathSync(outbox)
  } catch {
    throw new Error('outbox: не удалось разобрать путь outbox')
  }
  if (!within(workspaceReal, outboxReal)) throw new Error('outbox: каталог выведен за пределы workspace')
  const date = officeDateDirectory(now)
  const directory = join(outbox, date)
  mkdirSync(directory, { recursive: true })
  let directoryReal: string
  try {
    directoryReal = realpathSync(directory)
  } catch {
    throw new Error('outbox: не удалось разобрать путь каталога даты')
  }
  if (!within(outboxReal, directoryReal)) {
    throw new Error('outbox: каталог даты выведен за пределы workspace/outbox')
  }
  return { directory, workspace: workspaceReal, date }
}

/**
 * Run one format action in a fresh worker and wait for its answer.
 *
 * The timer is the daemon's own timer (the tests move it with the fake clock),
 * so a hanging library always ends as a tool error while the daemon stays up.
 */
function runWorker(
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<OfficeWorkerAnswer> {
  return new Promise<OfficeWorkerAnswer>((settle) => {
    let worker: Worker
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (answer: OfficeWorkerAnswer): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      void worker?.terminate().catch(() => undefined)
      settle(answer)
    }
    const aborted = (): void => finish({ ok: false, error: 'генерация отменена' })

    try {
      worker = new Worker(new URL('./office-worker.mjs', import.meta.url), {
        resourceLimits: OFFICE_WORKER_LIMITS,
      })
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    timer = setTimeout(() => finish({ ok: false, error: 'таймаут генерации' }), OFFICE_TIMEOUT_MS)
    if (signal?.aborted === true) {
      aborted()
      return
    }
    signal?.addEventListener('abort', aborted, { once: true })
    worker.once('message', (message: unknown) => {
      const answer = message !== null && typeof message === 'object' ? (message as OfficeWorkerAnswer) : undefined
      if (answer === undefined) finish({ ok: false, error: 'пустой ответ worker' })
      else if (answer.ok === true) finish({ ok: true })
      else finish({ ok: false, error: answer.error ?? 'неизвестная ошибка' })
    })
    worker.once('error', (error: unknown) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    worker.once('exit', (code) => {
      if (!settled) finish({ ok: false, error: `worker завершился с кодом ${code}` })
    })
    worker.postMessage(payload)
  })
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${what}: нужен непустой массив`)
  return value
}

export function createOfficeTool(deps: OfficeToolDeps): RunnerTool {
  const ownerSession = deps.ownerSessionId ?? 'main'

  /**
   * Pages of a page-aware read in order, each under its number. A page without
   * a text layer goes to the recognition model; a page that could not be
   * rendered or recognized keeps its number and a note instead of disappearing.
   */
  async function pagesText(result: OfficeExtraction, signal?: AbortSignal): Promise<string> {
    const images = new Map((result.images ?? []).map((image) => [image.page, image]))
    const failed = new Map((result.failedPages ?? []).map((failure) => [failure.page, failure.reason]))
    const parts: string[] = []
    for (const page of result.pages ?? []) {
      let text = page.text.trim()
      if (text === '') {
        const image = images.get(page.page)
        if (image !== undefined && deps.recognizePage !== undefined) {
          try {
            text = (await deps.recognizePage(image, signal)).trim()
          } catch (error) {
            text = `не удалось распознать скан: ${error instanceof Error ? error.message : String(error)}`
          }
        } else if (failed.has(page.page)) {
          text = `скан без текстового слоя, страница не распознана: ${failed.get(page.page)}`
        } else {
          text = 'скан без текстового слоя, страница не распознана'
        }
        if (text === '') text = 'скан без текстового слоя, модель не вернула текст'
      }
      parts.push(`--- страница ${page.page} ---\n${text}`)
    }
    if (result.note !== undefined && result.note !== '') parts.push(result.note)
    return parts.join('\n\n')
  }

  async function generate(
    action: CreateAction | 'edit_xlsx',
    args: Record<string, unknown>,
    context: RunnerToolContext | undefined,
  ): Promise<string> {
    const extension = action === 'edit_xlsx' ? 'xlsx' : CREATE_ACTIONS[action]
    const name = sanitizeOfficeName(args.name, extension)
    const outbox = prepareOutbox(deps.home, Date.now())
    const target = uniquePath(outbox.directory, name)
    const payload: Record<string, unknown> = {
      action,
      target,
      outbox: outbox.directory,
      workspace: outbox.workspace,
    }
    if (action === 'create_docx') payload.blocks = requireArray(args.blocks, 'blocks')
    else if (action === 'create_xlsx') payload.sheets = requireArray(args.sheets, 'sheets')
    else if (action === 'create_pptx') {
      // An image path is resolved here, once, to a real file in the workspace:
      // the worker then sees no symlinked escape and no `..` variant.
      payload.slides = requireArray(args.slides, 'slides').map((slide) => {
        if (slide === null || typeof slide !== 'object' || Array.isArray(slide)) return slide
        const image = (slide as Record<string, unknown>).image
        if (image === undefined) return slide
        return { ...(slide as Record<string, unknown>), image: resolveWorkspaceFile(deps.home, image, 'slides.image') }
      })
    } else {
      payload.source = resolveWorkspaceFile(deps.home, args.path)
      payload.edits = Array.isArray(args.edits) ? args.edits : []
      payload.appendRows = Array.isArray(args.append_rows) ? args.append_rows : []
      if ((payload.edits as unknown[]).length === 0 && (payload.appendRows as unknown[]).length === 0) {
        throw new Error('edit_xlsx: нужны edits или append_rows')
      }
    }
    const answer = await runWorker(payload, context?.signal)
    if (!answer.ok) throw new Error(`office ${action}: ${answer.error ?? 'не удалось создать файл'}`)
    return `Файл создан: ${target}`
  }

  return {
    name: 'office',
    description:
      'Создать офисный файл в workspace/outbox/<дата>/ и вернуть его путь: create_docx (заголовки, абзацы с жирным/курсивом, списки, таблицы, разрыв страницы), create_xlsx (листы, строки ячеек, даты, формулы, жирная шапка, закреплённая первая строка), create_pptx (слайды с заголовком, текстом, списком, таблицей, картинкой из workspace), edit_xlsx (правка ячеек и добавление строк в новый файл), read (текст существующего файла через разбор вложений с теми же лимитами; у PDF pages задаёт диапазон страниц, каждая страница помечена номером, без pages читаются первые 20, сканы распознаются моделью с картинками).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_docx', 'create_xlsx', 'create_pptx', 'edit_xlsx', 'read'],
          description: 'Что сделать с файлом',
        },
        name: {
          type: 'string',
          description: 'Имя нового файла; расширение задаёт действие. Файл всегда пишется в workspace/outbox/<дата>/',
        },
        blocks: {
          type: 'array',
          description:
            'create_docx: блоки { type: heading, level 1-3, text } | { type: paragraph, runs [{ text, bold?, italic? }] } | { type: bullets, items } | { type: numbered, items } | { type: table, rows: string[][] } | { type: page_break }',
          items: { type: 'object' },
        },
        sheets: {
          type: 'array',
          description:
            'create_xlsx: листы { name, rows }; ячейка — строка, число, булево, { date: ISO } или строка-формула с "="',
          items: { type: 'object' },
        },
        slides: {
          type: 'array',
          description:
            'create_pptx: слайды { title, text?, bullets?: string[], table?: { rows }, image?: абсолютный путь картинки в workspace }',
          items: { type: 'object' },
        },
        path: {
          type: 'string',
          description: 'edit_xlsx и read: путь файла в разрешённых корнях (абсолютный или относительно workspace)',
        },
        pages: {
          type: 'string',
          description:
            'read и только PDF: диапазон страниц, например "3-5" или "7" (нумерация с 1). Без pages читаются первые 20 страниц; страницы без текстового слоя распознаются как сканы.',
        },
        edits: {
          type: 'array',
          description: 'edit_xlsx: правки { sheet, cell: "B2", value }',
          items: { type: 'object' },
        },
        append_rows: {
          type: 'array',
          description: 'edit_xlsx: новые строки { sheet, rows }',
          items: { type: 'object' },
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>, context?: RunnerToolContext): Promise<string> {
      // Owner-only, as a check at execution time: the schema of a guest and the
      // subset a delegated child inherits are decided elsewhere, and a tool
      // loaded through `tool_search` reaches a child too. Only the main session
      // of the owner may make a file; anything else is a tool error.
      const sessionId = context?.sessionId
      if (sessionId !== undefined && sessionId !== ownerSession) {
        throw new Error(`office: инструмент доступен только в main-сессии владельца (${sessionId})`)
      }
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'read') {
        const parseReadPath = deps.resolveReadFile ?? ((raw: unknown) => resolveWorkspaceFile(deps.home, raw))
        const file = parseReadPath(args.path)
        const pages =
          args.pages === undefined || args.pages === null || String(args.pages).trim() === ''
            ? undefined
            : String(args.pages)
        const result = await deps.extract({
          path: file,
          name: basename(file),
          ...(pages === undefined ? {} : { pages }),
        })
        if (!result.ok) throw new Error(`office read: ${result.error ?? 'файл не разобран'}`)
        // A document and its PDF pages are written by strangers: both branches
        // return the extracted text inside the common frame of untrusted data.
        const text = result.pages !== undefined
          ? await pagesText(result, context?.signal)
          : result.text ?? ''
        return frameData(text, { source: 'office' })
      }
      if (action === 'create_docx' || action === 'create_xlsx' || action === 'create_pptx' || action === 'edit_xlsx') {
        return await generate(action, args, context)
      }
      throw new Error(`office: неизвестное действие ${JSON.stringify(action)}`)
    },
  }
}
