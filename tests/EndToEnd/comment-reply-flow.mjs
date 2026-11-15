import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCommentContext } from '../../src/Contracts/comment-read.ts'
import { decodeInboxThread } from '../../src/Contracts/inbox.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeCommentAuthorEditDetail, decodePublicCommentReply, decodePublicCommentSubmissionResult, decodeSession,
  FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

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
    const receipt = await submitReply(author, siteOrigin, send, parentId)
    assert.equal(receipt.articleId, articleId)

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
    if (process.env.FSUSBLOG_TEST_COMMENT_EDIT === '1')
      await verifyCommentEdit({ browser, author, recipient, siteOrigin, evidence, articleId, parentId, replyId: receipt.commentId,
        body, permalink, inboxUrl: inboxThread.url(), approve })
    if (process.env.FSUSBLOG_TEST_COMMENT_REPORT === '1') {
      const { verifySignedInCommentReport } = await import('./comment-report-flow.mjs')
      await verifySignedInCommentReport({ browser, author, siteOrigin, articleId, parentId, evidence })
    }
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

async function submitReply(page, origin, send, parentId) {
  const [challenge, submitted] = await Promise.all([
    page.waitForResponse(response => response.url() === origin + WireRoutes.PublicCommentReplyPow),
    page.waitForResponse(response => response.url() === origin + WireRoutes.SubmitPublicCommentReply),
    send.click(),
  ])
  assert.equal(challenge.status(), 200)
  assert.equal(submitted.status(), 200)
  assert(challenge.request().postDataBuffer().equals(submitted.request().postDataBuffer()))
  assert.equal(decodePublicCommentReply(decodeFrame(submitted.request().postDataBuffer(), FrameType.PublicCommentReply).payload).parentId, parentId)
  const receipt = decodePublicCommentSubmissionResult(decodeFrame(await submitted.body(), FrameType.PublicCommentSubmissionResult).payload)
  assert.equal(receipt.moderationStatus, 0)
  await page.getByText('Reply submitted for review.', { exact: true }).waitFor()
  return receipt
}

async function verifyCommentEdit({ browser, author, recipient, siteOrigin, evidence, articleId, parentId, replyId, body, permalink, inboxUrl, approve }) {
  const anon = await browser.newContext()
  const menu = { name: 'Edit my comment', exact: true }
  const key = (route, id) => siteOrigin + route.replace('{id:long}', String(id))
  const detailUrl = key(WireRoutes.CommentAuthorEditDetail, replyId)
  const challengeUrl = key(WireRoutes.CommentAuthorChallenge, replyId)
  const editUrl = key(WireRoutes.CommentAuthorEdit, replyId)
  const newBody = 'Owner correction to the same reply, approved only after a new review.'
  const childBody = 'Public child remains attached to the reply while the edit is pending.'
  const selector = id => `[id="comment-${id}"]`
  try {
    const ownerSession = await author.request.get(siteOrigin + WireRoutes.Session)
    assert.equal(ownerSession.status(), 200)
    assert.equal(decodeSession(decodeFrame(await ownerSession.body(), FrameType.OperatorSession).payload).canAuthor, false)
    const otherSession = await recipient.request.get(siteOrigin + WireRoutes.Session)
    assert.equal(otherSession.status(), 200)
    const otherHandle = otherSession.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(/^[a-f0-9]{64}$/.test(otherHandle ?? ''))
    assert.equal((await anon.request.get(detailUrl)).status(), 401)
    const denied = await recipient.request.get(detailUrl, { headers: { [WireHeaders.CurrentSession]: otherHandle } })
    assert.equal(denied.status(), 404)
    assertNoCommentText(await denied.body())
    await recipient.locator(selector(parentId)).getByRole('button', menu).waitFor()
    assert.equal(await recipient.locator(selector(replyId)).getByRole('button', menu).count(), 0)

    const guest = await anon.newPage()
    assert.equal((await guest.goto(siteOrigin + permalink)).status(), 200)
    await guest.locator(selector(replyId)).getByText(body, { exact: true }).waitFor()
    assert.equal(await guest.locator(selector(replyId)).getByRole('button', menu).count(), 0)

    await recipient.bringToFront()
    await recipient.locator(selector(replyId)).getByRole('button', { name: 'Reply', exact: true }).click()
    await recipient.getByLabel('Reply', { exact: true }).fill(childBody)
    await recipient.getByText('Publish as Moderation fixture writer after review', { exact: true }).click()
    const child = await submitReply(recipient, siteOrigin, recipient.getByRole('button', { name: 'Submit for review' }), replyId)
    assert.equal(child.articleId, articleId)
    await approve(childBody, child.commentId)
    const first = (await readContext(replyId)).view.target
    const firstChild = (await readContext(child.commentId)).view.target
    assert.equal(first.content, body)
    assert.equal(first.edited, false)
    assert.equal(first.parentId, String(parentId))
    assert.equal(firstChild.content, childBody)
    assert.equal(firstChild.parentId, first.id)
    const originalNotice = await readNotice()
    assert.equal(originalNotice.messages.length, 1)
    assert(originalNotice.messages[0].body.includes(body.slice(0, 40)))

    await author.bringToFront()
    await author.goto(siteOrigin + permalink)
    assert.equal((await author.reload()).status(), 200)
    const publicationResponse = await author.request.get(siteOrigin + WireRoutes.PublicArticle.replace('{id}', String(articleId)))
    assert.equal(publicationResponse.status(), 200)
    const publication = decodeArticle(decodeFrame(await publicationResponse.body(), FrameType.ArticleDetail).payload).publication
    const action = author.locator(selector(replyId)).getByRole('button', menu)
    const dialog = author.getByRole('dialog', { name: 'Edit your comment', exact: true })
    const input = dialog.getByLabel('Edited comment', { exact: true })
    const save = dialog.getByRole('button', { name: 'Save for review', exact: true })
    async function openEditor() {
      const [loaded] = await Promise.all([
        author.waitForResponse(response => response.url() === detailUrl && response.request().method() === 'GET'),
        action.click(),
      ])
      assert.equal(loaded.status(), 200)
      assert.match((await loaded.headerValue('Cache-Control')) ?? '', /no-store/)
      const decoded = decodeCommentAuthorEditDetail(decodeFrame(await loaded.body(), FrameType.CommentAuthorEditDetail).payload)
      assert.equal(decoded.articleId, articleId)
      assert.equal(decoded.publication, publication)
      assert.equal(decoded.body, body)
      await dialog.waitFor()
      assert.equal(await input.inputValue(), body)
      return decoded
    }
    const writes = []
    author.on('request', request => {
      if (request.method() === 'POST' && [challengeUrl, editUrl].includes(request.url())) writes.push(request.url())
    })
    const detail = await openEditor()
    assert(detail.currentVersion > 0n)
    assert.equal(await save.isDisabled(), true)
    await input.fill('This cancelled edit must never be submitted.')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(writes, [])
    assert.equal((await readContext(replyId)).view.target.content, body)

    const next = await openEditor()
    assert.deepEqual(next, detail)
    await input.fill(newBody)
    assert.equal(await author.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await author.screenshot({ path: join(evidence, 'comment-edit-before-save-mobile.png'), animations: 'disabled' })
    const [grant, applied] = await Promise.all([
      author.waitForResponse(response => response.url() === challengeUrl && response.request().method() === 'POST'),
      author.waitForResponse(response => response.url() === editUrl && response.request().method() === 'POST'),
      save.click(),
    ])
    assert.equal(grant.status(), 200)
    assert.equal(applied.status(), 200)
    assert.deepEqual(writes, [challengeUrl, editUrl])
    const { purpose } = readJson(grant.request().postDataBuffer(), FrameType.CommentManagementChallengeRequest)
    assert.equal(purpose, 'edit')
    const proof = readJson(await grant.body(), FrameType.CommentManagementChallengeResponse)
    const command = readJson(applied.request().postDataBuffer(), FrameType.CommentAuthorEditRequest)
    assert.deepEqual(Object.keys(command).sort(), ['challenge', 'content', 'expectedVersion'])
    assert(command.challenge === proof.challenge, 'The edit must use the proof just issued for it.')
    assert.equal(command.content, newBody)
    assert.equal(command.expectedVersion, Number(detail.currentVersion))
    assert.equal(proof.currentVersion, command.expectedVersion)
    const result = readJson(await applied.body(), FrameType.CommentAuthorMutationResult)
    assert.equal(result.success, true)
    assert.equal(result.moderationStatus, 0)
    assert.equal(result.currentVersion, command.expectedVersion + 1)
    await dialog.waitFor({ state: 'hidden' })
    await author.getByText('Comment edit submitted for review.', { exact: true }).waitFor()
    await author.getByText('This comment is unavailable.', { exact: true }).waitFor()
    assert.equal(await author.getByText(body, { exact: true }).count(), 0)
    assert.equal(await author.getByText(newBody, { exact: true }).count(), 0)
    const pending = await readContext(replyId)
    assert.equal(pending.view, null)
    assertNoCommentText(pending.payload)
    const childWhilePending = await readContext(child.commentId)
    assertNoCommentText(childWhilePending.payload)
    assert.equal(childWhilePending.view.target.content, childBody)
    assert.equal(childWhilePending.view.target.parentId, first.id)
    const hiddenParent = childWhilePending.view.ancestors.find(node => node.id === first.id)
    assert(hiddenParent?.deleted && !hiddenParent.edited)
    assert.notEqual(hiddenParent.author.displayName, first.author.displayName)
    await author.screenshot({ path: join(evidence, 'comment-edit-pending-mobile.png'), animations: 'disabled' })

    await approve(newBody, replyId)
    assert.equal((await guest.reload()).status(), 200)
    const publicNode = guest.locator(selector(replyId))
    await publicNode.getByText(newBody, { exact: true }).waitFor()
    await publicNode.getByText('Edited', { exact: true }).waitFor()
    assert.equal(await publicNode.getByText(body, { exact: true }).count(), 0)
    assert.equal(await publicNode.getByRole('button', menu).count(), 0)
    const final = (await readContext(replyId)).view.target
    const finalChild = (await readContext(child.commentId)).view.target
    const coordinates = node => [node.id, node.parentId, node.rootId, node.replyToId, node.depth, node.createdAt]
    assert.deepEqual(coordinates(final), coordinates(first))
    assert.deepEqual(coordinates(finalChild), coordinates(firstChild))
    assert.equal(final.content, newBody)
    assert.equal(final.edited, true)
    const finalNotice = await readNotice()
    assert.deepEqual(finalNotice.messages.map(message => [message.id, message.body]),
      originalNotice.messages.map(message => [message.id, message.body]))
    assert.equal((await recipient.goto(siteOrigin + '/user/messagebox')).status(), 200)
    const noticeButton = recipient.getByRole('button', { name: /收到新的评论回复/ })
    await noticeButton.waitFor()
    assert.equal(await noticeButton.count(), 1)
    await writeFile(join(evidence, 'comment-edit-result.json'), JSON.stringify({ articleId, replyId: String(replyId), childId: String(child.commentId),
      previousVersion: command.expectedVersion, pendingVersion: result.currentVersion, preservedPublicDescendant: true,
      reapprovedSameCoordinates: true, originalNoticeCount: originalNotice.messages.length, finalNoticeCount: finalNotice.messages.length }, null, 2) + '\n')
  } finally { await anon.close() }

  async function readContext(id) {
    const url = siteOrigin + WireRoutes.CommentContext.replace('{articleId:int}', String(articleId)).replace('{commentId:long}', String(id))
    const response = await anon.request.get(url)
    assert.equal(response.status(), 200)
    const payload = Buffer.from(decodeFrame(await response.body(), FrameType.CommentPermalinkContext).payload)
    return { payload, view: decodeCommentContext(payload) }
  }

  async function readNotice() {
    const response = await recipient.request.get(inboxUrl)
    assert.equal(response.status(), 200)
    return decodeInboxThread(decodeFrame(await response.body(), FrameType.ConversationDetailV3).payload)
  }

  function assertNoCommentText(bytes) {
    assert(!bytes.includes(Buffer.from(body)) && !bytes.includes(Buffer.from(newBody)))
  }
}

function readJson(frame, type) {
  return JSON.parse(Buffer.from(decodeFrame(frame, type).payload).toString('utf8'))
}
