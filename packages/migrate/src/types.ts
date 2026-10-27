// Shared shapes of the migration tool. Items are the single vocabulary of the
// plan, the terminal output and `report.json`: a step of a source adapter only
// adds candidates, while the planner decides their status against the
// destination. New sources and new steps of OpenClaw extend the collector, not
// this file.

/** Status of one item after the plan (and, when applied, after the writes). */
export type ItemStatus = 'applied' | 'skipped' | 'conflict' | 'error' | 'warning'

/** How the planner sees an item before it is written. */
export type PlannedStatus = 'new' | 'applied' | 'skipped' | 'conflict' | 'error' | 'warning'

/** One line of the plan and of the report. A secret `value` never leaves memory. */
export interface PlanItem {
  /** `secret`, `env`, `owner`, `mcp`, `auth`. */
  readonly kind: string
  /** Name of the key, server or kv entry; never a value. */
  readonly name: string
  /** Where the value comes from: a source file name plus a field path. */
  readonly source: string
  /** Where the value goes: a path under DSHBOT_HOME or an absolute file path. */
  readonly target: string
  /** Field path for a name derived from a config path; absent for named keys. */
  readonly field?: string
  status: PlannedStatus
  /** Human reason for anything that is not applied. Never contains a value. */
  reason?: string
  /** Secret value, kept only in memory until it is written to the vault. */
  value?: SecretValue
  /** Server description of an `mcp` item, already carrying `${secret:NAME}` refs. */
  server?: Record<string, unknown>
  /** `true` when an existing environment line is replaced rather than appended. */
  replace?: boolean
  /** Skill directory to copy for a `skill` item. */
  skill?: SkillCandidate
  /** Memory file and entries for a `memory` item. */
  memory?: MemoryCandidate
  /** Text of a `identity` item (SOUL.md). */
  identity?: string
  /** Schedule to create or update for a `schedule` item. */
  schedule?: ScheduleCandidate
  /** Existing schedule row replaced by `--overwrite`. */
  existingScheduleId?: string
  /** Items that go to manual-review.md. */
  manual?: readonly ManualCandidate[]
}

/** A vault value: text, or the exact bytes of a credentials file. */
export type SecretValue = string | Buffer

/** A secret from any source before it is compared with the destination vault. */
export interface SecretCandidate {
  readonly name: string
  readonly value: SecretValue
  /** Every source label that produced the same name; joined for the report. */
  readonly sources: string[]
  /** Field paths that produced a derived name; shown in the report. */
  readonly fields: string[]
  /** Set when another source uses the same name with a different value. */
  conflict?: string
}

/** An environment-file entry (the three daemon keys of the bot). */
export interface EnvCandidate {
  readonly name: string
  readonly value: string
  readonly sources: string[]
  conflict?: string
}

/** A skill directory to copy into `<home>/skills/<name>`. */
export interface SkillCandidate {
  /** Name of the destination directory (already renamed on a collision). */
  readonly name: string
  /** Absolute source directory. */
  readonly dir: string
  /** Source label for the report, e.g. `skills/notes`. */
  readonly source: string
}

/** One memory file (`MEMORY.md`, `USER.md`) split into §-delimited entries. */
export interface MemoryCandidate {
  readonly name: string
  readonly source: string
  readonly entries: readonly string[]
}

/** A cron job of the source, already translated to a DSHBOT schedule spec. */
export interface ScheduleCandidate {
  readonly id: string
  readonly name: string
  readonly source: string
  readonly task: string
  /** Spec understood by the scheduler (`0 9 * * *`, `every 90m`, ISO instant). */
  readonly spec: string
  readonly maxRuns?: number
  readonly paused: boolean
}

/** An item that cannot be migrated automatically and goes to manual-review.md. */
export interface ManualCandidate {
  readonly name: string
  readonly reason: string
  /** Text of the task (`prompt`); secret values are replaced when it is written. */
  readonly prompt?: string
  /** The script of the job, for the same review. */
  readonly detail?: string
}

/** Everything a source adapter found; the planner turns it into items. */
export interface Collected {
  readonly secrets: SecretCandidate[]
  readonly env: EnvCandidate[]
  readonly owner?: { readonly id: string; readonly source: string }
  readonly mcp: readonly {
    readonly name: string
    readonly source: string
    readonly server: Record<string, unknown>
    readonly warnings: readonly PlanItem[]
  }[]
  /** SOUL.md of the source; the same identity policy is used by every source. */
  readonly identity?: { readonly text: string; readonly source: string }
  readonly memory?: readonly MemoryCandidate[]
  readonly skills?: readonly SkillCandidate[]
  readonly schedules?: readonly ScheduleCandidate[]
  readonly manual?: readonly ManualCandidate[]
  readonly warnings: PlanItem[]
}
