import { AppErrorCode, createAppError } from '@/utils/appError'
import type { CaptchaRaster } from '@/../wasm/security/captcha'

export interface CaptchaWorkerSolveResult {
  nonceHex: string
  responseTokenHex: string
  durationMs: number
}

export interface CaptchaWorkerClient {
  render(payload: Record<string, unknown>, options?: { forceCanvasFallback?: boolean; forceWasmFailure?: boolean }): Promise<CaptchaRaster>
  solve(payload: Record<string, unknown>, answerText: string, options?: { forceWasmFailure?: boolean }): Promise<CaptchaWorkerSolveResult>
  dispose(): void
}

type CaptchaWorkerResponse =
  | {
      v: 1
      type: 'rendered'
      requestId: number
      ok: true
      raster: CaptchaRaster
    }
  | {
      v: 1
      type: 'solved'
      requestId: number
      ok: true
      nonceHex: string
      responseTokenHex: string
      durationMs: number
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

const DEFAULT_TIMEOUT_MS = 15000

export function createCaptchaWorkerClient(timeoutMs = DEFAULT_TIMEOUT_MS): CaptchaWorkerClient {
  let worker: Worker | null = null
  let requestId = 0
  const pending = new Map<number, PendingRequest>()

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker
    }
    if (typeof Worker === 'undefined') {
      throw createAppError(AppErrorCode.InfraFailure, 'captcha_worker_unavailable')
    }

    worker = new Worker(new URL('../workers/security/captcha.worker.ts', import.meta.url), {
      name: 'FsusCaptchaWorker',
      type: 'module'
    })
    worker.onmessage = (event: MessageEvent<CaptchaWorkerResponse>) => {
      const response = event.data
      const current = pending.get(response.requestId)
      if (!current) {
        return
      }
      pending.delete(response.requestId)
      clearTimeout(current.timeoutId)

      if (!response.ok) {
        current.reject(createAppError(AppErrorCode.InfraFailure, response.error))
        return
      }
      current.resolve(response.type === 'rendered'
        ? response.raster
        : {
            nonceHex: response.nonceHex,
            responseTokenHex: response.responseTokenHex,
            durationMs: response.durationMs
          })
    }
    worker.onerror = () => {
      for (const current of pending.values()) {
        clearTimeout(current.timeoutId)
        current.reject(createAppError(AppErrorCode.InfraFailure, 'captcha_worker_failed'))
      }
      pending.clear()
      worker?.terminate()
      worker = null
    }
    return worker
  }

  const post = <T>(message: Record<string, unknown>): Promise<T> => {
    const activeWorker = ensureWorker()
    const id = ++requestId
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id)
        reject(createAppError(AppErrorCode.Timeout, 'captcha_worker_timeout'))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeoutId
      })
      activeWorker.postMessage({ v: 1, requestId: id, ...message })
    })
  }

  return {
    render(payload, options) {
      return post<CaptchaRaster>({
        type: 'render',
        payload,
        forceCanvasFallback: options?.forceCanvasFallback,
        forceWasmFailure: options?.forceWasmFailure
      })
    },
    solve(payload, answerText, options) {
      return post<CaptchaWorkerSolveResult>({
        type: 'solve',
        payload,
        answerText,
        forceWasmFailure: options?.forceWasmFailure
      })
    },
    dispose() {
      for (const current of pending.values()) {
        clearTimeout(current.timeoutId)
        current.reject(createAppError(AppErrorCode.InfraFailure, 'captcha_worker_disposed'))
      }
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
}
