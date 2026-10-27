// playwright-core is heavy (tens of MB of RSS, hundreds of ms of start-up) and only the browser tool needs it.
// Importing the daemon module must therefore neither resolve nor load it: that happens on the first launch of
// the browser or the first attach to Chrome over CDP.
//
// The check runs in a child Node process (the way `npm start` loads the app: packages/app/register.mjs first).
// A preload registers module hooks that record every resolve and load that mentions playwright-core. As a
// control, the same process imports playwright-core by hand afterwards and must see it recorded, so a hook
// that records nothing cannot make the test pass by itself.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const registerUrl = pathToFileURL(join(repoRoot, 'packages/app/register.mjs')).href
const appIndexUrl = pathToFileURL(join(repoRoot, 'packages/app/src/index.ts')).href
const browserIndexUrl = pathToFileURL(join(repoRoot, 'packages/tools-browser/src/index.ts')).href

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-lazy-pw-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const PRELOAD = `
import { registerHooks } from 'node:module'

const seen = []
const mentions = (text) => typeof text === 'string' && /playwright-core/.test(text)

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    if (mentions(specifier) || mentions(result.url)) seen.push('resolve ' + specifier + ' -> ' + result.url)
    return result
  },
  load(url, context, nextLoad) {
    if (mentions(url)) seen.push('load ' + url)
    return nextLoad(url, context)
  },
})

globalThis.__playwrightSeen = seen
`

function main(): string {
  return `
const report = (label) => process.stdout.write('RESULT ' + JSON.stringify({ label, seen: [...globalThis.__playwrightSeen] }) + '\\n')

await import(${JSON.stringify(appIndexUrl)})
report('after-app-import')

await import(${JSON.stringify(browserIndexUrl)})
report('after-browser-module-import')

const { createRequire } = await import('node:module')
const { pathToFileURL } = await import('node:url')
const playwrightPath = createRequire(${JSON.stringify(join(repoRoot, 'package.json'))}).resolve('playwright-core')
await import(pathToFileURL(playwrightPath).href)
report('after-manual-import')
`
}

interface Report {
  label: string
  seen: string[]
}

function runChild(): Report[] {
  const preload = join(scratch, 'preload.mjs')
  const entry = join(scratch, 'entry.mjs')
  writeFileSync(preload, PRELOAD)
  writeFileSync(entry, main())
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_OPTIONS
  const r = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, '--import', registerUrl, entry],
    { env, cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  )
  const reports = r.stdout
    .split('\n')
    .filter((line) => line.startsWith('RESULT '))
    .map((line) => JSON.parse(line.slice('RESULT '.length)) as Report)
  expect(reports.map((x) => x.label), `child output:\n${r.stdout}\n${r.stderr}`).toEqual([
    'after-app-import',
    'after-browser-module-import',
    'after-manual-import',
  ])
  return reports
}

test('test_c1_importing_the_app_module_does_not_resolve_or_load_playwright_core', () => {
  const [afterApp, afterBrowserModule, afterManual] = runChild()

  expect(afterApp.seen).toEqual([])
  // The browser tool module itself is part of the app graph; loading it must not pull the library either.
  expect(afterBrowserModule.seen).toEqual([])
  // Control: the hooks do see playwright-core when it is really imported.
  expect(afterManual.seen.length).toBeGreaterThan(0)
}, 150_000)
