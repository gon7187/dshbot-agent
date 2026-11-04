import type { DatabaseSync } from 'node:sqlite'
import type { Factory, FactoryTask } from '../../factory/src/index.js'
import { Engine } from './core/engine.js'
import { latestAssignment, type ReportState, type Ticket } from './core/model.js'
import { SqliteRepositories } from './repository.js'

export function createSuperagent(options: {
  db: DatabaseSync
  factory: Pick<Factory, 'createTask' | 'findTask' | 'listTasks'>
  ownerId: () => number | null
}): { submit(input: { chatId: number; updateId: number; text: string }): FactoryTask; status(chatId: number): string } {
  const { db, factory, ownerId } = options
  let state: ReturnType<typeof initialize> | undefined

  function requireOwner(chatId: number): void {
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== ownerId()) throw new Error('Команда доступна только владельцу.')
  }

  function initialize() {
    const repo = new SqliteRepositories(db)
    db.exec('CREATE TABLE IF NOT EXISTS superagent_factory_tasks (ticket_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL UNIQUE)')
    const engine = new Engine({
      repo,
      policy: () => ({
        version: `telegram-owner:${ownerId()}`,
        paused: false,
        gate: trigger => trigger.source === 'telegram' && trigger.human && trigger.addressed === 'direct'
          && trigger.actor.id === String(ownerId())
          ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', source: 'telegram', sender: trigger.actor.id } }
          : { admissible: false, reason: 'ownerRequired' },
        revalidate: mandate => mandate.actor.source === 'telegram' && mandate.actor.id === String(ownerId()),
        admitsInferred: () => false,
        evalTimeoutMs: 60_000,
      }),
      scope: { scope: input => input.source === 'telegram' && input.meta.chatId === ownerId()
        ? { listened: true, observed: false } : { listened: false, reason: 'ownerRequired' } },
      assessor: { request: () => { throw new Error('Explicit commands do not use model assessment') } },
      // Pending assignments and undelivered inputs are already durable in the repository; commands drain them below.
      executor: { start() {}, deliver() {}, stop() {} },
      outbox: {
        send: () => { throw new Error('Superagent output belongs to the factory') },
        status: () => undefined,
        withdraw() {},
      },
    })
    return { repo, engine }
  }

  function context() { return state ??= initialize() }

  function relevant(ticket: Ticket, chatId: number): boolean {
    return ticket.mandate.actor.source === 'telegram' && ticket.mandate.actor.id === String(chatId)
  }

  function synchronize(ticket: Ticket): FactoryTask {
    const { repo, engine } = context()
    const mapping = db.prepare('SELECT task_id FROM superagent_factory_tasks WHERE ticket_id=?').get(ticket.id)
    let task: FactoryTask | undefined
    if (mapping) {
      task = factory.findTask(Number(mapping.task_id))
      if (!task) throw new Error(`Задача фабрики #${mapping.task_id} не найдена`)
    } else {
      if (ticket.ended || latestAssignment(ticket)?.state !== 'pending') throw new Error('Связь с задачей фабрики отсутствует')
      const trigger = repo.triggers.get(ticket.origin.triggerId)
      if (!trigger) throw new Error('Исходная команда задачи не найдена')
      task = factory.createTask({ text: trigger.text, title: ticket.title, requestId: `superagent:${ticket.id}` })
      db.prepare('INSERT INTO superagent_factory_tasks (ticket_id,task_id) VALUES (?,?)').run(ticket.id, task.id)
    }
    if (ticket.ended) return task
    const assignment = latestAssignment(ticket)
    if (!assignment) throw new Error('Назначение задачи отсутствует')
    if (assignment.state === 'pending') engine.assignmentStarted(ticket.id, assignment.id)
    const pending = repo.tickets.get(ticket.id)!.undelivered
    if (pending.length) {
      engine.inputsDelivered(ticket.id, assignment.id, pending)
      engine.inputsRead(ticket.id, pending)
    }
    const report: ReportState = task.status === 'merged' ? 'ready' : task.status === 'rejected' ? 'dropped'
      : task.status === 'awaiting_approval' ? 'waiting' : task.status === 'awaiting_human' ? 'blocked' : 'progress'
    if (assignment.report?.state !== report || assignment.report.summary !== task.status) {
      engine.report(ticket.id, { state: report, summary: task.status })
    }
    return task
  }

  // shortcut: lifecycle reconciliation runs only on owner commands; use a durable worker if idle-time updates become necessary.
  function drain(chatId: number) {
    return context().repo.tickets.list().filter(ticket => relevant(ticket, chatId)).map(ticket => {
      try { return { ticket, task: synchronize(ticket) } }
      catch (error) { return { ticket, error: error instanceof Error ? error.message : String(error) } }
    })
  }

  return {
    submit(input) {
      requireOwner(input.chatId)
      if (!Number.isSafeInteger(input.updateId) || input.updateId < 0) throw new Error('Некорректный update_id')
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 16_000) throw new Error('Задача должна содержать от 1 до 16000 символов')
      const { engine } = context()
      const id = `telegram:${input.chatId}:${input.updateId}`
      engine.receive({
        id, source: 'telegram', threads: [{ source: 'telegram', id: `${input.chatId}:${input.updateId}` }],
        actor: { source: 'telegram', id: String(input.chatId) }, human: true, addressed: 'direct',
        at: new Date().toISOString(), text: input.text.trim(), meta: { chatId: input.chatId, updateId: input.updateId },
      })
      const decision = engine.decide(id, { kind: 'accept', title: input.text.trim().split('\n')[0]!.slice(0, 120),
        scope: 'Execute through the existing factory approval, review and gate workflow', reason: 'Explicit owner command' })
      if (!decision.ticketId) throw new Error('Команда не создала задачу')
      const result = drain(input.chatId).find(item => item.ticket.id === decision.ticketId)
      if (!result?.task) throw new Error(result?.error ?? 'Связь с задачей фабрики отсутствует')
      return result.task
    },
    status(chatId) {
      requireOwner(chatId)
      const rows = drain(chatId).slice(0, 10).map(item => item.task
        ? `#${item.task.id} — ${item.task.status}`
        : `#? — ${item.error}`)
      return ['/superagent new <задача>', ...rows, rows.length ? '' : 'Задач пока нет.',
        'Одобрение и управление задачами: /factory'].filter(Boolean).join('\n')
    },
  }
}
