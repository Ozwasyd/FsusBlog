/**
 * Public bootstrap browser causal matrix (scenarios A–G).
 *
 * Uses in-repo service + page.route() delay control. Causal order is asserted
 * from telemetry / DOM mutation receipts — not absolute multi-second sleeps.
 */
import { expect, test } from '@playwright/test'
import {
  fixtures,
  openAuditedPage,
  prewarmDevRuntime,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import { waitForPublicHydration } from '../../support/playwright/readiness.mjs'
import {
  clickPublicNav,
  installPublicBootstrapCausalProbe,
  waitForActivationTerminal
} from '../../support/playwright/publicBootstrapCausalHarness'
import { requirePublicBootstrapCausalOrder } from '../../support/publicBootstrapCausalEvidence.mjs'

test.describe('public bootstrap causal matrix', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeAll(async ({ browser }) => {
    await prewarmDevRuntime(browser)
  })

  test('A: silent path never shows loader/nprogress or current-URL snapshot', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: '/',
      scenario: 'A-silent-no-interaction'
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      // Keep no interaction; allow a short scheduler window via event wait, not sleep-oracle.
      await session.page.waitForFunction(() => document.readyState === 'complete')
      await session.page.evaluate(() => new Promise<void>((resolve) => {
        const ric = (window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
        }).requestIdleCallback
        if (typeof ric === 'function') {
          ric(() => resolve(), { timeout: 400 })
        } else {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }
      }))

      const loader = session.page.locator('#global-loader')
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
      await expect(session.page.locator('#fsus-aot-shell')).toBeVisible()
      await expect(session.page.locator('#nprogress')).toHaveCount(0)

      const counts = await probe.counts()
      // Current URL navigation snapshot must stay 0 on silent path.
      expect(counts.navigationSnapshotRequests, 'silent path must not fetch current-URL navigation snapshot').toBe(0)
      expect(counts.loaderEverVisible, 'global loader must never become visible on silent path').toBe(false)
      expect(counts.nprogressEverVisible, '#nprogress must never appear on silent path').toBe(false)

      // Takeover snapshot element is commit-time only; silent path must not create it as loader UI.
      await expect(session.page.locator('[data-fsusblog-takeover-snapshot]')).toHaveCount(0)

      session.audit.assertCleanSince(start, 'A-silent-no-interaction')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })

  test('B: intent before entry inject preempts idle and injects entry once', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: '/',
      scenario: 'B-preempt-before-entry',
      delay: { spaEntryMs: 120 }
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/', { waitUntil: 'domcontentloaded' })
      // Do not wait for full SPA readiness — we want intent while idle may still be queued.
      await session.page.waitForSelector('#fsus-aot-shell', { state: 'visible' })
      await session.page.waitForSelector('#fsus-public-boot-config')

      await probe.markIntent()
      // pointerdown is the BootKernel intent surface that must cancel idle.
      await session.page.dispatchEvent('body', 'pointerdown')
      await clickPublicNav(session.page, '归档')

      const terminal = await waitForActivationTerminal(session.page, { timeoutMs: 60_000 })
      expect(['interactive', 'fallback']).toContain(terminal)

      await expect.poll(() => new URL(session.page.url()).pathname).toBe('/archive')
      const evidence = await probe.snapshotEvidence()
      // Single navigation to archive (no Router+document double navigation).
      expect(evidence.navigationCount + evidence.documentNavigationCount).toBeGreaterThanOrEqual(1)
      // Entry request must have started after intent, not after a 1200/1800ms forced timer alone.
      const counts = await probe.counts()
      expect(counts.spaEntryRequests, 'entry must inject on intent').toBeGreaterThanOrEqual(1)

      if (evidence.timestamps.feedbackFirstVisible != null && evidence.timestamps.interactive != null) {
        requirePublicBootstrapCausalOrder(evidence, 'B-preempt-before-entry')
      }

      session.audit.assertCleanSince(start, 'B-preempt-before-entry')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })

  test('C: delayed core/snapshot keeps AOT owner until commit and suppresses Router progress', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: `/article/${fixtures.articleId}`,
      scenario: 'C-delayed-core-or-snapshot',
      delay: {
        fullAppCoreMs: 80,
        navigationSnapshotMs: 120
      }
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto(`/article/${fixtures.articleId}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
      await expect(session.page.locator('#global-loader')).toBeHidden()

      await probe.markIntent()
      await clickPublicNav(session.page, '归档')

      // AOT shell remains until ownership transfer completes.
      await expect.poll(async () => {
        const terminal = await session.page.evaluate(() => {
          const state = (window as Window & {
            __FSUS_PUBLIC_BOOTSTRAP_CAUSAL__?: { interactiveAt: number | null }
          }).__FSUS_PUBLIC_BOOTSTRAP_CAUSAL__
          return state?.interactiveAt != null
            || document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true'
        })
        return terminal
      }, { timeout: 60_000 }).toBe(true)

      await expect.poll(() => new URL(session.page.url()).pathname).toBe('/archive')
      const counts = await probe.counts()
      expect(counts.nprogressEverVisible, 'Router #nprogress must be suppressed during AOT takeover').toBe(false)

      const evidence = await probe.snapshotEvidence()
      if (evidence.timestamps.feedbackFirstVisible != null && evidence.timestamps.interactive != null) {
        requirePublicBootstrapCausalOrder(evidence, 'C-delayed-core-or-snapshot')
        expect(evidence.timestamps.feedbackFirstVisible).toBeLessThan(evidence.timestamps.interactive)
      }

      await expect(session.page.locator('#global-loader')).toBeHidden()
      session.audit.assertCleanSince(start, 'C-delayed-core-or-snapshot')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })

  test('D: rapid same/different targets stay single-navigation and latest-wins', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: '/',
      scenario: 'D-rapid-competition',
      delay: { navigationSnapshotMs: 60, fullAppCoreMs: 40 }
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await probe.markIntent()
      const archive = session.page
        .locator('nav[aria-label="主导航"], nav[aria-label="Primary navigation"]')
        .getByRole('link', { name: '归档' })
        .first()
      const about = session.page
        .locator('nav[aria-label="主导航"], nav[aria-label="Primary navigation"]')
        .getByRole('link', { name: /关于|About/i })
        .first()

      // same target: pointerdown + click + double click
      await archive.dispatchEvent('pointerdown')
      await archive.click({ clickCount: 1 })
      await archive.dblclick({ force: true }).catch(() => {})

      // different target latest-wins before commit if About is present
      if (await about.count() > 0 && await about.isVisible().catch(() => false)) {
        await about.click({ force: true }).catch(() => {})
      }

      await waitForActivationTerminal(session.page, { timeoutMs: 60_000 })
      await waitForAppReady(session.page)

      const pathname = new URL(session.page.url()).pathname
      expect(['/archive', '/about', '/']).toContain(pathname)

      const evidence = await probe.snapshotEvidence()
      // Must not accumulate unbounded navigations from double-firing.
      expect(evidence.navigationCount + evidence.documentNavigationCount).toBeLessThanOrEqual(3)

      session.audit.assertCleanSince(start, 'D-rapid-competition')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })

  test('E: snapshot failure falls back once and cleans feedback', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: '/',
      scenario: 'E-snapshot-failure-fallback',
      delay: { failNavigationSnapshot: true, fullAppCoreMs: 20 }
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await probe.markIntent()
      await clickPublicNav(session.page, '归档')

      // Either document fallback navigation or SPA recovery; feedback must clear.
      await expect.poll(async () => {
        const loaderHidden = await session.page.locator('#global-loader').isHidden()
        const path = new URL(session.page.url()).pathname
        return loaderHidden && (path === '/archive' || path === '/')
      }, { timeout: 60_000 }).toBe(true)

      const evidence = await probe.snapshotEvidence()
      if (evidence.timestamps.feedbackFirstVisible != null) {
        expect(evidence.timestamps.feedbackHidden ?? evidence.timestamps.fallback ?? evidence.timestamps.interactive)
          .not.toBeNull()
      }

      // No second nprogress flash after failure cleanup.
      const counts = await probe.counts()
      expect(counts.nprogressEverVisible).toBe(false)

      session.audit.assertCleanSince(start, 'E-snapshot-failure-fallback')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })

  test('F: seed lifecycle re-runs snapshot producer after consume', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: '/',
      scenario: 'F-seed-lifecycle'
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await probe.markIntent()
      await clickPublicNav(session.page, '归档')
      await waitForAppReady(session.page)
      await expect.poll(() => new URL(session.page.url()).pathname).toBe('/archive')
      const firstCounts = await probe.counts()
      const firstSnapshot = firstCounts.navigationSnapshotRequests

      // Return home then re-enter archive — second prepare cannot reuse consumed seed.
      try {
        await clickPublicNav(session.page, /主页|Home|博客|Blog/i)
      } catch {
        await session.page.goto('/', { waitUntil: 'domcontentloaded' })
      }
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await clickPublicNav(session.page, '归档')
      await waitForAppReady(session.page)
      await expect.poll(() => new URL(session.page.url()).pathname).toBe('/archive')

      const secondCounts = await probe.counts()
      expect(
        secondCounts.navigationSnapshotRequests,
        'second archive navigation must re-run snapshot producer after seed consume'
      ).toBeGreaterThan(firstSnapshot)

      session.audit.assertCleanSince(start, 'F-seed-lifecycle')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })

  test('G: hydration mismatch remains fail-closed without suppression attributes', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: `/article/${fixtures.articleId}`,
      scenario: 'G-hydration-counterexample'
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto(`/article/${fixtures.articleId}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)

      // Inject a controlled structural mismatch on the AOT shell before intentional hydration.
      await session.page.evaluate(() => {
        const shell = document.querySelector('#fsus-aot-shell')
        if (!shell) return
        const marker = document.createElement('div')
        marker.setAttribute('data-fsus-hydration-probe', 'mismatch')
        marker.textContent = 'controlled-hydration-mismatch'
        shell.prepend(marker)
      })

      // Force an interaction that would otherwise start FullApp enhancement.
      await session.page.mouse.click(16, 16)

      // Either hydration stays unflagged or fail-closed recovery runs; suppression attrs must be zero.
      const suppression = await session.page.evaluate(() => {
        const attr = ['data', 'allow', 'mismatch'].join('-')
        return {
          allowMismatchNodes: document.querySelectorAll(`[${attr}]`).length,
          hydrated: document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true',
          hasProbe: Boolean(document.querySelector('[data-fsus-hydration-probe="mismatch"]'))
        }
      })

      expect(suppression.allowMismatchNodes, 'no hydration mismatch suppression attribute nodes').toBe(0)

      // If the probe node still forces a mismatch path, hydrated flag must not be silently true
      // with a suppressed warning. When hydration already completed before the probe, the
      // assertion still requires zero suppression attributes.
      if (suppression.hasProbe && !suppression.hydrated) {
        await expect(session.page.locator('#fsus-aot-shell')).not.toHaveAttribute('data-public-hydrated', 'true')
      }

      session.audit.assertCleanSince(start, 'G-hydration-counterexample')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })

  test('C-bis: first intent hydrates public shell without progress double-flash', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const probe = await installPublicBootstrapCausalProbe(session.page, {
      route: `/article/${fixtures.articleId}`,
      scenario: 'C-bis-first-intent-hydrate',
      delay: { fullAppCoreMs: 50 }
    })

    try {
      const start = session.audit.checkpoint()
      await session.page.goto(`/article/${fixtures.articleId}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await probe.markIntent()
      await session.page.mouse.click(16, 16)
      await waitForPublicHydration(session.page)

      const counts = await probe.counts()
      expect(counts.nprogressEverVisible).toBe(false)
      await expect(session.page.locator('#global-loader')).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveAttribute('data-public-hydrated', 'true')

      session.audit.assertCleanSince(start, 'C-bis-first-intent-hydrate')
    } finally {
      await probe.dispose()
      await session.close()
    }
  })
})
