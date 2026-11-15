import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodePublicCommentReply, decodePublicCommentSubmissionResult, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function verifyApprovedReply({ browser, siteOrigin, evidence, articleId, parentId, approve }) {
  const authorTicket = process.env.FSUSBLOG_TEST_REPLY_AUTHOR_TICKET
  const parentTicket = execFileSync(process.env.FSUSBLOG_TEST_REPLY_PARENT_TICKET, [], { encoding: 'utf8' }).trim()
  assert.match(authorTicket, /^[a-f0-9]{64}$/)
  assert.match(parentTicket, /^[a-f0-9]{64}$/)
  const recipientContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const authorContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const body = 'Reply fixture validates independent moderation and private delivery.'
  const subject = '收到新的评论回复'
  try {
    const author = await login(authorContext, authorTicket)
    const recipient = await login(recipientContext, parentTicket)
    const errors = []
    for (const page of [author, recipient]) {
      page.on('pageerror', error => errors.push(error.message))
      page.on('response', response => {
        if (response.status() >= 500 || (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/assets/')))
          errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
      })
    }
    await author.bringToFront()
    const articleUrl = `${siteOrigin}/article/${articleId}`
    assert.equal((await author.goto(articleUrl)).status(), 200)
    await author.getByRole('heading', { name: 'Moderation fixture article', exact: true }).waitFor()
    assert.match(await author.title(), /Moderation fixture article/)
    const parent = author.locator(`[id="comment-${parentId}"]`)
    const reply = parent.getByRole('button', { name: 'Reply', exact: true })
    await reply.click()
    const composer = author.getByRole('heading', { name: 'Reply to Moderation fixture writer', exact: true })
    await composer.waitFor()
    assert.equal(await composer.evaluate(heading => heading.closest('[tabindex="-1"]') === document.activeElement), true)
    const input = author.getByLabel('Reply', { exact: true })
    const confirm = author.getByRole('checkbox', { name: 'Publish as Reply fixture writer after review' })
    const confirmLabel = author.getByText('Publish as Reply fixture writer after review', { exact: true })
    const send = author.getByRole('button', { name: 'Submit for review' })
    await input.fill('This unconfirmed text belongs to the first reply state.')
    await confirmLabel.click()
    assert.equal(await confirm.isChecked(), true)
    await author.getByRole('button', { name: 'Cancel reply' }).click()
    await reply.click()
    assert.equal(await input.inputValue(), '')
    assert.equal(await confirm.isChecked(), false)
    assert.equal(await send.isDisabled(), true)
    await input.fill(body)
    await confirmLabel.click()
    assert.equal(await confirm.isChecked(), true)
    assert.equal(await author.locator('vite-error-overlay').count(), 0)
    assert.equal(await author.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await author.screenshot({ path: join(evidence, 'comment-reply-compose-mobile.png'), animations: 'disabled' })
    const [challenge, submitted] = await Promise.all([
      author.waitForResponse(response => response.url() === siteOrigin + WireRoutes.PublicCommentReplyPow),
      author.waitForResponse(response => response.url() === siteOrigin + WireRoutes.SubmitPublicCommentReply),
      send.click(),
    ])
    assert.equal(challenge.status(), 200)
    assert.equal(submitted.status(), 200)
    assert(challenge.request().postDataBuffer().equals(submitted.request().postDataBuffer()))
    assert.equal(decodePublicCommentReply(decodeFrame(submitted.request().postDataBuffer(), FrameType.PublicCommentReply).payload).parentId, parentId)
    const receipt = decodePublicCommentSubmissionResult(decodeFrame(await submitted.body(), FrameType.PublicCommentSubmissionResult).payload)
    assert.equal(receipt.moderationStatus, 0)
    await author.getByText('Reply submitted for review.', { exact: true }).waitFor()

    await recipient.bringToFront()
    const before = recipient.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.InboxList)
    assert.equal((await recipient.goto(siteOrigin + '/user/messagebox')).status(), 200)
    await recipient.getByRole('heading', { name: '我的站内信' }).waitFor()
    assert.equal((await before).status(), 200)
    assert.match(await recipient.title(), /我的站内信/)
    const notice = recipient.getByRole('button', { name: new RegExp(subject) })
    assert.equal(await notice.count(), 0)
    const publicContext = WireRoutes.CommentContext.replace('{articleId:int}', articleId).replace('{commentId:long}', receipt.commentId)
    assert(!(await (await authorContext.request.get(siteOrigin + publicContext)).body()).includes(Buffer.from(body)))
    await approve(body, receipt.commentId)
    await recipient.bringToFront()
    await notice.waitFor({ timeout: 20_000 })
    const [inboxThread] = await Promise.all([
      recipient.waitForResponse(response => /^\/api\/binary\/messages\/conversations\/\d+$/.test(new URL(response.url()).pathname)),
      notice.click(),
    ])
    assert.equal(inboxThread.status(), 200)
    const permalink = `/article/${articleId}#comment-${receipt.commentId}`
    await recipient.getByRole('heading', { name: subject }).waitFor()
    await recipient.getByText(`Reply fixture writer 回复了您的评论：${body.slice(0, 40)}。定位：${permalink}`, { exact: true }).last().waitFor()
    assert.equal((await authorContext.request.get(inboxThread.url())).status(), 404)
    await recipient.screenshot({ path: join(evidence, 'comment-reply-private-inbox.png'), animations: 'disabled' })
    assert.equal((await recipient.goto(siteOrigin + permalink)).status(), 200)
    const target = recipient.locator(`[id="comment-${receipt.commentId}"]`)
    await target.getByText(body, { exact: true }).waitFor()
    assert.equal(await target.evaluate(element => element === document.activeElement), true)
    assert.equal(await recipient.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await authorContext.close()
    await recipientContext.close()
  }

  async function login(context, ticket) {
    const page = await context.newPage()
    assert.equal((await page.goto(siteOrigin + '/login')).status(), 200)
    await page.getByLabel('Owner access key').fill(ticket)
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.waitForURL(siteOrigin + '/user/manage/article/write')
    return page
  }
}
