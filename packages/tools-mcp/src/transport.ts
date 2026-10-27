// Stdio transport for the MCP servers of the owner with an explicit environment.
//
// The SDK's StdioClientTransport spreads `getDefaultEnvironment()` (HOME, PATH,
// SHELL, USER, ...) under the caller's env, and the harness bridge starts from
// `scrubbedParentEnv()`, which still carries every ambient name that does not
// look like a credential. An MCP server of the owner must get only PATH, HOME,
// LANG and the env entries written in `mcp.json`, so this transport spawns the
// process with exactly the environment the caller passes: the keys of the bot
// (DEEPSEEK_API_KEY, TELEGRAM_BOT_TOKEN, ...) cannot reach it by construction.
//
// Framing is the MCP stdio framing: one JSON-RPC message per line. ReadBuffer
// and serializeMessage come from @modelcontextprotocol/client, so this file
// only owns the process life cycle.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client'

/** How long a child gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000

/** How much of the child's stderr is kept for error messages. */
const STDERR_TAIL_CHARS = 4_000

export interface StdioTransportOptions {
  /** Executable from `mcp.json`. */
  command: string
  /** Arguments from `mcp.json`, passed without shell interpolation. */
  args: readonly string[]
  /** Working directory from `mcp.json`; absent means the daemon's directory. */
  cwd?: string
  /** The complete environment of the child. */
  env: Readonly<Record<string, string>>
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** MCP client transport over a child process that inherits no parent environment. */
export class EnvOnlyStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private child: ChildProcessWithoutNullStreams | undefined
  private readonly buffer = new ReadBuffer()
  private stderrTail = ''
  private closing = false

  private readonly options: StdioTransportOptions

  constructor(options: StdioTransportOptions) {
    this.options = options
  }

  /** Last stderr output of the server, for tool error messages. */
  get stderr(): string {
    return this.stderrTail.trim()
  }

  async start(): Promise<void> {
    if (this.child !== undefined) throw new Error('stdio transport already started')
    const child = spawn(this.options.command, [...this.options.args], {
      env: { ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
    })
    this.child = child

    child.on('close', () => {
      if (this.child === child) this.child = undefined
      this.onclose?.()
    })
    child.stdin.on('error', (error) => this.onerror?.(errorOf(error)))
    child.stdout.on('error', (error) => this.onerror?.(errorOf(error)))
    child.stderr.on('error', () => undefined)
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk)
        for (;;) {
          const message = this.buffer.readMessage()
          if (message === null) break
          this.onmessage?.(message)
        }
      } catch (error) {
        this.onerror?.(errorOf(error))
        void this.close()
      }
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => {
        reject(error)
        this.onerror?.(errorOf(error))
      })
    })
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.child
      if (child === undefined || child.stdin.destroyed) {
        reject(new Error('MCP server is not running'))
        return
      }
      try {
        const line = serializeMessage(message)
        if (child.stdin.write(line)) resolve()
        else child.stdin.once('drain', resolve)
      } catch (error) {
        reject(errorOf(error))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const child = this.child
    this.child = undefined
    try {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          finish()
        }, KILL_GRACE_MS)
        child.once('exit', finish)
        try {
          child.kill('SIGTERM')
        } catch {
          finish()
        }
      })
    } finally {
      this.closing = false
    }
  }
}
