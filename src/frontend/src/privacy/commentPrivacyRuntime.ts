import {
  getCommentPrivacyWorkerClient
} from './commentPrivacyWorkerClient'
import { createCommentPrivacyAdapter } from './commentPrivacyAdapter'
import type { CommentPrivacyCredentialMaterial } from './commentPrivacyContracts'
import type {
  CommentPrivacyAdapter,
  CommentPrivacyAdapterFailure,
  CommentPrivacyMetadata,
  CommentPrivacyPreparedTicket,
  CommentPrivacyTicketResult,
  CommentPrivacyUiState,
  CommentPrivacyWorkerClient
} from './commentPrivacyTypes'
import {
  registerCommentPrivacyCredentialPurgeHandler,
  type CommentPrivacyCredentialPurgeReason,
  zeroizeCommentPrivacyBytes
} from './commentPrivacyCredentialLifecycle'

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
  purge(reason: CommentPrivacyCredentialPurgeReason): Promise<void>
}

export interface CommentPrivacyRuntimeOptions {
  adapter?: CommentPrivacyAdapter
  workerClient?: CommentPrivacyWorkerClient
  now?: () => number
  scheduleIdleTask?: ScheduleIdleTask
}

let singleton: CommentPrivacyRuntime | null = null
let unregisterSingletonPurgeHandler: (() => void) | null = null

export function getCommentPrivacyRuntime(): CommentPrivacyRuntime {
  if (!singleton) {
    singleton = createCommentPrivacyRuntime()
    unregisterSingletonPurgeHandler = registerCommentPrivacyCredentialPurgeHandler(reason => singleton?.purge(reason))
  }

  return singleton
}

export function resetCommentPrivacyRuntimeForTests(): void {
  unregisterSingletonPurgeHandler?.()
  unregisterSingletonPurgeHandler = null
  void singleton?.purge('panic')
  singleton = null
}

export function createCommentPrivacyRuntime(options: CommentPrivacyRuntimeOptions = {}): CommentPrivacyRuntime {
  const adapter = options.adapter ?? createCommentPrivacyAdapter()
  const workerClient = options.workerClient ?? getCommentPrivacyWorkerClient()
  const now = options.now ?? (() => Date.now())
  const scheduleIdleTask = options.scheduleIdleTask ?? scheduleCommentPrivacyIdleTask
  const metadataByScope = new Map<string, CommentPrivacyMetadata>()
  const ticketsByScope = new Map<string, CommentPrivacyPreparedTicket>()
  const listeners = new Set<CommentPrivacyListener>()

  let uiState: CommentPrivacyUiState = 'publicOnly'
  let activeTasks = 0
  let unavailable = false
  let credentialMaterial: CommentPrivacyCredentialMaterial | null = null
  let activePreloadController: AbortController | null = null
  let activePrepareController: AbortController | null = null

  const replaceCredentialMaterial = (material: CommentPrivacyCredentialMaterial | null): void => {
    zeroizeCredentialMaterial(credentialMaterial)
    credentialMaterial = material ? cloneCredentialMaterial(material) : null
  }

  const refreshCredential = async (signal: AbortSignal): Promise<boolean> => {
    const result = await adapter.ensureCredentialPrepared({ signal })
    if (!result.ok || !result.credential || signal.aborted) {
      replaceCredentialMaterial(null)
      return false
    }
    replaceCredentialMaterial(result.credential)
    zeroizeCredentialMaterial(result.credential)
    return true
  }

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
    const controller = new AbortController()
    return await runTask(async () => {
      try {
        if (!await refreshCredential(controller.signal)) {
          markUnavailable()
          return false
        }
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
            if (!await refreshCredential(controller.signal)) {
              if (!controller.signal.aborted) {
                markUnavailable()
              }
              settle(false)
              return
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
        if (!await refreshCredential(controller.signal)) {
          markUnavailable()
          return false
        }

        const metadata = await ensureMetadata(normalizedScope, controller.signal)
        if (!metadata) {
          return false
        }
        const ticketMetadata = attachCredentialMaterial(metadata, credentialMaterial)

        await workerClient.prewarm(controller.signal)
        const proof = await workerClient.prepareProof({
          scope: normalizedScope,
          rootVersion: ticketMetadata.rootVersion,
          metadataBytes: ticketMetadata.metadataBytes,
          credentialEpoch: ticketMetadata.credentialEpoch,
          circuitNumericId: ticketMetadata.circuitNumericId,
          publicInputLayoutVersion: ticketMetadata.publicInputLayoutVersion,
          circuitId: ticketMetadata.circuitId,
          verifyingKeyHash: ticketMetadata.verifyingKeyHash,
          issuerPublicKeyHash: ticketMetadata.issuerPublicKeyHash,
          policyHash: ticketMetadata.policyHash,
          isEligible: true,
          mayComment: true,
          rateClass: 'common',
          requiresModeration: false,
          credentialCommitment: credentialMaterial?.credentialCommitment,
          credentialRoot: ticketMetadata.credentialRoot,
          revocationRoot: ticketMetadata.revocationRoot,
          circuitMetadata: ticketMetadata.circuitMetadata,
          credentialLevel: ticketMetadata.credentialLevel,
          reputationBucket: ticketMetadata.reputationBucket,
          credentialSecret: credentialMaterial?.credentialSecret,
          issuerSignature: credentialMaterial?.issuerSignature,
          revocationWitness: credentialMaterial?.revocationWitness,
          signal: controller.signal
        })
        let ticket: CommentPrivacyTicketResult
        try {
          ticket = await adapter.issueAnonymousTicket({
            scope: normalizedScope,
            metadata: ticketMetadata,
            proof,
            proofBytes: proof.proofBytes,
            signal: controller.signal
          })
        } finally {
          zeroizeCommentPrivacyBytes(proof.proofBytes)
          zeroizeCommentPrivacyBytes(proof.publicInputs)
          zeroizeCommentPrivacyBytes(proof.nullifierHash)
        }
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
      zeroizePreparedTicket(ticket)
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
        zeroizePreparedTicket(ticket)
        ticketsByScope.delete(scope)
      }
    }
  }

  const purge = async (reason: CommentPrivacyCredentialPurgeReason): Promise<void> => {
    activePreloadController?.abort()
    activePrepareController?.abort()
    activePreloadController = null
    activePrepareController = null
    replaceCredentialMaterial(null)
    for (const metadata of metadataByScope.values()) {
      zeroizeMetadata(metadata)
    }
    metadataByScope.clear()
    for (const ticket of ticketsByScope.values()) {
      zeroizePreparedTicket(ticket)
    }
    ticketsByScope.clear()
    await adapter.purgeCredential?.()
    workerClient.dispose()
    activeTasks = 0
    unavailable = reason === 'feature-disabled' || reason === 'migration-failure'
    emitState()
  }

  return {
    ensureCredentialPrepared,
    preloadPrivacyMetadata,
    prewarmProver,
    prepareAnonymousTicket,
    consumePreparedTicket,
    purge,
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

function cloneCredentialMaterial(material: CommentPrivacyCredentialMaterial): CommentPrivacyCredentialMaterial {
  return {
    credentialSecret: new Uint8Array(material.credentialSecret),
    credentialCommitment: new Uint8Array(material.credentialCommitment),
    issuerSignature: new Uint8Array(material.issuerSignature),
    revocationWitness: new Uint8Array(material.revocationWitness),
    revocationHandleHash: material.revocationHandleHash ? new Uint8Array(material.revocationHandleHash) : undefined,
    credentialLevel: material.credentialLevel,
    reputationBucket: material.reputationBucket
  }
}

function zeroizeCredentialMaterial(material: CommentPrivacyCredentialMaterial | null): void {
  if (!material) return
  zeroizeCommentPrivacyBytes(material.credentialSecret)
  zeroizeCommentPrivacyBytes(material.credentialCommitment)
  zeroizeCommentPrivacyBytes(material.issuerSignature)
  zeroizeCommentPrivacyBytes(material.revocationWitness)
  zeroizeCommentPrivacyBytes(material.revocationHandleHash)
}

function zeroizeMetadata(metadata: CommentPrivacyMetadata): void {
  zeroizeCommentPrivacyBytes(metadata.metadataBytes)
  zeroizeCommentPrivacyBytes(metadata.credentialRoot)
  zeroizeCommentPrivacyBytes(metadata.revocationRoot)
  zeroizeCommentPrivacyBytes(metadata.circuitMetadata)
}

function zeroizePreparedTicket(ticket: CommentPrivacyPreparedTicket | null | undefined): void {
  zeroizeCommentPrivacyBytes(ticket?.ticket)
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

function attachCredentialMaterial(
  metadata: CommentPrivacyMetadata,
  credential: CommentPrivacyCredentialMaterial | null
): CommentPrivacyMetadata {
  if (!credential) {
    return metadata
  }

  return {
    ...metadata,
    credentialLevel: credential.credentialLevel || metadata.credentialLevel,
    reputationBucket: credential.reputationBucket || metadata.reputationBucket
  }
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
