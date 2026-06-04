import { test, expect } from '@playwright/test'

test.describe('cross-browser release smoke', () => {
  test('public shell, auth entry, passkey capability, PWA cache and security headers stay coherent', async ({ page, request, browserName }) => {
    const consoleMessages: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push(`${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => {
      consoleMessages.push(`pageerror: ${error.message}`)
    })

    const publicResponse = await request.get('/')
    expect(publicResponse.ok()).toBeTruthy()
    expect(publicResponse.headers()['x-content-type-options']).toBe('nosniff')
    expect(publicResponse.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(publicResponse.headers()['content-security-policy'] ?? '').toContain("default-src 'self'")

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#fsus-aot-shell')).toBeVisible()
    await expect(page.locator('#fsus-aot-shell')).toHaveAttribute('data-public-hydration-kind', /Home|ArticleDetail|Archive|Filter|About/)
    await expect.poll(
      async () => await page.evaluate(() => Array.isArray((window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? (window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__?.length ?? 0
        : 0),
      { timeout: 15_000 }
    ).toBeGreaterThan(0)

    const hydrationState = await page.evaluate(() => ({
      hasShell: Boolean(document.querySelector('#fsus-aot-shell')),
      hydrationMetrics: Array.isArray((window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? (window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__?.length ?? 0
        : 0,
      serviceWorkerSupported: 'serviceWorker' in navigator,
      passkeySupported: typeof PublicKeyCredential !== 'undefined',
      conditionalMediationProbeAvailable: typeof PublicKeyCredential !== 'undefined'
        && typeof PublicKeyCredential.isConditionalMediationAvailable === 'function'
    }))

    expect(hydrationState.hasShell).toBeTruthy()
    expect(hydrationState.hydrationMetrics).toBeGreaterThan(0)
    expect(typeof hydrationState.serviceWorkerSupported).toBe('boolean')
    expect(typeof hydrationState.passkeySupported).toBe('boolean')
    expect(typeof hydrationState.conditionalMediationProbeAvailable).toBe('boolean')

    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#username')).toBeVisible()
    await expect(page.locator('#password')).toBeVisible()

    if (hydrationState.serviceWorkerSupported) {
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready
      })
      await page.reload({ waitUntil: 'networkidle' })
      const cacheNames = await page.evaluate(async () => await caches.keys())
      expect(cacheNames.every((name) => name.startsWith('fsus-'))).toBeTruthy()
      expect(cacheNames.some((name) => name.includes('shell')) || browserName !== 'chromium').toBeTruthy()
    }

    const relevantDiagnostics = consoleMessages.filter((message) => !/favicon|404|ResizeObserver|Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i.test(message))
    expect(relevantDiagnostics).toEqual([])
  })
})
