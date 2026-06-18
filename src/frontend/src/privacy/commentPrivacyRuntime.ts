import {
  getCommentPrivacyWorkerClient
} from './commentPrivacyWorkerClient'
import type {
  CommentPrivacyAdapter,
  CommentPrivacyAdapterFailure,
  CommentPrivacyMetadata,
  CommentPrivacyPreparedTicket,
  CommentPrivacyUiState,
  CommentPrivacyWorkerClient
} from './commentPrivacyTypes'

export type {
  CommentPrivacyAdapter,
  CommentPrivacyMetadata,
  CommentPrivacyPreparedTicket,
  CommentPrivacyUiState,
  CommentPrivacyWorkerClient
} from './commentPrivacyTypes'

type CommentPrivacyListener = (state: CommentPrivacyUiState) => void
type ScheduleIdleTask = (task: () => void) => () => void

export interface CommentPrivacyRuntime {
  ensureCredentialPrepared(): Promise<boolean>
  preloadPrivacyMetadata(articleId: number): Promise<boolean>
  prewarmProver(): Promise<boolean>
  prepareAnonymousTicket(scope: string): Promise<boolean>
  consumePreparedTicket(scope: string): CommentPrivacyPreparedTicket | null
  getUiState(): CommentPrivacyUiState
  subscribe(listener: CommentPrivacyListener): () => void
}

export interface CommentPrivacyRuntimeOptions {
  adapter?: CommentPrivacyAdapter
  workerClient?: CommentPrivacyWorkerClient
  now?: () => number
  scheduleIdleTask?: ScheduleIdleTask
}

const unavailableAdapter: CommentPrivacyAdapter = {
  async ensureCredentialPrepared() {
    return { ok: false, reason: 'comment_privacy_unavailable' }
  },
  async loadPrivacyMetadata() {
    return { ok: false, reason: 'comment_privacy_metadata_unavailable' }
  },
  async issueAnonymousTicket() {
    return { ok: false, reason: 'comment_privacy_ticket_unavailable' }
  }
}

let singleton: CommentPrivacyRuntime | null = null

export function getCommentPrivacyRuntime(): CommentPrivacyRuntime {
  if (!singleton) {
    singleton = createCommentPrivacyRuntime()
  }

  return singleton
}

export function resetCommentPrivacyRuntimeForTests(): void {
  singleton = null
}

export function createCommentPrivacyRuntime(options: CommentPrivacyRuntimeOptions = {}): CommentPrivacyRuntime {
  const adapter = options.adapter ?? unavailableAdapter
  const workerClient = options.workerClient ?? getCommentPrivacyWorkerClient()
  const now = options.now ?? (() => Date.now())
  const scheduleIdleTask = options.scheduleIdleTask ?? scheduleCommentPrivacyIdleTask
  const metadataByScope = new Map<string, CommentPrivacyMetadata>()
  const ticketsByScope = new Map<string, CommentPrivacyPreparedTicket>()
  const listeners = new Set<CommentPrivacyListener>()

  let uiState: CommentPrivacyUiState = 'publicOnly'
  let activeTasks = 0
  let unavailable = false
  let credentialPrepared = false
  let activePreloadController: AbortController | null = null
  let activePrepareController: AbortController | null = null

  const emitState = (): void => {
    const next = computeUiState()
    if (next === uiState) {
      return
    }

    uiState = next
    for (const listener of listeners) {
      listener(uiState)
    }
  }

  const computeUiState = (): CommentPrivacyUiState => {
    pruneExpiredTickets()
    if (unavailable) {
      return 'unavailable'
    }
    if (activeTasks > 0 || metadataByScope.size > 0) {
      return ticketsByScope.size > 0 ? 'ready' : 'preparing'
    }
    if (ticketsByScope.size > 0) {
      return 'ready'
    }

    return 'publicOnly'
  }

  const runTask = async <T>(action: () => Promise<T>): Promise<T> => {
    activeTasks += 1
    emitState()
    try {
      return await action()
    } finally {
      activeTasks = Math.max(0, activeTasks - 1)
      emitState()
    }
  }

  const markUnavailable = (): void => {
    unavailable = true
    emitState()
  }

  const loadMetadata = async (scope: string, articleId: number | null, signal: AbortSignal): Promise<CommentPrivacyMetadata | null> => {
    const result = await adapter.loadPrivacyMetadata({ scope, articleId, signal })
    if (!result.ok) {
      if (!signal.aborted) {
        markUnavailable()
      }
      return null
    }

    metadataByScope.set(scope, result.metadata)
    emitState()
    return result.metadata
  }

  const ensureMetadata = async (scope: string, signal: AbortSignal): Promise<CommentPrivacyMetadata | null> => {
    const cached = metadataByScope.get(scope)
    if (cached) {
      return cached
    }

    return await loadMetadata(scope, parseArticleIdFromScope(scope), signal)
  }

  const ensureCredentialPrepared = async (): Promise<boolean> => {
    if (credentialPrepared) {
      return true
    }

    const controller = new AbortController()
    return await runTask(async () => {
      try {
        const result = await adapter.ensureCredentialPrepared({ signal: controller.signal })
        if (!result.ok) {
          markUnavailable()
          return false
        }

        credentialPrepared = true
        return true
      } catch {
        markUnavailable()
        return false
      }
    })
  }

  const prewarmProver = async (): Promise<boolean> => {
    const controller = new AbortController()
    return await runTask(async () => {
      try {
        await workerClient.prewarm(controller.signal)
        return true
      } catch {
        markUnavailable()
        return false
      }
    })
  }

  const cancelActivePreload = (): void => {
    activePreloadController?.abort()
    activePreloadController = null
  }

  const preloadPrivacyMetadata = async (articleId: number): Promise<boolean> => {
    cancelActivePreload()
    const scope = toArticleScope(articleId)
    const controller = new AbortController()
    activePreloadController = controller

    return await new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (value: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        resolve(value)
      }
      const cancelIdle = scheduleIdleTask(() => {
        void runTask(async () => {
          if (controller.signal.aborted) {
            settle(false)
            return
          }
          try {
            if (!credentialPrepared) {
              const credential = await adapter.ensureCredentialPrepared({ signal: controller.signal })
              if (!credential.ok) {
                markUnavailable()
                settle(false)
                return
              }

              credentialPrepared = true
            }

            const metadata = await loadMetadata(scope, articleId, controller.signal)
            settle(Boolean(metadata))
          } catch {
            if (!controller.signal.aborted) {
              markUnavailable()
            }
            settle(false)
          } finally {
            if (activePreloadController === controller) {
              activePreloadController = null
            }
          }
        })
      })
      controller.signal.addEventListener('abort', () => {
        cancelIdle()
        settle(false)
      }, { once: true })
    })
  }

  const prepareAnonymousTicket = async (scope: string): Promise<boolean> => {
    const normalizedScope = normalizeScope(scope)
    activePrepareController?.abort()
    const controller = new AbortController()
    activePrepareController = controller

    return await runTask(async () => {
      try {
        if (!credentialPrepared) {
          const credential = await adapter.ensureCredentialPrepared({ signal: controller.signal })
          if (!credential.ok) {
            markUnavailable()
            return false
          }

          credentialPrepared = true
        }

        const metadata = await ensureMetadata(normalizedScope, controller.signal)
        if (!metadata) {
          return false
        }

        await workerClient.prewarm(controller.signal)
        const proofBytes = await workerClient.prepareProof({
          scope: normalizedScope,
          rootVersion: metadata.rootVersion,
          metadataBytes: metadata.metadataBytes,
          signal: controller.signal
        })
        const ticket = await adapter.issueAnonymousTicket({
          scope: normalizedScope,
          metadata,
          proofBytes,
          signal: controller.signal
        })
        if (!ticket.ok || ticket.ticket.expiresAtUnixMs <= now()) {
          markUnavailable()
          return false
        }

        ticketsByScope.set(normalizedScope, ticket.ticket)
        unavailable = false
        emitState()
        return true
      } catch {
        if (!controller.signal.aborted) {
          markUnavailable()
        }
        return false
      } finally {
        if (activePrepareController === controller) {
          activePrepareController = null
        }
      }
    })
  }

  const consumePreparedTicket = (scope: string): CommentPrivacyPreparedTicket | null => {
    const normalizedScope = normalizeScope(scope)
    const ticket = ticketsByScope.get(normalizedScope)
    if (!ticket || ticket.expiresAtUnixMs <= now()) {
      ticketsByScope.delete(normalizedScope)
      emitState()
      return null
    }

    ticketsByScope.delete(normalizedScope)
    emitState()
    return ticket
  }

  const pruneExpiredTickets = (): void => {
    for (const [scope, ticket] of ticketsByScope) {
      if (ticket.expiresAtUnixMs <= now()) {
        ticketsByScope.delete(scope)
      }
    }
  }

  return {
    ensureCredentialPrepared,
    preloadPrivacyMetadata,
    prewarmProver,
    prepareAnonymousTicket,
    consumePreparedTicket,
    getUiState() {
      uiState = computeUiState()
      return uiState
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(uiState)
      return () => listeners.delete(listener)
    }
  }
}

function toArticleScope(articleId: number): string {
  return `article:${articleId}`
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim()
  return normalized || 'article'
}

function parseArticleIdFromScope(scope: string): number | null {
  if (!scope.startsWith('article:')) {
    return null
  }

  const parsed = Number(scope.slice('article:'.length))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function scheduleCommentPrivacyIdleTask(task: () => void): () => void {
  let cancelled = false
  const run = (): void => {
    if (!cancelled) {
      task()
    }
  }

  const idleWindow = typeof window !== 'undefined'
    ? window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
      cancelIdleCallback?: (handle: number) => void
    }
    : null
  if (typeof idleWindow?.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(() => run(), { timeout: 1_000 })
    return () => {
      cancelled = true
      idleWindow.cancelIdleCallback?.(handle)
    }
  }

  if (typeof queueMicrotask === 'function') {
    queueMicrotask(run)
    return () => {
      cancelled = true
    }
  }

  const handle = setTimeout(run, 0)
  return () => {
    cancelled = true
    clearTimeout(handle)
  }
}

export function createUnavailableCommentPrivacyAdapter(reason = 'comment_privacy_unavailable'): CommentPrivacyAdapter {
  const fail = async (): Promise<CommentPrivacyAdapterFailure> => ({ ok: false, reason })
  return {
    ensureCredentialPrepared: fail,
    loadPrivacyMetadata: fail,
    issueAnonymousTicket: fail
  }
}
