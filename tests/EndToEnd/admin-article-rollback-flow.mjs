import assert from 'node:assert/strict'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { adminArticleFixture, sourceTitle } from './admin-article-fixture.mjs'
import * as adminFx from './admin-workspace-fixture.mjs'
import { saveShot } from './isolated-browser-fixture.mjs'
import { assertFields, assertGetStatus, getFrame } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireRoutes: R } = wire

export async function verifyAdminArticleRollback({ page, context, adminOrigin, siteOrigin, owner, adminCookieName, siteCookie, probe, evidence }) {
  await adminFx.visitAdminWorkspace(page, '/admin/articles')
  const fx = adminArticleFixture({ page, context, adminOrigin, siteOrigin })
  const { admin, section, expectSend, openPublicationRecovery, previewRollback, inspect, index, commitMfaCommand } = fx
  const before = await inspect()
  assertFields(before, { revision: 2n, publication: 2n, title: 'Rollback fixture current title' })
  assert.equal(before.rights?.copyrightHolder, 'Current fixture rights')

  for (const route of [R.AdminArticleRollbackAvailability, R.AdminArticleDraftRollbackAvailability]) {
    await probe(admin(route), adminCookieName, siteCookie.value, 401)
    await assertGetStatus(context.request, siteOrigin.origin + route, 404)
  }
  await openPublicationRecovery()
  await section.waitFor()
  await assertGetStatus(context.request, admin(R.AdminArticleDraftRollbackAvailability), 204)
  await previewRollback()
  assert.deepEqual(await inspect(), before)

  const reason = 'Restore the approved historical publication'
  const commandBody = { articleId: 1, expectedRevision: 2n, expectedPublicationId: 2n, sourceRevision: 1n,
    idempotencyKey: crypto.randomUUID(), reason }
  const packed = value => adminFx.packFrame(FrameType.AdminArticleRollbackIntent, wire.encodeAdminArticleRollbackIntent(value))
  await expectSend(R.AdminArticleRollbackExecute, packed(commandBody), 403)
  await expectSend(R.AdminArticleRollbackStepUpBegin, packed(commandBody), 403, { Origin: siteOrigin.origin })

  await loc.exactLabel(section, 'Reason for publishing this revision').fill(reason)
  const publish = loc.exactButton(section, 'Publish revision with Passkey')
  assert(await publish.isDisabled())
  await adminFx.checkLabeledCheckbox(section, 'Publish a new revision with this historical content, rights, and responsibility')

  const committed = await commitMfaCommand({
    schema: 'AdminArticleRollback', button: publish, check: loc.exactButton(section, 'Check publication result'),
    tamperIntent: () => ({ ...commandBody, reason: 'A different requested public rollback' }),
    verifyReceipt: r => assertFields(r, { articleId: 1, revision: 3n, sourceRevision: 1n, previousPublicationId: 2n, publicationNo: 3 }),
  })
  await loc.exactText(section, `Published revision 3 as publication ${committed.publicationId}`).waitFor()
  const after = await inspect()
  assertFields(after, { revision: 3n, publication: committed.publicationId, title: sourceTitle })
  assertFields(after.rights, { copyrightHolder: 'Historical fixture rights', snapshotId: committed.rightsSnapshotId })
  await fx.expectPublicHtml()
  await saveShot(page, evidence, 'administrator-article-rollback.png', {})

  const priorIndex = await index()
  assert(priorIndex.items.some(article => article.id === 1 && article.revision === 3n && article.publication === committed.publicationId))

  const draftReason = 'Restore the historical copy as a private draft and withdraw it'
  const draftBody = { articleId: 1, expectedRevision: 3n, expectedPublicationId: committed.publicationId, sourceRevision: 1n,
    idempotencyKey: crypto.randomUUID(), reason: draftReason, targetStatus: 0 }
  const packedDraft = value => adminFx.packFrame(FrameType.AdminArticleDraftRollbackIntent, wire.encodeAdminArticleDraftRollbackIntent(value))
  await expectSend(R.AdminArticleDraftRollbackExecute, packedDraft(draftBody), 403)
  await expectSend(R.AdminArticleDraftRollbackExecute, packedDraft({ ...draftBody, targetStatus: 3 }), 400)
  await expectSend(R.AdminArticleDraftRollbackStepUpBegin, packedDraft(draftBody), 403, { Origin: siteOrigin.origin })
  await loc.exactButton(section, 'Preview publication rollback').press('Enter')
  await loc.exactHeading(section, sourceTitle).waitFor()
  await loc.exactLabel(section, 'Reason for restoring this revision as a draft').fill(draftReason)
  await loc.exactLabel(section, 'Reason for publishing this revision').fill(reason)
  const withdraw = loc.exactButton(section, 'Restore as draft and withdraw')
  assert(await withdraw.isDisabled())
  await adminFx.checkLabeledCheckbox(section, 'Create a private draft from this revision and withdraw the current publication')
  assert(await publish.isDisabled(), 'Draft confirmation must never authorize publishing')
  assert.equal((await inspect()).publication, committed.publicationId)

  await commitMfaCommand({
    schema: 'AdminArticleDraftRollback', button: withdraw, check: loc.exactButton(section, 'Check draft rollback result'),
    verifyIntent: actual => assert.deepEqual(actual, { ...draftBody, idempotencyKey: actual.idempotencyKey }),
    extraTamper: (actual, headers) => expectSend(R.AdminArticleRollbackExecute, packed(actual), 403, headers),
    tamperIntent: actual => ({ ...actual, reason: 'A different draft rollback request' }),
    verifyReceipt(receipt) {
      assertFields(receipt, { articleId: 1, revision: 4n, sourceRevision: 1n, previousPublicationId: committed.publicationId,
        publicationNo: 4, targetStatus: 0 })
      assert(receipt.privateReleaseId > 0n && receipt.privateReleaseId !== committed.publicationId)
      assert(receipt.rightsSnapshotId > 0n && receipt.rightsSnapshotId !== committed.rightsSnapshotId)
      assert(receipt.responsibilitySnapshotId > 0n && receipt.responsibilitySnapshotId !== committed.responsibilitySnapshotId)
    },
  })
  await loc.exactText(section, 'Restored revision 4 as a private draft').waitFor()

  await fx.expectWithdrawnArticle()
  await fx.expectStaleIndex(priorIndex.generation)
  const hiddenIndex = await index()
  assert.notEqual(hiddenIndex.generation, priorIndex.generation)
  assert(!hiddenIndex.items.some(article => article.id === 1))
  await fx.expectWithdrawnCorpus(hiddenIndex.generation)

  const draft = await getFrame(owner.request, admin(R.Draft.replace('{id:int}', '1')), FrameType.Draft, wire.decodeDraft)
  assertFields(draft, { id: 1, revision: 4n, title: sourceTitle, published: false,
    body: 'Historical Markdown ready for restoration\n\n![Never fetched in source preview](https://archive-preview.invalid/from-source.png)\n' })
  const inventoryRows = (await fx.ownerArticles(owner, '?scope=active&article=1&state=draft')).items
  assert.deepEqual(inventoryRows.map(item => [item.id, item.revision, item.state]), [[1, 4n, 'draft']])
  await saveShot(page, evidence, 'administrator-article-draft-rollback.png', {})
}
