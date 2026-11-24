import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { binary, postFrame, submitPublicationMutation } from './browser-authoring-fixture.mjs'
import { withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { exactHeading, exactLink } from './role-locators.mjs'
import { expect, launchIdentityBrowser, readTlsPublicationFixture, request, secureLoginProtocol } from './site-authentication-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

// Run after the performance matrix releases the host. The disposable TLS fixture
// must initialize the schema and configure its PostgreSQL
// connection to suppress bind-parameter logging, including on errors.
const fixtureError = 'Use the disposable admin TLS fixture with its read-proof database, administrator bootstrap and TLS leaf pins.'
const { url, origin, pins } = readTlsPublicationFixture(fixtureError)
const adminOrigin = new URL(process.env.FSUSBLOG_TEST_ADMIN_URL).origin
const bootstrap = process.env.FSUSBLOG_TEST_ADMIN_TICKET
const database = process.env.FSUSBLOG_TEST_READ_PROOF_DATABASE
const runtimeControl = process.env.FSUSBLOG_RUNTIME_EVIDENCE_CONTROL
const runtimeOutput = process.env.FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT
assert(bootstrap && url.port && /^fsusv2_admin_tls_[0-9a-f]{24}$/.test(database ?? '') && runtimeControl && runtimeOutput &&
  process.env.PGHOST && process.env.PGPORT && process.env.PGUSER, fixtureError)

const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/article-read-proof-browser')
const psql = process.env.PG_TOOLS_DIR ? join(process.env.PG_TOOLS_DIR, 'psql') : 'psql'
const pgDump = process.env.PG_TOOLS_DIR ? join(process.env.PG_TOOLS_DIR, 'pg_dump') : 'pg_dump'
const logProbeAgent = 'FsusReadProofTransientProbe'
const challengeRequest = 32976, challengeResponse = 32977, submitRequest = 32978, submitResponse = 32979, minimumDwell = 8_000
const requestHeaders = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' }
const wirePath = (article, operation) => `/api/v2/public/articles/${article.id}/${article.publication}/read/${operation}.aeds`
const articlePath = article => WireRoutes.PublicArticle.replace('{id}', String(article.id))
const runPsql = (input, extraArgs = []) => execFileSync(psql, ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', database, ...extraArgs],
  { encoding: 'utf8', timeout: 5_000, input }).trim()

async function payload(response, type) {
  assertStatus(response, 200, response.url())
  assert.match(response.headers()['content-type'] ?? '', /^application\/octet-stream(?:;|$)/i)
  return decodeFrame(await response.body(), type).payload
}

async function refusal(response, status) {
  assertStatus(response, status, response.url())
  assert.match(response.headers()['content-type'] ?? '', /^application\/octet-stream(?:;|$)/i)
  assert.equal(decodeApiError(decodeFrame(await response.body(), FrameType.ApiError).payload, status).status, status)
}

async function dwellTicket(response) {
  const data = Buffer.from(await payload(response, challengeResponse))
  assert.equal(response.headers()['cache-control'], 'no-store')
  assert.equal(data.length, 60)
  assert.equal(data.readInt32LE(0), minimumDwell)
  return data.subarray(4)
}

function submission(ticket, dwell) {
  assert.equal(ticket.length, 56)
  const data = Buffer.alloc(60)
  data.writeInt32LE(dwell)
  ticket.copy(data, 4)
  return data
}

async function counted(response, expected) {
  assert.equal(response.headers()['cache-control'], 'no-store')
  assert.deepEqual([...await payload(response, submitResponse)], [expected ? 1 : 0])
}

function readAggregates(article) {
  assert(Number.isSafeInteger(article.id) && article.id > 0)
  const data = JSON.parse(runPsql(`
      BEGIN READ ONLY;
      SELECT json_build_object(
        'hours', coalesce((SELECT json_agg(json_build_object(
          'utc', to_char(hour_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'count', count))
          FROM public.article_read_hour WHERE article_id = :article_id), '[]'::json),
        'dwell', coalesce((SELECT json_agg(json_build_object('day', to_char(day_utc, 'YYYY-MM-DD'),
          'bucket', bucket, 'count', count)) FROM public.article_read_dwell WHERE article_id = :article_id), '[]'::json),
        'epochs', (SELECT json_agg(last_epoch::text) FROM public.article_read_epoch WHERE singleton));
      COMMIT;
    `, ['-v', `article_id=${article.id}`]))
  assert.equal(data.epochs?.length, 1, 'Expected the singleton durable epoch row')
  return data
}

const assertNoReads = article => {
  const { hours, dwell } = readAggregates(article)
  assert.deepEqual({ hours, dwell }, { hours: [], dwell: [] })
}

async function runtimeMark(mark) {
  const command = join(runtimeControl, 'runtime.mark')
  await writeFile(`${command}.tmp`, mark, { flag: 'wx' })
  await rename(`${command}.tmp`, command)
  await expect.poll(async () => access(join(runtimeControl, `${mark}.ack`)).then(() => true, () => false)).toBe(true)
  const sample = (await readFile(runtimeOutput, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(record => record.mark === mark)
  assert(sample)
  return sample
}

const reader = await request.newContext({ baseURL: origin, userAgent: logProbeAgent })
const postWire = (path, type, data = Buffer.alloc(0), headers = requestHeaders) =>
  postFrame(reader, path, type, data, { ...binary, ...headers })
const postChallenge = (path, headers) => postWire(path, challengeRequest, Buffer.alloc(0), headers)
const assertNotCounted = async (path, ticket) => counted(await postWire(path, submitRequest, submission(ticket, minimumDwell)), false)
const checks = {}
const browser = await launchIdentityBrowser(pins)
const browserVersion = browser.version()

await withBrowserEvidence(browser, evidence, 'article-read-proof-browser-result.json', failure => ({
  browser: browserVersion, checks, failure: failure instanceof Error ? failure.message : undefined,
}), async () => {
  assertStatus(await reader.get('/health/ready'), 204)
  const authorContext = await browser.newContext()
  await signInFreshAdmin(await authorContext.newPage(), adminOrigin, bootstrap)
  const author = authorContext.request
  const command = async (path, id, expectedRevision, title = '', body = '') =>
    decodeDraft(await payload(await submitPublicationMutation(author, adminOrigin + path, id, expectedRevision, title, body), FrameType.Draft))
  async function publish(label, previous) {
    const title = `${label} ${randomUUID()}`
    const saved = await command(WireRoutes.Save, previous?.id ?? 0, previous?.revision ?? 0n, title, 'Public article used to verify a visible read.')
    const published = await command(WireRoutes.Publish, saved.id, saved.revision)
    const article = decodeArticle(await payload(await reader.get(articlePath(published)), FrameType.ArticleDetail))
    assert.equal(article.id, published.id)
    assert.equal(article.title, title)
    return { ...article, revision: published.revision }
  }

  const wireArticle = await publish('Read proof direct protocol')
  const browserArticle = await publish('Read proof visible browser')
  const wireChallenge = wirePath(wireArticle, 'challenge'), wireSubmit = wirePath(wireArticle, 'submit')
  const plain = await reader.get(`/article/${wireArticle.id}`)
  assertStatus(plain, 200)
  assert.match(await plain.text(), /<meta\b[^>]*name="fsus-article-read-proof"[^>]*content="enabled"/i)
  assert.equal(plain.headers()['set-cookie'], undefined)
  assertStatus(await reader.get(articlePath(wireArticle)), 200)
  const before = await runtimeMark('measure-before')
  assertStatus(await reader.get(`/article/${wireArticle.id}`), 200)
  assertStatus(await reader.get(articlePath(wireArticle)), 200)
  assertStatus(await reader.head(`/article/${wireArticle.id}`), 405)
  assertStatus(await reader.head(articlePath(wireArticle)), 404)
  const after = await runtimeMark('measure-after')
  for (const route of ['detailHtml', 'detailAeds']) {
    assert.equal(after.requestStatus200[route] - before.requestStatus200[route], 1)
    assert.equal(after.dbCommandStarts[route] - before.dbCommandStarts[route], 0)
    assert.equal(after.dbPhysicalOpenStarts[route] - before.dbPhysicalOpenStarts[route], 0)
  }
  assertNoReads(wireArticle)
  checks.staticReadCreatesNoAnalytics = true

  await refusal(await postChallenge(wireChallenge, {}), 403)
  await refusal(await postChallenge(wireChallenge, { ...requestHeaders, Origin: 'https://other-origin.invalid' }), 403)
  await refusal(await postChallenge(wireChallenge, { ...requestHeaders, 'Sec-Fetch-Site': 'cross-site' }), 403)
  await refusal(await postChallenge(wirePath({ id: 2_147_483_647, publication: 1n }, 'challenge')), 404)
  checks.challengeRequiresSameOriginAndExistingArticle = true

  const epochRemaining = 900_000 - Date.now() % 900_000
  if (epochRemaining < 45_000) await delay(epochRemaining + 500)
  const wireTicket = await dwellTicket(await postChallenge(wireChallenge))
  const wireSubmission = submission(wireTicket, minimumDwell)
  await refusal(await postWire(wireSubmit, submitRequest, wireSubmission, { ...requestHeaders, 'Sec-Fetch-Dest': 'document' }), 403)
  await assertNotCounted(wireSubmit, wireTicket)
  await assertNotCounted(wireSubmit, Buffer.alloc(56))
  assertNoReads(wireArticle)
  checks.earlyAndInvalidTicketsCreateNoAnalytics = true

  const oldTicket = await dwellTicket(await postChallenge(wireChallenge))
  const replacement = await publish('Read proof replacement', wireArticle)
  assert.notEqual(replacement.publication, wireArticle.publication)
  await refusal(await postChallenge(wireChallenge), 409)
  const replacementTicket = await dwellTicket(await postChallenge(wirePath(replacement, 'challenge')))

  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  const faults = [], analyticsRequests = []
  page.on('pageerror', error => faults.push(error.message))
  page.on('request', req => {
    const target = new URL(req.url())
    if (target.origin === origin && /\/read\/(challenge|submit)\.aeds$/.test(target.pathname)) analyticsRequests.push(target.pathname)
  })
  const main = await page.goto(origin)
  assert(main?.ok())
  const tls = await secureLoginProtocol(page, main)
  const entry = exactLink(page, browserArticle.title)
  await expect(entry).toBeVisible()
  assert.deepEqual(analyticsRequests, [])
  checks.siteHomeCreatesNoReadRequests = true
  const liveChallenge = wirePath(browserArticle, 'challenge'), liveSubmit = wirePath(browserArticle, 'submit')
  const isPost = (path, response) => response.url() === origin + path && response.request().method() === 'POST'
  await page.addStyleTag({ content: '[data-fsus-article-read-body] { margin-top: 140vh; }' })
  await entry.click()
  await page.waitForURL(origin + `/article/${browserArticle.id}`)
  const articleHeading = exactHeading(page, browserArticle.title)
  await expect(articleHeading).toBeVisible()
  const readingBody = page.locator('[data-fsus-article-read-body]')
  await expect(readingBody).not.toBeInViewport()
  await delay(minimumDwell)
  assert.deepEqual(analyticsRequests, [])
  assertNoReads(browserArticle)
  checks.offscreenBodyCreatesNoReadRequests = true
  const began = new Date()
  const [challenge, receipt] = await Promise.all([
    page.waitForResponse(response => isPost(liveChallenge, response), { timeout: 20_000 }),
    page.waitForResponse(response => isPost(liveSubmit, response), { timeout: 25_000 }),
    readingBody.scrollIntoViewIfNeeded(),
  ])
  assert.equal(page.url(), origin + `/article/${browserArticle.id}`)
  await expect(articleHeading).toBeVisible()
  const ticket = await dwellTicket(challenge)
  await counted(receipt, true)
  assert.deepEqual(analyticsRequests, [liveChallenge, liveSubmit])
  const challengeBytes = challenge.request().postDataBuffer()
  assert(challengeBytes)
  assert.equal(decodeFrame(challengeBytes, challengeRequest).payload.length, 0)
  const submitted = receipt.request(), headers = await submitted.allHeaders()
  assert.equal(headers.origin, origin)
  assert.equal(headers['sec-fetch-site'], 'same-origin')
  assert.equal(headers['sec-fetch-dest'], 'empty')
  assert(['cors', 'same-origin'].includes(headers['sec-fetch-mode']))
  assert.equal(headers.cookie, undefined)
  assert.equal(headers[WireHeaders.PowProof.toLowerCase()], undefined)
  assert.equal(receipt.headers()['set-cookie'], undefined)
  const bytes = submitted.postDataBuffer()
  assert(bytes)
  const sentPayload = Buffer.from(decodeFrame(bytes, submitRequest).payload)
  assert.equal(sentPayload.length, 60)
  assert(sentPayload.readInt32LE(0) >= minimumDwell)
  assert(sentPayload.subarray(4).equals(ticket), 'Submit used a different ticket than the challenge.')
  assert(submitted.timing().startTime - challenge.request().timing().startTime >= minimumDwell - 100)
  const finished = new Date()
  const { hours, dwell, epochs } = readAggregates(browserArticle)
  assert.equal(hours.length, 1)
  assert.equal(hours[0].count, 1)
  assert([began, finished].some(time => hours[0].utc === time.toISOString().slice(0, 13) + ':00:00Z'))
  assert.equal(dwell.length, 1)
  assert.equal(dwell[0].count, 1)
  assert([began, finished].some(time => dwell[0].day === time.toISOString().slice(0, 10)))
  assert(Number.isInteger(dwell[0].bucket) && dwell[0].bucket >= 0 && dwell[0].bucket <= 3)
  assert.match(epochs[0], /^[0-9]+$/)
  checks.visibleBrowserCommitsOnceAfterDwell = { tls, hours, dwell }

  const replay = await page.evaluate(async ({ path, data }) => {
    const response = await fetch(path, {
      method: 'POST', mode: 'same-origin', credentials: 'omit', signal: AbortSignal.timeout(7_000),
      headers: { 'Content-Type': 'application/octet-stream' }, body: Uint8Array.from(data),
    })
    return { status: response.status, cache: response.headers.get('cache-control'), body: [...new Uint8Array(await response.arrayBuffer())] }
  }, { path: liveSubmit, data: [...bytes] })
  assert.equal(replay.status, 200)
  assert.equal(replay.cache, 'no-store')
  assert.deepEqual([...decodeFrame(Uint8Array.from(replay.body), submitResponse).payload], [0])
  assert.deepEqual(readAggregates(browserArticle), { hours, dwell, epochs })
  await assertNotCounted(wireSubmit, oldTicket)
  await command(WireRoutes.Retract, replacement.id, replacement.revision)
  assertStatus(await reader.get(articlePath(replacement)), 404)
  await assertNotCounted(wirePath(replacement, 'submit'), replacementTicket)
  assertNoReads(wireArticle)
  checks.replayStaleAndWithdrawnPublicationsCreateNoAnalytics = true

  assert.equal(runPsql(`
      SELECT c.relpersistence::text = 't' AND n.nspname LIKE 'pg_temp_%'
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='article_read_seen';`), 't')
  const dump = execFileSync(pgDump, ['-w', '--no-owner', '--no-privileges', '--dbname', database], { encoding: 'utf8', timeout: 10_000 })
  assert(dump.includes('COPY public.article_read_hour') && dump.includes('COPY public.article_read_dwell'))
  assert(!dump.includes('article_read_seen') && !dump.includes(logProbeAgent), 'Logical backup retained transient data.')
  for (const name of ['server.log', 'caddy.log']) assert(!(await readFile(join(evidence, name), 'utf8')).includes(logProbeAgent), 'The deployment logged a synthetic analytics UA.')
  checks.liveTemporaryRelationExcludedFromLogicalBackup = true
  assert.deepEqual(faults, [])
}, { mkdir: true, newline: true, after: () => reader.dispose() })
