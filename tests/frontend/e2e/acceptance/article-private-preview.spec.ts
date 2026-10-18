import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import {
  adminName,
  adminPassword,
  assertNoHorizontalOverflow,
  assertThemeReadable,
  captureStorageState,
  ensureThemeApplied,
  openAuditedPage,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

const draftStorageKey = 'fsus:article-draft:create'
const draftEndpoint = '/api/author/drafts/fsus%3Aarticle-draft%3Acreate'
const previewEndpointPattern = '**/api/binary/author/preview'
const previewMarkdown = [
  '| column | value |',
  '| --- | --- |',
  '| browser table | complete |',
  '',
  '```ts',
  'const browserPreview = 42',
  '```',
  '',
  '$$E = mc^2$$',
  '',
  '```mermaid',
  'graph TD; Preview-->Complete',
  '```',
  '',
  '<script>steal()</script>',
  '<img src=x onerror=steal()>',
  '<svg onload=steal()></svg>',
  '<iframe srcdoc="<script>steal()</script>"></iframe>'
].join('\n')
const previewIdentityPattern = /^preview:sha256:[a-f0-9]{64}$/u

let adminStorageStatePromise: Promise<Awaited<ReturnType<typeof captureStorageState>>> | null = null

async function clearCreateDraft(page: Page): Promise<void> {
  await page.evaluate(async ({ endpoint, storageKey }) => {
    localStorage.removeItem(storageKey)
    await fetch(endpoint, {
      method: 'DELETE',
      credentials: 'include',
      headers: { Accept: 'application/json' }
    })
  }, { endpoint: draftEndpoint, storageKey: draftStorageKey })
}

async function openPrivatePreview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.locator('[data-inspector-view="preview"]')).toBeVisible()
  await expect(page.getByRole('button', { name: '生成私有预览', exact: true })).toBeVisible()
}

async function generatePrivatePreview(page: Page): Promise<string> {
  await page.getByRole('button', { name: '生成私有预览', exact: true }).click()
  const article = page.locator('[data-inspector-view="preview"] .author-preview')
  await expect(article).toHaveAttribute('data-preview-source-identity', previewIdentityPattern, {
    timeout: 45_000
  })
  const identity = await article.getAttribute('data-preview-source-identity')
  expect(identity).toMatch(previewIdentityPattern)
  await expect(article).toHaveAttribute('data-preview-render-complete', identity!, {
    timeout: 45_000
  })
  return identity!
}

async function captureRenderedEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const output = testInfo.outputPath(`${name}.png`)
  await page.screenshot({
    path: output,
    animations: 'disabled',
    fullPage: false
  })
  await testInfo.attach(name, {
    path: output,
    contentType: 'image/png'
  })
}

test.describe('article private preview browser contract', () => {
  test.describe.configure({ timeout: 180_000 })

  test('renders current structured Markdown while stale responses and hostile markup stay inert', async ({
    browser
  }, testInfo) => {
    adminStorageStatePromise ??= captureStorageState(browser, adminName, adminPassword, '/user/manage/article/write')
    const session = await openAuditedPage(browser, await adminStorageStatePromise)
    const dialogs: string[] = []
    const unsafeRequests: string[] = []

    session.page.on('dialog', (dialog) => {
      dialogs.push(`${dialog.type()}:${dialog.message()}`)
      void dialog.dismiss()
    })
    session.page.on('request', (request) => {
      if (/^(?:javascript:|vbscript:|data:text\/html)/iu.test(request.url())) {
        unsafeRequests.push(request.url())
      }
    })

    try {
      await session.page.goto('/user/manage/article/write', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)
      await clearCreateDraft(session.page)
      await session.page.reload({ waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      const auditStart = session.audit.checkpoint()
      const titleInput = session.page.getByPlaceholder('在此键入博文标题...')
      const editor = session.page.getByRole('textbox', { name: 'Markdown 正文编辑区' })
      await titleInput.fill(`Private preview browser <img src=x onerror=steal()> ${Date.now()}`)
      await editor.fill(previewMarkdown)
      await expect(editor).toHaveValue(previewMarkdown)

      const previewUrl = session.page.url()
      const unexpectedNavigations: string[] = []
      session.page.on('framenavigated', (frame) => {
        if (frame === session.page.mainFrame() && frame.url() !== previewUrl) {
          unexpectedNavigations.push(frame.url())
        }
      })

      await openPrivatePreview(session.page)
      const firstIdentity = await generatePrivatePreview(session.page)
      const previewArticle = session.page.locator('[data-inspector-view="preview"] .author-preview')
      const renderer = previewArticle.locator('.markdown-renderer__body').first()
      await expect(renderer).toBeVisible({ timeout: 45_000 })
      await expect(previewArticle.locator('.markdown-renderer__error')).toHaveCount(0)
      await expect(previewArticle.getByRole('heading', { level: 1 })).toContainText(
        '<img src=x onerror=steal()>'
      )
      await expect(renderer.locator('table')).toBeVisible()
      await expect(renderer.locator('pre code')).toContainText('const browserPreview = 42')
      await expect(renderer.locator('.katex')).toBeVisible()
      await expect(renderer.locator('.markdown-renderer__mermaid svg')).toBeVisible()
      await expect(renderer.locator('[data-latex-placeholder], [data-mermaid-placeholder]')).toHaveCount(0)
      await expect(renderer.locator('[data-markdown-feature-activated="latex"]')).toHaveCount(1)
      await expect(renderer.locator('[data-markdown-feature-activated="mermaid"]')).toHaveCount(1)

      await expect(renderer.locator('script, iframe, object, embed, base, form')).toHaveCount(0)
      await expect(renderer.locator('[srcdoc]')).toHaveCount(0)
      expect(await renderer.locator('*').evaluateAll((elements) =>
        elements.flatMap((element) => [...element.attributes]
          .map((attribute) => attribute.name)
          .filter((name) => name.toLowerCase().startsWith('on')))
      )).toEqual([])
      expect(await renderer.locator('[href], [src]').evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('href') || element.getAttribute('src') || '')
          .filter((value) => /^(?:javascript:|vbscript:|data:text\/html)/iu.test(value.trim()))
      )).toEqual([])
      expect(dialogs).toEqual([])
      expect(unsafeRequests).toEqual([])
      expect(unexpectedNavigations).toEqual([])
      expect(session.page.url()).toBe(previewUrl)

      let resolveHeldResponse: (() => void) | null = null
      const releaseHeldResponse = () => resolveHeldResponse?.()
      const heldResponseRelease = new Promise<void>((resolve) => {
        resolveHeldResponse = resolve
      })
      let markResponseHeld: (() => void) | null = null
      const responseHeld = new Promise<void>((resolve) => {
        markResponseHeld = resolve
      })
      let intercepted = false
      await session.page.route(previewEndpointPattern, async (route) => {
        if (intercepted || route.request().method() !== 'POST') {
          await route.continue()
          return
        }
        intercepted = true
        const response = await route.fetch()
        markResponseHeld?.()
        await heldResponseRelease
        await route.fulfill({ response })
      })

      const staleMarkdown = previewMarkdown.replace(
        'const browserPreview = 42',
        'const staleBrowserPreview = 41'
      )
      const currentMarkdown = previewMarkdown.replace(
        'const browserPreview = 42',
        'const currentBrowserPreview = 43'
      )
      await editor.fill(staleMarkdown)
      await session.page.getByRole('button', { name: '生成私有预览', exact: true }).click()
      await responseHeld
      await editor.fill(currentMarkdown)
      releaseHeldResponse()
      await expect(session.page.getByRole('button', {
        name: '生成私有预览',
        exact: true
      })).toBeEnabled({ timeout: 45_000 })
      await session.page.unroute(previewEndpointPattern)

      await expect(previewArticle).toHaveAttribute('data-preview-source-identity', firstIdentity)
      await expect(previewArticle).toHaveAttribute('data-preview-render-complete', firstIdentity)
      await expect(renderer).toContainText('const browserPreview = 42')
      await expect(renderer).not.toContainText('const staleBrowserPreview = 41')

      const currentIdentity = await generatePrivatePreview(session.page)
      expect(currentIdentity).not.toBe(firstIdentity)
      await expect(renderer).toContainText('const currentBrowserPreview = 43')
      const renderMarkdownIdentity = await previewArticle.getAttribute(
        'data-preview-render-markdown-identity'
      )
      const activationMarkdownIdentity = await previewArticle.getAttribute(
        'data-preview-activation-markdown-identity'
      )
      expect(renderMarkdownIdentity).toMatch(/^markdown:/u)
      expect(activationMarkdownIdentity).toBe(renderMarkdownIdentity)
      expect(currentIdentity).not.toBe(renderMarkdownIdentity)

      await assertThemeReadable(session.page, 'light', 'private preview wide light')
      await assertNoHorizontalOverflow(session.page, 4)
      await captureRenderedEvidence(
        session.page,
        testInfo,
        'article-private-preview-wide-light'
      )

      await session.page.setViewportSize({ width: 390, height: 844 })
      await ensureThemeApplied(session.page, 'dark')
      await expect(session.page.locator('[data-inspector-view="preview"]')).toBeVisible()
      await assertThemeReadable(session.page, 'dark', 'private preview mobile dark')
      await assertNoHorizontalOverflow(session.page, 6)
      await captureRenderedEvidence(
        session.page,
        testInfo,
        'article-private-preview-mobile-dark'
      )

      session.audit.assertCleanSince(auditStart, 'article-private-preview-browser')
    } finally {
      await clearCreateDraft(session.page).catch(() => {})
      await session.close()
    }
  })
})
