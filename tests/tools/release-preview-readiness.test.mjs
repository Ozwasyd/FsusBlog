import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { digestDeclaredOutputs } from '../../tools/test-matrix/local-profile.mjs'
import {
  canonicalizeReleasePreviewHtml,
  publishReleasePreviewReady,
  releasePreviewHtmlCanonicalization,
  releasePreviewReadySchema,
  validateFrontendBuildReady,
  validateReleasePreviewReady
} from '../../tools/ux/release-preview-readiness.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bootstrapSource = fs.readFileSync(path.join(repositoryRoot, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
const viteConfigSource = fs.readFileSync(path.join(repositoryRoot, 'src/frontend/vite.config.ts'), 'utf8')

function createBuildFixture(t, runId = 'production-fresh-1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-preview-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const distEntryPath = `.tmp/build/${runId}/frontend/dist/index.html`
  const distEntry = path.join(root, distEntryPath)
  fs.mkdirSync(path.dirname(distEntry), { recursive: true })
  fs.writeFileSync(distEntry, '<!doctype html>\n<html><body><script src="/assets/app-current.js"></script></body></html>\n')
  const digest = digestDeclaredOutputs(root, [distEntryPath])[distEntryPath]
  const markerFile = path.join(root, '.tmp/test-runs', runId, 'frontend-build-ready.json')
  fs.mkdirSync(path.dirname(markerFile), { recursive: true })
  fs.writeFileSync(markerFile, `${JSON.stringify({
    schema: 'fsusblog.local-production.frontend-build-ready.v1',
    status: 'success',
    physicalBundleId: 'build-static',
    producerStepId: 'sync-static-assets',
    schedulerRunId: runId,
    distEntry: { path: distEntryPath, digest }
  }, null, 2)}\n`)
  return { root, runId, distEntry, markerFile, digest }
}

async function listen(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

test('run-bound frontend build validation checks schema, bundle, run, path, and digest', t => {
  const fixture = createBuildFixture(t)
  const verified = validateFrontendBuildReady(fixture)
  assert.equal(verified.schedulerRunId, fixture.runId)
  assert.equal(verified.distDigest, fixture.digest)

  fs.appendFileSync(fixture.distEntry, '<!-- stale mutation -->\n')
  assert.throws(
    () => validateFrontendBuildReady(fixture),
    /dist digest does not match current/u
  )

  fs.writeFileSync(fixture.distEntry, '<!doctype html>\n')
  const marker = JSON.parse(fs.readFileSync(fixture.markerFile, 'utf8'))
  marker.distEntry.digest = digestDeclaredOutputs(fixture.root, [marker.distEntry.path])[marker.distEntry.path]
  marker.physicalBundleId = 'runtime-browser'
  fs.writeFileSync(fixture.markerFile, JSON.stringify(marker))
  assert.throws(
    () => validateFrontendBuildReady(fixture),
    /not bound to current build-static run/u
  )
})

test('preview readiness proves normalized served HTML and preview-origin API namespace binding', async t => {
  const fixture = createBuildFixture(t)
  const apiBody = Buffer.from('AEDS-current-namespace')
  const backendUrl = await listen(t, (request, response) => {
    assert.equal(request.url, '/api/binary/system/seo')
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(apiBody)
  })
  const previewUrl = await listen(t, (request, response) => {
    if (request.url.startsWith('/?fsus-preview-proof=')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('\uFEFF<!doctype html>\r\n<html><body><script src="/assets/app-current.js"></script></body></html>  \r\n')
      return
    }
    assert.equal(request.url, '/api/binary/system/seo')
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(apiBody)
  })

  const { marker, markerFile } = await publishReleasePreviewReady({
    ...fixture,
    namespace: 'production-fresh-runtime-browser',
    previewUrl,
    backendUrl,
    generatedAt: '2026-07-12T00:00:00.000Z'
  })

  assert.equal(marker.schema, releasePreviewReadySchema)
  assert.equal(marker.status, 'ready')
  assert.equal(marker.schedulerRunId, fixture.runId)
  assert.equal(marker.distEntry.digest, fixture.digest)
  assert.equal(marker.servedIndex.sourceDigestMatch, true)
  assert.equal(marker.servedIndex.canonicalization, releasePreviewHtmlCanonicalization)
  assert.equal(marker.apiProbe.status, 200)
  assert.equal(marker.apiProbe.namespaceBound, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, 'utf8')), marker)
  assert.deepEqual(
    canonicalizeReleasePreviewHtml(fs.readFileSync(fixture.distEntry)),
    canonicalizeReleasePreviewHtml(Buffer.from('\uFEFF<!doctype html>\r\n<html><body><script src="/assets/app-current.js"></script></body></html>  \r\n'))
  )
  assert.deepEqual(
    fs.readdirSync(path.dirname(markerFile)).filter(name => name.includes('.next-')),
    []
  )

  const validated = validateReleasePreviewReady({
    root: fixture.root,
    runId: fixture.runId,
    previewUrl
  })
  assert.equal(validated.markerFile, markerFile)
  assert.equal(validated.backendUrl, backendUrl)

  fs.appendFileSync(fixture.distEntry, '<!-- changed after readiness -->\n')
  assert.throws(
    () => validateReleasePreviewReady({ root: fixture.root, runId: fixture.runId, previewUrl }),
    /dist digest changed after readiness/u
  )
})

test('preview readiness refuses old HTML or an API response from another backend', async t => {
  const fixture = createBuildFixture(t)
  let previewApiBody = Buffer.from('AEDS-wrong-namespace')
  let serveOldHtml = true
  const backendUrl = await listen(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end('AEDS-current-namespace')
  })
  const previewUrl = await listen(t, (request, response) => {
    if (request.url.startsWith('/?fsus-preview-proof=')) {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(serveOldHtml ? '<!doctype html><script src="/assets/app-old.js"></script>' : fs.readFileSync(fixture.distEntry))
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(previewApiBody)
  })

  await assert.rejects(
    publishReleasePreviewReady({ ...fixture, namespace: 'production-fresh', previewUrl, backendUrl }),
    /served index is not derived/u
  )

  serveOldHtml = false
  await assert.rejects(
    publishReleasePreviewReady({ ...fixture, namespace: 'production-fresh', previewUrl, backendUrl }),
    /does not match the current namespace backend/u
  )

  previewApiBody = Buffer.from('AEDS-current-namespace')
  const result = await publishReleasePreviewReady({ ...fixture, namespace: 'production-fresh', previewUrl, backendUrl })
  assert.equal(result.marker.apiProbe.namespaceBound, true)
})

test('bootstrap validates the build marker before reuse/start and publishes only after preview API readiness', () => {
  const ensureStart = bootstrapSource.indexOf('ensure_release_preview()')
  const validate = bootstrapSource.indexOf('release-preview-readiness.mjs" validate-build', ensureStart)
  const reuse = bootstrapSource.indexOf('release preview already healthy with matching fingerprint', ensureStart)
  const start = bootstrapSource.indexOf("'release preview' \\", ensureStart)
  const apiReady = bootstrapSource.indexOf("wait_for_binary_url 'release preview namespace API'", start)
  const publish = bootstrapSource.indexOf('release-preview-readiness.mjs" publish-ready', apiReady)

  assert.ok(validate > ensureStart)
  assert.ok(validate < reuse)
  assert.ok(validate < start)
  assert.ok(apiReady > start)
  assert.ok(publish > apiReady)
  assert.match(bootstrapSource, /rm -f "\$ROOT_DIR\/\.tmp\/test-runs\/\$FSUSBLOG_TEST_RUN_ID\/release-preview-ready\.json"/u)
  assert.match(
    bootstrapSource.slice(start, apiReady),
    /VITE_API_BASE_URL="\$DEBUG_BACKEND_URL" VITE_PUBLIC_SHELL_PROXY=1[\s\\]*npm exec -- vite preview/u
  )
  assert.match(viteConfigSource, /const releasePreviewApplicationProxy:[\s\S]*?SSR nonce, redirects, real 404s, and integrity APIs/u)
  assert.match(viteConfigSource, /publicSeoProxy:[\s\S]*?searchParams\.has\('fsus-preview-proof'\)[\s\S]*?return '\/index\.html'/u)
  assert.match(viteConfigSource, /const sharedApiProxy:[\s\S]*?'\^\/integrity\(\?:\/\|\$\)': publicSeoProxy/u)
  assert.match(viteConfigSource, /preview:[\s\S]*?\.\.\.sharedApiProxy,[\s\S]*?\.\.\.publicRouteProxy,[\s\S]*?\.\.\.releasePreviewApplicationProxy/u)
  assert.match(viteConfigSource, /build:\s*\{[\s\S]*?modulePreload:\s*false/u)
})

test('bootstrap does not publish resident readiness until the post-fixture public home is ready', () => {
  const mainStart = bootstrapSource.indexOf('main() {')
  const mainSource = bootstrapSource.slice(mainStart)
  const fixtures = mainSource.indexOf('prepare_fixtures')
  const publicHome = mainSource.indexOf("'release preview public home after fixture seeding'", fixtures)
  const residentLease = mainSource.indexOf('resident-resource-leases-cli.mjs" publish', publicHome)

  assert.ok(mainStart >= 0)
  assert.ok(fixtures >= 0)
  assert.ok(publicHome > fixtures)
  assert.ok(residentLease > publicHome)
})
