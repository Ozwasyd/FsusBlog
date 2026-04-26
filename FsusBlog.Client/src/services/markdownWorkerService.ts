import type { MarkdownRenderRequest } from '@wasm/markdown'

type PendingRequest = {
  resolve: (value: string) => void
  reject: (error: unknown) => void
  release: () => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

type WorkerSuccessMessage = {
  id: number
  html: string
}

let sharedWorker: Worker | null = null
let requestSeq = 0
const pending = new Map<number, PendingRequest>()
let retainCount = 0
let idleTerminateTimer: ReturnType<typeof setTimeout> | null = null

const IDLE_TERMINATE_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

function clearIdleTerminateTimer(): void {
  if (!idleTerminateTimer) {
    return
  }

  clearTimeout(idleTerminateTimer)
  idleTerminateTimer = null
}

function destroyWorker(reason: unknown = new Error('markdown worker destroyed')): void {
  if (!sharedWorker) {
    return
  }

  sharedWorker.onmessage = null
  sharedWorker.onerror = null
  sharedWorker.terminate()
  sharedWorker = null

  pending.forEach((entry) => {
    try {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId)
        entry.timeoutId = null
      }
      entry.reject(reason)
    } finally {
      entry.release()
    }
  })
  pending.clear()
}

function settlePendingRequest(id: number, action: (entry: PendingRequest) => void): void {
  const entry = pending.get(id)
  if (!entry) {
    return
  }

  pending.delete(id)
  try {
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId)
      entry.timeoutId = null
    }
    action(entry)
  } finally {
    entry.release()
  }
}

function scheduleIdleTerminate(): void {
  if (retainCount > 0) {
    return
  }

  clearIdleTerminateTimer()
  idleTerminateTimer = setTimeout(() => {
    if (retainCount === 0) {
      destroyWorker(new Error('markdown worker idle timeout'))
    }
    idleTerminateTimer = null
  }, IDLE_TERMINATE_MS)
}

function ensureWorker(): Worker {
  clearIdleTerminateTimer()

  if (sharedWorker) {
    return sharedWorker
  }

  sharedWorker = new Worker(new URL('@/workers/markdown.worker.ts', import.meta.url), { type: 'module' })

  sharedWorker.onmessage = (event: MessageEvent<WorkerSuccessMessage>) => {
    const { id, html } = event.data
    settlePendingRequest(id, (entry) => entry.resolve(html))
  }

  sharedWorker.onerror = (error: ErrorEvent) => {
    const reason = error.error ?? new Error(error.message || 'markdown worker error')
    destroyWorker(reason)
  }

  return sharedWorker
}

export function retainMarkdownWorker(): () => void {
  retainCount += 1
  clearIdleTerminateTimer()
  ensureWorker()

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    retainCount = Math.max(0, retainCount - 1)
    scheduleIdleTerminate()
  }
}

export function renderMarkdownInWorker(request: MarkdownRenderRequest | string): Promise<string> {
  const release = retainMarkdownWorker()
  const worker = ensureWorker()
  const id = ++requestSeq
  const payload = typeof request === 'string' ? { source: request } : request

  return new Promise<string>((resolve, reject) => {
    let released = false
    const releaseOnce = () => {
      if (released) {
        return
      }
      released = true
      release()
    }

    const timeoutId = setTimeout(() => {
      settlePendingRequest(id, (entry) => {
        const timeoutError = new Error('markdown worker request timed out')
        entry.reject(timeoutError)
        destroyWorker(timeoutError)
      })
    }, REQUEST_TIMEOUT_MS)

    pending.set(id, { resolve, reject, release: releaseOnce, timeoutId })

    try {
      worker.postMessage({ id, ...payload })
    } catch (error) {
      settlePendingRequest(id, (entry) => entry.reject(error))
    }
  })
}
