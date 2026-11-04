/** Upstream Runtime entry gated on the Telegram guard service. */
import * as upstream from '../upstream/lib/index.js'

export const name = upstream.name
export const Config = upstream.Config
export const inject = [...upstream.inject, 'dshbotSuperagentGuard']

export const FIRST_PROFILE_DELIVERY_POLICY = [
  'Delivery is helper-only; raw git push and gh merge are blocked.',
  'From the clean, committed ticket cwd invoke the immutable delivery broker exactly as `/opt/node /opt/superagent/telegram/delivery-cli.mjs <title>`; the helper sends the patch to the host.',
  'The host independently runs the full factory test command in bwrap and a stateless review, opens the PR, and performs a normal non-force merge push of the exact tested tree.',
  'The owner approved the same account, no CI, and local tests plus review. Deployment is a separate explicit command and is never implied by delivery.',
  'Use the fixed `/opt/superagent/telegram/github-cli.mjs` broker for GitHub Source operations. Never put credentials in this profile.',
  'Report `failed` and `pr_open` truthfully; delivery is successful only with a verified durable merged receipt, never from a local push, an open PR, or an unverified response.',
].join(' ')

function runtimeService(ctx) {
  if (typeof ctx?.get !== 'function') throw new TypeError('dsh-superagent runtime wrapper requires ctx.get')
  const runtime = ctx.get('orchestrator', false)
  if (runtime === undefined || runtime === null || typeof runtime !== 'object') {
    throw new TypeError('dsh-superagent runtime did not provide orchestrator')
  }
  return runtime
}

function validateRuntime(runtime) {
  if (runtime.settings === undefined || runtime.settings === null || typeof runtime.settings.pause !== 'function') {
    throw new TypeError('dsh-superagent runtime orchestrator has no settings.pause')
  }
  if (runtime.prompts === undefined || runtime.prompts === null
    || typeof runtime.prompts.current !== 'function' || typeof runtime.prompts.save !== 'function') {
    throw new TypeError('dsh-superagent runtime orchestrator has no prompts.current/save')
  }
  if (typeof runtime.stop !== 'function') throw new TypeError('dsh-superagent runtime orchestrator has no stop')
  return runtime
}

async function initializeFirstProfileDelivery(runtime) {
  const current = await runtime.prompts.current()
  if (current === undefined || current === null || typeof current !== 'object') {
    throw new TypeError('dsh-superagent runtime prompts.current returned an invalid prompt revision')
  }
  if (current.revision !== 0) return
  if (current.config === undefined || current.config === null || typeof current.config !== 'object') {
    throw new TypeError('dsh-superagent runtime prompts.current returned an invalid prompt config')
  }
  const config = { ...current.config, delivery: FIRST_PROFILE_DELIVERY_POLICY }
  await runtime.prompts.save(config, current.revision, 'panel')
}

async function stopBestEffort(runtime) {
  try { await runtime?.stop?.() } catch { /* preserve the startup failure */ }
}

export async function apply(ctx, config) {
  let pending
  let applyError
  try {
    pending = Promise.resolve(upstream.apply(ctx, config))
    // Keep a rejection handler attached while validation/pause awaits run.
    pending.catch(() => {})
  } catch (error) {
    applyError = error
  }

  let runtime
  try {
    runtime = runtimeService(ctx)
    validateRuntime(runtime)
    if (applyError !== undefined) throw applyError
    await runtime.settings.pause(true, 'panel')
    const result = await pending
    await initializeFirstProfileDelivery(runtime)
    return result
  } catch (error) {
    await stopBestEffort(runtime)
    throw error
  }
}
