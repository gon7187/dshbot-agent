// Lazy MCP client for @modelcontextprotocol/server-memory.
//
// The server is a separate node process launched over stdio on the first graph
// call. Its only environment variable is MEMORY_FILE_PATH, pointing at
// `<DSHBOT_HOME>/memory/graph.jsonl`; the memory directory is created before the
// spawn so a fresh install needs no setup step. A crashed server is replaced on
// the next call, and stop() terminates the child with the daemon.
//
// Calls are serialized in one queue: the model may issue several graph calls in
// a turn, and a single lazy process keeps ordering and restarts predictable.

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

import { Client, type CallToolResult } from '@modelcontextprotocol/client'

import { EnvOnlyStdioTransport } from './transport.js'

/** Package whose dist/index.js runs the graph server. */
export const SERVER_MEMORY_PACKAGE = '@modelcontextprotocol/server-memory'

/** Entry point inside the installed package; `npx` is never involved. */
export const SERVER_MEMORY_ENTRY = 'dist/index.js'

/** The one variable the server process receives. */
export const MEMORY_FILE_ENV = 'MEMORY_FILE_PATH'

/** File under `DSHBOT_HOME/memory` that keeps the graph. */
export const GRAPH_FILE_NAME = 'graph.jsonl'

/** Directory under `DSHBOT_HOME` that holds memory state. */
export const MEMORY_DIR_NAME = 'memory'

/** Resolve the installed server entry from the repository's node_modules. */
export function resolveServerMemoryEntry(): string {
  const require = createRequire(import.meta.url)
  return require.resolve(`${SERVER_MEMORY_PACKAGE}/${SERVER_MEMORY_ENTRY}`)
}

export interface MemoryGraphClientOptions {
  /** `DSHBOT_HOME`; the graph file is `<home>/memory/graph.jsonl`. */
  home: string
  /** Absolute entry point of the server; defaults to the installed package. */
  serverEntry?: string
  /** Node executable; defaults to `process.execPath`. */
  nodePath?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Absolute path of the graph file of one DSHBOT_HOME. */
export function graphFileOf(home: string): string {
  return resolve(home, MEMORY_DIR_NAME, GRAPH_FILE_NAME)
}

export class MemoryGraphClient {
  /** Absolute `MEMORY_FILE_PATH`; also the only child environment entry. */
  readonly filePath: string
  private readonly serverEntry: string
  private readonly nodePath: string

  private client: Client | undefined
  private transport: EnvOnlyStdioTransport | undefined
  private startPromise: Promise<Client> | undefined
  private queue: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(options: MemoryGraphClientOptions) {
    this.filePath = graphFileOf(options.home)
    this.serverEntry = options.serverEntry ?? resolveServerMemoryEntry()
    this.nodePath = options.nodePath ?? process.execPath
  }

  /**
   * Call one server tool. A transport failure (the server died) closes the old
   * process and retries once on a fresh one; graph mutations are idempotent, so
   * a retry cannot duplicate entities, relations or observations.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.enqueue(async () => {
      let lastError: unknown
      let lastStderr = ''
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const client = await this.ensureClient()
          return await client.callTool({ name, arguments: args })
        } catch (error) {
          lastError = error
          lastStderr = this.transport?.stderr ?? ''
          await this.reset()
          if (this.stopped) break
        }
      }
      throw new Error(
        `graph memory server call "${name}" failed: ${errorText(lastError)}${lastStderr === '' ? '' : `\n${lastStderr}`}`,
      )
    })
  }

  /** Terminate the server process; the client stays unusable afterwards. */
  async stop(): Promise<void> {
    this.stopped = true
    const starting = this.startPromise
    if (starting !== undefined) await starting.catch(() => undefined)
    await this.reset()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private ensureClient(): Promise<Client> {
    if (this.client !== undefined) return Promise.resolve(this.client)
    if (this.stopped) return Promise.reject(new Error('graph memory is stopped'))
    if (this.startPromise === undefined) {
      this.startPromise = this.connect().finally(() => {
        this.startPromise = undefined
      })
    }
    return this.startPromise
  }

  private async connect(): Promise<Client> {
    if (this.stopped) throw new Error('graph memory is stopped')
    mkdirSync(dirname(this.filePath), { recursive: true })
    const transport = new EnvOnlyStdioTransport({
      command: this.nodePath,
      args: [this.serverEntry],
      // The whole environment: no daemon variables, no secrets.
      env: { [MEMORY_FILE_ENV]: this.filePath },
    })
    const client = new Client({ name: 'dshbot-memory-graph', version: '1.0.0' })
    transport.onclose = () => {
      if (this.client === client) {
        this.client = undefined
        this.transport = undefined
      }
    }
    try {
      await client.connect(transport)
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw new Error(`graph memory server did not start: ${errorText(error)}${this.withStderr(transport)}`)
    }
    if (this.stopped) {
      await client.close().catch(() => undefined)
      throw new Error('graph memory is stopped')
    }
    this.client = client
    this.transport = transport
    return client
  }

  private async reset(): Promise<void> {
    const client = this.client
    const transport = this.transport
    this.client = undefined
    this.transport = undefined
    if (client !== undefined) {
      await client.close().catch(() => undefined)
      return
    }
    if (transport !== undefined) await transport.close().catch(() => undefined)
  }

  private withStderr(transport: EnvOnlyStdioTransport): string {
    const stderr = transport.stderr
    return stderr === '' ? '' : `\n${stderr}`
  }
}
