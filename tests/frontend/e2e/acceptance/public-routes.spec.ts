import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  WARMUP_TIMEOUT_MS,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import { inspectFontLoadingReadiness } from '../../support/playwright/readiness.mjs'

type SeoHeadSnapshot = {
  canonical: string
  canonicalCount: number
  description: string
  graph: { '@graph'?: Array<Record<string, unknown>> } | null
  jsonLdCount: number
  marker: {
    canonicalUrl: string
    description: string
    digest: string
    documentTitle: string
    openGraph: { url: string }
    pageEntityId: string
    publicOrigin: string
    schema: string
    version: number
  }
  markerCount: number
  navigationCount: number
  ogUrl: string
  spaSession: string | null
  title: string
}

async function readAuthoritativePublicHead(page: Page): Promise<SeoHeadSnapshot> {
  return await page.evaluate(() => {
    const canonicalNodes = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="canonical"]'))
    const jsonLdNodes = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'))
    const markerNodes = Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-fsus-seo-head-model]'))
    const marker = markerNodes[0]?.textContent ? JSON.parse(markerNodes[0].textContent) : null
    const graph = jsonLdNodes[0]?.textContent ? JSON.parse(jsonLdNodes[0].textContent) : null

    return {
      title: document.title,
      description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
      canonicalCount: canonicalNodes.length,
      canonical: canonicalNodes[0]?.href ?? '',
      ogUrl: document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ?? '',
      jsonLdCount: jsonLdNodes.length,
      markerCount: markerNodes.length,
      marker,
      graph,
      navigationCount: performance.getEntriesByType('navigation').length,
      spaSession: (window as Window & { __FSUSBLOG_SEO_SPA_SESSION__?: string })
        .__FSUSBLOG_SEO_SPA_SESSION__ ?? null
    }
  })
}

async function expectAuthoritativePublicHead(page: Page, path: string, expectArticle: boolean): Promise<void> {
  await expect.poll(async () => (await readAuthoritativePublicHead(page)).marker?.canonicalUrl)
    .toContain(path)
  const head = await readAuthoritativePublicHead(page)

  expect(head.title).toBe(head.marker.documentTitle)
  expect(head.description).toBe(head.marker.description)
  expect(head.canonicalCount).toBe(1)
  expect(head.jsonLdCount).toBe(1)
  expect(head.markerCount).toBe(1)
  expect(head.canonical).toBe(head.marker.canonicalUrl)
  expect(head.ogUrl).toBe(head.marker.openGraph.url)
  expect(head.marker.schema).toBe('fsusblog.public-seo-head')
  expect(head.marker.version).toBe(1)
  expect(head.marker.digest).toMatch(/^[a-f0-9]{64}$/u)
  expect(head.marker.pageEntityId).toBe(head.canonical)
  expect(new URL(head.canonical).origin).toBe(head.marker.publicOrigin)
  expect(head.graph?.['@graph']?.some((node) => node['@type'] === 'BlogPosting') ?? false)
    .toBe(expectArticle)
  expect(head.navigationCount).toBe(1)
}

async function navigatePublicSpa(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    const anchor = document.createElement('a')
    anchor.href = target
    anchor.textContent = 'SEO navigation probe'
    anchor.dataset.fsusSeoNavigationProbe = 'true'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }, path)
  await page.waitForURL((url) => `${url.pathname}${url.search}` === path, {
    timeout: WARMUP_TIMEOUT_MS
  })
  await settlePage(page)
  expect((await readAuthoritativePublicHead(page)).spaSession).toBe('browser-contract-session')
}

test.describe('public browser-only navigation contract', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })
  test.skip(({ browserName }) => browserName !== 'chromium',
    'Firefox/WebKit project the Chromium canonical product path and run only capability delta probes')

  test('locale pages load their bundled font faces without FontFace errors', async ({ page }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL
    expect(typeof baseURL).toBe('string')

    const localeFonts = [
      {
        family: 'Google Sans',
        locale: 'en-US',
        representativeText: 'Àéñçõ',
        weights: [400, 500, 700]
      },
      {
        family: 'Noto Sans SC',
        locale: 'zh-CN',
        representativeText: '汉语字形',
        weights: [400, 500, 700]
      }
    ] as const

    for (const expected of localeFonts) {
      await page.context().addCookies([{
        name: 'fsusblog.locale',
        value: expected.locale,
        url: baseURL as string,
        httpOnly: true,
        sameSite: 'Lax'
      }])
      const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
      expect(response?.ok()).toBe(true)
      await waitForAppReady(page, WARMUP_TIMEOUT_MS)
      await expect.poll(async () => await page.locator('html').getAttribute('lang'))
        .toBe(expected.locale)

      const report = await inspectFontLoadingReadiness(page, [expected])
      expect(report.fontSetStatusBeforeProbe).toBe('loaded')
      expect(report.fontSetStatusAfterProbe).toBe('loaded')
      expect(report.errorFacesBeforeProbe).toEqual([])
      expect(report.errorFacesAfterProbe).toEqual([])
      expect(report.families).toHaveLength(1)
      expect(report.families[0]?.family).toBe(expected.family)
      expect(report.families[0]?.facesBeforeProbe.length).toBeGreaterThan(0)
      expect(report.families[0]?.loadedWeightsBeforeProbe).toEqual(expected.weights)
      expect(report.families[0]?.probes).toEqual(expected.weights.map((weight) => ({
        check: true,
        loadedCount: expect.any(Number),
        query: `${weight} 1em "${expected.family}"`,
        weight
      })))
      for (const probe of report.families[0]?.probes ?? []) {
        expect(probe.loadedCount).toBeGreaterThan(0)
      }
    }
  })

  test('Home → article A → article B → archive → category → tag → Home and history keep one coherent head', {
    tag: '@browser-test:primary-public-route-navigation',
  }, async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForAppReady(page, WARMUP_TIMEOUT_MS)
    await settlePage(page)
    await expectAuthoritativePublicHead(page, '/', false)
    await page.evaluate(() => {
      ;(window as Window & { __FSUSBLOG_SEO_SPA_SESSION__?: string })
        .__FSUSBLOG_SEO_SPA_SESSION__ = 'browser-contract-session'
    })

    const articleHrefs = await page.locator('a[href^="/article/"]').evaluateAll((anchors) =>
      Array.from(new Set(anchors
        .map((anchor) => anchor.getAttribute('href'))
        .filter((href): href is string => Boolean(href))))
    )
    expect(articleHrefs.length).toBeGreaterThanOrEqual(2)
    const articleA = articleHrefs[0]!
    const articleB = articleHrefs[1]!

    const firstArticle = page.locator(`a[href="${articleA}"]`).first()
    await firstArticle.hover()
    await firstArticle.click()
    await page.waitForURL((url) => url.pathname === articleA, { timeout: WARMUP_TIMEOUT_MS })
    await settlePage(page)
    await expectAuthoritativePublicHead(page, articleA, true)

    const taxonomy = await page.locator('a[href^="/category/"], a[href^="/tag/"]').evaluateAll((anchors) =>
      Array.from(new Set(anchors
        .map((anchor) => anchor.getAttribute('href'))
        .filter((href): href is string => Boolean(href))))
    )
    const category = taxonomy.find((href) => href.startsWith('/category/'))
    const tag = taxonomy.find((href) => href.startsWith('/tag/'))
    expect(category).toBeTruthy()
    expect(tag).toBeTruthy()

    for (const [path, article] of [
      [articleB, true],
      ['/archive', false],
      [category!, false],
      [tag!, false],
      ['/', false]
    ] as const) {
      await navigatePublicSpa(page, path)
      await expectAuthoritativePublicHead(page, path, article)
    }

    await page.goBack()
    await expectAuthoritativePublicHead(page, tag!, false)
    await page.goForward()
    await expectAuthoritativePublicHead(page, '/', false)
  })
})
