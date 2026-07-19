import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertPublicManifest,
  buildArticleCanonicalPackage,
  canonicalizationVersion,
  canonicalizeMarkdown,
  canonicalizeRenderedHtml,
  evaluateProductionDefault,
  mutationEvidence,
  stableJson,
  verifyArticleCanonicalPackage,
  writeArticleCanonicalPackage
} from '../../tools/content-credentials/content-credential-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixturePath = path.join(root, 'tests/fixtures/content-credentials/article.json')
const fixtureDirectory = path.dirname(fixturePath)
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

test('canonical article package is deterministic and excludes response volatility', () => {
  const reordered = {
    ...fixture,
    renderedHtml: fixture.renderedHtml.replace('<article', '<article nonce="one-time"'),
    markdown: fixture.markdown.replaceAll('\n', '\r\n')
  }
  const first = buildArticleCanonicalPackage(reordered, { fixtureDirectory })
  const second = buildArticleCanonicalPackage({ ...reordered, renderedHtml: reordered.renderedHtml.replace('one-time', 'different') }, { fixtureDirectory })

  assert.equal(canonicalizeMarkdown('正文\r\n'), '正文\n')
  assert.doesNotMatch(canonicalizeRenderedHtml(reordered.renderedHtml), /nonce|阅读 42/u)
  assert.equal(stableJson(first.packageManifest), stableJson(second.packageManifest))
  assert.equal(first.assertion.canonicalization, canonicalizationVersion)
  assert.deepEqual(verifyArticleCanonicalPackage(first), { accepted: true, errors: [] })
  assert.match(first.association, /^<link rel="c2pa-manifest" type="application\/c2pa" href="https:\/\//u)
})

test('article, HTML, metadata and every ingredient are independently bound', () => {
  const articlePackage = buildArticleCanonicalPackage(fixture, { fixtureDirectory })
  assert.match(articlePackage.assertion.digests.markdownSha256, /^[a-f0-9]{64}$/u)
  assert.match(articlePackage.assertion.digests.renderedHtmlSha256, /^[a-f0-9]{64}$/u)
  assert.match(articlePackage.assertion.digests.metadataSha256, /^[a-f0-9]{64}$/u)
  assert.deepEqual(articlePackage.assertion.ingredients.map(item => item.kind), ['cover', 'attachment'])
  assert.ok(articlePackage.assertion.ingredients.every(item => /^[a-f0-9]{64}$/u.test(item.sha256)))

  const cases = mutationEvidence(fixture, { fixtureDirectory })
  assert.deepEqual(cases.map(item => item.case), ['markdown', 'metadata', 'cover', 'ingredient', 'manifest-url'])
  assert.ok(cases.every(item => item.detected))
})

test('manifest association is same-origin, revision-scoped and immutable', () => {
  assert.throws(
    () => buildArticleCanonicalPackage({ ...fixture, manifestUrl: 'https://tracker.example/manifest.c2pa' }, { fixtureDirectory }),
    /same-origin/u
  )
  assert.throws(
    () => buildArticleCanonicalPackage({ ...fixture, manifestUrl: 'https://fsus.blog/credentials/latest.c2pa' }, { fixtureDirectory }),
    /immutable and revision-scoped/u
  )
  assert.throws(
    () => buildArticleCanonicalPackage({ ...fixture, manifestUrl: `${fixture.manifestUrl}?user=1` }, { fixtureDirectory }),
    /query or fragment/u
  )
})

test('public assertion rejects identity, network and private authoring data', () => {
  assert.doesNotThrow(() => assertPublicManifest(buildArticleCanonicalPackage(fixture, { fixtureDirectory }).assertion))
  assert.throws(() => assertPublicManifest({ author_email: 'writer@example.test' }), /private field/u)
  assert.throws(() => assertPublicManifest({ note: 'writer@example.test' }), /email-like/u)
  assert.throws(() => assertPublicManifest({ note: 'client 192.168.1.1' }), /IP-like/u)
  assert.throws(() => assertPublicManifest({ model_prompt: 'private draft' }), /private field/u)
})

test('production-default remains blocked until independent interop and operational evidence pass', () => {
  const base = {
    canonicalization: canonicalizationVersion,
    canonicalizationFrozen: true,
    verifiers: [{ name: 'c2patool', implementationFamily: 'c2pa-rs', status: 'passed' }],
    tamperCases: mutationEvidence(fixture, { fixtureDirectory }),
    staticDownload: true,
    cacheRestore: true,
    redeploy: true,
    noJavaScriptReadable: true,
    keyRotation: true,
    keyRevocation: true,
    privacyReview: true,
    performanceBudget: true
  }
  const blocked = evaluateProductionDefault(base)
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(blocked.reasons, ['two-independent-verifiers-required'])

  const eligible = evaluateProductionDefault({
    ...base,
    verifiers: [
      ...base.verifiers,
      { name: 'independent-validator', implementationFamily: 'independent-stack', status: 'passed' }
    ]
  })
  assert.deepEqual(eligible, {
    schema: 'fsusblog.c2pa-production-decision.v1',
    status: 'eligible',
    productionDefault: true,
    reasons: []
  })
})

test('package writer emits canonical files without requiring a C2PA binary', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-c2pa-package-'))
  try {
    const articlePackage = buildArticleCanonicalPackage(fixture, { fixtureDirectory })
    writeArticleCanonicalPackage(output, articlePackage)
    for (const file of ['canonical/article.md', 'canonical/article.html', 'canonical/metadata.json', 'manifest-definition.json', 'html-association.txt', 'package-manifest.json', 'assets/cover.svg', 'assets/attachment.svg']) {
      assert.equal(fs.statSync(path.join(output, file)).isFile(), true, file)
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})

test('explicit interop command reports unavailable without breaking ordinary checks', () => {
  const script = path.join(root, 'tools/content-credentials/c2pa-prototype.mjs')
  const result = spawnSync(process.execPath, [script, 'interop'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent', C2PATOOL: 'c2patool-not-installed' }
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'unavailable')
  assert.equal(report.productionDefault, false)
})

test('interop policy pins a reproducible offline primary tool and never claims production default', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/content-credentials/c2pa-interop-policy.json'), 'utf8'))
  assert.equal(policy.specification, 'C2PA 2.4')
  assert.equal(policy.primaryTool.version, '0.26.60')
  assert.equal(policy.primaryTool.implementationFamily, 'c2pa-rs')
  assert.match(policy.primaryTool.releaseAssetSha256, /^[a-f0-9]{64}$/u)
  assert.equal(policy.promotionRequirements.independentImplementationFamilies, 2)
  assert.equal(policy.promotionRequirements.offlineOnly, true)
  assert.equal(policy.productionDefault, false)
})
