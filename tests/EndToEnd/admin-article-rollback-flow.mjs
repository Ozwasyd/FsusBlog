import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import {
  decodeAdminArticleRollbackReceipt, encodeAdminArticleRollbackIntent, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

export async function verifyAdminArticleRollback({ page, context, adminOrigin, siteOrigin, grant, logIn, evidence }) {
  const admin = path => adminOrigin.origin + path
  const publicApi = siteOrigin.origin + WireRoutes.PublicArticle.replace('{id}', '1')
  const availability = WireRoutes.AdminArticleRollbackAvailability
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
  assert.equal(await section.count(), 0)
  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await page.reload()
  await logIn(page)
  await section.waitFor()
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
}
