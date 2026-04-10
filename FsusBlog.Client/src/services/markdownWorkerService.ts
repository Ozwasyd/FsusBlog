import type { MarkdownRenderRequest } from '@wasm/markdown'

type PendingRequest = {
  resolve: (value: string) => void
  reject: (error: unknown) => void
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

  sharedWorker.terminate()
  sharedWorker = null

  pending.forEach((entry) => entry.reject(reason))
  pending.clear()
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
    const entry = pending.get(id)
    if (!entry) {
      return
    }

    pending.delete(id)
    entry.resolve(html)
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
  const worker = ensureWorker()
  const id = ++requestSeq
  const payload = typeof request === 'string' ? { source: request } : request

  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, ...payload })
  })
}
