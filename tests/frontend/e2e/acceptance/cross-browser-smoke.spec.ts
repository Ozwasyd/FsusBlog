import { test, expect } from '@playwright/test'
import {
  waitForPublicHydration,
  waitForServiceWorkerCacheReady
} from '../../support/playwright/readiness.mjs'
import {
  assertBrowserCapabilityBehavior,
  resolveBrowserCapabilityDeclaration
} from '../../support/playwright/browser-capability-contract.mjs'

test.describe('cross-browser release smoke', () => {
  test('public shell engine capabilities and PWA cache stay coherent', async ({ page, browserName }) => {
    const consoleMessages: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push(`${message.type()}: ${message.text()}`)
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

    // Backend contracts, auth rules and security headers are covered once by
    // browserless/runtime correctness lanes. This diagnostic keeps only real
    // engine differences so Firefox/WebKit never repeat business assertions.
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

    const hydrationState = await page.evaluate(async () => {
      const conditionalMediationProbeAvailable = typeof PublicKeyCredential !== 'undefined'
        && typeof PublicKeyCredential.isConditionalMediationAvailable === 'function'
      let conditionalMediationSupported = false
      let conditionalMediationProbeResolved = false
      if (conditionalMediationProbeAvailable) {
        try {
          conditionalMediationSupported = await PublicKeyCredential.isConditionalMediationAvailable()
          conditionalMediationProbeResolved = true
        } catch {
          conditionalMediationSupported = false
        }
      }

      return {
        hasShell: Boolean(document.querySelector('#fsus-aot-shell')),
        shellHydrated: document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true',
        hydrationMetrics: Array.isArray((window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__)
          ? (window as Window & { __FSUS_PUBLIC_HYDRATION_METRICS__?: unknown[] }).__FSUS_PUBLIC_HYDRATION_METRICS__?.length ?? 0
          : 0,
        serviceWorkerSupported: 'serviceWorker' in navigator,
        passkeySupported: typeof PublicKeyCredential !== 'undefined'
          && typeof navigator.credentials?.get === 'function',
        conditionalMediationSupported,
        conditionalMediationProbeResolved
      }
    })

    expect(hydrationState.hasShell).toBeTruthy()
    expect(hydrationState.shellHydrated || hydrationState.hydrationMetrics > 0).toBeTruthy()

    await waitForPublicHydration(page)
    const serviceWorkerDeclaration = resolveBrowserCapabilityDeclaration(
      browserName,
      'serviceWorker'
    )
    const serviceWorkerEnabled = hydrationState.serviceWorkerSupported
      && serviceWorkerDeclaration.classification !== 'intentionally-disabled'
    const serviceWorkerSupportedBehavior: Record<string, boolean> = {}
    const serviceWorkerFallbackBehavior: Record<string, boolean> = {}

    if (serviceWorkerEnabled) {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForPublicHydration(page)
      if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
        await page.reload({ waitUntil: 'domcontentloaded' })
      }
      await waitForServiceWorkerCacheReady(page, {
        requireShellCache: browserName === 'chromium'
      })
      const serviceWorkerState = await page.evaluate(async () => ({
        registrationReady: Boolean(await navigator.serviceWorker.ready),
        cacheNames: await caches.keys()
      }))
      serviceWorkerSupportedBehavior['registration-ready'] = serviceWorkerState.registrationReady
      serviceWorkerSupportedBehavior['fsus-cache-namespace'] =
        serviceWorkerState.cacheNames.length > 0
        && serviceWorkerState.cacheNames.every((name) => name.startsWith('fsus-'))
        && (serviceWorkerState.cacheNames.some((name) => name.includes('shell'))
          || browserName !== 'chromium')
    } else {
      await expect.poll(
        async () => await page.evaluate(async () =>
          'serviceWorker' in navigator
            ? (await navigator.serviceWorker.getRegistrations()).length
            : 0
        )
      ).toBe(0)
      serviceWorkerFallbackBehavior['policy-disabled'] =
        serviceWorkerDeclaration.classification === 'intentionally-disabled'
      serviceWorkerFallbackBehavior['no-registrations'] = true
      serviceWorkerFallbackBehavior['online-shell-usable'] =
        await page.locator('#fsus-aot-shell').isVisible()
      serviceWorkerFallbackBehavior['no-unhandled-registration-error'] =
        !consoleMessages.some((message) =>
          /service_worker_(register|update)_failed/i.test(message)
        )
    }

    assertBrowserCapabilityBehavior({
      browserName,
      capability: 'serviceWorker',
      evidence: {
        probe: serviceWorkerEnabled,
        supportedBehavior: serviceWorkerSupportedBehavior,
        fallbackBehavior: serviceWorkerFallbackBehavior,
        absentCapabilityFixture: {}
      }
    })

    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    const passkeyAction = page.getByRole('button', {
      name: /通行密钥|passkey/i
    })
    const recoveryLink = page.locator('a[href="/recover"]')
    await expect(passkeyAction).toBeVisible()
    await expect(recoveryLink).toBeVisible()
    const actualPasskeyBehavior = {
      'passkey-action-visible': await passkeyAction.isVisible(),
      'passkey-action-enabled': await passkeyAction.isEnabled()
    }
    const actualConditionalMediationBehavior = {
      'conditional-probe-resolved':
        hydrationState.conditionalMediationProbeResolved,
      'passkey-action-visible': await passkeyAction.isVisible()
    }

    await page.addInitScript(() => {
      const fixtureWindow = window as typeof window & {
        __FSUSBLOG_MISSING_CREDENTIAL_API_CALLS__?: number
      }
      fixtureWindow.__FSUSBLOG_MISSING_CREDENTIAL_API_CALLS__ = 0
      Object.defineProperty(globalThis, 'PublicKeyCredential', {
        configurable: true,
        value: undefined
      })
      for (const method of ['get', 'create'] as const) {
        Object.defineProperty(navigator.credentials, method, {
          configurable: true,
          value: async () => {
            fixtureWindow.__FSUSBLOG_MISSING_CREDENTIAL_API_CALLS__ =
              (fixtureWindow.__FSUSBLOG_MISSING_CREDENTIAL_API_CALLS__ ?? 0) + 1
            throw new DOMException(
              'capability fixture disabled this API',
              'NotSupportedError'
            )
          }
        })
      }
    })
    await page.goto('/login?capability-fixture=absent', {
      waitUntil: 'domcontentloaded'
    })
    const fallbackRecoveryLink = page.locator('a[href="/recover"]')
    await expect(fallbackRecoveryLink).toBeVisible()
    const missingCredentialApiCalls = await page.evaluate(() =>
      (window as typeof window & {
        __FSUSBLOG_MISSING_CREDENTIAL_API_CALLS__?: number
      }).__FSUSBLOG_MISSING_CREDENTIAL_API_CALLS__ ?? 0
    )
    const absentCapabilityFixture = {
      'recovery-link-visible': await fallbackRecoveryLink.isVisible(),
      'missing-api-not-called': missingCredentialApiCalls === 0
    }

    assertBrowserCapabilityBehavior({
      browserName,
      capability: 'passkey',
      evidence: {
        probe: hydrationState.passkeySupported,
        supportedBehavior: actualPasskeyBehavior,
        fallbackBehavior: absentCapabilityFixture,
        absentCapabilityFixture
      }
    })
    assertBrowserCapabilityBehavior({
      browserName,
      capability: 'conditionalMediation',
      evidence: {
        probe: hydrationState.conditionalMediationSupported,
        supportedBehavior: actualConditionalMediationBehavior,
        fallbackBehavior: absentCapabilityFixture,
        absentCapabilityFixture
      }
    })

    const relevantDiagnostics = consoleMessages.filter((message) => {
      if (/favicon|404|ResizeObserver|Failed to load resource: the server responded with a status of 401 \(Unauthorized\)|api\/notifications\/stream\/preflight.*428|Failed to load resource: the server responded with a status of 428 \(Precondition Required\)/i.test(message)) {
        return false
      }
      if (browserName === 'webkit' && (
        /fsus_pow_(simd|basic)\.(wasm|js).*access control checks/i.test(message)
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
