import { expect, test, type Page } from '@playwright/test'
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from '../../support/playwright/acceptance-shared'

const renderRecipe = {
  v: 2,
  width: 128,
  height: 80,
  background: '#101820',
  layers: [
    { kind: 'rect', x: 8, y: 10, width: 48, height: 20, color: '#dfe7fd', alpha: 0.9 },
    { kind: 'ellipse', x: 78, y: 26, radiusX: 22, radiusY: 13, color: '#2fbf71', alpha: 0.8 }
  ],
  strokeSegments: [
    {
      points: [
        { x: 12, y: 58 },
        { x: 42, y: 38 },
        { x: 90, y: 54 },
        { x: 116, y: 24 }
      ],
      width: 4,
      color: '#f7b32b',
      alpha: 0.9
    }
  ],
  noiseFields: [
    { seed: 516, density: 0.18, alpha: 0.16, color: '#ffffff', cellSize: 2 }
  ],
  warpFields: [
    { seed: 7, amplitude: 2.2, frequency: 0.12, axis: 'x' }
  ],
  occluders: [
    { kind: 'rect', x: 72, y: 48, width: 38, height: 10, color: '#05070a', alpha: 0.68 }
  ],
  presentationHints: {
    taskKind: 'localization'
  }
} as const

type PerceptionWorkerSummary =
  | {
      ok: true
      renderer: string
      payloadKind: string
      width: number
      height: number
      ticks: number
      nonBlankPixels: boolean
      semanticIdsPresent: boolean
    }
  | {
      ok: false
      error: string
      ticks: number
    }

test.describe('PerceptionSealedV2 worker renderer', () => {
  test.use({ viewport: DESKTOP_VIEWPORT })

  test('renders through a module worker and uses OffscreenCanvas transfer on Chromium', async ({ page, browserName }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    const result = await renderInPerceptionWorker(page)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.width).toBe(renderRecipe.width)
      expect(result.height).toBe(renderRecipe.height)
      expect(result.nonBlankPixels).toBe(true)
      expect(result.semanticIdsPresent).toBe(false)
      expect(result.ticks).toBeGreaterThan(0)
      expect(['offscreen-canvas', 'canvas-fallback']).toContain(result.renderer)
      if (browserName === 'chromium') {
        expect(result.renderer).toBe('offscreen-canvas')
        expect(result.payloadKind).toBe('bitmap')
      }
    }
  })
})

test.describe('PerceptionSealedV2 mobile Safari fallback gates', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  })

  test('renders with Canvas fallback and returns recoverable worker failures', async ({ page, browserName }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    const fallback = await renderInPerceptionWorker(page, { forceCanvasFallback: true })
    const workerInitFailure = await renderInPerceptionWorker(page, { forceWorkerInitFailure: true })

    expect(fallback.ok).toBe(true)
    if (fallback.ok) {
      expect(fallback.renderer).toBe('canvas-fallback')
      expect(fallback.payloadKind).toBe('rgba-raster')
      expect(fallback.nonBlankPixels).toBe(true)
      expect(fallback.semanticIdsPresent).toBe(false)
    }

    expect(workerInitFailure.ok).toBe(false)
    if (!workerInitFailure.ok) {
      expect(workerInitFailure.error).toContain('perception_v2_worker_init_failed')
    }

    if (browserName === 'webkit') {
      const platformFallback = await renderInPerceptionWorker(page)
      expect(platformFallback.ok).toBe(true)
      if (platformFallback.ok) {
        expect(platformFallback.renderer).toBe('canvas-fallback')
        expect(platformFallback.payloadKind).toBe('rgba-raster')
      }
    }
  })
})

async function renderInPerceptionWorker(
  page: Page,
  options: { forceCanvasFallback?: boolean; forceWorkerFailure?: boolean; forceWorkerInitFailure?: boolean } = {}
): Promise<PerceptionWorkerSummary> {
  return page.evaluate(async ({ recipe, options }) => {
    const modulePath = '/src/services/securityPerceptionV2Client.ts'
    const { createPerceptionV2WorkerClient } = await import(/* @vite-ignore */ modulePath)
    const client = createPerceptionV2WorkerClient({
      workerFactory: options.forceWorkerInitFailure === true
        ? () => {
            throw new Error('perception_v2_worker_init_failed')
          }
        : undefined
    })
    let ticks = 0
    const interval = window.setInterval(() => {
      ticks += 1
    }, 0)

    try {
      const response = await client.render(recipe, {
        forceCanvasFallback: options.forceCanvasFallback === true,
        forceWorkerFailure: options.forceWorkerFailure === true
      })

      if (response.ok !== true) {
        return {
          ok: false,
          error: String(response.error || 'perception_v2_worker_failed'),
          ticks
        }
      }

      const result = response.result as Record<string, unknown>
      const width = Number(result.width)
      const height = Number(result.height)
      const canvas = document.createElement('canvas')
      canvas.dataset.test = 'perception-v2-e2e-canvas'
      canvas.width = width
      canvas.height = height
      document.body.append(canvas)
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('perception_v2_canvas_context_missing')
      }

      if (result.kind === 'bitmap') {
        const bitmap = result.bitmap as ImageBitmap
        context.drawImage(bitmap, 0, 0)
        if (typeof bitmap.close === 'function') {
          bitmap.close()
        }
      } else {
        const pixels = result.pixels as Uint8ClampedArray
        context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)
      }

      const rendered = context.getImageData(0, 0, width, height).data
      let nonBlankPixels = false
      for (let index = 0; index < rendered.length; index += 4) {
        if (rendered[index] !== 0 || rendered[index + 1] !== 0 || rendered[index + 2] !== 0) {
          nonBlankPixels = true
          break
        }
      }

      const serializedRecipe = JSON.stringify(recipe)
      return {
        ok: true,
        renderer: String(response.renderer),
        payloadKind: String(result.kind),
        width,
        height,
        ticks,
        nonBlankPixels,
        semanticIdsPresent: serializedRecipe.includes('glyphIds') || serializedRecipe.includes('charIds')
      }
    } finally {
      window.clearInterval(interval)
      client.dispose()
    }
  }, { recipe: renderRecipe, options })
}
