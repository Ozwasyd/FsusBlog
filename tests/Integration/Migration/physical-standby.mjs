import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [worktree, mode, failed, promoted, input, receipt] = process.argv.slice(2)
assert(mode === 'write' || mode === 'compare')
const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(4000), redirect: 'error' })
const { decodeFrame, encodeFrame } = await import(pathToFileURL(worktree + '/src/Contracts/aeds.ts'))
const { decodeDraft, decodeSession, encodeArticleCommand, encodeSignIn, FrameType, WireHeaders, WireRoutes } =
  await import(pathToFileURL(worktree + '/src/Contracts/wire.generated.ts'))
const { decodeArticle } = await import(pathToFileURL(worktree + '/src/Contracts/public-articles.ts'))
const binary = 'application/octet-stream'
let token, expectedSession
const marker = 'Physical standby publication fixture'
const articleAeds = id => WireRoutes.PublicArticle.replace('{id}', String(id))
async function write(origin, route, type, payload, responseType, status = 200) {
  const headers = { 'Content-Type': binary }
  if (token) {
    headers.Cookie = token
    headers[WireHeaders.CurrentSession] = expectedSession
  }
  const response = await request(origin + route, { method: 'POST', headers, body: encodeFrame(type, payload) })
  assert.equal(response.status, status)
  const decoded = decodeFrame(new Uint8Array(await response.arrayBuffer()), responseType)
  return { response, payload: decoded.payload }
}
const visibility = async (origin, article, status, generation) => {
  const html = await request(origin + '/article/' + article.id)
  const binaryDetail = await request(origin + articleAeds(article.id), { headers: { Accept: binary } })
  assert.equal(html.status, status)
  assert.equal(binaryDetail.status, status)
  if (generation) {
    assert.equal(html.headers.get(WireHeaders.SearchIndexGeneration), generation)
    assert.equal(binaryDetail.headers.get(WireHeaders.SearchIndexGeneration), generation)
  }
  if (status === 200) {
    assert.match(await html.text(), new RegExp(marker))
    return decodeArticle(decodeFrame(new Uint8Array(await binaryDetail.arrayBuffer()), FrameType.ArticleDetail).payload)
  }
  assert(!((await html.text()).includes(marker)))
}
const command = (id, revision, title = '', body = '') =>
  encodeArticleCommand({ id, expectedRevision: revision, idempotencyKey: randomUUID(), title, body })
if (mode === 'write') {
  const ticket = (await readFile(input, 'utf8')).trim()
  const login = await write(promoted, WireRoutes.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }), FrameType.OperatorSession)
  assert(decodeSession(login.payload).canAuthor)
  token = login.response.headers.get('Set-Cookie').split(';', 1)[0]
  expectedSession = login.response.headers.get(WireHeaders.CurrentSession)
  assert(token && expectedSession)
  const save = await write(promoted, WireRoutes.Save, FrameType.ArticleCommand, command(0, 0n, marker, 'PostgreSQL confirms this body.'), FrameType.Draft)
  const draft = decodeDraft(save.payload)
  const publishCommand = command(draft.id, draft.revision)
  const publication = decodeDraft((await write(promoted, WireRoutes.Publish, FrameType.ArticleCommand, publishCommand, FrameType.Draft)).payload)
  assert(publication.published)
  const corpus = await request(promoted + WireRoutes.PublicSearchCorpus)
  assert.equal(corpus.status, 200)
  await corpus.arrayBuffer()
  const generation = corpus.headers.get(WireHeaders.SearchIndexGeneration)
  assert.match(generation, /^(0|[1-9][0-9]{0,18})$/)
  const detail = await visibility(promoted, publication, 200, generation)
  assert.equal(detail.revision, publication.revision)
  await writeFile(receipt, JSON.stringify({
    token, expectedSession, id: draft.id, revision: String(publication.revision),
    generation, publication: String(detail.publication), publishCommand: Buffer.from(publishCommand).toString('base64'),
  }), { flag: 'wx', mode: 0o600 })
} else {
  const original = JSON.parse(await readFile(input, 'utf8'))
  token = original.token
  expectedSession = original.expectedSession
  const article = { id: original.id, revision: BigInt(original.revision) }
  assert.equal((await request(failed + '/health/ready')).status, 503)
  await visibility(failed, article, 503)
  await write(failed, WireRoutes.Retract, FrameType.ArticleCommand, command(article.id, article.revision), FrameType.ApiError, 503)
  const detail = await visibility(promoted, article, 200, original.generation)
  assert.equal(detail.publication, BigInt(original.publication))
  assert.equal(detail.revision, article.revision)
  const oldHead = await request(promoted + WireRoutes.PublicSearchCorpus + '?generation=' + original.generation, { method: 'HEAD' })
  assert.equal(oldHead.status, 204)
  const replay = await write(promoted, WireRoutes.Publish, FrameType.ArticleCommand,
    Buffer.from(original.publishCommand, 'base64'), FrameType.Draft)
  assert.equal(decodeDraft(replay.payload).revision, article.revision)
  const retractCommand = command(article.id, article.revision)
  const retract = await write(promoted, WireRoutes.Retract, FrameType.ArticleCommand, retractCommand, FrameType.Draft)
  assert(!decodeDraft(retract.payload).published)
  const replayRetract = await write(promoted, WireRoutes.Retract, FrameType.ArticleCommand, retractCommand, FrameType.Draft)
  assert.equal(decodeDraft(replayRetract.payload).revision, decodeDraft(retract.payload).revision)
  const stale = await request(promoted + WireRoutes.PublicSearchCorpus + '?generation=' + original.generation, { method: 'HEAD' })
  assert.equal(stale.status, 409)
  await visibility(promoted, article, 404)
  await visibility(failed, article, 503)
  console.log(JSON.stringify({ readyOld: 503, stalePrivateWrite: 503, restorePublication: original.publication,
    restoreRevision: original.revision, restoreGeneration: original.generation, durableReplay: true,
    durableRetraction: String(decodeDraft(retract.payload).revision), oldGenerationAfterRetraction: 409,
    oldHtml: 503, newHtmlAndAedsAfterRetraction: 404 }))
}
