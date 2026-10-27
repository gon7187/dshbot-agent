// Stable names of migrated secrets. A name either comes from the source (an
// environment variable, a vault row, a provider) or is derived from the config
// path of the field, so a repeated run writes the same file and the report can
// show the pair "field path → name".

import { createHash } from 'node:crypto'

/** Same contract as the daemon vault (`packages/app/src/secrets.ts`). */
export const SECRET_NAME_RE = /^[A-Z0-9_]{1,64}$/

/** The three keys the daemon reads from its systemd EnvironmentFile. */
export const DAEMON_ENV_KEYS = new Set(['TELEGRAM_BOT_TOKEN', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'])

/** Field names whose values are secrets in a plugin config, MCP env or headers. */
export const SECRET_FIELD_RE = /token|key|secret|password|authorization/i

/** A deterministic vault name for a config path such as `plugins.entries.x.config.token`. */
export function derivedName(parts: readonly string[]): string {
  const raw = parts
    .join('_')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  if (raw === '') return `SECRET_${hash(parts.join('_'))}`
  if (raw.length <= 64) return raw
  return `${raw.slice(0, 55)}_${hash(raw)}`
}

/** Provider name for an API key, e.g. `zhipu` → `ZHIPU_API_KEY`. */
export function providerKeyName(provider: string): string {
  const clean = provider.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  return `${clean === '' ? 'PROVIDER' : clean}_API_KEY`
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8).toUpperCase()
}
