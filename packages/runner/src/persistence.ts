// A small durable session backend for the runner.
//
// The harness ships the session-persistence contract but not a storage backend in the
// minimal dependency set, so the runner owns one: one directory per session under
// `$DSH_HOME/sessions`, a JSON header and an append-only JSONL event log. The service
// also routes live `session/event` appends and `session/flush` checkpoints into the open
// write handle, which is the persistence wiring the product bundles normally provide.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'

const HEADER_FILE = 'session.json'
const META_FILE = 'storage.json'
const EVENTS_FILE = 'events.jsonl'
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export interface JsonlSessionPersistenceConfig {
  /** Directory that receives one subdirectory per session. */
  root: string
}

function safeId(id: SessionId): string {
  const value = String(id)
  if (!SAFE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`session id "${value}" is not usable as a directory name`)
  }
  return value
}

function readInherited(directory: string): number {
  const file = join(directory, META_FILE)
  if (!existsSync(file)) return 0
  const meta = JSON.parse(readFileSync(file, 'utf8')) as { inheritedEventCount?: unknown }
  return typeof meta.inheritedEventCount === 'number' ? meta.inheritedEventCount : 0
}

function readEvents(file: string): SessionEvent[] {
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8')
  const events: SessionEvent[] = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as SessionEvent)
    } catch (error) {
      // A crash can leave a torn final record. Never resurrect it, and never reject
      // the whole session because of it.
      if (index === lines.length - 1) break
      throw error
    }
  }
  return events
}

class JsonlSessionHandle implements SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly access: SessionAccess

  private readonly eventsFile: string
  private events: SessionEvent[]
  private closed = false
  private tail: Promise<void> = Promise.resolve()
  private readonly release: () => void

  constructor(directory: string, header: SessionHeader, inheritedEventCount: SessionLogOffset, access: SessionAccess, events: SessionEvent[], release: () => void) {
    this.eventsFile = join(directory, EVENTS_FILE)
    this.id = header.id
    this.header = header
    this.inheritedEventCount = inheritedEventCount
    this.access = access
    this.events = events
    this.release = release
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, operation)
  }

  private assertWritable(operation: string): void {
    this.assertOpen(operation)
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, operation)
  }

  async read(offset = 0, length?: number, _options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    const start = Math.max(0, Math.trunc(offset))
    const end = length === undefined ? this.events.length : start + Math.max(0, Math.trunc(length))
    // The caller may adopt the values without copying, so hand over an independent graph.
    const events = structuredClone(this.events.slice(start, end))
    return { eventState: 'detached', events }
  }

  append(events: readonly SessionEvent[], _options?: SessionHandleAppendOptions): Promise<void> {
    try {
      this.assertWritable('append')
    } catch (error) {
      return Promise.reject(error)
    }
    const batch = structuredClone(events)
    const next = this.tail.then(() => this.write(batch))
    // Keep the queue usable after one failed batch; the failure still reaches the caller.
    this.tail = next.catch(() => undefined)
    return next
  }

  private async write(batch: readonly SessionEvent[]): Promise<void> {
    this.assertWritable('append')
    let next = this.events.length
    for (const event of batch) {
      if (event.seq !== next) {
        throw new Error(`append seq mismatch for "${String(this.id)}": expected ${next}, got ${event.seq}`)
      }
      next += 1
    }
    const body = batch.map((event) => `${JSON.stringify(event)}\n`).join('')
    if (body !== '') appendFileSync(this.eventsFile, body, 'utf8')
    this.events.push(...batch)
  }

  async flush(_options?: SessionHandleFlushOptions): Promise<void> {
    this.assertWritable('flush')
    await this.tail
    // Every append above is already a synchronous write, so the barrier only has to
    // wait for the queued batch and re-check that this handle still owns the session.
    this.assertOpen('flush')
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.tail
    } finally {
      this.closed = true
      this.release()
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

export class JsonlSessionPersistence extends SessionPersistence {
  private readonly root: string
  private readonly handles = new Map<string, JsonlSessionHandle>()

  constructor(ctx: Context, config: JsonlSessionPersistenceConfig) {
    super(ctx)
    this.root = config.root
    mkdirSync(this.root, { recursive: true })
    ctx.on('session/event', (session, event) => {
      const handle = this.handles.get(String(session.id))
      if (handle === undefined) return
      handle.append([event]).catch((error: unknown) => {
        ctx.logger.error(`session "${String(session.id)}" append failed: ${String(error)}`)
      })
    })
    ctx.on('session/flush', async (session) => {
      const handle = this.handles.get(String(session.id))
      if (handle !== undefined) await handle.flush()
    })
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const directory = join(this.root, safeId(header.id))
    try {
      mkdirSync(directory, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SessionAlreadyExistsError(header.id)
      throw error
    }
    writeFileSync(join(directory, `${HEADER_FILE}.tmp`), `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(join(directory, `${HEADER_FILE}.tmp`), join(directory, HEADER_FILE))
    writeFileSync(join(directory, META_FILE), `${JSON.stringify({ inheritedEventCount: options?.inheritedEventCount ?? 0 })}\n`, { encoding: 'utf8', flag: 'wx' })
    writeFileSync(join(directory, EVENTS_FILE), '', { encoding: 'utf8', flag: 'wx' })
    return this.openWrite(header, options?.inheritedEventCount ?? SessionLogOffset(0), [], directory)
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const directory = join(this.root, safeId(id))
    const headerFile = join(directory, HEADER_FILE)
    if (!existsSync(headerFile)) throw new SessionPersistenceNotFoundError(id)
    const header = JSON.parse(readFileSync(headerFile, 'utf8')) as SessionHeader
    // The runner only creates fresh sessions and never forks, so a missing storage
    // record is a fresh (non-seeded) session.
    const inherited = SessionLogOffset(readInherited(directory))
    const events = readEvents(join(directory, EVENTS_FILE))
    if (access === 'read') return new JsonlSessionHandle(directory, header, inherited, 'read', events, () => {})
    if (this.handles.has(String(id))) throw new SessionAlreadyOwnedError(id)
    return this.openWrite(header, inherited, events, directory)
  }

  private openWrite(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: SessionEvent[], directory: string): JsonlSessionHandle {
    const key = String(header.id)
    const handle = new JsonlSessionHandle(directory, header, inheritedEventCount, 'write', events, () => {
      if (this.handles.get(key) === handle) this.handles.delete(key)
    })
    this.handles.set(key, handle)
    return handle
  }

  async flush(): Promise<void> {
    const failures: unknown[] = []
    for (const handle of [...this.handles.values()]) {
      try {
        await handle.flush()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'session persistence flush failed')
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const directory = join(this.root, safeId(id))
    const headerFile = join(directory, HEADER_FILE)
    if (!existsSync(headerFile)) return undefined
    const header = JSON.parse(readFileSync(headerFile, 'utf8')) as SessionHeader
    const events = readEvents(join(directory, EVENTS_FILE))
    return {
      header,
      formatStatus: 'current',
      revision: SessionPersistenceRevision(`jsonl:${events.length}`),
      eventCount: events.length,
    }
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    const snapshots: SessionPersistenceSnapshot[] = []
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const snapshot = await this.stat(entry.name as SessionId, options)
      if (snapshot !== undefined) snapshots.push(snapshot)
    }
    return snapshots
  }
}
