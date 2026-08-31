import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'
import {
  currentRegistryBinding,
  produceClassReceipt,
  seal
} from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  produceAotSpaHydrationSourceBundle,
  projectAotSpaHydrationRaw,
  verifyAotSpaHydrationRaw
} from '../../tools/test-evidence/aot-spa-hydration-raw.mjs'
import { loadPostRuntimeProducerRegistry, root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const commit = 'a'.repeat(40)
const fingerprint = `sha256:${'b'.repeat(64)}`
const runId = 'run-aot-current-1'
const attemptId = 'attempt-1'
const releaseId = 'release-aot-current-1'

function fixture(context)
{
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'aot-spa-hydration-raw-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/')
  const write = (name, value) => {
    const file = path.join(directory, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
    return relative(file)
  }

  const inputRoot = path.join(directory, 'source')
  const artifactRoot = path.join(directory, 'build')
  fs.mkdirSync(path.join(inputRoot, 'inputs'), { recursive: true })
  fs.mkdirSync(path.join(artifactRoot, 'frontend-dist', '.vite'), { recursive: true })
  fs.writeFileSync(path.join(inputRoot, 'inputs', 'source.json'), '{}')
  fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', '.vite', 'manifest.json'), '{"entry":{"file":"assets/app.js"}}')
  const build = createProductionBuildReceipt({
    root: inputRoot, artifactRoot,
    sourceState: { commit, worktreeFingerprint: fingerprint },
    producer: { workflow: 'focused', runId, runAttempt: 1, job: 'production-build-artifacts' },
    toolchain: { node: '24', npm: '11', dotnet: '10', vite: '7', vitest: '3', playwright: '1', emsdk: '4' },
    inputPaths: ['inputs'], domains: [{ name: 'frontend-dist', path: 'frontend-dist' }]
  })
  const buildPath = relative(path.join(artifactRoot, 'receipt.json'))
  const manifestArtifact = build.artifacts.find(({ path: artifactPath }) => artifactPath.endsWith('/.vite/manifest.json'))
  const descriptor = seal({
    schema: 'fsusblog.spa-manifest-descriptor.v1', releaseId,
    sourceCommit: commit, worktreeFingerprint: fingerprint,
    buildReceiptDigest: build.contentDigest,
    assetRoot: `/app/release-assets/${releaseId}`,
    manifestPath: `/app/release-assets/${releaseId}/.vite/manifest.json`,
    manifestDigest: manifestArtifact.sha256,
    assetInventoryDigest: `sha256:${'c'.repeat(64)}`
  })
  const manifestPath = write('manifest.json', descriptor)

  const registry = loadPostRuntimeProducerRegistry(root)
  const producer = registry.producers[0]
  const rawOutput = relative(path.join(directory, 'aot-spa-hydration.json'))
  const observations = Object.entries(registry.observationClasses)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([classId, definition]) => ({
      classId, schema: definition.schema,
      receiptPath: classId === 'aot-spa-hydration' ? rawOutput : relative(path.join(directory, `${classId}.json`)),
      requiredModes: Object.entries(producer.requiredObservations)
        .filter(([, classes]) => classes.includes(classId)).map(([mode]) => mode).sort()
    }))
  const plan = seal({
    schema: 'fsusblog.post-runtime-candidate-plan.v1', producerId: producer.producerId,
    registryBinding: currentRegistryBinding(root),
    sourceState: { commit, worktreeFingerprint: fingerprint },
    build: { receipt: buildPath, receiptContentDigest: build.contentDigest, sourceState: build.sourceState },
    candidate: {
      candidateId: 'candidate-aot-current-1', runId, attemptId, fixtureId: 'fixture-aot-current-1',
      profileId: 'production-fresh', runtimeId: 'runtime-aot-current-1', browserId: 'browser-aot-current-1',
      releaseId, rolloutId: 'rollout-aot-current-1'
    },
    preRuntimeReceiptDigest: `sha256:${'d'.repeat(64)}`,
    acceptedClaimsReceiptDigest: `sha256:${'e'.repeat(64)}`,
    observations, status: 'planned'
  })
  const planPath = write('candidate-plan.json', plan)
  const sourceState = {
    sourceCommit: commit, worktreeFingerprint: fingerprint, buildIdentity: build.contentDigest, runId, attemptId
  }
  const evidenceDocument = (schema, facts) => ({ schema, status: 'passed', sourceState, facts })
  const evidence = {
    manifest: manifestPath,
    publication: write('publication.json', evidenceDocument('fsusblog.aot-publication-evidence.v1', {
      route: '/article/42', statusCode: 200, contentType: 'text/html', published: true, releaseId
    })),
    locale: write('locale.json', evidenceDocument('fsusblog.aot-locale-canary.v1', {
      expectedLocale: 'zh-CN', serverLocale: 'zh-CN', clientLocale: 'zh-CN', matches: true
    })),
    data: write('data.json', evidenceDocument('fsusblog.aot-data-canary.v1', {
      route: '/article/42', hydrationKind: 'ArticleDetail',
      serverDigest: `sha256:${'f'.repeat(64)}`, clientDigest: `sha256:${'f'.repeat(64)}`, matches: true
    })),
    serverHtml: write('server.html', '<!doctype html><html lang="zh-CN"><head><link href="https://example.test/article/42" rel="canonical"><script type="application/json" data-fsus-seo-head-model>{}</script></head><body><div id="app"><div id="fsus-aot-shell" data-public-hydration-kind="ArticleDetail"></div></div></body></html>'),
    hydratedDom: write('hydrated-dom.json', evidenceDocument('fsusblog.aot-hydrated-dom-evidence.v1', {
      route: '/article/42', hydrationKind: 'ArticleDetail', appCount: 1, shellCount: 1,
      hydrated: true, identityPreserved: true
    })),
    client: write('client.json', evidenceDocument('fsusblog.aot-client-state-evidence.v1', {
      route: '/article/42', ready: true, historyCoherent: true, hydrationMetricsPresent: true
    })),
    network: write('network.json', evidenceDocument('fsusblog.aot-network-resource-evidence.v1', {
      documentStatus: 200, failedRequests: [], manifestResourcesMatched: true
    }))
  }
  const sourceBundle = produceAotSpaHydrationSourceBundle({ candidatePlan: planPath, evidence, repositoryRoot: root })
  const sourceBundlePath = write('aot-source-bundle.json', sourceBundle)
  return { planPath, rawOutput, evidence, sourceBundlePath, build, buildPath }
}

test('projects and independently reopens the exact current-run evidence set', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.planPath, sourceReceipt: value.sourceBundlePath, repositoryRoot: root })
  fs.writeFileSync(path.join(root, value.rawOutput), `${JSON.stringify(receipt)}\n`)
  const verified = verifyAotSpaHydrationRaw(value.rawOutput, root)
  assert.equal(verified.schema, 'fsusblog.observation.aot-spa-hydration.v1')
  assert.equal(verified.sourceState.buildIdentity, value.build.contentDigest)
  assert.equal(verified.sourceState.artifactDigest, verified.semanticFacts.manifestDigest)
  assert.deepEqual(verified.modes, ['boundary'])
  assert.equal(verified.semanticFacts.coherent, true)
  assert.equal(produceClassReceipt({
    candidatePlan: value.planPath,
    classId: 'aot-spa-hydration',
    result: value.rawOutput,
    repositoryRoot: root
  }).status, 'qualified')
})

test('rejects a server/client route mismatch before qualification', (context) =>
{
  const value = fixture(context)
  const file = path.join(root, value.evidence.client)
  const evidence = JSON.parse(fs.readFileSync(file, 'utf8'))
  evidence.facts.route = '/archive'
  fs.writeFileSync(file, `${JSON.stringify(evidence)}\n`)
  const sourceBundle = produceAotSpaHydrationSourceBundle({ candidatePlan: value.planPath, evidence: value.evidence, repositoryRoot: root })
  fs.writeFileSync(path.join(root, value.sourceBundlePath), `${JSON.stringify(sourceBundle)}\n`)
  assert.throws(() => projectAotSpaHydrationRaw({
    candidatePlan: value.planPath, sourceReceipt: value.sourceBundlePath, repositoryRoot: root
  }), /identities are not coherent/u)
})

test('rejects cross-candidate evidence identities', (context) =>
{
  const value = fixture(context)
  const file = path.join(root, value.evidence.locale)
  const evidence = JSON.parse(fs.readFileSync(file, 'utf8'))
  evidence.sourceState.runId = 'stale-run'
  fs.writeFileSync(file, `${JSON.stringify(evidence)}\n`)
  const sourceBundle = produceAotSpaHydrationSourceBundle({ candidatePlan: value.planPath, evidence: value.evidence, repositoryRoot: root })
  fs.writeFileSync(path.join(root, value.sourceBundlePath), `${JSON.stringify(sourceBundle)}\n`)
  assert.throws(() => projectAotSpaHydrationRaw({
    candidatePlan: value.planPath, sourceReceipt: value.sourceBundlePath, repositoryRoot: root
  }), /locale evidence does not exact-match/u)
})

test('verifier rejects evidence bytes changed after projection', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.planPath, sourceReceipt: value.sourceBundlePath, repositoryRoot: root })
  fs.writeFileSync(path.join(root, value.rawOutput), `${JSON.stringify(receipt)}\n`)
  fs.appendFileSync(path.join(root, value.evidence.network), ' ')
  assert.throws(() => verifyAotSpaHydrationRaw(value.rawOutput, root), /network evidence bytes changed/u)
})

test('verifier rejects immutable production manifest drift', (context) =>
{
  const value = fixture(context)
  const receipt = projectAotSpaHydrationRaw({ candidatePlan: value.planPath, sourceReceipt: value.sourceBundlePath, repositoryRoot: root })
  fs.writeFileSync(path.join(root, value.rawOutput), `${JSON.stringify(receipt)}\n`)
  const file = path.join(path.dirname(path.join(root, value.buildPath)), 'frontend-dist', '.vite', 'manifest.json')
  fs.chmodSync(file, 0o644)
  fs.appendFileSync(file, ' ')
  assert.throws(() => verifyAotSpaHydrationRaw(value.rawOutput, root), /artifact (?:size|digest) mismatch/u)
})
