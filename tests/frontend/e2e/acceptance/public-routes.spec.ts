import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'
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

  test('nonce is unique per document and blocks an untrusted inline script', async ({ page, request }) => {
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
      const blocked = document.createElement('script')
      blocked.textContent = 'window.__FSUSBLOG_UNTRUSTED_INLINE_EXECUTED__ = true'
      document.head.appendChild(blocked)

      const allowed = document.createElement('script')
      allowed.nonce = nonce
      allowed.textContent = 'window.__FSUSBLOG_TRUSTED_INLINE_EXECUTED__ = true'
      document.head.appendChild(allowed)
      await new Promise(resolve => setTimeout(resolve, 50))

      const state = window as Window & {
        __FSUSBLOG_UNTRUSTED_INLINE_EXECUTED__?: boolean
        __FSUSBLOG_TRUSTED_INLINE_EXECUTED__?: boolean
        __FSUSBLOG_CSP_VIOLATIONS__?: string[]
      }
      return {
        nonce,
        untrustedExecuted: state.__FSUSBLOG_UNTRUSTED_INLINE_EXECUTED__ === true,
        trustedExecuted: state.__FSUSBLOG_TRUSTED_INLINE_EXECUTED__ === true,
        violations: state.__FSUSBLOG_CSP_VIOLATIONS__ ?? []
      }
    })

    expect(result.nonce).not.toBe('')
    expect(result.untrustedExecuted).toBe(false)
    expect(result.trustedExecuted).toBe(true)
    expect(result.violations.some(directive => directive.startsWith('script-src'))).toBe(true)
  })
})

test.describe('public route real HTTP status', () => {
  test.describe.configure({ timeout: 120_000 })

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
