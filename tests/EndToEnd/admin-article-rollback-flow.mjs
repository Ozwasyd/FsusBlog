import { visitAdminWorkspace } from './admin-workspace-fixture.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import {
  decodeAdminArticleDraftRollbackIntent, decodeAdminArticleDraftRollbackReceipt, decodeDraft, encodeAdminArticleDraftRollbackIntent,
  decodeAdminArticleRollbackReceipt, encodeAdminArticleRollbackIntent, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'
import { adminArticleFixture, commitWithLostReceipt, sourceTitle } from './admin-article-fixture.mjs'

export async function verifyAdminArticleRollback({ page, context, adminOrigin, siteOrigin, grant, logIn, evidence }) {
  await visitAdminWorkspace(page, '/admin/articles')
  const { admin, section, send, grantAndSignIn, previewRollback, inspect, index,
    expectStaleIndex, expectWithdrawnArticle, expectWithdrawnCorpus } = adminArticleFixture({ page, context, adminOrigin, siteOrigin })
  const availability = WireRoutes.AdminArticleRollbackAvailability
  const draftAvailability = WireRoutes.AdminArticleDraftRollbackAvailability
  const command = WireRoutes.AdminArticleRollbackExecute
  const before = await inspect()
  assert.deepEqual([before.revision, before.publication, before.title, before.rights?.copyrightHolder],
    [2n, 2n, 'Rollback fixture current title', 'Current fixture rights'])

  assert.equal((await context.request.get(admin(availability))).status(), 403)
  assert.equal((await context.request.get(siteOrigin.origin + availability)).status(), 404)
  assert.equal((await context.request.get(admin(draftAvailability))).status(), 403)
  assert.equal((await context.request.get(siteOrigin.origin + draftAvailability)).status(), 404)
  assert.equal(await section.count(), 0)
  await grantAndSignIn(grant, logIn)
  await section.waitFor()
  assert.equal((await context.request.get(admin(draftAvailability))).status(), 204)
  await previewRollback()
  assert.deepEqual(await inspect(), before)

  const reason = 'Restore the approved historical publication'
  const commandBody = {
    articleId: 1, expectedRevision: 2n, expectedPublicationId: 2n, sourceRevision: 1n,
    idempotencyKey: crypto.randomUUID(), reason,
  }
  const packed = value => Buffer.from(encodeFrame(FrameType.AdminArticleRollbackIntent, encodeAdminArticleRollbackIntent(value)))
  assert.equal((await send(command, packed(commandBody))).status(), 403)
  assert.equal((await send(WireRoutes.AdminArticleRollbackStepUpBegin, packed(commandBody), { Origin: siteOrigin.origin })).status(), 403)

  await section.getByLabel('Reason for publishing this revision', { exact: true }).fill(reason)
  const publish = section.getByRole('button', { name: 'Publish revision with Passkey', exact: true })
  assert(await publish.isDisabled())
  const confirmationText = 'Publish a new revision with this historical content, rights, and responsibility'
  await section.getByText(confirmationText, { exact: true }).click()
  assert(await section.getByRole('checkbox', { name: confirmationText, exact: true }).isChecked())

  const committed = await commitWithLostReceipt({
    page, url: admin(command), button: publish,
    check: section.getByRole('button', { name: 'Check publication result', exact: true }),
    async verifyRequest(request) {
      const authorization = await request.headerValue(WireHeaders.MfaProof)
      assert(/^[A-Za-z0-9_-]{43}$/.test(authorization ?? ''), 'The exact command has a live Passkey proof')
      const altered = await send(command, packed({ ...commandBody, reason: 'A different requested public rollback' }),
        { [WireHeaders.MfaProof]: authorization })
      assert.equal(altered.status(), 403)
      await altered.dispose()
    },
    readReceipt(bytes) {
      const receipt = decodeAdminArticleRollbackReceipt(decodeFrame(bytes, FrameType.AdminArticleRollbackReceipt).payload)
      assert.deepEqual([receipt.articleId, receipt.revision, receipt.sourceRevision, receipt.previousPublicationId,
        receipt.publicationNo], [1, 3n, 1n, 2n, 3])
      return receipt
    },
  })
  await section.getByText(`Published revision 3 as publication ${committed.publicationId}`, { exact: true }).waitFor()
  const after = await inspect()
  assert.deepEqual([after.revision, after.publication, after.title, after.rights?.copyrightHolder, after.rights?.snapshotId],
    [3n, committed.publicationId, 'Rollback fixture source title', 'Historical fixture rights', committed.rightsSnapshotId])
  const html = await context.request.get(siteOrigin.origin + '/article/1')
  assert.equal(html.status(), 200)
  assert.match(await html.text(), /Historical Markdown ready for restoration/)
  await page.screenshot({ path: join(evidence, 'administrator-article-rollback.png') })

  const priorIndex = await index()
  assert(priorIndex.items.some(article => article.id === 1 && article.revision === 3n && article.publication === committed.publicationId))

  const draftReason = 'Restore the historical copy as a private draft and withdraw it'
  const draftCommand = WireRoutes.AdminArticleDraftRollbackExecute
  const draftBody = {
    articleId: 1, expectedRevision: 3n, expectedPublicationId: committed.publicationId, sourceRevision: 1n,
    idempotencyKey: crypto.randomUUID(), reason: draftReason, targetStatus: 0,
  }
  const packedDraft = value => Buffer.from(encodeFrame(FrameType.AdminArticleDraftRollbackIntent, encodeAdminArticleDraftRollbackIntent(value)))
  assert.equal((await send(draftCommand, packedDraft(draftBody))).status(), 403)
  assert.equal((await send(draftCommand, packedDraft({ ...draftBody, targetStatus: 3 }))).status(), 400)
  assert.equal((await send(WireRoutes.AdminArticleDraftRollbackStepUpBegin, packedDraft(draftBody), { Origin: siteOrigin.origin })).status(), 403)
  await section.getByRole('button', { name: 'Preview publication rollback', exact: true }).press('Enter')
  await section.getByRole('heading', { name: sourceTitle, exact: true }).waitFor()
  await section.getByLabel('Reason for restoring this revision as a draft', { exact: true }).fill(draftReason)
  await section.getByLabel('Reason for publishing this revision', { exact: true }).fill(reason)
  const withdraw = section.getByRole('button', { name: 'Restore as draft and withdraw', exact: true })
  assert(await withdraw.isDisabled())
  const draftConfirmation = 'Create a private draft from this revision and withdraw the current publication'
  await section.getByText(draftConfirmation, { exact: true }).click()
  assert(await section.getByRole('checkbox', { name: draftConfirmation, exact: true }).isChecked())
  assert(await publish.isDisabled(), 'Draft confirmation must never authorize publishing')
  assert.equal((await inspect()).publication, committed.publicationId)

  await commitWithLostReceipt({
    page, url: admin(draftCommand), button: withdraw,
    check: section.getByRole('button', { name: 'Check draft rollback result', exact: true }),
    async verifyRequest(request, sent) {
      const actual = decodeAdminArticleDraftRollbackIntent(decodeFrame(sent, FrameType.AdminArticleDraftRollbackIntent).payload)
      assert.deepEqual(actual, { ...draftBody, idempotencyKey: actual.idempotencyKey })
      const authorization = await request.headerValue(WireHeaders.MfaProof)
      assert(/^[A-Za-z0-9_-]{43}$/.test(authorization ?? ''), 'The Draft operation has a fresh Passkey proof')
      const proof = { [WireHeaders.MfaProof]: authorization }
      const wrongAction = await send(command, packed(actual), proof)
      assert.equal(wrongAction.status(), 403, 'A Draft proof cannot authorize the same fields for publishing')
      await wrongAction.dispose()
      const altered = await send(draftCommand, packedDraft({ ...actual, reason: 'A different draft rollback request' }), proof)
      assert.equal(altered.status(), 403)
      await altered.dispose()
    },
    readReceipt(bytes) {
      const receipt = decodeAdminArticleDraftRollbackReceipt(decodeFrame(bytes, FrameType.AdminArticleDraftRollbackReceipt).payload)
      assert.deepEqual([receipt.articleId, receipt.revision, receipt.sourceRevision, receipt.previousPublicationId,
        receipt.publicationNo, receipt.targetStatus], [1, 4n, 1n, committed.publicationId, 4, 0])
      assert(receipt.privateReleaseId > 0n && receipt.privateReleaseId !== committed.publicationId)
      assert(receipt.rightsSnapshotId > 0n && receipt.rightsSnapshotId !== committed.rightsSnapshotId)
      assert(receipt.responsibilitySnapshotId > 0n && receipt.responsibilitySnapshotId !== committed.responsibilitySnapshotId)
      return receipt
    },
  })
  await section.getByText('Restored revision 4 as a private draft', { exact: true }).waitFor()

  await expectWithdrawnArticle()
  await expectStaleIndex(priorIndex.generation)
  const hiddenIndex = await index()
  assert.notEqual(hiddenIndex.generation, priorIndex.generation)
  assert(!hiddenIndex.items.some(article => article.id === 1))
  await expectWithdrawnCorpus(hiddenIndex.generation)

  const ownerDraft = await context.request.get(siteOrigin.origin + WireRoutes.Draft.replace('{id:int}', '1'))
  assert.equal(ownerDraft.status(), 200)
  const draft = decodeDraft(decodeFrame(await ownerDraft.body(), FrameType.Draft).payload)
  assert.deepEqual([draft.id, draft.revision, draft.title, draft.body, draft.published],
    [1, 4n, 'Rollback fixture source title',
      'Historical Markdown ready for restoration\n\n![Never fetched in source preview](https://archive-preview.invalid/from-source.png)\n', false])
  await ownerDraft.dispose()
  const inventory = await context.request.get(siteOrigin.origin + WireRoutes.AuthorArticles + '?scope=active&article=1&state=draft')
  assert.equal(inventory.status(), 200)
  const inventoryRows = decodeAuthorArticlePage(decodeFrame(await inventory.body(), FrameType.AuthorArticlePage).payload).items
  assert.deepEqual(inventoryRows.map(item => [item.id, item.revision, item.state]), [[1, 4n, 'draft']])
  await inventory.dispose()
  await page.screenshot({ path: join(evidence, 'administrator-article-draft-rollback.png') })
}
