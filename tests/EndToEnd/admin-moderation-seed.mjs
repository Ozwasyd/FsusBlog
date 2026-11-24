import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { authorFixture, submitPublicCommentWithPow } from './browser-authoring-fixture.mjs'
import { withTempContext } from './isolated-browser-fixture.mjs'
import { assertStatus, fetchPublicArticle } from './response-status-fixture.mjs'
import { signInFreshAdmin, signInFreshSite } from './webauthn-fixture.mjs'

const { FSUSBLOG_TEST_TLS_DOTNET: dotnet, FSUSBLOG_TEST_TLS_CLI: cli,
  FSUSBLOG_TEST_ADMIN_MODERATOR_SITE_TICKET: ticket, FSUSBLOG_TEST_ADMIN_MODERATOR_DATABASE: database,
  FSUSBLOG_TEST_MODERATION_PUBLISHER: bootstrap } = process.env

export async function seedModeration({ reader, adminOrigin, siteOrigin, body }) {
  assert(dotnet && cli && /^[a-f0-9]{64}$/.test(ticket ?? '') && /^[a-f0-9]{64}$/.test(bootstrap ?? '')
    && /^fsusv2_admin_tls_[a-f0-9]{24}$/.test(database ?? '') && body)
  const admin = authorFixture(adminOrigin, [])
  const articleId = await withTempContext(reader.context().browser(), async publisher => {
    await signInFreshAdmin(await publisher.newPage(), adminOrigin, bootstrap)
    const draft = await admin.createDraft(publisher, 'Moderation fixture article', 'Published fixture for pending comment isolation.')
    await admin.publishDraft(publisher, draft)
    assertStatus(await publisher.request.post(adminOrigin + WireRoutes.AdminSignOut, { headers: { Origin: adminOrigin } }), 200)
    return draft.id
  })

  await signInFreshSite(reader, siteOrigin, ticket)
  const displayName = 'Moderation fixture writer'
  const { publication } = await fetchPublicArticle(reader.request, siteOrigin, articleId)
  const psql = process.env.PG_TOOLS_DIR ? `${process.env.PG_TOOLS_DIR}/psql` : 'psql'
  const userId = name => {
    const id = execFileSync(psql, ['-X', '-w', '-tA', '-d', database, '-c',
      `select id from public.blog_user where name='${name}'`], { encoding: 'utf8' }).trim()
    assert.match(id, /^[0-9a-f-]{36}$/)
    return id
  }
  const user = userId('tls-moderation-fixture')
  execFileSync(dotnet, [cli, 'comment', 'policy', String(articleId), 'enable'])
  execFileSync(dotnet, [cli, 'comment', 'handle', user, displayName])
  if (process.env.FSUSBLOG_TEST_COMMENT_REPLY === '1') {
    const responder = userId('tls-comment-reply-fixture')
    assert.notEqual(responder, user)
    execFileSync(dotnet, [cli, 'comment', 'handle', responder, 'Reply fixture writer'])
  }

  const comments = [body, body + ' [reject fixture]']
  if (process.env.FSUSBLOG_TEST_ADMIN_COMMENT_BATCH === '1')
    comments.push('Batch approve fixture one', 'Batch approve fixture two', 'Batch reject fixture one', 'Batch reject fixture two')
  for (const comment of comments) {
    await submitPublicCommentWithPow(reader.request, siteOrigin, { articleId, publication, displayName, body: comment })
  }
  return articleId
}
