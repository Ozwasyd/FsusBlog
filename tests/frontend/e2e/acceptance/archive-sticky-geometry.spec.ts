import { expect, test, type Browser, type Page } from '@playwright/test'

const DESKTOP_VIEWPORT = { width: 1440, height: 900 }
const MOBILE_VIEWPORT = { width: 390, height: 844 }
const WARMUP_TIMEOUT_MS = 45_000

const headerSelector = '[data-public-shell-header]'
const headingSelector = '.archive-year-heading'
const sectionSelector = '.archive-year-section'

async function openAuditedPage(browser: Browser, viewport: Readonly<{ width: number; height: number }>) {
  const context = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000',
    viewport
  })
  const page = await context.newPage()
  const diagnostics: string[] = []
  page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return
    const text = message.text()
    if (/Failed to load resource|favicon|notification.*preflight/iu.test(text)) return
    diagnostics.push(`console:${message.type()}:${text}`)
  })
  page.on('requestfailed', (request) => {
    const error = request.failure()?.errorText || 'request failed'
    if (/ERR_ABORTED|ERR_NETWORK_CHANGED/iu.test(error)) return
    diagnostics.push(`requestfailed:${request.method()} ${request.url()} ${error}`)
  })
  page.on('response', (response) => {
    if (response.status() < 400 || response.status() === 401) return
    const url = response.url()
    if (/favicon|\/api\/notifications\/stream\/preflight/iu.test(url)) return
    diagnostics.push(`response:${response.status()}:${response.request().method()} ${url}`)
  })
  return {
    page,
    audit: {
      checkpoint: () => diagnostics.length,
      assertCleanSince: (start: number, label: string) => {
        expect(diagnostics.slice(start), `${label} runtime diagnostics`).toEqual([])
      }
    },
    close: () => context.close()
  }
}

async function waitForAppReady(page: Page, timeout: number) {
  await page.waitForFunction(() => {
    const shell = document.querySelector<HTMLElement>('#fsus-aot-shell')
    const app = document.querySelector<HTMLElement>('#app')
    if (!shell || !app || document.readyState !== 'complete') return false
    const rect = app.getBoundingClientRect()
    const style = getComputedStyle(app)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }, undefined, { timeout })
}

type GeometrySnapshot = Readonly<{
  headerBottom: number
  headerHeight: number
  headingTop: number
  sectionTop: number
  stickyTop: number
  anchorOffset: number
  stickyToken: string
  anchorToken: string
}>

async function readGeometry(page: Page, sectionId?: string): Promise<GeometrySnapshot> {
  return await page.evaluate(({ headerSelector, headingSelector, sectionSelector, sectionId }) => {
    const header = document.querySelector<HTMLElement>(headerSelector)
    const heading = document.querySelector<HTMLElement>(headingSelector)
    const section = sectionId
      ? document.getElementById(sectionId)
      : document.querySelector<HTMLElement>(sectionSelector)
    if (!header || !heading || !section) {
      throw new Error('archive sticky geometry elements are missing')
    }

    const headerRect = header.getBoundingClientRect()
    const headingStyle = getComputedStyle(heading)
    const sectionStyle = getComputedStyle(section)
    return {
      headerBottom: headerRect.bottom,
      headerHeight: headerRect.height,
      headingTop: heading.getBoundingClientRect().top,
      sectionTop: section.getBoundingClientRect().top,
      stickyTop: Number.parseFloat(headingStyle.top),
      anchorOffset: Number.parseFloat(sectionStyle.scrollMarginTop),
      stickyToken: headingStyle.getPropertyValue('--fsusblog-public-sticky-top').trim(),
      anchorToken: sectionStyle.getPropertyValue('--fsusblog-public-anchor-offset').trim()
    }
  }, { headerSelector, headingSelector, sectionSelector, sectionId })
}

function relativeTolerance(snapshot: GeometrySnapshot): number {
  return snapshot.headerHeight * 0.04
}

for (const viewport of [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT }
]) {
  test.describe(`archive sticky geometry (${viewport.name})`, () => {
    test.use({ viewport: viewport.size })
    test.describe.configure({ timeout: 120_000 })

    test('keeps hash targets below the header and closes the sticky-layer gap', async ({ browser }) => {
      const session = await openAuditedPage(browser, viewport.size)
      try {
        await session.page.setViewportSize(viewport.size)
        const auditStart = session.audit.checkpoint()
        await session.page.goto('/archive', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)

        const firstSection = session.page.locator(sectionSelector).first()
        const firstHeading = firstSection.locator(headingSelector)
        await expect(firstSection).toBeVisible()
        await expect(firstHeading).toBeVisible()
        await expect.poll(async () => {
          const snapshot = await readGeometry(session.page)
          return snapshot.headerHeight > 0
            ? Math.abs(snapshot.stickyTop - snapshot.headerBottom) / snapshot.headerHeight
            : Number.POSITIVE_INFINITY
        }, {
          message: 'runtime sticky geometry should replace the server-rendered fallback'
        }).toBeLessThanOrEqual(0.04)
        const sectionId = await firstSection.getAttribute('id')
        expect(sectionId).toMatch(/^archive-year-[0-9]{4}$/u)
        if (!sectionId) {
          throw new Error('archive year section id is missing')
        }

        await firstSection.evaluate((section) => {
          const spacer = document.createElement('div')
          spacer.dataset.archiveGeometrySpacer = 'true'
          spacer.setAttribute('aria-hidden', 'true')
          spacer.append(...Array.from({ length: 160 }, () => document.createElement('br')))
          section.append(spacer)
        })

        const initial = await readGeometry(session.page, sectionId)
        expect(initial.stickyToken).not.toBe('')
        expect(initial.anchorToken).not.toBe('')
        expect(initial.headerHeight).toBeGreaterThan(0)
        expect(initial.stickyTop).toBeGreaterThan(0)
        expect(initial.anchorOffset).toBeGreaterThan(initial.stickyTop)

        await session.page.evaluate((targetId) => {
          window.scrollTo(0, document.documentElement.scrollHeight)
          history.replaceState(null, '', `${location.pathname}${location.search}`)
          location.hash = targetId
        }, sectionId)

        await expect(session.page).toHaveURL(new RegExp(`#${sectionId}$`, 'u'))
        await expect.poll(async () => {
          const snapshot = await readGeometry(session.page, sectionId)
          return snapshot.headerHeight > 0
            ? Math.abs(snapshot.sectionTop - snapshot.anchorOffset) / snapshot.headerHeight
            : Number.POSITIVE_INFINITY
        }, {
          message: 'hash navigation should settle at the public anchor offset'
        }).toBeLessThanOrEqual(0.04)

        const hashGeometry = await readGeometry(session.page, sectionId)
        expect(hashGeometry.sectionTop).toBeGreaterThanOrEqual(
          hashGeometry.headerBottom - relativeTolerance(hashGeometry)
        )

        await session.page.evaluate(({ targetId, anchorOffset }) => {
          const section = document.getElementById(targetId)
          if (!section) throw new Error('archive section disappeared')
          const documentTop = section.getBoundingClientRect().top + window.scrollY
          window.scrollTo(0, documentTop + anchorOffset)
        }, { targetId: sectionId, anchorOffset: hashGeometry.anchorOffset })

        await expect.poll(async () => {
          const snapshot = await readGeometry(session.page, sectionId)
          return snapshot.headerHeight > 0
            ? Math.abs(snapshot.headingTop - snapshot.headerBottom) / snapshot.headerHeight
            : Number.POSITIVE_INFINITY
        }, {
          message: 'sticky year heading should settle flush against the public header'
        }).toBeLessThanOrEqual(0.04)

        const stickyGeometry = await readGeometry(session.page, sectionId)
        expect(Math.abs(stickyGeometry.headingTop - stickyGeometry.stickyTop)).toBeLessThanOrEqual(
          relativeTolerance(stickyGeometry)
        )
        expect(stickyGeometry.headingTop - stickyGeometry.headerBottom).toBeLessThanOrEqual(
          relativeTolerance(stickyGeometry)
        )
        session.audit.assertCleanSince(auditStart, `archive-sticky-geometry-${viewport.name}`)
      } finally {
        await session.close()
      }
    })
  })
}
