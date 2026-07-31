import { test, expect, type Page } from '@playwright/test'
import {
  articleRecoveryArticleKey,
  articleRecoverySourceHash
} from '../../../../src/frontend/src/services/articleRecoveryJournal'
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
const ARTICLE_RECOVERY_DATABASE = 'fsusblog-article-recovery-journal'
const ARTICLE_RECOVERY_STORE = 'entries'
const ARTICLE_RECOVERY_CLIENT_REVISION_PATTERN = /^[a-zA-Z0-9-]{8,128}$/u

interface BrowserArticleRecoveryRecord {
  schema?: unknown
  articleKey?: unknown
  clientRevision?: unknown
  sourceHash?: unknown
  payloadCodec?: unknown
  payloadBytes?: unknown
  payloadIsUint8Array: boolean
  contentBytes?: unknown
  storedBytes?: unknown
  hasOwnContent: boolean
}

function matchesCompressedArticleRecovery(
  record: BrowserArticleRecoveryRecord,
  expected: {
    articleKey: string
    sourceHash: string
    contentBytes: number
  }
): record is BrowserArticleRecoveryRecord & { clientRevision: string } {
  return record.schema === 'fsusblog.article-recovery-journal.v1'
    && record.articleKey === expected.articleKey
    && typeof record.clientRevision === 'string'
    && ARTICLE_RECOVERY_CLIENT_REVISION_PATTERN.test(record.clientRevision)
    && record.sourceHash === expected.sourceHash
    && record.payloadCodec === 'gzip-v1'
    && record.payloadIsUint8Array
    && record.payloadBytes === record.storedBytes
    && typeof record.storedBytes === 'number'
    && Number.isSafeInteger(record.storedBytes)
    && record.storedBytes > 0
    && record.storedBytes <= 1024 * 1024
    && record.contentBytes === expected.contentBytes
    && !record.hasOwnContent
}

async function readArticleRecoveryJournal(page: Page): Promise<BrowserArticleRecoveryRecord[]> {
  return page.evaluate(async ({ databaseName, storeName }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<BrowserArticleRecoveryRecord[]>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly')
        const request = transaction.objectStore(storeName).getAll()
        request.onsuccess = () => resolve(request.result.map(record => ({
          schema: record.schema,
          articleKey: record.articleKey,
          clientRevision: record.clientRevision,
          sourceHash: record.sourceHash,
          payloadCodec: record.payloadCodec,
          payloadBytes: record.payload instanceof Uint8Array ? record.payload.byteLength : null,
          payloadIsUint8Array: record.payload instanceof Uint8Array,
          contentBytes: record.contentBytes,
          storedBytes: record.storedBytes,
          hasOwnContent: Object.hasOwn(record, 'content')
        })))
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  }, {
    databaseName: ARTICLE_RECOVERY_DATABASE,
    storeName: ARTICLE_RECOVERY_STORE
  })
}

async function clearArticleRecoveryJournal(page: Page): Promise<void> {
  await page.evaluate(async ({ databaseName, storeName }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite')
        transaction.objectStore(storeName).clear()
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
  }, {
    databaseName: ARTICLE_RECOVERY_DATABASE,
    storeName: ARTICLE_RECOVERY_STORE
  })
}

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
    const expectedRecoveryArticleKey = articleRecoveryArticleKey(null)
    const expectedRecoverySourceHash = await articleRecoverySourceHash(source)
    const expectedRecoveryContentBytes = new TextEncoder().encode(source).byteLength
    const expectedRecoveryRecord = {
      articleKey: expectedRecoveryArticleKey,
      sourceHash: expectedRecoverySourceHash,
      contentBytes: expectedRecoveryContentBytes
    }
    let runtimeClientRevision: string | null = null
    const session = await openAuditedPage(browser, storageState)

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/user/manage/article/write', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)
      await assertNoHorizontalOverflow(session.page, 8)
      await session.page.evaluate(async () => {
        await fetch('/api/author/drafts/fsus%3Aarticle-draft%3Acreate', {
          method: 'DELETE',
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
      })
      await clearArticleRecoveryJournal(session.page)
      await session.page.reload({ waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)
      await session.page.route('**/api/binary/author/drafts', route => route.abort('internetdisconnected'))

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
        .poll(async () => {
          const records = await readArticleRecoveryJournal(session.page)
          const matches = records.filter(record => (
            matchesCompressedArticleRecovery(record, expectedRecoveryRecord)
          ))
          if (matches.length !== 1) {
            return false
          }
          runtimeClientRevision = matches[0]?.clientRevision ?? null
          return runtimeClientRevision !== null
        }, {
          message: 'extreme unsynced body should be written to the bounded IndexedDB journal',
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
      expect(runtimeClientRevision).not.toBeNull()
      const reloadedRecoveryRecords = await readArticleRecoveryJournal(session.page)
      expect(reloadedRecoveryRecords.filter(record => (
        matchesCompressedArticleRecovery(record, expectedRecoveryRecord)
        && record.clientRevision === runtimeClientRevision
      ))).toHaveLength(1)
      const restoreDraftButton = session.page.getByRole('button', { name: '恢复所选正文' })
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
      const discardDraftButton = session.page.getByRole('button', { name: '丢弃所选正文' })
      await expect(discardDraftButton).toBeVisible({ timeout: 20_000 })
      await discardDraftButton.click()
      await expect(session.page.getByRole('button', { name: '恢复所选正文' })).toHaveCount(0)
      await expect
        .poll(async () => (await readArticleRecoveryJournal(session.page)).length, {
          message: 'extreme unsynced body should be removed from the IndexedDB journal after discard',
          timeout: 10_000
        })
        .toBe(0)

      session.audit.assertCleanSince(start, 'markdown-extreme-editor')
    } finally {
      await session.page.evaluate(async () => {
        await fetch('/api/author/drafts/fsus%3Aarticle-draft%3Acreate', {
          method: 'DELETE',
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
      }).catch(() => {})
      await clearArticleRecoveryJournal(session.page).catch(() => {})
      await session.close()
    }
  })
})
