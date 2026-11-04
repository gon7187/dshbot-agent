import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { FactoryProject } from '../../factory/src/index.js'
import { httpReviewer, REVIEW_MODEL } from '../../evolve/src/index.js'
import type { RunnerUsage } from '../../runner/src/index.js'
import { createDeliveryService, type DeliveryService } from './delivery.js'
import { createProjectGithub } from './github.js'
import { createSuperagentBridge, type SuperagentBridge, type SuperagentBridgeInput } from './bridge.js'
import { createSuperagentSupervisor } from './supervisor.js'
import { requestPanel, startPanelProxy } from './panel.js'

interface RuntimeConfig { runtimeDir: string; projects: { id: number; port: number }[] }
type SimpleCommand = 'status' | 'projects' | 'pause' | 'resume' | 'deliveries'
type Command = { [K in SimpleCommand]: { kind: K } }[SimpleCommand]
  | { kind: 'new'; projectId: number; text: string }
  | { kind: 'stop'; projectId: number; ticketId: string }
  | { kind: 'retry'; projectId: number; id: string }
  | { kind: 'dismiss'; projectId: number; id: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readRuntimeConfig(home: string): RuntimeConfig | undefined {
  const path = join(home, 'superagent', 'runtime.json')
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!record(value) || Object.keys(value).some(key => !['runtimeDir', 'projects'].includes(key))
    || typeof value.runtimeDir !== 'string' || !isAbsolute(value.runtimeDir) || value.runtimeDir.includes('\0')
    || !Array.isArray(value.projects) || !value.projects.length) throw new Error('Invalid Superagent runtime configuration')
  const projects: RuntimeConfig['projects'] = []
  for (const project of value.projects) {
    if (!record(project) || Object.keys(project).some(key => !['id', 'port'].includes(key))
      || !Number.isSafeInteger(project.id) || Number(project.id) < 0
      || !Number.isSafeInteger(project.port) || Number(project.port) < 1024 || Number(project.port) > 65535
      || projects.some(row => row.id === project.id || row.port === project.port)) throw new Error('Invalid Superagent project configuration')
    projects.push({ id: Number(project.id), port: Number(project.port) })
  }
  return { runtimeDir: value.runtimeDir, projects }
}

export function parseSuperagentCommand(text: string): Command {
  const input = text.trim()
  if (!input) return { kind: 'status' }
  if (/^(status|projects|pause|resume|deliveries)$/i.test(input)) return { kind: input.toLowerCase() as SimpleCommand }
  const stop = /^stop\s+(\d+)\s+([A-Za-z0-9_-]{1,128})$/i.exec(input)
  if (stop && Number.isSafeInteger(Number(stop[1]))) return { kind: 'stop', projectId: Number(stop[1]), ticketId: stop[2]! }
  const reconciliation = /^(retry|dismiss)\s+(\d+)\s+([A-Za-z0-9_-]{1,512})$/i.exec(input)
  if (reconciliation && Number.isSafeInteger(Number(reconciliation[2]))) {
    return { kind: reconciliation[1]!.toLowerCase() as 'retry' | 'dismiss', projectId: Number(reconciliation[2]), id: reconciliation[3]! }
  }
  const task = /^new\s+([\s\S]+)$/i.exec(input)?.[1]?.trim()
  if (task) {
    const explicit = /^(\d+)\s+([\s\S]+)$/.exec(task)
    const projectId = explicit ? Number(explicit[1]) : 0
    const body = explicit ? explicit[2]!.trim() : task
    if (Number.isSafeInteger(projectId) && !/^-?\d+(?:\s|$)/.test(explicit ? '' : task) && body.length <= 16_000) {
      return { kind: 'new', projectId, text: body }
    }
  }
  throw new Error('Команды: /superagent projects; new <номер проекта> <задача>; status; pause; resume; deliveries; retry <проект> <id>; dismiss <проект> <id>; stop <проект> <ticket>.')
}

export function createSuperagentRuntime(options: {
  home: string
  db: DatabaseSync
  ownerId: () => number | null
  projects: () => FactoryProject[]
  send: (input: { chatId: number; replyTo: number; text: string }) => Promise<{ messageId: number }>
  recordUsage: (usage: RunnerUsage) => void
  modelKey: string
  modelBaseUrl: string
  fetch?: typeof globalThis.fetch
  log: (text: string) => void
}) {
  let config: RuntimeConfig | undefined
  let configurationError = false
  try {
    config = readRuntimeConfig(options.home)
  } catch {
    configurationError = true
    options.log('superagent disabled: invalid runtime configuration')
  }
  const directory = join(options.home, 'superagent')
  const bridgeDirectory = join(directory, 'bridge')
  let stopping = false
  let bridgeHealthy = false
  let deliveryActive = false
  let deliveryStopped = false
  let deliveryControl = Promise.resolve()
  let delivery: DeliveryService | undefined
  let github: ((projectId: number, argv: string[]) => Promise<{ stdout: string }>) | undefined
  if (config) {
    try {
      github = createProjectGithub({ home: options.home, projects: options.projects })
    } catch {
      options.log('superagent optional GitHub feature disabled')
    }
    let constructedDelivery: DeliveryService | undefined
    try {
      const reviewer = httpReviewer({ baseUrl: options.modelBaseUrl, apiKey: options.modelKey, fetch: options.fetch })
      constructedDelivery = createDeliveryService({
        home: options.home,
        db: options.db,
        projects: options.projects,
        review: prompt => reviewer({ model: REVIEW_MODEL, prompt }),
        reviewerModel: REVIEW_MODEL,
        log: options.log,
        allowed: () => deliveryActive && !stopping,
      })
      delivery = constructedDelivery
      // The sidecar is closed until the bridge has completed its source-acknowledged resume.
      constructedDelivery.pause()
    } catch {
      delivery = undefined
      if (constructedDelivery !== undefined) {
        void Promise.resolve().then(() => constructedDelivery!.stop()).catch(() => undefined)
      }
      options.log('superagent optional delivery feature disabled')
    }
  }
  let bridge: SuperagentBridge | undefined
  let bridgeError = false
  if (config) {
    try {
      bridge = createSuperagentBridge({
        db: options.db, socketPath: join(bridgeDirectory, 'superagent.sock'), ownerId: options.ownerId,
        listeners: config.projects.map(project => ({ projectId: project.id, socketPath: join(bridgeDirectory, String(project.id), 'superagent.sock') })),
        projects: () => options.projects().map(project => project.id), send: options.send,
        recordUsage: options.recordUsage, log: options.log, github, delivery,
      })
    } catch {
      bridgeError = true
      options.log('superagent disabled: bridge initialization failed')
    }
  }
  const children = new Map<number, ReturnType<typeof createSuperagentSupervisor>>()
  const panels = new Map<number, Awaited<ReturnType<typeof startPanelProxy>>>()
  const panelStarts = new Map<number, Promise<Awaited<ReturnType<typeof startPanelProxy>>>>()
  const intentionalStops = new Set<number>()
  let controlTail = Promise.resolve()
  let resumeController: AbortController | undefined
  let stopTask: Promise<void> | undefined
  let projectWatch: NodeJS.Timeout | undefined
  const removingProjects = new Map<number, Promise<void>>()
  const lifetime = new AbortController()
  let generation = 0

  class StateValidationError extends Error {}
  class SetupPendingError extends StateValidationError {}

  function cancelled(expectedGeneration: number, signal: AbortSignal): boolean {
    return stopping || signal.aborted || expectedGeneration !== generation
  }

  function assertActive(expectedGeneration: number, signal: AbortSignal): void {
    if (cancelled(expectedGeneration, signal)) throw new Error('Запуск Superagent отменён.')
  }

  function queueDelivery(action: 'pause' | 'resume'): Promise<void> {
    const pending = deliveryControl.then(async () => {
      if (delivery === undefined || deliveryStopped) return
      await delivery[action]()
    })
    deliveryControl = pending.then(() => undefined, () => undefined)
    return pending
  }

  function projectIds(): Set<number> {
    return new Set(options.projects().map(project => project.id))
  }

  function configuredProjectIds(): number[] {
    const connected = projectIds()
    return (config?.projects ?? []).filter(project => connected.has(project.id)).map(project => project.id)
  }

  function panelAddress(id: number, fallbackPort: number): string {
    const panel = panels.get(id)
    if (panel !== undefined && 'url' in panel && typeof panel.url === 'string') return panel.url
    return `http://127.0.0.1:${panel?.port ?? fallbackPort}`
  }

  function connected(id: number) {
    const project = options.projects().find(project => project.id === id)
    if (!project) throw new Error(`Проект #${id} не подключён в /factory.`)
    return project
  }
  function requireAvailable(): void {
    if (configurationError) throw new Error('Superagent отключён: некорректная конфигурация.')
    if (!config) throw new Error('Полный Superagent ещё не установлен.')
    if (bridgeError || !bridge) throw new Error('Superagent bridge не запущен.')
    if (!bridgeHealthy) throw new Error('Superagent bridge не запущен.')
  }
  function prepared(id: number) {
    connected(id)
    const entry = config?.projects.find(project => project.id === id)
    if (!entry) throw new Error(`Для проекта #${id} ещё не установлен профиль Superagent.`)
    return entry
  }
  async function api(id: number, path: string, body?: unknown, signal = lifetime.signal): Promise<unknown> {
    const { port } = prepared(id)
    return requestPanel(join(directory, 'projects', String(id), 'panel.sock'), port, path, body, signal)
  }
  function panic(): void {
    generation++
    resumeController?.abort()
    deliveryActive = false
    void queueDelivery('pause').catch(() => options.log('superagent delivery pause failed'))
    bridge?.setPaused(true)
    for (const [id, child] of children) {
      intentionalStops.add(id)
      child.panic()
    }
  }
  function panelFor(id: number, expectedGeneration: number, signal: AbortSignal): Promise<Awaited<ReturnType<typeof startPanelProxy>>> {
    const existing = panels.get(id)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = panelStarts.get(id)
    if (pending !== undefined) return pending
    const entry = prepared(id)
    const started = (async () => {
      const panel = await startPanelProxy(join(directory, 'projects', String(id), 'panel.sock'), entry.port)
      try {
        if (cancelled(expectedGeneration, signal) || !projectIds().has(id)) throw new Error('Запуск Superagent отменён.')
        panels.set(id, panel)
        return panel
      } catch (error) {
        await panel.stop().catch(() => undefined)
        throw error
      }
    })()
    panelStarts.set(id, started)
    const clear = () => { if (panelStarts.get(id) === started) panelStarts.delete(id) }
    void started.then(clear, clear)
    return started
  }
  async function stopProject(id: number, child: ReturnType<typeof createSuperagentSupervisor>, panel?: Awaited<ReturnType<typeof startPanelProxy>>): Promise<void> {
    intentionalStops.add(id)
    let stopped = false
    try { await child.stop(); stopped = true } finally {
      if (stopped && children.get(id) === child) children.delete(id)
      intentionalStops.delete(id)
    }
    const ownedPanel = panel ?? panels.get(id)
    if (ownedPanel !== undefined) {
      await ownedPanel.stop()
      if (panels.get(id) === ownedPanel) panels.delete(id)
    }
  }
  async function stopRemovedProject(id: number): Promise<void> {
    const child = children.get(id)
    if (child !== undefined) await stopProject(id, child)
    const pending = panelStarts.get(id)
    if (pending !== undefined) await pending.catch(() => undefined)
    const panel = panels.get(id)
    if (panel !== undefined) {
      await panel.stop()
      if (panels.get(id) === panel) panels.delete(id)
    }
  }
  function removedProjectIds(): number[] {
    const current = projectIds()
    return [...new Set([...children.keys(), ...panels.keys(), ...panelStarts.keys()])]
      .filter(id => !current.has(id) && !removingProjects.has(id))
  }
  function removeProject(id: number): Promise<void> {
    const pending = removingProjects.get(id)
    if (pending !== undefined) return pending
    const operation = stopRemovedProject(id)
    removingProjects.set(id, operation)
    const clear = () => { if (removingProjects.get(id) === operation) removingProjects.delete(id) }
    void operation.then(clear, clear)
    return operation
  }
  function reconcileRemovedProjects(cancelCurrent = true): void {
    if (stopping) return
    const ids = removedProjectIds()
    if (ids.length === 0) return
    if (cancelCurrent) {
      generation++
      resumeController?.abort()
    }
    for (const id of ids) void removeProject(id).catch(error => options.log(`superagent #${id} cleanup failed: ${String(error)}`))
  }
  async function reconcileRemovedProjectsAsync(): Promise<void> {
    for (const id of new Set([...removedProjectIds(), ...removingProjects.keys()])) await removeProject(id)
  }
  function startProjectWatch(): void {
    if (projectWatch !== undefined || stopping) return
    projectWatch = setInterval(() => {
      try { reconcileRemovedProjects() } catch (error) { options.log(`superagent project watcher failed: ${String(error)}`) }
    }, 1_000)
    projectWatch.unref()
  }
  function stopProjectWatch(): void {
    if (projectWatch === undefined) return
    clearInterval(projectWatch)
    projectWatch = undefined
  }
  function readyState(id: number, value: unknown): boolean {
    if (!record(value) || !record(value.setup) || !record(value.setup.accounts)
      || typeof value.setup.accounts.repository !== 'string' || value.setup.accounts.repository.trim() === '') {
      throw new SetupPendingError(`Superagent #${id} ещё не настроен.`)
    }
    if (value.setup.problem !== undefined && value.setup.problem !== null) {
      throw new SetupPendingError(`Superagent #${id} ожидает настройки GitHub.`)
    }
    if (!record(value.health) || !record(value.health.runtime) || typeof value.health.runtime.state !== 'string') {
      throw new StateValidationError(`Superagent #${id} вернул некорректное состояние.`)
    }
    const state = value.health.runtime.state
    if (state === 'error') throw new StateValidationError(`Superagent #${id} сообщил об ошибке запуска.`)
    if (state === 'ready' || state === 'paused') return true
    if (state === 'starting') return false
    throw new StateValidationError(`Superagent #${id} вернул некорректное состояние.`)
  }
  function readyTelegramSource(id: number, value: unknown): boolean {
    if (!Array.isArray(value)) throw new StateValidationError(`Superagent #${id} вернул некорректный список источников.`)
    const source = value.find(item => record(item) && item.id === 'telegram')
    if (!record(source) || source.installed !== true) {
      throw new SetupPendingError(`Superagent #${id}: источник Telegram не установлен.`)
    }
    if (source.enabled !== true || source.state === 'off') {
      throw new SetupPendingError(`Superagent #${id}: источник Telegram выключен в настройках.`)
    }
    if (typeof source.state !== 'string') {
      throw new StateValidationError(`Superagent #${id} вернул некорректное состояние Telegram.`)
    }
    if (source.state === 'error') {
      throw new SetupPendingError(`Superagent #${id}: источник Telegram сообщил об ошибке.`)
    }
    if (source.state === 'setup') {
      throw new SetupPendingError(`Superagent #${id}: источник Telegram ожидает настройки.`)
    }
    if (!['starting', 'paused', 'ready'].includes(source.state)) {
      throw new StateValidationError(`Superagent #${id} вернул некорректное состояние Telegram.`)
    }
    const owner = 'ownerId' in source ? source.ownerId : record(source.config) && 'ownerId' in source.config ? source.config.ownerId : undefined
    const currentOwner = options.ownerId()
    if (currentOwner === null) throw new SetupPendingError(`Superagent #${id}: владелец Telegram ещё не подключён.`)
    if (owner !== undefined) {
      const configuredOwner = typeof owner === 'number' ? owner : typeof owner === 'string' && /^\d+$/.test(owner) ? Number(owner) : NaN
      if (!Number.isSafeInteger(configuredOwner) || configuredOwner <= 0 || configuredOwner !== currentOwner) {
        throw new SetupPendingError(`Superagent #${id}: источник Telegram настроен на другого владельца.`)
      }
    }
    return true
  }
  function writeProjectBoundary(id: number): void {
    const projectDirectory = join(bridgeDirectory, String(id))
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 })
    const path = join(projectDirectory, 'project.json')
    writeFileSync(path, `${JSON.stringify({ projectId: id })}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  }
  function createChild(id: number, entry: RuntimeConfig['projects'][number]) {
    intentionalStops.delete(id)
    let child: ReturnType<typeof createSuperagentSupervisor>
    child = createSuperagentSupervisor({
      runtimeDir: config!.runtimeDir, homeDir: join(directory, 'projects', String(id)), bridgeDir: join(bridgeDirectory, String(id)),
      panelPort: entry.port,
      env: { DEEPSEEK_API_KEY: options.modelKey, DEEPSEEK_BASE_URL: options.modelBaseUrl },
      log: line => options.log(`superagent #${id}: ${line}`),
      onExit: () => {
        if (children.get(id) !== child || intentionalStops.has(id) || stopping) return
        panic()
      },
    })
    return child
  }
  async function startProject(
    id: number,
    expectedGeneration: number,
    signal: AbortSignal,
    restartExisting: boolean,
    requireReady: boolean,
  ): Promise<void> {
    const entry = prepared(id)
    const existingChild = children.get(id)
    let child = existingChild
    if (!child) {
      child = createChild(id, entry)
      children.set(id, child)
    }
    if (restartExisting && existingChild !== undefined) {
      const oldChild = child
      await stopProject(id, oldChild, undefined)
      assertActive(expectedGeneration, signal)
      child = createChild(id, entry)
      children.set(id, child)
    }
    await panelFor(id, expectedGeneration, signal)
    assertActive(expectedGeneration, signal)
    writeProjectBoundary(id)
    await child.start()
    assertActive(expectedGeneration, signal)
    if (!requireReady) return
    const deadline = Date.now() + 25_000
    while (!cancelled(expectedGeneration, signal) && child.running() && Date.now() < deadline) {
      try {
        const state = await api(id, 'state', undefined, signal)
        if (readyState(id, state)) {
          readyTelegramSource(id, await api(id, 'sources', undefined, signal))
          assertActive(expectedGeneration, signal)
          options.log(`superagent #${id}: ready on loopback port ${entry.port}`)
          return
        }
      } catch (error) {
        if (cancelled(expectedGeneration, signal) || error instanceof StateValidationError) throw error
        await delay(250, undefined, { signal })
      }
    }
    throw new Error(`Superagent #${id} не прошёл проверку запуска.`)
  }
  function enqueueControl<T>(operation: () => Promise<T>): Promise<T> {
    const pending = controlTail.then(operation)
    controlTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  async function waitForResumeReady(
    activeBridge: SuperagentBridge,
    resumeGeneration: number,
    expectedGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 25_000
    while (!cancelled(expectedGeneration, signal)) {
      if (activeBridge.resumeReady(resumeGeneration)) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Superagent не подтвердил паузу источников для поколения ${resumeGeneration}.`)
      try {
        await delay(Math.min(250, remaining), undefined, { signal })
      } catch (error) {
        if (cancelled(expectedGeneration, signal)) throw new Error('Запуск Superagent отменён.')
        throw error
      }
    }
    throw new Error('Запуск Superagent отменён.')
  }

  function resume(restartExisting = true, requireReady = true): Promise<void> {
    try { requireAvailable() } catch (error) { return Promise.reject(error) }
    if (stopping) return Promise.reject(new Error('Демон останавливается.'))
    const activeBridge = bridge!
    const activeConfig = config!
    return enqueueControl(async () => {
      const expectedGeneration = ++generation
      const controller = new AbortController()
      resumeController = controller
      activeBridge.setPaused(true)
      try {
        const wasDeliveryActive = deliveryActive
        deliveryActive = false
        if (wasDeliveryActive) await queueDelivery('pause')
        await reconcileRemovedProjectsAsync()
        const connectedProjects = configuredProjectIds()
        for (const project of activeConfig.projects) {
          if (cancelled(expectedGeneration, controller.signal)) throw new Error('Запуск Superagent отменён.')
          if (connectedProjects.includes(project.id)) {
            await startProject(project.id, expectedGeneration, controller.signal, restartExisting, requireReady)
          }
        }
        if (cancelled(expectedGeneration, controller.signal)) throw new Error('Запуск Superagent отменён.')
        if (requireReady) {
          const resumeGeneration = activeBridge.beginResume(connectedProjects)
          await waitForResumeReady(activeBridge, resumeGeneration, expectedGeneration, controller.signal)
          // Each Source resumes locally only after reading this active generation.
          activeBridge.activate(resumeGeneration)
          deliveryActive = true
          await queueDelivery('resume')
        }
      } catch (error) {
        activeBridge.setPaused(true)
        if (cancelled(expectedGeneration, controller.signal)) throw new Error('Запуск Superagent отменён.')
        if (!(error instanceof SetupPendingError) && expectedGeneration === generation && !stopping) panic()
        throw error
      } finally {
        if (resumeController === controller) resumeController = undefined
      }
    })
  }
  return {
    configured: Boolean(config),
    async start() {
      if (!bridge || stopping) return
      const bootReady = !bridge.isPaused()
      try {
        bridge.setPaused(true)
        mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 })
        await bridge.start()
        bridgeHealthy = true
        bridgeError = false
        startProjectWatch()
      } catch {
        bridgeHealthy = false
        bridgeError = true
        options.log('superagent disabled: bridge failed to start')
        return
      }
      await resume(false, bootReady).catch(error => options.log(`superagent recovery: ${String(error)}`))
    },
    stop() {
      if (stopTask !== undefined) return stopTask
      stopProjectWatch()
      stopping = true
      deliveryActive = false
      deliveryStopped = true
      bridgeHealthy = false
      generation++
      resumeController?.abort()
      lifetime.abort()
      const pending = (async () => {
        const controls = controlTail
        await controls
        await deliveryControl.catch(() => undefined)
        const service = delivery
        await Promise.allSettled(service === undefined ? [] : [Promise.resolve().then(() => service.stop())])
        const stoppedChildren = new Set([...children.values()])
        await Promise.allSettled([...stoppedChildren].map(child => child.stop()))
        await Promise.allSettled([...panelStarts.values()])
        await Promise.allSettled([...children.values()].filter(child => !stoppedChildren.has(child)).map(child => child.stop()))
        const stoppedPanels = new Set<Awaited<ReturnType<typeof startPanelProxy>>>()
        const stopPanel = (panel: Awaited<ReturnType<typeof startPanelProxy>>) => {
          if (stoppedPanels.has(panel)) return Promise.resolve()
          stoppedPanels.add(panel)
          return panel.stop()
        }
        await Promise.allSettled([...panels.values()].map(stopPanel))
        await Promise.allSettled([...panelStarts.values()])
        await bridge?.stop()
      })()
      stopTask = pending
      return pending
    },
    panic,
    pause: panic,
    resume,
    submit(input: SuperagentBridgeInput) {
      requireAvailable()
      reconcileRemovedProjects()
      prepared(input.projectId)
      return bridge!.enqueue(input)
    },
    replyProject(chatId: number, messageId: number) { return bridge?.replyProject(chatId, messageId) },
    stopTicket(projectId: number, ticketId: string) { return api(projectId, `tickets/${encodeURIComponent(ticketId)}/stop`, {}) },
    listUncertain() { return bridge?.listUncertain() ?? [] },
    retryUncertain(projectId: number, id: string) {
      if (!bridge) throw new Error('Полный Superagent ещё не установлен.')
      bridge.retryUncertain(projectId, id)
    },
    dismissUncertain(projectId: number, id: string) {
      if (!bridge) throw new Error('Полный Superagent ещё не установлен.')
      bridge.dismissUncertain(projectId, id)
    },
    projects() {
      return options.projects().map(project => `#${project.id} — ${project.own ? 'DSHBOT' : project.name}${config?.projects.some(row => row.id === project.id) ? '' : ' · профиль не установлен'}`).join('\n')
    },
    status() {
      if (configurationError) return 'Superagent отключён: некорректная конфигурация. Задачи прежней интеграции доступны в /factory.'
      if (bridgeError) return 'Superagent недоступен: bridge не запущен. Задачи прежней интеграции доступны в /factory.'
      if (!bridge) return 'Полный Superagent ещё не установлен. Задачи прежней интеграции доступны в /factory.'
      return [bridge.status(), ...config!.projects.filter(project => options.projects().some(row => row.id === project.id))
        .map(project => `#${project.id} · ${children.get(project.id)?.running() ? 'процесс запущен' : 'процесс остановлен'} · панель ${panelAddress(project.id, project.port)}`)].join('\n')
    },
  }
}
