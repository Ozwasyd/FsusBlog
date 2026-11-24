import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { decodeSearch } from '../../src/Contracts/public-articles.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { adminArticleFixture, sourceTitle } from './admin-article-fixture.mjs'
import * as adminFx from './admin-workspace-fixture.mjs'
import { authorFixture } from './browser-authoring-fixture.mjs'
import { saveShot, withViewport } from './isolated-browser-fixture.mjs'
import * as res from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireLimits, WireRoutes: R } = wire

export async function verifyAdminArticleArchive({ page, context, adminOrigin, siteOrigin, owner, adminCookieName, siteCookie, probe, evidence }) {
  await adminFx.visitAdminWorkspace(page, '/admin/articles')
  const fx = adminArticleFixture({ page, context, adminOrigin, siteOrigin })
  const ownerFx = authorFixture(adminOrigin.origin, [])
  const { admin, site, section, expectSend, openPublicationRecovery, previewRollback, inspect: content, index, commitMfaCommand } = fx
  const archive = loc.exactRegion(section, 'Archived articles')
  const inventory = loc.exactRegion(page, 'Article inventory')
  const inventoryRows = inventory.getByRole('row').filter({ has: page.getByRole('cell') })
  const sourceMarker = 'Historical Markdown ready for restoration'
  const sourceBody = `${sourceMarker}\n\n![Never fetched in source preview](https://archive-preview.invalid/from-source.png)\n`
  const previewPath = (articleId, revision, privateReleaseId) =>
    `${R.AdminArticleArchivePreview}?${new URLSearchParams({ articleId, revision, privateReleaseId })}`
  const pack = value => adminFx.packFrame(FrameType.AdminArticleArchiveIntent, wire.encodeAdminArticleArchiveIntent(value))
  const trashPreview = (articleId, revision) => page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.origin === adminOrigin.origin && url.pathname === R.AdminArticleTrashPublicationPreview &&
      url.searchParams.get('articleId') === articleId && url.searchParams.get('revision') === revision && response.request().method() === 'GET'
  })

  async function deniedPreview(url, status) {
    const response = await context.request.get(url)
    try {
      await res.assertNoStore(response)
      await res.assertApiError(response, status, sourceMarker)
    } finally { await response.dispose() }
  }

  async function archivedRows() {
    const bytes = new PodReader(await res.getFrame(context.request, admin(R.AdminArticleArchivePage), FrameType.AdminArticleArchivePage))
    const next = bytes.i32(), count = bytes.i32(), items = []
    assert.equal(next, 0)
    assert(count >= 0 && count <= WireLimits.AdminArticleArchivePageSize)
    for (let i = 0; i < count; i++) {
      items.push({ articleId: bytes.i32(), revision: bytes.i64(), release: bytes.i64(), publicationNo: bytes.i32(),
        archivedUnixMs: bytes.i64(), title: bytes.text(WireLimits.TitleBytes) })
    }
    bytes.finish()
    return items
  }

  const commitArchive = (button, expected, publicationNo) => commitMfaCommand({
    schema: 'AdminArticleArchive', button, check: loc.exactButton(section, 'Check archive command result'),
    verifyIntent: cmd => assert.deepEqual(cmd, { ...expected, idempotencyKey: cmd.idempotencyKey }),
    tamperIntent: cmd => ({ ...cmd, reason: 'A different archive command reason' }),
    verifyReceipt(receipt) {
      res.assertFields(receipt, { articleId: expected.articleId, revision: expected.expectedRevision + 1n,
        sourceRevision: expected.sourceRevision, previousReleaseId: expected.expectedReleaseId,
        publicationNo, targetStatus: expected.targetStatus })
      assert(receipt.releaseId > 0n && receipt.releaseId !== expected.expectedReleaseId)
      assert(receipt.transitionedUnixMs > 0n && receipt.rightsSnapshotId > 0n && receipt.responsibilitySnapshotId > 0n)
    },
  })

  res.assertFields(await content(), { revision: 2n, publication: 2n, title: 'Rollback fixture current title' })
  const beforeIndex = await index()
  assert(beforeIndex.items.some(article => article.id === 1 && article.revision === 2n && article.publication === 2n))
  const unpublishedPreview = `${R.AdminArticleTrashPublicationPreview}?articleId=23&revision=1`
  for (const path of [R.AdminArticleArchiveAvailability, R.AdminArticleArchivePage, R.AdminArticleInventory,
    R.AdminArticleTrashRestoreAvailability, unpublishedPreview]) await probe(admin(path), adminCookieName, siteCookie.value, 401)
  await res.assertGetAll(context.request, 404, [unpublishedPreview, R.AdminArticleInventory, R.AdminArticleArchiveAvailability].map(site))
  const denied = await probe(admin(previewPath(1, 3, 3)), adminCookieName, siteCookie.value, 401, true)
  res.assertNoneIn(denied, sourceMarker)
  decodeFrame(denied, FrameType.ApiError)
  await deniedPreview(site(previewPath(1, 3, 3)), 404)
  await openPublicationRecovery()
  await archive.waitFor()
  await res.assertGetStatus(context.request, admin(R.AdminArticleArchiveAvailability), 204)
  assert.deepEqual(await archivedRows(), [])
  await loc.exactTab(page, 'Articles').click()
  await inventory.getByRole('status').filter({ hasText: '22 active articles' }).waitFor()
  await inventory.getByRole('button', { name: 'Next page' }).press('Enter')
  await loc.exactText(inventory, 'Inventory draft 1').waitFor()
  assert.equal(await loc.exactText(inventory, 'Inventory draft 21').count(), 0)
  await loc.exactTab(page, 'Trash').click()
  await loc.exactText(inventory, 'Inventory draft 22').waitFor()
  assert.equal(await inventoryRows.count(), 1)
  await res.assertGetStatus(context.request, admin(R.AdminArticleTrashRestoreAvailability), 204)
  const [unpublished] = await Promise.all([trashPreview('23', '1'), loc.exactButton(inventory, 'Restore to draft').press('Enter')])
  res.assertStatus(unpublished, 409)
  const recover = loc.exactDialog(page, 'Restore deleted article')
  await loc.exactText(recover, 'Restore revision 1 of Inventory draft 22 to its author as a private draft.').waitFor()
  assert.equal(await loc.exactButton(recover, 'Restore former publication with Passkey').count(), 0)
  await saveShot(page, evidence, 'administrator-article-trash-review.png', {})
  let recoveryIntent
  const recovered = await commitMfaCommand({
    schema: 'AdminArticleTrashRestore', checkMutationId: true,
    button: recover.getByRole('button', { name: 'Restore draft with Passkey' }),
    check: inventory.getByRole('button', { name: 'Check restore result' }),
    verifyIntent: intent => { recoveryIntent = intent; res.assertFields(intent, { articleId: 23, expectedRevision: 1n }) },
    tamperIntent: intent => ({ ...intent, expectedRevision: 2n }),
  })
  assert.deepEqual(recovered, { articleId: 23, revision: 2n })
  await inventory.getByRole('status').filter({ hasText: '0 deleted articles' }).waitFor()
  await loc.exactText(inventory, 'Article 23 restored as private revision 2.').waitFor()
  const replayFrame = adminFx.packFrame(FrameType.AdminArticleTrashRestoreIntent,
    wire.encodeAdminArticleTrashRestoreIntent({ ...recoveryIntent, expectedRevision: 2n }))
  await expectSend(R.AdminArticleTrashRestoreExecute, replayFrame, 409, { [WireHeaders.ClientMutationId]: recoveryIntent.idempotencyKey })
  await res.assertGetAll(context.request, 404, [site(R.PublicArticle.replace('{id}', '23')), site(R.Draft.replace('{id:int}', '23'))])
  await loc.exactTab(page, 'Articles').click()
  await loc.exactLabel(inventory, 'Title or summary').fill('Inventory summary 21')
  await inventory.getByRole('button', { name: 'Search articles' }).press('Enter')
  await loc.exactText(inventory, 'Inventory draft 21').waitFor()
  assert.equal(await inventoryRows.count(), 1)
  await withViewport(page, 375, 800, async () => {
    await adminFx.assertFitsWidth(inventory)
    await saveShot(inventory, evidence, 'administrator-article-inventory.png', {})
  })

  await previewRollback()
  const archiveIntent = { articleId: 1, expectedRevision: 2n, expectedReleaseId: 2n, sourceRevision: 1n,
    reason: 'Archive the approved historical article revision', targetStatus: 3 }
  const unsigned = pack({ ...archiveIntent, idempotencyKey: crypto.randomUUID() })
  await expectSend(R.AdminArticleArchiveExecute, unsigned, 403)
  await expectSend(R.AdminArticleArchiveStepUpBegin, unsigned, 403, { Origin: siteOrigin.origin })
  await loc.exactLabel(section, 'Reason for archiving this revision').fill(archiveIntent.reason)
  const withdraw = loc.exactButton(section, 'Archive revision and withdraw')
  assert(await withdraw.isDisabled())
  await adminFx.checkLabeledCheckbox(section, 'Create an archived revision and withdraw the current publication')
  assert.equal((await content()).publication, 2n)

  const archived = await commitArchive(withdraw, archiveIntent, 3)
  await loc.exactText(section, `Archived revision 3 as private release ${archived.releaseId}`).waitFor()
  await loc.exactText(archive, sourceTitle).waitFor()
  assert.deepEqual(await archivedRows(), [{ articleId: 1, revision: 3n, release: archived.releaseId, publicationNo: 3,
    archivedUnixMs: archived.transitionedUnixMs, title: sourceTitle }])
  await fx.expectWithdrawnArticle()
  const hiddenIndex = await index()
  assert.notEqual(hiddenIndex.generation, beforeIndex.generation)
  assert(!hiddenIndex.items.some(article => article.id === 1))
  await fx.expectStaleIndex(beforeIndex.generation)
  await fx.expectWithdrawnCorpus(hiddenIndex.generation)
  const ownerBody = await owner.request.get(admin(R.Draft.replace('{id:int}', '1')))
  try { await res.assertApiError(ownerBody, 404, sourceMarker) } finally { await ownerBody.dispose() }
  for (const scope of ['active', 'trash']) assert.deepEqual((await fx.ownerArticles(owner, `?scope=${scope}&article=1`)).items, [])
  await saveShot(page, evidence, 'administrator-article-archived.png', {})

  await loc.exactButton(archive, 'Review for republishing').press('Enter')
  await loc.exactHeading(section, `Republish ${sourceTitle}`).waitFor()
  await loc.exactText(section, `Article 1 · Revision 3 · Private release ${archived.releaseId}`).waitFor()
  const archivedSourcePath = previewPath(1, 3, archived.releaseId)
  for (const [url, status] of [[admin(previewPath(2, 3, archived.releaseId)), 409], [admin(previewPath(1, 2, archived.releaseId)), 409],
    [admin(previewPath(1, 3, 2)), 409], [site(archivedSourcePath), 404]]) await deniedPreview(url, status)
  const dialog = page.getByRole('dialog', { name: 'Archived Markdown source' })
  const source = dialog.locator('pre[aria-label="Archived Markdown"]')
  const unexpected = []
  const observe = request => { if (request.url().startsWith('https://archive-preview.invalid/')) unexpected.push(request.url()) }
  page.on('request', observe)
  try {
    const response = await adminFx.pressForResponse(page, admin(archivedSourcePath), loc.exactButton(section, 'Preview archived source'))
    assert.equal(response.headers()['x-content-type-options'], 'nosniff')
    assert.deepEqual(await res.readNoStoreFrame(response, FrameType.AdminArticleArchivePreview, wire.decodeAdminArticleArchivePreview),
      { articleId: 1, revision: 3n, privateReleaseId: archived.releaseId, title: sourceTitle, markdown: sourceBody })
    await source.waitFor()
    assert.equal(await source.textContent(), sourceBody)
    assert.equal(await source.locator('img, a, script').count(), 0)
    await source.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('pre[aria-label="Archived Markdown"]').count(), 0)
  } finally { page.off('request', observe) }
  assert.deepEqual(unexpected, [])
  assert.equal((await archivedRows())[0].release, archived.releaseId)
  assert.equal((await index()).generation, hiddenIndex.generation)
  const publishIntent = { articleId: 1, expectedRevision: 3n, expectedReleaseId: archived.releaseId, sourceRevision: 3n,
    reason: 'Republish the exact archived article revision', targetStatus: 2 }
  await loc.exactLabel(section, 'Reason for republishing this revision').fill(publishIntent.reason)
  const publish = loc.exactButton(section, 'Republish with Passkey')
  assert(await publish.isDisabled())
  await adminFx.checkLabeledCheckbox(section, 'Publish this exact archived revision')
  const republished = await commitArchive(publish, publishIntent, 4)
  assert.notEqual(republished.rightsSnapshotId, archived.rightsSnapshotId)
  assert.notEqual(republished.responsibilitySnapshotId, archived.responsibilitySnapshotId)
  await loc.exactText(section, `Republished revision 4 as publication ${republished.releaseId}`).waitFor()
  await loc.exactText(archive, 'No archived articles on this page.').waitFor()
  await deniedPreview(admin(archivedSourcePath), 409)
  assert.deepEqual(await archivedRows(), [])
  const restored = await content()
  res.assertFields(restored, { title: sourceTitle, body: sourceBody, revision: 4n, publication: republished.releaseId })
  assert.equal(restored.rights?.snapshotId, republished.rightsSnapshotId)
  await fx.expectPublicHtml()
  const liveIndex = await index()
  assert.notEqual(liveIndex.generation, hiddenIndex.generation)
  assert(liveIndex.items.some(article => article.id === 1 && article.revision === 4n && article.publication === republished.releaseId))
  await saveShot(page, evidence, 'administrator-article-republished.png', {})

  const privateTitle = 'Never published fixture title', privateBody = 'neverpublictrashrestoremarker'
  const draft = await ownerFx.saveDraft(owner, { id: 1, revision: 4n, title: privateTitle }, privateBody)
  res.assertFields(draft, { id: 1, revision: 5n, title: privateTitle, body: privateBody })
  await ownerFx.deleteDraft(owner, draft)
  await fx.expectWithdrawnArticle()
  const trashIndex = await index()
  await fx.expectStaleIndex(liveIndex.generation)
  await fx.expectWithdrawnCorpus(trashIndex.generation)
  assert(!trashIndex.items.some(article => article.id === 1))

  await loc.exactTab(page, 'Trash').click()
  await loc.exactLabel(inventory, 'Title or summary').fill('')
  await inventory.getByRole('button', { name: 'Search articles' }).press('Enter')
  await loc.exactText(inventory, privateTitle).waitFor()
  const [former] = await Promise.all([trashPreview('1', '6'), loc.exactButton(inventory, 'Restore to draft').press('Enter')])
  await res.assertNoStore(former)
  const formerBytes = await former.body()
  res.assertStatus(former, 200)
  const formerPub = wire.decodeAdminArticleTrashPublicationPreview(decodeFrame(formerBytes, FrameType.AdminArticleTrashPublicationPreview).payload)
  res.assertFields(formerPub, { sourceRevision: 4n, sourcePublicationId: republished.releaseId, title: sourceTitle })
  res.assertNoneIn(formerBytes, privateTitle, privateBody)
  await recover.getByText(sourceTitle, { exact: false }).waitFor()
  const publicReason = 'Restore only the approved former publication from trash'
  await loc.exactLabel(recover, 'Reason for restoring publication').fill(publicReason)
  await saveShot(page, evidence, 'administrator-article-trash-publication-review.png', {})
  const publication = await commitMfaCommand({
    schema: 'AdminArticleTrashPublication', checkMutationId: true,
    button: loc.exactButton(recover, 'Restore former publication with Passkey'), check: loc.exactButton(inventory, 'Check restore result'),
    verifyIntent: intent => res.assertFields(intent, { articleId: 1, expectedRevision: 6n, sourceRevision: 4n,
      sourcePublicationId: republished.releaseId, reason: publicReason }),
    tamperIntent: intent => ({ ...intent, sourceRevision: 5n }),
  })
  res.assertFields(publication, { articleId: 1, revision: 7n, sourceRevision: 4n, sourcePublicationId: republished.releaseId })
  assert(publication.publicationId > 0n && publication.publicationId !== republished.releaseId)
  await inventory.getByRole('status').filter({ hasText: '0 deleted articles' }).waitFor()
  const live = await content()
  res.assertFields(live, { title: sourceTitle, body: sourceBody, revision: 7n, publication: publication.publicationId })
  assert(live.rights?.snapshotId > 0n && live.rights.snapshotId !== republished.rightsSnapshotId)
  await fx.expectStaleIndex(trashIndex.generation)
  assert((await index()).items.some(article => article.id === 1 && article.revision === 7n && article.publication === publication.publicationId))
  await fx.expectPublicHtml([privateTitle, privateBody])
  assert.deepEqual((await res.getFrame(context.request, site(`${R.PublicSearch}?q=${privateBody}`), FrameType.ArticleSearch, decodeSearch)).articles, [])
}
