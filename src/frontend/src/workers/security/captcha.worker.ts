import {
  loadCaptchaRuntime,
  parseCaptchaIssuePayload,
  renderCaptchaRaster,
  solveCaptchaProof,
  type CaptchaRaster
} from '../../../wasm/security/captcha'

type CaptchaWorkerRequest =
  | {
      v: 1
      type: 'render'
      requestId: number
      payload: Record<string, unknown>
      forceCanvasFallback?: boolean
      forceWasmFailure?: boolean
    }
  | {
      v: 1
      type: 'solve'
      requestId: number
      payload: Record<string, unknown>
      answerText: string
      forceWasmFailure?: boolean
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

const ctx = self as DedicatedWorkerGlobalScope

ctx.onmessage = async (event: MessageEvent<CaptchaWorkerRequest>) => {
  const request = event.data
  if (!request || request.v !== 1) {
    return
  }

  try {
    await loadCaptchaRuntime({ forceFailure: request.forceWasmFailure })
    const parsed = parseCaptchaIssuePayload(request.payload)
    if (request.type === 'render') {
      const raster = renderCaptchaRaster(parsed, {
        forceCanvasFallback: request.forceCanvasFallback
      })
      const response: CaptchaWorkerResponse = {
        v: 1,
        type: 'rendered',
        requestId: request.requestId,
        ok: true,
        raster
      }
      ctx.postMessage(response, [raster.pixels.buffer])
      return
    }

    const proof = await solveCaptchaProof(parsed, request.answerText)
    const response: CaptchaWorkerResponse = {
      v: 1,
      type: 'solved',
      requestId: request.requestId,
      ok: true,
      nonceHex: proof.nonceHex,
      responseTokenHex: proof.responseTokenHex,
      durationMs: proof.durationMs
    }
    ctx.postMessage(response)
  } catch (error) {
    const response: CaptchaWorkerResponse = {
      v: 1,
      type: 'error',
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'captcha_worker_failed'
    }
    ctx.postMessage(response)
  }
}
