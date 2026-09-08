import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestValue } from '../../tools/contracts/behavior-graph-join.mjs';
import {
    assertPreRuntimeQualified,
    assertRuntimeCandidateAdmissionAllowed,
    preRuntimeReceiptSchema,
    root,
    validatePreRuntimeReceipt
} from '../../tools/test-matrix/behavior-evidence-pre-runtime.mjs';
import { loadCanonicalReleaseFinalEvidenceInputs } from '../../tools/test-matrix/release-final-evidence-contract.mjs';

import {
    SOURCE_COMMIT,
    WORKTREE_FP,
    stable,
    digestReceipt,
    digestReceiptWithNullField,
    makeCatalog,
    makeFactExtractorRegistry,
    makeFact,
    makeOwner,
    makeTestEvidence,
    defaultEvidence,
    makeParseReceipt,
    makeVerification,
    makeGenerated,
    makeStaticAdmission,
    makeClaim,
    makeVerificationResult,
    makeMutationEvidence,
    happyBundle,
    join
} from './support/behavior-evidence-pre-runtime-fixture.mjs';

test('gate module forbids producer/parser imports and fallback patterns', () =>
{
    const source = readFileSync(
        path.join(root, 'tools/test-matrix/behavior-evidence-pre-runtime.mjs'),
        'utf8'
    );
    const importLines = source.split('\n').filter((line) => /^\s*import\b/u.test(line));
    const importSource = importLines.join('\n');
    assert.doesNotMatch(
        importSource,
        /behavior-owner-binding|behavior-test-binding|doc-claim|prose-claim-verifier|generated-fact-sections|fact-extractors|child_process|spawnSync\s*\(|execFileSync\s*\(/u
    );
    assert.doesNotMatch(
        source,
        /warning-only|compatSchema|optionalGate\s*[:=]|defaultPass\s*[:=]|latest.*evidence.*fallback|find.*latest/u
    );
});

test('happy path produces qualified pre-runtime receipt with stable digest', () =>
{
    const inputs = happyBundle();
    const receipt = join(inputs);
    assert.equal(receipt.schema, preRuntimeReceiptSchema);
    assert.equal(receipt.scope, 'pre-runtime');
    assert.equal(receipt.status, 'ok');
    assert.deepEqual(receipt.failureReasons, []);
    assert.equal(receipt.runtimeCandidateSpawnCountBeforeReceipt, 0);
    assert.ok(receipt.behaviorIds.includes('alpha-behavior'));
    assert.ok(receipt.behaviorIds.includes('beta-behavior'));
    assert.equal(receipt.requiredTestKinds['alpha-behavior'].includes('boundary'), true);
    assert.equal(receipt.observedTestKinds['alpha-behavior'].includes('boundary'), true);
    assert.equal(receipt.mutationStatus['alpha-behavior'].qualified, true);
    validatePreRuntimeReceipt(receipt, { behaviorCatalog: inputs.catalog });
    assertPreRuntimeQualified(receipt, { behaviorCatalog: inputs.catalog });
    assertRuntimeCandidateAdmissionAllowed({
        receipt,
        expectedCommit: SOURCE_COMMIT,
        expectedWorktreeFingerprint: WORKTREE_FP,
        behaviorCatalog: inputs.catalog,
        factExtractorRegistry: inputs.factExtractorRegistry
    });
});

test('static admission accepts only its canonical null-field digest convention', () =>
{
    const inputs = happyBundle();
    inputs.staticAdmissionReceipt.contentDigest = digestReceipt(inputs.staticAdmissionReceipt);
    assert.throws(
        () => join(inputs),
        /static admission receipt contentDigest mismatch/u
    );
});

test('test and mutation evidence reject the static admission digest convention', () =>
{
    const testInputs = happyBundle();
    testInputs.testEvidenceReceipt.contentDigest = digestReceiptWithNullField(
        testInputs.testEvidenceReceipt
    );
    assert.throws(
        () => join(testInputs),
        /test evidence receipt contentDigest mismatch/u
    );

    const mutationInputs = happyBundle();
    mutationInputs.mutationEvidenceReceipt.contentDigest = digestReceiptWithNullField(
        mutationInputs.mutationEvidenceReceipt
    );
    assert.throws(
        () => join(mutationInputs),
        /mutation evidence receipt contentDigest mismatch/u
    );
});

test('counterexample 1: boundary test not executed but file exists fails gate and refuses runtime spawn', () =>
{
    const inputs = happyBundle();
    const catalog = makeCatalog();
    const evidence = defaultEvidence(catalog).filter(
        (row) => !(row.behaviorId === 'alpha-behavior' && row.testKind === 'boundary')
    );
    const testEvidence = makeTestEvidence({ catalog, evidence });
    const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence });
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) => reason.includes('boundary')));
    assert.throws(
        () => assertRuntimeCandidateAdmissionAllowed({
            receipt,
            expectedCommit: SOURCE_COMMIT,
            expectedWorktreeFingerprint: WORKTREE_FP,
            behaviorCatalog: inputs.catalog,
            factExtractorRegistry: inputs.factExtractorRegistry
        }),
        /runtime candidate admission refused/u
    );
});

test('counterexample 2: survived mutant fails gate even when domain score is high', () =>
{
    const inputs = happyBundle();
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
    });
    const receipt = join({ ...inputs, mutationEvidenceReceipt: mutationEvidence });
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) =>
        reason.includes('alpha-behavior') && reason.includes('mutation')));
    assert.equal(receipt.mutationStatus['alpha-behavior'].qualified, false);
});

test('counterexample 3: docs-only PR cannot skip required test evidence', () =>
{
    const inputs = happyBundle();
    const catalog = makeCatalog();
    const evidence = defaultEvidence(catalog).filter(
        (row) => !(row.behaviorId === 'beta-behavior' && row.testKind === 'positive')
    );
    const testEvidence = makeTestEvidence({ catalog, evidence });
    const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence });
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) =>
        reason.includes('beta-behavior') && reason.includes('positive')));
});

test('counterexample 4: default-branch/historical test evidence is refused', () =>
{
    const inputs = happyBundle();
    const badEvidence = makeTestEvidence({
        catalog: inputs.catalog,
        evidence: defaultEvidence(inputs.catalog)
    });
    badEvidence.sourceState.commit = 'f'.repeat(40);
    badEvidence.contentDigest = digestReceipt(badEvidence);
    assert.throws(
        () => join({ ...inputs, testEvidenceReceipt: badEvidence }),
        /source identity/u
    );
});

test('counterexample 5: static admission receipt with different SHA than test build fails', () =>
{
    const inputs = happyBundle();
    const badAdmission = makeStaticAdmission({ sourceCommit: 'f'.repeat(40) });
    assert.throws(
        () => join({ ...inputs, staticAdmissionReceipt: badAdmission }),
        /source identity/u
    );
});

test('counterexample 6: gate failure refuses browser/runtime candidate spawn', () =>
{
    const inputs = happyBundle();
    const catalog = makeCatalog();
    const evidence = defaultEvidence(catalog).filter(
        (row) => !(row.behaviorId === 'alpha-behavior' && row.testKind === 'positive')
    );
    const testEvidence = makeTestEvidence({ catalog, evidence });
    const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence });
    assert.equal(receipt.status, 'failed');

    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pre-runtime-'));
    try
    {
        const receiptFile = path.join(directory, 'receipt.json');
        writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
        assert.throws(
            () => assertRuntimeCandidateAdmissionAllowed({
                receipt: receiptFile,
                expectedCommit: SOURCE_COMMIT,
                expectedWorktreeFingerprint: WORKTREE_FP,
                behaviorCatalog: inputs.catalog,
                factExtractorRegistry: inputs.factExtractorRegistry
            }),
            /runtime candidate admission refused/u
        );
        assert.throws(
            () => assertRuntimeCandidateAdmissionAllowed({
                receipt: path.join(directory, 'missing.json'),
                expectedCommit: SOURCE_COMMIT,
                expectedWorktreeFingerprint: WORKTREE_FP
            }),
            /receipt is missing/u
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('counterexample 7: release-final canonical inputs consume the verified gate receipt', () =>
{
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    assert.ok(canonical.inputs.includes('behavior-evidence-pre-runtime'));
});

test('counterexample 8: catalog behavior added without binding/closure fails gate', () =>
{
    const inputs = happyBundle();
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
    });
    const evidence = defaultEvidence(catalog);
    const testEvidence = makeTestEvidence({ catalog, evidence });
    const receipt = join({ ...inputs, catalog, testEvidenceReceipt: testEvidence });
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) => reason.includes('gamma-behavior')));
});

test('counterexample 9: post-runtime behavior is not admitted by the pre-runtime gate', () =>
{
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
    });
    const inputs = happyBundle();
    const evidence = defaultEvidence(postRuntimeCatalog);
    const testEvidence = makeTestEvidence({ catalog: postRuntimeCatalog, evidence });
    const owner = makeOwner({ catalog: postRuntimeCatalog });
    const generated = makeGenerated({ catalog: postRuntimeCatalog });
    const claims = [
        makeClaim('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
    ];
    const parseReceipt = makeParseReceipt({ catalog: postRuntimeCatalog, claims });
    const verification = makeVerification({
        catalog: postRuntimeCatalog,
        parseReceipt,
        results: [
            makeVerificationResult('beta-behavior', 'beta.enabled', 'enabled', 'docs/beta.md')
        ]
    });
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
    ];
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
    });
    assert.equal(receipt.status, 'ok');
    assert.equal(receipt.behaviorIds.includes('alpha-behavior'), false);
    assert.equal(receipt.behaviorIds.includes('beta-behavior'), true);
});

test('skipped/blocked/diagnostic evidence cannot satisfy the gate', () =>
{
    const inputs = happyBundle();
    const catalog = makeCatalog();
    const evidence = defaultEvidence(catalog).map((row) =>
    row.behaviorId === 'beta-behavior' && row.testKind === 'positive'
        ? { ...row, outcome: 'skipped' }
        : row
    );
    const testEvidence = makeTestEvidence({ catalog, evidence });
    const receipt = join({ ...inputs, testEvidenceReceipt: testEvidence });
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) => reason.includes('beta-behavior')));
});

test('diagnostic-run test evidence is refused before join', () =>
{
    const inputs = happyBundle();
    const badEvidence = makeTestEvidence({
        catalog: inputs.catalog,
        evidence: defaultEvidence(inputs.catalog)
    });
    badEvidence.run.attemptKind = 'diagnostic';
    badEvidence.contentDigest = digestReceipt(badEvidence);
    assert.throws(
        () => join({ ...inputs, testEvidenceReceipt: badEvidence }),
        /diagnostic/u
    );
});

test('merged multiple test evidence receipts keep consistent behavior coverage', () =>
{
    const inputs = happyBundle();
    const catalog = inputs.catalog;
    const evidence1 = defaultEvidence(catalog).filter(
        (row) => row.behaviorId === 'alpha-behavior' && row.testKind === 'positive'
    );
    const evidence2 = defaultEvidence(catalog).filter(
        (row) => !(row.behaviorId === 'alpha-behavior' && row.testKind === 'positive')
    );
    const te1 = makeTestEvidence({ catalog, evidence: evidence1 });
    const te2 = makeTestEvidence({ catalog, evidence: evidence2 });
    const receipt = join({
        ...inputs,
        testEvidenceReceipts: [te1, te2]
    }, { testEvidenceReceipts: [te1, te2] });
    assert.equal(receipt.status, 'ok');
    for (const behaviorId of ['alpha-behavior', 'beta-behavior'])
    {
        assert.ok(receipt.behaviorIds.includes(behaviorId));
        assert.ok(receipt.observedTestKinds[behaviorId].length > 0);
    }
});

test('runtime candidate admission refuses identity mismatch', () =>
{
    const inputs = happyBundle();
    const receipt = join(inputs);
    assert.throws(
        () => assertRuntimeCandidateAdmissionAllowed({
            receipt,
            expectedCommit: 'f'.repeat(40),
            expectedWorktreeFingerprint: WORKTREE_FP,
            behaviorCatalog: inputs.catalog,
            factExtractorRegistry: inputs.factExtractorRegistry
        }),
        /does not match expected/u
    );
    assert.throws(
        () => assertRuntimeCandidateAdmissionAllowed({
            receipt,
            expectedCommit: SOURCE_COMMIT,
            expectedWorktreeFingerprint: 'c'.repeat(64),
            behaviorCatalog: inputs.catalog,
            factExtractorRegistry: inputs.factExtractorRegistry
        }),
        /worktree fingerprint/u
    );
});

test('tampered receipt contentDigest is rejected', () =>
{
    const inputs = happyBundle();
    const receipt = join(inputs);
    receipt.status = 'failed';
    assert.throws(() => validatePreRuntimeReceipt(receipt), /contentDigest mismatch/u);
});

test('independent verifier rejects a resealed schema-incomplete receipt', () =>
{
    const inputs = happyBundle();
    const receipt = join(inputs);
    delete receipt.testEvidenceDigests;
    receipt.contentDigest = digestReceipt(receipt);
    assert.throws(
        () => validatePreRuntimeReceipt(receipt, { behaviorCatalog: inputs.catalog }),
        /schema validation failed/u
    );
});

test('join rejects current-run relabeling of stale same-source evidence', () =>
{
    const inputs = happyBundle();
    inputs.staticAdmissionReceipt = makeStaticAdmission({ runId: 'stale-run' });
    assert.throws(
        () => join(inputs),
        /run identity mismatch/u
    );
});

test('independent verifier rejects a resealed subset of current catalog behaviors', () =>
{
    const inputs = happyBundle();
    const receipt = join(inputs);
    receipt.behaviorIds = ['alpha-behavior'];
    delete receipt.requiredTestKinds['beta-behavior'];
    delete receipt.observedTestKinds['beta-behavior'];
    delete receipt.mutationStatus['beta-behavior'];
    receipt.contentDigest = digestReceipt(receipt);
    assert.throws(
        () => validatePreRuntimeReceipt(receipt, { behaviorCatalog: inputs.catalog }),
        /current pre-runtime catalog authority/u
    );
});

test('independent verifier rejects resealed test-kind and mutation policy weakening', () =>
{
    const inputs = happyBundle();
    const mutations = [
        (receipt) => { receipt.requiredTestKinds['alpha-behavior'] = ['positive']; },
        (receipt) => { receipt.observedTestKinds['alpha-behavior'] = ['positive']; },
        (receipt) => { receipt.mutationStatus['alpha-behavior'].mutationRequired = false; },
        (receipt) => { receipt.mutationStatus['alpha-behavior'].mutationStatus = 'failed'; },
        (receipt) => { receipt.mutationStatus['alpha-behavior'].qualified = false; },
        (receipt) => { receipt.mutationStatus['alpha-behavior'].behaviorId = 'beta-behavior'; }
    ];
    for (const mutate of mutations)
    {
        const receipt = join(inputs);
        mutate(receipt);
        receipt.contentDigest = digestReceipt(receipt);
        assert.throws(
            () => validatePreRuntimeReceipt(receipt, { behaviorCatalog: inputs.catalog }),
            /current catalog authority|requires qualified test and mutation evidence/u
        );
    }
});

test('receipt contentDigest is recomputable', () =>
{
    const inputs = happyBundle();
    const receipt = join(inputs);
    const recomputed = createHash('sha256')
        .update(JSON.stringify(stable(
            Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
        )), 'utf8')
        .digest('hex');
    assert.equal(receipt.contentDigest, `sha256:${recomputed}`);
});

test('independent verifier rejects resealed missing or source-only build identities', () =>
{
    const inputs = happyBundle();
    const sourceOnlyReceipt = join(inputs);
    const injected = structuredClone(sourceOnlyReceipt);
    injected.buildIdentities['alpha-fact-extractor'] = {
        artifactId: 'forged-build',
        receiptDigest: '1'.repeat(64),
        artifactDigest: '2'.repeat(64)
    };
    injected.contentDigest = digestReceipt(injected);
    assert.throws(
        () => validatePreRuntimeReceipt(injected, { factExtractorRegistry: inputs.factExtractorRegistry }),
        /source-only extractor/u
    );

    const compiledRegistry = makeFactExtractorRegistry(inputs.catalog, {
        'alpha-fact-extractor': 'alpha-observation'
    });
    const missing = structuredClone(sourceOnlyReceipt);
    missing.registryDigest = `sha256:${digestValue(compiledRegistry)}`;
    missing.buildIdentities = {};
    missing.contentDigest = digestReceipt(missing);
    assert.throws(
        () => validatePreRuntimeReceipt(missing, { factExtractorRegistry: compiledRegistry }),
        /exactly cover required compiled extractor authorities/u
    );
});

test('mutation-required behavior with missing mutation evidence fails per-behavior', () =>
{
    const inputs = happyBundle();
    const receipt = join({ ...inputs, mutationEvidenceReceipt: null });
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) =>
        reason.includes('alpha-behavior') && reason.includes('mutation')));
    assert.equal(receipt.mutationStatus['alpha-behavior'].qualified, false);
});
