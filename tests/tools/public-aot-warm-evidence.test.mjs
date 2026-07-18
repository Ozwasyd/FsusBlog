import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createPublicAotWarmEvidence,
  inspectPublicAotResponse,
  isCompletePublicAotSuccess,
  isValidColdFirstResponse,
  validatePublicAotWarmEvidence
} from '../../tools/frontend/public-aot-warm-evidence.mjs'
import { resolvePublicAotSidecarDirectories } from '../../tools/frontend/public-aot-sidecar-paths.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const route = {
  pageId: 'Article',
  kind: 'article',
  routeKey: 'article:42',
  path: '/article/42',
  canonicalPath: '/article/42',
  dependencyKeys: ['article:42', 'seo'],
  priority: 10
}

test('public AOT sidecars prefer explicit overrides then run-bound build roots', () => {
  assert.deepEqual(resolvePublicAotSidecarDirectories({
    repoRoot: '/repo',
    env: {
      FSUSBLOG_BACKEND_WEBROOT: '/run/backend-webroot',
      FSUSBLOG_FRONTEND_DIST_ROOT: '/run/frontend-dist'
    }
  }), {
    sourceDir: '/run/backend-webroot/aot-cache/payloads',
    previewDistDir: '/run/frontend-dist/aot-cache/payloads'
  })

  assert.deepEqual(resolvePublicAotSidecarDirectories({
    repoRoot: '/repo',
    env: {
      FSUSBLOG_BACKEND_WEBROOT: '/run/backend-webroot',
      FSUSBLOG_FRONTEND_DIST_ROOT: '/run/frontend-dist',
      FSUSBLOG_PUBLIC_AOT_SIDECAR_SOURCE_DIR: '/explicit/source',
      FSUSBLOG_PUBLIC_AOT_SIDECAR_DIST_DIR: '/explicit/dist'
    }
  }), {
    sourceDir: '/explicit/source',
    previewDistDir: '/explicit/dist'
  })
})

function completeHtml(canonical = 'https://blog.example.com/article/42') {
  return `<!doctype html><html><head>
    <title>一篇完整文章</title>
    <meta name="description" content="文章摘要">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="一篇完整文章">
    <meta property="og:description" content="文章摘要">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="一篇完整文章">
    <meta name="twitter:description" content="文章摘要">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
  </head><body><main><article>这是冷缓存第一次请求也必须可见的正文。</article></main></body></html>`
}

function successResponse(overrides = {}) {
  const headers = {
    'X-Fsus-Public-Aot-Source': 'server-ssr',
    'X-Fsus-Public-Aot-State': 'fresh',
    'X-Fsus-Public-Aot-Version': 'renderer-v3',
    'X-Fsus-Public-Aot-Frontend-Asset-Version': 'assets-sha256-v7',
    'X-Fsus-Release-Id': 'release-1090',
    'X-Fsus-Release-Slot': 'green',
    ...(overrides.headers || {})
  }
  return inspectPublicAotResponse({
    path: route.path,
    status: overrides.status ?? 200,
    headers,
    html: overrides.html ?? completeHtml(),
    expectedPublicOrigin: 'https://blog.example.com'
  })
}

function retryableResponse() {
  return inspectPublicAotResponse({
    path: route.path,
    status: 503,
    headers: {
      'X-Fsus-Public-Aot-Source': 'server-status',
      'X-Fsus-Public-Aot-State': 'transient-failure',
      'Retry-After': '5',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, follow'
    },
    html: '<!doctype html><meta name="robots" content="noindex"><main>请稍后重试</main>',
    expectedPublicOrigin: 'https://blog.example.com'
  })
}

function validEvidence(first = retryableResponse()) {
  const settled = successResponse()
  return createPublicAotWarmEvidence({
    baseUrl: 'http://127.0.0.1:7568',
    scope: 'all',
    manifest: [route],
    results: [{ ...route, first, settled, ok: true, firstResponseMs: 8, settledMs: 120 }],
    generatedAtUtc: '2026-07-15T01:00:00.000Z',
    expectedPublicOrigin: 'https://blog.example.com'
  })
}

const validationOptions = {
  expectedRelease: 'release-1090',
  expectedSlot: 'green',
  expectedPublicOrigin: 'https://blog.example.com',
  requireScope: 'all',
  now: Date.parse('2026-07-15T01:01:00.000Z')
}

test('complete AOT 200 requires full SEO, main content, and both version identities', () => {
  const response = successResponse()
  assert.equal(isCompletePublicAotSuccess(response), true)
  assert.equal(isValidColdFirstResponse(response), true)
  assert.deepEqual(Object.values(response.checks), Array(8).fill(true))
})

test('cold first 503 is accepted only when retryable, no-store, and noindex', () => {
  const response = retryableResponse()
  assert.equal(response.retryableFailure, true)
  assert.equal(isValidColdFirstResponse(response), true)

  const missingRetry = { ...response, retryAfter: '', retryableFailure: false }
  assert.equal(isValidColdFirstResponse(missingRetry), false)
})

test('generic SPA 200 and explicit 404 are never valid cold first responses', () => {
  const spa = successResponse({
    headers: {
      'X-Fsus-Public-Aot-Source': 'spa-index',
      'X-Fsus-Public-Aot-State': 'fallback'
    },
    html: '<!doctype html><html><head><title>Loading</title></head><body><main id="app"></main></body></html>'
  })
  const notFound = successResponse({ status: 404 })
  assert.equal(isValidColdFirstResponse(spa), false)
  assert.equal(isValidColdFirstResponse(notFound), false)
})

test('whole-manifest evidence validates route coverage, release, slot, and canonical origin', () => {
  assert.deepEqual(validatePublicAotWarmEvidence(validEvidence(), validationOptions), [])
})

test('evidence gate fails closed for stale, digest, coverage, asset, and canonical mismatches', () => {
  const stale = validEvidence()
  stale.generatedAtUtc = '2026-07-14T00:00:00.000Z'
  assert.match(validatePublicAotWarmEvidence(stale, validationOptions).join(';'), /stale/u)

  const badDigest = validEvidence()
  badDigest.manifestDigest = 'not-the-manifest-digest'
  assert.match(validatePublicAotWarmEvidence(badDigest, validationOptions).join(';'), /digest mismatch/u)

  const missingRoute = validEvidence()
  missingRoute.routes = []
  assert.match(validatePublicAotWarmEvidence(missingRoute, validationOptions).join(';'), /coverage is incomplete/u)

  const oldAsset = validEvidence()
  oldAsset.routes[0].settled.frontendAssetVersion = 'old-assets'
  assert.match(validatePublicAotWarmEvidence(oldAsset, validationOptions).join(';'), /asset version summary does not match/u)

  const wrongCanonical = validEvidence()
  wrongCanonical.routes[0].settled.canonicalUrl = 'https://wrong.example.com/article/42'
  assert.match(validatePublicAotWarmEvidence(wrongCanonical, validationOptions).join(';'), /canonical origin mismatch/u)
})

test('rollout warms and verifies all public routes before gateway switch', () => {
  const source = fs.readFileSync(path.join(root, 'tools/deployment/release-rollout.sh'), 'utf8')
  const candidateIndex = source.indexOf('StageCandidateSmoke()')
  const warmIndex = source.indexOf('warm-public-aot-cache.mjs', candidateIndex)
  const verifyIndex = source.indexOf('VerifyPublicAotWarmEvidence', warmIndex)
  const switchIndex = source.indexOf('StageGatewaySwitch()')
  assert.ok(candidateIndex >= 0)
  assert.ok(warmIndex >= 0)
  assert.ok(verifyIndex > warmIndex)
  assert.ok(switchIndex > verifyIndex)
  assert.match(source, /--scope all --fail-fast/u)
  assert.match(source, /StageGatewaySwitch\(\) \{\s+VerifyPublicAotWarmEvidence/u)
  assert.match(source, /publicAotWarm=\$EVIDENCE_DIR\/public-aot-warm\.json/u)
})

test('standalone evidence verifier accepts current evidence and rejects digest drift', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-public-aot-warm-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const report = path.join(directory, 'public-aot-warm.json')
  const verifier = path.join(root, 'tools/frontend/verify-public-aot-warm-evidence.mjs')
  const evidence = validEvidence()
  evidence.generatedAtUtc = new Date().toISOString()
  fs.writeFileSync(report, `${JSON.stringify(evidence)}\n`)
  const args = [
    verifier,
    '--report', report,
    '--expected-release', 'release-1090',
    '--expected-slot', 'green',
    '--expected-public-origin', 'https://blog.example.com',
    '--require-scope', 'all',
    '--max-age-seconds', '900'
  ]

  const accepted = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)

  evidence.manifestDigest = 'drifted'
  fs.writeFileSync(report, `${JSON.stringify(evidence)}\n`)
  const rejected = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /manifest digest mismatch/u)
})
