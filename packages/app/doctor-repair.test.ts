import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import {
  BOT_TOKEN, DEEPSEEK_KEY, OWNER_CHAT, TEST_TIMEOUT_MS, asObject,
  say, startOwnerDaemon, waitFor, world,
} from './test-support/wake-harness.js'

const doctorUrl = new URL('./src/doctor.ts', import.meta.url).href

function installDoctorFixture(): string {
  const shim = join(world.home, 'doctor-fixture.mjs')
  const hook = join(world.home, 'doctor-hook.mjs')
  const mode = join(world.home, 'doctor-mode')
  writeFileSync(mode, 'problems')
  writeFileSync(shim, `
import { readFileSync } from 'node:fs'
import * as real from ${JSON.stringify(doctorUrl)}
export * from ${JSON.stringify(doctorUrl)}
export async function runDoctor(deps) {
  const checks = await real.runDoctor({ ...deps, deepseek: { ...deps.deepseek,
    fetch: async () => new Response('probe failure ' + process.env.TELEGRAM_BOT_TOKEN + ' ' + process.env.DEEPSEEK_API_KEY, { status: 500 }) } })
  if (readFileSync(${JSON.stringify(mode)}, 'utf8') === 'ok') return checks.map(c => ({ ...c, status: 'ok', text: c.id + ': ✅ ок — исправно' }))
  return checks
}
export async function doctorReport(deps) { return real.formatDoctorReport(await runDoctor(deps)) }
`)
  writeFileSync(hook, `
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/packages/app/src/index.') && /\\/doctor\\.js$/.test(specifier))
    return { url: ${JSON.stringify(pathToFileURL(shim).href)}, shortCircuit: true }
  return next(specifier, context)
} })
`)
  return mode
}

type Task = { id: string; goal: string; state: string; session_id: string }
function tasks(): Task[] {
  const db = new DatabaseSync(join(world.dshbotHome, 'state.db'), { readOnly: true })
  try { return db.prepare('SELECT id, goal, state, session_id FROM tasks').all() as Task[] } finally { db.close() }
}

function reportEvents() {
  return world.timeline.events.filter(event => event.src === 'tg' && ['sendMessage', 'sendRichMessage'].includes(event.method) &&
    String(event.params.text ?? asObject(event.params.rich_message).markdown ?? '').includes('Самодиагностика бота'))
}

function button(markup: unknown): string | undefined {
  const rows = asObject(markup).inline_keyboard
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) if (Array.isArray(row)) for (const item of row) {
    const value = asObject(item)
    if (value.text === 'Починить' && typeof value.callback_data === 'string') return value.callback_data
  }
  return undefined
}

function click(data: string, id: number, user: number, messageId: number): void {
  world.tg.push({ update_id: id, callback_query: {
    id: `doctor-${id}`, from: { id: user, is_bot: false, first_name: 'Test' },
    chat_instance: 'doctor', data, message: { message_id: messageId, date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER_CHAT, type: 'private' }, text: 'Самодиагностика бота' },
  } })
}

function callbackAnswer(id: number): string | undefined {
  const event = world.timeline.events.find(event => event.src === 'tg' && event.method === 'answerCallbackQuery' && event.params.callback_query_id === `doctor-${id}`)
  return event?.src === 'tg' ? String(event.params.text ?? '') : undefined
}

test('c1 c2 c3 c4 c5 doctor repair uses a task and deduplicates callbacks', { timeout: TEST_TIMEOUT_MS }, async () => {
  const mode = installDoctorFixture()
  const hook = pathToFileURL(join(world.home, 'doctor-hook.mjs')).href
  let release: (() => void) | undefined
  const held = new Promise<void>(resolve => { release = resolve })
  world.stub.wake[0] = async () => { await held; return { text: 'done' } }
  const d = await startOwnerDaemon({ fakeTask: false, env: { NODE_OPTIONS: `--import ${hook}`, DSHBOT_AUTONOMY: 'observe' } })
  try {
    say(OWNER_CHAT, '/doctor')
    await waitFor('the problem report', () => reportEvents().length === 1, d)
    const report = reportEvents()[0]!
    if (report.src !== 'tg') throw new Error('expected Telegram report')
    const lines = String(report.params.text ?? asObject(report.params.rich_message).markdown).split('\n').map(line => line.trim())
    const problems = lines.filter(line => /(?:⚠|❌)/.test(line))
    const healthy = lines.filter(line => line.includes('✅'))
    expect(problems.some(line => line.includes('⚠'))).toBe(true)
    expect(problems.some(line => line.includes('❌'))).toBe(true)
    expect(healthy.length).toBeGreaterThan(0)
    const data = button(report.params.reply_markup)
    expect(data, 'a report with problems offers repair').toBeDefined()
    if (!data) return
    const sentBeforeReport = world.timeline.events.filter(event => event.src === 'tg' && ['sendMessage', 'sendRichMessage'].includes(event.method) && event.n <= report.n).length
    const messageId = 9000 + sentBeforeReport
    click(data, 970001, OWNER_CHAT + 1, messageId)
    await waitFor('unauthorized callback answer', () => callbackAnswer(970001) !== undefined, d)
    expect(callbackAnswer(970001)).toContain('Недостаточно прав')
    expect(tasks()).toHaveLength(0)
    click(data, 970002, OWNER_CHAT, messageId)
    await waitFor('repair task', () => tasks().length > 0 && callbackAnswer(970002) !== undefined, d)
    const task = tasks()[0]!
    expect(tasks()).toHaveLength(1)
    expect(task.session_id).toMatch(/^task-/)
    for (const line of problems) expect(task.goal).toContain(line)
    for (const line of healthy) expect(task.goal).not.toContain(line)
    expect(task.goal).not.toContain(BOT_TOKEN)
    expect(task.goal).not.toContain(DEEPSEEK_KEY)
    expect(lines.join('\n')).toContain('[скрыто]')
    expect(callbackAnswer(970002)).toContain(task.id)
    expect(callbackAnswer(970002)).toMatch(/запущ|начат/i)
    click(data, 970003, OWNER_CHAT, messageId)
    await waitFor('duplicate callback answer', () => callbackAnswer(970003) !== undefined, d)
    expect(tasks()).toHaveLength(1)
    expect(callbackAnswer(970003)).toContain(task.id)
    expect(callbackAnswer(970003)).toMatch(/уже|идёт|идет/i)
    writeFileSync(mode, 'ok')
    say(OWNER_CHAT, '/doctor')
    await waitFor('the healthy report', () => reportEvents().length === 2, d)
    const healthyReport = reportEvents()[1]!
    if (healthyReport.src !== 'tg') throw new Error('expected Telegram report')
    expect(button(healthyReport.params.reply_markup)).toBeUndefined()
  } finally { release?.() }
})
