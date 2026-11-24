import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCommentContext } from '../../src/Contracts/comment-read.ts'
import { decodeInboxThread } from '../../src/Contracts/inbox.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { assertFocused, clickForResponse, postBinary } from './admin-workspace-fixture.mjs'
import { readReaderSession } from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import * as status from './response-status-fixture.mjs'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'
import { readSessionHandle } from './site-authentication-fixture.mjs'
import { signInFreshSite } from './webauthn-fixture.mjs'

const { FrameType, WireHeaders, WireRoutes } = wire
const commentRoute = (origin, route, id) => origin + route.replace('{id:long}', String(id))
const editRoutes = (origin, id) => ({
  detail: commentRoute(origin, WireRoutes.CommentAuthorEditDetail, id),
  challenge: commentRoute(origin, WireRoutes.CommentAuthorChallenge, id),
  edit: commentRoute(origin, WireRoutes.CommentAuthorEdit, id),
})
const contextRoute = (origin, articleId, id) =>
  origin + WireRoutes.CommentContext.replace('{articleId:int}', String(articleId)).replace('{commentId:long}', String(id))

async function readContext(request, origin, articleId, id) {
  const payload = Buffer.from(await status.readFrame(await request.get(contextRoute(origin, articleId, id)), FrameType.CommentPermalinkContext))
  return { payload, view: decodeCommentContext(payload) }
}

const readEditDetail = response => status.readFrame(response, FrameType.CommentAuthorEditDetail, wire.decodeCommentAuthorEditDetail)

async function verifyEditChallenge(issued, commandBytes, expectedVersion, content) {
  status.assertStatus(issued, 200)
  assert.equal(status.decodeJsonFrame(issued.request().postDataBuffer(), FrameType.CommentManagementChallengeRequest).purpose, 'edit')
  const proof = await status.readJsonFrame(issued, FrameType.CommentManagementChallengeResponse)
  const command = status.decodeJsonFrame(commandBytes, FrameType.CommentAuthorEditRequest)
  assert(command.challenge === proof.challenge, 'The edit must use the proof just issued for it.')
  status.assertFields(command, { expectedVersion, content })
  return { proof, command }
}

export async function verifyApprovedReply({ recipient, browser, siteOrigin, evidence, articleId, parentId, approve }) {
  const authorTicket = process.env.FSUSBLOG_TEST_REPLY_AUTHOR_TICKET
  assert.match(authorTicket, /^[a-f0-9]{64}$/)
  const body = 'Reply fixture validates independent moderation and private delivery.'
  const subject = '收到新的评论回复'
  return isolated.withTempContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true }, async authorContext => {
    const author = await authorContext.newPage()
    await signInFreshSite(author, siteOrigin, authorTicket)
    await recipient.context().addCookies([{ name: 'fsus_locale', value: 'zh-CN', url: siteOrigin }])
    const errors = []
    for (const page of [author, recipient]) {
      page.on('pageerror', error => errors.push(error.message))
      page.on('response', response => {
        const path = new URL(response.url()).pathname
        if (response.status() >= 500 || (response.status() >= 400 && path.startsWith('/assets/'))) errors.push(`${response.status()} ${path}`)
      })
    }
    await author.bringToFront()
    status.assertStatus(await author.goto(`${siteOrigin}/article/${articleId}`), 200)
    await loc.exactHeading(author, 'Moderation fixture article').waitFor()
    assert.match(await author.title(), /Moderation fixture article/)
    const parent = author.locator(`[id="comment-${parentId}"]`)
    const reply = loc.exactButton(parent, 'Reply')
    await reply.click()
    const composer = loc.exactHeading(author, 'Reply to Moderation fixture writer')
    await composer.waitFor()
    assert.equal(await composer.evaluate(heading => heading.closest('[tabindex="-1"]') === document.activeElement), true)
    const input = loc.exactLabel(author, 'Reply')
    const confirm = author.getByRole('checkbox', { name: 'Publish as Reply fixture writer after review' })
    const confirmLabel = loc.exactText(author, 'Publish as Reply fixture writer after review')
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
    await isolated.assertNoOverflow(author)
    await isolated.saveShot(author, evidence, 'comment-reply-compose-mobile.png')
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
    status.assertStatus(await recipient.goto(siteOrigin + '/user/messagebox'), 200)
    await recipient.getByRole('heading', { name: '我的站内信' }).waitFor()
    status.assertStatus(await before, 200)
    assert.match(await recipient.title(), /^站内信 · /)
    const notice = recipient.getByRole('button', { name: new RegExp(subject) })
    assert.equal(await notice.count(), 0)
    assert(!(await (await authorContext.request.get(contextRoute(siteOrigin, articleId, receipt.commentId))).body()).includes(Buffer.from(body)))
    await approve(body, receipt.commentId)
    await recipient.bringToFront()
    await notice.waitFor({ timeout: 20_000 })
    const [inboxThread] = await Promise.all([
      recipient.waitForResponse(response => /^\/api\/binary\/messages\/conversations\/\d+$/.test(new URL(response.url()).pathname)),
      notice.click(),
    ])
    status.assertStatus(inboxThread, 200)
    const permalink = `/article/${articleId}#comment-${receipt.commentId}`
    await recipient.getByRole('heading', { name: subject }).waitFor()
    await loc.exactText(recipient, `Reply fixture writer 回复了您的评论：${body.slice(0, 40)}。定位：${permalink}`).last().waitFor()
    status.assertStatus(await authorContext.request.get(inboxThread.url()), 404)
    await isolated.saveShot(recipient, evidence, 'comment-reply-private-inbox.png')
    status.assertStatus(await recipient.goto(siteOrigin + permalink), 200)
    const target = recipient.locator(`[id="comment-${receipt.commentId}"]`)
    await loc.exactText(target, body).waitFor()
    await assertFocused(target)
    assert.equal(await recipient.locator('vite-error-overlay').count(), 0)
    let edit
    if (process.env.FSUSBLOG_TEST_COMMENT_EDIT === '1') {
      await recipient.context().addCookies([{ name: 'fsus_locale', value: 'en', url: siteOrigin }])
      status.assertStatus(await recipient.reload(), 200)
      edit = await verifyCommentEdit({ browser, author, recipient, siteOrigin, evidence, articleId, parentId,
        replyId: receipt.commentId, body, permalink, inboxUrl: inboxThread.url(), approve })
    }
    if (process.env.FSUSBLOG_TEST_COMMENT_REPORT === '1') {
      const { verifySignedInCommentReport } = await import('./comment-report-flow.mjs')
      await verifySignedInCommentReport({ browser, author, siteOrigin, articleId, parentId, evidence })
    }
    assert.deepEqual(errors, [])
    return { commentId: receipt.commentId, originalBody: body, editedBody: edit }
  })
}

async function submitReply(page, origin, send, parentId) {
  const [challenge, submitted] = await Promise.all([
    waitForUrlResponse(page, () => origin + WireRoutes.PublicCommentReplyPow),
    waitForUrlResponse(page, () => origin + WireRoutes.SubmitPublicCommentReply),
    send.click(),
  ])
  status.assertStatus(challenge, 200)
  status.assertStatus(submitted, 200)
  assert(challenge.request().postDataBuffer().equals(submitted.request().postDataBuffer()))
  assert.equal(wire.decodePublicCommentReply(decodeFrame(submitted.request().postDataBuffer(), FrameType.PublicCommentReply).payload).parentId, parentId)
  const receipt = await status.readFrame(submitted, FrameType.PublicCommentSubmissionResult, wire.decodePublicCommentSubmissionResult)
  assert.equal(receipt.moderationStatus, 0)
  await loc.exactText(page, 'Reply submitted for review.').waitFor()
  return receipt
}

async function verifyPendingEdit({ browser, author, recipient, siteOrigin, evidence, articleId, id, body }) {
  const newBody = 'Only the private pending reply now contains this corrected text.'
  const comments = siteOrigin + '/user/comments'
  const ownList = siteOrigin + WireRoutes.CommentAuthorAppeals
  const routes = editRoutes(siteOrigin, id)
  const detailUrl = routes.detail + '?state=pending'
  const nonceHeader = WireHeaders.CurrentSession.toLowerCase()
  const admin = new URL(process.env.FSUSBLOG_TEST_ADMIN_URL).origin
  const moderator = browser.contexts().find(context => context.pages().some(page => new URL(page.url()).origin === admin))
  assert(moderator, 'The dual-HTTPS fixture must have an authenticated moderator context')
  const noPrivateText = bytes => status.assertNoneIn(bytes, body, newBody)

  await isolated.withTempContext(browser, async anonymous => {
    const invisibleInPublic = async () => {
      const { payload, view } = await readContext(anonymous.request, siteOrigin, articleId, id)
      noPrivateText(payload)
      assert.equal(view, null)
    }
    const openCommentsList = async target => {
      const list = waitForUrlResponse(target, () => ownList, 'GET')
      status.assertStatus(await target.goto(comments), 200)
      const listed = await list
      status.assertStatus(listed, 200)
      return listed
    }
    await invisibleInPublic()
    const { publication } = await status.fetchPublicArticle(anonymous.request, siteOrigin, articleId)
    const peerHeaders = { [WireHeaders.CurrentSession]: await readSessionHandle(recipient, siteOrigin) }
    const deniedDetail = await recipient.request.get(detailUrl, { headers: peerHeaders })
    status.assertStatus(deniedDetail, 404)
    noPrivateText(await deniedDetail.body())
    noPrivateText(await (await openCommentsList(recipient)).body())
    await loc.exactHeading(recipient, '我的评论').waitFor()

    await author.bringToFront()
    const listed = await openCommentsList(author)
    assert.equal(await listed.headerValue(WireHeaders.CommentAuthorEditEnabled), '1')
    const handle = listed.request().headers()[nonceHeader]
    assert.match(handle, /^[a-f0-9]{64}$/)
    const row = text => author.getByRole('listitem').filter({ has: loc.exactText(author, text) })
    await loc.exactText(row(body), '待审核').waitFor()
    const loaded = await clickForResponse(author, detailUrl, loc.exactButton(row(body), '编辑评论'))
    await status.assertNoStore(loaded)
    const previous = await readEditDetail(loaded)
    assert.deepEqual(previous, { articleId, publication, currentVersion: 1n, body })
    const form = loc.roleWithExactName(author, 'form', '编辑待审核评论')
    const input = loc.exactLabel(form, '评论内容')
    await input.waitFor()
    assert.equal(await input.inputValue(), body)
    await input.fill(newBody)

    const paused = Promise.withResolvers()
    const resume = Promise.withResolvers()
    await author.route(routes.edit, async intercepted => {
      paused.resolve(intercepted.request())
      await resume.promise
      await intercepted.continue()
    }, { times: 1 })
    let applied
    try {
      const [issued] = await Promise.all([
        waitForUrlResponse(author, () => routes.challenge, 'POST'),
        author.waitForRequest(request => request.url() === routes.edit && request.method() === 'POST'),
        loc.exactButton(form, '保存修改').click(),
      ])
      const command = (await paused.promise).postDataBuffer()
      assert(command)
      await verifyEditChallenge(issued, command, 1, newBody)
      const deniedEdit = await postBinary(recipient.request, routes.edit, siteOrigin, command, peerHeaders)
      status.assertStatus(deniedEdit, 404)
      noPrivateText(await deniedEdit.body())
      const commit = waitForUrlResponse(author, () => routes.edit, 'POST')
      resume.resolve()
      applied = await commit
    } finally {
      resume.resolve()
    }
    const result = await status.readJsonFrame(applied, FrameType.CommentAuthorMutationResult)
    status.assertFields(result, { success: true, code: 'ok', currentVersion: 2, moderationStatus: 0 })
    await form.waitFor({ state: 'hidden' })
    await loc.exactText(author, '评论已修改，仍待审核。').waitFor()
    await loc.exactText(row(newBody), '待审核').waitFor()
    assert.equal(await row(body).count(), 0)
    const reread = await author.request.get(detailUrl, { headers: { [WireHeaders.CurrentSession]: handle } })
    assert.deepEqual(await readEditDetail(reread), { ...previous, currentVersion: 2n, body: newBody })
    await invisibleInPublic()

    const timeline = await moderator.request.get(commentRoute(admin, WireRoutes.AdminCommentTimeline, id) + `?articleId=${articleId}`)
    status.assertStatus(timeline, 200)
    const bytes = await timeline.body()
    noPrivateText(bytes)
    const history = status.decodeJsonFrame(bytes, FrameType.CommentModerationTimeline)
    assert.equal(String(history.commentId), String(id))
    status.assertFields(history, { articleId, consistent: true, deleted: false, projectedStatus: 0, currentStatus: 0 })
    assert.deepEqual(history.events.map(event => [event.eventType, event.previousStatus, event.nextStatus, event.commentVersion]),
      [['create', null, 0, 1], ['edit', 0, 0, 2]])
    await isolated.saveShot(author, evidence, 'comment-pending-edit-mobile.png')
    await isolated.writeEvidenceJson(evidence, 'comment-pending-edit-result.json', { articleId, commentId: String(id),
      previousVersion: 1, currentVersion: 2, moderationStatus: 0, foreignRead: 404, foreignEdit: 404,
      noPublicContent: true, consistentTimeline: ['create', 'edit'] })
  })
}

async function verifyCommentEdit({ browser, author, recipient, siteOrigin, evidence, articleId, parentId, replyId, body, permalink, inboxUrl, approve }) {
  const menu = { name: 'Edit my comment', exact: true }
  const routes = editRoutes(siteOrigin, replyId)
  const newBody = 'Owner correction to the same reply, approved only after a new review.'
  const childBody = 'Public child remains attached to the reply while the edit is pending.'
  const selector = id => `[id="comment-${id}"]`
  const assertNoCommentText = bytes => status.assertNoneIn(bytes, body, newBody)
  const readNotice = () => status.getFrame(recipient.request, inboxUrl, FrameType.ConversationDetailV3, decodeInboxThread)

  return isolated.withTempContext(browser, async anon => {
    await anon.addCookies([{ name: 'fsus_locale', value: 'en', url: siteOrigin }])
    const readPublicContext = id => readContext(anon.request, siteOrigin, articleId, id)
    await readReaderSession(author, siteOrigin)
    const otherHandle = await readSessionHandle(recipient, siteOrigin)
    await status.assertGetStatus(anon.request, routes.detail, 401)
    const denied = await recipient.request.get(routes.detail, { headers: { [WireHeaders.CurrentSession]: otherHandle } })
    status.assertStatus(denied, 404)
    assertNoCommentText(await denied.body())
    await recipient.locator(selector(parentId)).getByRole('button', menu).waitFor()
    assert.equal(await recipient.locator(selector(replyId)).getByRole('button', menu).count(), 0)

    const guest = await anon.newPage()
    status.assertStatus(await guest.goto(siteOrigin + permalink), 200)
    await loc.exactText(guest.locator(selector(replyId)), body).waitFor()
    assert.equal(await guest.locator(selector(replyId)).getByRole('button', menu).count(), 0)

    await recipient.bringToFront()
    await loc.exactButton(recipient.locator(selector(replyId)), 'Reply').click()
    await loc.exactLabel(recipient, 'Reply').fill(childBody)
    await loc.exactText(recipient, 'Publish as Moderation fixture writer after review').click()
    const child = await submitReply(recipient, siteOrigin, recipient.getByRole('button', { name: 'Submit for review' }), replyId)
    assert.equal(child.articleId, articleId)
    await approve(childBody, child.commentId)
    const first = (await readPublicContext(replyId)).view.target
    const firstChild = (await readPublicContext(child.commentId)).view.target
    status.assertFields(first, { content: body, edited: false, parentId: String(parentId) })
    status.assertFields(firstChild, { content: childBody, parentId: first.id })
    const originalNotice = await readNotice()
    assert.equal(originalNotice.messages.length, 1)
    assert(originalNotice.messages[0].body.includes(body.slice(0, 40)))

    await author.bringToFront()
    await author.goto(siteOrigin + permalink)
    status.assertStatus(await author.reload(), 200)
    const { publication } = await status.fetchPublicArticle(author.request, siteOrigin, articleId)
    const action = author.locator(selector(replyId)).getByRole('button', menu)
    const dialog = loc.exactDialog(author, 'Edit your comment')
    const input = loc.exactLabel(dialog, 'Edited comment')
    const save = loc.exactButton(dialog, 'Save for review')
    async function openEditor() {
      const loaded = await clickForResponse(author, routes.detail, action)
      await status.assertNoStore(loaded)
      const decoded = await readEditDetail(loaded)
      status.assertFields(decoded, { articleId, publication, body })
      await dialog.waitFor()
      assert.equal(await input.inputValue(), body)
      return decoded
    }
    const writes = []
    author.on('request', request => {
      if (request.method() === 'POST' && [routes.challenge, routes.edit].includes(request.url())) writes.push(request.url())
    })
    const detail = await openEditor()
    assert(detail.currentVersion > 0n)
    assert.equal(await save.isDisabled(), true)
    await input.fill('This cancelled edit must never be submitted.')
    await loc.exactButton(dialog, 'Cancel').click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(writes, [])
    assert.equal((await readPublicContext(replyId)).view.target.content, body)

    const next = await openEditor()
    assert.deepEqual(next, detail)
    await input.fill(newBody)
    await isolated.assertNoOverflow(author)
    await isolated.saveShot(author, evidence, 'comment-edit-before-save-mobile.png')
    const [grant, applied] = await Promise.all([
      waitForUrlResponse(author, () => routes.challenge, 'POST'),
      waitForUrlResponse(author, () => routes.edit, 'POST'),
      save.click(),
    ])
    assert.deepEqual(writes, [routes.challenge, routes.edit])
    const { proof, command } = await verifyEditChallenge(grant, applied.request().postDataBuffer(), Number(detail.currentVersion), newBody)
    assert.deepEqual(Object.keys(command).sort(), ['challenge', 'content', 'expectedVersion'])
    assert.equal(proof.currentVersion, command.expectedVersion)
    const result = await status.readJsonFrame(applied, FrameType.CommentAuthorMutationResult)
    status.assertFields(result, { success: true, moderationStatus: 0, currentVersion: command.expectedVersion + 1 })
    await dialog.waitFor({ state: 'hidden' })
    await loc.exactText(author, 'Comment edit submitted for review.').waitFor()
    await loc.exactText(author, 'This comment is unavailable.').waitFor()
    assert.equal(await loc.exactText(author, body).count(), 0)
    assert.equal(await loc.exactText(author, newBody).count(), 0)
    const pending = await readPublicContext(replyId)
    assert.equal(pending.view, null)
    assertNoCommentText(pending.payload)
    const childWhilePending = await readPublicContext(child.commentId)
    assertNoCommentText(childWhilePending.payload)
    status.assertFields(childWhilePending.view.target, { content: childBody, parentId: first.id })
    const hiddenParent = childWhilePending.view.ancestors.find(node => node.id === first.id)
    assert(hiddenParent?.deleted && !hiddenParent.edited)
    assert.notEqual(hiddenParent.author.displayName, first.author.displayName)
    await isolated.saveShot(author, evidence, 'comment-edit-pending-mobile.png')

    await approve(newBody, replyId)
    status.assertStatus(await guest.reload(), 200)
    const publicNode = guest.locator(selector(replyId))
    await loc.exactText(publicNode, newBody).waitFor()
    await loc.exactText(publicNode, 'Edited').waitFor()
    assert.equal(await loc.exactText(publicNode, body).count(), 0)
    assert.equal(await publicNode.getByRole('button', menu).count(), 0)
    const final = (await readPublicContext(replyId)).view.target
    const finalChild = (await readPublicContext(child.commentId)).view.target
    const coordinates = node => [node.id, node.parentId, node.rootId, node.replyToId, node.depth, node.createdAt]
    assert.deepEqual(coordinates(final), coordinates(first))
    assert.deepEqual(coordinates(finalChild), coordinates(firstChild))
    status.assertFields(final, { content: newBody, edited: true })
    const finalNotice = await readNotice()
    assert.deepEqual(finalNotice.messages.map(message => [message.id, message.body]),
      originalNotice.messages.map(message => [message.id, message.body]))
    status.assertStatus(await recipient.goto(siteOrigin + '/user/messagebox'), 200)
    const noticeButton = recipient.getByRole('button', { name: /收到新的评论回复/ })
    await noticeButton.waitFor()
    assert.equal(await noticeButton.count(), 1)
    await isolated.writeEvidenceJson(evidence, 'comment-edit-result.json', { articleId, replyId: String(replyId), childId: String(child.commentId),
      previousVersion: command.expectedVersion, pendingVersion: result.currentVersion, preservedPublicDescendant: true,
      reapprovedSameCoordinates: true, originalNoticeCount: originalNotice.messages.length, finalNoticeCount: finalNotice.messages.length })
    return newBody
  })
}
