import { assertStatus } from './response-status-fixture.mjs'
import assert from 'node:assert/strict'
import { signInFreshSite } from './webauthn-fixture.mjs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCommentContext } from '../../src/Contracts/comment-read.ts'
import { decodeInboxThread } from '../../src/Contracts/inbox.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeCommentAuthorEditDetail, decodePublicCommentReply, decodePublicCommentSubmissionResult, decodeSession,
  FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import { exactButton, roleWithExactName, exactLabel, exactText } from './role-locators.mjs'

export async function verifyApprovedReply({ recipient, browser, siteOrigin, evidence, articleId, parentId, approve }) {
  const authorTicket = process.env.FSUSBLOG_TEST_REPLY_AUTHOR_TICKET
  assert.match(authorTicket, /^[a-f0-9]{64}$/)
  const authorContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const body = 'Reply fixture validates independent moderation and private delivery.'
  const subject = '收到新的评论回复'
  try {
    const author = await authorContext.newPage()
    await signInFreshSite(author, siteOrigin, authorTicket)
    await recipient.context().addCookies([{ name: 'fsus_locale', value: 'zh-CN', url: siteOrigin }])
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
    assertStatus(await author.goto(articleUrl), 200)
    await roleWithExactName(author, 'heading', 'Moderation fixture article').waitFor()
    assert.match(await author.title(), /Moderation fixture article/)
    const parent = author.locator(`[id="comment-${parentId}"]`)
    const reply = exactButton(parent, 'Reply')
    await reply.click()
    const composer = roleWithExactName(author, 'heading', 'Reply to Moderation fixture writer')
    await composer.waitFor()
    assert.equal(await composer.evaluate(heading => heading.closest('[tabindex="-1"]') === document.activeElement), true)
    const input = exactLabel(author, 'Reply')
    const confirm = author.getByRole('checkbox', { name: 'Publish as Reply fixture writer after review' })
    const confirmLabel = exactText(author, 'Publish as Reply fixture writer after review')
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
    if (process.env.FSUSBLOG_TEST_COMMENT_EDIT === '1') {
      const pendingBody = 'This independent owner reply remains under review after its correction.'
      await reply.click()
      await input.fill(pendingBody)
      await confirmLabel.click()
      const pending = await submitReply(author, siteOrigin, send, parentId)
      assert.equal(pending.articleId, articleId)
      assert.notEqual(pending.commentId, receipt.commentId)
      await authorContext.addCookies([{ name: 'fsus_locale', value: 'zh-CN', url: siteOrigin }])
      try {
        await verifyPendingEdit({ browser, author, recipient, siteOrigin, evidence, articleId, id: pending.commentId, body: pendingBody })
      } finally {
        await authorContext.addCookies([{ name: 'fsus_locale', value: 'en', url: siteOrigin }])
      }
    }

    await recipient.bringToFront()
    const before = waitForPathResponse(recipient, () => WireRoutes.InboxList)
    assertStatus(await recipient.goto(siteOrigin + '/user/messagebox'), 200)
    await recipient.getByRole('heading', { name: '我的站内信' }).waitFor()
    assertStatus(await before, 200)
    assert.match(await recipient.title(), /^站内信 · /)
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
    assertStatus(inboxThread, 200)
    const permalink = `/article/${articleId}#comment-${receipt.commentId}`
    await recipient.getByRole('heading', { name: subject }).waitFor()
    await exactText(recipient, `Reply fixture writer 回复了您的评论：${body.slice(0, 40)}。定位：${permalink}`).last().waitFor()
    assertStatus(await authorContext.request.get(inboxThread.url()), 404)
    await recipient.screenshot({ path: join(evidence, 'comment-reply-private-inbox.png'), animations: 'disabled' })
    assertStatus(await recipient.goto(siteOrigin + permalink), 200)
    const target = recipient.locator(`[id="comment-${receipt.commentId}"]`)
    await exactText(target, body).waitFor()
    assert.equal(await target.evaluate(element => element === document.activeElement), true)
    assert.equal(await recipient.locator('vite-error-overlay').count(), 0)
    let edit
    if (process.env.FSUSBLOG_TEST_COMMENT_EDIT === '1') {
      await recipient.context().addCookies([{ name: 'fsus_locale', value: 'en', url: siteOrigin }])
      assertStatus(await recipient.reload(), 200)
      edit = await verifyCommentEdit({ browser, author, recipient, siteOrigin, evidence, articleId, parentId,
        replyId: receipt.commentId, body, permalink, inboxUrl: inboxThread.url(), approve })
    }
    if (process.env.FSUSBLOG_TEST_COMMENT_REPORT === '1') {
      const { verifySignedInCommentReport } = await import('./comment-report-flow.mjs')
      await verifySignedInCommentReport({ browser, author, siteOrigin, articleId, parentId, evidence })
    }
    assert.deepEqual(errors, [])
    return { commentId: receipt.commentId, originalBody: body, editedBody: edit }
  } finally {
    await authorContext.close()
  }

}

async function submitReply(page, origin, send, parentId) {
  const [challenge, submitted] = await Promise.all([
    waitForUrlResponse(page, () => origin + WireRoutes.PublicCommentReplyPow),
    waitForUrlResponse(page, () => origin + WireRoutes.SubmitPublicCommentReply),
    send.click(),
  ])
  assertStatus(challenge, 200)
  assertStatus(submitted, 200)
  assert(challenge.request().postDataBuffer().equals(submitted.request().postDataBuffer()))
  assert.equal(decodePublicCommentReply(decodeFrame(submitted.request().postDataBuffer(), FrameType.PublicCommentReply).payload).parentId, parentId)
  const receipt = decodePublicCommentSubmissionResult(decodeFrame(await submitted.body(), FrameType.PublicCommentSubmissionResult).payload)
  assert.equal(receipt.moderationStatus, 0)
  await exactText(page, 'Reply submitted for review.').waitFor()
  return receipt
}

async function verifyPendingEdit({ browser, author, recipient, siteOrigin, evidence, articleId, id, body }) {
  const newBody = 'Only the private pending reply now contains this corrected text.'
  const comments = siteOrigin + '/user/comments'
  const ownList = siteOrigin + WireRoutes.CommentAuthorAppeals
  const route = path => siteOrigin + path.replace('{id:long}', String(id))
  const detailUrl = route(WireRoutes.CommentAuthorEditDetail) + '?state=pending'
  const challengeUrl = route(WireRoutes.CommentAuthorChallenge)
  const editUrl = route(WireRoutes.CommentAuthorEdit)
  const nonceHeader = WireHeaders.CurrentSession.toLowerCase()
  const publicUrl = siteOrigin + WireRoutes.CommentContext.replace('{articleId:int}', String(articleId))
    .replace('{commentId:long}', String(id))
  const admin = new URL(process.env.FSUSBLOG_TEST_ADMIN_URL).origin
  const moderator = browser.contexts().find(context => context.pages().some(page => new URL(page.url()).origin === admin))
  assert(moderator, 'The dual-HTTPS fixture must have an authenticated moderator context')
  const anonymous = await browser.newContext()

  function readDetail(response) {
    return response.body().then(bytes => decodeCommentAuthorEditDetail(decodeFrame(bytes, FrameType.CommentAuthorEditDetail).payload))
  }
  function noPrivateText(bytes) {
    assert(!bytes.includes(Buffer.from(body)) && !bytes.includes(Buffer.from(newBody)))
  }
  async function invisibleInPublic() {
    const response = await anonymous.request.get(publicUrl)
    assertStatus(response, 200)
    const payload = Buffer.from(decodeFrame(await response.body(), FrameType.CommentPermalinkContext).payload)
    noPrivateText(payload)
    assert.equal(decodeCommentContext(payload), null)
  }

  try {
    await invisibleInPublic()
    const publicationReply = await anonymous.request.get(siteOrigin + WireRoutes.PublicArticle.replace('{id}', String(articleId)))
    assertStatus(publicationReply, 200)
    const publication = decodeArticle(decodeFrame(await publicationReply.body(), FrameType.ArticleDetail).payload).publication

    const peerSession = await recipient.request.get(siteOrigin + WireRoutes.Session)
    assertStatus(peerSession, 200)
    const peerHeaders = { [WireHeaders.CurrentSession]: peerSession.headers()[nonceHeader] }
    assert.match(peerHeaders[WireHeaders.CurrentSession], /^[a-f0-9]{64}$/)
    const deniedDetail = await recipient.request.get(detailUrl, { headers: peerHeaders })
    assertStatus(deniedDetail, 404)
    noPrivateText(await deniedDetail.body())
    const otherList = waitForUrlResponse(recipient, () => ownList, 'GET')
    assertStatus(await recipient.goto(comments), 200)
    const otherRows = await otherList
    assertStatus(otherRows, 200)
    noPrivateText(await otherRows.body())
    await roleWithExactName(recipient, 'heading', '我的评论').waitFor()

    await author.bringToFront()
    const own = waitForUrlResponse(author, () => ownList, 'GET')
    assertStatus(await author.goto(comments), 200)
    const listed = await own
    assertStatus(listed, 200)
    assert.equal(await listed.headerValue(WireHeaders.CommentAuthorEditEnabled), '1')
    const handle = listed.request().headers()[nonceHeader]
    assert.match(handle, /^[a-f0-9]{64}$/)
    const row = text => author.getByRole('listitem').filter({ has: exactText(author, text) })
    await exactText(row(body), '待审核').waitFor()
    const detail = waitForUrlResponse(author, () => detailUrl, 'GET')
    await exactButton(row(body), '编辑评论').click()
    const loaded = await detail
    assertStatus(loaded, 200)
    assert.match((await loaded.headerValue('Cache-Control')) ?? '', /no-store/)
    const previous = await readDetail(loaded)
    assert.deepEqual(previous, { articleId, publication, currentVersion: 1n, body })
    const form = roleWithExactName(author, 'form', '编辑待审核评论')
    const input = exactLabel(form, '评论内容')
    await input.waitFor()
    assert.equal(await input.inputValue(), body)
    await input.fill(newBody)

    const paused = Promise.withResolvers()
    const resume = Promise.withResolvers()
    await author.route(editUrl, async intercepted => {
      paused.resolve(intercepted.request())
      await resume.promise
      await intercepted.continue()
    }, { times: 1 })
    let applied
    try {
      const [issued] = await Promise.all([
        waitForUrlResponse(author, () => challengeUrl, 'POST'),
        author.waitForRequest(request => request.url() === editUrl && request.method() === 'POST'),
        exactButton(form, '保存修改').click(),
      ])
      assertStatus(issued, 200)
      assert.equal(readJson(issued.request().postDataBuffer(), FrameType.CommentManagementChallengeRequest).purpose, 'edit')
      const proof = readJson(await issued.body(), FrameType.CommentManagementChallengeResponse)
      const command = (await paused.promise).postDataBuffer()
      assert(command)
      const edit = readJson(command, FrameType.CommentAuthorEditRequest)
      assert(edit.challenge === proof.challenge)
      assert.equal(edit.expectedVersion, 1)
      assert.equal(edit.content, newBody)
      const deniedEdit = await recipient.request.post(editUrl, { data: command,
        headers: { ...peerHeaders, 'Content-Type': 'application/octet-stream', Origin: siteOrigin } })
      assertStatus(deniedEdit, 404)
      noPrivateText(await deniedEdit.body())
      const commit = waitForUrlResponse(author, () => editUrl, 'POST')
      resume.resolve()
      applied = await commit
    } finally {
      resume.resolve()
    }
    assertStatus(applied, 200)
    const result = readJson(await applied.body(), FrameType.CommentAuthorMutationResult)
    assert.deepEqual([result.success, result.code, result.currentVersion, result.moderationStatus], [true, 'ok', 2, 0])
    await form.waitFor({ state: 'hidden' })
    await exactText(author, '评论已修改，仍待审核。').waitFor()
    await exactText(row(newBody), '待审核').waitFor()
    assert.equal(await row(body).count(), 0)
    const reread = await author.request.get(detailUrl, { headers: { [WireHeaders.CurrentSession]: handle } })
    assertStatus(reread, 200)
    assert.deepEqual(await readDetail(reread), { ...previous, currentVersion: 2n, body: newBody })
    await invisibleInPublic()

    const timeline = await moderator.request.get(admin + WireRoutes.AdminCommentTimeline.replace('{id:long}', String(id)) + `?articleId=${articleId}`)
    assertStatus(timeline, 200)
    const bytes = await timeline.body()
    noPrivateText(bytes)
    const history = readJson(bytes, FrameType.CommentModerationTimeline)
    assert.equal(String(history.commentId), String(id))
    assert.deepEqual([history.articleId, history.consistent, history.deleted, history.projectedStatus, history.currentStatus],
      [articleId, true, false, 0, 0])
    assert.deepEqual(history.events.map(event => [event.eventType, event.previousStatus, event.nextStatus, event.commentVersion]),
      [['create', null, 0, 1], ['edit', 0, 0, 2]])
    await author.screenshot({ path: join(evidence, 'comment-pending-edit-mobile.png'), animations: 'disabled' })
    await writeFile(join(evidence, 'comment-pending-edit-result.json'), JSON.stringify({ articleId, commentId: String(id),
      previousVersion: 1, currentVersion: 2, moderationStatus: 0, foreignRead: 404, foreignEdit: 404,
      noPublicContent: true, consistentTimeline: ['create', 'edit'] }, null, 2) + '\n')
  } finally {
    await anonymous.close()
  }
}

async function verifyCommentEdit({ browser, author, recipient, siteOrigin, evidence, articleId, parentId, replyId, body, permalink, inboxUrl, approve }) {
  const anon = await browser.newContext()
  await anon.addCookies([{ name: 'fsus_locale', value: 'en', url: siteOrigin }])
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
    assertStatus(ownerSession, 200)
    assert.equal(decodeSession(decodeFrame(await ownerSession.body(), FrameType.OperatorSession).payload).canAuthor, false)
    const otherSession = await recipient.request.get(siteOrigin + WireRoutes.Session)
    assertStatus(otherSession, 200)
    const otherHandle = otherSession.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(/^[a-f0-9]{64}$/.test(otherHandle ?? ''))
    assertStatus(await anon.request.get(detailUrl), 401)
    const denied = await recipient.request.get(detailUrl, { headers: { [WireHeaders.CurrentSession]: otherHandle } })
    assertStatus(denied, 404)
    assertNoCommentText(await denied.body())
    await recipient.locator(selector(parentId)).getByRole('button', menu).waitFor()
    assert.equal(await recipient.locator(selector(replyId)).getByRole('button', menu).count(), 0)

    const guest = await anon.newPage()
    assertStatus(await guest.goto(siteOrigin + permalink), 200)
    await exactText(guest.locator(selector(replyId)), body).waitFor()
    assert.equal(await guest.locator(selector(replyId)).getByRole('button', menu).count(), 0)

    await recipient.bringToFront()
    await exactButton(recipient.locator(selector(replyId)), 'Reply').click()
    await exactLabel(recipient, 'Reply').fill(childBody)
    await exactText(recipient, 'Publish as Moderation fixture writer after review').click()
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
    assertStatus(await author.reload(), 200)
    const publicationResponse = await author.request.get(siteOrigin + WireRoutes.PublicArticle.replace('{id}', String(articleId)))
    assertStatus(publicationResponse, 200)
    const publication = decodeArticle(decodeFrame(await publicationResponse.body(), FrameType.ArticleDetail).payload).publication
    const action = author.locator(selector(replyId)).getByRole('button', menu)
    const dialog = roleWithExactName(author, 'dialog', 'Edit your comment')
    const input = exactLabel(dialog, 'Edited comment')
    const save = exactButton(dialog, 'Save for review')
    async function openEditor() {
      const [loaded] = await Promise.all([
        waitForUrlResponse(author, () => detailUrl, 'GET'),
        action.click(),
      ])
      assertStatus(loaded, 200)
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
    await exactButton(dialog, 'Cancel').click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(writes, [])
    assert.equal((await readContext(replyId)).view.target.content, body)

    const next = await openEditor()
    assert.deepEqual(next, detail)
    await input.fill(newBody)
    assert.equal(await author.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await author.screenshot({ path: join(evidence, 'comment-edit-before-save-mobile.png'), animations: 'disabled' })
    const [grant, applied] = await Promise.all([
      waitForUrlResponse(author, () => challengeUrl, 'POST'),
      waitForUrlResponse(author, () => editUrl, 'POST'),
      save.click(),
    ])
    assertStatus(grant, 200)
    assertStatus(applied, 200)
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
    await exactText(author, 'Comment edit submitted for review.').waitFor()
    await exactText(author, 'This comment is unavailable.').waitFor()
    assert.equal(await exactText(author, body).count(), 0)
    assert.equal(await exactText(author, newBody).count(), 0)
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
    assertStatus(await guest.reload(), 200)
    const publicNode = guest.locator(selector(replyId))
    await exactText(publicNode, newBody).waitFor()
    await exactText(publicNode, 'Edited').waitFor()
    assert.equal(await exactText(publicNode, body).count(), 0)
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
    assertStatus(await recipient.goto(siteOrigin + '/user/messagebox'), 200)
    const noticeButton = recipient.getByRole('button', { name: /收到新的评论回复/ })
    await noticeButton.waitFor()
    assert.equal(await noticeButton.count(), 1)
    await writeFile(join(evidence, 'comment-edit-result.json'), JSON.stringify({ articleId, replyId: String(replyId), childId: String(child.commentId),
      previousVersion: command.expectedVersion, pendingVersion: result.currentVersion, preservedPublicDescendant: true,
      reapprovedSameCoordinates: true, originalNoticeCount: originalNotice.messages.length, finalNoticeCount: finalNotice.messages.length }, null, 2) + '\n')
    return newBody
  } finally { await anon.close() }

  async function readContext(id) {
    const url = siteOrigin + WireRoutes.CommentContext.replace('{articleId:int}', String(articleId)).replace('{commentId:long}', String(id))
    const response = await anon.request.get(url)
    assertStatus(response, 200)
    const payload = Buffer.from(decodeFrame(await response.body(), FrameType.CommentPermalinkContext).payload)
    return { payload, view: decodeCommentContext(payload) }
  }

  async function readNotice() {
    const response = await recipient.request.get(inboxUrl)
    assertStatus(response, 200)
    return decodeInboxThread(decodeFrame(await response.body(), FrameType.ConversationDetailV3).payload)
  }

  function assertNoCommentText(bytes) {
    assert(!bytes.includes(Buffer.from(body)) && !bytes.includes(Buffer.from(newBody)))
  }
}

function readJson(frame, type) {
  return JSON.parse(Buffer.from(decodeFrame(frame, type).payload).toString('utf8'))
}
