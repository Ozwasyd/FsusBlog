import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSession, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function verifySignedInCommentReport({ browser, author, siteOrigin, articleId, parentId, evidence }) {
  const guestContext = await browser.newContext()
  const target = String(parentId)
  const route = WireRoutes.CommentReport.replace('{articleId:int}', String(articleId)).replace('{id:long}', target)
  const url = siteOrigin + route
  const publicContext = siteOrigin + WireRoutes.CommentContext.replace('{articleId:int}', String(articleId)).replace('{commentId:long}', target)
  const submittedDetail = 'Private report detail for a real visible native comment.'
  const button = { name: 'Report comment', exact: true }
  try {
    const guest = await guestContext.newPage()
    assert.equal((await guest.goto(`${siteOrigin}/article/${articleId}#comment-${target}`)).status(), 200)
    const publicNode = guest.locator(`[id="comment-${target}"]`)
    await publicNode.waitFor()
    assert.equal(await publicNode.getByRole('button', button).count(), 0)
    const frame = Buffer.from(encodeFrame(FrameType.CommentReportRequest, Buffer.from('{"reasonCode":"spam"}')))
    const binary = { 'Content-Type': 'application/octet-stream' }
    assert.equal((await guestContext.request.post(url, { headers: binary, data: frame })).status(), 401)
    const session = await author.request.get(siteOrigin + WireRoutes.Session)
    assert.equal(session.status(), 200)
    assert.equal(decodeSession(decodeFrame(await session.body(), FrameType.OperatorSession).payload).canAuthor, false)
    const handle = session.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert.match(handle, /^[a-f0-9]{64}$/)
    assert.equal((await author.request.post(url, { headers: { ...binary, [WireHeaders.CurrentSession]: '0'.repeat(64) }, data: frame })).status(), 409)
    const before = await guestContext.request.get(publicContext)
    assert.equal(before.status(), 200)

    await author.bringToFront()
    const action = author.locator(`[id="comment-${target}"]`).getByRole('button', button)
    const dialog = author.getByRole('dialog', { name: 'Report this comment', exact: true })
    const reason = dialog.getByRole('combobox', { name: 'Report reason', exact: true })
    const detail = dialog.getByLabel('Details (optional)', { exact: true })
    const send = dialog.getByRole('button', { name: 'Send report', exact: true })
    let writes = 0
    author.on('request', req => { if (req.url() === url && req.method() === 'POST') writes++ })
    await action.click()
    assert.equal(await send.isDisabled(), true)
    await detail.fill('Cancelling clears this detail.')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(writes, 0)

    const first = await submit('Spam', submittedDetail)
    assert.equal(first.duplicate, false)
    assert.equal(first.code, 'ok')
    assert(Number.isSafeInteger(first.reportId) && first.reportId > 0)
    await dialog.getByText('Your report was saved.', { exact: false }).waitFor()
    await author.screenshot({ path: join(evidence, 'comment-report-mobile-receipt.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const again = await submit('Privacy violation', 'A duplicate must preserve the first details.')
    assert.deepEqual(again, { success: true, code: 'comment_report_duplicate', reportId: first.reportId, duplicate: true })
    await dialog.getByText('You already reported this comment.', { exact: false }).waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(writes, 2)
    const after = await guestContext.request.get(publicContext)
    assert.equal(after.status(), 200)
    assert((await before.body()).equals(await after.body()), 'A report did not change public moderation or content.')
    await writeFile(join(evidence, 'comment-report-result.json'), JSON.stringify({ articleId, commentId: target,
      reportId: first.reportId, duplicateReusedOriginal: true, guestDenied: true, staleSessionDenied: true,
      identicalPublicCommentBytes: true }, null, 2) + '\n')

    async function submit(label, reportDetail) {
      await action.click()
      await dialog.waitFor()
      assert.equal(await detail.inputValue(), '')
      await reason.click()
      await author.getByRole('option', { name: label, exact: true }).click()
      await detail.fill(reportDetail)
      assert.equal(await author.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      const [result] = await Promise.all([author.waitForResponse(response => response.url() === url), send.click()])
      assert.equal(result.status(), 200)
      assert.match((await result.headerValue('Cache-Control')) ?? '', /no-store/)
      const receipt = JSON.parse(Buffer.from(decodeFrame(await result.body(), FrameType.CommentReportResult).payload).toString('utf8'))
      assert.deepEqual(Object.keys(receipt).sort(), ['code', 'duplicate', 'reportId', 'success'])
      assert.equal(receipt.success, true)
      return receipt
    }
  } finally { await guestContext.close() }
}
