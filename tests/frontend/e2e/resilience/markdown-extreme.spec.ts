import { test, expect } from '@playwright/test'
import {
  MOBILE_VIEWPORT,
  adminName,
  adminPassword,
  assertElementHitTarget,
  assertNoHorizontalOverflow,
  captureStorageState,
  openAuditedPage,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

const EXTREME_SIZE = Number(process.env.FSUSBLOG_MARKDOWN_EXTREME_SIZE || '500000')

function normalizeExtremeSize(value: number): number {
  return Number.isFinite(value) && value >= 10_000 ? Math.floor(value) : 500_000
}

function buildMarkdownExtremeCorpus(targetSize = EXTREME_SIZE): string {
  const normalizedTargetSize = normalizeExtremeSize(targetSize)
  const parts = [
    '\uFEFF# Markdown Extreme Editor Corpus',
    '',
    'Intro with **strong**, *emphasis*, `inline code`, [long link](https://example.com/path?q=markdown), 中文、かな、한글 and escaped HTML.',
    '<script>alert("xss")</script><img src=x onerror=alert(1)>',
    '',
    '| A | B | C |',
    '| --- | ---: | :--- |',
    '| left | 42 | right |',
    '',
    '```mermaid',
    'flowchart LR;',
    'A["Alpha Node"] --> B("Beta Branch");',
    'B --> C[Gamma End];',
    '```',
    '',
    ':::mermaid',
    'flowchart TD;',
    'Root["Root"] --> Leaf("Leaf");',
    ':::',
    '',
    'Inline math \\(x_1^2 + \\alpha + \\sqrt{b}\\).',
    '$$',
    '\\frac{a_1^2 + \\sqrt{b}}{\\alpha + 2}',
    '$$',
    '',
    '```',
    'unterminated fence sentinel'
  ]

  let section = 0
  while (parts.join('\n').length < normalizedTargetSize) {
    section += 1
    parts.push([
      '',
      `## Editor Boundary Section ${section}`,
      `Paragraph ${section} ${'longword'.repeat((section % 9) + 1)} with inline math \\(n_${section}^2 + \\beta\\).`,
      section % 7 === 0
        ? '```mermaid\nflowchart LR;\nN' + section + '["Node ' + section + '"] --> M' + section + '("Next");\n```'
        : '- list item alpha\n- list item beta\n- list item gamma',
      section % 11 === 0 ? '$$\n\\sum_{i=1}^{n} \\frac{i^2}{n}\n$$' : '| a | b |\n| --- | --- |\n| 1 | 2 |',
      `Unsafe probe ${section}: <iframe src="javascript:alert(${section})"></iframe>`
    ].join('\n'))
  }

  let corpus = parts.join('\n').slice(0, normalizedTargetSize + 4096)
  while (corpus.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').length < normalizedTargetSize) {
    section += 1
    corpus += `\n\nPadding boundary ${section}: ${'pad'.repeat(64)}`
  }
  return corpus
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

let adminStorageStatePromise: Promise<Awaited<ReturnType<typeof captureStorageState>>> | null = null

test.describe('markdown extreme editor resilience', () => {
  test.use({ viewport: MOBILE_VIEWPORT })
  test.describe.configure({ timeout: 420_000 })

  test('500k markdown latex mermaid draft preview and restore stay stable', async ({ browser }) => {
    adminStorageStatePromise ??= captureStorageState(browser, adminName, adminPassword, '/user/manage/article/write')
    const storageState = await adminStorageStatePromise
    const source = buildMarkdownExtremeCorpus()
    const expectedHash = fnv1a32(source)
    const session = await openAuditedPage(browser, storageState)

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/user/manage/article/write', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)
      await assertNoHorizontalOverflow(session.page, 8)
      await session.page.evaluate(async () => {
        localStorage.removeItem('fsus:article-draft:create')
        await fetch('/api/author/drafts/fsus%3Aarticle-draft%3Acreate', {
          method: 'DELETE',
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
      })
      await session.page.reload({ waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      const titleInput = session.page.getByPlaceholder('在此键入博文标题...')
      const editor = session.page.getByRole('textbox', { name: 'Markdown 正文编辑区' })
      await titleInput.fill(`Markdown Extreme ${Date.now()}`)
      await editor.evaluate((textarea, value) => {
        const target = textarea as HTMLTextAreaElement
        target.value = value
        target.dispatchEvent(new Event('input', { bubbles: true }))
      }, source)

      await expect(editor).toHaveValue(source, { timeout: 20_000 })
      await expect(session.page.getByText(`字 ${source.length}`)).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(async () => await session.page.evaluate(() => Boolean(localStorage.getItem('fsus:article-draft:create'))), {
          message: 'extreme draft should be written to localStorage',
          timeout: 20_000
        })
        .toBe(true)

      const previewButton = session.page.getByRole('button', { name: '预览' }).first()
      await assertElementHitTarget(session.page, previewButton, 'extreme markdown preview switch')
      await previewButton.click()
      await expect(
        session.page.locator('.preview-panel .markdown-renderer__body, .preview-panel .markdown-renderer__error').first()
      ).toBeVisible({ timeout: 45_000 })
      await assertNoHorizontalOverflow(session.page, 8)

      await session.page.reload({ waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)
      const restoreDraftButton = session.page.getByRole('button', { name: /恢复(本地缓存|服务端草稿)/ })
      await expect(restoreDraftButton).toBeVisible({ timeout: 20_000 })
      await restoreDraftButton.click()
      await expect(editor).toHaveValue(source, { timeout: 20_000 })
      const restoredHash = await editor.evaluate((textarea) => {
        const value = (textarea as HTMLTextAreaElement).value
        let hash = 0x811c9dc5
        for (let index = 0; index < value.length; index += 1) {
          hash ^= value.charCodeAt(index)
          hash = Math.imul(hash, 0x01000193) >>> 0
        }
        return hash.toString(16).padStart(8, '0')
      })
      expect(restoredHash).toBe(expectedHash)

      await session.page.reload({ waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)
      const discardDraftButton = session.page.getByRole('button', { name: /丢弃(缓存|服务端草稿)/ })
      await expect(discardDraftButton).toBeVisible({ timeout: 20_000 })
      await discardDraftButton.click()
      await expect(session.page.getByRole('button', { name: /恢复(本地缓存|服务端草稿)/ })).toHaveCount(0)
      await expect
        .poll(async () => await session.page.evaluate(() => localStorage.getItem('fsus:article-draft:create')), {
          message: 'extreme draft should be removed after discard',
          timeout: 10_000
        })
        .toBeNull()

      session.audit.assertCleanSince(start, 'markdown-extreme-editor')
    } finally {
      await session.page.evaluate(async () => {
        localStorage.removeItem('fsus:article-draft:create')
        await fetch('/api/author/drafts/fsus%3Aarticle-draft%3Acreate', {
          method: 'DELETE',
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
      }).catch(() => {})
      await session.close()
    }
  })
})
