// Contract shared by the Telegram modules: everything talks to Bot API through TelegramApi,
// so tests swap in a fake that records calls instead of a real fetch.

export interface FileUpload {
  name: string
  data: Uint8Array
  contentType?: string
}

/** Per-call options of {@link TelegramApi.call}. */
export interface TelegramCallOptions {
  /** Aborts the HTTP request; used by the poller's request deadline. */
  readonly signal?: AbortSignal
  /**
   * The caller sleeps through flood waits itself: a 429, or a call made while
   * the client's shared flood pause is still on, is thrown at once with
   * `retryAfterMs` instead of being waited out inside the call. The poller
   * sets it so its stall watchdog can tell a planned pause from a hang.
   */
  readonly throwOnFloodWait?: boolean
}

export interface TelegramApi {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    files?: Record<string, FileUpload>,
    options?: TelegramCallOptions,
  ): Promise<T>
  /**
   * Download a file by the `file_path` returned from `getFile`. The Bot API
   * serves files from a different root than the method endpoints, so the
   * client owns the URL and the token.
   */
  downloadFile?(filePath: string): Promise<Uint8Array>
}

export class TelegramApiError extends Error {
  readonly method: string
  readonly errorCode: number
  readonly description: string
  readonly retryAfterMs: number | undefined

  constructor(method: string, errorCode: number, description: string, retryAfterMs?: number) {
    super(`${method}: ${errorCode} ${description}`)
    this.name = 'TelegramApiError'
    this.method = method
    this.errorCode = errorCode
    this.description = description
    this.retryAfterMs = retryAfterMs
  }
}
