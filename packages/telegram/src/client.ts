import { TelegramApiError, type FileUpload, type TelegramApi, type TelegramCallOptions } from './api.js'

const DEFAULT_API_ROOT = 'https://api.telegram.org'
const DEFAULT_FLOOD_BUDGET_MS = 5 * 60 * 1000
/** Extra time over a getUpdates long poll before the HTTP request is aborted. */
const GET_UPDATES_RESERVE_MS = 15_000

/** Bot API errors sometimes echo the request URL, which embeds the bot token. */
const REDACTED = '<redacted>'
/** Not an HTTP status: the request produced no response at all. */
const NETWORK_ERROR_CODE = 0
const MAX_BODY_SNIPPET = 200

export interface CreateTelegramApiOptions {
  token: string
  /** HTTP implementation supplied by the caller; the client never reaches for a global. */
  fetch: typeof globalThis.fetch
  apiRoot?: string
  /** Longest flood-wait the caller is willing to sit through before failing. */
  floodBudgetMs?: number
}

interface BotApiPayload {
  ok?: unknown
  result?: unknown
  error_code?: unknown
  description?: unknown
  parameters?: unknown
}

/** Serializes one Bot API parameter value for a multipart request. */
function formValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

/** Uint8Array is generic over its backing buffer; Blob only accepts ArrayBuffer-backed views. */
function blobData(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer) return data as Uint8Array<ArrayBuffer>
  return new Uint8Array(data)
}

/**
 * The token must never reach an error object: Telegram and the network stack can
 * quote the request URL (`.../bot<token>/method`), so every error text is scrubbed.
 */
function makeRedactor(token: string): (text: string) => string {
  const secrets = new Set<string>()
  if (token.length > 0) {
    secrets.add(token)
    // A URL-encoding layer may have escaped `:` before it reached us.
    secrets.add(encodeURIComponent(token))
  }
  if (secrets.size === 0) return (text) => text
  const ordered = [...secrets].sort((a, b) => b.length - a.length)
  return (text) => {
    let scrubbed = text
    for (const secret of ordered) scrubbed = scrubbed.split(secret).join(REDACTED)
    return scrubbed
  }
}

/** A compact, single-line excerpt of a non-JSON body (usually an HTML 502 page). */
function bodySnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  return collapsed.length > MAX_BODY_SNIPPET ? `${collapsed.slice(0, MAX_BODY_SNIPPET)}...` : collapsed
}

function retryAfterMsFrom(payload: BotApiPayload): number | undefined {
  const parameters = payload.parameters
  if (typeof parameters !== 'object' || parameters === null) return undefined
  const seconds = (parameters as { retry_after?: unknown }).retry_after
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

export function createTelegramApi(options: CreateTelegramApiOptions): TelegramApi {
  const { token } = options
  const fetchImpl = options.fetch
  const apiRoot = (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, '')
  const floodBudgetMs = options.floodBudgetMs ?? DEFAULT_FLOOD_BUDGET_MS
  const redact = makeRedactor(token)

  // One pause per client (per token): every call waits for it before sending,
  // and a shorter competing retry_after can never shorten it.
  let floodPauseUntil = 0

  async function waitForFloodPause(method: string, options: TelegramCallOptions | undefined): Promise<void> {
    for (;;) {
      const remaining = floodPauseUntil - Date.now()
      if (remaining <= 0) return
      if (options?.throwOnFloodWait === true) {
        throw new TelegramApiError(
          method,
          429,
          `flood pause in effect for ${Math.ceil(remaining / 1000)} s`,
          remaining,
        )
      }
      await new Promise<void>((resolve) => setTimeout(resolve, remaining))
    }
  }

  function buildRequest(
    method: string,
    params: Record<string, unknown> | undefined,
    files: Record<string, FileUpload> | undefined,
  ): { url: string; init: RequestInit } {
    const url = `${apiRoot}/bot${token}/${method}`
    if (!files || Object.keys(files).length === 0) {
      return {
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params ?? {}),
        },
      }
    }

    // Never set content-type here: the FormData body must supply its own boundary.
    const body = new FormData()
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue
      body.append(key, formValue(value))
    }
    for (const [key, file] of Object.entries(files)) {
      const blob = new Blob([blobData(file.data)], file.contentType ? { type: file.contentType } : undefined)
      body.append(key, blob, file.name)
    }
    return { url, init: { method: 'POST', body } }
  }

  async function readPayload(response: Response): Promise<{ payload?: BotApiPayload; text: string }> {
    const text = await response.text()
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null) return { payload: parsed as BotApiPayload, text }
      return { text }
    } catch {
      // 502 and friends answer with HTML; keep the body as a diagnostic excerpt.
      return { text }
    }
  }

  async function call<T>(
    method: string,
    params?: Record<string, unknown>,
    files?: Record<string, FileUpload>,
    options?: TelegramCallOptions,
  ): Promise<T> {
    for (;;) {
      await waitForFloodPause(method, options)
      const { url, init } = buildRequest(method, params, files)
      // A long poll must never turn into a forever request: the peer may accept
      // the connection and then stay silent. The deadline covers the requested
      // long-poll time plus a bounded reserve; the poller retries after it.
      const timeoutParam = params?.timeout
      const longPollMs =
        method === 'getUpdates' && typeof timeoutParam === 'number' && Number.isFinite(timeoutParam)
          ? Math.max(0, timeoutParam) * 1000
          : undefined
      const controller = longPollMs === undefined ? undefined : new AbortController()
      const deadline =
        controller === undefined || longPollMs === undefined
          ? undefined
          : setTimeout(() => controller.abort(), longPollMs + GET_UPDATES_RESERVE_MS)
      deadline?.unref?.()
      const signal = options?.signal ?? controller?.signal
      if (signal !== undefined) init.signal = signal
      let response: Response
      try {
        response = await fetchImpl(url, init)
      } catch (cause) {
        // fetch failures often embed the full URL, token included.
        const detail = cause instanceof Error ? cause.message : String(cause)
        const description = redact(detail === '' ? 'network request failed' : detail)
        throw new TelegramApiError(method, NETWORK_ERROR_CODE, description)
      } finally {
        if (deadline !== undefined) clearTimeout(deadline)
      }
      const { payload, text } = await readPayload(response)

      if (payload && payload.ok === true) return payload.result as T

      const errorCode =
        payload && typeof payload.error_code === 'number'
          ? payload.error_code
          : response.status
      const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      const snippet = bodySnippet(text)
      const description =
        payload && typeof payload.description === 'string'
          ? payload.description
          : `${statusLine}${snippet === '' ? '' : `: ${snippet}`}`
      const retryAfterMs = payload ? retryAfterMsFrom(payload) : undefined
      const error = new TelegramApiError(method, errorCode, redact(description), retryAfterMs)

      if (errorCode === 429 && retryAfterMs !== undefined) {
        const now = Date.now()
        const pauseUntil = Math.max(floodPauseUntil, now + retryAfterMs)
        if (pauseUntil - now > floodBudgetMs) throw error
        floodPauseUntil = pauseUntil
        // The caller owns the wait (see TelegramCallOptions.throwOnFloodWait);
        // the shared pause above still holds every other call back.
        if (options?.throwOnFloodWait === true) throw error
        continue
      }

      throw error
    }
  }

  async function downloadFile(filePath: string): Promise<Uint8Array> {
    const clean = filePath.replace(/^\/+/, '')
    const url = `${apiRoot}/file/bot${token}/${clean.split('/').map(encodeURIComponent).join('/')}`
    let response: Response
    try {
      response = await fetchImpl(url, { method: 'GET' })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new TelegramApiError('downloadFile', NETWORK_ERROR_CODE, redact(detail === '' ? 'network request failed' : detail))
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new TelegramApiError('downloadFile', response.status, redact(bodySnippet(text) || `HTTP ${response.status}`))
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  return { call, downloadFile }
}
