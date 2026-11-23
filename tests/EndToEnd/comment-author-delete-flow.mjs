import { withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { roleWithExactName, exactText, exactButton, exactLabel } from './role-locators.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodePowChallenge, encodePowProof } from '../../src/Contracts/pow.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeDraft, decodePublicCommentSubmissionResult, decodeSession, encodeArticleCommand, encodePublicCommentSubmission,
  FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { binary, chromium, expect, observePageErrors, postFrame } from './browser-authoring-fixture.mjs'
import { enableAuthenticator } from './webauthn-fixture.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const socket = process.env.FSUSBLOG_TEST_COMMENT_DELETE_DB
const englishLocale = { name: 'fsus_locale', value: 'en', url: origin }
assert(socket?.startsWith('/tmp/fsusv2-e2e.') && socket.endsWith('/socket'))
const observations = []
const diagnostics = []
const requestPath = (path, id) => path.replace('{id:long}', String(id))
const json = value => Buffer.from(JSON.stringify(value))
const decodeJson = payload => JSON.parse(Buffer.from(payload).toString())

function sql(statement, variables = {}) {
  return execFileSync(`${process.env.PG_TOOLS_DIR}/psql`, ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '54930',
    '-U', 'fsusqa', '-d', 'postgres', ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`])],
  { input: statement, encoding: 'utf8' }).trim()
}

async function post(context, path, type, payload, expected, headers = {}, status = 200) {
  const response = await postFrame(context.request, origin + path, type, payload, { ...binary, ...headers })
  assert.equal(response.status(), status, path)
  assert.match(response.headers()['cache-control'] ?? '', /no-store/)
  return expected === undefined ? response : decodeFrame(await response.body(), expected).payload
}

async function readerPasskeyLogin(page) {
  await page.context().addCookies([englishLocale])
  await page.goto(origin + '/login')
  await exactButton(page, 'Log in with Passkey').click()
  await page.waitForURL(origin + '/user/identity/mfa')
  const response = await page.request.get(origin + WireRoutes.Session)
  try {
    assertStatus(response, 200)
    const handle = response.headers()[WireHeaders.CurrentSession.toLowerCase()]
    const session = decodeSession(decodeFrame(await response.body(), FrameType.OperatorSession).payload)
    assert.equal(session.canAuthor, false)
    assert.match(handle, /^[a-f0-9]{64}$/)
    return { name: session.name, handle }
  } finally { await response.dispose() }
}

async function registerReader(page) {
  await enableAuthenticator(page.context(), page)
  await page.context().addCookies([englishLocale])
  await page.goto(origin + '/register')
  await exactText(page, 'I have read and agree to the guidelines.').click()
  await exactButton(page, 'Create Passkey').click()
  await roleWithExactName(page, 'link', 'Log in with Passkey').waitFor()
  return readerPasskeyLogin(page)
}

async function publisherPasskeyLogin(page, bootstrap) {
  assert(bootstrap)
  await enableAuthenticator(page.context(), page)
  await page.context().addCookies([englishLocale])
  await page.goto(origin + '/login?redirect=/admin/identity')
  await exactButton(page, 'Set up your first Passkey').click()
  await exactLabel(page, 'One-time setup ticket').fill(bootstrap)
  await exactButton(page, 'Create Passkey').click()
  await exactText(page, 'Passkey created. Log in with your Passkey.').waitFor()
  await exactButton(page, 'Log in with Passkey').click()
  await page.waitForURL(origin + '/admin/identity')
  const response = await page.request.get(origin + WireRoutes.AuthoringSession)
  try {
    assertStatus(response, 200)
    const handle = response.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert.match(handle, /^[a-f0-9]{64}$/)
    return { [WireHeaders.CurrentSession]: handle }
  } finally { await response.dispose() }
}

async function comment(context, articleId, publication, body) {
  const idempotencyKey = randomUUID()
  const command = encodePublicCommentSubmission({ articleId, publication, displayName: 'Shared display label', body, idempotencyKey, explicitPublic: true })
  const clientNonce = randomBytes(16).toString('hex')
  const key = { [WireHeaders.ClientMutationId]: idempotencyKey }
  const proof = decodePowChallenge(await post(context, WireRoutes.PublicCommentPowChallenge, FrameType.PublicCommentSubmission,
    command, FrameType.PowChallenge, { ...key, [WireHeaders.PowClientNonce]: clientNonce }))
  let work
  for (let nonce = 0; nonce < 131_072 && work === undefined; nonce++) {
    const digest = createHash('sha256').update(`${proof.salt}:${nonce}:${clientNonce}`).digest()
    const bytes = Math.floor(proof.difficulty / 8)
    const bits = proof.difficulty % 8
    if (digest.subarray(0, bytes).every(value => value === 0) && (bits === 0 || digest[bytes] >>> (8 - bits) === 0)) work = String(nonce)
  }
  assert(work !== undefined)
  const receipt = decodePublicCommentSubmissionResult(await post(context, WireRoutes.SubmitPublicComment, FrameType.PublicCommentSubmission,
    command, FrameType.PublicCommentSubmissionResult, { ...key, [WireHeaders.PowProof]: encodePowProof(proof, work, clientNonce) }))
  assert.equal(receipt.moderationStatus, 0)
  return receipt.commentId
}

async function challenge(context, auth, id, status = 200, purpose = 'delete') {
  const result = await post(context, requestPath(WireRoutes.CommentAuthorChallenge, id), FrameType.CommentManagementChallengeRequest,
    json({ purpose, capabilitySecret: null }), status === 200 ? FrameType.CommentManagementChallengeResponse : undefined, auth, status)
  if (status !== 200) return
  const grant = decodeJson(result)
  assert.deepEqual(Object.keys(grant).sort(), ['challenge', 'currentVersion', 'expiresAtUtc', 'failureCode', 'issued'])
  assert.equal(grant.issued, true)
  assert.equal(grant.failureCode, null)
  assert.match(grant.challenge, /^[A-Za-z0-9_-]{43}$/)
  assert(Math.abs(Date.parse(grant.expiresAtUtc) - Date.now() - 300_000) < 10_000)
  return grant
}

const remove = async (context, auth, id, grant, status = 200) => {
  const result = await post(context, requestPath(WireRoutes.CommentAuthorDelete, id), FrameType.CommentAuthorStatusRequest,
    json({ challenge: grant.challenge, capabilitySecret: '' }), status === 200 ? FrameType.CommentAuthorMutationResult : undefined, auth, status)
  if (status === 200) assert.deepEqual(decodeJson(result), {
    success: true, code: 'ok', currentVersion: grant.currentVersion + 1, moderationStatus: 1, editedAtUtc: null,
  })
}

const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
await withBrowserEvidence(browser, evidence, 'comment-author-delete-result.json', { observations, diagnostics }, async () => {
  const publisher = await browser.newContext()
  const secondSession = await browser.newContext()
  const outsider = await browser.newContext()
  const reader = await browser.newContext()
  const publisherAuth = await publisherPasskeyLogin(observePageErrors(await publisher.newPage(), diagnostics),
    process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP)
  const enrolled = observePageErrors(await secondSession.newPage(), diagnostics)
  const owner = await registerReader(enrolled)
  const commenter = await browser.newContext({ storageState: await secondSession.storageState(), viewport: { width: 375, height: 850 } })
  // Keep the first server session alive while the registered authenticator opens an independent session.
  await secondSession.clearCookies()
  const second = await readerPasskeyLogin(enrolled)
  assert.equal(second.name, owner.name)
  assert.notEqual(second.handle, owner.handle)
  const foreign = await registerReader(observePageErrors(await outsider.newPage(), diagnostics))
  assert.notEqual(foreign.name, owner.name)
  await reader.addCookies([englishLocale])
  const commenterAuth = { [WireHeaders.CurrentSession]: owner.handle }
  const secondAuth = { [WireHeaders.CurrentSession]: second.handle }
  const outsiderAuth = { [WireHeaders.CurrentSession]: foreign.handle }
  const draft = decodeDraft(await post(publisher, WireRoutes.Save, FrameType.ArticleCommand, encodeArticleCommand({ id: 0, expectedRevision: 0n,
    idempotencyKey: randomUUID(), title: 'Comment ownership fixture article', body: 'Public article for signed-in deletion.' }), FrameType.Draft))
  await post(publisher, WireRoutes.Publish, FrameType.ArticleCommand, encodeArticleCommand({ id: draft.id, expectedRevision: draft.revision,
    idempotencyKey: randomUUID(), title: '', body: '' }), FrameType.Draft)
  const view = await publisher.request.get(`${origin}${WireRoutes.PublicArticle.replace('{id}', String(draft.id))}`)
  assertStatus(view, 200)
  const { publication } = decodeArticle(decodeFrame(await view.body(), FrameType.ArticleDetail).payload)
  sql(`insert into public.comment_public_write(article_id) values(:article);
       insert into public.comment_public_handle(user_id,display_name) select id,'Shared display label' from public.blog_user
       where name in (:'owner', :'outsider');`, { article: draft.id, owner: owner.name, outsider: foreign.name })
  const parentText = 'Author-owned root removed after a public reply.'
  const childText = 'Other author public reply remains visible.'
  const root = await comment(commenter, draft.id, publication, parentText)
  const child = await comment(outsider, draft.id, publication, childText)
  const other = await comment(commenter, draft.id, publication, 'Stale, expired and rolled-back proof target.')
  sql(`update public.comment set moderation_status=1,moderation_version=moderation_version+1 where article_id=:article;
       update public.comment set parent_id=:root,root_id=:root,depth=1,parent_depth=0 where article_id=:article and id=:child;
       insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
       values(:article,9007199254740993,9007199254740993,0,1,false,'Legacy equal public handle',3,'Shared display label','en',now());`,
  { article: draft.id, root, child })

  await challenge(reader, {}, root, 401)
  await challenge(outsider, outsiderAuth, root, 404)
  await challenge(publisher, publisherAuth, root, 401)
  await challenge(commenter, commenterAuth, 9007199254740993n, 404)
  await challenge(commenter, commenterAuth, root, 400, 'status')
  await challenge(commenter, outsiderAuth, root, 409)
  await post(commenter, requestPath(WireRoutes.CommentAuthorChallenge, root), FrameType.CommentManagementChallengeRequest,
    json({ purpose: 'delete', capabilitySecret: null }), undefined, { ...commenterAuth, Origin: 'https://not-the-blog.invalid' }, 403)
  const stale = await challenge(commenter, commenterAuth, other)
  await remove(secondSession, secondAuth, other, stale, 404)
  await remove(commenter, commenterAuth, root, stale, 404)
  const revoked = await challenge(secondSession, secondAuth, other)
  const ended = await secondSession.request.post(`${origin}${WireRoutes.SignOut}`)
  assertStatus(ended, 200)
  await remove(secondSession, secondAuth, other, revoked, 401)
  await remove(commenter, commenterAuth, other, revoked, 404)
  sql('update public.comment set moderation_version=moderation_version+1 where article_id=:article and id=:id;', { article: draft.id, id: other })
  await remove(commenter, commenterAuth, other, stale, 409)
  const expired = await challenge(commenter, commenterAuth, other)
  sql("update public.comment_author_delete_challenge set expires_at=clock_timestamp()-interval '1 second' where comment_id=:id;", { id: other })
  await remove(commenter, commenterAuth, other, expired, 404)
  const rollback = await challenge(commenter, commenterAuth, other)
  sql('alter table public.comment_author_delete_outbox add constraint fixture_refuse_delete check (false);')
  await remove(commenter, commenterAuth, other, rollback, 503)
  assert.equal(sql(`select c.deleted,(select count(*) from public.comment_author_deleted where comment_id=:id),
      (select count(*) from public.comment_author_delete_challenge where comment_id=:id) from public.comment c where id=:id;`, { id: other }), 'f|0|1')
  sql('alter table public.comment_author_delete_outbox drop constraint fixture_refuse_delete;')
  const resumed = await Promise.all([0, 1].map(() => postFrame(commenter.request,
    origin + requestPath(WireRoutes.CommentAuthorDelete, other), FrameType.CommentAuthorStatusRequest,
    json({ challenge: rollback.challenge, capabilitySecret: '' }), { ...binary, ...commenterAuth })))
  assert.deepEqual(resumed.map(response => response.status()).sort(), [200, 404])
  assert.deepEqual(decodeJson(decodeFrame(await resumed.find(response => response.status() === 200).body(),
    FrameType.CommentAuthorMutationResult).payload), {
    success: true, code: 'ok', currentVersion: rollback.currentVersion + 1, moderationStatus: 1, editedAtUtc: null,
  })
  await remove(commenter, commenterAuth, other, rollback, 404)
  observations.push({ signedInNonArticleOwner: true, foreignAccountAndSessionDenied: true, revokedSessionProofDenied: true, staleAndExpiredDenied: true,
    noDisplayNameAuthority: true, outboxFailureRollsBackAndPreservesExactProof: true, singleUse: true })

  const article = `${origin}/article/${draft.id}`
  const page = await commenter.newPage()
  observePageErrors(page, diagnostics)
  let challenges = 0
  page.on('request', req => { if (req.url() === `${origin}${requestPath(WireRoutes.CommentAuthorChallenge, root)}`) challenges++ })
  await page.goto(article)
  const target = page.locator(`#comment-${root}`)
  const action = roleWithExactName(target, 'button', 'Delete my comment')
  await expect(action).toBeVisible()
  const reply = page.locator(`#comment-${child}`)
  if (!await reply.isVisible()) await target.getByRole('button', { name: 'Show replies (1)' }).click()
  await expect(exactText(reply, childText)).toBeVisible()
  await expect(reply.getByRole('button', { name: 'Delete my comment' })).toHaveCount(0)
  await expect(page.locator('#comment-9007199254740993').getByRole('button', { name: 'Delete my comment' })).toHaveCount(0)
  const anonymousPage = await reader.newPage()
  await anonymousPage.goto(article)
  await expect(anonymousPage.locator(`#comment-${root}`)).toBeVisible()
  await expect(anonymousPage.getByRole('button', { name: 'Delete my comment' })).toHaveCount(0)
  await action.click()
  const confirmation = page.getByRole('dialog', { name: 'Delete your comment?' })
  await expect(confirmation).toBeVisible()
  await page.screenshot({ path: join(evidence, 'comment-delete-confirm-mobile.png') })
  await confirmation.getByRole('button', { name: 'Keep comment' }).click()
  await expect(confirmation).toBeHidden()
  assert.equal(challenges, 0)
  await expect(exactText(target, parentText)).toBeVisible()
  await action.click()
  await confirmation.getByRole('button', { name: 'Delete comment' }).click()
  await expect(exactText(page, 'Comment deleted.')).toBeVisible()
  await expect(exactText(page, parentText)).toHaveCount(0)
  if (!await reply.isVisible()) await target.getByRole('button', { name: 'Show replies (1)' }).click()
  await expect(exactText(reply, childText)).toBeVisible()
  await expect(target.getByRole('button', { name: 'Delete my comment' })).toHaveCount(0)
  await page.screenshot({ path: join(evidence, 'comment-delete-public-tombstone.png') })
  await anonymousPage.goto(`${article}#comment-${root}`)
  await expect(exactText(anonymousPage, 'This comment is unavailable.')).toBeVisible()
  const fresh = decodeDraft(decodeFrame(await (await publisher.request.get(`${origin}${WireRoutes.Draft.replace('{id:int}', String(draft.id))}`)).body(), FrameType.Draft).payload)
  const withdrawn = await comment(outsider, draft.id, publication, 'Owned comment remains manageable after withdrawal.')
  sql('update public.comment set moderation_status=1,moderation_version=moderation_version+1 where id=:id;', { id: withdrawn })
  await post(publisher, WireRoutes.Retract, FrameType.ArticleCommand, encodeArticleCommand({ id: draft.id, expectedRevision: fresh.revision,
    idempotencyKey: randomUUID(), title: '', body: '' }), FrameType.Draft)
  const withdrawnGrant = await challenge(outsider, outsiderAuth, withdrawn)
  await remove(outsider, outsiderAuth, withdrawn, withdrawnGrant)
  const counts = sql(`select (select count(*) from public.comment_account_owner),(select count(*) from public.comment_author_deleted),
    (select count(*) from public.comment_author_delete_outbox),(select count(*) from public.comment_author_deleted where octet_length(body_digest)=32);`)
  assert.equal(counts, '4|3|3|3')
  observations.push({ mobileConfirmation: true, cancellingDidNotIssueProof: true, tombstoneRedactsRootAndPreservesReply: true,
    anonymousDeletedPermalinkUnavailable: true, authorCanDeleteAfterArticleWithdrawal: true, durableCounts: counts })
  assert.deepEqual(diagnostics, [])
})
