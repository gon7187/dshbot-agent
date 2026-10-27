// Named agent profiles of the owner: `<DSHBOT_HOME>/agents.json`.
//
// The file is a JSON array of profiles, each `{name, description, tools,
// instructions, model}`. A profile names a narrow sub-agent: `delegate` with
// `agent: "<name>"` gives the child only the profile tools (intersected with
// the tools no child may hold) and the profile instructions on the profile
// model; a schedule job with `agent: "<name>"` runs its planned turn in the
// same profile.
//
// A missing file simply means "no profiles". A file that cannot be read, is
// not valid JSON, is not an array, or has one malformed or duplicate entry is
// reported in the journal and yields no profiles at all: the daemon keeps
// working, and both `delegate` and `schedule` answer with an ordinary error.
// The loader never throws into the start of the daemon.

import { readFileSync } from 'node:fs'

/**
 * The two routes a profile may name. The bot never picks the expensive `pro`
 * route on its own, so the loader accepts it for compatibility but stores and
 * runs the profile on `flash` and says so in the journal once.
 */
export type AgentProfileModel = 'flash' | 'pro'

/** One named sub-agent profile. */
export interface AgentProfile {
  name: string
  description: string
  /** Tools the profile allows; the runner still cuts everything a child may not hold. */
  tools: string[]
  /** Instructions the child (or the planned turn) gets with its system prompt. */
  instructions: string
  model: AgentProfileModel
}

/** Read-only view of the loaded profiles, indexed by name. */
export interface AgentProfileBook {
  /** Profiles in file order. */
  list(): readonly AgentProfile[]
  /** One profile by exact name, or undefined. */
  get(name: string): AgentProfile | undefined
}

const EMPTY_BOOK: AgentProfileBook = Object.freeze({
  list: () => [],
  get: () => undefined,
})

/** Names become part of a harness session id, so the loader keeps them path-safe. */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Validate one profile object; a string result is the reason it is refused. */
function readProfile(value: unknown, index: number): AgentProfile | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `entry ${index + 1} is not an object`
  }
  const raw = value as Record<string, unknown>
  const name = nonEmptyString(raw.name)
  if (name === undefined) return `entry ${index + 1} has no non-empty name`
  if (!PROFILE_NAME_RE.test(name) || name.includes('..')) {
    return `profile "${name}": the name may contain only letters, digits, dot, dash and underscore`
  }
  const description = nonEmptyString(raw.description)
  if (description === undefined) return `profile "${name}" has no non-empty description`
  if (!Array.isArray(raw.tools) || raw.tools.some((tool) => typeof tool !== 'string')) {
    return `profile "${name}": tools must be an array of tool names`
  }
  const tools: string[] = []
  for (const tool of raw.tools as string[]) {
    const trimmed = tool.trim()
    if (trimmed !== '' && !tools.includes(trimmed)) tools.push(trimmed)
  }
  const instructions = nonEmptyString(raw.instructions)
  if (instructions === undefined) return `profile "${name}" has no non-empty instructions`
  const model =
    typeof raw.model === 'string' && raw.model.trim().toLowerCase() === 'pro'
      ? 'pro'
      : typeof raw.model === 'string' && raw.model.trim().toLowerCase() === 'flash'
        ? 'flash'
        : undefined
  if (model === undefined) return `profile "${name}": model must be "flash" or "pro"`
  return { name, description, tools, instructions, model }
}

/**
 * Load the profiles of one agents.json. `journal` receives exactly one line
 * when the file exists but cannot be used; the caller keeps running with no
 * profiles then. A missing file is not an error.
 */
export function loadAgentProfiles(file: string, journal: (message: string) => void): AgentProfileBook {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_BOOK
    journal(`agents.json: cannot read ${file}: ${messageOf(error)}; agent profiles are disabled`)
    return EMPTY_BOOK
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    journal(`agents.json: ${file} is not valid JSON (${messageOf(error)}); agent profiles are disabled`)
    return EMPTY_BOOK
  }
  if (!Array.isArray(parsed)) {
    journal(`agents.json: ${file} must contain a JSON array of profiles; agent profiles are disabled`)
    return EMPTY_BOOK
  }
  const profiles = new Map<string, AgentProfile>()
  for (const [index, value] of parsed.entries()) {
    const profile = readProfile(value, index)
    if (typeof profile === 'string') {
      journal(`agents.json: ${file}: ${profile}; agent profiles are disabled`)
      return EMPTY_BOOK
    }
    if (profiles.has(profile.name)) {
      journal(`agents.json: ${file}: duplicate profile "${profile.name}"; agent profiles are disabled`)
      return EMPTY_BOOK
    }
    profiles.set(profile.name, profile)
  }
  const list = [...profiles.values()]
  // The owner keeps the model field of the old profiles, but the bot does not
  // choose the expensive model itself: one journal line says what happens.
  if (list.some((profile) => profile.model === 'pro')) {
    for (const profile of list) {
      if (profile.model === 'pro') profile.model = 'flash'
    }
    journal(
      `agents.json: ${file}: model "pro" replaced with "flash"; ` +
        'the bot does not use deepseek-v4-pro on its own',
    )
  }
  return {
    list: () => [...list],
    get: (name: string) => profiles.get(name.trim()),
  }
}
