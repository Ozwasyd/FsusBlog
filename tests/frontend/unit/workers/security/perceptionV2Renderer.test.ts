import { assert, describe, expect, it } from 'vitest'
import {
  handlePerceptionV2WorkerRequest,
  renderPerceptionRecipeV2,
  type PerceptionV2RenderEnvironment,
  type PerceptionV2WorkerRequest,
  type PerceptionV2WorkerResponse,
  type RenderRecipeV2
} from '@/workers/security/perception-v2.renderer'
import { createPerceptionV2WorkerClient } from '@/services/securityPerceptionV2Client'

const completeRecipe: RenderRecipeV2 = {
  v: 2,
  width: 64,
  height: 40,
  background: '#101820',
  layers: [
    { kind: 'rect', x: 4, y: 5, width: 24, height: 10, color: '#dfe7fd', alpha: 0.88 },
    { kind: 'ellipse', x: 30, y: 10, radiusX: 12, radiusY: 7, color: '#2fbf71', alpha: 0.78 }
  ],
  strokeSegments: [
    {
      points: [
        { x: 6, y: 28 },
        { x: 20, y: 18 },
        { x: 44, y: 26 },
        { x: 58, y: 12 }
      ],
      width: 3,
      color: '#f7b32b',
      alpha: 0.9
    }
  ],
  noiseFields: [
    { seed: 9127, density: 0.2, alpha: 0.18, color: '#ffffff', cellSize: 2 }
  ],
  warpFields: [
    { seed: 37, amplitude: 2.4, frequency: 0.16, axis: 'x' }
  ],
  occluders: [
    { kind: 'rect', x: 38, y: 24, width: 18, height: 7, color: '#05070a', alpha: 0.7 }
  ],
  presentationHints: {
    taskKind: 'localization'
  }
}

describe('PerceptionV2 worker renderer core', () => {
  it('uses OffscreenCanvas transfer output when the worker runtime supports it', async () => {
    const bitmap: ImageBitmap = { width: 64, height: 40, close: () => undefined }
    const result = await renderPerceptionRecipeV2(completeRecipe, {
      createOffscreenCanvas: () => createFakeCanvas(bitmap)
    })

    expect(result.renderer).toBe('offscreen-canvas')
    expect(result.width).toBe(64)
    expect(result.height).toBe(40)
    expect(result.payload.kind).toBe('bitmap')
    expect(result.transfer).toEqual([bitmap])
  })

  it('falls back to transferable RGBA pixels when OffscreenCanvas is unavailable', async () => {
    const result = await renderPerceptionRecipeV2(completeRecipe, {
      createOffscreenCanvas: undefined
    })

    expect(result.renderer).toBe('canvas-fallback')
    expect(result.payload.kind).toBe('rgba-raster')
    assert(result.payload.kind === 'rgba-raster')
    expect(result.payload.width).toBe(64)
    expect(result.payload.height).toBe(40)
    expect(result.payload.pixels).toBeInstanceOf(Uint8ClampedArray)
    expect(result.payload.pixels.some((value) => value !== 0)).toBe(true)
    expect(result.transfer).toEqual([result.payload.pixels.buffer])
  })

  it('renders shared localization and micro-interaction recipes without semantic ids', async () => {
    for (const taskKind of ['localization', 'micro-interaction'] as const) {
      const recipe = {
        ...completeRecipe,
        presentationHints: { taskKind }
      }
      expect(JSON.stringify(recipe)).not.toMatch(/glyphIds|charIds/)

      const result = await renderPerceptionRecipeV2(recipe, {
        createOffscreenCanvas: undefined
      })

      expect(result.payload.kind).toBe('rgba-raster')
      assert(result.payload.kind === 'rgba-raster')
      expect(checksum(result.payload.pixels)).toBeGreaterThan(0)
    }
  })

  it('makes layers, stroke segments, noise, warp, and occluders visible in the raster output', async () => {
    const full = await renderPerceptionRecipeV2(completeRecipe, { createOffscreenCanvas: undefined })
    const withoutVisualFields = await renderPerceptionRecipeV2(
      {
        v: 2,
        width: completeRecipe.width,
        height: completeRecipe.height,
        background: completeRecipe.background
      },
      { createOffscreenCanvas: undefined }
    )

    expect(full.payload.kind).toBe('rgba-raster')
    expect(withoutVisualFields.payload.kind).toBe('rgba-raster')
    assert(full.payload.kind === 'rgba-raster')
    assert(withoutVisualFields.payload.kind === 'rgba-raster')
    expect(checksum(full.payload.pixels)).not.toBe(checksum(withoutVisualFields.payload.pixels))
  })

  it('returns recoverable worker errors for initialization or recipe failures', async () => {
    const forced = await handlePerceptionV2WorkerRequest({
      v: 1,
      type: 'render',
      requestId: 7,
      recipe: completeRecipe,
      forceWorkerFailure: true
    })

    expect(forced?.response).toMatchObject({
      v: 1,
      type: 'error',
      requestId: 7,
      ok: false,
      error: 'perception_v2_forced_worker_failure'
    })
    expect(forced?.transfer).toEqual([])

    const invalid = await handlePerceptionV2WorkerRequest({
      v: 1,
      type: 'render',
      requestId: 8,
      recipe: { v: 2, width: 2048, height: 40 }
    })

    expect(invalid?.response).toMatchObject({
      v: 1,
      type: 'error',
      requestId: 8,
      ok: false
    })
    expect(invalid?.response.type === 'error' ? invalid.response.error : '').toContain('perception_v2_invalid_dimensions')
  })

  it('rejects semantic answer fields in render-only recipes', async () => {
    const result = await handlePerceptionV2WorkerRequest({
      v: 1,
      type: 'render',
      requestId: 9,
      recipe: {
        ...completeRecipe,
        expectedPoint: { x: 0.25, y: 0.75 }
      }
    })

    expect(result?.response).toMatchObject({
      v: 1,
      type: 'error',
      requestId: 9,
      ok: false
    })
    expect(result?.response.type === 'error' ? result.response.error : '').toContain('perception_v2_semantic_field_forbidden')
  })

  it('returns a recoverable result when worker initialization fails', async () => {
    const client = createPerceptionV2WorkerClient({
      workerFactory: () => {
        throw new Error('perception_v2_worker_init_failed')
      }
    })

    await expect(client.render(completeRecipe)).resolves.toEqual({
      ok: false,
      error: 'perception_v2_worker_init_failed'
    })
  })

  it('supports injected worker factories without a global Worker constructor', async () => {
    const worker = new FakePerceptionWorker((message) => ({
      v: 1,
      type: 'rendered',
      requestId: Number(message.requestId),
      ok: true,
      renderer: 'canvas-fallback',
      result: {
        kind: 'rgba-raster',
        width: 1,
        height: 1,
        pixels: new Uint8ClampedArray([1, 2, 3, 255])
      }
    }))
    const client = createPerceptionV2WorkerClient({
      workerFactory: () => worker.asWorker()
    })

    await expect(client.render(completeRecipe)).resolves.toMatchObject({
      ok: true,
      renderer: 'canvas-fallback'
    })
    expect(worker.posted).toHaveLength(1)
  })

  it('returns recoverable errors for postMessage failures and worker timeouts', async () => {
    const throwingWorker = new FakePerceptionWorker(() => {
      throw new DOMException('clone failed', 'DataCloneError')
    })
    const postFailureClient = createPerceptionV2WorkerClient({
      workerFactory: () => throwingWorker.asWorker()
    })

    await expect(postFailureClient.render(completeRecipe)).resolves.toMatchObject({
      ok: false,
      error: 'clone failed'
    })
    expect(throwingWorker.terminated).toBe(true)

    const workers = [
      new FakePerceptionWorker(() => undefined),
      new FakePerceptionWorker((message) => ({
        v: 1,
        type: 'rendered',
        requestId: Number(message.requestId),
        ok: true,
        renderer: 'canvas-fallback',
        result: {
          kind: 'rgba-raster',
          width: 1,
          height: 1,
          pixels: new Uint8ClampedArray([4, 5, 6, 255])
        }
      }))
    ]
    let workerIndex = 0
    const timeoutClient = createPerceptionV2WorkerClient({
      timeoutMs: 1,
      workerFactory: () => workers[workerIndex++].asWorker()
    })

    await expect(timeoutClient.render(completeRecipe)).resolves.toEqual({
      ok: false,
      error: 'perception_v2_worker_timeout'
    })
    expect(workers[0].terminated).toBe(true)
    await expect(timeoutClient.render(completeRecipe)).resolves.toMatchObject({
      ok: true,
      renderer: 'canvas-fallback'
    })
    expect(workers[1].posted).toHaveLength(1)
  })
})

function createFakeCanvas(bitmap: ImageBitmap): ReturnType<NonNullable<PerceptionV2RenderEnvironment['createOffscreenCanvas']>> {
  return {
    getContext: () => ({
      putImageData: () => undefined
    }),
    transferToImageBitmap: () => bitmap
  }
}

function checksum(bytes: Uint8ClampedArray): number {
  let result = 0
  for (const value of bytes) {
    result = (result + value) % 65535
  }
  return result
}

class FakePerceptionWorker extends EventTarget implements Worker {
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  onmessageerror: Worker['onmessageerror'] = null
  posted: unknown[] = []
  terminated = false

  private readonly responder: (message: PerceptionV2WorkerRequest) => PerceptionV2WorkerResponse | undefined

  constructor(responder: (message: PerceptionV2WorkerRequest) => PerceptionV2WorkerResponse | undefined) {
    super()
    this.responder = responder
  }

  postMessage(message: PerceptionV2WorkerRequest): void {
    this.posted.push(message)
    const response = this.responder(message)
    if (response) {
      this.onmessage?.(new MessageEvent('message', { data: response }))
    }
  }

  terminate(): void {
    this.terminated = true
  }

  asWorker(): Worker {
    return this
  }
}
