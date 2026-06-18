import type { CommentPrivacyProofRequest, CommentPrivacyWorkerClient } from './commentPrivacyTypes'

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
      if (!response.ok) {
        current.reject(new Error(response.error))
        return
      }

      current.resolve(response.type === 'proof' ? response.proofBytes : undefined)
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
      current.reject(reason)
    }
    pending.clear()
  }

  const postMessage = <T>(message: CommentPrivacyWorkerRequest, transfer: Transferable[] = []): Promise<T> => {
    const activeWorker = ensureWorker()
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(message.requestId)
        reject(new Error('comment_privacy_worker_timeout'))
      }, timeoutMs)
      pending.set(message.requestId, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeoutId
      })
      activeWorker.postMessage(message, transfer)
    })
  }

  const post = <T>(message: CommentPrivacyWorkerPostPayload, transfer: Transferable[] = []): Promise<T> => {
    const id = ++requestId
    return postMessage<T>({ v: 1, requestId: id, ...message } as CommentPrivacyWorkerRequest, transfer)
  }

  return {
    prewarm(signal) {
      if (signal?.aborted) {
        return Promise.resolve()
      }
      return post<void>({ type: 'prewarm' })
    },
    prepareProof(request: CommentPrivacyProofRequest) {
      if (request.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }

      const metadataBytes = copyToTransferableBuffer(request.metadataBytes)
      return post<Uint8Array>({
        type: 'prepareProof',
        scope: request.scope,
        rootVersion: request.rootVersion,
        metadataBytes
      }, [metadataBytes])
    },
    dispose() {
      rejectAll(new Error('comment_privacy_worker_disposed'))
      worker?.terminate()
      worker = null
    }
  }
}

function copyToTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}
