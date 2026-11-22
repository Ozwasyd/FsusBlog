import { WireLayouts } from '../../Contracts/wire.generated.ts'

export const metadataStore = 'metadata'
export const pageStore = 'pages'
export const stateKey = 'corpus'
export const minimumPageBytes = WireLayouts.SearchPackagePayloadOffset + WireLayouts.SearchShardHeaderSize
const generationPattern = /^(0|[1-9][0-9]{0,18})$/
const maxInt64 = 9_223_372_036_854_775_807n

export function isAvailable(kind: 'compact' | 'wide'): boolean {
  try {
    return globalThis.isSecureContext &&
      typeof globalThis.indexedDB?.open === 'function' &&
      typeof globalThis.navigator?.locks?.request === 'function' &&
      (kind === 'compact' || typeof globalThis.crypto?.randomUUID === 'function') &&
      typeof globalThis.crypto?.subtle?.digest === 'function'
  } catch {
    return false
  }
}

export function isFixedBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer && (!('resizable' in value) || value.resizable === false)
}

export function validGeneration(value: unknown): value is string {
  return typeof value === 'string' && generationPattern.test(value) && BigInt(value) <= maxInt64
}

export function open(
  databaseName: string,
  signal: AbortSignal | undefined,
  blockedError: () => Error,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      reject(error)
    }
    const cancel = () => fail(signal?.reason)
    request.onupgradeneeded = () => {
      if (settled || signal?.aborted) {
        request.transaction?.abort()
        return
      }
      request.result.createObjectStore(metadataStore)
      request.result.createObjectStore(pageStore)
    }
    request.onblocked = () => fail(blockedError())
    request.onerror = () => fail(request.error)
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      signal?.removeEventListener('abort', cancel)
      resolve(request.result)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}
