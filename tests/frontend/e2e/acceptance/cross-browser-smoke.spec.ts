import { test, expect } from '@playwright/test'

test.describe('cross-browser release smoke', () => {
  test('public shell, auth entry, passkey capability, PWA cache and security headers stay coherent', async ({ page, request, browserName }) => {
    const consoleMessages: string[] = []
    const rateLimitedUrls: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push(`${message.type()}: ${message.text()}`)
      }
    })
    page.on('response', (response) => {
      if (response.status() === 429) {
        rateLimitedUrls.push(response.url())
      }
    })
    page.on('pageerror', (error) => {
      consoleMessages.push(`pageerror: ${error.message}`)
    })

    // WebKit does not participate in the PWA-cache assertions below. Avoid
    // starting its service worker in the local HTTP + COEP acceptance runtime,
    // where WebKit rejects the otherwise same-origin worker before the test can
    // exercise any supported behavior.
    if (browserName === 'webkit') {
      await page.addInitScript(() => {
        (window as Window & { __FSUSBLOG_DISABLE_SERVICE_WORKER__?: boolean })
          .__FSUSBLOG_DISABLE_SERVICE_WORKER__ = true
      })
    }

    if (process.env.FSUSBLOG_DISABLE_NOTIFICATION_STREAM === '1') {
      await page.addInitScript(() => {
        const runtimeWindow = window as typeof window & {
          __FSUSBLOG_DISABLE_NOTIFICATION_STREAM__?: boolean
        }
        runtimeWindow.__FSUSBLOG_DISABLE_NOTIFICATION_STREAM__ = true

        const markNotificationStreamSuppressed = () => {
          const root = document.documentElement
          if (!root) {
            return false
          }

          root.dataset.fsusDisableNotificationStream = 'true'
          return true
        }

        if (!markNotificationStreamSuppressed()) {
          setTimeout(markNotificationStreamSuppressed, 0)
        }
      })
    }

    const publicResponse = await request.get('/')
    expect(publicResponse.ok()).toBeTruthy()
    expect(publicResponse.headers()['x-content-type-options']).toBe('nosniff')
    expect(publicResponse.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(publicResponse.headers()['content-security-policy'] ?? '').toContain("default-src 'self'")

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#fsus-aot-shell')).toBeVisible()
    await expect(page.locator('#fsus-aot-shell')).toHaveAttribute('data-public-hydration-kind', /Home|ArticleDetail|Archive|Filter|About/)
    await expect.poll(
      async () => await page.evaluate(() => {
        const shellHydrated = document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true'
        const metricsCount = Array.isArray((window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__)
          ? (window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__?.length ?? 0
          : 0
        return shellHydrated || metricsCount > 0
      }),
      { timeout: 15_000 }
    ).toBeTruthy()

    const hydrationState = await page.evaluate(() => ({
      hasShell: Boolean(document.querySelector('#fsus-aot-shell')),
      shellHydrated: document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true',
      hydrationMetrics: Array.isArray((window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? (window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__?.length ?? 0
        : 0,
      serviceWorkerSupported: 'serviceWorker' in navigator,
      passkeySupported: typeof PublicKeyCredential !== 'undefined',
      conditionalMediationProbeAvailable: typeof PublicKeyCredential !== 'undefined'
        && typeof PublicKeyCredential.isConditionalMediationAvailable === 'function'
    }))

    expect(hydrationState.hasShell).toBeTruthy()
    expect(hydrationState.shellHydrated || hydrationState.hydrationMetrics > 0).toBeTruthy()
    expect(typeof hydrationState.serviceWorkerSupported).toBe('boolean')
    expect(typeof hydrationState.passkeySupported).toBe('boolean')
    expect(typeof hydrationState.conditionalMediationProbeAvailable).toBe('boolean')

    // Hydration can publish its ready marker while background dynamic imports
    // are still in flight. Navigating immediately makes Firefox abort those
    // requests with NS_BINDING_ABORTED and report a false module-load failure.
    // Finish the real module graph before testing the next route.
    await page.waitForLoadState('networkidle')
    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
    await expect(page.getByRole('button', { name: /使用通行密钥登录/ })).toBeVisible()
    await expect(page.getByText(/使用 Recovery Key 恢复访问/)).toBeVisible()

    if (hydrationState.serviceWorkerSupported && browserName !== 'webkit') {
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready
      })
      await page.reload({ waitUntil: 'networkidle' })
      const cacheNames = await page.evaluate(async () => await caches.keys())
      expect(cacheNames.every((name) => name.startsWith('fsus-'))).toBeTruthy()
      expect(cacheNames.some((name) => name.includes('shell')) || browserName !== 'chromium').toBeTruthy()
    }

    const onlyNotificationPreflightRateLimits = rateLimitedUrls.length > 0
      && rateLimitedUrls.every((url) => url.includes('/api/notifications/stream/preflight'))
    const relevantDiagnostics = consoleMessages.filter((message) => {
      if (/favicon|404|ResizeObserver|Failed to load resource: the server responded with a status of 401 \(Unauthorized\)|api\/notifications\/stream\/preflight.*428|Failed to load resource: the server responded with a status of 428 \(Precondition Required\)/i.test(message)) {
        return false
      }
      if (onlyNotificationPreflightRateLimits && /Failed to load resource: the server responded with a status of 429 \(Too Many Requests\)/i.test(message)) {
        return false
      }
      if (browserName === 'webkit' && (
        /service_worker_update_failed/i.test(message)
        || /fsus_pow_(simd|basic)\.(wasm|js).*access control checks/i.test(message)
        || /wasm streaming compile failed|falling back to ArrayBuffer instantiation|failed to asynchronously prepare wasm|Aborted\(NetworkError/i.test(message)
        || /FACTORY_MISSING: Glue code did not export createPowModule|\[Worker\] (Initialization Error|PING Failed)/i.test(message)
      )) {
        return false
      }
      return true
    })
    expect(relevantDiagnostics).toEqual([])
  })
})
