import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

// Sign-in to openai-codex (ChatGPT) by the device code, headless: the runner runs in a child process whose global
// fetch answers for the authorization server (auth.openai.com) itself, as the zai address is redirected in
// model-providers.test.ts. The interaction picks "device code" in the method question; the notice with the
// verification page must carry the address and the code of the device as separate fields (notify receives an object
// with `url` and `code`, not one glued string); the server then confirms and hands out tokens, and the sign-in is
// saved. No request leaves for the real auth.openai.com: the stand-in answers every request to that host itself.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 120_000
const RESULT_MARK = '@@DEVICE-CODE-RESULT@@'

const USER_CODE = 'WXYZ-4821'
const VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const DEEPSEEK_KEY = 'sk-ds-device-code-test-0123456789abcdef'

const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const requests = []
const realFetch = globalThis.fetch
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
const accessToken = [b64({ alg: 'none' }), b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-device-test' } }), 'sig'].join('.')
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(raw)
  if (url.hostname !== 'auth.openai.com') return realFetch(input, init)
  requests.push(url.pathname)
  if (url.pathname === '/api/accounts/deviceauth/usercode') {
    return json({ device_auth_id: 'dev-auth-1', user_code: cfg.userCode, interval: '1' })
  }
  if (url.pathname === '/api/accounts/deviceauth/token') {
    return json({ authorization_code: 'authz-code-1', code_verifier: 'verifier-1' })
  }
  if (url.pathname === '/oauth/token') {
    return json({ access_token: accessToken, refresh_token: 'refresh-device-test', expires_in: 3600 })
  }
  return json({ error: 'unexpected' }, 404)
}

const out = { asked: [], notices: [], requests }
try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.deepseekKey,
    systemPrefix: 'Device code sign-in.',
  })
  try {
    out.before = (await runner.providers()).find((row) => row.id === 'openai-codex')
    const result = await runner.connectProvider('openai-codex', {
      prompt: async (request) => {
        out.asked.push(request)
        if (request.kind === 'select') {
          const option = (request.options || []).find((entry) => /device/i.test(entry.id + ' ' + entry.label))
          return option ? option.id : undefined
        }
        return undefined
      },
      notify: (notice) => {
        out.notices.push(notice)
      },
    })
    out.status = result.status
    out.after = (await runner.providers()).find((row) => row.id === 'openai-codex')
  } finally {
    await runner.stop()
  }
} catch (error) {
  out.error = String(error && error.stack ? error.stack : error)
  process.exitCode = 1
}
console.log('${RESULT_MARK}' + JSON.stringify(out))
setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref()
`

interface ProviderRow {
  id: string
  connected: boolean
}

interface Report {
  asked: Array<{ kind: string; message: string; options?: Array<{ id: string; label: string }> }>
  notices: unknown[]
  requests: string[]
  before?: ProviderRow
  after?: ProviderRow
  status?: string
  error?: string
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-device-code-'))
  mkdirSync(join(scratch, 'workspace'), { recursive: true })
  mkdirSync(join(scratch, 'state'), { recursive: true })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

async function runDriver(): Promise<Report> {
  const script = join(scratch, 'driver.mjs')
  writeFileSync(script, DRIVER_SOURCE)
  const cfg = {
    entry: runnerEntry,
    dshHome: join(scratch, 'state', 'dsh'),
    cwd: join(scratch, 'workspace'),
    // Nothing in this scenario asks the model; the address only has to be well formed.
    baseUrl: 'http://127.0.0.1:9/anthropic',
    deepseekKey: DEEPSEEK_KEY,
    userCode: USER_CODE,
  }
  const env = { PATH: process.env.PATH ?? '', HOME: scratch, USERPROFILE: scratch, DEEPSEEK_API_KEY: DEEPSEEK_KEY }
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(repoRoot, 'packages/app/register.mjs'), script, JSON.stringify(cfg)], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
    child.stdout.on('data', (data: Buffer) => {
      text += data.toString('utf8')
    })
    child.stderr.on('data', (data: Buffer) => {
      text += data.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(text)
    })
  })
  const line = output.split('\n').find((candidate) => candidate.startsWith(RESULT_MARK))
  expect(line, `the driver reported\n${output.slice(-3000)}`).toBeDefined()
  const report = JSON.parse((line as string).slice(RESULT_MARK.length)) as Report
  expect(report.error, `the driver failed\n${output.slice(-3000)}`).toBeUndefined()
  return report
}

test('test_c11_openai_codex_device_code_sign_in_hands_url_and_code_as_separate_fields_and_saves_the_tokens', { timeout: CHILD_TIMEOUT_MS + 30_000 }, async () => {
  const report = await runDriver()

  // c11: the method question is offered to the interaction, which chose the device code
  const select = report.asked.find((request) => request.kind === 'select')
  expect(select, 'the flow asked for the way to sign in').toBeDefined()
  expect(select?.options?.some((option) => /device/i.test(`${option.id} ${option.label}`)), 'the device code is among the options').toBe(true)

  // c11: the notice has the verification page and the code of the device in separate fields
  const notices = report.notices.filter((notice): notice is Record<string, unknown> => typeof notice === 'object' && notice !== null)
  const device = notices.find((notice) => notice.code === USER_CODE)
  expect(device, `a notice object carries the device code; notices: ${JSON.stringify(report.notices)}`).toBeDefined()
  expect(device?.url, 'the address of the verification page is its own field').toBe(VERIFICATION_URL)
  expect(typeof device?.message, 'the notice keeps a text for the owner').toBe('string')

  // c11: the stand-in server confirmed, so the sign-in is saved and the provider is marked as connected
  expect(report.before?.connected, 'openai-codex is not connected before').toBe(false)
  expect(report.status).toBe('connected')
  expect(report.after?.connected, 'openai-codex is connected after the tokens came').toBe(true)
  expect(report.requests, 'the device flow went through the stand-in server').toEqual([
    '/api/accounts/deviceauth/usercode',
    '/api/accounts/deviceauth/token',
    '/oauth/token',
  ])

  // c11: nothing reached the real auth.openai.com: the stand-in answers every request to that host, none passes through
})
