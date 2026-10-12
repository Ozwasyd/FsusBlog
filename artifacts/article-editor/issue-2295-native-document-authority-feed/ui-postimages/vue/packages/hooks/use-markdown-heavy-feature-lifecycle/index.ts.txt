import { inject, provide } from 'vue'

import type { InjectionKey } from 'vue'
import type {
  MarkdownHeavyFeatureAdapterResources,
  MarkdownHeavyFeatureResourceCount,
} from '../../wasm/markdown-heavy-feature-resource'

export const MARKDOWN_HEAVY_FEATURE_KINDS = Object.freeze([
  'code-highlight',
  'latex',
  'mermaid',
] as const)

export type MarkdownHeavyFeatureKind =
  (typeof MARKDOWN_HEAVY_FEATURE_KINDS)[number]

export type MarkdownHeavyFeatureState =
  | 'active-work'
  | 'static-mounted'
  | 'unmounted'

export const MARKDOWN_HEAVY_FEATURE_CACHE_BUDGET = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxEntries: 128,
  version: 'markdown-heavy-feature-cache@1',
})

export interface MarkdownHeavyFeatureIdentity {
  readonly config: string
  readonly documentEpoch: number | string
  readonly documentKey: string
  readonly featureKind: MarkdownHeavyFeatureKind
  readonly gatewayVersion: string
  readonly locale: string
  readonly nodeId: string
  readonly rendererVersion: string
  readonly revision: number | string
  readonly sourceIdentity: string
  readonly theme: string
}

export interface MarkdownHeavyFeatureLifecycleMetrics {
  readonly aborts: number
  readonly activations: number
  readonly activeNodes: number
  readonly cacheBytes: number
  readonly cacheEntries: number
  readonly evictions: number
  readonly reuses: number
  readonly retainedListeners: number
  readonly retainedObservers: number
  readonly retainedResources: number
  readonly retainedRuntimes: number
  readonly retainedTasks: number
  readonly staleCommits: number
  readonly staticNodes: number
  readonly teardowns: number
  readonly unmountedNodes: number
}

export interface MarkdownHeavyFeatureResources extends MarkdownHeavyFeatureAdapterResources {}

export interface MarkdownHeavyFeatureResourceInspection {
  readonly admission: 'open' | 'paused' | 'disposed'
  readonly networkCancellation: 'unavailable'
  readonly resumeAdmissionAvailable: boolean
  readonly scope: 'owned-handles'
  readonly timerCancellation: 'unavailable'
  readonly usage: Readonly<{
    listeners: number
    networkRequests: MarkdownHeavyFeatureResourceCount
    observers: number
    pendingImports: number
    runtimes: number
    scheduledContinuations: number
    tasks: number
    timers: MarkdownHeavyFeatureResourceCount
  }>
}

export interface MarkdownHeavyFeatureActivation<T> {
  readonly commit: (
    value: T,
    signal: AbortSignal,
  ) => HTMLElement | void | Promise<HTMLElement | void>
  readonly element: HTMLElement
  readonly estimateBytes: (value: T) => number
  readonly identity: MarkdownHeavyFeatureIdentity
  readonly render: (signal: AbortSignal) => Promise<T>
  readonly resources?: Partial<MarkdownHeavyFeatureResources>
  readonly signal?: AbortSignal
  readonly teardown?: () => void
}

export interface MarkdownHeavyFeatureLifecycle {
  activate: <T>(input: MarkdownHeavyFeatureActivation<T>) => Promise<boolean>
  dispose: () => void
  inspectResources: () => MarkdownHeavyFeatureResourceInspection
  metrics: () => MarkdownHeavyFeatureLifecycleMetrics
  mountStatic: (input: {
    readonly element: HTMLElement
    readonly identity: MarkdownHeavyFeatureIdentity
  }) => boolean
  pause: () => void
  resetDocument: (documentKey: string, documentEpoch: number | string) => void
  resume: () => boolean
  unmountRoot: (root: ParentNode) => void
}

export interface MarkdownHeavyFeatureLifecycleOptions {
  readonly maxBytes?: number
  readonly maxEntries?: number
  readonly onMetricsChange?: (
    metrics: MarkdownHeavyFeatureLifecycleMetrics,
  ) => void
}

interface CacheEntry {
  readonly bytes: number
  readonly key: string
  readonly value: unknown
  used: number
}

interface NodeRecord {
  controller: AbortController | null
  documentEpoch: number | string
  documentKey: string
  element: HTMLElement
  identityKey: string
  removeExternalAbort?: () => void
  resourceRecord: ResourceRecord
  state: Exclude<MarkdownHeavyFeatureState, 'unmounted'>
  teardown?: () => void
  tornDown: boolean
}

interface ResourceRecord {
  released: boolean
  removeResourceChange?: () => void
  awaitPending: boolean
  resources: Partial<MarkdownHeavyFeatureResources>
  unobservedWork: boolean
}

const identityParts = (identity: MarkdownHeavyFeatureIdentity) => [
  identity.documentKey,
  identity.documentEpoch,
  identity.revision,
  identity.nodeId,
  identity.featureKind,
  identity.sourceIdentity,
  identity.config,
  identity.theme,
  identity.locale,
  identity.rendererVersion,
  identity.gatewayVersion,
]

const validIdentity = (identity: MarkdownHeavyFeatureIdentity) =>
  identityParts(identity).every(
    (part) =>
      (typeof part === 'string' && part.length > 0) ||
      (typeof part === 'number' && Number.isFinite(part)),
  )

const cacheKeyOf = (identity: MarkdownHeavyFeatureIdentity) =>
  JSON.stringify(identityParts(identity))

const nodeKeyOf = (identity: MarkdownHeavyFeatureIdentity) =>
  JSON.stringify([
    identity.documentKey,
    identity.documentEpoch,
    identity.nodeId,
    identity.featureKind,
  ])

const normalizeResourceCount = (value: number | undefined) => {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('markdown_heavy_feature_resource_count_invalid')
  }
  return value
}

const normalizeResources = (
  resources: Partial<MarkdownHeavyFeatureResources> | undefined,
): MarkdownHeavyFeatureResources => ({
  listeners: normalizeResourceCount(resources?.listeners),
  observers: normalizeResourceCount(resources?.observers),
  pendingImports: normalizeResourceCount(resources?.pendingImports),
  runtimes: normalizeResourceCount(resources?.runtimes),
  scheduledContinuations: normalizeResourceCount(
    resources?.scheduledContinuations,
  ),
  tasks: normalizeResourceCount(resources?.tasks),
})

const EMPTY_RESOURCES: MarkdownHeavyFeatureResources = Object.freeze({
  listeners: 0,
  networkRequests: 0,
  observers: 0,
  pendingImports: 0,
  runtimes: 0,
  scheduledContinuations: 0,
  tasks: 0,
  timers: 0,
})

const isDeeplyFrozen = (
  value: unknown,
  seen = new WeakSet<object>(),
): boolean => {
  if (Object(value) !== value) return true
  const object = value as object
  if (seen.has(object)) return true
  if (!Object.isFrozen(object)) return false
  seen.add(object)
  return Reflect.ownKeys(object).every((key) =>
    isDeeplyFrozen((object as Record<PropertyKey, unknown>)[key], seen),
  )
}

export const createMarkdownHeavyFeatureLifecycle = (
  options: MarkdownHeavyFeatureLifecycleOptions = {},
): MarkdownHeavyFeatureLifecycle => {
  const normalizeBudget = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : fallback
  const maxBytes = normalizeBudget(
    options.maxBytes,
    MARKDOWN_HEAVY_FEATURE_CACHE_BUDGET.maxBytes,
  )
  const maxEntries = normalizeBudget(
    options.maxEntries,
    MARKDOWN_HEAVY_FEATURE_CACHE_BUDGET.maxEntries,
  )
  const cache = new Map<string, CacheEntry>()
  const nodes = new Map<string, NodeRecord>()
  const resourceRecords = new Set<ResourceRecord>()
  // Once unobservable work has escaped an owner, settlement or disposal cannot
  // prove a zero timer/network census. Retain uncertainty without retaining DOM.
  let retiredTimers: MarkdownHeavyFeatureResourceCount = 0
  let retiredNetworkRequests: MarkdownHeavyFeatureResourceCount = 0
  let cacheBytes = 0
  let clock = 0
  let aborts = 0
  let activations = 0
  let evictions = 0
  let reuses = 0
  let staleCommits = 0
  let teardowns = 0
  let unmountedNodes = 0
  let disposed = false
  let paused = false

  const notifyMetricsChange = () => options.onMetricsChange?.(metrics())

  const readUnobservableCount = (
    record: ResourceRecord,
    key: 'networkRequests' | 'timers',
  ): MarkdownHeavyFeatureResourceCount => {
    if (record.unobservedWork) return 'unknown'
    const value = record.resources[key]
    if (value === 'unknown' || value === 'unavailable') return value
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : 'unknown'
  }
  const addCounts = (
    a: MarkdownHeavyFeatureResourceCount,
    b: MarkdownHeavyFeatureResourceCount,
  ): MarkdownHeavyFeatureResourceCount => {
    if (a === 'unknown' || b === 'unknown') return 'unknown'
    if (a === 'unavailable' || b === 'unavailable') return 'unavailable'
    return a + b
  }
  const pruneReleasedResource = (record: ResourceRecord) => {
    if (!record.released || record.awaitPending) return
    const resources = normalizeResources(record.resources)
    if (
      resources.listeners ||
      resources.observers ||
      resources.runtimes ||
      resources.tasks ||
      resources.pendingImports ||
      resources.scheduledContinuations
    )
      return
    const timers = readUnobservableCount(record, 'timers')
    const networkRequests = readUnobservableCount(record, 'networkRequests')
    if (typeof timers === 'number' && timers > 0) return
    if (typeof networkRequests === 'number' && networkRequests > 0) return
    retiredTimers = addCounts(retiredTimers, timers)
    retiredNetworkRequests = addCounts(retiredNetworkRequests, networkRequests)
    record.removeResourceChange?.()
    record.removeResourceChange = undefined
    resourceRecords.delete(record)
  }

  const releaseActiveResource = (record: NodeRecord) => {
    record.removeExternalAbort?.()
    record.removeExternalAbort = undefined
    const teardown = record.teardown
    record.teardown = undefined
    record.resourceRecord.released = true
    teardown?.()
    pruneReleasedResource(record.resourceRecord)
  }

  const teardownRecord = (record: NodeRecord) => {
    if (record.tornDown) return
    record.tornDown = true
    const controller = record.controller
    record.controller = null
    if (controller && !controller.signal.aborted) {
      aborts += 1
      controller.abort()
    }
    releaseActiveResource(record)
    teardowns += 1
  }

  const removeIfCurrent = (key: string, record: NodeRecord) => {
    if (nodes.get(key) !== record) return false
    // Detach before abort/teardown callbacks can install a newer generation.
    nodes.delete(key)
    return true
  }

  const evict = () => {
    while (cache.size > maxEntries || cacheBytes > maxBytes) {
      let oldest: CacheEntry | undefined
      for (const entry of cache.values()) {
        if (!oldest || entry.used < oldest.used) oldest = entry
      }
      if (!oldest) break
      cache.delete(oldest.key)
      cacheBytes -= oldest.bytes
      evictions += 1
    }
  }

  const activate = async <T>(input: MarkdownHeavyFeatureActivation<T>) => {
    if (disposed || paused || !validIdentity(input.identity)) return false
    const resources = input.resources ?? EMPTY_RESOURCES
    if (input.resources && !input.teardown) {
      throw new Error('markdown_heavy_feature_teardown_required')
    }
    normalizeResources(resources)
    const nodeKey = nodeKeyOf(input.identity)
    const identityKey = cacheKeyOf(input.identity)
    const previous = nodes.get(nodeKey)
    if (previous) {
      removeIfCurrent(nodeKey, previous)
      teardownRecord(previous)
    }
    if (disposed || paused || nodes.has(nodeKey)) return false

    const controller = new AbortController()
    const resourceRecord: ResourceRecord = {
      released: false,
      awaitPending: false,
      resources,
      unobservedWork: false,
    }
    const record: NodeRecord = {
      controller,
      documentEpoch: input.identity.documentEpoch,
      documentKey: input.identity.documentKey,
      element: input.element,
      identityKey,
      resourceRecord,
      state: 'active-work',
      teardown: input.teardown,
      tornDown: false,
    }
    nodes.set(nodeKey, record)
    resourceRecords.add(resourceRecord)
    const discardIfCurrent = () => {
      const removed = removeIfCurrent(nodeKey, record)
      // A stale completion still owns its own cleanup, never the new record.
      teardownRecord(record)
      if (!removed) return
      unmountedNodes += 1
      notifyMetricsChange()
    }
    const canStartWork = () =>
      !disposed &&
      !paused &&
      !controller.signal.aborted &&
      !resourceRecord.released &&
      nodes.get(nodeKey) === record
    const awaitTask = async <U>(run: () => U | Promise<U>): Promise<U> => {
      if (!canStartWork()) throw new DOMException('Aborted', 'AbortError')
      resourceRecord.awaitPending = true
      try {
        notifyMetricsChange()
        if (!canStartWork()) throw new DOMException('Aborted', 'AbortError')
        return await run()
      } finally {
        resourceRecord.awaitPending = false
        pruneReleasedResource(resourceRecord)
        notifyMetricsChange()
      }
    }
    const abort = () => discardIfCurrent()
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal) {
      record.removeExternalAbort = () =>
        input.signal?.removeEventListener('abort', abort)
    }
    if (input.signal?.aborted) {
      discardIfCurrent()
      input.signal.removeEventListener('abort', abort)
      return false
    }

    try {
      resourceRecord.removeResourceChange = resources.subscribe?.(() => {
        pruneReleasedResource(resourceRecord)
        notifyMetricsChange()
      })
      // subscribe may synchronously cancel before returning its remover.
      pruneReleasedResource(resourceRecord)
      notifyMetricsChange()
      if (!canStartWork()) {
        discardIfCurrent()
        return false
      }
      const cached = cache.get(identityKey)
      if (cached) {
        cached.used = ++clock
        const committed = await awaitTask(() =>
          input.commit(cached.value as T, controller.signal),
        )
        if (controller.signal.aborted || nodes.get(nodeKey) !== record) {
          discardIfCurrent()
          staleCommits += 1
          return false
        }
        if (committed) record.element = committed
        releaseActiveResource(record)
        if (controller.signal.aborted || nodes.get(nodeKey) !== record) {
          discardIfCurrent()
          staleCommits += 1
          return false
        }
        record.controller = null
        record.state = 'static-mounted'
        reuses += 1
        notifyMetricsChange()
        return false
      }

      const value = await awaitTask(() => {
        activations += 1
        resourceRecord.unobservedWork = !input.resources
        return input.render(controller.signal)
      })
      const current = nodes.get(nodeKey)
      if (
        controller.signal.aborted ||
        current !== record ||
        current.identityKey !== identityKey
      ) {
        discardIfCurrent()
        staleCommits += 1
        return false
      }
      if (!isDeeplyFrozen(value)) {
        discardIfCurrent()
        staleCommits += 1
        return false
      }
      const committed = await awaitTask(() =>
        input.commit(value, controller.signal),
      )
      if (controller.signal.aborted || nodes.get(nodeKey) !== record) {
        discardIfCurrent()
        staleCommits += 1
        return false
      }
      if (committed) current.element = committed
      releaseActiveResource(current)
      if (controller.signal.aborted || nodes.get(nodeKey) !== record) {
        discardIfCurrent()
        staleCommits += 1
        return false
      }
      current.controller = null
      current.state = 'static-mounted'
      const estimate = input.estimateBytes(value)
      if (disposed || paused || nodes.get(nodeKey) !== record) {
        discardIfCurrent()
        staleCommits += 1
        return false
      }
      const bytes =
        Number.isFinite(estimate) && estimate >= 0
          ? Math.floor(estimate)
          : maxBytes + 1
      if (bytes <= maxBytes) {
        const old = cache.get(identityKey)
        if (old) cacheBytes -= old.bytes
        cache.set(identityKey, {
          bytes,
          key: identityKey,
          used: ++clock,
          value,
        })
        cacheBytes += bytes
        evict()
      }
      notifyMetricsChange()
      return true
    } catch (error) {
      if (controller.signal.aborted) {
        discardIfCurrent()
        staleCommits += 1
        return false
      }
      discardIfCurrent()
      throw error
    } finally {
      record.removeExternalAbort?.()
      record.removeExternalAbort = undefined
      if (record.controller === controller) record.controller = null
    }
  }

  const unmountRoot = (root: ParentNode) => {
    const rootNode = root as Node
    let changed = false
    for (const [key, record] of [...nodes]) {
      if (rootNode === record.element || rootNode.contains(record.element)) {
        const removed = removeIfCurrent(key, record)
        teardownRecord(record)
        if (removed) {
          unmountedNodes += 1
          changed = true
        }
      }
    }
    if (changed) notifyMetricsChange()
  }

  const mountStatic: MarkdownHeavyFeatureLifecycle['mountStatic'] = (input) => {
    if (disposed || !validIdentity(input.identity)) return false
    const nodeKey = nodeKeyOf(input.identity)
    const previous = nodes.get(nodeKey)
    if (previous) {
      removeIfCurrent(nodeKey, previous)
      teardownRecord(previous)
    }
    if (disposed || nodes.has(nodeKey)) return false
    nodes.set(nodeKey, {
      controller: null,
      documentEpoch: input.identity.documentEpoch,
      documentKey: input.identity.documentKey,
      element: input.element,
      identityKey: cacheKeyOf(input.identity),
      resourceRecord: {
        released: true,
        awaitPending: false,
        resources: EMPTY_RESOURCES,
        unobservedWork: false,
      },
      state: 'static-mounted',
      tornDown: false,
    })
    notifyMetricsChange()
    return true
  }

  const resetDocument = (
    documentKey: string,
    documentEpoch: number | string,
  ) => {
    let changed = false
    for (const [key, record] of [...nodes]) {
      if (
        record.documentKey !== documentKey ||
        record.documentEpoch !== documentEpoch
      ) {
        const removed = removeIfCurrent(key, record)
        teardownRecord(record)
        if (removed) {
          unmountedNodes += 1
          changed = true
        }
      }
    }
    if (changed) notifyMetricsChange()
  }

  function metrics(): MarkdownHeavyFeatureLifecycleMetrics {
    let activeNodes = 0
    let staticNodes = 0
    let retainedListeners = 0
    let retainedObservers = 0
    let retainedRuntimes = 0
    let retainedTasks = 0
    for (const record of nodes.values()) {
      if (record.state === 'active-work') {
        activeNodes += 1
        retainedListeners += record.removeExternalAbort ? 1 : 0
      } else staticNodes += 1
    }
    for (const record of resourceRecords) {
      const resources = normalizeResources(record.resources)
      retainedListeners += resources.listeners
      retainedObservers += resources.observers
      retainedRuntimes += resources.runtimes
      // The lifecycle await and adapter work are independently held tasks.
      retainedTasks += (record.awaitPending ? 1 : 0) + resources.tasks
    }
    return Object.freeze({
      aborts,
      activations,
      activeNodes,
      cacheBytes,
      cacheEntries: cache.size,
      evictions,
      reuses,
      retainedListeners,
      retainedObservers,
      retainedResources:
        retainedListeners +
        retainedObservers +
        retainedRuntimes +
        retainedTasks,
      retainedRuntimes,
      retainedTasks,
      staleCommits,
      staticNodes,
      teardowns,
      unmountedNodes,
    })
  }

  const inspectResources = (): MarkdownHeavyFeatureResourceInspection => {
    const local = metrics()
    let timers = retiredTimers
    let networkRequests = retiredNetworkRequests
    let pendingImports = 0
    let scheduledContinuations = 0
    for (const record of resourceRecords) {
      timers = addCounts(timers, readUnobservableCount(record, 'timers'))
      networkRequests = addCounts(
        networkRequests,
        readUnobservableCount(record, 'networkRequests'),
      )
      pendingImports += normalizeResourceCount(record.resources.pendingImports)
      scheduledContinuations += normalizeResourceCount(
        record.resources.scheduledContinuations,
      )
    }
    return Object.freeze({
      admission: disposed ? 'disposed' : paused ? 'paused' : 'open',
      networkCancellation: 'unavailable',
      resumeAdmissionAvailable: !disposed,
      scope: 'owned-handles',
      timerCancellation: 'unavailable',
      usage: Object.freeze({
        listeners: local.retainedListeners,
        networkRequests,
        observers: local.retainedObservers,
        pendingImports,
        runtimes: local.retainedRuntimes,
        scheduledContinuations,
        tasks: local.retainedTasks,
        timers,
      }),
    })
  }

  const pause = () => {
    if (disposed || paused) return
    paused = true
    for (const [key, record] of [...nodes]) {
      if (record.state !== 'active-work') continue
      const removed = removeIfCurrent(key, record)
      teardownRecord(record)
      if (removed) unmountedNodes += 1
    }
    notifyMetricsChange()
  }

  const resume = () => {
    if (disposed) return false
    paused = false
    notifyMetricsChange()
    return true
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const [key, record] of [...nodes]) {
      removeIfCurrent(key, record)
      teardownRecord(record)
    }
    cache.clear()
    cacheBytes = 0
    notifyMetricsChange()
  }

  return Object.freeze({
    activate,
    dispose,
    inspectResources,
    metrics,
    mountStatic,
    pause,
    resetDocument,
    resume,
    unmountRoot,
  })
}

/** Borrowed exact ticket from the original native transaction producer; no source/history payload. */
export interface MarkdownHeavyFeatureDocumentAuthorityTicket {
  readonly scope: 'native-transaction-document'
  readonly documentKey: string
  readonly documentEpoch: number | string
  readonly revision: number | string
}

export interface MarkdownHeavyFeatureDocumentAuthority {
  capture(): MarkdownHeavyFeatureDocumentAuthorityTicket | null
  /** Original private producer continuity only; no external read/callback/allocation. */
  hasCustody(ticket: MarkdownHeavyFeatureDocumentAuthorityTicket): boolean
}

export interface MarkdownHeavyFeatureDocumentContext {
  readonly documentEpoch: () => number | string
  readonly documentKey: () => string
  readonly revision: () => number | string
  readonly documentAuthority?: MarkdownHeavyFeatureDocumentAuthority
}

export const MARKDOWN_HEAVY_FEATURE_DOCUMENT_CONTEXT: InjectionKey<MarkdownHeavyFeatureDocumentContext> =
  Symbol.for('fsus-markdown-heavy-feature-document-context')

export const provideMarkdownHeavyFeatureDocumentContext = (
  context: MarkdownHeavyFeatureDocumentContext,
) => provide(MARKDOWN_HEAVY_FEATURE_DOCUMENT_CONTEXT, context)

export const useMarkdownHeavyFeatureDocumentContext = () =>
  inject(MARKDOWN_HEAVY_FEATURE_DOCUMENT_CONTEXT, null)
