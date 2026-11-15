import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { queryCorpusPage, searchTerms } from '../../src/Contracts/local-search.ts'
import { decodeArticle, decodeSearch } from '../../src/Contracts/public-articles.ts'
import {
  decodeAdminArticleArchiveIntent, decodeAdminArticleArchivePreview, decodeAdminArticleArchiveReceipt, encodeAdminArticleArchiveIntent,
  FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

export async function verifyAdminArticleArchive({ page, context, adminOrigin, siteOrigin, grant, logIn, evidence }) {
  const admin = path => adminOrigin.origin + path
  const site = path => siteOrigin.origin + path
  const section = page.getByRole('region', { name: 'Restore a published article revision', exact: true })
  const archive = section.getByRole('region', { name: 'Archived articles', exact: true })
  const detailPath = WireRoutes.PublicArticle.replace('{id}', '1')
  const sourceTitle = 'Rollback fixture source title'
  const sourceBody = 'Historical Markdown ready for restoration\n\n![Never fetched in source preview](https://archive-preview.invalid/from-source.png)\n'
  const availability = WireRoutes.AdminArticleArchiveAvailability
  const archivePage = WireRoutes.AdminArticleArchivePage
  const preview = WireRoutes.AdminArticleArchivePreview
  const previewPath = (articleId, revision, privateReleaseId) =>
    `${preview}?${new URLSearchParams({ articleId, revision, privateReleaseId })}`
  const execute = WireRoutes.AdminArticleArchiveExecute
  const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
  const executeUrl = admin(execute)
  const pack = value => Buffer.from(encodeFrame(FrameType.AdminArticleArchiveIntent, encodeAdminArticleArchiveIntent(value)))
  const post = (route, data, headers = {}) => context.request.post(admin(route), {
    headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream', ...headers }, data,
  })

  async function content() {
    const response = await context.request.get(site(detailPath))
    try {
      assert.equal(response.status(), 200)
      return decodeArticle(decodeFrame(await response.body(), FrameType.ArticleDetail).payload)
    } finally { await response.dispose() }
  }

  async function index() {
    const response = await context.request.get(site(WireRoutes.PublicIndex + '?page=1'))
    try {
      assert.equal(response.status(), 200)
      const generation = response.headers()[generationHeader]
      assert.match(generation, /^\d+$/)
      return { generation, items: decodeSearch(decodeFrame(await response.body(), FrameType.ArticleSearch).payload).articles }
    } finally { await response.dispose() }
  }

  async function deniedPreview(url, status) {
    const response = await context.request.get(url)
    try {
      assert.equal(response.status(), status)
      assert.match(response.headers()['cache-control'], /no-store/)
      const bytes = await response.body()
      assert.doesNotMatch(bytes.toString('utf8'), /Historical Markdown ready for restoration/)
      decodeFrame(bytes, FrameType.ApiError)
    } finally { await response.dispose() }
  }

  async function archivedRows() {
    const response = await context.request.get(admin(archivePage))
    try {
      assert.equal(response.status(), 200)
      const bytes = new PodReader(decodeFrame(await response.body(), FrameType.AdminArticleArchivePage).payload)
      const next = bytes.i32()
      const count = bytes.i32()
      const items = []
      assert.equal(next, 0)
      assert(count >= 0 && count <= WireLimits.AdminArticleArchivePageSize)
      for (let i = 0; i < count; i++) {
        items.push({
          articleId: bytes.i32(), revision: bytes.i64(), release: bytes.i64(), publicationNo: bytes.i32(),
          archivedUnixMs: bytes.i64(), title: bytes.text(WireLimits.TitleBytes),
        })
      }
      bytes.finish()
      return items
    } finally { await response.dispose() }
  }

  async function commitWithLostResponse(button, expected, expectedPublicationNo) {
    const intercepted = Promise.withResolvers()
    const loseResponse = async route => {
      try {
        const request = route.request()
        const sent = request.postDataBuffer()
        assert(sent)
        const command = decodeAdminArticleArchiveIntent(decodeFrame(sent, FrameType.AdminArticleArchiveIntent).payload)
        assert.deepEqual(command, { ...expected, idempotencyKey: command.idempotencyKey })
        const proof = await request.headerValue(WireHeaders.MfaProof)
        assert(/^[A-Za-z0-9_-]{43}$/.test(proof ?? ''))
        const altered = await post(execute, pack({ ...command, reason: 'A different archive command reason' }), { [WireHeaders.MfaProof]: proof })
        assert.equal(altered.status(), 403)
        await altered.dispose()
        const actual = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
        try {
          assert.equal(actual.status(), 200)
          const bytes = await actual.body()
          const receipt = decodeAdminArticleArchiveReceipt(decodeFrame(bytes, FrameType.AdminArticleArchiveReceipt).payload)
          assert.deepEqual([
            receipt.articleId, receipt.revision, receipt.sourceRevision, receipt.previousReleaseId, receipt.publicationNo, receipt.targetStatus,
          ], [
            expected.articleId, expected.expectedRevision + 1n, expected.sourceRevision, expected.expectedReleaseId,
            expectedPublicationNo, expected.targetStatus,
          ])
          assert(receipt.releaseId > 0n && receipt.releaseId !== expected.expectedReleaseId)
          assert(receipt.transitionedUnixMs > 0n && receipt.rightsSnapshotId > 0n && receipt.responsibilitySnapshotId > 0n)
          await route.abort('connectionreset')
          intercepted.resolve({ sent, bytes, receipt })
        } finally { await actual.dispose() }
      } catch (cause) {
        await route.abort('failed').catch(() => {})
        intercepted.reject(cause)
      }
    }
    await page.route(executeUrl, loseResponse, { times: 1 })
    let committed
    try {
      const [result] = await Promise.all([intercepted.promise, button.press('Enter')])
      committed = result
    } finally { await page.unroute(executeUrl, loseResponse) }
    const check = section.getByRole('button', { name: 'Check archive command result', exact: true })
    await check.waitFor()
    const [replay] = await Promise.all([
      page.waitForResponse(response => response.url() === executeUrl && response.request().method() === 'POST'),
      check.press('Enter'),
    ])
    assert.equal(replay.status(), 200)
    assert.deepEqual(replay.request().postDataBuffer(), committed.sent)
    assert.equal(await replay.request().headerValue(WireHeaders.MfaProof), null)
    assert.deepEqual(await replay.body(), committed.bytes)
    return committed.receipt
  }

  const before = await content()
  assert.deepEqual([before.revision, before.publication, before.title], [2n, 2n, 'Rollback fixture current title'])
  const beforeIndex = await index()
  assert(beforeIndex.items.some(article => article.id === 1 && article.revision === 2n && article.publication === 2n))
  assert.equal((await context.request.get(admin(availability))).status(), 403)
  assert.equal((await context.request.get(admin(archivePage))).status(), 403)
  await deniedPreview(admin(previewPath(1, 3, 3)), 403)
  await deniedPreview(site(previewPath(1, 3, 3)), 404)
  assert.equal((await context.request.get(site(availability))).status(), 404)
  assert.equal(await archive.count(), 0)
  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await page.reload()
  await logIn(page)
  await archive.waitFor()
  assert.equal((await context.request.get(admin(availability))).status(), 204)
  assert.deepEqual(await archivedRows(), [])

  await section.getByRole('textbox', { name: 'Article ID', exact: true }).fill('1')
  await section.getByRole('textbox', { name: 'Historical revision', exact: true }).fill('1')
  await section.getByRole('button', { name: 'Preview publication rollback', exact: true }).press('Enter')
  await section.getByRole('heading', { name: sourceTitle, exact: true }).waitFor()
  const archiveIntent = {
    articleId: 1, expectedRevision: 2n, expectedReleaseId: 2n, sourceRevision: 1n,
    reason: 'Archive the approved historical article revision', targetStatus: 3,
  }
  const unsigned = pack({ ...archiveIntent, idempotencyKey: crypto.randomUUID() })
  assert.equal((await post(execute, unsigned)).status(), 403)
  assert.equal((await post(WireRoutes.AdminArticleArchiveStepUpBegin, unsigned, { Origin: siteOrigin.origin })).status(), 403)
  await section.getByLabel('Reason for archiving this revision', { exact: true }).fill(archiveIntent.reason)
  const withdraw = section.getByRole('button', { name: 'Archive revision and withdraw', exact: true })
  assert(await withdraw.isDisabled())
  const archiveConfirmation = 'Create an archived revision and withdraw the current publication'
  await section.getByText(archiveConfirmation, { exact: true }).click()
  assert(await section.getByRole('checkbox', { name: archiveConfirmation, exact: true }).isChecked())
  assert.equal((await content()).publication, 2n)

  const archived = await commitWithLostResponse(withdraw, archiveIntent, 3)
  await section.getByText(`Archived revision 3 as private release ${archived.releaseId}`, { exact: true }).waitFor()
  await archive.getByText(sourceTitle, { exact: true }).waitFor()
  assert.deepEqual(await archivedRows(), [{
    articleId: 1, revision: 3n, release: archived.releaseId, publicationNo: 3,
    archivedUnixMs: archived.transitionedUnixMs, title: sourceTitle,
  }])
  const notPublic = await context.request.get(site(detailPath))
  assert.equal(notPublic.status(), 404)
  decodeFrame(await notPublic.body(), FrameType.ApiError)
  await notPublic.dispose()
  const hiddenHtml = await context.request.get(site('/article/1'))
  assert.equal(hiddenHtml.status(), 404)
  assert.doesNotMatch(await hiddenHtml.text(), /Historical Markdown ready for restoration/)
  await hiddenHtml.dispose()
  const hiddenIndex = await index()
  assert.notEqual(hiddenIndex.generation, beforeIndex.generation)
  assert(!hiddenIndex.items.some(article => article.id === 1))
  const stale = await context.request.get(site(`${WireRoutes.PublicIndex}?page=1&generation=${beforeIndex.generation}`))
  assert.equal(stale.status(), 409)
  await stale.dispose()
  const corpus = await context.request.get(site(WireRoutes.PublicSearchCorpus + '?page=1'))
  assert.equal(corpus.status(), 200)
  assert.equal(corpus.headers()[generationHeader], hiddenIndex.generation)
  assert(!queryCorpusPage(await corpus.body(), searchTerms('Historical Markdown')).documents.has(1))
  await corpus.dispose()
  const ownerBody = await context.request.get(site(WireRoutes.Draft.replace('{id:int}', '1')))
  assert.equal(ownerBody.status(), 404)
  const deniedBody = await ownerBody.body()
  decodeFrame(deniedBody, FrameType.ApiError)
  assert.doesNotMatch(deniedBody.toString('utf8'), /Historical Markdown ready for restoration/)
  await ownerBody.dispose()
  for (const scope of ['active', 'trash']) {
    const ownerInventory = await context.request.get(site(`${WireRoutes.AuthorArticles}?scope=${scope}&article=1`))
    assert.equal(ownerInventory.status(), 200)
    const rows = decodeAuthorArticlePage(decodeFrame(await ownerInventory.body(), FrameType.AuthorArticlePage).payload)
    assert.deepEqual(rows.items, [])
    await ownerInventory.dispose()
  }
  await page.screenshot({ path: join(evidence, 'administrator-article-archived.png') })

  await archive.getByRole('button', { name: 'Review for republishing', exact: true }).press('Enter')
  await section.getByRole('heading', { name: `Republish ${sourceTitle}`, exact: true }).waitFor()
  await section.getByText(`Article 1 · Revision 3 · Private release ${archived.releaseId}`, { exact: true }).waitFor()
  const archivedSourcePath = previewPath(1, 3, archived.releaseId)
  await deniedPreview(admin(previewPath(2, 3, archived.releaseId)), 409)
  await deniedPreview(admin(previewPath(1, 2, archived.releaseId)), 409)
  await deniedPreview(admin(previewPath(1, 3, 2)), 409)
  await deniedPreview(site(archivedSourcePath), 404)
  const trigger = section.getByRole('button', { name: 'Preview archived source', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Archived Markdown source' })
  const source = dialog.locator('pre[aria-label="Archived Markdown"]')
  const unexpected = []
  const observe = request => { if (request.url().startsWith('https://archive-preview.invalid/')) unexpected.push(request.url()) }
  page.on('request', observe)
  try {
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url() === admin(archivedSourcePath) && value.request().method() === 'GET'),
      trigger.press('Enter'),
    ])
    assert.equal(response.status(), 200)
    assert.match(response.headers()['cache-control'], /no-store/)
    assert.equal(response.headers()['x-content-type-options'], 'nosniff')
    assert.deepEqual(decodeAdminArticleArchivePreview(decodeFrame(await response.body(), FrameType.AdminArticleArchivePreview).payload), {
      articleId: 1, revision: 3n, privateReleaseId: archived.releaseId, title: sourceTitle, markdown: sourceBody,
    })
    await source.waitFor()
    assert.equal(await source.textContent(), sourceBody)
    assert.equal(await source.locator('img, a, script').count(), 0)
    await source.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('pre[aria-label="Archived Markdown"]').count(), 0)
  } finally { page.off('request', observe) }
  assert.deepEqual(unexpected, [])
  const stillArchived = await archivedRows()
  assert.equal(stillArchived[0].release, archived.releaseId)
  assert.equal((await index()).generation, hiddenIndex.generation)
  const publishIntent = {
    articleId: 1, expectedRevision: 3n, expectedReleaseId: archived.releaseId, sourceRevision: 3n,
    reason: 'Republish the exact archived article revision', targetStatus: 2,
  }
  await section.getByLabel('Reason for republishing this revision', { exact: true }).fill(publishIntent.reason)
  const publish = section.getByRole('button', { name: 'Republish with Passkey', exact: true })
  assert(await publish.isDisabled())
  const publishConfirmation = 'Publish this exact archived revision'
  await section.getByText(publishConfirmation, { exact: true }).click()
  assert(await section.getByRole('checkbox', { name: publishConfirmation, exact: true }).isChecked())
  const republished = await commitWithLostResponse(publish, publishIntent, 4)
  assert.notEqual(republished.rightsSnapshotId, archived.rightsSnapshotId)
  assert.notEqual(republished.responsibilitySnapshotId, archived.responsibilitySnapshotId)
  await section.getByText(`Republished revision 4 as publication ${republished.releaseId}`, { exact: true }).waitFor()
  await archive.getByText('No archived articles on this page.', { exact: true }).waitFor()
  await deniedPreview(admin(archivedSourcePath), 409)
  assert.deepEqual(await archivedRows(), [])
  const restored = await content()
  assert.deepEqual([restored.title, restored.body, restored.revision, restored.publication],
    [sourceTitle, sourceBody, 4n, republished.releaseId])
  assert.equal(restored.rights?.snapshotId, republished.rightsSnapshotId)
  const restoredHtml = await context.request.get(site('/article/1'))
  assert.equal(restoredHtml.status(), 200)
  assert.match(await restoredHtml.text(), /Historical Markdown ready for restoration/)
  await restoredHtml.dispose()
  const liveIndex = await index()
  assert.notEqual(liveIndex.generation, hiddenIndex.generation)
  assert(liveIndex.items.some(article => article.id === 1 && article.revision === 4n && article.publication === republished.releaseId))
  await page.screenshot({ path: join(evidence, 'administrator-article-republished.png') })
}
