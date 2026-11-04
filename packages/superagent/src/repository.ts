import type { DatabaseSync } from 'node:sqlite'
import { latestAssignment, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from './core/model.js'
import type { Repositories } from './core/ports.js'

type Table = 'triggers' | 'dispositions' | 'threads' | 'tickets' | 'decisions'
let savepointId = 0

/** Domain records in DSHBOT's shared database; the caller owns the connection. */
export class SqliteRepositories implements Repositories {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    this.atomic(() => db.exec(`
      CREATE TABLE IF NOT EXISTS superagent_triggers (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS superagent_dispositions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS superagent_threads (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS superagent_tickets (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS superagent_decisions (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS superagent_decisions_thread ON superagent_decisions(thread);
    `))
  }

  atomic<T>(work: () => T): T {
    const name = `superagent_atomic_${++savepointId}`
    this.db.exec(`SAVEPOINT ${name}`)
    try {
      const result = work()
      this.db.exec(`RELEASE SAVEPOINT ${name}`)
      return result
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`)
      throw error
    }
  }

  private get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM superagent_${table} WHERE id=?`).get(id)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }

  private save(table: Exclude<Table, 'decisions'>, id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO superagent_${table} (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`)
      .run(id, JSON.stringify(value))
  }

  private list<T>(table: Table, newestFirst = false): T[] {
    return this.db.prepare(`SELECT value FROM superagent_${table} ORDER BY rowid ${newestFirst ? 'DESC' : 'ASC'}`)
      .all().map(row => JSON.parse(String(row.value)) as T)
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.get('triggers', id),
    save: (trigger: Trigger): void => this.save('triggers', trigger.id, trigger),
    disposition: (id: string): TriggerDisposition | undefined => this.get('dispositions', id),
    saveDisposition: (id: string, value: TriggerDisposition): void => this.save('dispositions', id, value),
  }

  // shortcut: working sets scan this personal bot's records; add indexed projections if history outgrows memory.
  readonly threads = {
    get: (key: string): Thread | undefined => this.get('threads', key),
    save: (thread: Thread): void => this.save('threads', thread.key, thread),
    list: (): Thread[] => this.list('threads'),
    active: (): Thread[] => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.get('tickets', id),
    save: (ticket: Ticket): void => this.save('tickets', ticket.id, ticket),
    list: (): Ticket[] => this.list('tickets', true),
    open: (): Ticket[] => this.tickets.list().filter(ticket => !ticket.ended),
    active: (): Ticket[] => this.tickets.list().filter(ticket => ticket.undelivered.length > 0
      || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.get('decisions', id),
    save: (decision: Decision): void => {
      this.db.prepare(`INSERT INTO superagent_decisions (id,thread,value) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET thread=excluded.thread,value=excluded.value`)
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
    },
    byThread: (key: string): Decision[] => this.db.prepare('SELECT value FROM superagent_decisions WHERE thread=? ORDER BY rowid')
      .all(key).map(row => JSON.parse(String(row.value)) as Decision),
  }
}
