import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { isGithubMutation } from './github.js'

const MAX_BODY_BYTES = 64 * 1024
const MAX_DELIVERY_BODY_BYTES = 256 * 1024
const MAX_TEXT_LENGTH = 4_000
const MAX_INCOMING_TEXT_LENGTH = 16_000
const MAX_GITHUB_ARGV = 128
const MAX_GITHUB_ARG_LENGTH = 4_096
const SEND_TIMEOUT_MS = 5_000

export interface SuperagentBridgeInput {
  projectId: number
  updateId: number
  messageId: number
  chatId: number
  fromId: number
  text: string
  at: string
  replyTo?: number
}

export interface SuperagentBridgeEvent extends SuperagentBridgeInput {
  id: string
  rootMessageId: number
}

export interface SuperagentBridge {
  enqueue(input: SuperagentBridgeInput): { id: string; rootMessageId: number }
  ownsReply(chatId: number, messageId: number): boolean
  replyProject(chatId: number, messageId: number): number | undefined
  listUncertain(): Array<{ projectId: number; id: string }>
  retryUncertain(projectId: number, id: string): void
  dismissUncertain(projectId: number, id: string): void
  beginResume(projectIds: readonly number[]): number
  resumeReady(generation: number): boolean
  activate(generation: number): void
  isPaused(): boolean
  status(): string
  start(): Promise<void>
  stop(): Promise<void>
  setPaused(paused: boolean): void
}

type SendInput = { chatId: number; replyTo: number; text: string }
type SendResult = { messageId: number }
export type SuperagentBridgeListener = { projectId: number; socketPath: string }
export type SuperagentUsage = {
  at: number
  sessionId: string
  model: string
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  projectId?: number
  id?: string
  provider?: string
}
export type SuperagentGithub = (projectId: number, argv: string[]) => Promise<{ stdout: string }>
export type SuperagentDelivery = {
  submit: (projectId: number, input: unknown) => Promise<unknown>
  status: (projectId: number, id: string) => Promise<unknown>
}
type BridgeOptions = {
  db: DatabaseSync
  socketPath?: string
  ownerId: () => number | null
  send: (input: SendInput) => Promise<SendResult>
  log?: (message: string) => void
  projects?: () => readonly number[]
  recordUsage?: (usage: SuperagentUsage) => void
  listeners?: readonly SuperagentBridgeListener[]
  github?: SuperagentGithub
  delivery?: SuperagentDelivery
}

type EventRow = {
  id: string
  project_id: number
  update_id: number
  message_id: number
  chat_id: number
  from_id: number
  root_message_id: number
  text: string
  at: string
  reply_to: number | null
  acked: number
}

type MessageRow = {
  message_id: number
  direction: 'incoming' | 'outgoing'
  text: string
  at: string
  reply_to: number | null
}

type OutboxRow = {
  id: string
  project_id: number
  chat_id: number
  root_message_id: number
  reply_to: number
  text: string
  state: 'pending' | 'sending' | 'sent' | 'uncertain' | 'gone'
  message_id: number | null
}

type BridgePhase = 'paused' | 'arming' | 'active'

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function positiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function bodyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= MAX_TEXT_LENGTH
}

function incomingText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= MAX_INCOMING_TEXT_LENGTH
}

function now(): number { return Date.now() }

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    throw error
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value) ?? 'null'
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function errorResponse(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof HttpError ? error.message : 'bridge failure'
  if (!res.writableEnded) json(res, status, { error: message })
}

async function requestBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const header = req.headers['content-length']
  if (header !== undefined) {
    const length = Number(Array.isArray(header) ? header[0] : header)
    if (!Number.isFinite(length) || length < 0) throw new HttpError(400, 'invalid content length')
    if (length > maxBytes) {
      req.resume()
      throw new HttpError(413, 'request body is too large')
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > maxBytes) {
      req.resume()
      throw new HttpError(413, 'request body is too large')
    }
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') throw new HttpError(400, 'request body is required')
  try { return JSON.parse(text) as unknown } catch { throw new HttpError(400, 'request body must be JSON') }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('send timeout')), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function socketProbe(socketPath: string): Promise<'active' | 'stale'> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: 'active' | 'stale') => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const req = httpRequest({ socketPath, method: 'GET', path: '/health' }, response => {
      response.resume()
      response.once('end', () => finish('active'))
      response.once('error', () => finish('active'))
    })
    req.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      finish(code === 'ENOENT' || code === 'ECONNREFUSED' ? 'stale' : 'active')
    })
    req.setTimeout(250, () => { req.destroy(); finish('active') })
    req.end()
  })
}

export function createSuperagentBridge(options: BridgeOptions): SuperagentBridge {
  const { db, socketPath, ownerId, send, log, projects, recordUsage, listeners, github, delivery } = options
  if (listeners === undefined && (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.endsWith('/') || socketPath.includes('\0'))) {
    throw new Error('socketPath must be an absolute Unix socket path')
  }
  const listenerSpecs = listeners?.map(listener => {
    if (!nonNegativeSafeInt(listener.projectId) || typeof listener.socketPath !== 'string'
      || !listener.socketPath.startsWith('/') || listener.socketPath.endsWith('/') || listener.socketPath.includes('\0')) {
      throw new Error('invalid project listener')
    }
    return { projectId: listener.projectId, socketPath: listener.socketPath }
  })
  if (listenerSpecs !== undefined) {
    const projectsSeen = new Set<number>()
    const pathsSeen = new Set<string>()
    for (const listener of listenerSpecs) {
      if (projectsSeen.has(listener.projectId) || pathsSeen.has(listener.socketPath)) throw new Error('duplicate project listener')
      projectsSeen.add(listener.projectId)
      pathsSeen.add(listener.socketPath)
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS superagent_bridge_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS superagent_bridge_events (
      id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, update_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, from_id INTEGER NOT NULL,
      root_message_id INTEGER NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
      reply_to INTEGER, acked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS superagent_bridge_events_pending
      ON superagent_bridge_events(project_id, chat_id, acked);
    CREATE TABLE IF NOT EXISTS superagent_bridge_messages (
      project_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
      root_message_id INTEGER NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
      text TEXT NOT NULL, at TEXT NOT NULL, reply_to INTEGER, event_id TEXT,
      PRIMARY KEY(project_id, chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS superagent_bridge_messages_thread
      ON superagent_bridge_messages(project_id, chat_id, root_message_id);
    CREATE TABLE IF NOT EXISTS superagent_bridge_outbox (
      id TEXT NOT NULL, project_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
      root_message_id INTEGER NOT NULL, reply_to INTEGER NOT NULL, text TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'uncertain', 'gone')),
      message_id INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, id)
    );
    CREATE INDEX IF NOT EXISTS superagent_bridge_outbox_pending
      ON superagent_bridge_outbox(state, created_at);
    CREATE TABLE IF NOT EXISTS superagent_bridge_usage (
      project_id INTEGER NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, id)
    );
    CREATE TABLE IF NOT EXISTS superagent_bridge_resume (
      generation INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      acked INTEGER NOT NULL DEFAULT 0 CHECK(acked IN (0,1)),
      PRIMARY KEY(generation, project_id)
    );
  `)

  const savedPause = db.prepare('SELECT value FROM superagent_bridge_state WHERE key=?').get('paused') as { value?: string } | undefined
  let paused = savedPause?.value === undefined ? true : savedPause.value !== '0'
  if (savedPause === undefined) {
    db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?)').run('paused', '1')
  } else if (savedPause.value !== '0' && savedPause.value !== '1') {
    paused = true
    db.prepare('UPDATE superagent_bridge_state SET value=? WHERE key=?').run('1', 'paused')
  }
  const savedGeneration = db.prepare('SELECT value FROM superagent_bridge_state WHERE key=?').get('generation') as { value?: string } | undefined
  const parsedGeneration = savedGeneration?.value === undefined ? 0 : Number(savedGeneration.value)
  let generation = nonNegativeSafeInt(parsedGeneration) ? parsedGeneration : 0
  const savedPhase = db.prepare('SELECT value FROM superagent_bridge_state WHERE key=?').get('phase') as { value?: string } | undefined
  let phase: BridgePhase = savedPhase?.value === 'arming' || savedPhase?.value === 'active' || savedPhase?.value === 'paused'
    ? savedPhase.value
    : (paused ? 'paused' : 'active')
  if (phase === 'active' && paused) phase = 'paused'
  if (phase !== 'active') paused = true
  if (phase === 'active') paused = false
  transaction(db, () => {
    db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('generation', String(generation))
    db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('phase', phase)
    db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('paused', paused ? '1' : '0')
  })
  db.prepare("UPDATE superagent_bridge_outbox SET state='uncertain', error=COALESCE(error, 'bridge restarted'), updated_at=? WHERE state='sending'").run(now())

  let servers: ReturnType<typeof createServer>[] = []
  let running = false
  let starting: Promise<void> | undefined
  let activeSend: Promise<void> | undefined
  let pumpQueued = false

  function currentOwner(): number | null {
    const value = ownerId()
    return positiveSafeInt(value) ? value : null
  }

  function projectConnected(projectId: number): boolean {
    if (!nonNegativeSafeInt(projectId)) return false
    if (projects === undefined) return true
    const connected = projects()
    return connected.includes(projectId) || projectId === 0
  }

  function requireProject(projectId: unknown, http = false): number {
    if (!nonNegativeSafeInt(projectId) || !projectConnected(projectId)) {
      if (http) throw new HttpError(404, 'unknown project')
      throw new Error('unknown project')
    }
    return projectId
  }

  function requireOwnerChat(chatId: unknown, fromId?: unknown): number {
    const owner = currentOwner()
    if (owner === null || !positiveSafeInt(chatId) || (fromId !== undefined && (!positiveSafeInt(fromId) || fromId !== chatId)) || chatId !== owner) {
      throw new Error('owner chat required')
    }
    return owner
  }

  function validateInput(input: SuperagentBridgeInput): void {
    if (!nonNegativeSafeInt(input.updateId) || !positiveSafeInt(input.messageId)
      || !positiveSafeInt(input.chatId) || !positiveSafeInt(input.fromId) || input.chatId !== input.fromId) {
      throw new Error('invalid Telegram identity')
    }
    requireProject(input.projectId)
    requireOwnerChat(input.chatId, input.fromId)
    if (!incomingText(input.text)) throw new Error('text must contain 1 to 16000 characters')
    if (typeof input.at !== 'string' || input.at.length === 0 || input.at.length > 128) throw new Error('invalid event timestamp')
    if (input.replyTo !== undefined && !positiveSafeInt(input.replyTo)) throw new Error('invalid reply target')
  }

  function eventPayload(row: EventRow): SuperagentBridgeEvent {
    return {
      id: row.id, projectId: Number(row.project_id), updateId: Number(row.update_id), messageId: Number(row.message_id),
      chatId: Number(row.chat_id), fromId: Number(row.from_id), rootMessageId: Number(row.root_message_id), text: row.text, at: row.at,
      ...(row.reply_to === null ? {} : { replyTo: Number(row.reply_to) }),
    }
  }

  function enqueue(input: SuperagentBridgeInput): { id: string; rootMessageId: number } {
    validateInput(input)
    const id = `telegram:${input.chatId}:${input.updateId}`
    const existing = db.prepare('SELECT project_id,root_message_id FROM superagent_bridge_events WHERE id=?').get(id) as { project_id?: number; root_message_id?: number } | undefined
    if (existing?.root_message_id !== undefined) {
      if (Number(existing.project_id) !== input.projectId) throw new Error('update id already belongs to another project')
      return { id, rootMessageId: Number(existing.root_message_id) }
    }
    const replyRoot = input.replyTo === undefined ? undefined : db.prepare(
      'SELECT root_message_id FROM superagent_bridge_messages WHERE project_id=? AND chat_id=? AND message_id=?',
    ).get(input.projectId, input.chatId, input.replyTo) as { root_message_id?: number } | undefined
    const rootMessageId = replyRoot?.root_message_id === undefined ? input.messageId : Number(replyRoot.root_message_id)
    transaction(db, () => {
      const occupied = db.prepare('SELECT direction FROM superagent_bridge_messages WHERE project_id=? AND chat_id=? AND message_id=?').get(input.projectId, input.chatId, input.messageId) as { direction?: string } | undefined
      if (occupied !== undefined) throw new Error('message_id already belongs to another event')
      db.prepare(`INSERT INTO superagent_bridge_events
        (id,project_id,update_id,message_id,chat_id,from_id,root_message_id,text,at,reply_to,acked)
        VALUES (?,?,?,?,?,?,?,?,?,?,0)`).run(
        id, input.projectId, input.updateId, input.messageId, input.chatId, input.fromId, rootMessageId, input.text, input.at, input.replyTo ?? null,
      )
      db.prepare(`INSERT INTO superagent_bridge_messages
        (project_id,chat_id,message_id,root_message_id,direction,text,at,reply_to,event_id)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        input.projectId, input.chatId, input.messageId, rootMessageId, 'incoming', input.text, input.at, input.replyTo ?? null, id,
      )
    })
    return { id, rootMessageId }
  }

  function replyProject(chatId: number, messageId: number): number | undefined {
    if (!positiveSafeInt(chatId) || !positiveSafeInt(messageId) || currentOwner() !== chatId) return undefined
    const row = db.prepare(`SELECT project_id FROM superagent_bridge_messages
      WHERE chat_id=? AND message_id=? ORDER BY project_id LIMIT 1`).get(chatId, messageId) as { project_id?: number } | undefined
    return row?.project_id === undefined ? undefined : Number(row.project_id)
  }

  function ownsReply(chatId: number, messageId: number): boolean {
    if (replyProject(chatId, messageId) === undefined || currentOwner() !== chatId) return false
    const row = db.prepare(`SELECT 1 AS found FROM superagent_bridge_messages
      WHERE chat_id=? AND message_id=? AND direction='outgoing'`).get(chatId, messageId) as { found?: number } | undefined
    return row?.found === 1
  }

  function counts(): { pending: number; sending: number; uncertain: number; sent: number; gone: number } {
    const rows = db.prepare('SELECT state, COUNT(*) AS count FROM superagent_bridge_outbox GROUP BY state').all() as Array<{ state: string; count: number }>
    const result = { pending: 0, sending: 0, uncertain: 0, sent: 0, gone: 0 }
    for (const row of rows) if (row.state in result) result[row.state as keyof typeof result] = Number(row.count)
    return result
  }

  function status(): string {
    const value = counts()
    return `superagent bridge paused=${paused ? '1' : '0'} phase=${phase} generation=${generation} owner=${currentOwner() ?? 'none'} pending=${value.pending} sending=${value.sending} sent=${value.sent} uncertain=${value.uncertain} gone=${value.gone}`
  }

  function listUncertain(): Array<{ projectId: number; id: string }> {
    const owner = currentOwner()
    if (owner === null) return []
    const rows = db.prepare(`SELECT project_id,id FROM superagent_bridge_outbox
      WHERE chat_id=? AND state='uncertain' ORDER BY created_at LIMIT 20`).all(owner) as Array<{ project_id: number; id: string }>
    return rows.map(row => ({ projectId: Number(row.project_id), id: row.id }))
  }

  function uncertainRow(projectId: number, id: string): OutboxRow {
    if (!nonNegativeSafeInt(projectId)) throw new Error('unknown project')
    if (typeof id !== 'string' || id.length === 0 || id.length > 512) throw new Error('unknown uncertain outbox')
    const row = db.prepare(`SELECT id,project_id,chat_id,root_message_id,reply_to,text,state,message_id
      FROM superagent_bridge_outbox WHERE project_id=? AND id=?`).get(projectId, id) as OutboxRow | undefined
    if (row === undefined) throw new Error('unknown uncertain outbox')
    requireOwnerChat(row.chat_id)
    if (row.state !== 'uncertain') throw new Error('outbox is not uncertain')
    return row
  }

  function retryUncertain(projectId: number, id: string): void {
    requireProject(projectId)
    uncertainRow(projectId, id)
    db.prepare(`UPDATE superagent_bridge_outbox
      SET state='pending', message_id=NULL, error=NULL, updated_at=?
      WHERE project_id=? AND id=? AND state='uncertain'`).run(now(), projectId, id)
    schedulePump()
  }

  function dismissUncertain(projectId: number, id: string): void {
    uncertainRow(projectId, id)
    db.prepare(`UPDATE superagent_bridge_outbox
      SET state='gone', message_id=NULL, error='dismissed', updated_at=?
      WHERE project_id=? AND id=? AND state='uncertain'`).run(now(), projectId, id)
  }

  function markUncertain(projectId: number, id: string): void {
    try {
      db.prepare("UPDATE superagent_bridge_outbox SET state='uncertain', error='delivery uncertain', updated_at=? WHERE project_id=? AND id=? AND state='sending'").run(now(), projectId, id)
    } catch {
      log?.('superagent bridge could not persist uncertain outbox state')
    }
  }

  async function deliver(row: OutboxRow): Promise<void> {
    if (currentOwner() !== row.chat_id) {
      markUncertain(row.project_id, row.id)
      return
    }
    try {
      const receipt = await withTimeout(Promise.resolve().then(() => send({ chatId: row.chat_id, replyTo: row.reply_to, text: row.text })), SEND_TIMEOUT_MS)
      if (!positiveSafeInt(receipt?.messageId)) throw new Error('invalid send receipt')
      transaction(db, () => {
        const current = db.prepare('SELECT state FROM superagent_bridge_outbox WHERE project_id=? AND id=?').get(row.project_id, row.id) as { state?: string } | undefined
        if (current?.state !== 'sending') return
        db.prepare("UPDATE superagent_bridge_outbox SET state='sent', message_id=?, error=NULL, updated_at=? WHERE project_id=? AND id=?").run(receipt.messageId, now(), row.project_id, row.id)
        db.prepare(`INSERT INTO superagent_bridge_messages
          (project_id,chat_id,message_id,root_message_id,direction,text,at,reply_to,event_id)
          VALUES (?,?,?,?,?,?,?, ?, NULL)`).run(row.project_id, row.chat_id, receipt.messageId, row.root_message_id, 'outgoing', row.text, new Date().toISOString(), row.reply_to)
      })
    } catch {
      markUncertain(row.project_id, row.id)
      log?.('superagent bridge outbox delivery is uncertain')
    }
  }

  async function pump(): Promise<void> {
    if (!running || paused || phase !== 'active' || activeSend !== undefined) return
    const row = db.prepare(`SELECT id,project_id,chat_id,root_message_id,reply_to,text,state,message_id
      FROM superagent_bridge_outbox WHERE state='pending' ORDER BY created_at LIMIT 1`).get() as OutboxRow | undefined
    if (row === undefined) return
    const claimed = db.prepare("UPDATE superagent_bridge_outbox SET state='sending', updated_at=? WHERE project_id=? AND id=? AND state='pending'").run(now(), row.project_id, row.id)
    if (Number(claimed.changes) !== 1) return
    const work = deliver(row)
    activeSend = work
    try { await work } finally {
      if (activeSend === work) activeSend = undefined
      if (running && !paused && phase === 'active') schedulePump()
    }
  }

  function schedulePump(): void {
    if (!running || paused || phase !== 'active' || activeSend !== undefined || pumpQueued) return
    pumpQueued = true
    queueMicrotask(() => {
      pumpQueued = false
      void pump().catch(() => log?.('superagent bridge pump failed'))
    })
  }

  function validateOutboxBody(value: unknown): { id: string; projectId: number; chatId: number; rootMessageId: number; replyTo: number; text: string } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid outbox body')
    const body = value as Record<string, unknown>
    if (typeof body.id !== 'string' || body.id.length === 0 || body.id.length > 512) throw new HttpError(400, 'invalid outbox id')
    if (!nonNegativeSafeInt(body.projectId) || !positiveSafeInt(body.chatId) || !positiveSafeInt(body.rootMessageId)
      || !positiveSafeInt(body.replyTo) || !bodyText(body.text)) throw new HttpError(400, 'invalid outbox fields')
    requireProject(body.projectId, true)
    return { id: body.id, projectId: body.projectId, chatId: body.chatId, rootMessageId: body.rootMessageId, replyTo: body.replyTo, text: body.text }
  }

  function outboxResponse(row: OutboxRow): { status: number; body: { state: string; messageId?: number } } {
    if (row.state === 'sent' && row.message_id !== null) return { status: 200, body: { state: 'sent', messageId: Number(row.message_id) } }
    if (row.state === 'gone') return { status: 200, body: { state: 'gone' } }
    if (row.state === 'uncertain') return { status: 409, body: { state: 'uncertain' } }
    return { status: 202, body: { state: 'pending' } }
  }

  function sameOutbox(row: OutboxRow, input: { id: string; projectId: number; chatId: number; rootMessageId: number; replyTo: number; text: string }): boolean {
    return row.id === input.id && row.project_id === input.projectId && row.chat_id === input.chatId
      && row.root_message_id === input.rootMessageId && row.reply_to === input.replyTo && row.text === input.text
  }

  function postOutbox(value: unknown): { status: number; body: { state: string; messageId?: number } } {
    const input = validateOutboxBody(value)
    requireOwnerChat(input.chatId)
    const existing = db.prepare(`SELECT id,project_id,chat_id,root_message_id,reply_to,text,state,message_id
      FROM superagent_bridge_outbox WHERE project_id=? AND id=?`).get(input.projectId, input.id) as OutboxRow | undefined
    if (existing !== undefined) {
      if (!sameOutbox(existing, input)) throw new HttpError(409, 'outbox id already names another message')
      return outboxResponse(existing)
    }
    if (paused || phase !== 'active') throw new HttpError(409, 'bridge is paused')
    const destination = db.prepare(`SELECT 1 AS found FROM superagent_bridge_events
      WHERE project_id=? AND chat_id=? AND root_message_id=? LIMIT 1`).get(input.projectId, input.chatId, input.rootMessageId) as { found?: number } | undefined
    if (destination?.found !== 1) throw new HttpError(404, 'unknown thread destination')
    const replyTarget = db.prepare(`SELECT 1 AS found FROM superagent_bridge_messages
      WHERE project_id=? AND chat_id=? AND message_id=? AND root_message_id=?`).get(input.projectId, input.chatId, input.replyTo, input.rootMessageId) as { found?: number } | undefined
    if (replyTarget?.found !== 1) throw new HttpError(404, 'unknown reply destination')
    db.prepare(`INSERT INTO superagent_bridge_outbox
      (id,project_id,chat_id,root_message_id,reply_to,text,state,message_id,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',NULL,NULL,?,?)`).run(
      input.id, input.projectId, input.chatId, input.rootMessageId, input.replyTo, input.text, now(), now(),
    )
    schedulePump()
    return { status: 202, body: { state: 'pending' } }
  }

  function validateUsageBody(value: unknown): SuperagentUsage {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid usage body')
    const body = value as Record<string, unknown>
    const bounded = (item: unknown, limit: number): item is string => typeof item === 'string' && item.length > 0 && item.length <= limit
    const tokens = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const
    if (!nonNegativeSafeInt(body.projectId) || !nonNegativeSafeInt(body.at) || Number(body.at) > 8_640_000_000_000_000 || !bounded(body.id, 512) || !bounded(body.provider, 128) || !bounded(body.model, 256)
      || tokens.some(token => !nonNegativeSafeInt(body[token]))) throw new HttpError(400, 'invalid usage fields')
    if (body.sessionId !== undefined && !bounded(body.sessionId, 512)) throw new HttpError(400, 'invalid usage session')
    requireProject(body.projectId, true)
    return {
      at: body.at as number, sessionId: (body.sessionId ?? body.id) as string,
      projectId: body.projectId as number, id: body.id as string, provider: body.provider as string, model: body.model as string,
      inputTokens: body.inputTokens as number, cacheReadTokens: body.cacheReadTokens as number, cacheWriteTokens: body.cacheWriteTokens as number,
      outputTokens: body.outputTokens as number, ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId as string }),
    }
  }

  function postUsage(value: unknown): { status: number; body: { state: string; reused?: boolean } } {
    const usage = validateUsageBody(value)
    const payload = JSON.stringify({
      at: usage.at, provider: usage.provider, model: usage.model, inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens, ...(usage.sessionId === undefined ? {} : { sessionId: usage.sessionId }),
    })
    const projectId = usage.projectId!
    const id = usage.id!
    const existing = db.prepare('SELECT payload FROM superagent_bridge_usage WHERE project_id=? AND id=?').get(projectId, id) as { payload?: string } | undefined
    if (existing !== undefined) {
      if (existing.payload !== payload) throw new HttpError(409, 'usage id already names another payload')
      return { status: 200, body: { state: 'recorded', reused: true } }
    }
    transaction(db, () => {
      db.prepare('INSERT INTO superagent_bridge_usage(project_id,id,payload,created_at) VALUES (?,?,?,?)').run(projectId, id, payload, now())
      recordUsage?.(usage)
    })
    return { status: 200, body: { state: 'recorded', reused: false } }
  }

  function postArmed(value: unknown): { status: number; body: { ok: true; projectId: number; generation: number } } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid armed body')
    const body = value as Record<string, unknown>
    if (!nonNegativeSafeInt(body.projectId) || !nonNegativeSafeInt(body.generation)) throw new HttpError(400, 'invalid armed fields')
    const projectId = body.projectId
    const armedGeneration = body.generation
    requireProject(projectId, true)
    if (currentOwner() === null) throw new HttpError(403, 'owner unavailable')
    if (armedGeneration !== generation || phase !== 'arming') throw new HttpError(409, 'stale resume generation')
    const expected = db.prepare(`SELECT 1 AS found FROM superagent_bridge_resume
      WHERE generation=? AND project_id=?`).get(armedGeneration, projectId) as { found?: number } | undefined
    if (expected?.found !== 1) throw new HttpError(409, 'project was not requested for resume')
    db.prepare(`UPDATE superagent_bridge_resume SET acked=1
      WHERE generation=? AND project_id=?`).run(armedGeneration, projectId)
    return { status: 200, body: { ok: true, projectId, generation: armedGeneration } }
  }

  function requireHostOwner(): number {
    const owner = currentOwner()
    if (owner === null) throw new HttpError(403, 'owner unavailable')
    return owner
  }

  function requireActiveHost(): number {
    const owner = requireHostOwner()
    if (paused || phase !== 'active') throw new HttpError(409, 'bridge is paused')
    return owner
  }

  function githubBody(value: unknown): { projectId: number; argv: string[] } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid github body')
    const body = value as Record<string, unknown>
    if (!nonNegativeSafeInt(body.projectId) || !Array.isArray(body.argv) || body.argv.length > MAX_GITHUB_ARGV
      || body.argv.some(argument => typeof argument !== 'string' || argument.length > MAX_GITHUB_ARG_LENGTH || argument.includes('\0'))) {
      throw new HttpError(400, 'invalid github argv')
    }
    requireProject(body.projectId, true)
    return { projectId: body.projectId, argv: body.argv as string[] }
  }

  async function postGithub(value: unknown): Promise<{ status: number; body: { stdout: string } }> {
    const input = githubBody(value)
    requireHostOwner()
    if (isGithubMutation(input.argv)) requireActiveHost()
    if (github === undefined) throw new HttpError(404, 'github broker is not configured')
    const result = await github(input.projectId, input.argv)
    if (typeof result?.stdout !== 'string') throw new Error('invalid github broker response')
    return { status: 200, body: result }
  }

  function deliveryBody(value: unknown): { projectId: number; input: unknown } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid delivery body')
    const body = value as Record<string, unknown>
    if (!nonNegativeSafeInt(body.projectId)) throw new HttpError(400, 'invalid delivery project')
    requireProject(body.projectId, true)
    const input = { ...body }
    delete input.projectId
    return { projectId: body.projectId, input }
  }

  async function submitDelivery(value: unknown): Promise<{ status: number; body: unknown }> {
    const input = deliveryBody(value)
    requireActiveHost()
    if (delivery === undefined) throw new HttpError(404, 'delivery broker is not configured')
    return { status: 200, body: await delivery.submit(input.projectId, input.input) }
  }

  function deliveryId(url: URL): string {
    const id = url.searchParams.get('id')
    if (id === null || id.length === 0 || id.length > 512 || id.includes('\0')) throw new HttpError(400, 'invalid delivery id')
    return id
  }

  async function deliveryStatus(url: URL): Promise<{ status: number; body: unknown }> {
    const projectId = parseProjectQuery(url)
    const id = deliveryId(url)
    requireActiveHost()
    if (delivery === undefined) throw new HttpError(404, 'delivery broker is not configured')
    return { status: 200, body: await delivery.status(projectId, id) }
  }

  function parsePositiveQuery(url: URL, name: string): number {
    const value = Number(url.searchParams.get(name))
    if (!positiveSafeInt(value)) throw new HttpError(400, `invalid ${name}`)
    return value
  }

  function parseProjectQuery(url: URL): number {
    const raw = url.searchParams.get('projectId')
    if (raw === null) throw new HttpError(400, 'invalid projectId')
    const value = Number(raw)
    if (!nonNegativeSafeInt(value)) throw new HttpError(400, 'invalid projectId')
    return requireProject(value, true)
  }

  function eventsResponse(url: URL): { paused: boolean; phase: BridgePhase; generation: number; ownerId: number | null; events: SuperagentBridgeEvent[] } {
    const projectId = parseProjectQuery(url)
    const owner = currentOwner()
    if (paused || phase !== 'active' || owner === null) return { paused, phase, generation, ownerId: owner, events: [] }
    const rows = db.prepare(`SELECT id,project_id,update_id,message_id,chat_id,from_id,root_message_id,text,at,reply_to,acked
      FROM superagent_bridge_events WHERE project_id=? AND chat_id=? AND acked=0 ORDER BY rowid LIMIT 20`).all(projectId, owner) as unknown as EventRow[]
    return { paused, phase, generation, ownerId: owner, events: rows.map(eventPayload) }
  }

  function threadResponse(url: URL): { projectId: number; chatId: number; rootMessageId: number; messages: Array<Record<string, unknown>> } {
    const projectId = parseProjectQuery(url)
    const chatId = parsePositiveQuery(url, 'chat')
    const rootMessageId = parsePositiveQuery(url, 'root')
    requireOwnerChat(chatId)
    const exists = db.prepare('SELECT 1 AS found FROM superagent_bridge_events WHERE project_id=? AND chat_id=? AND root_message_id=? LIMIT 1').get(projectId, chatId, rootMessageId) as { found?: number } | undefined
    if (exists?.found !== 1) throw new HttpError(404, 'unknown thread')
    const rows = db.prepare(`SELECT message_id,direction,text,at,reply_to FROM superagent_bridge_messages
      WHERE project_id=? AND chat_id=? AND root_message_id=? ORDER BY rowid`).all(projectId, chatId, rootMessageId) as unknown as MessageRow[]
    return {
      projectId, chatId, rootMessageId,
      messages: rows.map(row => ({
        messageId: Number(row.message_id), direction: row.direction, text: row.text, at: row.at,
        ...(row.reply_to === null ? {} : { replyTo: Number(row.reply_to) }),
      })),
    }
  }

  function assertBoundQuery(url: URL, boundProject: number | undefined): void {
    if (boundProject === undefined) return
    const raw = url.searchParams.get('projectId')
    if (raw === null) throw new HttpError(400, 'invalid projectId')
    const projectId = Number(raw)
    if (!nonNegativeSafeInt(projectId) || projectId !== boundProject) throw new HttpError(403, 'project socket mismatch')
  }

  function assertBoundBody(body: unknown, boundProject: number | undefined): void {
    if (boundProject === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) return
    const projectId = (body as Record<string, unknown>).projectId
    if (nonNegativeSafeInt(projectId) && projectId !== boundProject) throw new HttpError(403, 'project socket mismatch')
  }

  async function handle(req: IncomingMessage, res: ServerResponse, boundProject?: number): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://superagent-bridge.invalid')
      if (req.method === 'GET' && url.pathname === '/events') {
        assertBoundQuery(url, boundProject)
        json(res, 200, eventsResponse(url))
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        const value = counts()
        json(res, 200, { ok: true, paused, ownerId: currentOwner(), pending: value.pending, uncertain: value.uncertain })
        return
      }
      if (req.method === 'GET' && url.pathname === '/thread') {
        assertBoundQuery(url, boundProject)
        json(res, 200, threadResponse(url))
        return
      }
      if (req.method === 'POST' && url.pathname === '/github') {
        const body = await requestBody(req)
        assertBoundBody(body, boundProject)
        const result = await postGithub(body)
        json(res, result.status, result.body)
        return
      }
      if (req.method === 'GET' && url.pathname === '/delivery') {
        assertBoundQuery(url, boundProject)
        const result = await deliveryStatus(url)
        json(res, result.status, result.body)
        return
      }
      if (req.method === 'POST' && url.pathname === '/delivery') {
        const body = await requestBody(req, MAX_DELIVERY_BODY_BYTES)
        assertBoundBody(body, boundProject)
        const result = await submitDelivery(body)
        json(res, result.status, result.body)
        return
      }
      if (req.method === 'POST' && url.pathname === '/ack') {
        const body = await requestBody(req)
        assertBoundBody(body, boundProject)
        if (typeof body !== 'object' || body === null || Array.isArray(body)
          || typeof (body as Record<string, unknown>).id !== 'string'
          || !nonNegativeSafeInt((body as Record<string, unknown>).projectId)) {
          throw new HttpError(400, 'invalid acknowledgement body')
        }
        const input = body as { id: string; projectId: number }
        requireProject(input.projectId, true)
        const event = db.prepare('SELECT project_id,chat_id FROM superagent_bridge_events WHERE id=?').get(input.id) as { project_id?: number; chat_id?: number } | undefined
        if (event === undefined || Number(event.project_id) !== input.projectId) throw new HttpError(404, 'unknown event')
        requireOwnerChat(event.chat_id)
        db.prepare('UPDATE superagent_bridge_events SET acked=1 WHERE id=? AND project_id=?').run(input.id, input.projectId)
        json(res, 200, { ok: true, id: input.id, projectId: input.projectId })
        return
      }
      if (req.method === 'POST' && url.pathname === '/outbox') {
        const body = await requestBody(req)
        assertBoundBody(body, boundProject)
        const result = postOutbox(body)
        json(res, result.status, result.body)
        return
      }
      if (req.method === 'POST' && url.pathname === '/usage') {
        const body = await requestBody(req)
        assertBoundBody(body, boundProject)
        const result = postUsage(body)
        json(res, result.status, result.body)
        return
      }
      if (req.method === 'POST' && url.pathname === '/armed') {
        const body = await requestBody(req)
        assertBoundBody(body, boundProject)
        const result = postArmed(body)
        json(res, result.status, result.body)
        return
      }
      throw new HttpError(404, 'not found')
    } catch (error) {
      errorResponse(res, error)
    }
  }

  async function listenSocket(path: string, boundProject?: number): Promise<ReturnType<typeof createServer>> {
    if (path.length >= 104) throw new Error('socketPath is too long')
    const directory = parentDirectory(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directoryStat = lstatSync(directory)
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) throw new Error('socket parent must be private')
    let existing: ReturnType<typeof lstatSync> | undefined
    try { existing = lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== undefined) {
      if (!existing.isSocket()) throw new Error('refusing to replace non-socket path')
      if (await socketProbe(path) === 'active') throw new Error('socket is already active')
      try { unlinkSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const next = createServer((req, res) => { void handle(req, res, boundProject) })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { next.off('listening', onListening); reject(error) }
        const onListening = () => { next.off('error', onError); resolve() }
        next.once('error', onError)
        next.once('listening', onListening)
        next.listen(path)
      })
      chmodSync(path, 0o600)
      return next
    } catch (error) {
      try { next.close() } catch { /* listener may not have started */ }
      throw error
    }
  }

  async function start(): Promise<void> {
    if (running) return
    if (starting !== undefined) return await starting
    starting = (async () => {
      const specs = listenerSpecs ?? [{ projectId: undefined, socketPath: socketPath! }]
      const opened: ReturnType<typeof createServer>[] = []
      try {
        for (const spec of specs) opened.push(await listenSocket(spec.socketPath, spec.projectId))
        servers = opened
        running = true
        schedulePump()
      } catch (error) {
        await Promise.all(opened.map(closeServer))
        throw error
      }
    })()
    try { await starting } finally { starting = undefined }
  }

  async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    await new Promise<void>(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      server.close(finish)
      void wait(1_000).then(() => {
        if (done) return
        server.closeAllConnections()
        finish()
      })
    })
  }

  async function stop(): Promise<void> {
    running = false
    const currentServers = servers
    servers = []
    await Promise.all(currentServers.map(closeServer))
    const currentSend = activeSend
    if (currentSend !== undefined) await Promise.race([currentSend, wait(SEND_TIMEOUT_MS + 100)])
  }

  function beginResume(projectIds: readonly number[]): number {
    if (!Array.isArray(projectIds)) throw new Error('resume projects must be an array')
    if (!nonNegativeSafeInt(generation) || generation === Number.MAX_SAFE_INTEGER) throw new Error('resume generation exhausted')
    const expected = [...new Set(projectIds)]
    for (const projectId of expected) {
      requireProject(projectId)
      if (listenerSpecs !== undefined && !listenerSpecs.some(listener => listener.projectId === projectId)) {
        throw new Error('project listener unavailable')
      }
    }
    const nextGeneration = generation + 1
    transaction(db, () => {
      db.prepare('DELETE FROM superagent_bridge_resume').run()
      db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('generation', String(nextGeneration))
      db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('phase', 'arming')
      db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('paused', '1')
      for (const projectId of expected) {
        db.prepare('INSERT INTO superagent_bridge_resume(generation,project_id,acked) VALUES (?,?,0)').run(nextGeneration, projectId)
      }
    })
    generation = nextGeneration
    phase = 'arming'
    paused = true
    return generation
  }

  function resumeReady(candidate: number): boolean {
    if (!nonNegativeSafeInt(candidate) || candidate !== generation || phase !== 'arming') return false
    const row = db.prepare(`SELECT COUNT(*) AS expected, COALESCE(SUM(acked),0) AS acknowledged
      FROM superagent_bridge_resume WHERE generation=?`).get(candidate) as { expected?: number; acknowledged?: number }
    return Number(row.expected) === Number(row.acknowledged)
  }

  function activate(candidate: number): void {
    if (!nonNegativeSafeInt(candidate) || candidate !== generation) throw new Error('stale resume generation')
    if (phase !== 'arming') throw new Error('resume is not arming')
    if (!resumeReady(candidate)) throw new Error('resume acknowledgements incomplete')
    transaction(db, () => {
      db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('phase', 'active')
      db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('paused', '0')
    })
    phase = 'active'
    paused = false
    schedulePump()
  }

  function setPaused(value: boolean): void {
    if (typeof value !== 'boolean') throw new Error('paused must be boolean')
    if (value) {
      if (generation === Number.MAX_SAFE_INTEGER) throw new Error('resume generation exhausted')
      const nextGeneration = generation + 1
      transaction(db, () => {
        db.prepare('DELETE FROM superagent_bridge_resume').run()
        db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('generation', String(nextGeneration))
        db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('phase', 'paused')
        db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('paused', '1')
      })
      generation = nextGeneration
      phase = 'paused'
      paused = true
      return
    }
    transaction(db, () => {
      db.prepare('DELETE FROM superagent_bridge_resume').run()
      db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('phase', 'active')
      db.prepare('INSERT INTO superagent_bridge_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('paused', '0')
    })
    phase = 'active'
    paused = false
    schedulePump()
  }

  function isPaused(): boolean { return paused }

  return { enqueue, ownsReply, replyProject, listUncertain, retryUncertain, dismissUncertain, beginResume, resumeReady, activate, isPaused, status, start, stop, setPaused }
}
