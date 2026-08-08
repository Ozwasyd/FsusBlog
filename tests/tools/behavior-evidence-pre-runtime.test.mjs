import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertPreRuntimeQualified,
  assertRuntimeCandidateAdmissionAllowed,
  joinBehaviorEvidencePreRuntime,
  preRuntimeReceiptSchema,
  root,
  validatePreRuntimeReceipt
} from '../../tools/test-matrix/behavior-evidence-pre-runtime.mjs'
import {
  digestValue,
  sealDocClaimVerificationReceipt,
  sealGeneratedSectionCheckReceipt,
  sealOwnerBindingReceipt
} from '../../tools/contracts/behavior-graph-join.mjs'
import { sealMutationEvidenceReceipt } from '../../tools/test/mutation-evidence-receipt.mjs'
import { buildReceipt, sealReceipt } from '../../tools/fact-extractors/receipt.mjs'
import { loadCanonicalReleaseFinalEvidenceInputs } from '../../tools/test-matrix/release-final-evidence-contract.mjs'

const SOURCE_COMMIT = 'a'.repeat(40)
const WORKTREE_FP = 'b'.repeat(64)
const EXTRACTOR_DIGEST = 'c'.repeat(64)
const REGISTRY_DIGEST = 'd'.repeat(64)
const INPUT_DIGEST = 'e'.repeat(64)

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])])
    )
  }
  return value
}

function digestReceipt(receipt) {
  const content = structuredClone(receipt)
  delete content.contentDigest
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(content)), 'utf8')
    .digest('hex')}`
}

function makeCatalog(overrides = {}) {
  return {
    schema: 'fsusblog.behavior-contract-catalog.v1',
    digestAlgorithm: 'sha256',
    canonicalSerialization: 'json-utf8-v1',
    domains: ['testing'],
    extractors: [
      { id: 'alpha-fact-extractor', path: 'tools/alpha/extract.mjs' },
      { id: 'beta-fact-extractor', path: 'tools/beta/extract.mjs' }
    ],
    contracts: [
      {
        id: 'alpha-behavior',
        domain: 'testing',
        risk: 'high',
        status: 'active',
        implementationOwnerCardinality: 'one',
        allowedImplementationOwnerRoles: [],
        factExtractorId: 'alpha-fact-extractor',
        requiredTestKinds: ['positive', 'boundary'],
        documentationPolicy: 'required',
        documentationRationale: 'Public alpha contract.',
        allowedClaimTypes: ['behavioral'],
        releaseQualification: true,
        evidenceStage: 'pre-runtime',
        coverageIds: ['alpha-behavior'],
        documents: ['docs/alpha.md'],
        mutationPolicy: {
          mutationRequired: true,
          minimumMutationScore: 70,
          requireExecutedMutants: true,
          allowedEquivalentMutantPolicy: 'none'
        }
      },
      {
        id: 'beta-behavior',
        domain: 'documentation',
        risk: 'medium',
        status: 'active',
        implementationOwnerCardinality: 'one',
        allowedImplementationOwnerRoles: [],
        factExtractorId: 'beta-fact-extractor',
        requiredTestKinds: ['positive'],
        documentationPolicy: 'required',
        documentationRationale: 'Public beta contract.',
        allowedClaimTypes: ['behavioral'],
        releaseQualification: true,
        evidenceStage: 'pre-runtime',
        coverageIds: ['beta-behavior'],
        documents: ['docs/beta.md']
      }
    ],
    ...overrides
  }
}

function catalogDigest(catalog) {
  return digestValue(catalog)
}

function makeFact({
  extractorId = 'alpha-fact-extractor',
  behaviorIds = ['alpha-behavior'],
  observations = { limit: 10 },
  status = 'ok',
  sourceCommit = SOURCE_COMMIT,
  worktreeFingerprint = WORKTREE_FP
} = {}) {
  return sealReceipt(buildReceipt({
    extractorId,
    behaviorIds,
    sourceCommit,
    worktreeFingerprint,
    buildIdentity: null,
    extractorDigest: EXTRACTOR_DIGEST,
    registryDigest: REGISTRY_DIGEST,
    consumedInputDigests: [{ path: 'tools/alpha/extract.mjs', digest: INPUT_DIGEST }],
    observations: status === 'ok' ? observations : {},
    status,
    failureReasons: status === 'ok' ? [] : ['extractor failed']
  }))
}

function makeOwner({ catalog, behaviorIds = ['alpha-behavior', 'beta-behavior'], errors = [] } = {}) {
  const digest = catalogDigest(catalog)
  const bindings = behaviorIds.map((id, index) => ({
    behaviorId: id,
    language: 'javascript',
    sourcePath: `tools/${id.split('-')[0]}/extract.mjs`,
    symbol: 'extract',
    bindingKind: 'marker',
    sourceDigest: String(index + 1).repeat(64),
    status: 'ok'
  }))
  return sealOwnerBindingReceipt({
    schema: 'fsusblog.behavior-owner-binding-receipt.v1',
    catalogDigest: digest,
    worktreeDigest: SOURCE_COMMIT,
    status: errors.length === 0 ? 'ok' : 'failed',
    bindingCount: bindings.length,
    bindings: bindings.map((binding) => ({
      ...binding,
      catalogDigest: digest,
      worktreeDigest: SOURCE_COMMIT
    })),
    errors
  })
}

function makeTestEvidence({ catalog, evidence, errors = [] } = {}) {
  const digest = catalogDigest(catalog)
  const rows = evidence ?? []
  const coverage = catalog.contracts
    .filter((contract) => contract.status === 'active')
    .map((contract) => {
      const satisfied = contract.requiredTestKinds.filter((kind) =>
        rows.some((row) =>
          row.behaviorId === contract.id
          && row.testKind === kind
          && row.discovered
          && row.executed
          && row.outcome === 'passed'
        )
      )
      const missing = contract.requiredTestKinds.filter((kind) => !satisfied.includes(kind))
      return {
        behaviorId: contract.id,
        requiredTestKinds: [...contract.requiredTestKinds],
        satisfiedTestKinds: satisfied,
        missingTestKinds: missing,
        status: missing.length === 0 ? 'ok' : 'failed'
      }
    })
  const receipt = {
    schema: 'fsusblog.behavior-test-evidence-receipt.v1',
    catalogDigest: digest,
    worktreeDigest: SOURCE_COMMIT,
    run: { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' },
    sourceState: { commit: SOURCE_COMMIT, worktreeFingerprint: `sha256:${WORKTREE_FP}` },
    sourceClosureDigest: `sha256:${'f'.repeat(64)}`,
    rawResultDigest: `sha256:${'9'.repeat(64)}`,
    bindings: rows.map((row) => ({
      behaviorId: row.behaviorId,
      testKind: row.testKind,
      canonicalTestId: row.canonicalTestId,
      framework: 'node-tap',
      sourcePath: row.sourcePath,
      fullyQualifiedName: row.fullyQualifiedName,
      invariantIds: [],
      reasonId: null,
      concurrencyHarness: null,
      bindingKind: 'helper',
      line: 1
    })),
    evidence: rows,
    coverage,
    errors,
    testPlanDigest: `sha256:${'7'.repeat(64)}`,
    testPlanCommit: SOURCE_COMMIT,
    plannedTestIds: rows.map((row) => row.canonicalTestId).sort(),
    unplannedBoundTestIds: [],
    extraExecutedTestIds: [],
    runtimeCandidateSpawnCountBeforeReceipt: 0,
    producer: {
      command: 'node tools/test-matrix/produce-behavior-test-evidence.mjs',
      schema: 'fsusblog.behavior-test-evidence-receipt.v1'
    },
    contentDigest: null
  }
  receipt.contentDigest = digestReceipt(receipt)
  return receipt
}

function defaultEvidence(catalog) {
  const rows = []
  for (const contract of catalog.contracts.filter((entry) => entry.status === 'active')) {
    for (const kind of contract.requiredTestKinds) {
      rows.push({
        behaviorId: contract.id,
        testKind: kind,
        canonicalTestId: `node-tap:tests/${contract.id}.${kind}.test.mjs#${kind}`,
        framework: 'node-tap',
        sourcePath: `tests/${contract.id}.${kind}.test.mjs`,
        fullyQualifiedName: kind,
        discovered: true,
        executed: true,
        outcome: 'passed',
        invariantIds: [],
        reasonId: null,
        concurrencyHarness: null,
        run: { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' },
        sourceState: { commit: SOURCE_COMMIT, worktreeFingerprint: `sha256:${WORKTREE_FP}` },
        sourceClosureDigest: `sha256:${'f'.repeat(64)}`,
        rawResultDigest: `sha256:${'9'.repeat(64)}`
      })
    }
  }
  return rows
}

function makeParseReceipt({ catalog, claims = [] } = {}) {
  const receipt = {
    schema: 'fsusblog.doc-claim-parse-receipt.v1',
    digestAlgorithm: 'sha256',
    canonicalSerialization: 'json-utf8-v1',
    behaviorCatalogDigest: catalogDigest(catalog),
    claims
  }
  return { ...receipt, contentDigest: digestValue(receipt) }
}

function makeVerification({ catalog, parseReceipt, results = [], status = 'ok', failureReasons = [] } = {}) {
  return sealDocClaimVerificationReceipt({
    sourceCommit: SOURCE_COMMIT,
    worktreeFingerprint: WORKTREE_FP,
    catalogDigest: catalogDigest(catalog),
    parseReceiptDigest: parseReceipt.contentDigest,
    factObservationDigests: [],
    results,
    status,
    failureReasons
  })
}

function makeGenerated({ catalog, sections = [], status = 'ok', failureReasons = [] } = {}) {
  return sealGeneratedSectionCheckReceipt({
    sourceCommit: SOURCE_COMMIT,
    worktreeFingerprint: WORKTREE_FP,
    catalogDigest: catalogDigest(catalog),
    sectionCatalogDigest: '8'.repeat(64),
    factObservationDigests: [],
    sections,
    status,
    failureReasons
  })
}

function makeStaticAdmission({ status = 'ok', candidateSpawnCount = 0, sourceCommit = SOURCE_COMMIT } = {}) {
  const receipt = {
    schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
    run: { id: 'run-1' },
    source: {
      commit: sourceCommit,
      worktreeFingerprint: `sha256:${WORKTREE_FP}`
    },
    status,
    candidateSpawnCountBeforeReceipt: candidateSpawnCount,
    failureReasons: status === 'ok' ? [] : ['admission failure'],
    contentDigest: null
  }
  receipt.contentDigest = digestReceipt(receipt)
  return receipt
}

function makeClaim(behaviorId, claimId, factPath = 'limit', documentPath = `docs/${behaviorId.split('-')[0]}.md`) {
  return {
    declaration: { claimId, behaviorId, claimType: 'scalar', factPath, render: 'scalar-inline' },
    location: {
      documentPath,
      claimStartLine: 1,
      claimEndLine: 4,
      documentStatus: 'current',
      headingPath: ['Section'],
      bodyKind: 'paragraph',
      bodyStartLine: 5,
      bodyEndLine: 5,
      bodyText: `${factPath} is 10`
    }
  }
}

function makeVerificationResult(behaviorId, claimId, factPath = 'limit', documentPath, status = 'verified') {
  return {
    claimId,
    behaviorId,
    claimType: 'scalar',
    documentPath: documentPath ?? `docs/${behaviorId.split('-')[0]}.md`,
    documentStatus: 'current',
    factPath,
    status,
    reason: 'ok'
  }
}

function makeMutationEvidence({ catalog, owner, status = 'ok', qualifications, attributions = [], failureReasons = [] }) {
  return sealMutationEvidenceReceipt({
    sourceCommit: SOURCE_COMMIT,
    worktreeFingerprint: WORKTREE_FP,
    catalogDigest: catalogDigest(catalog),
    selectionDigest: '6'.repeat(64),
    ownerReceiptDigest: owner.contentDigest,
    testBindingScanDigest: '7'.repeat(64),
    rawReportDigest: '8'.repeat(64),
    rawTraceDigest: '9'.repeat(64),
    attributions,
    qualifications,
    blockedCount: status === 'ok' ? 0 : 0,
    status,
    failureReasons,
    runId: 'round-1',
    attemptId: 'attempt-0001',
    scope: 'pr'
  })
}

function happyBundle() {
  const catalog = makeCatalog()
  const owner = makeOwner({ catalog })
  const evidence = defaultEvidence(catalog)
  const testEvidence = makeTestEvidence({ catalog, evidence })
  const claims = [
    makeClaim('alpha-behavior', 'alpha.limit', 'limit', 'docs/alpha.md'),
    makeClaim('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
  ]
  const parseReceipt = makeParseReceipt({ catalog, claims })
  const verification = makeVerification({
    catalog,
    parseReceipt,
    results: [
      makeVerificationResult('alpha-behavior', 'alpha.limit', 'limit', 'docs/alpha.md'),
      makeVerificationResult('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
    ]
  })
  const generated = makeGenerated({ catalog })
  const facts = [
    makeFact({
      extractorId: 'alpha-fact-extractor',
      behaviorIds: ['alpha-behavior'],
      observations: { limit: 10 }
    }),
    makeFact({
      extractorId: 'beta-fact-extractor',
      behaviorIds: ['beta-behavior'],
      observations: { enabled: true }
    })
  ]
  const mutationEvidence = makeMutationEvidence({
    catalog,
    owner,
    attributions: [
      {
        mutantId: 'alpha:1',
        behaviorId: 'alpha-behavior',
        sourcePath: 'tools/alpha/extract.mjs',
        symbol: 'extract',
        mutator: 'Boolean',
        status: 'Killed',
        coveredTestIds: ['a1'],
        killedTestIds: ['a1']
      }
    ],
    qualifications: [
      {
        behaviorId: 'alpha-behavior',
        mutationRequired: true,
        executed: 1,
        killed: 1,
        survived: 0,
        timeout: 0,
        noCoverage: 0,
        compileError: 0,
        requiredMutants: 1,
        recordedMutants: 1,
        score: 100,
        minimumMutationScore: 70,
        qualified: true,
        failures: []
      }
    ],
    status: 'ok',
    failureReasons: []
  })
  const admission = makeStaticAdmission()

  return {
    catalog,
    ownerReceipt: owner,
    testEvidenceReceipt: testEvidence,
    docClaimParseReceipt: parseReceipt,
    docClaimVerificationReceipt: verification,
    generatedSectionCheckReceipt: generated,
    factObservationReceipts: facts,
    mutationEvidenceReceipt: mutationEvidence,
    staticAdmissionReceipt: admission
  }
}

function join(inputs, overrides = {}) {
  return joinBehaviorEvidencePreRuntime({
    catalog: inputs.catalog,
    ownerReceipt: inputs.ownerReceipt,
    testEvidenceReceipts: [inputs.testEvidenceReceipt],
    docClaimParseReceipt: inputs.docClaimParseReceipt,
    docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
    generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
    factObservationReceipts: inputs.factObservationReceipts,
    mutationEvidenceReceipt: inputs.mutationEvidenceReceipt,
    staticAdmissionReceipt: inputs.staticAdmissionReceipt,
    sourceCommit: SOURCE_COMMIT,
    worktreeFingerprint: WORKTREE_FP,
    ...overrides
  })
}

test('gate module forbids producer/parser imports and fallback patterns', () => {
  const source = readFileSync(
    path.join(root, 'tools/test-matrix/behavior-evidence-pre-runtime.mjs'),
    'utf8'
  )
  const importLines = source.split('\n').filter((line) => /^\s*import\b/u.test(line))
  const importSource = importLines.join('\n')
  assert.doesNotMatch(
    importSource,
    /behavior-owner-binding|behavior-test-binding|doc-claim|prose-claim-verifier|generated-fact-sections|fact-extractors|child_process|spawnSync\s*\(|execFileSync\s*\(/u
  )
  assert.doesNotMatch(
    source,
    /warning-only|compatSchema|optionalGate\s*[:=]|defaultPass\s*[:=]|latest.*evidence.*fallback|find.*latest/u
  )
})

test('happy path produces qualified pre-runtime receipt with stable digest', () => {
  const inputs = happyBundle()
  const receipt = join(inputs)
  assert.equal(receipt.schema, preRuntimeReceiptSchema)
  assert.equal(receipt.scope, 'pre-runtime')
  assert.equal(receipt.status, 'ok')
  assert.deepEqual(receipt.failureReasons, [])
  assert.equal(receipt.runtimeCandidateSpawnCountBeforeReceipt, 0)
  assert.ok(receipt.behaviorIds.includes('alpha-behavior'))
  assert.ok(receipt.behaviorIds.includes('beta-behavior'))
  assert.equal(receipt.requiredTestKinds['alpha-behavior'].includes('boundary'), true)
  assert.equal(receipt.observedTestKinds['alpha-behavior'].includes('boundary'), true)
  assert.equal(receipt.mutationStatus['alpha-behavior'].qualified, true)
  validatePreRuntimeReceipt(receipt)
  assertPreRuntimeQualified(receipt)
  assertRuntimeCandidateAdmissionAllowed({
    receipt,
    expectedCommit: SOURCE_COMMIT,
    expectedWorktreeFingerprint: WORKTREE_FP
  })
})

test('counterexample 1: boundary test not executed but file exists fails gate and refuses runtime spawn', () => {
  const inputs = happyBundle()
  const catalog = makeCatalog()
  const evidence = defaultEvidence(catalog).filter(
    (row) => !(row.behaviorId === 'alpha-behavior' && row.testKind === 'boundary')
  )
  const testEvidence = makeTestEvidence({ catalog, evidence })
  const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence })
  assert.equal(receipt.status, 'failed')
  assert.ok(receipt.failureReasons.some((reason) => reason.includes('boundary')))
  assert.throws(
    () => assertRuntimeCandidateAdmissionAllowed({
      receipt,
      expectedCommit: SOURCE_COMMIT,
      expectedWorktreeFingerprint: WORKTREE_FP
    }),
    /runtime candidate admission refused/u
  )
})

test('counterexample 2: survived mutant fails gate even when domain score is high', () => {
  const inputs = happyBundle()
  const mutationEvidence = makeMutationEvidence({
    catalog: inputs.catalog,
    owner: inputs.ownerReceipt,
    attributions: [
      {
        mutantId: 'alpha:1',
        behaviorId: 'alpha-behavior',
        sourcePath: 'tools/alpha/extract.mjs',
        symbol: 'extract',
        mutator: 'Boolean',
        status: 'Survived',
        coveredTestIds: [],
        killedTestIds: []
      }
    ],
    qualifications: [
      {
        behaviorId: 'alpha-behavior',
        mutationRequired: true,
        executed: 1,
        killed: 0,
        survived: 1,
        timeout: 0,
        noCoverage: 0,
        compileError: 0,
        requiredMutants: 1,
        recordedMutants: 1,
        score: 90,
        minimumMutationScore: 70,
        qualified: false,
        failures: ['alpha-behavior has 1 survived mutant(s)']
      }
    ],
    status: 'failed',
    failureReasons: ['alpha-behavior has 1 survived mutant(s)']
  })
  const receipt = join({ ...inputs, mutationEvidenceReceipt: mutationEvidence })
  assert.equal(receipt.status, 'failed')
  assert.ok(receipt.failureReasons.some((reason) =>
    reason.includes('alpha-behavior') && reason.includes('mutation')))
  assert.equal(receipt.mutationStatus['alpha-behavior'].qualified, false)
})

test('counterexample 3: docs-only PR cannot skip required test evidence', () => {
  const inputs = happyBundle()
  const catalog = makeCatalog()
  const evidence = defaultEvidence(catalog).filter(
    (row) => !(row.behaviorId === 'beta-behavior' && row.testKind === 'positive')
  )
  const testEvidence = makeTestEvidence({ catalog, evidence })
  const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence })
  assert.equal(receipt.status, 'failed')
  assert.ok(receipt.failureReasons.some((reason) =>
    reason.includes('beta-behavior') && reason.includes('positive')))
})

test('counterexample 4: default-branch/historical test evidence is refused', () => {
  const inputs = happyBundle()
  const badEvidence = makeTestEvidence({
    catalog: inputs.catalog,
    evidence: defaultEvidence(inputs.catalog)
  })
  badEvidence.sourceState.commit = 'f'.repeat(40)
  badEvidence.contentDigest = digestReceipt(badEvidence)
  assert.throws(
    () => join({ ...inputs, testEvidenceReceipt: badEvidence }),
    /source identity/u
  )
})

test('counterexample 5: static admission receipt with different SHA than test build fails', () => {
  const inputs = happyBundle()
  const badAdmission = makeStaticAdmission({ sourceCommit: 'f'.repeat(40) })
  assert.throws(
    () => join({ ...inputs, staticAdmissionReceipt: badAdmission }),
    /source identity/u
  )
})

test('counterexample 6: gate failure refuses browser/runtime candidate spawn', () => {
  const inputs = happyBundle()
  const catalog = makeCatalog()
  const evidence = defaultEvidence(catalog).filter(
    (row) => !(row.behaviorId === 'alpha-behavior' && row.testKind === 'positive')
  )
  const testEvidence = makeTestEvidence({ catalog, evidence })
  const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence })
  assert.equal(receipt.status, 'failed')

  const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pre-runtime-'))
  try {
    const receiptFile = path.join(directory, 'receipt.json')
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
    assert.throws(
      () => assertRuntimeCandidateAdmissionAllowed({
        receipt: receiptFile,
        expectedCommit: SOURCE_COMMIT,
        expectedWorktreeFingerprint: WORKTREE_FP
      }),
      /runtime candidate admission refused/u
    )
    assert.throws(
      () => assertRuntimeCandidateAdmissionAllowed({
        receipt: path.join(directory, 'missing.json'),
        expectedCommit: SOURCE_COMMIT,
        expectedWorktreeFingerprint: WORKTREE_FP
      }),
      /receipt is missing/u
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('counterexample 7: release-final canonical inputs consume the verified gate receipt', () => {
  const canonical = loadCanonicalReleaseFinalEvidenceInputs()
  assert.ok(canonical.inputs.includes('behavior-evidence-pre-runtime'))
})

test('counterexample 8: catalog behavior added without binding/closure fails gate', () => {
  const inputs = happyBundle()
  const catalog = makeCatalog({
    contracts: [
      ...makeCatalog().contracts,
      {
        id: 'gamma-behavior',
        domain: 'testing',
        risk: 'high',
        status: 'active',
        implementationOwnerCardinality: 'one',
        allowedImplementationOwnerRoles: [],
        factExtractorId: 'alpha-fact-extractor',
        requiredTestKinds: ['positive'],
        documentationPolicy: 'required',
        documentationRationale: 'Gamma contract.',
        allowedClaimTypes: ['behavioral'],
        releaseQualification: true,
        evidenceStage: 'pre-runtime',
        coverageIds: ['gamma-behavior'],
        documents: ['docs/gamma.md']
      }
    ]
  })
  const evidence = defaultEvidence(catalog)
  const testEvidence = makeTestEvidence({ catalog, evidence })
  const receipt = join({ ...inputs, catalog, testEvidenceReceipt: testEvidence })
  assert.equal(receipt.status, 'failed')
  assert.ok(receipt.failureReasons.some((reason) => reason.includes('gamma-behavior')))
})

test('counterexample 9: post-runtime behavior is not admitted by the pre-runtime gate', () => {
  const postRuntimeCatalog = makeCatalog({
    contracts: [
      {
        id: 'alpha-behavior',
        domain: 'testing',
        risk: 'high',
        status: 'active',
        implementationOwnerCardinality: 'one',
        allowedImplementationOwnerRoles: [],
        factExtractorId: 'alpha-fact-extractor',
        requiredTestKinds: ['positive'],
        documentationPolicy: 'not-public',
        documentationRationale: 'Post-runtime only, not publicly documented.',
        allowedClaimTypes: ['behavioral'],
        releaseQualification: true,
        evidenceStage: 'post-runtime',
        coverageIds: ['alpha-behavior'],
        documents: []
      },
      makeCatalog().contracts[1]
    ]
  })
  const inputs = happyBundle()
  const evidence = defaultEvidence(postRuntimeCatalog)
  const testEvidence = makeTestEvidence({ catalog: postRuntimeCatalog, evidence })
  const owner = makeOwner({ catalog: postRuntimeCatalog })
  const generated = makeGenerated({ catalog: postRuntimeCatalog })
  const claims = [
    makeClaim('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
  ]
  const parseReceipt = makeParseReceipt({ catalog: postRuntimeCatalog, claims })
  const verification = makeVerification({
    catalog: postRuntimeCatalog,
    parseReceipt,
    results: [
      makeVerificationResult('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
    ]
  })
  const facts = [
    makeFact({
      extractorId: 'alpha-fact-extractor',
      behaviorIds: ['alpha-behavior'],
      observations: { limit: 10 }
    }),
    makeFact({
      extractorId: 'beta-fact-extractor',
      behaviorIds: ['beta-behavior'],
      observations: { enabled: true }
    })
  ]
  const receipt = join({
    ...inputs,
    catalog: postRuntimeCatalog,
    ownerReceipt: owner,
    testEvidenceReceipt: testEvidence,
    docClaimParseReceipt: parseReceipt,
    docClaimVerificationReceipt: verification,
    generatedSectionCheckReceipt: generated,
    factObservationReceipts: facts,
    mutationEvidenceReceipt: null
  })
  assert.equal(receipt.status, 'ok')
  assert.equal(receipt.behaviorIds.includes('alpha-behavior'), false)
  assert.equal(receipt.behaviorIds.includes('beta-behavior'), true)
})

test('skipped/blocked/diagnostic evidence cannot satisfy the gate', () => {
  const inputs = happyBundle()
  const catalog = makeCatalog()
  const evidence = defaultEvidence(catalog).map((row) =>
    row.behaviorId === 'beta-behavior' && row.testKind === 'positive'
      ? { ...row, outcome: 'skipped' }
      : row
  )
  const testEvidence = makeTestEvidence({ catalog, evidence })
  const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence })
  assert.equal(receipt.status, 'failed')
  assert.ok(receipt.failureReasons.some((reason) => reason.includes('beta-behavior')))
})

test('diagnostic-run test evidence is refused before join', () => {
  const inputs = happyBundle()
  const badEvidence = makeTestEvidence({
    catalog: inputs.catalog,
    evidence: defaultEvidence(inputs.catalog)
  })
  badEvidence.run.attemptKind = 'diagnostic'
  badEvidence.contentDigest = digestReceipt(badEvidence)
  assert.throws(
    () => join({ ...inputs, testEvidenceReceipt: badEvidence }),
    /diagnostic/u
  )
})

test('merged multiple test evidence receipts keep consistent behavior coverage', () => {
  const inputs = happyBundle()
  const catalog = inputs.catalog
  const evidence1 = defaultEvidence(catalog).filter(
    (row) => row.behaviorId === 'alpha-behavior' && row.testKind === 'positive'
  )
  const evidence2 = defaultEvidence(catalog).filter(
    (row) => !(row.behaviorId === 'alpha-behavior' && row.testKind === 'positive')
  )
  const te1 = makeTestEvidence({ catalog, evidence: evidence1 })
  const te2 = makeTestEvidence({ catalog, evidence: evidence2 })
  const receipt = join({
    ...inputs,
    testEvidenceReceipts: [te1, te2]
  }, { testEvidenceReceipts: [te1, te2] })
  assert.equal(receipt.status, 'ok')
  for (const behaviorId of ['alpha-behavior', 'beta-behavior']) {
    assert.ok(receipt.behaviorIds.includes(behaviorId))
    assert.ok(receipt.observedTestKinds[behaviorId].length > 0)
  }
})

test('runtime candidate admission refuses identity mismatch', () => {
  const inputs = happyBundle()
  const receipt = join(inputs)
  assert.throws(
    () => assertRuntimeCandidateAdmissionAllowed({
      receipt,
      expectedCommit: 'f'.repeat(40),
      expectedWorktreeFingerprint: WORKTREE_FP
    }),
    /does not match expected/u
  )
  assert.throws(
    () => assertRuntimeCandidateAdmissionAllowed({
      receipt,
      expectedCommit: SOURCE_COMMIT,
      expectedWorktreeFingerprint: 'c'.repeat(64)
    }),
    /worktree fingerprint/u
  )
})

test('tampered receipt contentDigest is rejected', () => {
  const inputs = happyBundle()
  const receipt = join(inputs)
  receipt.status = 'failed'
  assert.throws(() => validatePreRuntimeReceipt(receipt), /contentDigest mismatch/u)
})

test('receipt contentDigest is recomputable', () => {
  const inputs = happyBundle()
  const receipt = join(inputs)
  const recomputed = createHash('sha256')
    .update(JSON.stringify(stable(
      Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    )), 'utf8')
    .digest('hex')
  assert.equal(receipt.contentDigest, `sha256:${recomputed}`)
})

test('mutation-required behavior with missing mutation evidence fails per-behavior', () => {
  const inputs = happyBundle()
  const receipt = join({ ...inputs, mutationEvidenceReceipt: null })
  assert.equal(receipt.status, 'failed')
  assert.ok(receipt.failureReasons.some((reason) =>
    reason.includes('alpha-behavior') && reason.includes('mutation')))
  assert.equal(receipt.mutationStatus['alpha-behavior'].qualified, false)
})
