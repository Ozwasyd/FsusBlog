import assert from 'node:assert/strict'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { clickForResponse, packFrame, selectOption } from './admin-workspace-fixture.mjs'
import { binary, readReaderSession } from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { assertNoStore, assertStatus, readJsonFrame } from './response-status-fixture.mjs'
import { exactButton, exactLabel, roleWithExactName } from './role-locators.mjs'

export function verifySignedInCommentReport({ browser, author, siteOrigin, articleId, parentId, evidence }) {
  const target = String(parentId)
  const url = siteOrigin + WireRoutes.CommentReport.replace('{articleId:int}', String(articleId)).replace('{id:long}', target)
  const publicContext = siteOrigin + WireRoutes.CommentContext.replace('{articleId:int}', String(articleId)).replace('{commentId:long}', target)
  const submittedDetail = 'Private report detail for a real visible native comment.'
  const button = { name: 'Report comment', exact: true }
  return isolated.withTempContext(browser, async guestContext => {
    await guestContext.addCookies([{ name: 'fsus_locale', value: 'en', url: siteOrigin }])
    const guest = await guestContext.newPage()
    assertStatus(await guest.goto(`${siteOrigin}/article/${articleId}#comment-${target}`), 200)
    const publicNode = guest.locator(`[id="comment-${target}"]`)
    await publicNode.waitFor()
    assert.equal(await publicNode.getByRole('button', button).count(), 0)
    const frame = packFrame(FrameType.CommentReportRequest, Buffer.from('{"reasonCode":"spam"}'))
    assertStatus(await guestContext.request.post(url, { headers: binary, data: frame }), 401)
    await readReaderSession(author, siteOrigin)
    assertStatus(await author.request.post(url, { headers: { ...binary, [WireHeaders.CurrentSession]: '0'.repeat(64) }, data: frame }), 409)
    const before = await guestContext.request.get(publicContext)
    assertStatus(before, 200)

    await author.bringToFront()
    const action = author.locator(`[id="comment-${target}"]`).getByRole('button', button)
    const dialog = roleWithExactName(author, 'dialog', 'Report this comment')
    const detail = exactLabel(dialog, 'Details (optional)')
    const send = exactButton(dialog, 'Send report')
    let writes = 0
    author.on('request', req => { if (req.url() === url && req.method() === 'POST') writes++ })
    await action.click()
    assert.equal(await send.isDisabled(), true)
    await detail.fill('Cancelling clears this detail.')
    await exactButton(dialog, 'Cancel').click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(writes, 0)

    const first = await submit('Spam', submittedDetail)
    assert.equal(first.duplicate, false)
    assert.equal(first.code, 'ok')
    assert(Number.isSafeInteger(first.reportId) && first.reportId > 0)
    await dialog.getByText('Your report was saved.', { exact: false }).waitFor()
    await isolated.saveShot(author, evidence, 'comment-report-mobile-receipt.png')
    await exactButton(dialog, 'Close').click()
    const again = await submit('Privacy violation', 'A duplicate must preserve the first details.')
    assert.deepEqual(again, { success: true, code: 'comment_report_duplicate', reportId: first.reportId, duplicate: true })
    await dialog.getByText('You already reported this comment.', { exact: false }).waitFor()
    await exactButton(dialog, 'Close').click()
    assert.equal(writes, 2)
    const after = await guestContext.request.get(publicContext)
    assertStatus(after, 200)
    assert((await before.body()).equals(await after.body()), 'A report did not change public moderation or content.')
    await isolated.writeEvidenceJson(evidence, 'comment-report-result.json', { articleId, commentId: target,
      reportId: first.reportId, duplicateReusedOriginal: true, guestDenied: true, staleSessionDenied: true,
      identicalPublicCommentBytes: true })

    async function submit(label, reportDetail) {
      await action.click()
      await dialog.waitFor()
      assert.equal(await detail.inputValue(), '')
      await selectOption(author, dialog, 'Report reason', label)
      await detail.fill(reportDetail)
      await isolated.assertNoOverflow(author)
      const result = await clickForResponse(author, url, send, 'POST')
      await assertNoStore(result)
      const receipt = await readJsonFrame(result, FrameType.CommentReportResult)
      assert.deepEqual(Object.keys(receipt).sort(), ['code', 'duplicate', 'reportId', 'success'])
      assert.equal(receipt.success, true)
      return receipt
    }
  })
}
