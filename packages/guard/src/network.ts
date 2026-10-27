// One address policy for every network egress of the bot: `web_fetch`, the
// `browser` tool and the proxy of the `exec` sandbox all decide "public" here.
//
// The rules are deliberately private-by-default: only global unicast of IPv4 and
// IPv6 may leave the machine. Loopback, RFC1918, link-local (including the
// cloud metadata endpoint 169.254.169.254), CGNAT, multicast, documentation,
// unique-local and every IPv4-embedded IPv6 spelling are refused. A name is
// resolved exactly once by the caller and every answer must be public, so a
// rebinding name cannot pass the check and then connect somewhere else.
//
// Nothing in this file starts a process or opens a connection.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Refusal text: the same shape for every forbidden address. */
export function refuseAddress(url: string, why: string): Error {
  return new Error(`Адрес ${JSON.stringify(url)} отклонён: ${why}. Разрешены только публичные http(s)-адреса.`)
}

/** One IPv4 octet tuple, or undefined when the text is not IPv4. */
function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined
  return address.split('.').map((part) => Number(part))
}

/** True for every IPv4 address that is not public unicast. */
function privateIpv4(address: string): boolean {
  const octets = ipv4Octets(address)
  if (octets === undefined) return true
  const [a = 0, b = 0, c = 0] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    // 192.88.99.0/24: 6to4 relay anycast, removed from service but still
    // classified as reserved by every public-unicast table.
    (a === 192 && b === 88 && c === 99) ||
    // AS112 and AMT anycast ranges: special-purpose, not global unicast.
    (a === 192 && ((b === 175 && c === 48) || (b === 31 && c === 196) || (b === 52 && c === 193))) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

/**
 * Expand an IPv6 literal into its eight 16-bit hextets. The URL parser rewrites
 * an embedded dotted IPv4 (`::ffff:127.0.0.1`) into hexadecimal
 * (`::ffff:7f00:1`), so the only way to see the address a client will use is to
 * parse the groups, not to look for a dotted tail.
 */
function ipv6Hextets(address: string): number[] | undefined {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  if (isIP(value) !== 6) return undefined
  let text = value
  let tail: number[] = []
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted?.[1] !== undefined) {
    const octets = ipv4Octets(dotted[1])
    if (octets === undefined || octets.length !== 4) return undefined
    tail = [((octets[0] as number) << 8) | (octets[1] as number), ((octets[2] as number) << 8) | (octets[3] as number)]
    text = text.slice(0, text.length - dotted[1].length).replace(/:$/, '')
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined]
  const groupsOf = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16))
  const left = groupsOf(head)
  const right = groupsOf(rest)
  const groups =
    rest === undefined
      ? [...left]
      : [...left, ...Array<number>(Math.max(0, 8 - left.length - right.length - tail.length)).fill(0), ...right]
  groups.push(...tail)
  if (groups.length !== 8) return undefined
  if (groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined
  return groups
}

/** Dotted IPv4 from the two hextets that carry an embedded address. */
function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/**
 * True for every IPv6 address that is not public unicast. Embedded IPv4 forms
 * (mapped `::ffff:0:0/96`, compatible `::/96`, translated `::ffff:0:0:0/96`,
 * NAT64 `64:ff9b::/96` and 6to4 `2002::/16`) are unwrapped and run through the
 * same IPv4 rules, so `http://[::ffff:127.0.0.1]/` is refused like `127.0.0.1`.
 */
function privateIpv6(address: string): boolean {
  const groups = ipv6Hextets(address)
  if (groups === undefined) return true
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const zeroRange = (from: number, to: number): boolean => groups.slice(from, to).every((group) => group === 0)
  if (zeroRange(0, 8) || (zeroRange(0, 7) && g7 === 1)) return true
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses.
  if (zeroRange(0, 5) && (g5 === 0xffff || g5 === 0)) {
    if (g6 === 0 && g7 === 0) return true
    return privateIpv4(ipv4FromGroups(g6, g7))
  }
  // IPv4-translated (::ffff:0:a.b.c.d).
  if (zeroRange(0, 4) && g4 === 0xffff && g5 === 0) return privateIpv4(ipv4FromGroups(g6, g7))
  // NAT64 (64:ff9b::/96) and the local-use 64:ff9b:1::/48.
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0x0001) return true
    if (zeroRange(2, 6)) return privateIpv4(ipv4FromGroups(g6, g7))
    return true
  }
  // 6to4 (2002::/16) embeds the IPv4 address in its first two groups.
  if (g0 === 0x2002) return privateIpv4(ipv4FromGroups(g1, g2))
  // Teredo (2001::/32) tunnels a UDP endpoint, so the eventual destination is
  // not the address that passed a check.
  if (g0 === 0x2001 && g1 === 0x0000) return true
  // 2001:db8::/32 documentation, benchmarking 2001:2::/48, AMT 2001:3::/32,
  // AS112 2001:4:112::/48 and 2620:4f:8000::/48, ORCHID 2001:10::/28 and
  // 2001:20::/28: special-purpose blocks that are not global unicast.
  if (g0 === 0x2001 && g1 === 0x0db8) return true
  if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0) return true
  if (g0 === 0x2001 && g1 === 0x0003) return true
  if (g0 === 0x2001 && g1 === 0x0004 && g2 === 0x0112) return true
  if (g0 === 0x2620 && g1 === 0x004f && g2 === 0x8000) return true
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0020) return true
  // 100::/64 discard-only.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 deprecated site-local,
  // ff00::/8 multicast.
  if ((g0 & 0xfe00) === 0xfc00) return true
  if ((g0 & 0xffc0) === 0xfe80) return true
  if ((g0 & 0xffc0) === 0xfec0) return true
  if ((g0 & 0xff00) === 0xff00) return true
  return false
}

/** True for every literal or resolved address that must not be opened. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0] ?? address
  const family = isIP(bare)
  if (family === 4) return privateIpv4(bare)
  if (family === 6) return privateIpv6(bare)
  return true
}

/** Hostnames that never leave the machine, before any name lookup. */
export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.+$/, '')
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name === 'metadata' ||
    name === 'metadata.google.internal' ||
    name === 'instance-data'
  )
}

/** Where a name resolved during one page or one proxy request: shared by its requests. */
export type ResolutionCache = Map<string, Promise<string[]>>

/**
 * Refuse a host unless every address it resolves to is public unicast.
 *
 * The lookup happens once. The caller must connect to one of the returned
 * addresses, never resolve the name again: that is what closes DNS rebinding.
 */
export async function assertPublicHost(raw: string, url: URL, cache?: ResolutionCache): Promise<string[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isLocalHostname(hostname)) throw refuseAddress(raw, 'локальное имя')
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw refuseAddress(raw, 'частный или служебный адрес')
    return [hostname]
  }
  let pending = cache?.get(hostname)
  if (pending === undefined) {
    pending = (async () => {
      let answers: Array<{ address: string }>
      try {
        answers = await lookup(hostname, { all: true, verbatim: true })
      } catch {
        throw new Error(`Адрес ${JSON.stringify(raw)} отклонён: имя ${JSON.stringify(hostname)} не разрешается.`)
      }
      if (answers.length === 0) throw refuseAddress(raw, 'имя не разрешается')
      for (const answer of answers) {
        if (isPrivateAddress(answer.address)) throw refuseAddress(raw, `имя ведёт на ${answer.address}`)
      }
      return answers.map((answer) => answer.address)
    })()
    cache?.set(hostname, pending)
    // A rejected lookup must not stick: a later request gets its own attempt.
    pending.catch(() => cache?.delete(hostname))
  }
  return await pending
}

/** A checked URL and the exact addresses the connection may use. */
export interface PublicTarget {
  readonly url: URL
  readonly addresses: readonly string[]
}

/**
 * Parse an absolute `http(s)` URL and check every address its name resolves to.
 * The returned address set is the only place a caller may connect.
 */
export async function checkPublicUrl(raw: string, cache?: ResolutionCache): Promise<PublicTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Адрес ${JSON.stringify(raw)} отклонён: это не абсолютный URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw refuseAddress(raw, `протокол ${url.protocol} не поддерживается`)
  }
  const addresses = await assertPublicHost(raw, url, cache)
  return { url, addresses }
}

/** `checkPublicUrl` when only the parsed URL is needed. */
export async function assertPublicUrl(raw: string, cache?: ResolutionCache): Promise<URL> {
  return (await checkPublicUrl(raw, cache)).url
}

/** One checked address in the shape a pinned HTTP transport's lookup needs. */
export interface PublicAddress {
  readonly address: string
  readonly family: 4 | 6
}

/**
 * Check a bare hostname for a pinned HTTP transport: the name is resolved here
 * once and the returned address set is the only place the caller may connect.
 * This is the resolver `web_fetch` hands to its transport, so the check and the
 * connection see the same DNS answer and a rebinding name cannot swap it.
 */
export async function resolvePublicHostname(hostname: string, cache?: ResolutionCache): Promise<PublicAddress[]> {
  const url = new URL(`http://${hostname}/`)
  const addresses = await assertPublicHost(hostname, url, cache)
  return addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }))
}

/**
 * One checked address for a proxy connection: the name is resolved here once
 * and the proxy connects to this address, so the check and the connect see the
 * same answer.
 */
export async function resolvePublicTarget(raw: string): Promise<string> {
  const target = await checkPublicUrl(raw)
  const address = target.addresses[0]
  if (address === undefined) throw refuseAddress(raw, 'имя не разрешается')
  return address
}
