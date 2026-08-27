import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import {
  produceApplicationRuntimeObservation,
  verifyApplicationRuntimeObservation
} from '../../tools/fact-extractors/post-runtime/application-runtime.mjs'
import { sealCurrentRunInput } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { root } from '../../tools/fact-extractors/registry.mjs'

const SOURCE = 'a'.repeat(40)
const WORKTREE = 'b'.repeat(64)
const DIGEST = (character) => character.repeat(64)
const CLAIM_IDS = [
  'api.public-error-codes',
  'content.article-transitions',
  'security.admin-permissions'
]

function sealWithPrefixedDigest(value)
{
  const receipt = structuredClone(value)
  delete receipt.contentDigest
  receipt.contentDigest = `sha256:${digestValue(receipt)}`
  return receipt
}

function exactnessReceipt(claimId, character)
{
  const receipt = {
    schema: 'fsusblog.behavior-doc-exactness-receipt.v1',
    scopeId: `fixture-${claimId}`,
    source: { commit: SOURCE, worktreeFingerprint: WORKTREE },
    rows: [{ claimId }],
    counts: { warnings: 0 },
    status: 'ok',
    failureReasons: [],
    contentDigest: null
  }
  receipt.contentDigest = digestValue(receipt)
  return receipt
}

function preRuntimeReceipt()
{
  return sealWithPrefixedDigest({
    schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1',
    scope: 'pre-runtime',
    sourceIdentity: { commit: SOURCE, worktreeFingerprint: WORKTREE },
    behaviorIds: ['browserless-production-correctness'],
    runtimeCandidateSpawnCountBeforeReceipt: 0,
    status: 'ok',
    failureReasons: []
  })
}

function identities()
{
  return {
    artifactId: 'application-production',
    artifactDigest: DIGEST('c'),
    buildId: 'build-application-1',
    buildReceiptDigest: DIGEST('d'),
    candidateId: 'candidate-application-1',
    fixtureId: 'fixture-public-content-1',
    profileId: 'production',
    runId: 'run-application-1',
    attemptId: 'attempt-1',
    runtimeId: 'runtime-application-1',
    toolchainDigest: DIGEST('e'),
    browserId: 'chromium-contract-1'
  }
}

const factMap = Object.freeze({
  'route-response-error-semantics': {
    statusCode: 200,
    typedResult: 'payload',
    protocolIdentity: 'aeds-v2',
    contentIdentity: 'article-revision-7',
    authSemantics: 'anonymous-public',
    permissionSemantics: 'public-read',
    visibilitySemantics: 'published-visible',
    cacheSemantics: 'revision-7-generation-4',
    semanticMatch: true
  },
  'aot-hydration-coherence': {
    buildDigest: DIGEST('1'), manifestDigest: DIGEST('2'), publicationDigest: DIGEST('3'),
    localeCanaryDigest: DIGEST('4'), dataCanaryDigest: DIGEST('5'), serverHtmlDigest: DIGEST('6'),
    hydratedDomDigest: DIGEST('7'), clientStateDigest: DIGEST('8'), networkResourceDigest: DIGEST('9'),
    coherent: true
  },
  'cache-search-outbox-convergence': {
    authorityCoordinateDigest: DIGEST('1'), eventDigest: DIGEST('2'), edgeDigest: DIGEST('3'),
    generationDigest: DIGEST('4'), queryDigest: DIGEST('5'), readModelDigest: DIGEST('6'),
    outputDigest: DIGEST('7'), terminalReceiptDigest: DIGEST('8'), terminalState: 'converged', coherent: true
  },
  'session-cookie-runtime-coherence': {
    databaseSessionDigest: DIGEST('1'), credentialDigest: DIGEST('2'), authContextDigest: DIGEST('3'),
    jwtDigest: DIGEST('4'), cookieDigest: DIGEST('5'), storageClaimsDigest: DIGEST('6'),
    expiryDigest: DIGEST('7'), revisionDigest: DIGEST('8'), deviceDigest: DIGEST('9'),
    serviceResultDigest: DIGEST('a'), coherent: true
  },
  'browser-behavior-contract': {
    requiredTestIds: ['browser-contract:public-article', 'browser-contract:session'],
    viewportId: 'desktop-1440', themeId: 'light', stateId: 'published-authenticated',
    interactionDigest: DIGEST('1'), domDigest: DIGEST('2'), a11yDigest: DIGEST('3'),
    networkDigest: DIGEST('4'), consoleDigest: DIGEST('5'),
    contractSatisfied: true, consoleClean: true, screenshotOnly: false
  }
})

function fixtureInputs()
{
  const claims = CLAIM_IDS.map((claimId, index) => exactnessReceipt(claimId, String(index + 1)))
  const preRuntime = preRuntimeReceipt()
  const identity = identities()
  const plan = sealCurrentRunInput({
    planId: 'application-runtime-plan-1',
    producerId: 'application-runtime-observation-producer',
    sourceCommit: SOURCE,
    worktreeFingerprint: WORKTREE,
    buildIdentity: {
      artifactId: identity.artifactId,
      receiptDigest: identity.buildReceiptDigest,
      artifactDigest: identity.artifactDigest
    },
    identities: identity,
    plannedObservationClasses: Object.keys(factMap),
    requiredOutcomes: ['positive', 'negative', 'boundary', 'failure'],
    claimReceiptDigests: Object.fromEntries(claims.map((receipt) => [receipt.rows[0].claimId, receipt.contentDigest])),
    preRuntimeReceiptDigest: preRuntime.contentDigest
  })
  const rawReceipts = Object.entries(factMap).map(([observationClass, facts]) => sealCurrentRunInput({
    producerId: 'application-runtime-observation-producer',
    observationClass,
    executionClass: 'browser-runtime',
    evidenceClass: 'correctness',
    qualificationEligible: true,
    identity,
    planned: true,
    executed: true,
    outcome: 'passed',
    coveredOutcomes: ['positive', 'negative', 'boundary', 'failure'],
    attemptKind: 'qualification',
    recovered: false,
    facts,
    rawRef: `.tmp/application-runtime/run-application-1/${observationClass}.json`,
    rerunCommand: './tools/test.sh runtime-browser'
  }))
  return { repositoryRoot: root, candidatePlan: plan, rawReceipts, preRuntimeReceipt: preRuntime, claimReceipts: claims }
}

test('application adapter seals exact-one semantic current-candidate observations and verifier replays raw results', () =>
{
  const inputs = fixtureInputs()
  const receipt = produceApplicationRuntimeObservation(inputs)
  assert.equal(receipt.status, 'ok', receipt.failureReasons.join('\n'))
  assert.deepEqual(receipt.observations.observedObservationClasses, Object.keys(factMap).sort())
  assert.deepEqual(verifyApplicationRuntimeObservation({ ...inputs, receipt }), receipt)
})

test('application counterexamples fail closed without becoming qualification evidence', () =>
{
  const cases = [
    ['HTTP200 with old cache payload', (inputs) => { inputs.rawReceipts[0].facts.semanticMatch = false }, /HTTP status alone/u],
    ['AOT file exists with stale manifest/canary', (inputs) => { inputs.rawReceipts[1].facts.coherent = false }, /AOT\/hydration/u],
    ['stale search/outbox edge', (inputs) => { inputs.rawReceipts[2].facts.terminalState = 'partial' }, /stale or partial/u],
    ['DB session and Cookie mismatch', (inputs) => { inputs.rawReceipts[3].facts.coherent = false }, /claims mismatch/u],
    ['diagnostic screenshot only', (inputs) => { inputs.rawReceipts[4].facts.screenshotOnly = true }, /diagnostic screenshot/u],
    ['raw test skipped', (inputs) => { inputs.rawReceipts[0].outcome = 'skipped' }, /not planned, executed, and passed/u],
    ['recovered attempt', (inputs) => { inputs.rawReceipts[0].recovered = true }, /diagnostic\/recovered/u],
    ['another candidate', (inputs) => { inputs.rawReceipts[0].identity = { ...inputs.rawReceipts[0].identity, candidateId: 'other-candidate' } }, /identity does not match/u],
    ['missing observation', (inputs) => { inputs.rawReceipts.pop() }, /exact-one/u],
    ['duplicate observation', (inputs) => { inputs.rawReceipts.push(structuredClone(inputs.rawReceipts[0])) }, /observed 2/u],
    ['unknown result', (inputs) => { inputs.rawReceipts[0].observationClass = 'unknown-runtime-result' }, /unknown observation class/u],
    ['historical fallback', (inputs) => { inputs.rawReceipts[0].rawRef = 'history/latest/route.json' }, /historical\/latest/u],
    ['raw receipt tamper', (inputs) => { inputs.rawReceipts[0].facts.contentIdentity = 'tampered' }, /contentDigest mismatch/u, false]
  ]
  for (const [label, mutate, reasonPattern, reseal = true] of cases)
  {
    const inputs = fixtureInputs()
    mutate(inputs)
    if (reseal) inputs.rawReceipts = inputs.rawReceipts.map((raw) => sealCurrentRunInput(raw))
    const receipt = produceApplicationRuntimeObservation(inputs)
    assert.equal(receipt.status, 'failed', label)
    assert.ok(receipt.failureReasons.some((reason) => reasonPattern.test(reason)), `${label}: ${receipt.failureReasons.join('; ')}`)
  }
})

test('application verifier rejects observation receipt tamper and claim/pre-runtime identity drift', () =>
{
  const inputs = fixtureInputs()
  const receipt = produceApplicationRuntimeObservation(inputs)
  const tampered = structuredClone(receipt)
  tampered.observations.qualificationStatus = 'qualified-after-edit'
  assert.throws(() => verifyApplicationRuntimeObservation({ ...inputs, receipt: tampered }), /contentDigest mismatch/u)

  const staleClaims = fixtureInputs()
  staleClaims.claimReceipts[0].source.commit = 'f'.repeat(40)
  staleClaims.claimReceipts[0].contentDigest = digestValue({ ...staleClaims.claimReceipts[0], contentDigest: null })
  assert.throws(() => produceApplicationRuntimeObservation(staleClaims), /source identity/u)

  const stalePreRuntime = fixtureInputs()
  stalePreRuntime.preRuntimeReceipt.sourceIdentity.commit = 'f'.repeat(40)
  stalePreRuntime.preRuntimeReceipt = sealWithPrefixedDigest(stalePreRuntime.preRuntimeReceipt)
  assert.throws(() => produceApplicationRuntimeObservation(stalePreRuntime), /digest does not match candidatePlan|source identity/u)
})

test('independent verifier rereads only the explicit current-run JSON inputs and detects raw-file tamper', (context) =>
{
  mkdirSync(path.join(root, '.tmp'), { recursive: true })
  const directory = mkdtempSync(path.join(root, '.tmp', 'application-observation-explicit-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const relative = (name) => path.relative(root, path.join(directory, name)).replaceAll(path.sep, '/')
  const write = (name, value) => writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
  const inputs = fixtureInputs()

  inputs.rawReceipts = inputs.rawReceipts.map((raw, index) =>
  {
    const name = `raw-${index}.json`
    const sealed = sealCurrentRunInput({ ...raw, rawRef: relative(name) })
    write(name, sealed)
    return relative(name)
  })
  write('plan.json', inputs.candidatePlan)
  write('pre-runtime.json', inputs.preRuntimeReceipt)
  inputs.claimReceipts.forEach((receipt, index) => write(`claim-${index}.json`, receipt))
  const pathInputs = {
    repositoryRoot: root,
    candidatePlan: relative('plan.json'),
    preRuntimeReceipt: relative('pre-runtime.json'),
    claimReceipts: inputs.claimReceipts.map((_, index) => relative(`claim-${index}.json`)),
    rawReceipts: inputs.rawReceipts
  }
  const receipt = produceApplicationRuntimeObservation(pathInputs)
  write('receipt.json', receipt)
  assert.equal(verifyApplicationRuntimeObservation({ ...pathInputs, receipt: relative('receipt.json') }).status, 'ok')

  const rawFile = path.join(root, inputs.rawReceipts[0])
  const tampered = JSON.parse(readFileSync(rawFile, 'utf8'))
  tampered.facts.contentIdentity = 'tampered-after-produce'
  writeFileSync(rawFile, `${JSON.stringify(tampered, null, 2)}\n`)
  assert.throws(
    () => verifyApplicationRuntimeObservation({ ...pathInputs, receipt: relative('receipt.json') }),
    /contentDigest mismatch|does not exact-match/u
  )
})
