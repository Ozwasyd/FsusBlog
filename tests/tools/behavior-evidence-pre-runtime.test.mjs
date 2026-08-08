import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  joinBehaviorEvidencePreRuntime,
  preRuntimeReceiptSchema,
  validatePreRuntimeReceipt,
  assertPreRuntimeQualified,
  root
} from '../../tools/test-matrix/behavior-evidence-pre-runtime.mjs';
import {
  joinBehaviorGraph,
  sealOwnerBindingReceipt,
  sealDocClaimVerificationReceipt,
  sealGeneratedSectionCheckReceipt,
  behaviorGraphSchema,
  digestValue
} from '../../tools/contracts/behavior-graph-join.mjs';
import { sealMutationEvidenceReceipt } from '../../tools/test/mutation-evidence-receipt.mjs';
import { sealReceipt, buildReceipt } from '../../tools/fact-extractors/receipt.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);
const WORKTREE_FP = 'b'.repeat(64);
const EXTRACTOR_DIGEST = 'c'.repeat(64);
const REGISTRY_DIGEST = 'd'.repeat(64);
const INPUT_DIGEST = 'e'.repeat(64);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function digestTestEvidence(receipt) {
  const content = structuredClone(receipt);
  delete content.contentDigest;
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(content)), 'utf8')
    .digest('hex')}`;
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
        mutationPolicy: { mutationRequired: true, minimumMutationScore: 70, requireExecutedMutants: true, allowedEquivalentMutantPolicy: 'none' }
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
  };
}

function catalogDigest(catalog) {
  return digestValue(catalog);
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
  }));
}

function makeOwner({ catalog, behaviorIds = ['alpha-behavior', 'beta-behavior'], errors = [] } = {}) {
  const digest = catalogDigest(catalog);
  const bindings = behaviorIds.map((id, idx) => ({
    behaviorId: id,
    language: 'javascript',
    sourcePath: `tools/${id.split('-')[0]}/extract.mjs`,
    symbol: 'extract',
    bindingKind: 'marker',
    sourceDigest: String(idx + 1).repeat(64),
    status: 'ok'
  }));
  return sealOwnerBindingReceipt({
    schema: 'fsusblog.behavior-owner-binding-receipt.v1',
    catalogDigest: digest,
    worktreeDigest: SOURCE_COMMIT,
    status: errors.length === 0 ? 'ok' : 'failed',
    bindingCount: bindings.length,
    bindings: bindings.map((b) => ({ ...b, catalogDigest: digest, worktreeDigest: SOURCE_COMMIT })),
    errors
  });
}

function makeTestEvidence({ catalog, evidence, errors = [] } = {}) {
  const digest = catalogDigest(catalog);
  const coverage = catalog.contracts
    .filter((c) => c.status === 'active')
    .map((contract) => {
      const satisfied = contract.requiredTestKinds.filter((kind) =>
        (evidence ?? []).some((row) =>
          row.behaviorId === contract.id && row.testKind === kind
          && row.discovered && row.executed && row.outcome === 'passed'
        )
      );
      const missing = contract.requiredTestKinds.filter((k) => !satisfied.includes(k));
      return { behaviorId: contract.id, requiredTestKinds: [...contract.requiredTestKinds], satisfiedTestKinds: satisfied, missingTestKinds: missing, status: missing.length === 0 ? 'ok' : 'failed' };
    });
  const receipt = {
    schema: 'fsusblog.behavior-test-evidence-receipt.v1',
    catalogDigest: digest,
    worktreeDigest: SOURCE_COMMIT,
    run: { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' },
    sourceState: { commit: SOURCE_COMMIT, worktreeFingerprint: `sha256:${WORKTREE_FP}` },
    sourceClosureDigest: `sha256:${'f'.repeat(64)}`,
    rawResultDigest: `sha256:${'9'.repeat(64)}`,
    bindings: (evidence ?? []).map((row) => ({
      behaviorId: row.behaviorId, testKind: row.testKind,
      canonicalTestId: row.canonicalTestId, framework: 'node-tap',
      sourcePath: row.sourcePath, fullyQualifiedName: row.fullyQualifiedName,
      invariantIds: [], reasonId: null, concurrencyHarness: null, bindingKind: 'helper', line: 1
    })),
    evidence: evidence ?? [],
    coverage,
    errors
  };
  receipt.contentDigest = digestTestEvidence(receipt);
  return receipt;
}

function defaultEvidence(catalog) {
  const rows = [];
  for (const contract of catalog.contracts.filter((e) => e.status === 'active')) {
    for (const kind of contract.requiredTestKinds) {
      rows.push({
        behaviorId: contract.id, testKind: kind,
        canonicalTestId: `node-tap:tests/${contract.id}.${kind}.test.mjs#${kind}`,
        framework: 'node-tap',
        sourcePath: `tests/${contract.id}.${kind}.test.mjs`,
        fullyQualifiedName: kind,
        discovered: true, executed: true, outcome: 'passed',
        invariantIds: [], reasonId: null, concurrencyHarness: null,
        run: { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' },
        sourceState: { commit: SOURCE_COMMIT, worktreeFingerprint: `sha256:${WORKTREE_FP}` },
        sourceClosureDigest: `sha256:${'f'.repeat(64)}`,
        rawResultDigest: `sha256:${'9'.repeat(64)}`
      });
    }
  }
  return rows;
}

function makeParseReceipt({ catalog, claims = [] } = {}) {
  const receipt = {
    schema: 'fsusblog.doc-claim-parse-receipt.v1',
    digestAlgorithm: 'sha256',
    canonicalSerialization: 'json-utf8-v1',
    behaviorCatalogDigest: catalogDigest(catalog),
    claims
  };
  return { ...receipt, contentDigest: digestValue(receipt) };
}

function makeVerification({ catalog, parseReceipt, results = [], status = 'ok', failureReasons = [] } = {}) {
  return sealDocClaimVerificationReceipt({
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP,
    catalogDigest: catalogDigest(catalog),
    parseReceiptDigest: parseReceipt.contentDigest,
    factObservationDigests: [],
    results, status, failureReasons
  });
}

function makeGenerated({ catalog, sections = [], status = 'ok', failureReasons = [] } = {}) {
  return sealGeneratedSectionCheckReceipt({
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP,
    catalogDigest: catalogDigest(catalog),
    sectionCatalogDigest: '8'.repeat(64),
    factObservationDigests: [],
    sections, status, failureReasons
  });
}

function makeStaticAdmission({ status = 'ok', candidateSpawnCount = 0 } = {}) {
  const receipt = {
    schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
    status,
    candidateSpawnCountBeforeReceipt: candidateSpawnCount,
    runId: 'run-1',
    sourceCommit: SOURCE_COMMIT,
    worktreeFingerprint: `sha256:${WORKTREE_FP}`,
    catalogDigest: '1'.repeat(64),
    failures: status === 'ok' ? [] : ['admission failure'],
    contentDigest: null
  };
  receipt.contentDigest = digestValue(receipt);
  return receipt;
}

function makeClaim(behaviorId, claimId, factPath = 'limit', documentPath = `docs/${behaviorId.split('-')[0]}.md`) {
  return {
    declaration: { claimId, behaviorId, claimType: 'scalar', factPath, render: 'scalar-inline' },
    location: { documentPath, claimStartLine: 1, claimEndLine: 4, documentStatus: 'current', headingPath: ['Section'], bodyKind: 'paragraph', bodyStartLine: 5, bodyEndLine: 5, bodyText: `${factPath} is 10` }
  };
}

function makeVerificationResult(behaviorId, claimId, factPath = 'limit', documentPath, status = 'verified') {
  return { claimId, behaviorId, claimType: 'scalar', documentPath: documentPath ?? `docs/${behaviorId.split('-')[0]}.md`, documentStatus: 'current', factPath, status, reason: 'ok' };
}

function happyBundle() {
  const catalog = makeCatalog();
  const owner = makeOwner({ catalog });
  const catalogDig = catalogDigest(catalog);
  const evidence = defaultEvidence(catalog);
  const testEvidence = makeTestEvidence({ catalog, evidence });
  const claims = [
    makeClaim('alpha-behavior', 'alpha.limit', 'limit', 'docs/alpha.md'),
    makeClaim('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
  ];
  const parseReceipt = makeParseReceipt({ catalog, claims });
  const verification = makeVerification({
    catalog, parseReceipt,
    results: [
      makeVerificationResult('alpha-behavior', 'alpha.limit', 'limit', 'docs/alpha.md'),
      makeVerificationResult('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
    ]
  });
  const generated = makeGenerated({ catalog });
  const facts = [
    makeFact({ extractorId: 'alpha-fact-extractor', behaviorIds: ['alpha-behavior'], observations: { limit: 10 } }),
    makeFact({ extractorId: 'beta-fact-extractor', behaviorIds: ['beta-behavior'], observations: { enabled: true } })
  ];
  const mutationEvidence = sealMutationEvidenceReceipt({
    sourceCommit: SOURCE_COMMIT,
    worktreeFingerprint: WORKTREE_FP,
    catalogDigest: catalogDig,
    selectionDigest: '6'.repeat(64),
    ownerReceiptDigest: owner.contentDigest,
    testBindingScanDigest: '7'.repeat(64),
    rawReportDigest: '8'.repeat(64),
    rawTraceDigest: '9'.repeat(64),
    attributions: [
      { mutantId: 'a:1', behaviorId: 'alpha-behavior', sourcePath: 'tools/alpha/extract.mjs', symbol: 'extract', mutator: 'Boolean', status: 'Killed', coveredTestIds: ['a1'], killedTestIds: ['a1'] }
    ],
    qualifications: [
      { behaviorId: 'alpha-behavior', mutationRequired: true, executed: 1, killed: 1, survived: 0, timeout: 0, noCoverage: 0, score: 100, minimumMutationScore: 70, qualified: true, failures: [] }
    ],
    blockedCount: 0,
    status: 'ok',
    failureReasons: []
  });
  const admission = makeStaticAdmission();

  return {
    catalog, ownerReceipt: owner, testEvidenceReceipt: testEvidence,
    docClaimParseReceipt: parseReceipt,
    docClaimVerificationReceipt: verification,
    generatedSectionCheckReceipt: generated,
    factObservationReceipts: facts,
    mutationEvidenceReceipt: mutationEvidence,
    staticAdmissionReceipt: admission
  };
}

test('source module forbids producer/parser imports and forbidden patterns', () => {
  const source = readFileSync(
    path.join(root, 'tools/test-matrix/behavior-evidence-pre-runtime.mjs'),
    'utf8'
  );
  const importLines = source.split('\n').filter(l => /^\s*import\b/.test(l));
  const importSource = importLines.join('\n');
  assert.doesNotMatch(importSource, /behavior-owner-binding|behavior-test-binding|doc-claim|child_process|prose-claim-verifier|spawnSync\s*\(|execFileSync\s*\(/u);
  assert.doesNotMatch(source, /warning-only|secondGate|compatSchema|optionalGate\s*[:=]|defaultPass\s*[:=]|latest.*evidence.*fallback/iu);
});

test('happy path produces qualified pre-runtime receipt with stable digest', () => {
  const inputs = happyBundle();
  const receipt = joinBehaviorEvidencePreRuntime({
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
    worktreeFingerprint: WORKTREE_FP
  });
  assert.equal(receipt.schema, preRuntimeReceiptSchema);
  assert.equal(receipt.scope, 'pre-runtime');
  assert.equal(receipt.status, 'ok');
  assert.deepEqual(receipt.failureReasons, []);
  assert.equal(receipt.runtimeCandidateSpawnCountBeforeReceipt, 0);
  assert.ok(receipt.behaviorIds.includes('alpha-behavior'));
  assert.ok(receipt.behaviorIds.includes('beta-behavior'));

  validatePreRuntimeReceipt(receipt);
  assertPreRuntimeQualified(receipt);
});

test('missing boundary test fails pre-runtime gate', () => {
  const inputs = happyBundle();
  const catalog = makeCatalog();
  const evidence = defaultEvidence(catalog).filter(
    (row) => !(row.behaviorId === 'alpha-behavior' && row.testKind === 'boundary')
  );
  const testEvidence = makeTestEvidence({ catalog, evidence });
  const receipt = joinBehaviorEvidencePreRuntime({
    catalog, ownerReceipt: inputs.ownerReceipt,
    testEvidenceReceipts: [testEvidence],
    docClaimParseReceipt: inputs.docClaimParseReceipt,
    docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
    generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
    factObservationReceipts: inputs.factObservationReceipts,
    mutationEvidenceReceipt: inputs.mutationEvidenceReceipt,
    staticAdmissionReceipt: inputs.staticAdmissionReceipt,
    sourceCommit: SOURCE_COMMIT,
    worktreeFingerprint: WORKTREE_FP
  });
  assert.equal(receipt.status, 'failed');
  assert.ok(receipt.failureReasons.some((r) => r.includes('boundary')));
});

test('survived mutant fails pre-runtime gate', () => {
  const inputs = happyBundle();
  const me = sealMutationEvidenceReceipt({
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP,
    catalogDigest: catalogDigest(inputs.catalog),
    selectionDigest: '6'.repeat(64),
    ownerReceiptDigest: inputs.ownerReceipt.contentDigest,
    testBindingScanDigest: '7'.repeat(64),
    rawReportDigest: '8'.repeat(64),
    rawTraceDigest: '9'.repeat(64),
    attributions: [
      { mutantId: 'a:1', behaviorId: 'alpha-behavior', sourcePath: 'tools/alpha/extract.mjs', symbol: 'extract', mutator: 'Boolean', status: 'Survived', coveredTestIds: [], killedTestIds: [] }
    ],
    qualifications: [
      { behaviorId: 'alpha-behavior', mutationRequired: true, executed: 1, killed: 0, survived: 1, timeout: 0, noCoverage: 0, score: 0, minimumMutationScore: 70, qualified: false, failures: ['alpha-behavior has 1 survived mutant(s)'] }
    ],
    blockedCount: 0,
    status: 'failed',
    failureReasons: ['alpha-behavior has 1 survived mutant(s)']
  });
  const receipt = joinBehaviorEvidencePreRuntime({
    catalog: inputs.catalog, ownerReceipt: inputs.ownerReceipt,
    testEvidenceReceipts: [inputs.testEvidenceReceipt],
    docClaimParseReceipt: inputs.docClaimParseReceipt,
    docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
    generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
    factObservationReceipts: inputs.factObservationReceipts,
    mutationEvidenceReceipt: me,
    staticAdmissionReceipt: inputs.staticAdmissionReceipt,
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP
  });
  assert.equal(receipt.status, 'failed');
  assert.ok(receipt.failureReasons.some((r) => r.includes('alpha-behavior') && r.includes('survived')));
});

test('post-runtime behavior excluded from pre-runtime scope', () => {
  const catalog = makeCatalog({
    contracts: [
      {
        id: 'alpha-behavior', domain: 'testing', risk: 'high', status: 'active',
        implementationOwnerCardinality: 'one', allowedImplementationOwnerRoles: [],
        factExtractorId: 'alpha-fact-extractor', requiredTestKinds: ['positive'],
        documentationPolicy: 'not-public', documentationRationale: 'Post-runtime only, not yet publicly documented.',
        allowedClaimTypes: ['behavioral'], releaseQualification: true,
        evidenceStage: 'post-runtime',
        coverageIds: ['alpha-behavior'], documents: []
      },
      {
        id: 'beta-behavior', domain: 'documentation', risk: 'medium', status: 'active',
        implementationOwnerCardinality: 'one', allowedImplementationOwnerRoles: [],
        factExtractorId: 'beta-fact-extractor', requiredTestKinds: ['positive'],
        documentationPolicy: 'required', documentationRationale: 'Beta.',
        allowedClaimTypes: ['behavioral'], releaseQualification: true,
        evidenceStage: 'pre-runtime',
        coverageIds: ['beta-behavior'], documents: ['docs/beta.md']
      }
    ]
  });
  const inputs = happyBundle();
  const evidence = defaultEvidence(catalog);
  const testEvidence = makeTestEvidence({ catalog, evidence });
  const claims = [
    makeClaim('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
  ];
  const parseReceipt = makeParseReceipt({ catalog, claims });
  const verification = makeVerification({
    catalog, parseReceipt,
    results: [
      makeVerificationResult('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
    ]
  });
  const facts = [
    makeFact({ extractorId: 'alpha-fact-extractor', behaviorIds: ['alpha-behavior'], observations: { limit: 10 } }),
    makeFact({ extractorId: 'beta-fact-extractor', behaviorIds: ['beta-behavior'], observations: { enabled: true } })
  ];
  const receipt = joinBehaviorEvidencePreRuntime({
    catalog, ownerReceipt: makeOwner({ catalog }),
    testEvidenceReceipts: [testEvidence],
    docClaimParseReceipt: parseReceipt,
    docClaimVerificationReceipt: verification,
    generatedSectionCheckReceipt: makeGenerated({ catalog }),
    factObservationReceipts: facts,
    staticAdmissionReceipt: inputs.staticAdmissionReceipt,
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP
  });
  // Post-runtime alpha-behavior should NOT be in the pre-runtime behaviorIds
  assert.ok(!receipt.behaviorIds.includes('alpha-behavior'));
  assert.ok(receipt.behaviorIds.includes('beta-behavior'));
  assert.equal(receipt.status, 'ok');
});

test('rejects static admission receipt with non-zero candidate spawn count', () => {
  const inputs = happyBundle();
  const badAdmission = makeStaticAdmission({ candidateSpawnCount: 1 });
  assert.throws(() => {
    joinBehaviorEvidencePreRuntime({
      catalog: inputs.catalog, ownerReceipt: inputs.ownerReceipt,
      testEvidenceReceipts: [inputs.testEvidenceReceipt],
      docClaimParseReceipt: inputs.docClaimParseReceipt,
      docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
      generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
      factObservationReceipts: inputs.factObservationReceipts,
      mutationEvidenceReceipt: inputs.mutationEvidenceReceipt,
      staticAdmissionReceipt: badAdmission,
      sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP
    });
  }, /non-zero candidate spawn/);
});

test('fails when mutation-required behavior has no mutation evidence', () => {
  const inputs = happyBundle();
  // Remove mutation evidence
  const receipt = joinBehaviorEvidencePreRuntime({
    catalog: inputs.catalog,
    ownerReceipt: inputs.ownerReceipt,
    testEvidenceReceipts: [inputs.testEvidenceReceipt],
    docClaimParseReceipt: inputs.docClaimParseReceipt,
    docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
    generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
    factObservationReceipts: inputs.factObservationReceipts,
    mutationEvidenceReceipt: null,
    staticAdmissionReceipt: inputs.staticAdmissionReceipt,
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP
  });
  assert.equal(receipt.status, 'failed');
  assert.ok(receipt.failureReasons.some((r) => r.includes('mutation') && r.includes('alpha-behavior')));
});

test('rejects source identity mismatch in test evidence', () => {
  const inputs = happyBundle();
  const badEvidence = makeTestEvidence({
    catalog: inputs.catalog,
    evidence: defaultEvidence(inputs.catalog)
  });
  badEvidence.sourceState.commit = 'f'.repeat(40);
  badEvidence.contentDigest = digestTestEvidence(badEvidence);
  assert.throws(() => {
    joinBehaviorEvidencePreRuntime({
      catalog: inputs.catalog, ownerReceipt: inputs.ownerReceipt,
      testEvidenceReceipts: [badEvidence],
      docClaimParseReceipt: inputs.docClaimParseReceipt,
      docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
      generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
      factObservationReceipts: inputs.factObservationReceipts,
      mutationEvidenceReceipt: inputs.mutationEvidenceReceipt,
      staticAdmissionReceipt: inputs.staticAdmissionReceipt,
      sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP
    });
  }, /source commit/);
});

test('merged multiple test evidence receipts produce consistent behavior coverage', () => {
  const inputs = happyBundle();
  const catalog = inputs.catalog;
  const evidence1 = defaultEvidence(catalog).filter((row) =>
    row.behaviorId === 'alpha-behavior' && row.testKind === 'positive');
  const evidence2 = defaultEvidence(catalog).filter((row) =>
    !(row.behaviorId === 'alpha-behavior' && row.testKind === 'positive'));
  const te1 = makeTestEvidence({ catalog, evidence: evidence1 });
  const te2 = makeTestEvidence({ catalog, evidence: evidence2 });

  const receipt = joinBehaviorEvidencePreRuntime({
    catalog, ownerReceipt: inputs.ownerReceipt,
    testEvidenceReceipts: [te1, te2],
    docClaimParseReceipt: inputs.docClaimParseReceipt,
    docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
    generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
    factObservationReceipts: inputs.factObservationReceipts,
    mutationEvidenceReceipt: inputs.mutationEvidenceReceipt,
    staticAdmissionReceipt: inputs.staticAdmissionReceipt,
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP
  });
  assert.equal(receipt.status, 'ok');
  // Both behaviors should have all required kinds satisfied
  for (const behaviorId of ['alpha-behavior', 'beta-behavior']) {
    assert.ok(receipt.behaviorIds.includes(behaviorId));
    assert.ok(receipt.observedTestKinds[behaviorId].length > 0);
  }
});

test('generates receipt with recomputable contentDigest', () => {
  const inputs = happyBundle();
  const receipt = joinBehaviorEvidencePreRuntime({
    catalog: inputs.catalog, ownerReceipt: inputs.ownerReceipt,
    testEvidenceReceipts: [inputs.testEvidenceReceipt],
    docClaimParseReceipt: inputs.docClaimParseReceipt,
    docClaimVerificationReceipt: inputs.docClaimVerificationReceipt,
    generatedSectionCheckReceipt: inputs.generatedSectionCheckReceipt,
    factObservationReceipts: inputs.factObservationReceipts,
    mutationEvidenceReceipt: inputs.mutationEvidenceReceipt,
    staticAdmissionReceipt: inputs.staticAdmissionReceipt,
    sourceCommit: SOURCE_COMMIT, worktreeFingerprint: WORKTREE_FP
  });
  const hash = createHash('sha256');
  hash.update(JSON.stringify(stable(
    Object.fromEntries(Object.entries(receipt).filter(([k]) => k !== 'contentDigest'))
  )), 'utf8');
  const recomputed = hash.digest('hex');
  assert.equal(receipt.contentDigest, recomputed);
});
