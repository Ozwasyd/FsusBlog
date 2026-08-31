import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    assertBehaviorGraphQualified,
    assertJoinerDoesNotImportProducers,
    behaviorGraphSchema,
    digestValue,
    joinBehaviorGraph,
    recomputeContentDigest,
    root,
    sealDocClaimVerificationReceipt,
    sealGeneratedSectionCheckReceipt,
    sealOwnerBindingReceipt,
    validateBehaviorGraphReceipt
} from '../../tools/contracts/behavior-graph-join.mjs';
import { buildReceipt, sealReceipt } from '../../tools/fact-extractors/receipt.mjs';
import { sealMutationEvidenceReceipt } from '../../tools/test/mutation-evidence-receipt.mjs';

const joinerPath = path.join(root, 'tools/contracts/behavior-graph-join.mjs');
const checkerPath = path.join(root, 'tools/contracts/check-behavior-graph.mjs');

const SOURCE_COMMIT = 'a'.repeat(40);
const WORKTREE_FP = 'b'.repeat(64);
const EXTRACTOR_DIGEST = 'c'.repeat(64);
const INPUT_DIGEST = 'e'.repeat(64);

function stable (value)
{
    if (Array.isArray(value))
    {
        return value.map(stable);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function digestTestEvidence (receipt)
{
    const content = structuredClone(receipt);
    delete content.contentDigest;
    return `sha256:${createHash('sha256').update(JSON.stringify(stable(content)), 'utf8').digest('hex')}`;
}

function makeCatalog (overrides = {})
{
    const catalog = {
        schema: 'fsusblog.behavior-contract-catalog.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        domains: ['testing', 'documentation'],
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
                documentationRationale: 'Public alpha contract must be documented.',
                allowedClaimTypes: ['behavioral'],
                releaseQualification: true,
                coverageIds: ['alpha-behavior'],
                documents: ['docs/alpha.md']
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
                documentationRationale: 'Public beta contract must be documented.',
                allowedClaimTypes: ['behavioral'],
                releaseQualification: true,
                coverageIds: ['beta-behavior'],
                documents: ['docs/beta.md']
            }
        ]
    };
    return { ...catalog, ...overrides, contracts: overrides.contracts ?? catalog.contracts };
}

function catalogDigest (catalog)
{
    return digestValue(catalog);
}

function makeFactExtractorRegistry (catalog = makeCatalog(), compiledArtifacts = {})
{
    return {
        schema: 'fsusblog.behavior-fact-extractor-registry.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        extractors: catalog.extractors.map((entry) =>
        {
            const requiredBuildArtifact = compiledArtifacts[entry.id] ?? null;
            return {
                id: entry.id,
                kind: requiredBuildArtifact == null ? 'canonical-catalog' : 'compiled-assembly',
                entrypoint: entry.path,
                consumedInputs: [entry.path],
                outputSchema: 'fsusblog.fact-observation-receipt.v1',
                requiredBuildArtifact,
                hermeticPolicy: requiredBuildArtifact == null ? 'declared-inputs' : 'exact-build-receipt',
                ownedBehaviorIds: catalog.contracts
                    .filter((contract) => contract.factExtractorId === entry.id)
                    .map((contract) => contract.id)
            };
        })
    };
}

const REGISTRY_DIGEST = digestValue(makeFactExtractorRegistry());

function makeFact ({
    extractorId = 'alpha-fact-extractor',
    behaviorIds = ['alpha-behavior'],
    observations = { limit: 10 },
    status = 'ok',
    failureReasons = [],
    sourceCommit = SOURCE_COMMIT,
    worktreeFingerprint = WORKTREE_FP,
    buildIdentity = null,
    registryDigest = REGISTRY_DIGEST
} = {})
{
    return sealReceipt(buildReceipt({
        extractorId,
        behaviorIds,
        sourceCommit,
        worktreeFingerprint,
        buildIdentity,
        extractorDigest: EXTRACTOR_DIGEST,
        registryDigest,
        consumedInputDigests: [{ path: 'tools/alpha/extract.mjs', digest: INPUT_DIGEST }],
        observations: status === 'ok' ? observations : observations,
        status,
        failureReasons
    }));
}

function makeOwner ({
    catalog,
    bindings = [
        {
            behaviorId: 'alpha-behavior',
            language: 'javascript',
            sourcePath: 'tools/alpha/extract.mjs',
            symbol: 'extract',
            bindingKind: 'marker',
            sourceDigest: '1'.repeat(64),
            status: 'ok'
        },
        {
            behaviorId: 'beta-behavior',
            language: 'javascript',
            sourcePath: 'tools/beta/extract.mjs',
            symbol: 'extract',
            bindingKind: 'marker',
            sourceDigest: '2'.repeat(64),
            status: 'ok'
        }
    ],
    errors = []
} = {})
{
    const digest = catalogDigest(catalog);
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
    });
}

function makeTestEvidence ({
    catalog,
    evidence,
    errors = [],
    run = { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' },
    sourceState = {
        commit: SOURCE_COMMIT,
        worktreeFingerprint: `sha256:${WORKTREE_FP}`
    }
} = {})
{
    const digest = catalogDigest(catalog);
    const coverage = catalog.contracts
        .filter((contract) => contract.status === 'active')
        .map((contract) =>
        {
            const satisfied = contract.requiredTestKinds.filter((kind) =>
                (evidence ?? []).some((row) =>
                    row.behaviorId === contract.id
          && row.testKind === kind
          && row.discovered === true
          && row.executed === true
          && row.outcome === 'passed'
          && row.run?.attemptKind !== 'diagnostic'));
            const missing = contract.requiredTestKinds.filter((kind) => !satisfied.includes(kind));
            return {
                behaviorId: contract.id,
                requiredTestKinds: [...contract.requiredTestKinds],
                satisfiedTestKinds: satisfied,
                missingTestKinds: missing,
                status: missing.length === 0 ? 'ok' : 'failed'
            };
        });
    const receipt = {
        schema: 'fsusblog.behavior-test-evidence-receipt.v1',
        catalogDigest: digest,
        worktreeDigest: SOURCE_COMMIT,
        run,
        sourceState,
        sourceClosureDigest: `sha256:${'f'.repeat(64)}`,
        rawResultDigest: `sha256:${'9'.repeat(64)}`,
        bindings: (evidence ?? []).map((row) => ({
            behaviorId: row.behaviorId,
            testKind: row.testKind,
            canonicalTestId: row.canonicalTestId,
            framework: row.framework ?? 'node-tap',
            sourcePath: row.sourcePath ?? 'tests/tools/sample.test.mjs',
            fullyQualifiedName: row.fullyQualifiedName ?? row.canonicalTestId,
            invariantIds: row.invariantIds ?? [],
            reasonId: row.reasonId ?? null,
            concurrencyHarness: row.concurrencyHarness ?? null,
            bindingKind: 'helper',
            line: 1
        })),
        evidence: evidence ?? [],
        coverage,
        errors
    };
    receipt.contentDigest = digestTestEvidence(receipt);
    return receipt;
}

function defaultEvidence (catalog)
{
    const rows = [];
    for (const contract of catalog.contracts.filter((entry) => entry.status === 'active'))
    {
        for (const kind of contract.requiredTestKinds)
        {
            rows.push({
                behaviorId: contract.id,
                testKind: kind,
                canonicalTestId: `node-tap:tests/tools/${contract.id}.${kind}.test.mjs#${kind}`,
                framework: 'node-tap',
                sourcePath: `tests/tools/${contract.id}.${kind}.test.mjs`,
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
            });
        }
    }
    return rows;
}

function makeParseReceipt ({ catalog, claims })
{
    const receipt = {
        schema: 'fsusblog.doc-claim-parse-receipt.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        behaviorCatalogDigest: catalogDigest(catalog),
        claims: claims ?? []
    };
    return {
        ...receipt,
        contentDigest: digestValue(receipt)
    };
}

function locatedClaim ({
    claimId,
    behaviorId,
    claimType = 'scalar',
    factPath = 'limit',
    documentPath = 'docs/alpha.md',
    documentStatus = 'current',
    bodyText = 'limit is 10'
} = {})
{
    return {
        declaration: {
            claimId,
            behaviorId,
            claimType,
            factPath,
            render: 'scalar-inline'
        },
        location: {
            documentPath,
            claimStartLine: 1,
            claimEndLine: 4,
            documentStatus,
            headingPath: ['Alpha'],
            bodyKind: 'paragraph',
            bodyStartLine: 5,
            bodyEndLine: 5,
            bodyText
        }
    };
}

function makeVerification ({
    catalog,
    parseReceipt,
    factObservationDigests,
    results,
    status = 'ok',
    failureReasons = []
})
{
    return sealDocClaimVerificationReceipt({
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        parseReceiptDigest: parseReceipt.contentDigest,
        factObservationDigests,
        results,
        status,
        failureReasons
    });
}

function makeGenerated ({
    catalog,
    factObservationDigests,
    sections,
    status = 'ok',
    failureReasons = []
})
{
    return sealGeneratedSectionCheckReceipt({
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        sectionCatalogDigest: '8'.repeat(64),
        factObservationDigests,
        sections,
        status,
        failureReasons
    });
}

function defaultClaims ()
{
    return [
        locatedClaim({
            claimId: 'alpha.limit',
            behaviorId: 'alpha-behavior',
            factPath: 'limit',
            documentPath: 'docs/alpha.md',
            bodyText: 'limit is 10'
        }),
        locatedClaim({
            claimId: 'beta.enabled',
            behaviorId: 'beta-behavior',
            claimType: 'boolean',
            factPath: 'enabled',
            documentPath: 'docs/beta.md',
            bodyText: 'enabled is true'
        })
    ];
}

function defaultVerificationResults ()
{
    return [
        {
            claimId: 'alpha.limit',
            behaviorId: 'alpha-behavior',
            claimType: 'scalar',
            documentPath: 'docs/alpha.md',
            documentStatus: 'current',
            factPath: 'limit',
            status: 'verified',
            reason: 'body matches observation'
        },
        {
            claimId: 'beta.enabled',
            behaviorId: 'beta-behavior',
            claimType: 'boolean',
            documentPath: 'docs/beta.md',
            documentStatus: 'current',
            factPath: 'enabled',
            status: 'verified',
            reason: 'body matches observation'
        }
    ];
}

function happyBundle (mutators = {})
{
    const catalog = makeCatalog(mutators.catalog);
    const factExtractorRegistry = mutators.factExtractorRegistry ?? makeFactExtractorRegistry(catalog);
    const alphaFact = makeFact({
        extractorId: 'alpha-fact-extractor',
        behaviorIds: ['alpha-behavior'],
        observations: { limit: 10 },
        buildIdentity: mutators.buildIdentity ?? null
    });
    const betaFact = makeFact({
        extractorId: 'beta-fact-extractor',
        behaviorIds: ['beta-behavior'],
        observations: { enabled: true },
        buildIdentity: mutators.buildIdentity ?? null
    });
    const facts = mutators.facts ?? [alphaFact, betaFact];
    const owner = mutators.owner ?? makeOwner({ catalog });
    const evidence = mutators.evidence ?? defaultEvidence(catalog);
    const testEvidence = mutators.testEvidence ?? makeTestEvidence({
        catalog,
        evidence,
        errors: mutators.testErrors ?? []
    });
    const claims = mutators.claims ?? defaultClaims();
    const parseReceipt = mutators.parseReceipt ?? makeParseReceipt({ catalog, claims });
    const factObservationDigests = facts.map((receipt) => ({
        extractorId: receipt.extractorId,
        contentDigest: receipt.contentDigest
    }));
    const verification = mutators.verification ?? makeVerification({
        catalog,
        parseReceipt,
        factObservationDigests,
        results: mutators.verificationResults ?? defaultVerificationResults(),
        status: mutators.verificationStatus ?? 'ok',
        failureReasons: mutators.verificationFailures ?? []
    });
    const generated = mutators.generated ?? makeGenerated({
        catalog,
        factObservationDigests,
        sections: mutators.generatedSections ?? [],
        status: mutators.generatedStatus ?? 'ok',
        failureReasons: mutators.generatedFailures ?? []
    });
    return {
        catalog,
        factExtractorRegistry,
        ownerReceipt: owner,
        factObservationReceipts: facts,
        testEvidenceReceipt: testEvidence,
        docClaimParseReceipt: parseReceipt,
        docClaimVerificationReceipt: verification,
        generatedSectionCheckReceipt: generated
        , ...(mutators.mutationEvidenceReceipt != null
            ? { mutationEvidenceReceipt: mutators.mutationEvidenceReceipt }
            : {})
    };
}

function makeMutationEvidence ({ catalog, ownerReceipt, status = 'ok', qualified = true, sourceCommit = SOURCE_COMMIT } = {})
{
    return sealMutationEvidenceReceipt({
        sourceCommit,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        selectionDigest: '6'.repeat(64),
        ownerReceiptDigest: ownerReceipt.contentDigest,
        testBindingScanDigest: '7'.repeat(64),
        rawReportDigest: '8'.repeat(64),
        rawTraceDigest: '9'.repeat(64),
        attributions: [{ mutantId: 'src:alpha:1', behaviorId: 'alpha-behavior', sourcePath: 'tools/alpha/extract.mjs', symbol: 'extract', mutator: 'Boolean', status: qualified ? 'Killed' : 'Survived', coveredTestIds: ['alpha'], killedTestIds: qualified ? ['alpha'] : [] }],
        qualifications: [{ behaviorId: 'alpha-behavior', mutationRequired: true, executed: 1, killed: qualified ? 1 : 0, survived: qualified ? 0 : 1, timeout: 0, noCoverage: 0, score: qualified ? 100 : 0, minimumMutationScore: 70, qualified, failures: qualified ? [] : ['alpha-behavior has 1 survived mutant(s)'] }],
        blockedCount: 0,
        status,
        failureReasons: status === 'ok' ? [] : ['alpha-behavior has 1 survived mutant(s)']
    });
}

test('joiner source has zero producer/parser/scanner imports and forbidden residual patterns', () =>
{
    const source = readFileSync(joinerPath, 'utf8');
    assertJoinerDoesNotImportProducers(source);
    const importLines = source.split(/\r?\n/u).filter((line) => /^\s*import\b/u.test(line)).join('\n');
    assert.doesNotMatch(importLines, /behavior-owner-binding|behavior-test-binding|doc-claim|child_process|prose-claim-verifier/u);
    assert.doesNotMatch(source, /spawnSync\s*\(|execFileSync\s*\(/u);
    assert.doesNotMatch(source, /warning-only|secondJoiner|compatSchema|optionalJoin\s*[:=]|defaultPass\s*[:=]/iu);
    const checker = readFileSync(checkerPath, 'utf8');
    assertJoinerDoesNotImportProducers(checker, 'check-behavior-graph');
    assert.doesNotMatch(checker, /spawnSync\s*\(|child_process|scanBehavior|parseRepository|runExtractor/u);
});

test('happy path seals qualified BehaviorGraph with recomputable digest', () =>
{
    const inputs = happyBundle();
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.schema, behaviorGraphSchema);
    assert.equal(receipt.status, 'ok');
    assert.deepEqual(receipt.buildIdentities, {});
    assert.deepEqual(receipt.failureReasons, []);
    assert.equal(receipt.contentDigest, recomputeContentDigest(receipt));
    validateBehaviorGraphReceipt(receipt);
    assertBehaviorGraphQualified(receipt);
    assert.equal(receipt.behaviorNodes.length, 2);
    assert.ok(receipt.behaviorNodes.every((node) => node.qualification === 'qualified'));
    assert.equal(receipt.sourceIdentity.commit, SOURCE_COMMIT);
    assert.equal(receipt.sourceIdentity.worktreeFingerprint, WORKTREE_FP);
});

test('compiled fact extractors preserve distinct canonical build identities per extractor', () =>
{
    const catalog = makeCatalog();
    const factExtractorRegistry = makeFactExtractorRegistry(catalog, {
        'alpha-fact-extractor': 'alpha-observation',
        'beta-fact-extractor': 'beta-observation'
    });
    const registryDigest = digestValue(factExtractorRegistry);
    const alphaBuild = { artifactId: 'alpha-observation', receiptDigest: '1'.repeat(64), artifactDigest: '2'.repeat(64) };
    const betaBuild = { artifactId: 'beta-observation', receiptDigest: '3'.repeat(64), artifactDigest: '4'.repeat(64) };
    const facts = [
        makeFact({ extractorId: 'alpha-fact-extractor', behaviorIds: ['alpha-behavior'], observations: { limit: 10 }, buildIdentity: alphaBuild, registryDigest }),
        makeFact({ extractorId: 'beta-fact-extractor', behaviorIds: ['beta-behavior'], observations: { enabled: true }, buildIdentity: betaBuild, registryDigest })
    ];

    const receipt = joinBehaviorGraph(happyBundle({ factExtractorRegistry, facts }));
    assert.equal(receipt.status, 'ok');
    assert.deepEqual(receipt.buildIdentities, {
        'alpha-fact-extractor': alphaBuild,
        'beta-fact-extractor': betaBuild
    });
    assert.equal(receipt.registryDigest, registryDigest);
});

test('missing compiled build and same-extractor build conflicts fail closed', () =>
{
    const catalog = makeCatalog();
    const factExtractorRegistry = makeFactExtractorRegistry(catalog, {
        'alpha-fact-extractor': 'alpha-observation'
    });
    const registryDigest = digestValue(factExtractorRegistry);
    const beta = makeFact({ extractorId: 'beta-fact-extractor', behaviorIds: ['beta-behavior'], observations: { enabled: true }, registryDigest });
    const missingBuild = joinBehaviorGraph(happyBundle({
        factExtractorRegistry,
        facts: [
            makeFact({ extractorId: 'alpha-fact-extractor', behaviorIds: ['alpha-behavior'], observations: { limit: 10 }, registryDigest }),
            beta
        ]
    }));
    assert.equal(missingBuild.status, 'failed');
    assert.ok(missingBuild.failureReasons.some((reason) => /missing required compiled buildIdentity for alpha-observation/u.test(reason)));

    const first = makeFact({
        extractorId: 'alpha-fact-extractor', behaviorIds: ['alpha-behavior'], observations: { limit: 10 }, registryDigest,
        buildIdentity: { artifactId: 'alpha-observation', receiptDigest: '1'.repeat(64), artifactDigest: '2'.repeat(64) }
    });
    const conflicting = makeFact({
        extractorId: 'alpha-fact-extractor', behaviorIds: ['alpha-behavior'], observations: { limit: 10 }, registryDigest,
        buildIdentity: { artifactId: 'alpha-observation', receiptDigest: '1'.repeat(64), artifactDigest: '9'.repeat(64) }
    });
    const conflict = joinBehaviorGraph(happyBundle({ factExtractorRegistry, facts: [first, conflicting, beta] }));
    assert.equal(conflict.status, 'failed');
    assert.ok(conflict.failureReasons.some((reason) => /conflicting build identities within one extractor authority/u.test(reason)));
});

test('fact extractor registry identity drift fails closed', () =>
{
    const inputs = happyBundle();
    const drifted = structuredClone(inputs.factObservationReceipts[0]);
    drifted.registryDigest = 'f'.repeat(64);
    drifted.contentDigest = digestValue(Object.fromEntries(
        Object.entries(drifted).filter(([key]) => key !== 'contentDigest')
    ));
    inputs.factObservationReceipts[0] = drifted;
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) => /registryDigest does not match/u.test(reason)));
});

test('mutation proof is linked through Behavior ID and strengthens the DocClaim-qualified node', () =>
{
    const initial = happyBundle();
    const catalog = makeCatalog({
        contracts: initial.catalog.contracts.map((contract) => contract.id === 'alpha-behavior'
            ? { ...contract, mutationPolicy: { mutationRequired: true, minimumMutationScore: 70, requireExecutedMutants: true, allowedEquivalentMutantPolicy: 'none' } }
            : contract)
    });
    const inputs = happyBundle({ catalog });
    inputs.mutationEvidenceReceipt = makeMutationEvidence({ catalog, ownerReceipt: inputs.ownerReceipt });
    const receipt = joinBehaviorGraph(inputs);
    const alpha = receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior');
    assert.equal(receipt.status, 'ok');
    assert.equal(alpha.mutationStatus, 'ok');
    assert.equal(receipt.mutationEdges.length, 1);
    assert.equal(receipt.documentClaimEdges.some((edge) => edge.behaviorId === 'alpha-behavior'), true);
});

test('survived mutant and stale evidence fail closed without changing DocClaim inputs', () =>
{
    const initial = happyBundle();
    const catalog = makeCatalog({
        contracts: initial.catalog.contracts.map((contract) => contract.id === 'alpha-behavior'
            ? { ...contract, mutationPolicy: { mutationRequired: true, minimumMutationScore: 70, requireExecutedMutants: true, allowedEquivalentMutantPolicy: 'none' } }
            : contract)
    });
    const inputs = happyBundle({ catalog });
    inputs.mutationEvidenceReceipt = makeMutationEvidence({ catalog, ownerReceipt: inputs.ownerReceipt, status: 'failed', qualified: false });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior').mutationStatus, 'failed');
    assert.ok(receipt.conflicts.some((entry) => entry.kind === 'mutation-failed'));
});

test('1) implementation value 10 vs verified doc still 5 fails even if lastVerifiedCommit would have passed old gates', () =>
{
    const inputs = happyBundle({
        verificationResults: [
            {
                claimId: 'alpha.limit',
                behaviorId: 'alpha-behavior',
                claimType: 'scalar',
                documentPath: 'docs/alpha.md',
                documentStatus: 'current',
                factPath: 'limit',
                status: 'failed',
                reason: 'body claims 5 but observation limit=10'
            },
            {
                claimId: 'beta.enabled',
                behaviorId: 'beta-behavior',
                claimType: 'boolean',
                documentPath: 'docs/beta.md',
                documentStatus: 'current',
                factPath: 'enabled',
                status: 'verified',
                reason: 'body matches observation'
            }
        ],
        verificationStatus: 'failed',
        verificationFailures: ['alpha.limit body claims 5 but observation limit=10']
    });
    // Explicitly ensure no lastVerifiedCommit path can rescue this.
    assert.equal(Object.hasOwn(inputs.docClaimVerificationReceipt, 'lastVerifiedCommit'), false);
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    const alpha = receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior');
    assert.equal(alpha.qualification, 'failed');
    assert.equal(alpha.docStatus, 'failed');
    assert.ok(receipt.failureReasons.some((reason) => /alpha\.limit|claims 5|limit/u.test(reason)));
    assert.ok(receipt.conflicts.some((entry) => entry.kind === 'doc-conflict' && entry.behaviorId === 'alpha-behavior'));
});

test('2) unrelated docs/tests file churn does not affect join when receipts are identical', () =>
{
    const first = joinBehaviorGraph(happyBundle());
    // Simulate unrelated markdown/test file edits by not changing any sealed receipt.
    const second = joinBehaviorGraph(happyBundle());
    assert.equal(first.contentDigest, second.contentDigest);
    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'ok');
});

test('3) owner+fact present but boundary test missing fails independently', () =>
{
    const catalog = makeCatalog();
    const evidence = defaultEvidence(catalog).filter((row) =>
        !(row.behaviorId === 'alpha-behavior' && row.testKind === 'boundary'));
    const inputs = happyBundle({
        catalog,
        evidence,
        testErrors: ['alpha-behavior missing this-round passed evidence for kind(s): boundary']
    });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    const alpha = receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior');
    assert.equal(alpha.ownerStatus, 'ok');
    assert.equal(alpha.factStatus, 'ok');
    assert.equal(alpha.testStatus, 'failed');
    assert.ok(receipt.missing.some((entry) => entry.kind === 'missing-test-kind' && entry.behaviorId === 'alpha-behavior'));
});

test('4) claim references non-existent factPath fails', () =>
{
    const claims = [
        locatedClaim({
            claimId: 'alpha.missing',
            behaviorId: 'alpha-behavior',
            factPath: 'doesNotExist',
            documentPath: 'docs/alpha.md'
        }),
        locatedClaim({
            claimId: 'beta.enabled',
            behaviorId: 'beta-behavior',
            claimType: 'boolean',
            factPath: 'enabled',
            documentPath: 'docs/beta.md'
        })
    ];
    const inputs = happyBundle({
        claims,
        verificationResults: [
            {
                claimId: 'alpha.missing',
                behaviorId: 'alpha-behavior',
                claimType: 'scalar',
                documentPath: 'docs/alpha.md',
                documentStatus: 'current',
                factPath: 'doesNotExist',
                status: 'failed',
                reason: 'factPath doesNotExist not found in receipts'
            },
            {
                claimId: 'beta.enabled',
                behaviorId: 'beta-behavior',
                claimType: 'boolean',
                documentPath: 'docs/beta.md',
                documentStatus: 'current',
                factPath: 'enabled',
                status: 'verified',
                reason: 'body matches observation'
            }
        ],
        verificationStatus: 'failed',
        verificationFailures: ['factPath doesNotExist not found in receipts']
    });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.missing.some((entry) =>
        entry.kind === 'missing-fact'
    && entry.behaviorId === 'alpha-behavior'
    && /doesNotExist/u.test(entry.reason)));
});

test('5) observation from old build/source is refused', () =>
{
    const stale = makeFact({
        extractorId: 'alpha-fact-extractor',
        behaviorIds: ['alpha-behavior'],
        observations: { limit: 10 },
        sourceCommit: 'f'.repeat(40),
        worktreeFingerprint: WORKTREE_FP
    });
    const beta = makeFact({
        extractorId: 'beta-fact-extractor',
        behaviorIds: ['beta-behavior'],
        observations: { enabled: true }
    });
    const inputs = happyBundle({ facts: [stale, beta] });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.conflicts.some((entry) =>
        entry.kind === 'identity-mismatch' && /fact:alpha-fact-extractor/u.test(entry.anchor)));
});

test('6) two current docs with conflicting verified values for same behavior fail', () =>
{
    const claims = [
        locatedClaim({
            claimId: 'alpha.limit.a',
            behaviorId: 'alpha-behavior',
            factPath: 'limit',
            documentPath: 'docs/alpha.md',
            bodyText: 'limit is 10'
        }),
        locatedClaim({
            claimId: 'alpha.limit.b',
            behaviorId: 'alpha-behavior',
            factPath: 'limit',
            documentPath: 'docs/alpha-alt.md',
            bodyText: 'limit is 5'
        }),
        locatedClaim({
            claimId: 'beta.enabled',
            behaviorId: 'beta-behavior',
            claimType: 'boolean',
            factPath: 'enabled',
            documentPath: 'docs/beta.md'
        })
    ];
    const inputs = happyBundle({
        claims,
        verificationResults: [
            {
                claimId: 'alpha.limit.a',
                behaviorId: 'alpha-behavior',
                claimType: 'scalar',
                documentPath: 'docs/alpha.md',
                documentStatus: 'current',
                factPath: 'limit',
                status: 'verified',
                reason: 'matches 10'
            },
            {
                claimId: 'alpha.limit.b',
                behaviorId: 'alpha-behavior',
                claimType: 'scalar',
                documentPath: 'docs/alpha-alt.md',
                documentStatus: 'current',
                factPath: 'limit',
                status: 'failed',
                reason: 'conflicts with observation/other claim value 5 vs 10'
            },
            {
                claimId: 'beta.enabled',
                behaviorId: 'beta-behavior',
                claimType: 'boolean',
                documentPath: 'docs/beta.md',
                documentStatus: 'current',
                factPath: 'enabled',
                status: 'verified',
                reason: 'ok'
            }
        ],
        verificationStatus: 'failed',
        verificationFailures: ['alpha-behavior conflict between current docs for factPath limit']
    });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.conflicts.some((entry) => entry.kind === 'doc-conflict' && entry.behaviorId === 'alpha-behavior'));
});

test('7) public required behavior without docs fails', () =>
{
    const claims = [
        locatedClaim({
            claimId: 'beta.enabled',
            behaviorId: 'beta-behavior',
            claimType: 'boolean',
            factPath: 'enabled',
            documentPath: 'docs/beta.md'
        })
    ];
    const inputs = happyBundle({
        claims,
        verificationResults: [
            {
                claimId: 'beta.enabled',
                behaviorId: 'beta-behavior',
                claimType: 'boolean',
                documentPath: 'docs/beta.md',
                documentStatus: 'current',
                factPath: 'enabled',
                status: 'verified',
                reason: 'ok'
            }
        ]
    });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    const alpha = receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior');
    assert.equal(alpha.docStatus, 'failed');
    assert.ok(receipt.missing.some((entry) => entry.kind === 'missing-doc' && entry.behaviorId === 'alpha-behavior'));
});

test('8) retired behavior with current claim fails', () =>
{
    const catalog = makeCatalog({
        contracts: [
            {
                id: 'alpha-behavior',
                domain: 'testing',
                risk: 'high',
                status: 'retired',
                implementationOwnerCardinality: 'one',
                allowedImplementationOwnerRoles: [],
                factExtractorId: 'alpha-fact-extractor',
                requiredTestKinds: ['positive'],
                documentationPolicy: 'required',
                documentationRationale: 'retired',
                allowedClaimTypes: ['behavioral'],
                releaseQualification: false,
                coverageIds: ['alpha-behavior'],
                documents: ['docs/alpha.md']
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
                documentationRationale: 'Public beta contract must be documented.',
                allowedClaimTypes: ['behavioral'],
                releaseQualification: true,
                coverageIds: ['beta-behavior'],
                documents: ['docs/beta.md']
            }
        ]
    });
    const inputs = happyBundle({
        catalog,
        owner: makeOwner({
            catalog,
            bindings: [
                {
                    behaviorId: 'beta-behavior',
                    language: 'javascript',
                    sourcePath: 'tools/beta/extract.mjs',
                    symbol: 'extract',
                    bindingKind: 'marker',
                    sourceDigest: '2'.repeat(64),
                    status: 'ok'
                }
            ]
        }),
        facts: [
            makeFact({
                extractorId: 'beta-fact-extractor',
                behaviorIds: ['beta-behavior'],
                observations: { enabled: true }
            })
        ],
        claims: [
            locatedClaim({
                claimId: 'alpha.limit',
                behaviorId: 'alpha-behavior',
                factPath: 'limit',
                documentPath: 'docs/alpha.md'
            }),
            locatedClaim({
                claimId: 'beta.enabled',
                behaviorId: 'beta-behavior',
                claimType: 'boolean',
                factPath: 'enabled',
                documentPath: 'docs/beta.md'
            })
        ],
        verificationResults: [
            {
                claimId: 'alpha.limit',
                behaviorId: 'alpha-behavior',
                claimType: 'scalar',
                documentPath: 'docs/alpha.md',
                documentStatus: 'current',
                factPath: 'limit',
                status: 'verified',
                reason: 'stale retired claim still verified'
            },
            {
                claimId: 'beta.enabled',
                behaviorId: 'beta-behavior',
                claimType: 'boolean',
                documentPath: 'docs/beta.md',
                documentStatus: 'current',
                factPath: 'enabled',
                status: 'verified',
                reason: 'ok'
            }
        ],
        evidence: defaultEvidence(catalog)
    });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.conflicts.some((entry) => entry.kind === 'retired-claim' && entry.behaviorId === 'alpha-behavior'));
    const alpha = receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior');
    assert.equal(alpha.qualification, 'failed');
    assert.equal(alpha.status, 'retired');
});

test('9) extractor failed observation refuses historical fallback and fails join', () =>
{
    const failed = makeFact({
        extractorId: 'alpha-fact-extractor',
        behaviorIds: ['alpha-behavior'],
        observations: {},
        status: 'failed',
        failureReasons: ['extractor hard failure']
    });
    const beta = makeFact({
        extractorId: 'beta-fact-extractor',
        behaviorIds: ['beta-behavior'],
        observations: { enabled: true }
    });
    // Joiner is given only the failed current receipt — no older artifact path is consulted.
    const inputs = happyBundle({ facts: [failed, beta] });
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((reason) => /alpha-fact-extractor.*failed|refuses historical fallback/u.test(reason)));
    const alpha = receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior');
    assert.equal(alpha.factStatus, 'failed');
});

test('duplicate owners fail independently of docs and tests', () =>
{
    const catalog = makeCatalog();
    const owner = makeOwner({
        catalog,
        bindings: [
            {
                behaviorId: 'alpha-behavior',
                language: 'javascript',
                sourcePath: 'tools/alpha/extract.mjs',
                symbol: 'extract',
                bindingKind: 'marker',
                sourceDigest: '1'.repeat(64),
                status: 'ok'
            },
            {
                behaviorId: 'alpha-behavior',
                language: 'javascript',
                sourcePath: 'tools/alpha/wrapper.mjs',
                symbol: 'wrapper',
                bindingKind: 'marker',
                sourceDigest: '3'.repeat(64),
                status: 'ok'
            },
            {
                behaviorId: 'beta-behavior',
                language: 'javascript',
                sourcePath: 'tools/beta/extract.mjs',
                symbol: 'extract',
                bindingKind: 'marker',
                sourceDigest: '2'.repeat(64),
                status: 'ok'
            }
        ],
        errors: ['alpha-behavior active one-owner behavior has 2 owners']
    });
    const receipt = joinBehaviorGraph(happyBundle({ catalog, owner }));
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.conflicts.some((entry) => entry.kind === 'duplicate-owner' && entry.behaviorId === 'alpha-behavior'));
});

test('skipped/diagnostic evidence cannot qualify', () =>
{
    const catalog = makeCatalog();
    const evidence = defaultEvidence(catalog).map((row) =>
    {
        if (row.behaviorId === 'alpha-behavior' && row.testKind === 'boundary')
        {
            return {
                ...row,
                outcome: 'skipped',
                run: { id: 'round-1', attemptKind: 'diagnostic', evidenceClass: 'diagnostic' }
            };
        }
        return row;
    });
    const receipt = joinBehaviorGraph(happyBundle({
        catalog,
        evidence,
        testErrors: ['boundary skipped']
    }));
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.missing.some((entry) => entry.kind === 'missing-test-kind'));
    assert.ok(receipt.conflicts.some((entry) => entry.kind === 'non-qualifying-test'));
});

test('catalog digest drift across receipts fails closed', () =>
{
    const inputs = happyBundle();
    inputs.ownerReceipt = {
        ...inputs.ownerReceipt,
        catalogDigest: '0'.repeat(64),
        contentDigest: null
    };
    inputs.ownerReceipt.contentDigest = digestValue(
        Object.fromEntries(Object.entries(inputs.ownerReceipt).filter(([key]) => key !== 'contentDigest'))
    );
    const receipt = joinBehaviorGraph(inputs);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.conflicts.some((entry) => entry.kind === 'identity-mismatch' && entry.anchor === 'ownerReceipt'));
});

test('behavior nodes are stable-sorted by behaviorId and single failure is localizable', () =>
{
    const catalog = makeCatalog();
    const evidence = defaultEvidence(catalog).filter((row) =>
        !(row.behaviorId === 'beta-behavior' && row.testKind === 'positive'));
    const receipt = joinBehaviorGraph(happyBundle({
        catalog,
        evidence,
        testErrors: ['beta missing positive']
    }));
    const ids = receipt.behaviorNodes.map((node) => node.behaviorId);
    assert.deepEqual(ids, [...ids].sort());
    const beta = receipt.behaviorNodes.find((node) => node.behaviorId === 'beta-behavior');
    assert.equal(beta.qualification, 'failed');
    assert.ok(beta.failureReasons.some((reason) => /positive/u.test(reason)));
    assert.equal(receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior').testStatus, 'ok');
});
