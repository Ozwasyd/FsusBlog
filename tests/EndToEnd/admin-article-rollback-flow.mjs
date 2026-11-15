import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { queryCorpusPage, searchTerms } from '../../src/Contracts/local-search.ts'
import { decodeArticle, decodeSearch } from '../../src/Contracts/public-articles.ts'
import {
  decodeAdminArticleDraftRollbackIntent, decodeAdminArticleDraftRollbackReceipt, decodeDraft, encodeAdminArticleDraftRollbackIntent,
  decodeAdminArticleRollbackReceipt, encodeAdminArticleRollbackIntent, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

export async function verifyAdminArticleRollback({ page, context, adminOrigin, siteOrigin, grant, logIn, evidence }) {
  const admin = path => adminOrigin.origin + path
  const publicApi = siteOrigin.origin + WireRoutes.PublicArticle.replace('{id}', '1')
  const availability = WireRoutes.AdminArticleRollbackAvailability
  const draftAvailability = WireRoutes.AdminArticleDraftRollbackAvailability
  const section = page.getByRole('region', { name: 'Restore a published article revision', exact: true })
  const command = WireRoutes.AdminArticleRollbackExecute
  const inspect = async () => {
    const response = await context.request.get(publicApi)
    assert.equal(response.status(), 200)
    return decodeArticle(decodeFrame(await response.body(), FrameType.ArticleDetail).payload)
  }
  const before = await inspect()
  assert.deepEqual([before.revision, before.publication, before.title, before.rights?.copyrightHolder],
    [2n, 2n, 'Rollback fixture current title', 'Current fixture rights'])

  assert.equal((await context.request.get(admin(availability))).status(), 403)
  assert.equal((await context.request.get(siteOrigin.origin + availability)).status(), 404)
  assert.equal((await context.request.get(admin(draftAvailability))).status(), 403)
  assert.equal((await context.request.get(siteOrigin.origin + draftAvailability)).status(), 404)
  assert.equal(await section.count(), 0)
  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await page.reload()
  await logIn(page)
  await section.waitFor()
  assert.equal((await context.request.get(admin(draftAvailability))).status(), 204)
  await section.getByRole('textbox', { name: 'Article ID', exact: true }).fill('1')
  await section.getByRole('textbox', { name: 'Historical revision', exact: true }).fill('1')
  await section.getByRole('button', { name: 'Preview publication rollback', exact: true }).press('Enter')
  await section.getByRole('heading', { name: 'Rollback fixture source title', exact: true }).waitFor()
  assert.deepEqual(await inspect(), before)

  const reason = 'Restore the approved historical publication'
  const commandBody = {
    articleId: 1, expectedRevision: 2n, expectedPublicationId: 2n, sourceRevision: 1n,
    idempotencyKey: crypto.randomUUID(), reason,
  }
  const packed = value => Buffer.from(encodeFrame(FrameType.AdminArticleRollbackIntent, encodeAdminArticleRollbackIntent(value)))
  const send = (path, body, headers = {}) => context.request.post(admin(path), {
    headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream', ...headers }, data: body,
  })
  assert.equal((await send(command, packed(commandBody))).status(), 403)
  assert.equal((await send(WireRoutes.AdminArticleRollbackStepUpBegin, packed(commandBody), { Origin: siteOrigin.origin })).status(), 403)

  await section.getByLabel('Reason for publishing this revision', { exact: true }).fill(reason)
  const publish = section.getByRole('button', { name: 'Publish revision with Passkey', exact: true })
  assert(await publish.isDisabled())
  const confirmationText = 'Publish a new revision with this historical content, rights, and responsibility'
  await section.getByText(confirmationText, { exact: true }).click()
  assert(await section.getByRole('checkbox', { name: confirmationText, exact: true }).isChecked())

  const transport = Promise.withResolvers()
  const commandUrl = admin(command)
  const loseResponse = async route => {
    try {
      const request = route.request()
      const sent = request.postDataBuffer()
      const authorization = await request.headerValue(WireHeaders.MfaProof)
      assert(/^[A-Za-z0-9_-]{43}$/.test(authorization ?? ''), 'The exact command has a live Passkey proof')
      const altered = await send(command, packed({ ...commandBody, reason: 'A different requested public rollback' }),
        { [WireHeaders.MfaProof]: authorization })
      assert.equal(altered.status(), 403)
      await altered.dispose()
      const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      try {
        assert.equal(real.status(), 200)
        const bytes = await real.body()
        const receipt = decodeAdminArticleRollbackReceipt(decodeFrame(bytes, FrameType.AdminArticleRollbackReceipt).payload)
        assert.deepEqual([receipt.articleId, receipt.revision, receipt.sourceRevision, receipt.previousPublicationId,
          receipt.publicationNo], [1, 3n, 1n, 2n, 3])
        await route.abort('connectionreset')
        transport.resolve({ sent, bytes, receipt })
      } finally { await real.dispose() }
    } catch (error) {
      await route.abort('failed').catch(() => {})
      transport.reject(error)
    }
  }
  await page.route(commandUrl, loseResponse, { times: 1 })
  let attempted
  try {
    attempted = await Promise.all([transport.promise, publish.press('Enter')])
  } finally { await page.unroute(commandUrl, loseResponse) }
  const [committed] = attempted
  const check = section.getByRole('button', { name: 'Check publication result', exact: true })
  await check.waitFor()
  const [retry] = await Promise.all([
    page.waitForResponse(response => response.url() === commandUrl && response.request().method() === 'POST'),
    check.press('Enter'),
  ])
  assert.equal(retry.status(), 200)
  assert.deepEqual(retry.request().postDataBuffer(), committed.sent)
  assert.equal(await retry.request().headerValue(WireHeaders.MfaProof), null)
  assert.deepEqual(await retry.body(), committed.bytes)
  await section.getByText(`Published revision 3 as publication ${committed.receipt.publicationId}`, { exact: true }).waitFor()
  const after = await inspect()
  assert.deepEqual([after.revision, after.publication, after.title, after.rights?.copyrightHolder, after.rights?.snapshotId],
    [3n, committed.receipt.publicationId, 'Rollback fixture source title', 'Historical fixture rights', committed.receipt.rightsSnapshotId])
  const html = await context.request.get(siteOrigin.origin + '/article/1')
  assert.equal(html.status(), 200)
  assert.match(await html.text(), /Historical Markdown ready for restoration/)
  await page.screenshot({ path: join(evidence, 'administrator-article-rollback.png') })

  const indexPath = siteOrigin.origin + WireRoutes.PublicIndex
  const corpusPath = siteOrigin.origin + WireRoutes.PublicSearchCorpus
  const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
  const priorIndex = await context.request.get(`${indexPath}?page=1`)
  const priorGeneration = priorIndex.headers()[generationHeader]
  assert.equal(priorIndex.status(), 200)
  assert.match(priorGeneration, /^\d+$/)
  assert(decodeSearch(decodeFrame(await priorIndex.body(), FrameType.ArticleSearch).payload).articles
    .some(article => article.id === 1 && article.revision === 3n && article.publication === committed.receipt.publicationId))
  await priorIndex.dispose()

  const draftReason = 'Restore the historical copy as a private draft and withdraw it'
  const draftCommand = WireRoutes.AdminArticleDraftRollbackExecute
  const draftCommandUrl = admin(draftCommand)
  const draftBody = {
    articleId: 1, expectedRevision: 3n, expectedPublicationId: committed.receipt.publicationId, sourceRevision: 1n,
    idempotencyKey: crypto.randomUUID(), reason: draftReason, targetStatus: 0,
  }
  const packedDraft = value => Buffer.from(encodeFrame(FrameType.AdminArticleDraftRollbackIntent, encodeAdminArticleDraftRollbackIntent(value)))
  assert.equal((await send(draftCommand, packedDraft(draftBody))).status(), 403)
  assert.equal((await send(draftCommand, packedDraft({ ...draftBody, targetStatus: 3 }))).status(), 400)
  assert.equal((await send(WireRoutes.AdminArticleDraftRollbackStepUpBegin, packedDraft(draftBody), { Origin: siteOrigin.origin })).status(), 403)
  await section.getByRole('button', { name: 'Preview publication rollback', exact: true }).press('Enter')
  await section.getByRole('heading', { name: 'Rollback fixture source title', exact: true }).waitFor()
  await section.getByLabel('Reason for restoring this revision as a draft', { exact: true }).fill(draftReason)
  await section.getByLabel('Reason for publishing this revision', { exact: true }).fill(reason)
  const withdraw = section.getByRole('button', { name: 'Restore as draft and withdraw', exact: true })
  assert(await withdraw.isDisabled())
  const draftConfirmation = 'Create a private draft from this revision and withdraw the current publication'
  await section.getByText(draftConfirmation, { exact: true }).click()
  assert(await section.getByRole('checkbox', { name: draftConfirmation, exact: true }).isChecked())
  assert(await publish.isDisabled(), 'Draft confirmation must never authorize publishing')
  assert.equal((await inspect()).publication, committed.receipt.publicationId)

  const draftTransport = Promise.withResolvers()
  const loseDraftResponse = async route => {
    try {
      const request = route.request()
      const sent = request.postDataBuffer()
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

      const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      try {
        assert.equal(real.status(), 200)
        const bytes = await real.body()
        const receipt = decodeAdminArticleDraftRollbackReceipt(decodeFrame(bytes, FrameType.AdminArticleDraftRollbackReceipt).payload)
        assert.deepEqual([receipt.articleId, receipt.revision, receipt.sourceRevision, receipt.previousPublicationId,
          receipt.publicationNo, receipt.targetStatus], [1, 4n, 1n, committed.receipt.publicationId, 4, 0])
        assert(receipt.privateReleaseId > 0n && receipt.privateReleaseId !== committed.receipt.publicationId)
        assert(receipt.rightsSnapshotId > 0n && receipt.rightsSnapshotId !== committed.receipt.rightsSnapshotId)
        assert(receipt.responsibilitySnapshotId > 0n && receipt.responsibilitySnapshotId !== committed.receipt.responsibilitySnapshotId)
        await route.abort('connectionreset')
        draftTransport.resolve({ sent, bytes })
      } finally { await real.dispose() }
    } catch (error) {
      await route.abort('failed').catch(() => {})
      draftTransport.reject(error)
    }
  }
  await page.route(draftCommandUrl, loseDraftResponse, { times: 1 })
  let withdrawn
  try {
    const [receipt] = await Promise.all([draftTransport.promise, withdraw.press('Enter')])
    withdrawn = receipt
  } finally { await page.unroute(draftCommandUrl, loseDraftResponse) }
  const checkDraft = section.getByRole('button', { name: 'Check draft rollback result', exact: true })
  await checkDraft.waitFor()
  const [draftRetry] = await Promise.all([
    page.waitForResponse(response => response.url() === draftCommandUrl && response.request().method() === 'POST'),
    checkDraft.press('Enter'),
  ])
  assert.equal(draftRetry.status(), 200)
  assert.deepEqual(draftRetry.request().postDataBuffer(), withdrawn.sent)
  assert.equal(await draftRetry.request().headerValue(WireHeaders.MfaProof), null)
  assert.deepEqual(await draftRetry.body(), withdrawn.bytes)
  await section.getByText('Restored revision 4 as a private draft', { exact: true }).waitFor()

  const missing = await context.request.get(publicApi)
  assert.equal(missing.status(), 404)
  decodeFrame(await missing.body(), FrameType.ApiError)
  await missing.dispose()
  const withdrawnHtml = await context.request.get(siteOrigin.origin + '/article/1')
  assert.equal(withdrawnHtml.status(), 404)
  assert.doesNotMatch(await withdrawnHtml.text(), /Historical Markdown ready for restoration/)
  await withdrawnHtml.dispose()
  const oldIndex = await context.request.get(`${indexPath}?page=1&generation=${priorGeneration}`)
  assert.equal(oldIndex.status(), 409)
  await oldIndex.dispose()
  const index = await context.request.get(`${indexPath}?page=1`)
  assert.equal(index.status(), 200)
  const generation = index.headers()[generationHeader]
  assert.notEqual(generation, priorGeneration)
  assert(!decodeSearch(decodeFrame(await index.body(), FrameType.ArticleSearch).payload).articles.some(article => article.id === 1))
  await index.dispose()
  const corpus = await context.request.get(`${corpusPath}?page=1`)
  assert.equal(corpus.status(), 200)
  assert.equal(corpus.headers()[generationHeader], generation)
  assert(!queryCorpusPage(await corpus.body(), searchTerms('Historical Markdown')).documents.has(1))
  await corpus.dispose()

  const ownerDraft = await context.request.get(siteOrigin.origin + WireRoutes.Draft.replace('{id:int}', '1'))
  assert.equal(ownerDraft.status(), 200)
  const draft = decodeDraft(decodeFrame(await ownerDraft.body(), FrameType.Draft).payload)
  assert.deepEqual([draft.id, draft.revision, draft.title, draft.body, draft.published],
    [1, 4n, 'Rollback fixture source title', 'Historical Markdown ready for restoration', false])
  await ownerDraft.dispose()
  const inventory = await context.request.get(siteOrigin.origin + WireRoutes.AuthorArticles + '?scope=active&article=1&state=draft')
  assert.equal(inventory.status(), 200)
  const inventoryRows = decodeAuthorArticlePage(decodeFrame(await inventory.body(), FrameType.AuthorArticlePage).payload).items
  assert.deepEqual(inventoryRows.map(item => [item.id, item.revision, item.state]), [[1, 4n, 'draft']])
  await inventory.dispose()
  await page.screenshot({ path: join(evidence, 'administrator-article-draft-rollback.png') })
}
