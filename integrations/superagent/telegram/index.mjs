import Schema from '@deepseek-ai/schemastery'
import { createTelegramBridge, createTelegramKind, normalizeBoundary, runTelegram } from './bridge.mjs'

export const name = 'dshbot-superagent-telegram'
export const inject = ['orchestrator']

export const Config = Schema.object({
  socketPath: Schema.string().pattern(/^\/[^\0]*$/).required()
    .description('Absolute Unix HTTP socket owned by the Telegram bot.'),
  ownerId: Schema.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).required()
    .description('Positive Telegram owner user/chat ID.'),
  projectId: Schema.number().min(0).max(Number.MAX_SAFE_INTEGER).step(1).required()
    .description('Non-negative factory project ID.'),
})

function boundaryOf(config) {
  return normalizeBoundary(config)
}

function settingsOf(ctx) {
  const settings = ctx.orchestrator?.settings
  if (!settings || typeof settings.pause !== 'function') throw new Error('orchestrator settings.pause is unavailable')
  return settings
}

export function apply(ctx, rawConfig) {
  const boundary = boundaryOf(rawConfig)
  const bridge = createTelegramBridge(boundary, {
    pauseRuntime: () => settingsOf(ctx).pause(true, 'panel'),
    resumeRuntime: () => settingsOf(ctx).pause(false, 'panel'),
    fatal: () => process.exit(1),
    log: message => ctx.logger?.warn?.(message),
  })
  const kind = createTelegramKind(boundary, bridge, () => ctx.orchestrator.sources.instance('telegram')?.config)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'telegram: source kind')
  ctx.effect(() => {
    const source = ctx.orchestrator.context(kind)
    const controller = new AbortController()
    const running = runTelegram(source, bridge, controller.signal).catch(error => {
      if (!controller.signal.aborted) source.report('telegram', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}

export { createTelegramBridge, createTelegramKind, normalizeBoundary, runTelegram } from './bridge.mjs'
