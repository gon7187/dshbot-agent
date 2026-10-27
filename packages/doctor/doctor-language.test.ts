// The recovery doctor answers in the language of the owner: its system prompt
// no longer pins Russian. The doctor runs as a child process against local Bot
// API / Messages API doubles, like recovery.test.ts; the test reads the system
// prompt of the first model request.
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 7123458
const TOKEN = '7000003:AAHLanguageFixtureToken0123456789'
const KEY = 'sk-language-fixture-deepseek-0123456789'
const MARKER = 'doctor-language-case-1'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type Obj = Record<string, unknown>

function object(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block === 'string' ? block : String(object(block).text ?? ''))).join('')
}

let scratch = ''
let child: ChildProcess | undefined
let output = ''
const servers: Server[] = []

afterEach(async () => {
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  child = undefined
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

/** Runs the doctor against doubles and returns the system prompt of its first model request. */
async function doctorSystemPrompt(): Promise<string> {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-doctor-lang-')))
  const userHome = join(scratch, 'user')
  const home = join(userHome, '.local/share/dshbot')
  const bin = join(scratch, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  const db = new DatabaseSync(join(home, 'state.db'))
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('telegram.owner_chat_id', String(OWNER))
  db.close()
  // the main unit is down: the doctor stays and listens to the owner
  const preamble = `#!${process.execPath}\n`
  writeFileSync(join(bin, 'systemctl'), `${preamble}console.log('failed'); process.exit(3);\n`)
  writeFileSync(join(bin, 'journalctl'), `${preamble}console.log('journal-line');\n`)
  chmodSync(join(bin, 'systemctl'), 0o755)
  chmodSync(join(bin, 'journalctl'), 0o755)

  const systems: string[] = []
  const queue: Obj[] = []
  let seq = 0
  let sent = false
  const tg = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const method = (req.url ?? '').split('?')[0]?.split('/').at(-1) ?? ''
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (method === 'getUpdates') {
        if (!sent) {
          sent = true
          reply([
            {
              update_id: ++seq,
              message: {
                message_id: ++seq,
                date: Math.floor(Date.now() / 1000),
                from: { id: OWNER, is_bot: false, first_name: 'Fixture' },
                chat: { id: OWNER, type: 'private' },
                text: `${MARKER} how is the bot?`,
              },
            },
          ])
          return
        }
        const timer = setTimeout(() => reply(queue.splice(0)), 1_000)
        res.on('close', () => clearTimeout(timer))
        return
      }
      let params: Obj = {}
      try {
        params = object(JSON.parse(raw))
      } catch {
        // form-encoded or empty: no fields needed
      }
      if (method === 'getMe') return reply({ id: 1, is_bot: true, first_name: 'Doctor', username: 'doctor_fixture_bot' })
      reply({ message_id: ++seq, date: 1, chat: { id: OWNER, type: 'private' }, text: String(params.text ?? '') })
    })
  })
  servers.push(tg)
  const tgOrigin = await listen(tg)

  const model = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const request = object(JSON.parse(raw))
      systems.push(flatten(request.system))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [{ type: 'text', text: 'doctor-language-answer' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      )
    })
  })
  servers.push(model)
  const modelOrigin = await listen(model)

  child = spawn(process.execPath, ['./packages/doctor/bin/doctor.ts'], {
    cwd: root,
    env: {
      HOME: userHome,
      PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      DSHBOT_HOME: home,
      TELEGRAM_BOT_TOKEN: TOKEN,
      DEEPSEEK_API_KEY: KEY,
      // The prompt arrives only after the grace window when the unit is down;
      // the window itself is covered by restart-grace-window.test.ts.
      DSHBOT_DOCTOR_GRACE_MS: '1',
      TELEGRAM_API_ROOT: `${tgOrigin}/telegram-fixture`,
      DEEPSEEK_BASE_URL: `${modelOrigin}/model-fixture/anthropic`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const until = Date.now() + 30_000
  while (systems.length === 0 && Date.now() < until) await sleep(25)
  expect(systems.length, `the doctor never asked the model\n${output}`).toBeGreaterThan(0)
  const system = systems[0] as string
  expect(system, 'the doctor prompt must reach the model').toContain('доктор')
  return system
}

test('test_c5_doctor_prompt_replies_in_the_language_of_the_interlocutor_and_does_not_pin_russian', { timeout: 60_000 }, async () => {
  const system = await doctorSystemPrompt()
  expect(system).not.toMatch(/Отвечай по-русски/i)
  expect(system, 'the doctor must answer in the language of the interlocutor').toMatch(
    /на\s+(?:том\s+)?язык\S*[^.\n]{0,40}(?:собеседник|владел|пишет|вопрос|обращ)|language\s+of\s+(?:the\s+)?(?:owner|interlocutor|user)/i,
  )
  // the rest of the meaning stays: brief, to the point, say what was checked
  expect(system).toMatch(/коротко/i)
  expect(system).toMatch(/провер/i)
})
