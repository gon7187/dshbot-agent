// The secret vault of the owner: one file per secret in `<DSHBOT_HOME>/secrets`,
// readable by the owner of the daemon alone (0600), plus the names of the
// values this process ever held so a value that a live MCP server or a live
// background job still carries stays scrubbed after `/unsecret` or a new value.
//
// The vault never writes a value into a log, a session, an ingress row or a
// model request: the value message is consumed by the daemon before the durable
// ingress put, and every consumer scrubs with {@link known}. The history of
// values lives only in memory and dies with the process, together with the
// server processes and jobs that could quote it.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory of the vault inside `DSHBOT_HOME`. */
export const SECRETS_DIR = 'secrets'

/** A name the owner may give a secret: ASCII capitals, digits and the underscore. */
export const SECRET_NAME_RE = /^[A-Z0-9_]{1,64}$/

/** Stands in place of a scrubbed value in text handed to the model or the owner. */
export const SECRET_PLACEHOLDER = '[скрыто]'

/** Reference to a secret inside a value of `mcp.json` (`env` or `headers`). */
const SECRET_REFERENCE_RE = /\$\{secret:([A-Za-z0-9_]+)\}/g

/** One name/value pair the process has seen; the value outlives the file. */
export interface KnownSecret {
  readonly name: string
  readonly value: string
}

/** What `mcp.json` resolution needs; implemented by {@link SecretVault}. */
export interface SecretResolver {
  resolve(text: string): { text: string; missing: string[] }
  known(): readonly KnownSecret[]
}

/** What `exec` needs; implemented by {@link SecretVault}. */
export interface SecretReader {
  get(name: string): string | undefined
  names(): string[]
  known(): readonly KnownSecret[]
}

function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/** The vault: files in `DSHBOT_HOME/secrets` and the in-memory history of values. */
export class SecretVault implements SecretResolver, SecretReader {
  readonly dir: string
  private history: KnownSecret[] = []

  constructor(home: string) {
    this.dir = join(home, SECRETS_DIR)
    this.load()
  }

  /** Names of the secrets that exist now, sorted. A missing directory is an empty vault. */
  names(): string[] {
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }
    return entries
      .filter((name) => SECRET_NAME_RE.test(name) && this.isFile(join(this.dir, name)))
      .sort()
  }

  /** Value of the named secret, or undefined; a read value joins the scrub history. */
  get(name: string): string | undefined {
    if (!SECRET_NAME_RE.test(name)) return undefined
    try {
      const value = stripTrailingNewline(readFileSync(join(this.dir, name), 'utf8'))
      this.remember(name, value)
      return value
    } catch {
      return undefined
    }
  }

  /** Save a value as `0600` in the vault; the value never leaves this process. */
  set(name: string, value: string): void {
    if (!SECRET_NAME_RE.test(name)) throw new Error(`недопустимое имя секрета: ${name}`)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, name)
    writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 })
    // `mode` of writeFileSync is filtered by umask and ignored for an existing
    // file, so the mode is set once more explicitly.
    chmodSync(path, 0o600)
    this.remember(name, value)
  }

  /** Remove the file; its old value stays in the scrub history of this process. */
  remove(name: string): boolean {
    if (!SECRET_NAME_RE.test(name)) return false
    const path = join(this.dir, name)
    if (!this.isFile(path)) return false
    const old = this.get(name)
    try {
      rmSync(path, { force: true })
    } catch {
      return false
    }
    if (old !== undefined) this.remember(name, old)
    return true
  }

  /** Every value this process has held, longest first. No duplicates. */
  values(): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const entry of this.history) {
      if (entry.value === '' || seen.has(entry.value)) continue
      seen.add(entry.value)
      result.push(entry.value)
    }
    return result.sort((left, right) => right.length - left.length)
  }

  /** History of names and values, newest first. */
  known(): readonly KnownSecret[] {
    return this.history
  }

  /** Replace every `${secret:NAME}` with the current value; names without a value are reported. */
  resolve(text: string): { text: string; missing: string[] } {
    const missing = new Set<string>()
    const resolved = text.replace(SECRET_REFERENCE_RE, (whole, name: string) => {
      const value = this.get(name)
      if (value === undefined) {
        missing.add(name)
        return whole
      }
      return value
    })
    return { text: resolved, missing: [...missing] }
  }

  /** A value with every known secret replaced by the placeholder. */
  scrub(text: string): string {
    let result = text
    for (const value of this.values()) result = result.split(value).join(SECRET_PLACEHOLDER)
    return result
  }

  /** Name that belongs to a value; the newest name wins. */
  nameOf(value: string): string | undefined {
    return this.history.find((entry) => entry.value === value)?.name
  }

  private load(): void {
    for (const name of this.names()) this.get(name)
  }

  private remember(name: string, value: string): void {
    if (value === '') return
    if (this.history.some((entry) => entry.name === name && entry.value === value)) return
    this.history = [{ name, value }, ...this.history]
  }

  private isFile(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isFile()
    } catch {
      return false
    }
  }
}
