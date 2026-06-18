import { expect, test } from '@playwright/test'
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from '../../support/playwright/acceptance-shared'

const providerPayload = {
  algorithm: 'fsu.captcha/chebyshev-noise@v1',
  polynomialSeedHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  noiseSeedHex: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
  seedPayloadBase64: 'dj0xCmNoYWxsZW5nZUlkPTAxOTAwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMA==',
  signatureHex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  gridWidth: '64',
  gridHeight: '24',
  distortionLevel: '18',
  powDifficultyBits: '8',
  issuedAtUnixMs: '1770000000000',
  expiresAtUnixMs: '1770000300000'
}

for (const viewport of [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT }
]) {
  test.describe(`CaptchaV1 worker harness (${viewport.name})`, () => {
    test.use({ viewport: viewport.size })

    test('renders locally, accepts mobile-safe input, and solves PoW without blocking the page', async ({ page }) => {
      await page.goto('/login', { waitUntil: 'domcontentloaded' })
      const result = await page.evaluate(async (payload) => {
        const modulePath = '/src/services/securityCaptchaClient.ts'
        const { createCaptchaWorkerClient } = await import(/* @vite-ignore */ modulePath)
        const client = createCaptchaWorkerClient(15_000)
        let ticks = 0
        const interval = window.setInterval(() => {
          ticks += 1
        }, 0)

        try {
          const raster = await client.render(payload)
          const canvas = document.createElement('canvas')
          canvas.dataset.test = 'captcha-e2e-canvas'
          canvas.width = raster.width
          canvas.height = raster.height
          document.body.append(canvas)
          const context = canvas.getContext('2d')
          const pixels = new Uint8ClampedArray(raster.pixels.length)
          pixels.set(raster.pixels)
          context?.putImageData(new ImageData(pixels, raster.width, raster.height), 0, 0)

          const input = document.createElement('input')
          input.dataset.test = 'captcha-e2e-input'
          input.inputMode = 'text'
          input.autocomplete = 'off'
          input.value = '3F4H'
          document.body.append(input)

          const proof = await client.solve(payload, input.value)
          window.clearInterval(interval)
          return {
            width: raster.width,
            height: raster.height,
            renderer: raster.renderer,
            nonceHex: proof.nonceHex,
            responseTokenHex: proof.responseTokenHex,
            ticks,
            nonBlankPixels: Array.from(raster.pixels).some((value) => value !== 0)
          }
        } finally {
          window.clearInterval(interval)
          client.dispose()
        }
      }, providerPayload)

      await expect(page.locator('[data-test="captcha-e2e-canvas"]')).toBeVisible()
      await expect(page.locator('[data-test="captcha-e2e-input"]')).toHaveValue('3F4H')
      expect(result).toMatchObject({
        width: 256,
        height: 96,
        nonceHex: '10000000',
        responseTokenHex: '00b00dbcdd558be9b6143868dd3cbd8e90cb77a88a525645b6e06d927f7192a6',
        nonBlankPixels: true
      })
      expect(result.ticks).toBeGreaterThan(0)
    })
  })
}

test('CaptchaV1 worker exposes Canvas fallback and fails closed on wasm load failure', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async (payload) => {
    const modulePath = '/src/services/securityCaptchaClient.ts'
    const { createCaptchaWorkerClient } = await import(/* @vite-ignore */ modulePath)
    const client = createCaptchaWorkerClient(15_000)
    try {
      const raster = await client.render(payload, { forceCanvasFallback: true })
      let wasmFailure = ''
      try {
        await client.render(payload, { forceWasmFailure: true })
      } catch (error) {
        wasmFailure = error instanceof Error ? error.message : String(error)
      }
      return {
        fallbackRenderer: raster.renderer,
        wasmFailure
      }
    } finally {
      client.dispose()
    }
  }, providerPayload)

  expect(result.fallbackRenderer).toBe('canvas-fallback')
  expect(result.wasmFailure).toContain('captcha_wasm_load_failed')
})
