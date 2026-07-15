import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect, type Page } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  NARROW_MOBILE_VIEWPORT,
  TABLET_VIEWPORT,
  WARMUP_TIMEOUT_MS,
  fixtures,
  openAuditedPage,
  prewarmDevRuntime,
  assertElementHitTarget,
  assertElementInViewport,
  assertNoHorizontalOverflow,
  assertResponsiveLayoutContract,
  expectRouteAndShell,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

const articlePath = `/article/${fixtures.articleId}`
const execFileAsync = promisify(execFile)
const resetSecurityTestState = process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE !== '0'
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || 'fsusblog-redis'
const publicRouteExecutionMode = process.env.FSUSBLOG_DISABLE_HUMAN_READ_PROOF === '1'
  && process.env.FSUSBLOG_DISABLE_NOTIFICATION_STREAM === '1'
  ? 'parallel'
  : 'serial'

test.describe.configure({ mode: publicRouteExecutionMode })

async function resetLocalPowRiskState() {
  if (!resetSecurityTestState) {
    return
  }

  try {
    await execFileAsync('docker', [
      'exec',
      redisContainer,
      'sh',
      '-c',
      "redis-cli --scan --pattern '*fsus:sec:pow-risk:*' | xargs -r redis-cli DEL"
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container name.
  }
}

function publicExpectations() {
  return [
    {
      path: '/',
      expectedUrl: '/',
      label: 'public-home',
      selectors: [
        (page) => page.getByRole('heading', { level: 1 }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/archive',
      expectedUrl: '/archive',
      label: 'public-archive',
      selectors: [
        (page) => page.getByRole('heading', { name: /归档/i }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/about',
      expectedUrl: '/about',
      label: 'public-about',
      selectors: [
        (page) => page.getByRole('heading').first(),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/privacy',
      expectedUrl: '/privacy',
      label: 'public-privacy',
      selectors: [
        (page) => page.getByRole('heading', { name: /隐私政策/i }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/guidelines',
      expectedUrl: '/guidelines',
      label: 'public-guidelines',
      selectors: [
        (page) => page.getByRole('heading', { name: /用户守则/i }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/copyright',
      expectedUrl: '/copyright',
      label: 'public-copyright',
      selectors: [
        (page) => page.getByRole('heading', { name: /版权声明/i }),
        (page) => page.locator('main')
      ]
    },
    {
      path: `/category/${fixtures.categoryId}`,
      expectedUrl: `/category/${fixtures.categoryId}`,
      label: 'public-category',
      selectors: [
        (page) => page.getByRole('heading').first(),
        (page) => page.locator('main')
      ]
    },
    {
      path: `/tag/${fixtures.tagId}`,
      expectedUrl: `/tag/${fixtures.tagId}`,
      label: 'public-tag',
      selectors: [
        (page) => page.getByRole('heading').first(),
        (page) => page.locator('main')
      ]
    },
    {
      path: `/search?q=${encodeURIComponent(fixtures.searchKeyword)}`,
      expectedUrl: `/search?q=${encodeURIComponent(fixtures.searchKeyword)}`,
      label: 'public-search',
      selectors: [
        (page) => page.getByText('排序', { exact: false }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/login',
      expectedUrl: '/login',
      label: 'public-login',
      selectors: [
        (page) => page.getByRole('button', { name: /使用通行密钥登录/u }),
        (page) => page.getByRole('link', { name: /Recovery Key/u })
      ]
    }
  ]
}

async function readAuthoritativePublicHead(page: Page) {
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
      spaSession: (window as Window & { __FSUSBLOG_SEO_SPA_SESSION__?: string }).__FSUSBLOG_SEO_SPA_SESSION__ ?? null
    }
  })
}

async function expectAuthoritativePublicHead(page: Page, path: string, expectArticle: boolean) {
  await expect.poll(async () => (await readAuthoritativePublicHead(page)).marker?.canonicalUrl).toContain(path)
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
  const graph = Array.isArray(head.graph?.['@graph']) ? head.graph['@graph'] : []
  expect(graph.some((node) => node?.['@type'] === 'BlogPosting')).toBe(expectArticle)
  expect(head.navigationCount).toBe(1)
}

async function navigatePublicSpa(page: Page, path: string) {
  await page.evaluate((target) => {
    const anchor = document.createElement('a')
    anchor.href = target
    anchor.textContent = 'SEO navigation probe'
    anchor.dataset.fsusSeoNavigationProbe = 'true'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }, path)
  await page.waitForURL((url) => `${url.pathname}${url.search}` === path, { timeout: WARMUP_TIMEOUT_MS })
  await settlePage(page)
  expect((await readAuthoritativePublicHead(page)).spaSession).toBe('issue-1091-spa-session')
}

test.describe('public SEO head SPA parity', () => {
  test.describe.configure({ timeout: 180_000 })

  test('home fallback and article social images load with coherent metadata and natural dimensions', async ({ page }) => {
    for (const path of ['/', articlePath]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(page, WARMUP_TIMEOUT_MS)
      await settlePage(page)

      const result = await page.evaluate(async () => {
        const ogImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? ''
        const twitterImage = document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')?.content ?? ''
        const jsonLd = document.querySelector<HTMLScriptElement>('script[type="application/ld+json"]')?.textContent
        const graph = jsonLd ? JSON.parse(jsonLd)?.['@graph'] ?? [] : []
        const posting = graph.find((node: { '@type'?: string }) => node?.['@type'] === 'BlogPosting')
        const postingImage = typeof posting?.image === 'string' ? posting.image : posting?.image?.url ?? ''
        const image = new Image()
        image.src = ogImage
        await new Promise<void>((resolve, reject) => {
          if (image.complete) {
            image.naturalWidth > 0 ? resolve() : reject(new Error('social image completed without dimensions'))
            return
          }
          image.addEventListener('load', () => resolve(), { once: true })
          image.addEventListener('error', () => reject(new Error('social image failed to load')), { once: true })
        })
        return {
          ogImage,
          twitterImage,
          postingImage,
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight
        }
      })

      expect(result.ogImage).toBeTruthy()
      expect(result.twitterImage).toBe(result.ogImage)
      if (path === articlePath) {
        expect(result.postingImage).toBe(result.ogImage)
      }
      expect(result.complete).toBe(true)
      expect(result.naturalWidth).toBeGreaterThan(0)
      expect(result.naturalHeight).toBeGreaterThan(0)
    }
  })

  test('no-JavaScript direct loads expose the same authoritative head contract', async ({ browser }) => {
    const backendBaseUrl = process.env.FSUSBLOG_BASE_URL || process.env.FSUSBLOG_DEBUG_BACKEND_URL
    expect(backendBaseUrl, 'backend URL is required for server-rendered no-JavaScript checks').toBeTruthy()
    const context = await browser.newContext({ javaScriptEnabled: false })
    const directPage = await context.newPage()

    try {
      for (const path of ['/', articlePath]) {
        let source = ''
        for (let attempt = 0; attempt < 8 && source !== 'server-ssr'; attempt += 1) {
          const response = await directPage.goto(new URL(path, backendBaseUrl).toString(), {
            waitUntil: 'domcontentloaded'
          })
          source = response?.headers()['x-fsus-public-aot-source'] ?? ''
          if (source !== 'server-ssr') {
            await directPage.waitForTimeout(500)
          }
        }

        expect(source, `${path} should become a server-rendered AOT document`).toBe('server-ssr')
        const head = await readAuthoritativePublicHead(directPage)
        expect(head.marker.schema).toBe('fsusblog.public-seo-head')
        expect(head.marker.version).toBe(1)
        expect(head.marker.digest).toMatch(/^[a-f0-9]{64}$/u)
        expect(head.marker.canonicalUrl).toBe(head.canonical)
        expect(head.marker.pageEntityId).toBe(head.canonical)
        expect(head.title).toBe(head.marker.documentTitle)
        expect(head.description).toBe(head.marker.description)
        expect(head.canonicalCount).toBe(1)
        expect(head.jsonLdCount).toBe(1)
      }
    } finally {
      await context.close()
    }
  })

  test('Home → article A → article B → archive → category → tag → Home and history keep one coherent head', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForAppReady(page, WARMUP_TIMEOUT_MS)
    await settlePage(page)
    await expectAuthoritativePublicHead(page, '/', false)
    await page.evaluate(() => {
      ;(window as Window & { __FSUSBLOG_SEO_SPA_SESSION__?: string }).__FSUSBLOG_SEO_SPA_SESSION__ = 'issue-1091-spa-session'
    })

    const articleHrefs = await page.locator('a[href^="/article/"]').evaluateAll((anchors) =>
      Array.from(new Set(anchors.map((anchor) => anchor.getAttribute('href')).filter((href): href is string => Boolean(href))))
    )
    expect(articleHrefs.length).toBeGreaterThanOrEqual(2)
    const articleA = articleHrefs[0]
    const articleB = articleHrefs[1]

    const prewarmedArticleLink = page.locator(`a[href="${articleA}"]`).first()
    await prewarmedArticleLink.hover()
    await prewarmedArticleLink.click()
    await page.waitForURL((url) => url.pathname === articleA, { timeout: WARMUP_TIMEOUT_MS })
    await settlePage(page)
    expect((await readAuthoritativePublicHead(page)).spaSession).toBe('issue-1091-spa-session')
    await expectAuthoritativePublicHead(page, articleA, true)
    const taxonomy = await page.locator('a[href^="/category/"], a[href^="/tag/"]').evaluateAll((anchors) =>
      Array.from(new Set(anchors.map((anchor) => anchor.getAttribute('href')).filter((href): href is string => Boolean(href))))
    )
    const category = taxonomy.find((href) => href.startsWith('/category/'))
    const tag = taxonomy.find((href) => href.startsWith('/tag/'))
    expect(category).toBeTruthy()
    expect(tag).toBeTruthy()

    await navigatePublicSpa(page, articleB)
    await expectAuthoritativePublicHead(page, articleB, true)
    await navigatePublicSpa(page, '/archive')
    await expectAuthoritativePublicHead(page, '/archive', false)
    await navigatePublicSpa(page, category!)
    await expectAuthoritativePublicHead(page, category!, false)
    await navigatePublicSpa(page, tag!)
    await expectAuthoritativePublicHead(page, tag!, false)
    await navigatePublicSpa(page, '/')
    await expectAuthoritativePublicHead(page, '/', false)

    await page.goBack()
    await expectAuthoritativePublicHead(page, tag!, false)
    expect((await readAuthoritativePublicHead(page)).spaSession).toBe('issue-1091-spa-session')
    await page.goForward()
    await expectAuthoritativePublicHead(page, '/', false)
    expect((await readAuthoritativePublicHead(page)).spaSession).toBe('issue-1091-spa-session')
  })
})

for (const viewport of [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'tablet', size: TABLET_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT },
  { name: 'narrow-mobile', size: NARROW_MOBILE_VIEWPORT }
]) {
  test.describe(`public acceptance (${viewport.name})`, () => {
    test.use({ viewport: viewport.size })
    test.describe.configure({ timeout: 240_000 })

    test.beforeAll(async ({ browser }) => {
      await prewarmDevRuntime(browser)
    })

    test.beforeEach(async () => {
      await resetLocalPowRiskState()
    })

    test('visible public routes stay clean and aligned', async ({ browser }) => {
      for (const route of publicExpectations()) {
        const session = await openAuditedPage(browser)
        try {
          await expectRouteAndShell(session.page, session.audit, route)
          const main = session.page.locator('main').first()
          if (await main.count()) {
            await assertElementInViewport(session.page, main, `${route.label} main`)
          }
          await assertResponsiveLayoutContract(session.page, route.label)
        } finally {
          await session.close()
        }
      }
    })

    test('article detail and search page stay clean', async ({ browser }) => {
      const session = await openAuditedPage(browser)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto(articlePath, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
        await settlePage(session.page)

        const article = session.page.locator('main article, main [itemtype="https://schema.org/BlogPosting"]').first()
        const commentsIsland = session.page.locator('#fsus-comments-island')
        await expect(article).toBeVisible()
        await expect(commentsIsland).toBeVisible()
        await assertNoHorizontalOverflow(session.page)
        await assertResponsiveLayoutContract(session.page, 'public-article-detail')
        await assertElementInViewport(session.page, article, 'article detail')
        await assertElementInViewport(session.page, commentsIsland, 'comments-island')
        session.audit.assertCleanSince(start, 'public-article-detail')

        const searchStart = session.audit.checkpoint()
        await session.page.goto(`/search?q=${encodeURIComponent(fixtures.searchKeyword)}`, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
        await settlePage(session.page)

        for (const label of ['最新', '热度', '相关']) {
          const sortOption = session.page
            .locator('.filter-stack .el-radio-button')
            .filter({ hasText: label })
            .first()
          await assertElementHitTarget(session.page, sortOption, `search sort ${label}`)
        }
        await assertResponsiveLayoutContract(session.page, 'public-search-sort')

        session.audit.assertCleanSince(searchStart, 'public-search-sort')
      } finally {
        await session.close()
      }
    })
  })
}

test.describe('public CSP nonce enforcement', () => {
  test.describe.configure({ timeout: 120_000 })

  test('nonce is unique and production Trusted Types reject raw script sinks', async ({ page, request }) => {
    const first = await request.get('/')
    const second = await request.get('/')
    const firstHtml = await first.text()
    const secondHtml = await second.text()
    const firstNonce = firstHtml.match(/nonce="([A-Za-z0-9_-]+)"/u)?.[1] ?? ''
    const secondNonce = secondHtml.match(/nonce="([A-Za-z0-9_-]+)"/u)?.[1] ?? ''

    expect(first.status()).toBe(200)
    expect(second.status()).toBe(200)
    expect(firstNonce).not.toBe('')
    expect(secondNonce).not.toBe('')
    expect(firstNonce).not.toBe(secondNonce)
    expect(first.headers()['cache-control']).toContain('no-store')
    expect(first.headers().etag).toBeUndefined()
    const csp = first.headers()['content-security-policy']
    expect(csp).toContain("style-src-attr 'none'")
    expect(csp).not.toContain("style-src-attr 'unsafe-inline'")
    expect(csp).toContain("require-trusted-types-for 'script'")
    expect(csp).toContain('trusted-types vue fsusblog;')
    expect(csp).not.toMatch(/trusted-types\s+(?:\*|default)|allow-duplicates/u)
    expect(csp).toContain('report-uri /api/security/csp-report')

    await page.addInitScript(() => {
      const violations: string[] = []
      window.addEventListener('securitypolicyviolation', (event) => {
        violations.push(event.effectiveDirective)
      })
      ;(window as Window & { __FSUSBLOG_CSP_VIOLATIONS__?: string[] }).__FSUSBLOG_CSP_VIOLATIONS__ = violations
    })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForAppReady(page, WARMUP_TIMEOUT_MS)

    const result = await page.evaluate(async () => {
      // Browsers intentionally hide CSP nonce values from getAttribute(). The
      // standard .nonce property remains available to trusted page code.
      const nonceSource = document.querySelector('meta[property="csp-nonce"], script[nonce], style[nonce]') as HTMLElement | null
      const nonce = nonceSource?.nonce || ''
      let rawHtmlRejected = false
      try {
        document.createElement('template').innerHTML = '<img src=x onerror=alert(1)>'
      } catch (error) {
        rawHtmlRejected = error instanceof TypeError
      }
      let rawScriptUrlRejected = false
      try {
        document.createElement('script').src = '/wasm/comment-privacy-prover.js'
      } catch (error) {
        rawScriptUrlRejected = error instanceof TypeError
      }
      const blockedStyle = document.createElement('div')
      blockedStyle.setAttribute('style', 'display:none')
      document.body.appendChild(blockedStyle)
      await new Promise(resolve => setTimeout(resolve, 50))

      const state = window as Window & {
        __FSUSBLOG_CSP_VIOLATIONS__?: string[]
      }
      return {
        nonce,
        rawHtmlRejected,
        rawScriptUrlRejected,
        appReady: Boolean(document.querySelector('#app')),
        thirdPartyScripts: Array.from(document.scripts)
          .map(script => script.src)
          .filter(Boolean)
          .filter(src => new URL(src, location.href).origin !== location.origin),
        styleAttributeApplied: window.getComputedStyle(blockedStyle).display === 'none',
        violations: state.__FSUSBLOG_CSP_VIOLATIONS__ ?? []
      }
    })

    expect(result.nonce).not.toBe('')
    expect(result.rawHtmlRejected).toBe(true)
    expect(result.rawScriptUrlRejected).toBe(true)
    expect(result.appReady).toBe(true)
    expect(result.thirdPartyScripts).toEqual([])
    expect(result.styleAttributeApplied).toBe(false)
    expect(result.violations).toContain('require-trusted-types-for')
    expect(result.violations).toContain('style-src-attr')
  })
})

test.describe('public route real HTTP status', () => {
  test.describe.configure({ timeout: 120_000 })

  test('search is server-noindex, bounded to one URL, and stays noindex through SPA navigation', async ({ page, request }) => {
    const keyword = fixtures.searchKeyword
    const canonicalPath = `/search?q=${encodeURIComponent(keyword)}`
    const [getResponse, headResponse] = await Promise.all([
      request.get(canonicalPath, { headers: { Accept: 'text/html' } }),
      request.head(canonicalPath, { headers: { Accept: 'text/html' } })
    ])
    const body = await getResponse.text()

    expect(getResponse.status()).toBe(200)
    expect(headResponse.status()).toBe(200)
    expect(getResponse.headers()['x-robots-tag']).toBe('noindex, follow')
    expect(headResponse.headers()['x-robots-tag']).toBe('noindex, follow')
    expect(body).toContain('<meta name="robots" content="noindex,follow" data-fsus-search-head>')
    expect(body).not.toMatch(/rel="canonical"|application\/ld\+json/i)

    const homeResponse = await request.get('/', { headers: { Accept: 'text/html' } })
    expect(homeResponse.headers()['x-robots-tag']).toBeUndefined()
    expect(await homeResponse.text()).not.toContain('data-fsus-search-head')

    const normalized = await request.get('/SEARCH/?page=01&q=%20Cafe%CC%81%20%20&sort=LATEST&q=ignored&junk=x', {
      maxRedirects: 0
    })
    expect(normalized.status()).toBe(301)
    expect(normalized.headers().location).toBe('/search?q=Caf%C3%A9&sort=latest')

    const empty = await request.get('/search?q=&sort=hot&page=4', { maxRedirects: 0 })
    expect(empty.status()).toBe(301)
    expect(empty.headers().location).toBe('/search')

    const invalid = await request.get('/search?q=test&sort=unknown&page=101', { maxRedirects: 0 })
    expect(invalid.status()).toBe(301)
    expect(invalid.headers().location).toBe('/search?q=test')

    const oversized = await request.get(`/search?q=${'x'.repeat(129)}`, { maxRedirects: 0 })
    expect(oversized.status()).toBe(400)
    expect(oversized.headers()['x-robots-tag']).toBe('noindex, follow')
    expect(await oversized.text()).toContain('<meta name="robots" content="noindex,follow">')

    const [sitemap, robots] = await Promise.all([
      request.get('/sitemap.xml').then((response) => response.text()),
      request.get('/robots.txt').then((response) => response.text())
    ])
    expect(sitemap).not.toContain('/search')
    expect(robots).not.toMatch(/^Disallow:\s*\/search\s*$/mu)

    await page.goto(canonicalPath, { waitUntil: 'domcontentloaded' })
    await waitForAppReady(page)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow')
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0)
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0)
    await page.evaluate(() => {
      ;(window as Window & { __FSUSBLOG_SEARCH_SPA_MARKER__?: string }).__FSUSBLOG_SEARCH_SPA_MARKER__ = 'preserved'
    })
    await settlePage(page)
    await page.locator('.filter-stack .el-radio-button').filter({ hasText: '最新' }).first().click()
    await page.waitForURL(`${canonicalPath}&sort=latest`)
    expect(await page.evaluate(() =>
      (window as Window & { __FSUSBLOG_SEARCH_SPA_MARKER__?: string }).__FSUSBLOG_SEARCH_SPA_MARKER__
    )).toBe('preserved')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow')
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0)
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0)
    const articleLink = page.locator('main a[href^="/article/"]').first()
    await expect(articleLink).toBeVisible()
    expect(await articleLink.getAttribute('href')).toMatch(/^\/article\/\d+$/u)
  })

  test('invalid public URLs stay 404 before hydration and GET matches HEAD', async ({ page, request }) => {
    const paths = [
      '/route-that-does-not-exist',
      '/article/0',
      '/article/2147483647',
      `/article/${fixtures.articleId}/extra`,
      '/category/0',
      '/category/2147483647',
      '/category/8/extra',
      '/tag/0',
      '/tag/__fsusblog_missing_tag_1085__',
      '/tag/vue/extra'
    ]

    for (const path of paths) {
      const [getResponse, headResponse] = await Promise.all([
        request.get(path, { headers: { Accept: 'text/html' } }),
        request.head(path, { headers: { Accept: 'text/html' } })
      ])
      const body = await getResponse.text()

      expect(getResponse.status(), `${path} GET`).toBe(404)
      expect(headResponse.status(), `${path} HEAD`).toBe(404)
      expect(getResponse.headers()['x-robots-tag']).toBe('noindex, follow')
      expect(headResponse.headers()['x-robots-tag']).toBe('noindex, follow')
      expect(getResponse.headers()['x-fsus-public-aot-backfill']).toBe('none')
      expect(body).toContain('<meta name="robots" content="noindex,follow">')
      expect(body).not.toMatch(/rel="canonical"|property="og:url"|BlogPosting/i)
      expect(body).not.toContain('<script')
    }

    const navigation = await page.goto('/route-that-does-not-exist', { waitUntil: 'domcontentloaded' })
    expect(navigation?.status()).toBe(404)
    await expect(page.locator('h1')).toHaveText('页面不存在')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow')
    expect(await page.locator('script').count()).toBe(0)
  })

  test('trailing slash redirects once to the canonical path', async ({ request }) => {
    const response = await request.get(`/article/${fixtures.articleId}/`, { maxRedirects: 0 })

    expect(response.status()).toBe(301)
    expect(response.headers().location).toBe(`/article/${fixtures.articleId}`)
  })

  test('legacy tag name redirects once to the stable ID canonical', async ({ page, request }) => {
    await page.goto(articlePath, { waitUntil: 'domcontentloaded' })
    const tagLink = page.locator('[data-public-link="filter"][href^="/tag/"]').first()
    await expect(tagLink).toBeVisible()
    const canonicalHref = await tagLink.getAttribute('href')
    const label = (await tagLink.textContent())?.trim().replace(/^#/, '') ?? ''
    expect(canonicalHref).toMatch(/^\/tag\/\d+$/)
    expect(label.length).toBeGreaterThan(0)

    const response = await request.get(`/tag/${encodeURIComponent(label)}`, { maxRedirects: 0 })

    expect(response.status()).toBe(301)
    expect(response.headers().location).toBe(canonicalHref)
  })
})
