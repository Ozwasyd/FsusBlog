import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { decodeSearch } from '../../src/Contracts/public-articles.ts'
import {
  decodeAdminArticleArchiveIntent, decodeAdminArticleArchivePreview, decodeAdminArticleArchiveReceipt, encodeAdminArticleArchiveIntent,
  decodeAdminArticleTrashPublicationIntent, decodeAdminArticleTrashPublicationPreview, decodeAdminArticleTrashPublicationReceipt,
  encodeAdminArticleTrashPublicationIntent,
  decodeAdminArticleTrashRestoreIntent, decodeAdminArticleTrashRestoreReceipt, encodeAdminArticleTrashRestoreIntent,
  FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'
import { adminArticleFixture, commitWithLostReceipt, sourceTitle } from './admin-article-fixture.mjs'
import { readDraft, submitPublicationMutation } from './browser-authoring-fixture.mjs'

export async function verifyAdminArticleArchive({ page, context, adminOrigin, siteOrigin, grant, logIn, evidence }) {
  const { admin, site, section, send, grantAndSignIn, previewRollback, inspect: content, index,
    expectStaleIndex, expectWithdrawnArticle, expectWithdrawnCorpus } = adminArticleFixture({ page, context, adminOrigin, siteOrigin })
  const archive = section.getByRole('region', { name: 'Archived articles', exact: true })
  const inventory = page.getByRole('region', { name: 'Article inventory', exact: true })
  const inventoryPath = WireRoutes.AdminArticleInventory
  const sourceBody = 'Historical Markdown ready for restoration\n\n![Never fetched in source preview](https://archive-preview.invalid/from-source.png)\n'
  const availability = WireRoutes.AdminArticleArchiveAvailability
  const archivePage = WireRoutes.AdminArticleArchivePage
  const preview = WireRoutes.AdminArticleArchivePreview
  const previewPath = (articleId, revision, privateReleaseId) =>
    `${preview}?${new URLSearchParams({ articleId, revision, privateReleaseId })}`
  const execute = WireRoutes.AdminArticleArchiveExecute
  const pack = value => Buffer.from(encodeFrame(FrameType.AdminArticleArchiveIntent, encodeAdminArticleArchiveIntent(value)))
  const trashPreview = (articleId, revision) => page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.origin === adminOrigin.origin && url.pathname === WireRoutes.AdminArticleTrashPublicationPreview &&
      url.searchParams.get('articleId') === articleId && url.searchParams.get('revision') === revision && response.request().method() === 'GET'
  })
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

  function commitWithLostResponse(button, expected, expectedPublicationNo) {
    return commitWithLostReceipt({
      page, url: admin(execute), button,
      check: section.getByRole('button', { name: 'Check archive command result', exact: true }),
      async verifyRequest(request, sent) {
        assert(sent)
        const command = decodeAdminArticleArchiveIntent(decodeFrame(sent, FrameType.AdminArticleArchiveIntent).payload)
        assert.deepEqual(command, { ...expected, idempotencyKey: command.idempotencyKey })
        const proof = await request.headerValue(WireHeaders.MfaProof)
        assert(/^[A-Za-z0-9_-]{43}$/.test(proof ?? ''))
        const altered = await send(execute, pack({ ...command, reason: 'A different archive command reason' }), { [WireHeaders.MfaProof]: proof })
        assert.equal(altered.status(), 403)
        await altered.dispose()
      },
      readReceipt(bytes) {
        const receipt = decodeAdminArticleArchiveReceipt(decodeFrame(bytes, FrameType.AdminArticleArchiveReceipt).payload)
        assert.deepEqual([
          receipt.articleId, receipt.revision, receipt.sourceRevision, receipt.previousReleaseId, receipt.publicationNo, receipt.targetStatus,
        ], [
          expected.articleId, expected.expectedRevision + 1n, expected.sourceRevision, expected.expectedReleaseId,
          expectedPublicationNo, expected.targetStatus,
        ])
        assert(receipt.releaseId > 0n && receipt.releaseId !== expected.expectedReleaseId)
        assert(receipt.transitionedUnixMs > 0n && receipt.rightsSnapshotId > 0n && receipt.responsibilitySnapshotId > 0n)
        return receipt
      },
    })
  }

  const before = await content()
  assert.deepEqual([before.revision, before.publication, before.title], [2n, 2n, 'Rollback fixture current title'])
  const beforeIndex = await index()
  assert(beforeIndex.items.some(article => article.id === 1 && article.revision === 2n && article.publication === 2n))
  assert.equal((await context.request.get(admin(availability))).status(), 403)
  assert.equal((await context.request.get(admin(archivePage))).status(), 403)
  assert.equal((await context.request.get(admin(inventoryPath))).status(), 403)
  assert.equal((await context.request.get(admin(WireRoutes.AdminArticleTrashRestoreAvailability))).status(), 403)
  const unpublishedPreview = `${WireRoutes.AdminArticleTrashPublicationPreview}?articleId=23&revision=1`
  assert.equal((await context.request.get(admin(unpublishedPreview))).status(), 403)
  assert.equal((await context.request.get(site(unpublishedPreview))).status(), 404)
  assert.equal((await context.request.get(site(inventoryPath))).status(), 404)
  await deniedPreview(admin(previewPath(1, 3, 3)), 403)
  await deniedPreview(site(previewPath(1, 3, 3)), 404)
  assert.equal((await context.request.get(site(availability))).status(), 404)
  assert.equal(await archive.count(), 0)
  await grantAndSignIn(grant, logIn)
  await archive.waitFor()
  assert.equal((await context.request.get(admin(availability))).status(), 204)
  assert.deepEqual(await archivedRows(), [])
  await inventory.getByRole('button', { name: 'Active articles' }).press('Enter')
  await inventory.getByRole('status').filter({ hasText: '22 active articles' }).waitFor()
  await inventory.getByRole('button', { name: 'Next page' }).press('Enter')
  await inventory.getByText('Inventory draft 1', { exact: true }).waitFor()
  assert.equal(await inventory.getByText('Inventory draft 21', { exact: true }).count(), 0)
  await inventory.getByRole('button', { name: 'Article trash' }).press('Enter')
  await inventory.getByText('Inventory draft 22', { exact: true }).waitFor()
  assert.equal(await inventory.getByRole('listitem').count(), 1)
  assert.equal((await context.request.get(admin(WireRoutes.AdminArticleTrashRestoreAvailability))).status(), 204)
  const [unpublished] = await Promise.all([
    trashPreview('23', '1'),
    inventory.getByRole('button', { name: 'Restore to draft', exact: true }).press('Enter'),
  ])
  assert.equal(unpublished.status(), 409)
  const recover = page.getByRole('dialog', { name: 'Restore deleted article', exact: true })
  await recover.getByText('Restore revision 1 of Inventory draft 22 to its author as a private draft.', { exact: true }).waitFor()
  assert.equal(await recover.getByRole('button', { name: 'Restore former publication with Passkey', exact: true }).count(), 0)
  await page.screenshot({ path: join(evidence, 'administrator-article-trash-review.png') })
  const recoveryRoute = WireRoutes.AdminArticleTrashRestoreExecute
  const recoveryFrame = intent => Buffer.from(encodeFrame(FrameType.AdminArticleTrashRestoreIntent, encodeAdminArticleTrashRestoreIntent(intent)))
  let recoveryIntent
  const recovered = await commitWithLostReceipt({
    page, url: admin(recoveryRoute), button: recover.getByRole('button', { name: 'Restore draft with Passkey' }),
    check: inventory.getByRole('button', { name: 'Check restore result' }),
    async verifyRequest(request, sent) {
      recoveryIntent = decodeAdminArticleTrashRestoreIntent(decodeFrame(sent, FrameType.AdminArticleTrashRestoreIntent).payload)
      assert.deepEqual([recoveryIntent.articleId, recoveryIntent.expectedRevision], [23, 1n])
      const mutation = await request.headerValue(WireHeaders.ClientMutationId)
      const proof = await request.headerValue(WireHeaders.MfaProof)
      assert.equal(mutation, recoveryIntent.idempotencyKey)
      assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
      const altered = await send(recoveryRoute, recoveryFrame({ ...recoveryIntent, expectedRevision: 2n }), {
        [WireHeaders.ClientMutationId]: mutation, [WireHeaders.MfaProof]: proof,
      })
      assert.equal(altered.status(), 403)
      await altered.dispose()
    },
    readReceipt: bytes => decodeAdminArticleTrashRestoreReceipt(decodeFrame(bytes, FrameType.AdminArticleTrashRestoreReceipt).payload),
  })
  assert.deepEqual(recovered, { articleId: 23, revision: 2n })
  await inventory.getByRole('status').filter({ hasText: '0 deleted articles' }).waitFor()
  await inventory.getByText('Article 23 restored as private revision 2.', { exact: true }).waitFor()
  const conflict = await send(recoveryRoute, recoveryFrame({ ...recoveryIntent, expectedRevision: 2n }), {
    [WireHeaders.ClientMutationId]: recoveryIntent.idempotencyKey,
  })
  assert.equal(conflict.status(), 409)
  await conflict.dispose()
  assert.equal((await context.request.get(site(WireRoutes.PublicArticle.replace('{id}', '23')))).status(), 404)
  assert.equal((await context.request.get(site(WireRoutes.Draft.replace('{id:int}', '23')))).status(), 404)
  await inventory.getByRole('button', { name: 'Active articles' }).press('Enter')
  await inventory.getByLabel('Title or summary', { exact: true }).fill('Inventory summary 21')
  await inventory.getByRole('button', { name: 'Search articles' }).press('Enter')
  await inventory.getByText('Inventory draft 21', { exact: true }).waitFor()
  assert.equal(await inventory.getByRole('listitem').count(), 1)
  await page.setViewportSize({ width: 375, height: 800 })
  assert(await inventory.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
  await inventory.screenshot({ path: join(evidence, 'administrator-article-inventory.png') })
  await page.setViewportSize({ width: 1280, height: 800 })

  await previewRollback()
  const archiveIntent = {
    articleId: 1, expectedRevision: 2n, expectedReleaseId: 2n, sourceRevision: 1n,
    reason: 'Archive the approved historical article revision', targetStatus: 3,
  }
  const unsigned = pack({ ...archiveIntent, idempotencyKey: crypto.randomUUID() })
  assert.equal((await send(execute, unsigned)).status(), 403)
  assert.equal((await send(WireRoutes.AdminArticleArchiveStepUpBegin, unsigned, { Origin: siteOrigin.origin })).status(), 403)
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
  await expectWithdrawnArticle()
  const hiddenIndex = await index()
  assert.notEqual(hiddenIndex.generation, beforeIndex.generation)
  assert(!hiddenIndex.items.some(article => article.id === 1))
  await expectStaleIndex(beforeIndex.generation)
  await expectWithdrawnCorpus(hiddenIndex.generation)
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

  const privateTitle = 'Never published fixture title'
  const privateBody = 'neverpublictrashrestoremarker'
  const saved = await submitPublicationMutation(context.request, site(WireRoutes.Save), 1, 4n, privateTitle, privateBody)
  try {
    const draft = await readDraft(saved)
    assert.deepEqual([draft.id, draft.revision, draft.title, draft.body], [1, 5n, privateTitle, privateBody])
  } finally { await saved.dispose() }
  const deleted = await submitPublicationMutation(context.request, site(WireRoutes.Delete), 1, 5n, '', '')
  try {
    assert.equal(deleted.status(), 200)
    decodeFrame(await deleted.body(), FrameType.EmptySuccess)
  } finally { await deleted.dispose() }
  await expectWithdrawnArticle()
  const trashIndex = await index()
  await expectStaleIndex(liveIndex.generation)
  await expectWithdrawnCorpus(trashIndex.generation)
  assert(!trashIndex.items.some(article => article.id === 1))

  await inventory.getByLabel('Title or summary', { exact: true }).fill('')
  await inventory.getByRole('button', { name: 'Article trash' }).press('Enter')
  await inventory.getByText(privateTitle, { exact: true }).waitFor()
  const [former] = await Promise.all([
    trashPreview('1', '6'),
    inventory.getByRole('button', { name: 'Restore to draft', exact: true }).press('Enter'),
  ])
  assert.equal(former.status(), 200)
  assert.match(former.headers()['cache-control'], /no-store/)
  const formerBytes = await former.body()
  const formerPublication = decodeAdminArticleTrashPublicationPreview(decodeFrame(formerBytes, FrameType.AdminArticleTrashPublicationPreview).payload)
  assert.deepEqual([formerPublication.sourceRevision, formerPublication.sourcePublicationId, formerPublication.title],
    [4n, republished.releaseId, sourceTitle])
  for (const hidden of [privateTitle, privateBody]) assert(!formerBytes.includes(Buffer.from(hidden)))
  await recover.getByText(sourceTitle, { exact: false }).waitFor()
  const publicReason = 'Restore only the approved former publication from trash'
  await recover.getByLabel('Reason for restoring publication', { exact: true }).fill(publicReason)
  await page.screenshot({ path: join(evidence, 'administrator-article-trash-publication-review.png') })
  const publicationRoute = WireRoutes.AdminArticleTrashPublicationExecute
  const publication = await commitWithLostReceipt({
    page, url: admin(publicationRoute),
    button: recover.getByRole('button', { name: 'Restore former publication with Passkey', exact: true }),
    check: inventory.getByRole('button', { name: 'Check restore result', exact: true }),
    async verifyRequest(request, sent) {
      const intent = decodeAdminArticleTrashPublicationIntent(decodeFrame(sent, FrameType.AdminArticleTrashPublicationIntent).payload)
      assert.deepEqual([intent.articleId, intent.expectedRevision, intent.sourceRevision, intent.sourcePublicationId, intent.reason],
        [1, 6n, 4n, republished.releaseId, publicReason])
      const mutation = await request.headerValue(WireHeaders.ClientMutationId)
      const proof = await request.headerValue(WireHeaders.MfaProof)
      assert.equal(mutation, intent.idempotencyKey)
      assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
      const altered = await send(publicationRoute, Buffer.from(encodeFrame(FrameType.AdminArticleTrashPublicationIntent,
        encodeAdminArticleTrashPublicationIntent({ ...intent, sourceRevision: 5n }))), {
        [WireHeaders.ClientMutationId]: mutation, [WireHeaders.MfaProof]: proof,
      })
      assert.equal(altered.status(), 403)
      await altered.dispose()
    },
    readReceipt: bytes => decodeAdminArticleTrashPublicationReceipt(decodeFrame(bytes, FrameType.AdminArticleTrashPublicationReceipt).payload),
  })
  assert.deepEqual([publication.articleId, publication.revision, publication.sourceRevision, publication.sourcePublicationId],
    [1, 7n, 4n, republished.releaseId])
  assert(publication.publicationId > 0n && publication.publicationId !== republished.releaseId)
  await inventory.getByRole('status').filter({ hasText: '0 deleted articles' }).waitFor()
  const live = await content()
  assert.deepEqual([live.title, live.body, live.revision, live.publication], [sourceTitle, sourceBody, 7n, publication.publicationId])
  assert(live.rights?.snapshotId > 0n && live.rights.snapshotId !== republished.rightsSnapshotId)
  await expectStaleIndex(trashIndex.generation)
  const finalIndex = await index()
  assert(finalIndex.items.some(article => article.id === 1 && article.revision === 7n && article.publication === publication.publicationId))
  const publicHtml = await context.request.get(site('/article/1'))
  try {
    assert.equal(publicHtml.status(), 200)
    const html = await publicHtml.text()
    assert.match(html, /Historical Markdown ready for restoration/)
    assert(!html.includes(privateTitle) && !html.includes(privateBody))
  } finally { await publicHtml.dispose() }
  const privateSearch = await context.request.get(site(`${WireRoutes.PublicSearch}?q=${privateBody}`))
  try {
    assert.equal(privateSearch.status(), 200)
    assert.deepEqual(decodeSearch(decodeFrame(await privateSearch.body(), FrameType.ArticleSearch).payload).articles, [])
  } finally { await privateSearch.dispose() }
}
