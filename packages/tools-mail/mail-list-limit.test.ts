// `mail list` after a checkpoint shows at most 50 letters, the earliest ones, and says how many are left.
//
// The tool talks to a small fake IMAP server over TLS (self-signed certificate of 127.0.0.1, trusted for this
// process only). Every test gets its own DSHBOT_HOME, so a checkpoint never leaks from one case into another.
// Letters are told apart by the subject `Subj-<uid>-end`, which lets the tests read the UIDs of the answer
// without depending on the exact line layout.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo, Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer, getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { createMailTool } from './src/index.js'

const TLS_CERT = `
-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUFECeD9A3rxPKMEPr+lpxHV5BwQ8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNDIzMTQwMloYDzIxMjYw
OTMwMjMxNDAyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCl75vwjHshC+EcrFjUp5qsRpg8pt/dJccfNYBc2BBZ
+0XZOZF3nR9Q686Slo7OHFIiEqk61mfDxlf6xr625k8nPyzTmDPjLaI76abyK274
XT2h1QlrPBkURnJXYePUGK5lagYfHqGzDd8d07WCz2E7RNXalJR7mAVseWpI6Kxf
RiIyZmgJZIgmElMkuTRblD1UtTtCyixL4sIiwArGsiEGRYLlxrM8drVcRr1vMMBS
SEDMxTGuiMCj+eFKxYNcjh9qSVUAXUpD9jcLKJZdnlNL68zEGSsTOpq47LhESnAb
mK1cpzZHspapRjYnQTq1LwhmaKO+KOcwjLq7Qbl5YppVAgMBAAGjbzBtMB0GA1Ud
DgQWBBRUq9OBqqby/LWZ2gHbxL89bVmDzDAfBgNVHSMEGDAWgBRUq9OBqqby/LWZ
2gHbxL89bVmDzDAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDwYDVR0TAQH/
BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAHsN/i6d/2e5JIHv2fi5yi3zw32LL
r77keIQgQtU7jdY7kagOofilpPFAib5f/mhsSVTW4z5gUEojDSJ0WMPLfT4PX115
BWhM9E39BgZ3A9QLGN49N+LZL80C13H5UcO5pUdO1U6FIexc6XuspRDmBmqQSQKF
YwTIP5dlWcYQNO9hZvKa0q9GqkqT5in5EJPom1Qs0++0jdaEcyciFsgdYPS43vhr
yUByXZngY+sVjSe8TEuSBdxaCajkZ8Rpmvx8moZsUMRw3EiJanSxFZA9ezYdX9FK
nUS8feGaR8LXMs2M3SUCkoQwGj8AC2EERgYLku5Lt5NmbhmNPeDMzrKvPw==
-----END CERTIFICATE-----
`.trim() + '\n'

const TLS_KEY = `
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCl75vwjHshC+Ec
rFjUp5qsRpg8pt/dJccfNYBc2BBZ+0XZOZF3nR9Q686Slo7OHFIiEqk61mfDxlf6
xr625k8nPyzTmDPjLaI76abyK274XT2h1QlrPBkURnJXYePUGK5lagYfHqGzDd8d
07WCz2E7RNXalJR7mAVseWpI6KxfRiIyZmgJZIgmElMkuTRblD1UtTtCyixL4sIi
wArGsiEGRYLlxrM8drVcRr1vMMBSSEDMxTGuiMCj+eFKxYNcjh9qSVUAXUpD9jcL
KJZdnlNL68zEGSsTOpq47LhESnAbmK1cpzZHspapRjYnQTq1LwhmaKO+KOcwjLq7
Qbl5YppVAgMBAAECggEAAygffkfsXE6UsLQw8J6IZwkVuXoKd6QtMzLjXKPZ6X9c
Pg0zvmPXrbg64581no+BpvirVu+vWRhMNF4qOCtjkbg8VZnI461pI0Rcd3R2jKWA
TvF1uUTQFbU65w88QIRoEL2lzbBrxxTphcwGf61UZEyLCSaIvoGPGZ4LaKCfMkmI
3E7SU+0QrAj6BXJsBhI9pTaLNwh33B0sD2jZHezUfV9wxBBMi3P0Jw+ejTPwtsoK
ji8p2oc0ROxgvZJ2Ls3u9TBV+CIADWiLvrURDSQiJIq1rd75o7DM10IxkA8+QVV9
9VSg9TSXy45SGqCvUdVQRyeZw+hmA7yf2qhgNIXJaQKBgQDRHj4H3j5HpFAbV8K/
7+elNkZplakfwWCrPfpPXqMcQUDgeXGWoaH9lb4XUttyAXLYR+XzcIX2c3Lpd5PX
2P7ambvFeHdZ+HGxpqTu3cjjimmR1tcMylH/skY4jXWoZtfz4kqDH9CDOb0OdmbB
z1IoNJmU9DXfJPAcvY+0CXMu+wKBgQDLIwvFvgmZCwMXXnY4ot0rXbHnbjnHfRir
ZTiwI+Y9Fi/621hUrpjNhySQyGruhTlViwfzIm+Hu84P93UHsUGfu2b0hD9i39IJ
XnsjeidxTIx4kEZYU1HSahenZhjsviv5kXQvceoVcFpUulAM3Xr6YYKGRo/cvc5z
O9qd+wja7wKBgBgem9r+eEJ9Ijw1ICJRQm+c1fxBpdMi08qMiH11Fe0hXaFGgKJ2
HCAKkHVSOjtpDV0C1fQBK4JkiIGDKEtCHQsLpku9fE6lSD/MT8O5Uv1jro+CryUr
hM+wOUc2kbaNviTEGgILvloUY8jyQSHjjr9SadBzZm9JbGR0PMnwORfXAoGAXYOi
tcOIc5XoNGfeELCZFI+riJjrrHRgWPbeI+hC47hFGjzD6yf9XBBsuuIop+lYvZKl
dD5UDa5dbGhEzefCCCCjgskmzQOwk3OVSH3Bjpzoxc/VMnAY6L7CaOPNcZ8Sa2+U
hwrv8jKowvyKQYHsTTt6dQoizEHsuovBVpzsNK0CgYAPhJhV7M9eOkRG6PypeOiT
DBh5SYSR5EHyCo+UWx3eUXTrxQkHogE3ye4CNuiUlxq1TuMyG5mDAiVcT8N4mG7c
nUXQfd3+E/0k313hUdn67G5m+gB+JnJnaR6kEfxrIrq/Q8Oz2pyjyKiNYvDlW14B
/BL3u/Q6elKR9wrRIdWgDg==
-----END PRIVATE KEY-----
`.trim() + '\n'

const CRLF = '\r\n'
const BOX = 'personal'
const PASSWORD_ENV = 'MAIL_LIST_LIMIT_PASSWORD'
const UIDVALIDITY = 4242
const LETTER_DATE = '2024-03-17 12:00'

interface ImapServer {
  port: number
  close(): Promise<void>
}

/** True when `uid` is in an IMAP sequence set such as `5`, `3:7`, `101:*` or `1,4,9:12`; `*` is the highest UID. */
function inSet(set: string, uid: number, highest: number): boolean {
  const value = (token: string): number => (token === '*' ? highest : Number(token))
  return set.split(',').some((part) => {
    const [first = '', second] = part.split(':')
    if (second === undefined) return value(first) === uid
    const low = Math.min(value(first), value(second))
    const high = Math.max(value(first), value(second))
    return uid >= low && uid <= high
  })
}

function headerBlock(uid: number): string {
  return [
    `From: Sender ${uid} <sender-${uid}@example.org>`,
    `Subject: ${subjectOf(uid)}`,
    'Date: Sun, 17 Mar 2024 12:00:00 +0000',
    '',
    '',
  ].join(CRLF)
}

function subjectOf(uid: number): string {
  return `Subj-${uid}-end`
}

function handleConnection(socket: Socket, uids: number[]): void {
  const highest = Math.max(0, ...uids)
  let buffer = ''
  let selected = false

  const reply = (tag: string, text: string): void => {
    socket.write(`${tag} ${text}${CRLF}`)
  }

  const run = (line: string): void => {
    const [tag = '', word = '', ...args] = line.trim().split(/\s+/)
    const command = word.toUpperCase()
    if (command === 'LOGIN') {
      reply(tag, 'OK logged in')
    } else if (command === 'SELECT' || command === 'EXAMINE') {
      selected = true
      socket.write(
        [
          `* ${uids.length} EXISTS`,
          '* 0 RECENT',
          `* OK [UIDVALIDITY ${UIDVALIDITY}] UIDs valid`,
          `* OK [UIDNEXT ${highest + 1}] predicted next UID`,
          '',
        ].join(CRLF),
      )
      reply(tag, 'OK [READ-WRITE] done')
    } else if (command === 'UID' && selected) {
      const sub = (args[0] ?? '').toUpperCase()
      const rest = args.slice(1)
      if (sub === 'SEARCH') {
        const at = rest.findIndex((token) => token.toUpperCase() === 'UID')
        const hits = uids.filter((uid) => at < 0 || inSet(rest[at + 1] ?? '1:*', uid, highest))
        socket.write(`* SEARCH${hits.map((uid) => ` ${uid}`).join('')}${CRLF}`)
        reply(tag, 'OK done')
      } else if (sub === 'FETCH') {
        const set = rest[0] ?? ''
        uids.forEach((uid, index) => {
          if (!inSet(set, uid, highest)) return
          const block = headerBlock(uid)
          socket.write(
            `* ${index + 1} FETCH (UID ${uid} INTERNALDATE "17-Mar-2024 12:00:00 +0000" ` +
              `BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(block)}}${CRLF}${block})${CRLF}`,
          )
        })
        reply(tag, 'OK done')
      } else {
        reply(tag, 'BAD unknown command')
      }
    } else if (command === 'LOGOUT') {
      socket.write(`* BYE bye${CRLF}`)
      reply(tag, 'OK done')
      socket.end()
    } else {
      reply(tag, 'BAD unknown command')
    }
  }

  socket.on('error', () => {})
  socket.on('data', (data: Buffer) => {
    buffer += data.toString('latin1')
    for (;;) {
      const end = buffer.indexOf(CRLF)
      if (end < 0) return
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      run(line)
    }
  })
  socket.write(`* OK [CAPABILITY IMAP4rev1] fake IMAP ready${CRLF}`)
}

async function startImap(uids: number[]): Promise<ImapServer> {
  const sorted = [...uids].sort((left, right) => left - right)
  const sockets = new Set<Socket>()
  const server: Server = createTlsServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    handleConnection(socket, sorted)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

// --- the world of one test ------------------------------------------------------------------------------

let home = ''
let servers: ImapServer[] = []

beforeAll(() => {
  setDefaultCACertificates([...getCACertificates('default'), TLS_CERT])
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-mail-list-limit-'))
  process.env[PASSWORD_ENV] = 'list-limit-secret'
})

afterEach(async () => {
  for (const server of servers) await server.close()
  servers = []
  rmSync(home, { recursive: true, force: true })
})

function range(first: number, last: number, step = 1): number[] {
  const uids: number[] = []
  for (let uid = first; uid <= last; uid += step) uids.push(uid)
  return uids
}

/** A mailbox with exactly these UIDs, configured as the box `personal` of a fresh home. */
async function openMailbox(uids: number[]): Promise<{ list(): Promise<string>; mark(uid: number): Promise<string> }> {
  const server = await startImap(uids)
  servers.push(server)
  writeFileSync(
    join(home, 'mail.json'),
    JSON.stringify({
      [BOX]: { host: '127.0.0.1', port: server.port, login: 'owner@example.org', password_env: PASSWORD_ENV, tls: true },
    }),
  )
  const tool = createMailTool({ home, timeoutMs: 15_000 })
  return {
    list: async () => String(await tool.execute({ action: 'list', box: BOX }, undefined)),
    mark: async (uid) => String(await tool.execute({ action: 'checkpoint', box: BOX, uid }, undefined)),
  }
}

const FRAME = /<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>/

/** The answer split into the one untrusted frame and everything around it. */
function split(answer: string): { framed: string; outside: string } {
  const match = FRAME.exec(answer)
  expect(match, `the answer carries one EXTERNAL_UNTRUSTED_CONTENT frame:\n${answer.slice(0, 600)}`).not.toBeNull()
  const framed = match?.[0] ?? ''
  return { framed, outside: answer.replace(framed, '') }
}

/** UIDs of the letters listed inside the frame, in the order they are shown. */
function shownUids(framed: string): number[] {
  return [...framed.matchAll(/Subj-(\d+)-end/g)].map((match) => Number(match[1]))
}

const hasNumber = (text: string, value: number): boolean => new RegExp(`(?<!\\d)${value}(?!\\d)`).test(text)

test('test_c1_after_a_checkpoint_list_shows_the_50_earliest_letters_and_says_70_are_left', async () => {
  // 120 new letters (UIDs with gaps), plus a few old ones at or below the mark
  const old = [10, 80, 150, 199]
  const fresh = range(200, 438, 2)
  expect(fresh).toHaveLength(120)
  const box = await openMailbox([...old, ...fresh])
  await box.mark(199)

  const { framed, outside } = split(await box.list())
  const uids = shownUids(framed)
  expect(uids, 'the 50 smallest UIDs above the mark, ascending').toEqual(fresh.slice(0, 50))
  expect(hasNumber(outside, 70), `outside the frame: 70 letters are left:\n${outside}`).toBe(true)
  expect(hasNumber(outside, 298), `outside the frame: the last shown UID is the next mark:\n${outside}`).toBe(true)
  expect(outside, 'no letter data leaks out of the frame').not.toMatch(/Subj-|sender-/)

  // following the note: the mark moves to the last shown UID and the next portion comes
  await box.mark(298)
  const next = split(await box.list())
  expect(shownUids(next.framed)).toEqual(fresh.slice(50, 100))
  expect(hasNumber(next.outside, 20), `outside the frame: 20 letters are left:\n${next.outside}`).toBe(true)
  expect(hasNumber(next.outside, 398), `outside the frame: the new last shown UID:\n${next.outside}`).toBe(true)

  await box.mark(398)
  const last = split(await box.list())
  expect(shownUids(last.framed)).toEqual(fresh.slice(100))
  expect(last.outside, 'the last portion has no note about the rest').not.toMatch(/\d/)
})

test('test_c1_one_letter_over_the_limit_is_reported_as_one_left', async () => {
  const fresh = range(101, 151)
  expect(fresh).toHaveLength(51)
  const box = await openMailbox([...range(1, 100), ...fresh])
  await box.mark(100)

  const { framed, outside } = split(await box.list())
  expect(shownUids(framed)).toEqual(range(101, 150))
  expect(hasNumber(outside, 1), `outside the frame: one letter is left:\n${outside}`).toBe(true)
  expect(hasNumber(outside, 150), `outside the frame: the last shown UID:\n${outside}`).toBe(true)
})

test('test_c2_with_50_or_fewer_new_letters_list_shows_all_of_them_without_a_note', async () => {
  // exactly 50, and no letter at or below the mark in the box
  const exactly = await openMailbox(range(101, 150))
  await exactly.mark(100)
  const full = split(await exactly.list())
  expect(shownUids(full.framed)).toEqual(range(101, 150))
  expect(full.outside, 'no note about the rest').not.toMatch(/\d|остал|ещ[её]/i)

  // a handful of new letters among older ones
  const few = await openMailbox([...range(1, 100), 105, 110, 111])
  await few.mark(100)
  const short = split(await few.list())
  expect(shownUids(short.framed)).toEqual([105, 110, 111])
  expect(short.outside, 'no note about the rest').not.toMatch(/\d|остал|ещ[её]/i)
})

test('test_c3_without_a_checkpoint_list_still_returns_the_last_20_letters', async () => {
  // UIDs with gaps: the last 20 are the 20 largest real UIDs, not a range below UIDNEXT
  const uids = range(5, 600, 5)
  expect(uids.length).toBeGreaterThan(100)
  const box = await openMailbox(uids)

  const { framed } = split(await box.list())
  expect(shownUids(framed)).toEqual(uids.slice(-20))

  const small = await openMailbox(range(1, 7))
  expect(shownUids(split(await small.list()).framed), 'fewer than 20 letters: all of them').toEqual(range(1, 7))
})

test('test_c4_sender_subject_and_date_of_a_limited_list_stay_inside_the_untrusted_frame', async () => {
  const box = await openMailbox(range(101, 220))
  await box.mark(100)

  const answer = await box.list()
  const { framed, outside } = split(answer)
  expect(answer.split('<<<EXTERNAL_UNTRUSTED_CONTENT').length - 1, 'one opening line').toBe(1)
  expect(answer.split('<<<END_EXTERNAL_UNTRUSTED_CONTENT').length - 1, 'one closing line').toBe(1)
  for (const uid of [101, 125, 150]) {
    expect(framed, `subject of ${uid} inside the frame`).toContain(subjectOf(uid))
    expect(framed, `sender of ${uid} inside the frame`).toContain(`sender-${uid}@example.org`)
  }
  expect(framed, 'the date inside the frame').toContain(LETTER_DATE)
  expect(framed, 'the letters past the limit are not listed').not.toContain(subjectOf(151))
  expect(outside).not.toContain('2024-03-17')
  expect(outside).not.toMatch(/Subj-|sender-|Sender \d/)
})
