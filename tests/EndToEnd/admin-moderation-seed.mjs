import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readDraft, submitPublicationMutation } from './browser-authoring-fixture.mjs'
import { signInFreshAdmin, signInFreshSite } from './webauthn-fixture.mjs'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodePowChallenge, encodePowProof } from '../../src/Contracts/pow.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodePublicCommentSubmissionResult, encodePublicCommentSubmission,
  FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { FSUSBLOG_TEST_TLS_DOTNET: dotnet, FSUSBLOG_TEST_TLS_CLI: cli,
  FSUSBLOG_TEST_ADMIN_MODERATOR_SITE_TICKET: ticket, FSUSBLOG_TEST_ADMIN_MODERATOR_DATABASE: database,
  FSUSBLOG_TEST_MODERATION_PUBLISHER: bootstrap } = process.env

export async function seedModeration({ reader, adminOrigin, siteOrigin, body }) {
  assert(dotnet && cli && /^[a-f0-9]{64}$/.test(ticket ?? '') && /^[a-f0-9]{64}$/.test(bootstrap ?? '')
    && /^fsusv2_admin_tls_[a-f0-9]{24}$/.test(database ?? '') && body)
  const publisher = await reader.context().browser().newContext()
  let articleId
  try {
    await signInFreshAdmin(await publisher.newPage(), adminOrigin, bootstrap)
    const draft = await readDraft(await submitPublicationMutation(publisher.request, adminOrigin + WireRoutes.Save, 0, 0n,
      'Moderation fixture article', 'Published fixture for pending comment isolation.'))
    await readDraft(await submitPublicationMutation(publisher.request, adminOrigin + WireRoutes.Publish, draft.id, draft.revision, '', ''))
    articleId = draft.id
    assert.equal((await publisher.request.post(adminOrigin + WireRoutes.AdminSignOut, { headers: { Origin: adminOrigin } })).status(), 200)
  } finally { await publisher.close() }

  await signInFreshSite(reader, siteOrigin, ticket)
  const displayName = 'Moderation fixture writer'
  const session = reader.request
  const detail = await session.get(siteOrigin + WireRoutes.PublicArticle.replace('{id}', String(articleId)))
  assert.equal(detail.status(), 200)
  const { publication } = decodeArticle(decodeFrame(await detail.body(), FrameType.ArticleDetail).payload)
  const psql = process.env.PG_TOOLS_DIR ? `${process.env.PG_TOOLS_DIR}/psql` : 'psql'
  const user = execFileSync(psql, ['-X', '-w', '-tA', '-d', database, '-c',
    "select id from public.blog_user where name='tls-moderation-fixture'"], { encoding: 'utf8' }).trim()
  assert.match(user, /^[0-9a-f-]{36}$/)
  execFileSync(dotnet, [cli, 'comment', 'policy', String(articleId), 'enable'])
  execFileSync(dotnet, [cli, 'comment', 'handle', user, displayName])
  if (process.env.FSUSBLOG_TEST_COMMENT_REPLY === '1') {
    const responder = execFileSync(psql, ['-X', '-w', '-tA', '-d', database, '-c',
      "select id from public.blog_user where name='tls-comment-reply-fixture'"], { encoding: 'utf8' }).trim()
    assert.match(responder, /^[0-9a-f-]{36}$/)
    assert.notEqual(responder, user)
    execFileSync(dotnet, [cli, 'comment', 'handle', responder, 'Reply fixture writer'])
  }

  const comments = [body, body + ' [reject fixture]']
  if (process.env.FSUSBLOG_TEST_ADMIN_COMMENT_BATCH === '1')
    comments.push('Batch approve fixture one', 'Batch approve fixture two', 'Batch reject fixture one', 'Batch reject fixture two')
  for (const comment of comments) {
    const key = randomUUID()
    const payload = encodePublicCommentSubmission({ articleId, publication, displayName, body: comment, idempotencyKey: key, explicitPublic: true })
    const clientNonce = randomBytes(16).toString('hex')
    const challenge = decodePowChallenge(await post(session, siteOrigin + WireRoutes.PublicCommentPowChallenge, FrameType.PublicCommentSubmission,
      payload, FrameType.PowChallenge, { [WireHeaders.ClientMutationId]: key, [WireHeaders.PowClientNonce]: clientNonce }))
    const nonce = solve(challenge, clientNonce)
    const receipt = decodePublicCommentSubmissionResult(await post(session, siteOrigin + WireRoutes.SubmitPublicComment, FrameType.PublicCommentSubmission,
      payload, FrameType.PublicCommentSubmissionResult, { [WireHeaders.ClientMutationId]: key,
        [WireHeaders.PowProof]: encodePowProof(challenge, nonce, clientNonce) }))
    assert.equal(receipt.articleId, articleId)
    assert.equal(receipt.moderationStatus, 0)
    assert(receipt.commentId > 0n)
  }
  return articleId
}

async function post(session, path, type, body, expected, headers = {}) {
  const response = await session.post(path, { headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    data: Buffer.from(encodeFrame(type, body)) })
  assert.equal(response.status(), 200, path)
  return decodeFrame(await response.body(), expected).payload
}

function solve({ salt, difficulty }, clientNonce) {
  const bytes = Math.floor(difficulty / 8)
  const bits = difficulty % 8
  for (let nonce = 0; nonce < 131_072; nonce++) {
    const digest = createHash('sha256').update(`${salt}:${nonce}:${clientNonce}`).digest()
    if (digest.subarray(0, bytes).every(byte => byte === 0) && (bits === 0 || digest[bytes] >>> (8 - bits) === 0)) return String(nonce)
  }
  throw new Error('No proof found in the fixture budget.')
}
