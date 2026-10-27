// `/verbose on` summary of a tool call: a `url` value is shown only when it can be cut safely. An absolute URL
// of a known scheme loses its userinfo, query and fragment; a value that `new URL` cannot parse (a relative or a
// protocol-relative one) or that has no authority to cut (`mailto:`, `data:`) is not shown at all, only the
// argument name stays. Every hidden part carries its own marker, so a leak of any of them is visible.

import { expect, test } from 'vitest'

import { summarizeToolCall } from './src/index.js'

const HIDDEN = ['tm-user', 'tm-pass', 'tm-token', 'tm-query', 'tm-fragment']

function summary(url: string): string {
  return summarizeToolCall('web_fetch', JSON.stringify({ url, limit: 5 }))
}

function expectNoHiddenPart(text: string): void {
  for (const hidden of HIDDEN) expect(text, `no ${hidden} in "${text}"`).not.toContain(hidden)
}

test('an absolute url keeps host and path and loses userinfo, query and fragment', () => {
  const text = summary('https://tm-user:tm-pass@tm-host.example/tm-path?tm-token=tm-query#tm-fragment')
  expect(text).toBe('web_fetch url=https://tm-host.example/tm-path limit=5')
  expectNoHiddenPart(text)
})

test.each([
  ['protocol-relative with userinfo', '//tm-user:tm-pass@tm-host.example/tm-path?tm-token=tm-query#tm-fragment'],
  ['relative path with query and fragment', '/tm-path?tm-token=tm-query#tm-fragment'],
  ['relative without a slash', 'tm-path/x?tm-token=tm-query'],
  ['userinfo without a scheme', 'tm-user:tm-pass@tm-host.example/tm-path'],
  ['bare query', '?tm-token=tm-query#tm-fragment'],
  ['mailto with a secret in the path', 'mailto:tm-user:tm-pass@tm-host.example?tm-token=tm-query'],
  ['data url', 'data:text/plain,tm-token=tm-query'],
])('an url that cannot be cut safely is shown by name only: %s', (_what, url) => {
  const text = summary(url)
  expect(text).toBe('web_fetch url limit=5')
  expectNoHiddenPart(text)
})

test('a long absolute url is cut to eighty characters after its secret parts are gone', () => {
  const text = summarizeToolCall(
    'web_fetch',
    JSON.stringify({ url: `https://tm-user:tm-pass@tm-host.example/${'a'.repeat(200)}?tm-token=tm-query` }),
  )
  const value = text.slice('web_fetch url='.length)
  expect(value).toHaveLength(80)
  expect(value.startsWith('https://tm-host.example/aaa')).toBe(true)
  expect(value.endsWith('…')).toBe(true)
  expectNoHiddenPart(text)
})
