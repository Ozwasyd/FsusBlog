import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodePowChallenge, encodePowProof } from '../../src/Contracts/pow.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeDraft, decodePublicCommentSubmissionResult, encodeArticleCommand, encodePublicCommentSubmission, encodeSignIn,
  FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const source = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { request } = source('@playwright/test')
const { FSUSBLOG_TEST_SITE_URL: origin, FSUSBLOG_TEST_TLS_DOTNET: dotnet, FSUSBLOG_TEST_TLS_MIGRATE: migrate,
  FSUSBLOG_TEST_ADMIN_MODERATOR_SITE_TICKET: ticket, FSUSBLOG_TEST_ADMIN_MODERATOR_DATABASE: database,
  FSUSBLOG_TEST_ADMIN_MODERATOR_BODY: body } = process.env
assert(origin && dotnet && migrate && /^[a-f0-9]{64}$/.test(ticket ?? '') && /^fsusv2_admin_tls_[a-f0-9]+$/.test(database ?? '') && body)
const displayName = 'Moderation fixture writer'
const session = await request.newContext({ baseURL: origin })
try {
  await post(WireRoutes.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }), FrameType.OperatorSession)
  const content = { title: 'Moderation fixture article', body: 'Published fixture for pending comment isolation.' }
  const draft = decodeDraft(await write(WireRoutes.Save, 0, 0n, content))
  await write(WireRoutes.Publish, draft.id, draft.revision, { title: '', body: '' })
  const articleId = draft.id
  const detail = await session.get(WireRoutes.PublicArticle.replace('{id}', String(articleId)))
  assert.equal(detail.status(), 200)
  const { publication } = decodeArticle(decodeFrame(await detail.body(), FrameType.ArticleDetail).payload)
  const psql = process.env.PG_TOOLS_DIR ? `${process.env.PG_TOOLS_DIR}/psql` : 'psql'
  const user = execFileSync(psql, ['-X', '-w', '-tA', '-d', database, '-c',
    "select id from public.blog_user where name='tls-moderation-fixture'"], { encoding: 'utf8' }).trim()
  assert.match(user, /^[0-9a-f-]{36}$/)
  execFileSync(dotnet, [migrate, 'comment', 'policy', String(articleId), 'enable'])
  execFileSync(dotnet, [migrate, 'comment', 'handle', user, displayName])

  for (const comment of [body, body + ' [reject fixture]']) {
    const key = randomUUID()
    const payload = encodePublicCommentSubmission({ articleId, publication, displayName, body: comment, idempotencyKey: key, explicitPublic: true })
    const clientNonce = randomBytes(16).toString('hex')
    const challenge = decodePowChallenge(await post(WireRoutes.PublicCommentPowChallenge, FrameType.PublicCommentSubmission,
      payload, FrameType.PowChallenge, { [WireHeaders.ClientMutationId]: key, [WireHeaders.PowClientNonce]: clientNonce }))
    const nonce = solve(challenge, clientNonce)
    const receipt = decodePublicCommentSubmissionResult(await post(WireRoutes.SubmitPublicComment, FrameType.PublicCommentSubmission,
      payload, FrameType.PublicCommentSubmissionResult, { [WireHeaders.ClientMutationId]: key,
        [WireHeaders.PowProof]: encodePowProof(challenge, nonce, clientNonce) }))
    assert.equal(receipt.articleId, articleId)
    assert.equal(receipt.moderationStatus, 0)
    assert(receipt.commentId > 0n)
  }
  assert.equal((await session.post(WireRoutes.SignOut)).status(), 200)
  console.log(articleId)
} finally { await session.dispose() }

async function write(path, id, expectedRevision, content) {
  const idempotencyKey = randomUUID()
  return post(path, FrameType.ArticleCommand, encodeArticleCommand({ id, expectedRevision, idempotencyKey, ...content }),
    FrameType.Draft, { [WireHeaders.ClientMutationId]: idempotencyKey })
}

async function post(path, type, body, expected, headers = {}) {
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
