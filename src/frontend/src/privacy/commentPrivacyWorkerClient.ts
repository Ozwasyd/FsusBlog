import type { CommentPrivacyProofBundle, CommentPrivacyProofRequest, CommentPrivacyRevocationWorkerRequest, CommentPrivacyRevocationWorkerResult, CommentPrivacyWorkerClient } from './commentPrivacyTypes'
import { registerCommentPrivacyCredentialPurgeHandler } from './commentPrivacyCredentialLifecycle'

type CommentPrivacyWorkerRequest =
  | {
      v: 1
      type: 'prewarm'
      requestId: number
    }
  | {
      v: 1
      type: 'buildRevocationWitness'
      requestId: number
      artifact: Omit<CommentPrivacyRevocationWorkerRequest['artifact'], 'revocationRoot' | 'contentHash' | 'signature' | 'entryHashes'> & {
        revocationRoot: ArrayBuffer
        contentHash: ArrayBuffer
        signature: ArrayBuffer
        entryHashes: ArrayBuffer
      }
      baseEntryHashes?: ArrayBuffer
      revocationHandleHash: ArrayBuffer
      expectedEpoch: number
      expectedVersion: number
      expectedIssuerPublicKeyHash: string
      expectedRevocationRoot: ArrayBuffer
      nowUnixMs: number
      maxCpuMs: number
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
      verifyingKeyHash?: string
      issuerPublicKeyHash?: string
      policyHash?: string
      credentialCommitment?: ArrayBuffer
      credentialRoot?: ArrayBuffer
      revocationRoot?: ArrayBuffer
      circuitMetadata?: ArrayBuffer
      credentialLevel?: string
      reputationBucket?: string
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
      type: 'revocationWitness'
      requestId: number
      ok: true
      witness: Uint8Array
      entryHashes: Uint8Array
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
      verifyingKeyHash?: string
      issuerPublicKeyHash?: string
      policyHash?: string
      credentialCommitment?: ArrayBuffer
      credentialRoot?: ArrayBuffer
      revocationRoot?: ArrayBuffer
      circuitMetadata?: ArrayBuffer
      credentialLevel?: string
      reputationBucket?: string
      credentialSecret?: ArrayBuffer
      issuerSignature?: ArrayBuffer
      revocationWitness?: ArrayBuffer
    }
  | Omit<Extract<CommentPrivacyWorkerRequest, { type: 'buildRevocationWitness' }>, 'v' | 'requestId'>

export interface CommentPrivacyWorkerClientOptions {
  timeoutMs?: number
  workerFactory?: () => Worker
}

const DEFAULT_TIMEOUT_MS = 30_000

let singleton: CommentPrivacyWorkerClient | null = null
let unregisterSingletonPurgeHandler: (() => void) | null = null

export function getCommentPrivacyWorkerClient(): CommentPrivacyWorkerClient {
  if (!singleton) {
    singleton = createCommentPrivacyWorkerClient()
    unregisterSingletonPurgeHandler = registerCommentPrivacyCredentialPurgeHandler(() => singleton?.dispose())
  }

  return singleton
}

export function resetCommentPrivacyWorkerClientForTests(): void {
  unregisterSingletonPurgeHandler?.()
  unregisterSingletonPurgeHandler = null
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
        : response.type === 'revocationWitness'
        ? { witness: response.witness, entryHashes: response.entryHashes }
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
    buildRevocationWitness(request: CommentPrivacyRevocationWorkerRequest) {
      const transfers: Transferable[] = []
      return post<CommentPrivacyRevocationWorkerResult>({
        type: 'buildRevocationWitness',
        artifact: {
          ...request.artifact,
          revocationRoot: copyToTransferableBuffer(request.artifact.revocationRoot, transfers),
          contentHash: copyToTransferableBuffer(request.artifact.contentHash, transfers),
          signature: copyToTransferableBuffer(request.artifact.signature, transfers),
          entryHashes: copyToTransferableBuffer(request.artifact.entryHashes, transfers)
        },
        baseEntryHashes: copyOptionalToTransferableBuffer(request.baseEntryHashes, transfers),
        revocationHandleHash: copyToTransferableBuffer(request.revocationHandleHash, transfers),
        expectedEpoch: request.expectedEpoch,
        expectedVersion: request.expectedVersion,
        expectedIssuerPublicKeyHash: request.expectedIssuerPublicKeyHash,
        expectedRevocationRoot: copyToTransferableBuffer(request.expectedRevocationRoot, transfers),
        nowUnixMs: request.nowUnixMs,
        maxCpuMs: request.maxCpuMs
      }, transfers, request.signal)
    },
    prepareProof(request: CommentPrivacyProofRequest) {
      if (request.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }

      const transfers: Transferable[] = []
      const metadataBytes = copyToTransferableBuffer(request.metadataBytes, transfers)
      const credentialCommitment = copyOptionalToTransferableBuffer(request.credentialCommitment, transfers)
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
        verifyingKeyHash: request.verifyingKeyHash,
        issuerPublicKeyHash: request.issuerPublicKeyHash,
        policyHash: request.policyHash,
        credentialCommitment,
        credentialRoot,
        revocationRoot,
        circuitMetadata,
        credentialLevel: request.credentialLevel,
        reputationBucket: request.reputationBucket,
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
