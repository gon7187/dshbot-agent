import http from 'node:http'
import { isAbsolute } from 'node:path'

export const SOURCE = 'telegram'
export const MAX_MESSAGE_CODEPOINTS = 4000
export const MAX_MESSAGE_UTF16_UNITS = 4000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DEFAULT_HTTP_TIMEOUT_MS = 1500
const BRIDGE_PHASES = new Set(['paused', 'arming', 'active'])

export class BridgeProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeProtocolError'
  }
}

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BridgeProtocolError(`${name} must be an object`)
  return value
}

function string(value, name, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0)) throw new BridgeProtocolError(`${name} must be a ${empty ? '' : 'non-empty '}string`)
  if (value.includes('\0')) throw new BridgeProtocolError(`${name} contains NUL`)
  return value
}

function safeInteger(value, name, { positive = false, nonnegative = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive && value <= 0) || (nonnegative && value < 0)) {
    throw new BridgeProtocolError(`${name} must be a ${positive ? 'positive' : nonnegative ? 'non-negative' : 'safe'} integer`)
  }
  return value
}

function optionalInteger(value, name, options) {
  if (value === undefined || value === null) return undefined
  return safeInteger(value, name, options)
}

function isoTime(value, name) {
  const text = string(value, name)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new BridgeProtocolError(`${name} must be an ISO timestamp`)
  return new Date(time).toISOString()
}

function positiveConfig(value, name) {
  return safeInteger(value, name, { positive: true })
}

function nonnegativeConfig(value, name) {
  return safeInteger(value, name, { nonnegative: true })
}

export function normalizeBoundary(value) {
  const config = record(value, 'plugin config')
  const unknown = Object.keys(config).find(key => !['socketPath', 'ownerId', 'projectId'].includes(key))
  if (unknown !== undefined) throw new BridgeProtocolError(`Unknown Telegram plugin config key: ${unknown}`)
  const socketPath = string(config.socketPath, 'socketPath')
  if (!isAbsolute(socketPath) || socketPath === '/') throw new BridgeProtocolError('socketPath must be an absolute socket path')
  return Object.freeze({ socketPath, ownerId: positiveConfig(config.ownerId, 'ownerId'), projectId: nonnegativeConfig(config.projectId, 'projectId') })
}

function schema(parse) {
  return {
    parse,
    safeParse(value) {
      try { return { success: true, data: parse(value) } }
      catch (error) { return { success: false, error } }
    },
  }
}

function parseSourceConfig(value, boundary) {
  const input = value === undefined ? {} : record(value, 'Telegram Source config')
  const keys = Object.keys(input)
  if (keys.some(key => key !== 'ownerId')) throw new BridgeProtocolError(`Unknown Telegram Source config key: ${keys.find(key => key !== 'ownerId')}`)
  return { ownerId: input.ownerId === undefined ? boundary.ownerId : positiveConfig(input.ownerId, 'ownerId') }
}

function parseAllowed(value, boundary) {
  const input = value === undefined ? {} : record(value, 'Telegram Source policy')
  const keys = Object.keys(input)
  if (keys.some(key => key !== 'allowed')) throw new BridgeProtocolError(`Unknown Telegram Source policy key: ${keys.find(key => key !== 'allowed')}`)
  const allowed = input.allowed === undefined ? [{ id: String(boundary.ownerId) }] : input.allowed
  if (!Array.isArray(allowed)) throw new BridgeProtocolError('Telegram policy allowed must be an array')
  const seen = new Set()
  return { allowed: allowed.map((entry, index) => {
    const item = record(entry, `Telegram policy allowed[${index}]`)
    const itemKeys = Object.keys(item)
    if (itemKeys.some(key => key !== 'id' && key !== 'name')) throw new BridgeProtocolError(`Unknown Telegram policy allowed key: ${itemKeys.find(key => key !== 'id' && key !== 'name')}`)
    const id = string(item.id, `Telegram policy allowed[${index}].id`)
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new BridgeProtocolError(`Telegram policy allowed[${index}].id must be a positive Telegram user id`)
    if (seen.has(id)) throw new BridgeProtocolError(`Duplicate Telegram policy owner: ${id}`)
    seen.add(id)
    const name = item.name === undefined ? undefined : string(item.name, `Telegram policy allowed[${index}].name`, { empty: true }).trim()
    if (name !== undefined && name.length > 100) throw new BridgeProtocolError('Telegram policy owner name is too long')
    return name === undefined ? { id } : { id, name }
  }) }
}

function parseEvent(value, boundary) {
  const event = record(value, 'Telegram event')
  const projectId = nonnegativeConfig(event.projectId, 'event.projectId')
  if (projectId !== boundary.projectId) throw new BridgeProtocolError('Telegram event belongs to another project')
  const updateId = safeInteger(event.updateId, 'event.updateId', { nonnegative: true })
  const messageId = safeInteger(event.messageId, 'event.messageId', { positive: true })
  const chatId = safeInteger(event.chatId, 'event.chatId', { positive: true })
  const fromId = safeInteger(event.fromId, 'event.fromId', { positive: true })
  const rootMessageId = safeInteger(event.rootMessageId, 'event.rootMessageId', { positive: true })
  const id = string(event.id, 'event.id')
  const expectedId = `telegram:${chatId}:${updateId}`
  if (id !== expectedId) throw new BridgeProtocolError(`Telegram event id does not match update ${expectedId}`)
    const text = string(event.text, 'event.text')
  const at = isoTime(event.at, 'event.at')
  const replyTo = optionalInteger(event.replyTo, 'event.replyTo', { positive: true })
  return Object.freeze({ id, projectId, updateId, messageId, chatId, fromId, rootMessageId, text, at, ...(replyTo === undefined ? {} : { replyTo }) })
}

function eventId(value, name) {
  const id = string(value, name)
  if (!/^telegram:[1-9]\d*:\d+$/.test(id)) throw new BridgeProtocolError(`${name} must be a Telegram event id`)
  return id
}

export function parseEventsResponse(value, boundary) {
  const body = record(value, 'GET /events response')
  if (typeof body.phase !== 'string' || !BRIDGE_PHASES.has(body.phase)) throw new BridgeProtocolError('GET /events phase is invalid')
  const generation = nonnegativeConfig(body.generation, 'GET /events generation')
  if (body.projectId !== undefined && nonnegativeConfig(body.projectId, 'GET /events projectId') !== boundary.projectId) {
    throw new BridgeProtocolError('GET /events belongs to another project')
  }
  const ownerId = body.ownerId === null ? null : positiveConfig(body.ownerId, 'GET /events ownerId')
  if (!Array.isArray(body.events)) throw new BridgeProtocolError('GET /events events must be an array')
  return Object.freeze({ phase: body.phase, generation, ownerId, events: body.events.map(event => parseEvent(event, boundary)) })
}

function messageId(value, name) {
  if (typeof value === 'string') return string(value, name)
  return String(safeInteger(value, name, { positive: true }))
}

export function parseThreadResponse(value, expected = {}) {
  const body = record(value, 'GET /thread response')
  if (body.projectId !== undefined) {
    const projectId = nonnegativeConfig(body.projectId, 'GET /thread projectId')
    if (expected.projectId !== undefined && projectId !== expected.projectId) throw new BridgeProtocolError('GET /thread belongs to another project')
  }
  if (body.chatId !== undefined) {
    const chatId = positiveConfig(body.chatId, 'GET /thread chatId')
    if (expected.chatId !== undefined && chatId !== expected.chatId) throw new BridgeProtocolError('GET /thread belongs to another chat')
  }
  if (body.rootMessageId !== undefined) {
    const rootMessageId = positiveConfig(body.rootMessageId, 'GET /thread rootMessageId')
    if (expected.rootMessageId !== undefined && rootMessageId !== expected.rootMessageId) throw new BridgeProtocolError('GET /thread belongs to another root')
  }
  if (!Array.isArray(body.messages)) throw new BridgeProtocolError('GET /thread messages must be an array')
  const messages = body.messages.map((raw, index) => {
    const item = record(raw, `thread message ${index}`)
    const legacy = item.id === undefined && item.messageId !== undefined
    const id = messageId(legacy ? item.messageId : item.id, `thread message ${index}.${legacy ? 'messageId' : 'id'}`)
    let from
    let bot = false
    if (legacy) {
      if (item.direction !== 'incoming' && item.direction !== 'outgoing') throw new BridgeProtocolError(`thread message ${index}.direction must be incoming or outgoing`)
      bot = item.direction === 'outgoing'
      from = bot ? 'bot' : String(expected.ownerId ?? '')
      if (!from) throw new BridgeProtocolError(`thread message ${index}.from is missing`)
    } else {
      from = typeof item.from === 'number' ? String(safeInteger(item.from, `thread message ${index}.from`, { positive: true })) : string(item.from, `thread message ${index}.from`)
      if (item.bot !== undefined && typeof item.bot !== 'boolean') throw new BridgeProtocolError(`thread message ${index}.bot must be boolean`)
      bot = item.bot === true
    }
    const at = isoTime(item.at, `thread message ${index}.at`)
    const text = string(item.text, `thread message ${index}.text`, { empty: true })
    const replyFromSnake = item.reply_to === undefined || item.reply_to === null ? undefined : messageId(item.reply_to, `thread message ${index}.reply_to`)
    const replyFromCamel = item.replyTo === undefined || item.replyTo === null ? undefined : messageId(item.replyTo, `thread message ${index}.replyTo`)
    if (replyFromSnake !== undefined && replyFromCamel !== undefined && replyFromSnake !== replyFromCamel) {
      throw new BridgeProtocolError(`thread message ${index} has conflicting reply targets`)
    }
    const replyTo = replyFromSnake ?? replyFromCamel
    return { id, from, at, text, ...(bot ? { bot: true } : {}), ...(replyTo === undefined ? {} : { reply_to: replyTo }) }
  })
  return { messages }
}

function parseReceipt(value) {
  const body = record(value, 'POST /outbox response')
  if (!['pending', 'sent', 'uncertain', 'gone'].includes(body.state)) throw new BridgeProtocolError('POST /outbox state is invalid')
  if (body.messageId !== undefined) safeInteger(body.messageId, 'POST /outbox messageId', { positive: true })
  return { state: body.state, ...(body.messageId === undefined ? {} : { messageId: body.messageId }) }
}

export function requestUnix(socketPath, path, { method = 'GET', body, signal, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, acceptStatuses = [] } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = http.request({ socketPath, path, method, headers: {
      accept: 'application/json',
      ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
    }, signal, timeout: timeoutMs }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) { request.destroy(new Error('Unix HTTP response is too large')); return }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode < 200 || response.statusCode >= 300) && !acceptStatuses.includes(response.statusCode)) {
          finish(new Error(`Unix HTTP ${method} ${path} returned ${response.statusCode}`)); return
        }
        if (!text.trim()) { finish(undefined, undefined); return }
        try { finish(undefined, JSON.parse(text)) }
        catch (error) { finish(new BridgeProtocolError(`Unix HTTP ${method} ${path} returned invalid JSON: ${String(error)}`)) }
      })
      response.on('error', error => finish(error))
    })
    request.on('timeout', () => request.destroy(new Error(`Unix HTTP ${method} ${path} timed out`)))
    request.on('error', error => finish(signal?.aborted ? new Error('Unix HTTP request aborted') : error))
    if (signal?.aborted) { request.destroy(); finish(new Error('Unix HTTP request aborted')); return }
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

export function createTelegramBridge(rawBoundary, options = {}) {
  const boundary = normalizeBoundary(rawBoundary)
  const pauseRuntime = typeof options.pauseRuntime === 'function' ? options.pauseRuntime : async () => {}
  const resumeRuntime = typeof options.resumeRuntime === 'function' ? options.resumeRuntime : async () => {}
  const fatal = typeof options.fatal === 'function' ? options.fatal : () => {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const events = async signal => parseEventsResponse(await requestUnix(boundary.socketPath, `/events?projectId=${boundary.projectId}`, { signal }), boundary)
  const ack = async (id, signal) => {
    eventId(id, 'ack.id')
    await requestUnix(boundary.socketPath, '/ack', { method: 'POST', body: { id, projectId: boundary.projectId }, signal })
  }
  const armed = async (generation, signal) => {
    const value = nonnegativeConfig(generation, 'armed.generation')
    await requestUnix(boundary.socketPath, '/armed', { method: 'POST', body: { projectId: boundary.projectId, generation: value }, signal })
  }
  const thread = async (input, signal) => {
    const { chatId, rootMessageId } = record(input, 'thread request')
    const chat = safeInteger(chatId, 'thread.chatId', { positive: true })
    const root = safeInteger(rootMessageId, 'thread.rootMessageId', { positive: true })
    return parseThreadResponse(await requestUnix(boundary.socketPath, `/thread?projectId=${boundary.projectId}&root=${root}&chat=${chat}`, { signal }), {
      projectId: boundary.projectId, chatId: chat, rootMessageId: root, ownerId: boundary.ownerId,
    })
  }
  const outbox = async (input, signal) => {
    const { id, chatId, rootMessageId, replyTo, text } = record(input, 'outbox request')
    string(id, 'outbox.id')
    const chat = safeInteger(chatId, 'outbox.chatId', { positive: true })
    const root = safeInteger(rootMessageId, 'outbox.rootMessageId', { positive: true })
    const reply = safeInteger(replyTo, 'outbox.replyTo', { positive: true })
    const value = string(text, 'outbox.text')
    return parseReceipt(await requestUnix(boundary.socketPath, '/outbox', { method: 'POST', acceptStatuses: [409], body: {
      id, projectId: boundary.projectId, chatId: chat, rootMessageId: root, replyTo: reply, text: value,
    }, signal }))
  }
  return Object.freeze({ ...boundary, events, ack, armed, thread, outbox, pauseRuntime, resumeRuntime, fatal, log })
}

export function eventTrigger(event, sourceConfig, boundary) {
  const config = parseSourceConfig(sourceConfig, boundary)
  if (event.projectId !== boundary.projectId) throw new BridgeProtocolError('Telegram event belongs to another project')
  if (event.chatId !== config.ownerId || event.fromId !== config.ownerId) throw new BridgeProtocolError('Telegram event is not a private message from the configured owner')
  return {
    id: event.id, source: SOURCE, threads: [{ source: SOURCE, id: `${event.chatId}:${event.rootMessageId}` }],
    actor: { source: SOURCE, id: String(event.fromId) }, human: true, addressed: 'direct', at: event.at, text: event.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${event.chatId}:${event.rootMessageId}`, address: {
      projectId: String(boundary.projectId), chatId: String(event.chatId), rootMessageId: String(event.rootMessageId), replyTo: String(event.messageId),
    } },
    meta: { projectId: event.projectId, chatId: event.chatId, fromId: event.fromId, updateId: event.updateId,
      messageId: event.messageId, rootMessageId: event.rootMessageId, direct: true, ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }) },
  }
}

export function splitText(text, limit = MAX_MESSAGE_CODEPOINTS) {
  const value = string(text, 'message.text', { empty: true })
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('split limit must be positive')
  const points = Array.from(value)
  if (points.length === 0) return ['']
  const parts = []
  let part = ''
  let pointCount = 0
  for (const point of points) {
    if (point.length > MAX_MESSAGE_UTF16_UNITS) throw new RangeError('message character exceeds Telegram text limit')
    if (part && (pointCount >= limit || part.length + point.length > MAX_MESSAGE_UTF16_UNITS)) {
      parts.push(part)
      part = ''
      pointCount = 0
    }
    part += point
    pointCount += 1
  }
  if (part) parts.push(part)
  return parts
}

function allowedAddress(address, config, boundary) {
  try {
    const value = record(address, 'Telegram channel address')
    const addressNumber = (input, name, options) => {
      if (typeof input !== 'string' || !/^\d+$/.test(input)) throw new BridgeProtocolError(`${name} must be a decimal string`)
      return safeInteger(Number(input), name, options)
    }
    const projectId = addressNumber(value.projectId, 'Telegram channel projectId', { nonnegative: true })
    const chatId = addressNumber(value.chatId, 'Telegram channel chatId', { positive: true })
    const rootMessageId = addressNumber(value.rootMessageId, 'Telegram channel rootMessageId', { positive: true })
    const replyTo = addressNumber(value.replyTo, 'Telegram channel replyTo', { positive: true })
    return projectId === boundary.projectId && chatId === config.ownerId && rootMessageId > 0 && replyTo > 0
  } catch {
    return false
  }
}

export function createTelegramKind(rawBoundary, bridge = createTelegramBridge(rawBoundary), sourceConfig = () => undefined) {
  const boundary = normalizeBoundary(rawBoundary)
  if (typeof sourceConfig !== 'function') throw new TypeError('sourceConfig must be a function')
  const configSchema = schema(value => parseSourceConfig(value, boundary))
  const policySchema = schema(value => parseAllowed(value, boundary))
  const kind = {
    kind: SOURCE,
    title: { zh: 'Telegram', en: 'Telegram' },
    description: { zh: 'Receives the owner private chat through the local Telegram bridge socket.', en: 'Receives the owner private chat through the local Telegram bridge socket.' },
    schema: configSchema,
    fields: [{ key: 'ownerId', type: 'number', min: 1, max: Number.MAX_SAFE_INTEGER,
      label: { zh: 'Telegram owner ID', en: 'Telegram owner ID' },
      hint: { zh: 'Defaults to the owner ID at the bridge boundary; only this private chat is received.', en: 'Defaults to the owner ID at the bridge boundary; only this private chat is received.' } }],
    health: ['telegram'],
    scope({ meta }, config) {
      const parsed = parseSourceConfig(config, boundary)
      const metaNumber = value => typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
      const projectId = metaNumber(meta.projectId)
      const chatId = metaNumber(meta.chatId)
      const fromId = metaNumber(meta.fromId)
      return projectId === boundary.projectId && Number.isSafeInteger(chatId) && Number.isSafeInteger(fromId) && meta.direct === true
        && chatId === parsed.ownerId && fromId === parsed.ownerId
        ? { listened: true, observed: false, row: String(parsed.ownerId) }
        : { listened: false, reason: 'owner_private_chat_required' }
    },
    channel: {
      allowed: (address, config) => {
        try { return allowedAddress(address, parseSourceConfig(config, boundary), boundary) }
        catch { return false }
      },
      async send(_host, message) {
        const config = parseSourceConfig(sourceConfig(), boundary)
        if (!allowedAddress(message.channel.address, config, boundary)) throw new Error('Telegram reply target is not the configured owner channel')
        const parts = splitText(message.text)
        for (let index = 0; index < parts.length; index += 1) {
          const id = parts.length === 1 ? message.id : `${message.id}:part:${index + 1}`
          const receipt = await bridge.outbox({ id, chatId: Number(message.channel.address.chatId),
            rootMessageId: Number(message.channel.address.rootMessageId), replyTo: Number(message.channel.address.replyTo), text: parts[index] })
          if (receipt.state === 'gone') return 'gone'
          if (receipt.state !== 'sent') throw new Error(`Telegram outbox ${receipt.state} for ${id}`)
        }
        return 'sent'
      },
      link: () => ({ url: '', label: { zh: 'Telegram message', en: 'Telegram message' } }),
    },
    threadContext: {
      messageId: trigger => {
        const value = trigger.meta.messageId
        return messageId(value, 'trigger.messageId')
      },
      async read(_commands, trigger, part) {
        if (trigger.source !== SOURCE || trigger.meta.projectId !== boundary.projectId || trigger.meta.direct !== true) {
          throw new BridgeProtocolError('Telegram thread trigger is outside the configured project')
        }
        const config = parseSourceConfig(sourceConfig(), boundary)
        const chatId = positiveConfig(Number(trigger.meta.chatId), 'trigger.chatId')
        const rootMessageId = positiveConfig(Number(trigger.meta.rootMessageId), 'trigger.rootMessageId')
        const fromId = positiveConfig(Number(trigger.meta.fromId), 'trigger.fromId')
        if (chatId !== config.ownerId || fromId !== config.ownerId) throw new BridgeProtocolError('Telegram thread trigger is outside the configured owner chat')
        const result = await bridge.thread({ chatId, rootMessageId })
        const messages = part === 'thread' ? result.messages
          : part === 'root' ? result.messages.filter(message => message.id === String(rootMessageId))
            : result.messages.filter(message => message.id === String(trigger.meta.replyTo ?? ''))
        return { messages, body: { messages } }
      },
    },
    policy: {
      schema: policySchema,
      fields: [{ key: 'allowed', type: 'rows', label: { zh: 'Telegram owners who may originate work', en: 'Telegram owners who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'Telegram user ID', en: 'Telegram user ID' }, pattern: '[0-9]+' },
          { key: 'name', type: 'text', label: { zh: 'Name', en: 'Name' }, optional: true }] }],
      explicit: { zh: 'An owner on the list writing in the private chat is always an explicit request.', en: 'An owner on the list writing in the private chat is always an explicit request.' },
      rows(stored) {
        const config = parseSourceConfig(stored, boundary)
        return [{ id: String(config.ownerId), label: String(config.ownerId), note: { zh: 'Owner private chat only', en: 'Owner private chat only' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }]
      },
    },
  }
  return Object.freeze(kind)
}

export async function consumeEvents(source, bridge, response) {
  const config = source.config(SOURCE)
  if (!source.configured() || !config) return { consumed: 0, skipped: response.events.length, configured: false }
  const expectedOwner = parseSourceConfig(config, bridge).ownerId
  if (response.ownerId !== expectedOwner) throw new BridgeProtocolError('Telegram bridge owner does not match Source config')
  if (response.phase !== 'active') return { consumed: 0, skipped: response.events.length, paused: true }
  let consumed = 0
  let filtered = 0
  for (const event of response.events) {
    const trigger = eventTrigger(event, config, bridge)
    const result = await source.receive(trigger)
    if (result !== 'stored' && result !== 'duplicate' && result !== 'filtered') throw new BridgeProtocolError(`Telegram trigger ${event.id} was not durably accepted (${result})`)
    await bridge.ack(event.id)
    consumed += 1
    if (result === 'filtered') filtered += 1
  }
  return { consumed, filtered, skipped: 0, configured: true }
}

async function report(source, value) {
  try { source.report('telegram', value) } catch { /* health reporting must not tear down the bridge lifecycle */ }
}

async function pauseAndReport(source, bridge, error) {
  const detail = String(error)
  try {
    await bridge.pauseRuntime(detail)
    await report(source, { state: 'paused', detail: `Bridge paused runtime: ${detail}` })
    return true
  } catch (pauseError) {
    await report(source, { state: 'error', detail: `Bridge could not pause runtime: ${String(pauseError)}; ${detail}` })
    return false
  }
}

export function waitFor(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export async function runTelegram(source, bridge, signal, { pollMs = 1000, fatal: fatalOption } = {}) {
  await source.ready
  let lastGeneration
  let barrierGeneration
  let armedGeneration
  let armingAcknowledged
  let pauseSatisfied
  let resumedGeneration
  let fatalBlocked = false
  const fatal = typeof fatalOption === 'function' ? fatalOption : typeof bridge.fatal === 'function' ? bridge.fatal : () => {}

  const setBarrier = generation => {
    const floor = Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
    barrierGeneration = barrierGeneration === undefined ? floor : Math.max(barrierGeneration, floor)
    armedGeneration = undefined
    armingAcknowledged = undefined
  }

  const ensurePaused = async (generation, detail) => {
    if (pauseSatisfied === generation) {
      await report(source, { state: 'paused', detail: `Telegram bridge requires an explicit owner resume or restart: ${detail}` })
      return true
    }
    const paused = await pauseAndReport(source, bridge, new Error(detail))
    if (paused) pauseSatisfied = generation
    return paused
  }

  const fatalPause = async (generation, detail) => {
    const error = new BridgeProtocolError(detail)
    fatalBlocked = true
    fatal(error)
    pauseSatisfied = undefined
    setBarrier(generation)
    await ensurePaused(generation, detail)
  }

  while (!signal.aborted) {
    try {
      const response = await bridge.events(signal)
      if (fatalBlocked) {
        await report(source, { state: 'paused', detail: 'Telegram bridge terminated after a fatal protocol or transport fault' })
        await waitFor(pollMs, signal)
        continue
      }
      const config = source.config(SOURCE)
      const ownerId = config ? parseSourceConfig(config, bridge).ownerId : bridge.ownerId
      if (response.phase !== 'paused' && response.ownerId === null) throw new BridgeProtocolError('Telegram bridge has no paired owner')
      if (response.ownerId !== null && response.ownerId !== ownerId) throw new BridgeProtocolError('Telegram bridge owner does not match Source config')
      const stale = lastGeneration !== undefined && response.generation < lastGeneration
      if (!stale && (lastGeneration === undefined || response.generation > lastGeneration)) lastGeneration = response.generation

      if (stale) {
        await fatalPause(lastGeneration, `Telegram bridge returned stale generation ${response.generation}`)
        return
      } else if (response.phase === 'paused') {
        setBarrier(response.generation)
        await ensurePaused(response.generation, 'Telegram bridge is paused')
      } else if (response.phase === 'arming') {
        if (barrierGeneration !== undefined && response.generation <= barrierGeneration) {
          await fatalPause(barrierGeneration, `Telegram bridge arming generation ${response.generation} is stale`)
          return
        } else if (armingAcknowledged === response.generation) {
          await report(source, { state: 'paused', detail: 'Telegram bridge is arming; waiting for active confirmation' })
        } else if (await ensurePaused(response.generation, `Telegram bridge is arming generation ${response.generation}`)) {
          await bridge.armed(response.generation, signal)
          armingAcknowledged = response.generation
          armedGeneration = response.generation
          barrierGeneration = undefined
        }
      } else if (barrierGeneration !== undefined || armedGeneration !== response.generation || armingAcknowledged !== response.generation) {
        await fatalPause(response.generation, `Telegram bridge active generation ${response.generation} was not armed`)
        return
      } else if (!source.configured()) {
        await report(source, { state: 'paused', detail: 'Waiting for Source setup' })
      } else if (!config) {
        await report(source, { state: 'paused', detail: 'Telegram Source is off' })
      } else {
        if (resumedGeneration !== response.generation) {
          await bridge.resumeRuntime?.()
          resumedGeneration = response.generation
        }
        const result = await consumeEvents(source, bridge, response)
        await report(source, { state: 'ready', detail: `${result.consumed} Telegram events accepted`, at: new Date().toISOString() })
      }
    } catch (error) {
      if (signal.aborted) break
      fatalBlocked = true
      fatal(error)
    }
    await waitFor(pollMs, signal)
  }
}

export { parseSourceConfig, parseAllowed }
