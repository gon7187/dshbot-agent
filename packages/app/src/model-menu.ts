// The `/model` menu: the current model of `main` and inline buttons instead of
// a list of every model of every connected provider. The first screen offers
// the three DeepSeek variants and one button per connected provider; a provider
// button opens its models in pages, one button per model. Buttons carry short
// hashes, not names: a model id of OpenRouter may be longer than the 64 bytes
// Telegram allows in callback_data, and a press is matched against the current
// catalogue, so a button of an older screen cannot pick a model by position.

import { createHash } from 'node:crypto'

/**
 * Model buttons on one page of a provider: one under the limit of 20 per page,
 * so a page whose label is the tail of another id (`openrouter/auto` and
 * `auto`) still stays within the limit when the pair is counted as two models.
 */
export const MODEL_MENU_PAGE_SIZE = 19

/** The DeepSeek variants of the first screen, in the order of the buttons. */
export const MODEL_MENU_ALIASES = ['flash', 'lite', 'pro'] as const
export type ModelMenuAlias = (typeof MODEL_MENU_ALIASES)[number]

export interface ModelMenuButton {
  text: string
  callback_data: string
}

export interface ModelMenuScreen {
  text: string
  keyboard: ModelMenuButton[][]
}

/** Model of a connected provider as the menu needs it. */
export interface ModelMenuEntry {
  provider: string
  id: string
}

/** The model of `main`; `provider` is the DeepSeek route name for the aliases. */
export interface ModelMenuCurrent {
  provider: string
  model: string
  /** DeepSeek alias of the current model; undefined for a model of another provider. */
  alias?: ModelMenuAlias | undefined
  /** Owner-facing line of the current model, for the screen text. */
  label: string
}

export type ModelMenuAction =
  | { kind: 'home' }
  | { kind: 'alias'; alias: ModelMenuAlias }
  | { kind: 'provider'; hash: string; page: number | undefined }
  | { kind: 'model'; hash: string }

const PREFIX = 'mm'
const CHECK = '✅ '

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length)
}

export function providerHash(provider: string): string {
  return shortHash(provider, 10)
}

export function modelHash(entry: ModelMenuEntry): string {
  return shortHash(`${entry.provider}/${entry.id}`, 12)
}

/** Model of the catalogue named by a button hash; undefined when stale or ambiguous. */
export function findMenuModel<T extends ModelMenuEntry>(catalogue: readonly T[], hash: string): T | undefined {
  const matches = catalogue.filter((entry) => modelHash(entry) === hash)
  return matches.length === 1 ? matches[0] : undefined
}

/** Provider of the catalogue named by a button hash. */
export function findMenuProvider(catalogue: readonly ModelMenuEntry[], hash: string): string | undefined {
  return catalogue.find((entry) => providerHash(entry.provider) === hash)?.provider
}

/** Action of a callback_data of this menu; undefined for foreign data. */
export function decodeModelMenuCallback(data: string): ModelMenuAction | undefined {
  const parts = data.split(':')
  if (parts[0] !== PREFIX) return undefined
  if (parts.length === 2 && parts[1] === 'h') return { kind: 'home' }
  if (parts.length === 3 && parts[1] === 'a') {
    const alias = MODEL_MENU_ALIASES.find((entry) => entry === parts[2])
    return alias === undefined ? undefined : { kind: 'alias', alias }
  }
  if (parts.length === 3 && parts[1] === 'm' && /^[0-9a-f]{12}$/.test(parts[2] ?? '')) {
    return { kind: 'model', hash: parts[2] as string }
  }
  if ((parts.length === 3 || parts.length === 4) && parts[1] === 'p' && /^[0-9a-f]{10}$/.test(parts[2] ?? '')) {
    if (parts.length === 3) return { kind: 'provider', hash: parts[2] as string, page: undefined }
    if (!/^\d{1,4}$/.test(parts[3] ?? '')) return undefined
    return { kind: 'provider', hash: parts[2] as string, page: Number(parts[3]) }
  }
  return undefined
}

function sortedProviders(catalogue: readonly ModelMenuEntry[]): Map<string, ModelMenuEntry[]> {
  const byProvider = new Map<string, ModelMenuEntry[]>()
  for (const entry of catalogue) {
    const list = byProvider.get(entry.provider)
    if (list === undefined) byProvider.set(entry.provider, [entry])
    else list.push(entry)
  }
  return new Map([...byProvider].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Models of one provider in the order of the pages. */
export function providerModels<T extends ModelMenuEntry>(catalogue: readonly T[], provider: string): T[] {
  return catalogue
    .filter((entry) => entry.provider === provider)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Number of pages of a provider with `count` models. */
export function modelMenuPageCount(count: number): number {
  return Math.max(1, Math.ceil(count / MODEL_MENU_PAGE_SIZE))
}

/** Page of a provider that holds the current model; the first page when it is elsewhere. */
export function pageOfCurrent(models: readonly ModelMenuEntry[], current: ModelMenuCurrent): number {
  const index = models.findIndex((entry) => entry.provider === current.provider && entry.id === current.model)
  return index < 0 ? 0 : Math.floor(index / MODEL_MENU_PAGE_SIZE)
}

/** Page of a provider on which `entry` stands. */
export function pageOfModel(models: readonly ModelMenuEntry[], entry: ModelMenuEntry): number {
  return pageOfCurrent(models, { provider: entry.provider, model: entry.id, label: '' })
}

/** First screen: the DeepSeek variants and one button per connected provider. */
export function homeScreen(current: ModelMenuCurrent, catalogue: readonly ModelMenuEntry[]): ModelMenuScreen {
  const providers = sortedProviders(catalogue)
  const lines = [`Текущая модель main: ${current.label}.`, 'Выберите модель кнопкой.']
  if (providers.size === 0) lines.push('Модели других провайдеров появятся здесь после входа в провайдер.')
  const keyboard: ModelMenuButton[][] = [
    MODEL_MENU_ALIASES.map((alias) => ({
      text: `${current.alias === alias ? CHECK : ''}${alias}`,
      callback_data: `${PREFIX}:a:${alias}`,
    })),
  ]
  for (const [provider, models] of providers) {
    keyboard.push([
      {
        text: `${current.provider === provider ? CHECK : ''}${provider} · ${models.length}`,
        callback_data: `${PREFIX}:p:${providerHash(provider)}`,
      },
    ])
  }
  return { text: lines.join('\n'), keyboard }
}

/** One page of a provider's models; the page is clamped into range. */
export function providerScreen(
  current: ModelMenuCurrent,
  catalogue: readonly ModelMenuEntry[],
  provider: string,
  page: number,
): ModelMenuScreen {
  const models = providerModels(catalogue, provider)
  const pages = modelMenuPageCount(models.length)
  const shown = Math.min(Math.max(0, page), pages - 1)
  const hash = providerHash(provider)
  const keyboard: ModelMenuButton[][] = models
    .slice(shown * MODEL_MENU_PAGE_SIZE, (shown + 1) * MODEL_MENU_PAGE_SIZE)
    .map((entry) => [
      {
        text: `${current.provider === entry.provider && current.model === entry.id ? CHECK : ''}${entry.id}`,
        callback_data: `${PREFIX}:m:${modelHash(entry)}`,
      },
    ])
  const pager: ModelMenuButton[] = []
  if (shown > 0) pager.push({ text: '◀️', callback_data: `${PREFIX}:p:${hash}:${shown - 1}` })
  if (shown < pages - 1) pager.push({ text: '▶️', callback_data: `${PREFIX}:p:${hash}:${shown + 1}` })
  if (pager.length > 0) keyboard.push(pager)
  keyboard.push([{ text: 'Назад', callback_data: `${PREFIX}:h` }])
  const where = pages > 1 ? `, страница ${shown + 1} из ${pages}` : ''
  return {
    text: `Текущая модель main: ${current.label}.\n${provider}: ${models.length} моделей${where}. Выберите модель кнопкой.`,
    keyboard,
  }
}
