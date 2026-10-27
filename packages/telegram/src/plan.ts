// Editable task plan. Telegram's real checklists (sendChecklist /
// editMessageChecklist) require a business_connection_id and are unavailable to a
// regular private-chat bot, so the plan rides on rich-message list items with
// has_checkbox/is_checked. A 400 on the rich edit falls back to plain HTML with
// ☑/☐ so the plan stays useful on older clients.

import type { TelegramApi } from './api.js'

export interface PlanTask {
  title: string
  done: boolean
}

export interface Plan {
  /** Markdown checklist: `- [x]` for done tasks, `- [ ]` for open ones. */
  render(tasks: readonly PlanTask[]): string
  /** Toggle item `index` and edit the plan message. */
  update(index: number, checked: boolean): Promise<void>
}

export function renderPlan(tasks: readonly PlanTask[]): string {
  return tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.title}`).join('\n')
}

// --- the progress card -------------------------------------------------------------------------
//
// The `plan` tool rides on one plain HTML message edited in place. Telegram's
// real checklist objects need a business connection, and rich list items carry
// only a checkbox, so four states (pending, in progress, done, error) are told
// apart by the mark at the start of a step line. The mark is part of the same
// line as the title: a reader (and a test) can take a line and see the state.

export type PlanStatus = 'pending' | 'in_progress' | 'done' | 'error'

/** Every status the model may name, in the order of a task's life. */
export const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'done', 'error']

export interface PlanStep {
  title: string
  status: PlanStatus
}

/** The mark of one state. All four are different, whatever the client draws. */
const PLAN_STATUS_MARKS: Record<PlanStatus, string> = {
  pending: '☐',
  in_progress: '◐',
  done: '☑',
  error: '⚠',
}

/** The card as HTML: one `<mark> <title>` line per step and a summary of the states. */
export function renderPlanCard(steps: readonly PlanStep[]): string {
  const count = (status: PlanStatus): number => steps.filter((step) => step.status === status).length
  const summary = [
    `${PLAN_STATUS_MARKS.done} ${count('done')}`,
    `${PLAN_STATUS_MARKS.in_progress} ${count('in_progress')}`,
    `${PLAN_STATUS_MARKS.pending} ${count('pending')}`,
    `${PLAN_STATUS_MARKS.error} ${count('error')}`,
  ].join(' · ')
  const lines = steps.map((step) => `${PLAN_STATUS_MARKS[step.status]} ${escapeHtml(step.title)}`)
  return `<b>План задачи</b>\n${summary}\n\n${lines.join('\n')}`
}

/**
 * Send the first state of a card into `chatId` (and the forum topic of the
 * turn) and return its message id. The id is the handle every later state edits.
 */
export async function sendPlanCard(
  api: TelegramApi,
  chatId: number,
  steps: readonly PlanStep[],
  threadId?: number,
): Promise<number> {
  const message = await api.call<{ message_id?: unknown }>('sendMessage', {
    chat_id: chatId,
    text: renderPlanCard(steps),
    parse_mode: 'HTML',
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  })
  const messageId = message?.message_id
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new Error('sendMessage: Telegram не вернул message_id')
  }
  return messageId
}

/** Replace the state of an existing card in place: the chat gets no new message. */
export async function editPlanCard(
  api: TelegramApi,
  chatId: number,
  messageId: number,
  steps: readonly PlanStep[],
): Promise<void> {
  await api.call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: renderPlanCard(steps),
    parse_mode: 'HTML',
  })
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderPlanHtml(tasks: readonly PlanTask[]): string {
  const done = tasks.filter((task) => task.done).length
  const remaining = tasks.length - done
  // The summary always carries both symbols, including when every item is checked.
  const summary = `☑ ${done} · ☐ ${remaining}`
  const lines = tasks.map((task) => `${task.done ? '☑' : '☐'} ${escapeHtml(task.title)}`)
  return `<b>План задачи</b>\n${summary}\n\n${lines.join('\n')}`
}

function richPlan(tasks: readonly PlanTask[]): Record<string, unknown> {
  return {
    blocks: [
      {
        type: 'list',
        items: tasks.map((task) => ({
          has_checkbox: true,
          is_checked: task.done,
          blocks: [{ type: 'paragraph', text: task.title }],
        })),
      },
    ],
  }
}

function isBadRequest(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { errorCode?: unknown }).errorCode === 400
}

/** Send the initial plan message and return the editor bound to it. */
export async function createPlan(
  api: TelegramApi,
  chatId: number,
  tasks: readonly PlanTask[],
): Promise<Plan> {
  const items = tasks.map((task) => ({ title: task.title, done: task.done }))
  const message = await api.call<{ message_id?: number }>('sendMessage', {
    chat_id: chatId,
    text: renderPlan(items),
  })
  const messageId = message?.message_id

  const update = async (index: number, checked: boolean): Promise<void> => {
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new RangeError(`plan item index out of range: ${index}`)
    }

    const previous = items[index].done
    items[index].done = checked
    const target = messageId === undefined ? { chat_id: chatId } : { chat_id: chatId, message_id: messageId }
    try {
      await api.call('editMessageText', {
        ...target,
        rich_message: richPlan(items),
      })
    } catch (error) {
      if (!isBadRequest(error)) {
        items[index].done = previous
        throw error
      }
      try {
        await api.call('editMessageText', {
          ...target,
          text: renderPlanHtml(items),
          parse_mode: 'HTML',
        })
      } catch (fallbackError) {
        // Neither representation reached the chat: keep the local plan honest.
        items[index].done = previous
        throw fallbackError
      }
    }
  }

  return { render: renderPlan, update }
}
