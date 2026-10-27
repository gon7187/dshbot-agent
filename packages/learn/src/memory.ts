// The `memory` tool of the experience review: file-backed entries in
// `memory/USER.md` (who the owner is) and `memory/MEMORY.md` (environment facts).
//
// The rules from docs/research/prompts.md §6 are part of the tool description:
// one fact goes to exactly one store, entries are declarative, and a full batch
// may free room by removing a stale entry in the same call (entries.ts checks
// the limit only on the final state).

import { join } from 'node:path'

import { createEntryStore, type EntryOperation } from '../../memory/src/index.js'
import type { RunnerTool } from '../../runner/src/index.js'

export const MEMORY_TOOL_NAME = 'memory'

/** Character budgets from DESIGN §7. */
export const USER_MEMORY_LIMIT = 1_400
export const ENVIRONMENT_MEMORY_LIMIT = 2_200

type MemoryTarget = 'user' | 'memory'

function targetOf(value: unknown): MemoryTarget {
  if (value === 'user' || value === 'memory') return value
  throw new Error("target must be 'user' or 'memory'")
}

function operationsOf(value: unknown): EntryOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('operations must be a non-empty array')
  return value.map((raw, index): EntryOperation => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`operations[${index}] must be an object`)
    }
    const operation = raw as Record<string, unknown>
    const op = operation.op
    if (op === 'add') {
      if (typeof operation.text !== 'string') throw new Error(`operations[${index}].text is required for add`)
      return { op: 'add', text: operation.text }
    }
    if (op === 'replace') {
      if (typeof operation.match !== 'string' || typeof operation.text !== 'string') {
        throw new Error(`operations[${index}] needs match and text for replace`)
      }
      return { op: 'replace', match: operation.match, text: operation.text }
    }
    if (op === 'remove') {
      if (typeof operation.match !== 'string') throw new Error(`operations[${index}].match is required for remove`)
      return { op: 'remove', match: operation.match }
    }
    throw new Error(`operations[${index}].op must be add, replace or remove`)
  })
}

/** The memory tool with one pair of stores under `home`. */
export function createMemoryTool(home: string): RunnerTool {
  const stores: Record<MemoryTarget, ReturnType<typeof createEntryStore>> = {
    user: createEntryStore(join(home, 'memory', 'USER.md'), { limit: USER_MEMORY_LIMIT }),
    memory: createEntryStore(join(home, 'memory', 'MEMORY.md'), { limit: ENVIRONMENT_MEMORY_LIMIT }),
  }

  return {
    name: MEMORY_TOOL_NAME,
    description:
      'Save durable facts to persistent memory. TWO stores: target="user" is who the owner is (persona, preferences, ' +
      'communication and work style); target="memory" is the environment you work in (tool quirks, project conventions, ' +
      'paths and endpoints). One fact goes to ONE store. Write declarative facts, not instructions: ' +
      '"Owner prefers concise answers" is right, "Always answer concisely" is wrong. Procedures and pitfalls belong in a ' +
      'skill via skill_manage, not here. Use one call with an operations array; the character limit is checked on the ' +
      'final result, so one batch may remove stale entries and add a new one together. Do not store task progress, ' +
      'completed-work logs, raw dumps or temporary state.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['user', 'memory'], description: 'Which store to change.' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add', 'replace', 'remove'] },
              text: { type: 'string' },
              match: { type: 'string' },
            },
            required: ['op'],
          },
        },
      },
      required: ['target', 'operations'],
    },
    execute(args) {
      const target = targetOf(args.target)
      const store = stores[target]
      const entries = store.apply(operationsOf(args.operations))
      return entries.length === 0 ? 'Память пуста.' : `Сохранено. Записи:\n${entries.join('\n§\n')}`
    },
  }
}
