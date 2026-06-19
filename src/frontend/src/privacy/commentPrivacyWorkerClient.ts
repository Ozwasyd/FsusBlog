import type { CommentPrivacyProofBundle, CommentPrivacyProofRequest, CommentPrivacyWorkerClient } from './commentPrivacyTypes'

type CommentPrivacyWorkerRequest =
  | {
      v: 1
      type: 'prewarm'
      requestId: number
    }
  | {
      v: 1
      type: 'prepareProof'
      requestId: number
      scope: string
      rootVersion: string
      metadataBytes: ArrayBuffer
      credentialEpoch?: number
      circuitNumericId?: number
      publicInputLayoutVersion?: number
      circuitId?: string
      credentialRoot?: ArrayBuffer
      revocationRoot?: ArrayBuffer
      circuitMetadata?: ArrayBuffer
      credentialSecret?: ArrayBuffer
      issuerSignature?: ArrayBuffer
      revocationWitness?: ArrayBuffer
    }

type CommentPrivacyWorkerResponse =
  | {
      v: 1
      type: 'prewarmed'
      requestId: number
      ok: true
    }
  | {
      v: 1
      type: 'proof'
      requestId: number
      ok: true
      proofBytes: Uint8Array
      publicInputs: Uint8Array
      nullifierHash: Uint8Array
    }
  | {
      v: 1
      type: 'error'
      requestId: number
      ok: false
      error: string
    }

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeoutId: ReturnType<typeof setTimeout>
  abortCleanup?: () => void
}

type CommentPrivacyWorkerPostPayload =
  | {
      type: 'prewarm'
    }
  | {
      type: 'prepareProof'
      scope: string
      rootVersion: string
      metadataBytes: ArrayBuffer
      credentialEpoch?: number
      circuitNumericId?: number
      publicInputLayoutVersion?: number
      circuitId?: string
      credentialRoot?: ArrayBuffer
      revocationRoot?: ArrayBuffer
      circuitMetadata?: ArrayBuffer
      credentialSecret?: ArrayBuffer
      issuerSignature?: ArrayBuffer
      revocationWitness?: ArrayBuffer
    }

export interface CommentPrivacyWorkerClientOptions {
  timeoutMs?: number
  workerFactory?: () => Worker
}

const DEFAULT_TIMEOUT_MS = 30_000

let singleton: CommentPrivacyWorkerClient | null = null

export function getCommentPrivacyWorkerClient(): CommentPrivacyWorkerClient {
  if (!singleton) {
    singleton = createCommentPrivacyWorkerClient()
  }

  return singleton
}

export function resetCommentPrivacyWorkerClientForTests(): void {
  singleton?.dispose()
  singleton = null
}

export function createCommentPrivacyWorkerClient(options: CommentPrivacyWorkerClientOptions = {}): CommentPrivacyWorkerClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let worker: Worker | null = null
  let requestId = 0
  const pending = new Map<number, PendingRequest>()

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker
    }
    if (typeof Worker === 'undefined' && !options.workerFactory) {
      throw new Error('comment_privacy_worker_unavailable')
    }

    worker = options.workerFactory
      ? options.workerFactory()
      : new Worker(new URL('../workers/privacy/commentPrivacy.worker.ts', import.meta.url), {
          name: 'FsusCommentPrivacyWorker',
          type: 'module'
        })
    worker.onmessage = (event: MessageEvent<CommentPrivacyWorkerResponse>) => {
      const response = event.data
      const current = pending.get(response.requestId)
      if (!current) {
        return
      }

      pending.delete(response.requestId)
      clearTimeout(current.timeoutId)
      current.abortCleanup?.()
      if (!response.ok) {
        current.reject(new Error(response.error))
        return
      }

      current.resolve(response.type === 'proof'
        ? {
            proofBytes: response.proofBytes,
            publicInputs: response.publicInputs,
            nullifierHash: response.nullifierHash
          }
        : undefined)
    }
    worker.onerror = (event) => {
      const error = event instanceof ErrorEvent && event.message ? event.message : 'comment_privacy_worker_failed'
      rejectAll(new Error(error))
      worker?.terminate()
      worker = null
    }
    return worker
  }

  const rejectAll = (reason: unknown): void => {
    for (const current of pending.values()) {
      clearTimeout(current.timeoutId)
      current.abortCleanup?.()
      current.reject(reason)
    }
    pending.clear()
  }

  const postMessage = <T>(message: CommentPrivacyWorkerRequest, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> => {
    const activeWorker = ensureWorker()
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }

      let abortCleanup: (() => void) | undefined
      let timeoutId: ReturnType<typeof setTimeout>
      const abortHandler = (): void => {
        pending.delete(message.requestId)
        clearTimeout(timeoutId)
        abortCleanup?.()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      timeoutId = setTimeout(() => {
        pending.delete(message.requestId)
        abortCleanup?.()
        reject(new Error('comment_privacy_worker_timeout'))
      }, timeoutMs)
      abortCleanup = signal
        ? () => signal.removeEventListener('abort', abortHandler)
        : undefined
      pending.set(message.requestId, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeoutId,
        abortCleanup
      })
      signal?.addEventListener('abort', abortHandler, { once: true })
      activeWorker.postMessage(message, transfer)
    })
  }

  const post = <T>(message: CommentPrivacyWorkerPostPayload, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> => {
    const id = ++requestId
    return postMessage<T>({ v: 1, requestId: id, ...message } as CommentPrivacyWorkerRequest, transfer, signal)
  }

  return {
    prewarm(signal) {
      if (signal?.aborted) {
        return Promise.resolve()
      }
      return post<void>({ type: 'prewarm' }, [], signal)
    },
    prepareProof(request: CommentPrivacyProofRequest) {
      if (request.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }

      const transfers: Transferable[] = []
      const metadataBytes = copyToTransferableBuffer(request.metadataBytes, transfers)
      const credentialRoot = copyOptionalToTransferableBuffer(request.credentialRoot, transfers)
      const revocationRoot = copyOptionalToTransferableBuffer(request.revocationRoot, transfers)
      const circuitMetadata = copyOptionalToTransferableBuffer(request.circuitMetadata, transfers)
      const credentialSecret = copyOptionalToTransferableBuffer(request.credentialSecret, transfers)
      const issuerSignature = copyOptionalToTransferableBuffer(request.issuerSignature, transfers)
      const revocationWitness = copyOptionalToTransferableBuffer(request.revocationWitness, transfers)
      return post<CommentPrivacyProofBundle>({
        type: 'prepareProof',
        scope: request.scope,
        rootVersion: request.rootVersion,
        metadataBytes,
        credentialEpoch: request.credentialEpoch,
        circuitNumericId: request.circuitNumericId,
        publicInputLayoutVersion: request.publicInputLayoutVersion,
        circuitId: request.circuitId,
        credentialRoot,
        revocationRoot,
        circuitMetadata,
        credentialSecret,
        issuerSignature,
        revocationWitness
      }, transfers, request.signal)
    },
    dispose() {
      rejectAll(new Error('comment_privacy_worker_disposed'))
      worker?.terminate()
      worker = null
    }
  }
}

function copyToTransferableBuffer(bytes: Uint8Array, transfers: Transferable[]): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  transfers.push(buffer)
  return buffer
}

function copyOptionalToTransferableBuffer(bytes: Uint8Array | undefined, transfers: Transferable[]): ArrayBuffer | undefined {
  return bytes ? copyToTransferableBuffer(bytes, transfers) : undefined
}
