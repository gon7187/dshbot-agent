// The single `graph` tool of the bot: a deliberately small interface over the
// server-memory tool set.
//
// The graph is the "connections" layer next to the file memory and FTS5: people,
// projects, services, facts about them and relations between them. It is an
// ordinary tool of the owner's `main` session (a guest never sees its schema);
// the lazy-schema delivery itself is a separate task, so nothing here hides the
// tool behind tool_search.
//
//   search -> search_nodes
//   open   -> open_nodes
//   add    -> create_entities, create_relations, add_observations (one call)
//   remove -> delete_entities, delete_observations, delete_relations
//
// Observations from an untrusted source (`web`, `forwarded`) are prefixed with
// a provenance marker inside the observation text, so the graph itself records
// where the fact came from instead of trusting it silently.

import type { CallToolResult } from '@modelcontextprotocol/client'

import type { RunnerTool } from '../../runner/src/index.js'
import { MemoryGraphClient, type MemoryGraphClientOptions } from './client.js'

/** Model-facing tool name. */
export const GRAPH_TOOL_NAME = 'graph'

/** Actions the one tool supports. */
export const GRAPH_ACTIONS = ['search', 'open', 'add', 'remove'] as const

export type GraphAction = (typeof GRAPH_ACTIONS)[number]

/** Where the facts came from; `web` and `forwarded` are untrusted. */
export const GRAPH_SOURCES = ['owner', 'tool', 'web', 'forwarded'] as const

export type GraphSource = (typeof GRAPH_SOURCES)[number]

/** Sources whose observations are marked as untrusted provenance. */
const UNTRUSTED_SOURCES: ReadonlySet<GraphSource> = new Set(['web', 'forwarded'])

/** Prefix that identifies an observation already carrying provenance. */
const PROVENANCE_PATTERN = /^\[provenance: [a-z-]+\] /

export interface GraphEntity {
  name: string
  entityType: string
  observations: string[]
}

export interface GraphRelation {
  from: string
  to: string
  relationType: string
}

export interface GraphObservation {
  entityName: string
  contents: string[]
}

export interface GraphTools {
  /** The `graph` tool, ready for the runner tool seam. */
  tools: readonly RunnerTool[]
  /** Stops the MCP server process; safe to call when it never started. */
  stop(): Promise<void>
}

function textOf(result: CallToolResult): string {
  const parts: string[] = []
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  if (result.isError === true) throw new Error(text === '' ? 'graph server returned an error' : text)
  if (text !== '') return text
  return JSON.stringify(result.structuredContent ?? {})
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringList(value: unknown, what: string): string[] {
  if (typeof value === 'string') {
    if (value.trim() === '') throw new Error(`${what} must not be empty`)
    return [value]
  }
  if (!Array.isArray(value)) throw new Error(`${what} must be a string or an array of strings`)
  const list = value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') throw new Error(`${what} must contain non-empty strings`)
    return item
  })
  return list
}

function optionalStringList(value: unknown, what: string): string[] {
  if (value === undefined) return []
  return stringList(value, what)
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function entitiesOf(value: unknown): GraphEntity[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('entities must be an array')
  return value.map((raw, index) => {
    const entity = objectOf(raw, `entities[${index}]`)
    const name = stringArg(entity, 'name')
    if (name === undefined) throw new Error(`entities[${index}].name is required`)
    const entityType = stringArg(entity, 'entityType') ?? 'entity'
    const observations = optionalStringList(entity.observations, `entities[${index}].observations`)
    return { name, entityType, observations }
  })
}

function relationsOf(value: unknown): GraphRelation[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('relations must be an array')
  return value.map((raw, index) => {
    const relation = objectOf(raw, `relations[${index}]`)
    const from = stringArg(relation, 'from')
    const to = stringArg(relation, 'to')
    const relationType = stringArg(relation, 'relationType')
    if (from === undefined || to === undefined || relationType === undefined) {
      throw new Error(`relations[${index}] needs from, to and relationType`)
    }
    return { from, to, relationType }
  })
}

function observationsOf(value: unknown): GraphObservation[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('observations must be an array')
  return value.map((raw, index) => {
    const observation = objectOf(raw, `observations[${index}]`)
    const entityName = stringArg(observation, 'entityName')
    if (entityName === undefined) throw new Error(`observations[${index}].entityName is required`)
    const contents = stringList(observation.contents, `observations[${index}].contents`)
    return { entityName, contents }
  })
}

function sourceOf(args: Record<string, unknown>): GraphSource {
  const raw = args.source
  if (raw === undefined) return 'owner'
  if (typeof raw !== 'string' || !(GRAPH_SOURCES as readonly string[]).includes(raw)) {
    throw new Error(`source must be one of ${GRAPH_SOURCES.join(', ')}`)
  }
  return raw as GraphSource
}

/** Add a provenance marker to observations whose source is untrusted. */
export function markProvenance(contents: readonly string[], source: GraphSource): string[] {
  if (!UNTRUSTED_SOURCES.has(source)) return [...contents]
  const prefix = `[provenance: ${source}] `
  return contents.map((content) => (PROVENANCE_PATTERN.test(content) ? content : `${prefix}${content}`))
}

const ACTION_DESCRIPTION =
  'search looks up entities by a word from a name, type or observation; ' +
  'open returns named entities with their observations and relations; ' +
  'add creates entities, observations and relations in one call; ' +
  'remove deletes the named entities and anything linked to them.'

const GRAPH_DESCRIPTION =
  'Durable knowledge graph of the owner: people, projects, services, facts about them and the relations ' +
  'between them. This is the "connections" layer; the file memory and recall stay the place for notes and ' +
  'search over past messages. Use it only when a durable relation or fact is worth keeping or is asked for, ' +
  'not on every turn. ' +
  ACTION_DESCRIPTION +
  ' For facts taken from the web or a forwarded message pass source=web or source=forwarded: the stored ' +
  'observation is marked with its provenance. Never store secrets or API keys here.'

const GRAPH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...GRAPH_ACTIONS],
      description: 'What to do: search, open, add or remove.',
    },
    query: {
      type: 'string',
      description: 'search: a word or phrase matched against entity names, types and observations.',
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description: 'open and remove: exact entity names.',
    },
    entities: {
      type: 'array',
      description: 'add: entities to create; observations attached here are stored with the entity.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique entity name.' },
          entityType: { type: 'string', description: 'Kind of entity, for example person, project or service.' },
          observations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Facts about the entity.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    relations: {
      type: 'array',
      description: 'add and remove: directed relations between existing entity names.',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Name of the entity where the relation starts.' },
          to: { type: 'string', description: 'Name of the entity where the relation ends.' },
          relationType: { type: 'string', description: 'Active-voice relation, for example works_on.' },
        },
        required: ['from', 'to', 'relationType'],
        additionalProperties: false,
      },
    },
    observations: {
      type: 'array',
      description: 'add and remove: observations for entities that already exist.',
      items: {
        type: 'object',
        properties: {
          entityName: { type: 'string', description: 'Name of an existing entity.' },
          contents: { type: 'array', items: { type: 'string' }, description: 'Observation texts.' },
        },
        required: ['entityName', 'contents'],
        additionalProperties: false,
      },
    },
    source: {
      type: 'string',
      enum: [...GRAPH_SOURCES],
      default: 'owner',
      description:
        'Where added facts came from. owner and tool are trusted; web and forwarded observations are stored ' +
        'with a provenance marker.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

/** The graph capability: one model tool plus the server teardown hook. */
export function createGraphTools(options: MemoryGraphClientOptions): GraphTools {
  const client = new MemoryGraphClient(options)

  const tool: RunnerTool = {
    name: GRAPH_TOOL_NAME,
    description: GRAPH_DESCRIPTION,
    inputSchema: GRAPH_INPUT_SCHEMA,
    async execute(args) {
      const action = stringArg(args, 'action')
      if (action === undefined || !(GRAPH_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`graph action must be one of ${GRAPH_ACTIONS.join(', ')}`)
      }
      return executeAction(client, action as GraphAction, args)
    },
  }

  return {
    tools: [tool],
    stop: () => client.stop(),
  }
}

async function executeAction(
  client: MemoryGraphClient,
  action: GraphAction,
  args: Record<string, unknown>,
): Promise<string> {
  if (action === 'search') {
    const query = stringArg(args, 'query')
    if (query === undefined) throw new Error('graph search needs query')
    return textOf(await client.callTool('search_nodes', { query }))
  }

  if (action === 'open') {
    const names = stringList(args.names, 'names')
    return textOf(await client.callTool('open_nodes', { names }))
  }

  if (action === 'add') {
    return addToGraph(client, args)
  }

  return removeFromGraph(client, args)
}

async function addToGraph(client: MemoryGraphClient, args: Record<string, unknown>): Promise<string> {
  const source = sourceOf(args)
  const entities = entitiesOf(args.entities).map((entity) => ({
    ...entity,
    observations: markProvenance(entity.observations, source),
  }))
  const observations = observationsOf(args.observations).map((observation) => ({
    ...observation,
    contents: markProvenance(observation.contents, source),
  }))
  const relations = relationsOf(args.relations)
  if (entities.length === 0 && observations.length === 0 && relations.length === 0) {
    throw new Error('graph add needs entities, observations or relations')
  }

  const answers: string[] = []
  if (entities.length > 0) {
    answers.push(textOf(await client.callTool('create_entities', { entities })))
  }
  if (relations.length > 0) {
    answers.push(textOf(await client.callTool('create_relations', { relations })))
  }
  if (observations.length > 0) {
    answers.push(textOf(await client.callTool('add_observations', { observations })))
  }
  return answers.join('\n')
}

async function removeFromGraph(client: MemoryGraphClient, args: Record<string, unknown>): Promise<string> {
  const names = optionalStringList(args.names, 'names')
  const observations = observationsOf(args.observations)
  const relations = relationsOf(args.relations)
  if (names.length === 0 && observations.length === 0 && relations.length === 0) {
    throw new Error('graph remove needs names, observations or relations')
  }

  const answers: string[] = []
  if (names.length > 0) {
    answers.push(textOf(await client.callTool('delete_entities', { entityNames: names })))
  }
  if (observations.length > 0) {
    answers.push(
      textOf(
        await client.callTool('delete_observations', {
          deletions: observations.map((observation) => ({
            entityName: observation.entityName,
            observations: observation.contents,
          })),
        }),
      ),
    )
  }
  if (relations.length > 0) {
    answers.push(textOf(await client.callTool('delete_relations', { relations })))
  }
  return answers.join('\n')
}
