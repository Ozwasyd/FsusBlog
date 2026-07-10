#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { decodePublicAotPayload } from '../../support/aeds-envelope.mjs'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

export const PAYLOAD_FIXTURE_SCHEMA = 'fsusblog.public-hydration-payload-fixture-matrix.v1'
const PAYLOAD_FIXTURE_SUMMARY_FILE = process.env.FSUSBLOG_PUBLIC_HYDRATION_PAYLOAD_FIXTURE_SUMMARY_FILE
  || fileURLToPath(new URL('../../../../.tmp/release-evidence/public-hydration-payload-fixture-summary.json', import.meta.url))
const PUBLIC_SSR_BUNDLE_FILE = fileURLToPath(new URL('../../../../src/frontend/dist/server/public-ssr.mjs', import.meta.url))
const executablePath = resolveSystemChromiumExecutablePath()

export const REQUIRED_DIMENSIONS = [
  'article-list:empty',
  'article-list:one-item',
  'article-list:full-page',
  'article-list:last-page',
  'article-list:long-title',
  'article-list:long-summary',
  'home-secondary:both-empty',
  'home-secondary:primary-only',
  'home-secondary:secondary-only',
  'home-secondary:both-present',
  'home-secondary:boundary-ordering',
  'article-detail:minimal',
  'article-detail:rich',
  'article-detail:no-tags',
  'article-detail:many-tags',
  'article-detail:no-related-reading',
  'article-detail:previous-next-present',
  'article-body:headings',
  'article-body:code-blocks',
  'article-body:images',
  'article-body:tables',
  'article-body:blockquotes',
  'article-body:long-inline-text',
  'article-body:safe-wrappers',
  'filter:valid-category',
  'filter:invalid-category',
  'filter:valid-tag',
  'filter:tag-by-name',
  'filter:invalid-tag',
  'filter:empty-result',
  'filter:multi-page-result',
  'archive:empty',
  'archive:grouped',
  'archive:large',
  'static:empty-content',
  'static:normal-content',
  'static:long-content',
  'footer:disabled-config',
  'footer:enabled-partial-config',
  'footer:complete-config',
  'site-title:fallback',
  'logo:present',
  'logo:absent',
  'payload:optional-arrays-missing',
  'payload:optional-values-null',
  'payload:backend-flat-shape',
  'payload:duplicate-scalars-absent',
]

const HYDRATION_KEYWORDS = [
  'Hydration',
  'mismatch',
  '[public-hydrate]',
  '[public-hydration]',
  'hydration node mismatch',
  'hydration text content mismatch',
  'hydration attribute mismatch',
  'hydration completed but contains mismatches',
]

const RENDER_TIMESTAMP = '2026-06-16T12:00:00.000Z'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function writeSummary(summary) {
  mkdirSync(dirname(PAYLOAD_FIXTURE_SUMMARY_FILE), { recursive: true })
  writeFileSync(PAYLOAD_FIXTURE_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`)
}

function installSsrDomGlobals() {
  if (typeof globalThis.Element === 'undefined') {
    globalThis.Element = class Element {}
  }
  if (typeof globalThis.HTMLElement === 'undefined') {
    globalThis.HTMLElement = class HTMLElement extends globalThis.Element {}
  }
  if (typeof globalThis.SVGElement === 'undefined') {
    globalThis.SVGElement = class SVGElement extends globalThis.Element {}
  }
  if (typeof globalThis.ShadowRoot === 'undefined') {
    globalThis.ShadowRoot = class ShadowRoot extends globalThis.Element {}
  }
}

async function loadSsrBundle() {
  assert(existsSync(PUBLIC_SSR_BUNDLE_FILE), `missing public SSR bundle: ${PUBLIC_SSR_BUNDLE_FILE}`)
  installSsrDomGlobals()
  const bundle = await import(pathToFileURL(PUBLIC_SSR_BUNDLE_FILE).href)
  assert(typeof bundle.buildPublicEntry === 'function', 'public SSR bundle missing buildPublicEntry')
  return bundle
}

function isHydrationIssue(text) {
  const lower = String(text).toLowerCase()
  return HYDRATION_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))
}

function createCompliance(mode) {
  if (mode === 'disabled') {
    return {
      enabled: false,
      regionMode: '',
      copyrightOwner: '',
      copyrightStartYear: null,
      copyrightText: '',
      contentLicenseName: '',
      contentLicenseUrl: '',
      icpRecordNumber: '',
      icpRecordUrl: '',
      policeRecordNumber: '',
      policeRecordUrl: '',
      policeBadgeIconUrl: '',
      operatorName: '',
      contactEmail: '',
    }
  }

  if (mode === 'partial') {
    return {
      enabled: true,
      regionMode: 'global',
      copyrightOwner: 'Fixture Owner',
      copyrightStartYear: null,
      copyrightText: '',
      contentLicenseName: '',
      contentLicenseUrl: '',
      icpRecordNumber: '',
      icpRecordUrl: '',
      policeRecordNumber: '',
      policeRecordUrl: '',
      policeBadgeIconUrl: '',
      operatorName: '',
      contactEmail: null,
    }
  }

  return {
    enabled: true,
    regionMode: 'cn',
    copyrightOwner: 'Fixture Owner',
    copyrightStartYear: 2024,
    copyrightText: 'All rights reserved.',
    contentLicenseName: 'CC BY-NC-SA 4.0',
    contentLicenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    icpRecordNumber: 'ICP fixture',
    icpRecordUrl: 'https://beian.miit.gov.cn/',
    policeRecordNumber: 'Police fixture',
    policeRecordUrl: 'https://www.beian.gov.cn/',
    policeBadgeIconUrl: 'https://example.com/police.png',
    operatorName: 'Fixture Ops',
    contactEmail: 'ops@fsus.blog',
  }
}

function commonOptions(overrides = {}) {
  return {
    siteTitle: 'FsusBlog Payload Matrix',
    siteDescription: 'Payload fixture matrix for public AOT hydration.',
    baseUrl: 'https://example.com',
    renderTimestamp: RENDER_TIMESTAMP,
    compliance: createCompliance('partial'),
    ...overrides,
  }
}

function articleSummary(id, overrides = {}) {
  return {
    id,
    title: `Payload fixture article ${id}`,
    summary: `Fixture summary ${id}`,
    coverImageUrl: '',
    views: id * 10,
    createTime: new Date(Date.UTC(2026, 5, 16, 12, 0, 0) - id * 3600_000).toISOString(),
    category: { id: 7, name: 'Payload' },
    tags: [{ id: 70 + id, name: 'hydration' }],
    ...overrides,
  }
}

function featuredArticle(id, overrides = {}) {
  return {
    id,
    title: `Featured fixture ${id}`,
    coverImageUrl: `https://example.com/assets/featured-${id}.jpg`,
    views: 100 + id,
    createTime: articleSummary(id).createTime,
    category: { id: 8, name: 'Featured' },
    ...overrides,
  }
}

function hotArticle(id, overrides = {}) {
  return {
    id,
    title: `Hot fixture ${id}`,
    views: 200 + id,
    ...overrides,
  }
}

function createArticleRights(id, overrides = {}) {
  return {
    snapshotId: `${id}01`,
    articleRevisionId: `${id}00`,
    revisionNo: 1,
    enabled: true,
    licenseType: 'all-rights-reserved',
    copyrightHolder: 'Fixture Owner',
    copyrightYear: 2026,
    rightsStatement: 'All rights reserved.',
    attributionTemplate: null,
    copyPolicy: 'append-attribution',
    maxExcerptChars: 300,
    allowCodeCopy: true,
    showPublicBadge: true,
    proofBindingEnabled: true,
    canonicalUrl: `https://example.com/article/${id}`,
    policyHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    contentCanonicalHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    proofUrl: null,
    proofStatus: 'pending',
    ...overrides,
  }
}

function articleDetail(id, overrides = {}) {
  return {
    ...articleSummary(id),
    bodyContent: 'Minimal payload fixture body.',
    authorName: 'Payload Harness',
    rights: createArticleRights(id),
    relatedReading: {
      related: [],
      previous: null,
      next: null,
    },
    ...overrides,
  }
}

function repeatedArticles(count, startId = 1000, overrides = {}) {
  return Array.from({ length: count }, (_, index) => articleSummary(startId + index, typeof overrides === 'function' ? overrides(index) : overrides))
}

const longTitle = 'Long title '.repeat(24).trim()
const longSummary = 'Long summary text '.repeat(80).trim()
const longInlineText = 'supercalifragilisticexpialidocious'.repeat(16)
const richBody = [
  '# Fixture Heading',
  '',
  '## Fixture Subheading',
  '',
  '```ts',
  'const payloadFixture = true',
  '```',
  '',
  '![Fixture image](/assets/rich-fixture.png)',
  '',
  '| Column A | Column B |',
  '|---|---|',
  '| alpha | beta |',
  '',
  '> Fixture blockquote',
  '',
  longInlineText,
].join('\n')

export const PUBLIC_PAYLOAD_FIXTURES = [
  {
    id: 'home-empty-disabled-footer',
    route: '/',
    kind: 'Home',
    releaseSubset: true,
    dimensions: [
      'article-list:empty',
      'home-secondary:both-empty',
      'footer:disabled-config',
      'site-title:fallback',
      'logo:absent',
      'payload:optional-values-null',
    ],
    options: commonOptions({
      siteTitle: null,
      siteDescription: null,
      compliance: createCompliance('disabled'),
      articles: [],
      featuredArticles: [],
      hotArticles: [],
      pageIndex: 1,
      pageSize: 8,
      total: 0,
    }),
  },
  {
    id: 'home-one-primary-long-copy',
    route: '/',
    kind: 'Home',
    releaseSubset: true,
    dimensions: [
      'article-list:one-item',
      'article-list:long-title',
      'article-list:long-summary',
      'home-secondary:primary-only',
      'footer:enabled-partial-config',
      'logo:present',
    ],
    options: commonOptions({
      siteLogoUrl: 'https://example.com/assets/logo.svg',
      articles: [articleSummary(1101, { title: longTitle, summary: longSummary })],
      featuredArticles: [featuredArticle(2101)],
      hotArticles: [],
      pageIndex: 1,
      pageSize: 8,
      total: 1,
    }),
  },
  {
    id: 'home-full-last-secondary-boundary',
    route: '/',
    kind: 'Home',
    releaseSubset: true,
    dimensions: [
      'article-list:full-page',
      'article-list:last-page',
      'home-secondary:both-present',
      'home-secondary:boundary-ordering',
      'footer:complete-config',
    ],
    options: commonOptions({
      compliance: createCompliance('complete'),
      articles: repeatedArticles(10, 1200),
      featuredArticles: [featuredArticle(2201), featuredArticle(2202)],
      hotArticles: [hotArticle(2301), hotArticle(2302), hotArticle(2303)],
      pageIndex: 3,
      pageSize: 10,
      total: 30,
    }),
  },
  {
    id: 'home-secondary-only',
    route: '/',
    kind: 'Home',
    releaseSubset: false,
    dimensions: [
      'home-secondary:secondary-only',
    ],
    options: commonOptions({
      articles: repeatedArticles(3, 1300),
      featuredArticles: [],
      hotArticles: [hotArticle(2401), hotArticle(2402)],
      pageIndex: 1,
      pageSize: 8,
      total: 3,
    }),
  },
  {
    id: 'article-minimal-no-tags-no-related',
    route: '/article/3101',
    kind: 'ArticleDetail',
    releaseSubset: true,
    dimensions: [
      'article-detail:minimal',
      'article-detail:no-tags',
      'article-detail:no-related-reading',
      'payload:optional-arrays-missing',
    ],
    options: commonOptions(articleDetail(3101, {
      title: 'Minimal article',
      tags: undefined,
      relatedReading: undefined,
    })),
  },
  {
    id: 'article-rich-many-tags-previous-next',
    route: '/article/3102',
    kind: 'ArticleDetail',
    releaseSubset: true,
    dimensions: [
      'article-detail:rich',
      'article-detail:many-tags',
      'article-detail:previous-next-present',
      'article-body:headings',
      'article-body:code-blocks',
      'article-body:images',
      'article-body:tables',
      'article-body:blockquotes',
      'article-body:long-inline-text',
      'article-body:safe-wrappers',
    ],
    options: commonOptions(articleDetail(3102, {
      title: 'Rich article',
      summary: 'Rich article summary',
      bodyContent: richBody,
      tags: Array.from({ length: 8 }, (_, index) => ({ id: 4000 + index, name: `tag-${index + 1}` })),
      relatedReading: {
        related: [
          articleSummary(3201, { reason: 'related by tag' }),
          articleSummary(3202, { reason: 'same category' }),
        ],
        previous: articleSummary(3200, { reason: 'previous' }),
        next: articleSummary(3203, { reason: 'next' }),
      },
    })),
  },
  {
    id: 'filter-valid-category-flat',
    route: '/category/4101',
    kind: 'Filter',
    releaseSubset: true,
    dimensions: [
      'filter:valid-category',
      'payload:backend-flat-shape',
      'payload:duplicate-scalars-absent',
    ],
    options: commonOptions({
      filterType: 'category',
      filterKey: 'category:4101',
      filterId: 4101,
      filterName: 'Payload Category',
      title: 'Payload Category',
      articles: repeatedArticles(4, 4100),
      pageIndex: 1,
      pageSize: 10,
      total: 4,
      isInvalidTarget: false,
    }),
  },
  {
    id: 'filter-invalid-category-empty',
    route: '/category/0',
    kind: 'Filter',
    releaseSubset: false,
    dimensions: [
      'filter:invalid-category',
      'filter:empty-result',
    ],
    options: commonOptions({
      filter: {
        filterType: 'category',
        filterKey: 'category:0',
        filterId: 0,
        filterName: '',
        articles: [],
        pageIndex: 1,
        pageSize: 10,
        total: 0,
        isInvalidTarget: true,
      },
      title: 'Invalid Category',
    }),
  },
  {
    id: 'filter-valid-tag-by-name-multipage',
    route: '/tag/hydration',
    kind: 'Filter',
    releaseSubset: true,
    dimensions: [
      'filter:valid-tag',
      'filter:tag-by-name',
      'filter:multi-page-result',
    ],
    options: commonOptions({
      filter: {
        filterType: 'tag',
        filterKey: 'tag:hydration',
        filterId: 0,
        filterName: 'hydration',
        articles: repeatedArticles(10, 4200),
        pageIndex: 2,
        pageSize: 10,
        total: 24,
        isInvalidTarget: false,
      },
      title: 'hydration',
    }),
  },
  {
    id: 'filter-invalid-tag',
    route: '/tag/0',
    kind: 'Filter',
    releaseSubset: false,
    dimensions: [
      'filter:invalid-tag',
    ],
    options: commonOptions({
      filter: {
        filterType: 'tag',
        filterKey: 'tag:0',
        filterId: 0,
        filterName: '',
        articles: [],
        pageIndex: 1,
        pageSize: 10,
        total: 0,
        isInvalidTarget: true,
      },
      title: 'Invalid Tag',
    }),
  },
  {
    id: 'archive-empty',
    route: '/archive',
    kind: 'Archive',
    releaseSubset: true,
    dimensions: [
      'archive:empty',
    ],
    options: commonOptions({
      articles: [],
      total: 0,
    }),
  },
  {
    id: 'archive-grouped',
    route: '/archive',
    kind: 'Archive',
    releaseSubset: false,
    dimensions: [
      'archive:grouped',
    ],
    options: commonOptions({
      articles: [
        articleSummary(5101, { createTime: '2026-06-16T12:00:00.000Z' }),
        articleSummary(5102, { createTime: '2026-05-16T12:00:00.000Z' }),
        articleSummary(5103, { createTime: '2025-12-16T12:00:00.000Z' }),
      ],
      total: 3,
    }),
  },
  {
    id: 'archive-large',
    route: '/archive',
    kind: 'Archive',
    releaseSubset: true,
    dimensions: [
      'archive:large',
    ],
    options: commonOptions({
      articles: repeatedArticles(64, 5200, (index) => ({
        createTime: new Date(Date.UTC(2026 - (index % 4), index % 12, 16, 12, 0, 0)).toISOString(),
      })),
      total: 64,
    }),
  },
  {
    id: 'static-empty',
    route: '/about',
    kind: 'About',
    releaseSubset: true,
    dimensions: [
      'static:empty-content',
    ],
    options: commonOptions({
      title: 'About Empty',
      slug: 'about',
      content: '',
    }),
  },
  {
    id: 'static-normal',
    route: '/privacy',
    kind: 'Privacy',
    releaseSubset: false,
    dimensions: [
      'static:normal-content',
    ],
    options: commonOptions({
      title: 'Privacy',
      slug: 'privacy',
      content: 'Normal static page content.',
    }),
  },
  {
    id: 'static-long',
    route: '/guidelines',
    kind: 'Guidelines',
    releaseSubset: true,
    dimensions: [
      'static:long-content',
    ],
    options: commonOptions({
      title: 'Guidelines',
      slug: 'guidelines',
      content: Array.from({ length: 16 }, (_, index) => `## Section ${index + 1}\n\nLong static payload content ${index + 1}.`).join('\n\n'),
    }),
  },
  {
    id: 'static-copyright',
    route: '/copyright',
    kind: 'Copyright',
    releaseSubset: false,
    dimensions: [
      'static:normal-content',
    ],
    options: commonOptions({
      title: 'Copyright',
      slug: 'copyright',
      content: 'Copyright fixture content.',
    }),
  },
]

function buildDocument(entry) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(entry.title ?? 'Payload fixture')}</title>
</head>
<body>
  <div id="app">${entry.html}</div>
  <script id="fsus-aot-bootstrap" type="application/octet-stream">${entry.bootstrapPayload}</script>
  <script id="fsus-aot-hydration-props" type="application/octet-stream">${entry.hydrationPropsPayload}</script>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

async function inspectEntryInBrowser(entry, fixture) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  })
  const context = await browser.newContext({
    javaScriptEnabled: true,
    locale: 'en-US',
    timezoneId: 'UTC',
  })
  const page = await context.newPage()
  const consoleIssues = []
  page.on('console', (msg) => {
    const text = msg.text()
    const type = msg.type()
    if ((type === 'warn' || type === 'warning' || type === 'error') && isHydrationIssue(text)) {
      consoleIssues.push({ type: type === 'warn' ? 'warning' : type, text: text.slice(0, 500) })
    }
  })
  page.on('pageerror', (error) => {
    const text = error.message
    if (isHydrationIssue(text)) {
      consoleIssues.push({ type: 'error', text: text.slice(0, 500) })
    }
  })

  try {
    await page.setContent(buildDocument(entry), { waitUntil: 'domcontentloaded' })
    const snapshot = await page.evaluate(() => {
      const shell = document.querySelector('#app > #fsus-aot-shell')
      const articleBodySection = document.querySelector('section[itemprop="articleBody"]')
      const markdownBody = articleBodySection?.querySelector('.markdown-body')
      const staticMarkdown = document.querySelector('article .blog-markdown-renderer.markdown-body')
      const staticRenderedBody = staticMarkdown?.querySelector('[role="article"]')
      const footer = document.querySelector('.el-public-shell__footer')
      const logo = document.querySelector('.el-public-shell__brand img, .el-public-shell__brand picture img')
      return {
        appCount: document.querySelectorAll('#app').length,
        shellCount: document.querySelectorAll('#fsus-aot-shell').length,
        shellKind: shell?.getAttribute('data-public-hydration-kind') ?? null,
        shellChildElementCount: shell?.children.length ?? 0,
        documentTitle: document.title,
        footerText: footer?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
        hasLogo: Boolean(logo),
        articleListItemCount: document.querySelectorAll('.public-article-list article, .public-article-list a[href^="/article/"], a[href^="/article/"]').length,
        relatedPreviousCount: document.querySelectorAll('[data-related-role="previous"]').length,
        relatedNextCount: document.querySelectorAll('[data-related-role="next"]').length,
        relatedItemCount: document.querySelectorAll('[data-related-role="related"]').length,
        articleBody: {
          hasSection: Boolean(articleBodySection),
          wrapperClass: markdownBody?.getAttribute('class') ?? '',
          role: markdownBody?.getAttribute('role') ?? '',
          hasMarkdownBody: Boolean(markdownBody),
          hasSafeWrap: markdownBody?.classList.contains('safe-inline-wrap') ?? false,
          headingCount: articleBodySection?.querySelectorAll('h1,h2,h3').length ?? 0,
          codeBlockCount: articleBodySection?.querySelectorAll('pre, code').length ?? 0,
          imageCount: articleBodySection?.querySelectorAll('img').length ?? 0,
          tableCount: articleBodySection?.querySelectorAll('table').length ?? 0,
          blockquoteCount: articleBodySection?.querySelectorAll('blockquote').length ?? 0,
          textLength: articleBodySection?.textContent?.length ?? 0,
        },
        staticBody: {
          hasMarkdownBody: Boolean(staticMarkdown),
          role: staticRenderedBody?.getAttribute('role') ?? '',
          textLength: staticRenderedBody?.textContent?.length ?? 0,
        },
      }
    })
    assert(consoleIssues.length === 0, `${fixture.id} hydration console issue: ${consoleIssues[0]?.text}`)
    return snapshot
  } finally {
    await context.close()
    await browser.close()
  }
}

function assertPayloadIdentity(fixture, entry, hydrationPayload, bootstrapPayload, domSnapshot) {
  assert(domSnapshot.appCount === 1, `${fixture.id} #app count mismatch`)
  assert(domSnapshot.shellCount === 1, `${fixture.id} #fsus-aot-shell count mismatch`)
  assert(domSnapshot.shellKind === fixture.kind, `${fixture.id} shell kind mismatch: ${domSnapshot.shellKind}`)
  assert(hydrationPayload.pageKind === fixture.kind, `${fixture.id} hydration pageKind mismatch`)
  assert(bootstrapPayload.pageKind === fixture.kind || bootstrapPayload.kind === fixture.kind, `${fixture.id} bootstrap pageKind mismatch`)
  assert(hydrationPayload.routeKey === entry.routeKey, `${fixture.id} hydration routeKey mismatch`)
  assert(bootstrapPayload.routeKey === entry.routeKey, `${fixture.id} bootstrap routeKey mismatch`)
  assert(Number.isInteger(entry.pageId) && entry.pageId > 0, `${fixture.id} invalid page id`)
  assert(typeof entry.title === 'string' && entry.title.length > 0, `${fixture.id} missing entry title`)
  assert(domSnapshot.documentTitle === entry.title, `${fixture.id} head/title metadata drift`)
  assert(hydrationPayload.renderTimestamp === RENDER_TIMESTAMP, `${fixture.id} hydration render timestamp mismatch`)
  assert(bootstrapPayload.renderTimestamp === RENDER_TIMESTAMP, `${fixture.id} bootstrap render timestamp mismatch`)
}

function assertHomeFixture(fixture, hydrationPayload, bootstrapPayload, domSnapshot) {
  if (fixture.kind !== 'Home') return null

  assert(Array.isArray(hydrationPayload.view?.items), `${fixture.id} missing hydration home items`)
  assert(Array.isArray(bootstrapPayload.articles), `${fixture.id} missing bootstrap home articles`)
  assert(Array.isArray(hydrationPayload.featuredArticles), `${fixture.id} missing hydration featured articles`)
  assert(Array.isArray(hydrationPayload.hotArticles), `${fixture.id} missing hydration hot articles`)
  assert(hydrationPayload.view.items.length === bootstrapPayload.articles.length, `${fixture.id} SSR/hydration article count drift`)
  if (fixture.dimensions.includes('home-secondary:both-empty')) {
    assert(hydrationPayload.featuredArticles.length === 0 && hydrationPayload.hotArticles.length === 0, `${fixture.id} expected empty secondary sections`)
  }
  if (fixture.dimensions.includes('home-secondary:primary-only')) {
    assert(hydrationPayload.featuredArticles.length > 0 && hydrationPayload.hotArticles.length === 0, `${fixture.id} expected primary-only secondary state`)
  }
  if (fixture.dimensions.includes('home-secondary:secondary-only')) {
    assert(hydrationPayload.featuredArticles.length === 0 && hydrationPayload.hotArticles.length > 0, `${fixture.id} expected secondary-only state`)
  }
  if (fixture.dimensions.includes('home-secondary:both-present')) {
    assert(hydrationPayload.featuredArticles.length > 0 && hydrationPayload.hotArticles.length > 0, `${fixture.id} expected both secondary sections`)
  }
  if (fixture.dimensions.includes('home-secondary:boundary-ordering')) {
    assert(hydrationPayload.view.pagination.indicator === '3 / 3', `${fixture.id} last-page pagination drift`)
    assert(hydrationPayload.featuredArticles[0]?.id < hydrationPayload.hotArticles[0]?.id, `${fixture.id} secondary ordering fixture drift`)
  }
  if (fixture.dimensions.includes('logo:present')) {
    assert(domSnapshot.hasLogo, `${fixture.id} expected visible logo`)
  }
  if (fixture.dimensions.includes('logo:absent')) {
    assert(!domSnapshot.hasLogo, `${fixture.id} expected logo absence`)
  }
  return {
    itemCount: hydrationPayload.view.items.length,
    featuredCount: hydrationPayload.featuredArticles.length,
    hotCount: hydrationPayload.hotArticles.length,
    pagination: hydrationPayload.view.pagination.indicator,
  }
}

function assertArticleFixture(fixture, hydrationPayload, bootstrapPayload, domSnapshot) {
  if (fixture.kind !== 'ArticleDetail') return null

  assert(hydrationPayload.articleId === bootstrapPayload.article.id, `${fixture.id} article id drift`)
  assert(hydrationPayload.title === bootstrapPayload.article.title, `${fixture.id} article title drift`)
  assert(typeof hydrationPayload.bodyHtml === 'string', `${fixture.id} missing bodyHtml`)
  assert(hydrationPayload.bodyContent === bootstrapPayload.article.content, `${fixture.id} article body content drift`)
  assert(hydrationPayload.rights?.policyHash === bootstrapPayload.article.rights?.policyHash, `${fixture.id} article rights policy hash drift`)
  assert(hydrationPayload.detailView?.rights?.contentCanonicalHash === bootstrapPayload.article.rights?.contentCanonicalHash, `${fixture.id} article detail rights hash drift`)
  assert(Array.isArray(bootstrapPayload.relatedReading?.related), `${fixture.id} missing normalized relatedReading.related`)

  if (fixture.dimensions.includes('article-detail:no-tags')) {
    assert(Array.isArray(bootstrapPayload.article.tags) && bootstrapPayload.article.tags.length === 0, `${fixture.id} expected no tags`)
  }
  if (fixture.dimensions.includes('article-detail:many-tags')) {
    assert(bootstrapPayload.article.tags.length >= 8, `${fixture.id} expected many tags`)
  }
  if (fixture.dimensions.includes('article-detail:no-related-reading')) {
    assert(bootstrapPayload.relatedReading.related.length === 0 && bootstrapPayload.relatedReading.previous === null && bootstrapPayload.relatedReading.next === null, `${fixture.id} expected no related reading`)
  }
  if (fixture.dimensions.includes('article-detail:previous-next-present')) {
    assert(bootstrapPayload.relatedReading.previous && bootstrapPayload.relatedReading.next, `${fixture.id} expected previous/next related reading`)
    assert(domSnapshot.relatedPreviousCount === 1 && domSnapshot.relatedNextCount === 1, `${fixture.id} previous/next DOM drift`)
  }
  if (fixture.dimensions.includes('article-detail:rich')) {
    assert(hydrationPayload.bodyHtml !== hydrationPayload.bodyContent, `${fixture.id} payload normalization did not render rich markdown`)
    for (const token of ['<h1', '<h2', '<table', '<blockquote', '<img']) {
      assert(hydrationPayload.bodyHtml.includes(token), `${fixture.id} rich body missing token ${token}`)
    }
    assert(domSnapshot.articleBody.hasMarkdownBody, `${fixture.id} rich article body keeps wrapper, role, class contract: missing markdown body`)
    assert(domSnapshot.articleBody.hasSafeWrap, `${fixture.id} rich article body keeps wrapper, role, class contract: missing safe wrapper`)
    assert(domSnapshot.articleBody.headingCount >= 2, `${fixture.id} rich body heading drift`)
    assert(domSnapshot.articleBody.imageCount >= 1, `${fixture.id} rich body image drift`)
    assert(domSnapshot.articleBody.tableCount >= 1, `${fixture.id} rich body table drift`)
    assert(domSnapshot.articleBody.blockquoteCount >= 1, `${fixture.id} rich body blockquote drift`)
    assert(domSnapshot.articleBody.textLength >= longInlineText.length, `${fixture.id} long inline text drift`)
  }

  return {
    articleId: hydrationPayload.articleId,
    tagCount: bootstrapPayload.article.tags.length,
    relatedCount: bootstrapPayload.relatedReading.related.length,
    bodyHtmlLength: hydrationPayload.bodyHtml.length,
  }
}

function assertFilterFixture(fixture, hydrationPayload, bootstrapPayload) {
  if (fixture.kind !== 'Filter') return null

  assert(hydrationPayload.filter && bootstrapPayload.filter, `${fixture.id} missing filter payload`)
  assert(hydrationPayload.filter.filterType === bootstrapPayload.filter.filterType, `${fixture.id} filter type drift`)
  assert(Array.isArray(hydrationPayload.filter.articles), `${fixture.id} missing hydration filter articles`)
  assert(Array.isArray(bootstrapPayload.filter.articles), `${fixture.id} missing bootstrap filter articles`)
  assert(hydrationPayload.filter.articles.length === bootstrapPayload.filter.articles.length, `${fixture.id} filter article count drift`)
  if (fixture.dimensions.includes('payload:duplicate-scalars-absent')) {
    for (const duplicateKey of ['filterType', 'filterId', 'filterName', 'articles', 'pageIndex', 'pageSize', 'total']) {
      assert(!(duplicateKey in hydrationPayload), `${fixture.id} duplicate scalar field present in hydration payload: ${duplicateKey}`)
      assert(!(duplicateKey in bootstrapPayload), `${fixture.id} duplicate scalar field present in bootstrap payload: ${duplicateKey}`)
    }
  }
  if (fixture.dimensions.includes('filter:invalid-category') || fixture.dimensions.includes('filter:invalid-tag')) {
    assert(hydrationPayload.filter.isInvalidTarget === true, `${fixture.id} expected invalid filter target`)
  }
  if (fixture.dimensions.includes('filter:multi-page-result')) {
    assert(hydrationPayload.filter.total > hydrationPayload.filter.pageSize, `${fixture.id} expected multi-page filter result`)
    assert(hydrationPayload.view.pagination.totalPages > 1, `${fixture.id} expected multi-page view contract`)
  }
  return {
    filterType: hydrationPayload.filter.filterType,
    filterName: hydrationPayload.filter.filterName,
    articleCount: hydrationPayload.filter.articles.length,
    total: hydrationPayload.filter.total,
    invalid: hydrationPayload.filter.isInvalidTarget,
  }
}

function assertArchiveFixture(fixture, hydrationPayload, bootstrapPayload) {
  if (fixture.kind !== 'Archive') return null

  assert(Array.isArray(hydrationPayload.articles), `${fixture.id} missing archive articles`)
  assert(Array.isArray(bootstrapPayload.articles), `${fixture.id} missing bootstrap archive articles`)
  assert(hydrationPayload.articles.length === bootstrapPayload.articles.length, `${fixture.id} archive article count drift`)
  assert(Array.isArray(hydrationPayload.view?.yearGroups), `${fixture.id} missing archive year groups`)
  if (fixture.dimensions.includes('archive:empty')) {
    assert(hydrationPayload.view.yearGroups.length === 0, `${fixture.id} expected empty archive`)
  }
  if (fixture.dimensions.includes('archive:grouped')) {
    assert(hydrationPayload.view.yearGroups.length >= 2, `${fixture.id} expected grouped archive years`)
  }
  if (fixture.dimensions.includes('archive:large')) {
    assert(hydrationPayload.articles.length >= 60, `${fixture.id} expected large archive`)
  }
  return {
    articleCount: hydrationPayload.articles.length,
    yearGroupCount: hydrationPayload.view.yearGroups.length,
  }
}

function assertStaticFixture(fixture, hydrationPayload, bootstrapPayload, domSnapshot) {
  if (!['About', 'Privacy', 'Guidelines', 'Copyright'].includes(fixture.kind)) return null

  assert(hydrationPayload.title === bootstrapPayload.title, `${fixture.id} static title drift`)
  assert(hydrationPayload.bodyHtml === bootstrapPayload.bodyHtml, `${fixture.id} static bodyHtml drift`)
  assert(hydrationPayload.staticPage.slug === bootstrapPayload.staticPage.slug, `${fixture.id} static slug drift`)
  if (fixture.dimensions.includes('static:empty-content')) {
    assert(hydrationPayload.staticPage.content === '', `${fixture.id} expected empty static content`)
  } else {
    assert(domSnapshot.staticBody.hasMarkdownBody, `${fixture.id} missing static markdown wrapper`)
    assert(domSnapshot.staticBody.role === 'article', `${fixture.id} static wrapper role drift`)
  }
  if (fixture.dimensions.includes('static:long-content')) {
    assert(hydrationPayload.staticPage.content.length > 400, `${fixture.id} expected long static content`)
  }
  return {
    slug: hydrationPayload.staticPage.slug,
    contentLength: hydrationPayload.staticPage.content.length,
    bodyHtmlLength: hydrationPayload.bodyHtml.length,
  }
}

function assertFooterFixture(fixture, entry, hydrationPayload, domSnapshot) {
  if (fixture.dimensions.includes('footer:disabled-config')) {
    assert(hydrationPayload.compliance === null || hydrationPayload.compliance.enabled === false, `${fixture.id} expected disabled footer config`)
  }
  if (fixture.dimensions.includes('footer:enabled-partial-config')) {
    assert(hydrationPayload.compliance?.enabled === true, `${fixture.id} expected enabled partial footer config`)
  }
  if (fixture.dimensions.includes('footer:complete-config')) {
    assert(hydrationPayload.compliance?.enabled === true, `${fixture.id} expected complete footer config`)
    assert(domSnapshot.footerText.includes('Fixture Owner'), `${fixture.id} complete footer output drift`)
  }
  if (fixture.dimensions.includes('site-title:fallback')) {
    assert(typeof hydrationPayload.siteTitle === 'string' && hydrationPayload.siteTitle.length > 0, `${fixture.id} site-title fallback output is not deterministic`)
    assert(hydrationPayload.title === entry.title && hydrationPayload.siteTitle === entry.title, `${fixture.id} site-title fallback drifted from entry title`)
  }
}

async function runFixture(bundle, fixture) {
  const result = await bundle.buildPublicEntry(fixture.kind, fixture.options)
  const entry = result.entry
  const hydrationPayload = decodePublicAotPayload(entry.hydrationPropsPayload)
  const bootstrapPayload = decodePublicAotPayload(entry.bootstrapPayload)
  const domSnapshot = await inspectEntryInBrowser(entry, fixture)

  assertPayloadIdentity(fixture, entry, hydrationPayload, bootstrapPayload, domSnapshot)
  assertFooterFixture(fixture, entry, hydrationPayload, domSnapshot)

  const details = {
    home: assertHomeFixture(fixture, hydrationPayload, bootstrapPayload, domSnapshot),
    article: assertArticleFixture(fixture, hydrationPayload, bootstrapPayload, domSnapshot),
    filter: assertFilterFixture(fixture, hydrationPayload, bootstrapPayload),
    archive: assertArchiveFixture(fixture, hydrationPayload, bootstrapPayload),
    staticPage: assertStaticFixture(fixture, hydrationPayload, bootstrapPayload, domSnapshot),
  }

  return {
    id: fixture.id,
    route: fixture.route,
    kind: fixture.kind,
    routeKey: entry.routeKey,
    pageId: entry.pageId,
    releaseSubset: fixture.releaseSubset,
    status: 'success',
    assertions: [
      'no fatal hydration warning/error',
      'page kind, route key, and page id agree',
      'optional sections keep SSR/hydration structure',
      'optional arrays missing cases are allowlisted explicitly',
      'payload normalization preserves required data unless allowlisted',
      'rich article body keeps wrapper, role, class contract',
      'footer/site-title fallback deterministic',
      'head/title metadata matches payload values',
    ],
    dimensions: fixture.dimensions,
    details,
  }
}

async function main() {
  const coverage = {
    requiredDimensions: REQUIRED_DIMENSIONS,
    dimensions: [],
    missingDimensions: REQUIRED_DIMENSIONS,
    releaseSubsetFixtureCount: 0,
    nightlySubsetFixtureCount: 0,
  }
  const summary = {
    schema: PAYLOAD_FIXTURE_SCHEMA,
    status: 'failure',
    generatedAt: new Date().toISOString(),
    coverage,
    fixtures: [],
  }

  try {
    const bundle = await loadSsrBundle()
    const coveredDimensions = new Set()
    for (const fixture of PUBLIC_PAYLOAD_FIXTURES) {
      process.stdout.write(`Testing payload fixture ${fixture.id}... `)
      const row = await runFixture(bundle, fixture)
      summary.fixtures.push(row)
      for (const dimension of fixture.dimensions) {
        coveredDimensions.add(dimension)
      }
      process.stdout.write('PASS\n')
    }

    coverage.dimensions = Array.from(coveredDimensions).sort()
    coverage.missingDimensions = REQUIRED_DIMENSIONS.filter((dimension) => !coveredDimensions.has(dimension))
    coverage.releaseSubsetFixtureCount = PUBLIC_PAYLOAD_FIXTURES.filter((fixture) => fixture.releaseSubset).length
    coverage.nightlySubsetFixtureCount = PUBLIC_PAYLOAD_FIXTURES.filter((fixture) => !fixture.releaseSubset).length

    assert(coverage.missingDimensions.length === 0, `missing payload fixture dimensions: ${coverage.missingDimensions.join(', ')}`)
    assert(summary.fixtures.length > 0, 'payload fixture catalog is empty')
    assert(coverage.releaseSubsetFixtureCount > 0 && coverage.nightlySubsetFixtureCount > 0, 'fixture catalog must declare release and nightly subsets')

    summary.status = 'success'
    writeSummary(summary)
    console.log(`[public-payload-fixture-hydration] ok (${summary.fixtures.length} fixture(s)); summary=${PAYLOAD_FIXTURE_SUMMARY_FILE}`)
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
    writeSummary(summary)
    console.error(`[public-payload-fixture-hydration] failed: ${summary.error}`)
    process.exit(1)
  }
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
}

if (isMainModule()) {
  main()
}
