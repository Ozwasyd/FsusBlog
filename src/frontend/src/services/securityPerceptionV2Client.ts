import type {
  PerceptionV2RenderPayload,
  PerceptionV2WorkerRequest,
  PerceptionV2WorkerResponse,
  RenderRecipeV2
} from '@/workers/security/perception-v2.renderer'
import { toTrustedApplicationWorkerScriptUrl } from '@/security/trustedTypesRuntime'
import perceptionV2WorkerUrl from '@/workers/security/perception-v2.worker.ts?worker&url'

export type PerceptionV2ClientRenderSuccess = {
  ok: true
  renderer: 'offscreen-canvas' | 'canvas-fallback'
  result: PerceptionV2RenderPayload
}

export type PerceptionV2ClientRenderError = {
  ok: false
  error: string
}

export type PerceptionV2ClientRenderResult = PerceptionV2ClientRenderSuccess | PerceptionV2ClientRenderError

export interface PerceptionV2WorkerClient {
  render(recipe: RenderRecipeV2, options?: { forceCanvasFallback?: boolean; forceWorkerFailure?: boolean }): Promise<PerceptionV2ClientRenderResult>
  dispose(): void
}

export interface PerceptionV2WorkerClientOptions {
  timeoutMs?: number
  workerFactory?: () => Worker
}

type PendingRequest = {
  resolve: (value: PerceptionV2ClientRenderResult) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 15_000

export function createPerceptionV2WorkerClient(options: PerceptionV2WorkerClientOptions = {}): PerceptionV2WorkerClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let worker: Worker | null = null
  let requestId = 0
  const pending = new Map<number, PendingRequest>()

  const ensureWorker = (): Worker | PerceptionV2ClientRenderError => {
    if (worker) {
      return worker
    }

    try {
      if (typeof Worker === 'undefined' && !options.workerFactory) {
        return { ok: false, error: 'perception_v2_worker_unavailable' }
      }

      worker = options.workerFactory
        ? options.workerFactory()
        : new Worker(toTrustedApplicationWorkerScriptUrl(
            new URL(perceptionV2WorkerUrl, import.meta.url)
          ) as string | URL, {
            name: 'FsusPerceptionV2Worker',
            type: 'module'
          })
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error && error.message ? error.message : 'perception_v2_worker_init_failed'
      }
    }

    worker.onmessage = (event: MessageEvent<PerceptionV2WorkerResponse>) => {
      const response = event.data
      const current = pending.get(response.requestId)
      if (!current) {
        return
      }

      pending.delete(response.requestId)
      clearTimeout(current.timeoutId)
      current.resolve(toRenderResult(response))
    }
    worker.onerror = (event) => {
      const error = event instanceof ErrorEvent && event.message ? event.message : 'perception_v2_worker_init_failed'
      resolveAll({ ok: false, error })
      worker?.terminate()
      worker = null
    }
    worker.onmessageerror = () => {
      resolveAll({ ok: false, error: 'perception_v2_worker_message_error' })
      worker?.terminate()
      worker = null
    }

    return worker
  }

  const resolveAll = (value: PerceptionV2ClientRenderError): void => {
    for (const current of pending.values()) {
      clearTimeout(current.timeoutId)
      current.resolve(value)
    }
    pending.clear()
  }

  const resetWorker = (value: PerceptionV2ClientRenderError): void => {
    resolveAll(value)
    worker?.terminate()
    worker = null
  }

  return {
    render(recipe, options) {
      const activeWorker = ensureWorker()
      if (!isWorker(activeWorker)) {
        return Promise.resolve(activeWorker)
      }

      const id = ++requestId
      const request: PerceptionV2WorkerRequest = {
        v: 1,
        type: 'render',
        requestId: id,
        recipe,
        forceCanvasFallback: options?.forceCanvasFallback,
        forceWorkerFailure: options?.forceWorkerFailure
      }

      return new Promise<PerceptionV2ClientRenderResult>((resolve) => {
        const timeoutId = setTimeout(() => {
          if (!pending.has(id)) {
            return
          }
          resetWorker({ ok: false, error: 'perception_v2_worker_timeout' })
        }, timeoutMs)
        pending.set(id, { resolve, timeoutId })
        try {
          activeWorker.postMessage(request)
        } catch (error) {
          resetWorker({
            ok: false,
            error: error instanceof Error && error.message ? error.message : 'perception_v2_worker_post_failed'
          })
        }
      })
    },
    dispose() {
      resolveAll({ ok: false, error: 'perception_v2_worker_disposed' })
      worker?.terminate()
      worker = null
    }
  }
}

function toRenderResult(response: PerceptionV2WorkerResponse): PerceptionV2ClientRenderResult {
  if (!response.ok) {
    return { ok: false, error: response.error }
  }

  return {
    ok: true,
    renderer: response.renderer,
    result: response.result
  }
}

function isWorker(value: Worker | PerceptionV2ClientRenderError): value is Worker {
  return Boolean(value)
    && typeof value === 'object'
    && 'postMessage' in value
    && typeof (value as Worker).postMessage === 'function'
    && 'terminate' in value
    && typeof (value as Worker).terminate === 'function'
}
