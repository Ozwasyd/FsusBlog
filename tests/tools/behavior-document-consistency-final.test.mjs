import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import {
    buildFinalConsistencyReport,
    buildVerifiedFinalConsistencyReport,
    scanZeroLegacyGovernance,
    validateFinalReport,
    validateZeroLegacyScan,
    zeroLegacyRequiredPathClasses,
    zeroLegacyScanSchema
} from '../../tools/docs/behavior-document-consistency-final.mjs'
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs'
import { createZeroLegacyScannerFixture } from './support/zero-legacy-scanner-fixture.mjs'
const { sealDocClaimVerificationReceipt, sealGeneratedSectionCheckReceipt, sealOwnerBindingReceipt } = await import(new URL('../../tools/contracts/behavior-graph-join.mjs', import.meta.url));
const { buildReceipt: buildFactObservationReceipt, semanticDigestFromReceipt } = await import(new URL('../../tools/fact-extractors/receipt.mjs', import.meta.url));
const { loadPostRuntimeProducerRegistry } = await import(new URL('../../tools/test-matrix/post-runtime-producer-registry.mjs', import.meta.url));
const { createRuntimeRoleMinimalV3Fixture } = await import(new URL('./support/runtime-role-minimal-v3-fixture.mjs', import.meta.url));

const commit = 'a'.repeat(40)
const fingerprint = 'b'.repeat(64)
const runId = 'final-round'
const repositorySourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const parserVersion = '1.59.1'
const parserBundle = fs.readFileSync(path.join(repositorySourceRoot, 'src/frontend/node_modules/playwright-core/lib/utilsBundleImpl/index.js'))
const parserPackage = fs.readFileSync(path.join(repositorySourceRoot, 'src/frontend/node_modules/playwright-core/package.json'))
const jsoncParserBundle = fs.readFileSync(path.join(repositorySourceRoot, 'src/frontend/node_modules/typescript/lib/typescript.js'))
const jsoncParserPackage = fs.readFileSync(path.join(repositorySourceRoot, 'src/frontend/node_modules/typescript/package.json'))
const parserConsumer = `${JSON.stringify({
    name: 'zero-legacy-fixture',
    version: '1.0.0',
    devDependencies: { '@playwright/test': '^1.59.1', typescript: '^6.0.3' }
}, null, 4)}\n`
const parserLock = `${JSON.stringify({
    name: 'zero-legacy-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
        '': { name: 'zero-legacy-fixture', version: '1.0.0', devDependencies: { '@playwright/test': '^1.59.1', typescript: '^6.0.3' } },
        'node_modules/@playwright/test': { version: parserVersion, dependencies: { playwright: parserVersion } },
        'node_modules/playwright': { version: parserVersion, dependencies: { 'playwright-core': parserVersion } },
        'node_modules/playwright-core': { version: parserVersion, integrity: 'sha512-fixture' },
        'node_modules/typescript': { version: '6.0.3', integrity: 'sha512-fixture' }
    }
}, null, 2)}\n`
const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const seal = (value, keepNull = false) => {
    const receipt = { ...value, contentDigest: null }
    const content = keepNull ? receipt : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    receipt.contentDigest = `sha256:${hash(content)}`
    return receipt
}
const emptyZeroLegacyScan = () => ({
    schema: zeroLegacyScanSchema,
    scanRoots: [
        { path: 'config', pathClass: 'config' },
        { path: 'docs', pathClass: 'docs' },
        { path: 'src', pathClass: 'production' },
        { path: 'tests', pathClass: 'tests' },
        { path: 'tools', pathClass: 'tools' }
    ],
    scannedFileCount: 0,
    pathClassCounts: Object.fromEntries(zeroLegacyRequiredPathClasses.map((pathClass) => [pathClass, 0])),
    findings: []
})
const sealBare = (value, keepNull = false) => {
    const receipt = seal(value, keepNull);
    receipt.contentDigest = receipt.contentDigest.replace(/^sha256:/u, '');
    return receipt;
};

function repositoryFixture(t, files)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zero-legacy-'))
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    const needsMachineParser = Object.entries(files).some(([relative, content]) =>
        /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx|jsonc?|ya?ml)$/iu.test(relative)
        || (/\.md$/iu.test(relative) && /(?:`{3,}|~{3,})(?:javascript|js|jsonc?|typescript|ts|ya?ml)\b/iu.test(String(content))))
    const suppliedConsumer = files['src/frontend/package.json'] === undefined
        ? JSON.parse(parserConsumer)
        : JSON.parse(String(files['src/frontend/package.json']))
    const admittedConsumer = `${JSON.stringify({
        name: 'zero-legacy-fixture',
        version: '1.0.0',
        ...suppliedConsumer,
        devDependencies: {
            '@playwright/test': '^1.59.1',
            typescript: '^6.0.3',
            ...suppliedConsumer.devDependencies
        }
    }, null, 4)}\n`
    const admittedFiles = needsMachineParser ? {
        ...files,
        'src/frontend/package.json': admittedConsumer,
        'src/frontend/package-lock.json': parserLock,
        'src/frontend/node_modules/playwright-core/package.json': parserPackage,
        'src/frontend/node_modules/playwright-core/lib/utilsBundleImpl/index.js': parserBundle,
        'src/frontend/node_modules/typescript/package.json': jsoncParserPackage,
        'src/frontend/node_modules/typescript/lib/typescript.js': jsoncParserBundle
    } : files
    for (const [relative, content] of Object.entries(admittedFiles))
    {
        const absolute = path.join(repositoryRoot, relative)
        fs.mkdirSync(path.dirname(absolute), { recursive: true })
        fs.writeFileSync(absolute, content)
    }
    return repositoryRoot
}

function sourceRepositoryFixture(t, files = {})
{
    const repositoryRoot = repositoryFixture(t, files)
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    fs.writeFileSync(path.join(repositoryRoot, '.git/info/exclude'), 'src/frontend/node_modules/\n')
    execFileSync('git', ['config', 'user.email', 'tests@fsusblog.local'], { cwd: repositoryRoot })
    execFileSync('git', ['config', 'user.name', 'FsusBlog Tests'], { cwd: repositoryRoot })
    execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'test: seal source state'], { cwd: repositoryRoot })
    return repositoryRoot
}

function fixture(overrides = {})
{
    const sourceRoot = overrides.sourceRoot ?? null;
    const admittedSourceRoot = overrides.admittedSourceRoot ?? sourceRoot;
    const sourceIdentity = sourceRoot === null
        ? { sourceCommit: commit, worktreeFingerprint: fingerprint }
        : sealSourceIdentity(sourceRoot);
    const { sourceCommit, worktreeFingerprint: sourceFingerprint } = sourceIdentity;
    // Complete current graph, but synthetic component evidence: never qualification.
    const catalog = JSON.parse(fs.readFileSync(new URL('../../config/contracts/behavior-contracts.json', import.meta.url), 'utf8'))
    const registry = loadPostRuntimeProducerRegistry()
    const active = catalog.contracts.filter((entry) => entry.status === 'active' && entry.releaseQualification)
    const preContracts = active.filter((entry) => entry.evidenceStage === 'pre-runtime')
    const catalogHash = digestCatalog(catalog)
    const owner = sealOwnerBindingReceipt({
        schema: 'fsusblog.behavior-owner-binding-receipt.v1',
        catalogDigest: catalogHash,
        worktreeDigest: sourceFingerprint,
        status: 'ok',
        bindingCount: active.length,
        bindings: active.map((entry) => ({
            behaviorId: entry.id, language: 'csharp', sourcePath: 'src/fixture.cs',
            symbol: 'Fixture', bindingKind: 'attribute', sourceDigest: '6'.repeat(64),
            catalogDigest: catalogHash, worktreeDigest: sourceFingerprint, status: 'ok'
        })),
        errors: []
    })
    const facts = [...new Set(active.map((entry) => entry.factExtractorId))].map((extractorId) =>
        buildFactObservationReceipt({
            extractorId,
            behaviorIds: active.filter((entry) => entry.factExtractorId === extractorId).map((entry) => entry.id),
            sourceCommit: sourceCommit, worktreeFingerprint: sourceFingerprint, buildIdentity: null,
            extractorDigest: '8'.repeat(64), registryDigest: '9'.repeat(64),
            consumedInputDigests: [{ path: 'config/fixture.json', digest: 'a'.repeat(64) }],
            observations: { alphaValue: true }, status: 'ok'
        }))
    const claims = sealBare({
        schema: 'fsusblog.doc-claim-parse-receipt.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        behaviorCatalogDigest: catalogHash,
        claims: active.map((entry) => ({
            declaration: {
                behaviorId: entry.id, claimId: `${entry.id}.fixture`,
                claimType: 'behavioral', factPath: 'alphaValue', render: 'scalar'
            },
            location: { documentPath: entry.documents?.[0] ?? 'docs/fixture.md' }
        }))
    })
    const factObservationDigests = facts.map((fact) => ({
        extractorId: fact.extractorId, contentDigest: fact.contentDigest
    }))
    const verification = sealDocClaimVerificationReceipt({
        sourceCommit: sourceCommit,
        worktreeFingerprint: sourceFingerprint,
        catalogDigest: catalogHash,
        parseReceiptDigest: claims.contentDigest,
        factObservationDigests,
        results: claims.claims.map((claim) => ({
            claimId: claim.declaration.claimId,
            behaviorId: claim.declaration.behaviorId,
            claimType: claim.declaration.claimType,
            documentPath: claim.location.documentPath,
            documentStatus: 'current',
            factPath: claim.declaration.factPath,
            status: 'verified',
            reason: 'claim matches current fact observation'
        })),
        status: 'ok'
    })
    const generated = sealGeneratedSectionCheckReceipt({
        sourceCommit: sourceCommit,
        worktreeFingerprint: sourceFingerprint,
        catalogDigest: catalogHash,
        sectionCatalogDigest: 'b'.repeat(64),
        factObservationDigests,
        sections: [],
        status: 'ok'
    })
    const admission = sealBare({
        schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
        run: { id: runId },
        source: { commit: sourceCommit, worktreeFingerprint: sourceFingerprint },
        worktree: { root: admittedSourceRoot ?? '/repo' },
        toolchain: { node: 'v24', dotnet: '10', platform: 'linux', architecture: 'x64', directoryBuildPropsDigest: '1'.repeat(64) },
        authorityDigests: {
            catalog: catalogHash, claim: claims.contentDigest, extractorRegistry: '9'.repeat(64),
            generatedSectionCatalog: generated.sectionCatalogDigest, generatedRenderer: 'c'.repeat(64),
            proseRenderer: 'd'.repeat(64), mutationCatalog: 'e'.repeat(64)
        },
        implementationOwner: { status: 'ok', bindingCount: active.length, contentDigest: owner.contentDigest },
        factObservations: Object.fromEntries(facts.map((fact) => [fact.extractorId, {
            status: 'ok', extractorDigest: fact.extractorDigest,
            semanticDigest: semanticDigestFromReceipt(fact), contentDigest: fact.contentDigest
        }])),
        minimalContractBuild: createRuntimeRoleMinimalV3Fixture(runId, sourceIdentity),
        generated: { status: 'ok', documentCount: 0, contentDigest: generated.contentDigest },
        prose: { status: 'ok', verifiedClaimCount: claims.claims.length, contentDigest: verification.contentDigest },
        mutationFixtures: { status: 'ok', caseCount: 1, contentDigest: 'f'.repeat(64) },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: [], durationMs: 1
    }, true)
    const pre = seal({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
        runIdentity: runId, sourceIdentity: { commit: sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}` },
        buildIdentities: {}, registryDigest: `sha256:${'9'.repeat(64)}`,
        catalogDigest: `sha256:${catalogHash}`,
        staticAdmissionDigest: `sha256:${admission.contentDigest}`,
        behaviorGraphDigest: `sha256:${'5'.repeat(64)}`,
        testEvidenceDigests: [`sha256:${'6'.repeat(64)}`],
        rawResultDigests: { testEvidence: `sha256:${'7'.repeat(64)}` },
        mutationEvidenceDigest: null,
        staticClaimVerificationDigest: verification.contentDigest,
        behaviorIds: preContracts.map((entry) => entry.id),
        requiredTestKinds: Object.fromEntries(preContracts.map((entry) => [entry.id, entry.requiredTestKinds])),
        observedTestKinds: Object.fromEntries(preContracts.map((entry) => [entry.id, entry.requiredTestKinds])),
        mutationStatus: Object.fromEntries(active.filter((entry) => entry.mutationPolicy?.mutationRequired)
            .map((entry) => [entry.id, {
                behaviorId: entry.id, mutationRequired: true, qualified: true,
                mutationStatus: 'passed', failures: []
            }])),
        missing: [], orphans: [], conflicts: [],
        runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const results = registry.producers.flatMap((producer) =>
        [...new Set(Object.values(producer.requiredObservations).flat())].sort().map((classId) => ({
            behaviorId: producer.behaviorId, producerId: producer.producerId,
            extractorId: catalog.contracts.find((entry) => entry.id === producer.behaviorId).factExtractorId,
            scope: ['release-identity-readiness', 'blue-green-containment'].includes(classId) ? 'release-deployment' : 'application',
            classId, status: 'ok',
            classReceiptPath: `.tmp/final/${classId}.json`,
            classReceiptDigest: `sha256:${hash({ classId })}`,
            rawReceiptPath: `.tmp/final/${classId}-raw.json`,
            rawReceiptDigest: `sha256:${hash({ raw: classId })}`,
            semanticFactsDigest: `sha256:${hash({ semantic: classId })}`
        })));
    const producerClasses = Object.fromEntries(registry.producers.map((producer) => [producer.producerId,
        results.filter((result) => result.producerId === producer.producerId).map((result) => result.classId)]));
    const post = seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: { commit: sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}` },
        candidateIdentity: {
            sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}`,
            buildIdentity: `sha256:${'d'.repeat(64)}`,
            candidateId: 'candidate-1', fixtureId: 'fixture-1', profileId: 'release', runId,
            attemptId: 'attempt-0001', runtimeId: 'runtime-1', browserId: 'chromium-1',
            releaseId: 'release-1', rolloutId: 'rollout-1'
        },
        executionIdentity: {
            commit: sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}`, schedulerRunId: runId,
            attemptId: 'attempt-0001', candidateIdentityDigest: `sha256:${'e'.repeat(64)}`,
            buildIdentityDigest: `sha256:${'f'.repeat(64)}`
        },
        preRuntimeReceiptDigest: pre.contentDigest,
        staticClaimVerificationDigest: `sha256:${pre.staticClaimVerificationDigest}`,
        catalogDigest: `sha256:${catalogHash}`, registryDigest: `sha256:${'1'.repeat(64)}`,
        behaviorIds: registry.producers.map((producer) => producer.behaviorId),
        requiredRuntimeProducers: registry.producers.map((producer) => producer.producerId),
        requiredObservationScopes: ['application', 'release-deployment'],
        requiredProducerClasses: producerClasses,
        observedProducerClasses: structuredClone(producerClasses),
        observedBehaviorResults: results,
        observationRefs: [
            { scope: 'application', path: '.tmp/final/application.json', fileDigest: `sha256:${'2'.repeat(64)}`, contentDigest: `sha256:${'3'.repeat(64)}` },
            { scope: 'release-deployment', path: '.tmp/final/release.json', fileDigest: `sha256:${'4'.repeat(64)}`, contentDigest: `sha256:${'5'.repeat(64)}` }
        ],
        acceptedClaimsRef: {
            path: '.tmp/final/claims.json', fileDigest: `sha256:${'6'.repeat(64)}`,
            contentDigest: `sha256:${'7'.repeat(64)}`
        },
        documentClaimDigests: Object.fromEntries(registry.producers.flatMap((producer) => producer.acceptedClaimRefs.map((claimId) => [claimId, `sha256:${hash({ claimId })}`]))),
        documentClaimTerminalDigest: `sha256:${'9'.repeat(64)}`,
        schedulerEvidence: {
            path: '.tmp/test-runs/final-round/scheduler-admission.json',
            fileDigest: `sha256:${'a'.repeat(64)}`, contentDigest: `sha256:${'b'.repeat(64)}`
        },
        missing: [], orphans: [], conflicts: [], stale: [], diagnostics: [],
        findingCounts: { missing: 0, orphans: 0, conflicts: 0, stale: 0, diagnostics: 0 },
        releaseFinalSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: []
    });
    const migrationLedger = { schema: 'fixture', scopes: [{ scopeId: 'fixture', entries: active.map((entry) => ({
        behaviorId: entry.id, documentPath: entry.documents?.[0] ?? 'docs/fixture.md',
        claimIds: [`${entry.id}.fixture`], generatedSectionIds: []
    })) }] }
    const matrix = { tiers: [
        { id: 'static', executionDependsOn: [], summaryAuthority: null },
        { id: 'pre', executionDependsOn: ['static'], summaryAuthority: null },
        { id: 'post', executionDependsOn: ['pre'], summaryAuthority: null }
    ] }
    return {
        staticAdmissionReceipt: admission, preRuntimeReceipt: pre, postRuntimeReceipt: post,
        ownerReceipt: owner, factObservationReceipts: facts, docClaimParseReceipt: claims,
        docClaimVerificationReceipt: verification, generatedSectionReceipt: generated,
        catalog, migrationLedger, matrix,
        ...overrides
    }
}

test('final consistency report deterministically closes every behavior edge', (t) =>
{
    const sourceRoot = sourceRepositoryFixture(t)
    const report = buildFinalConsistencyReport(fixture({ sourceRoot }))
    assert.equal(validateFinalReport(report).status, 'ok', report.failureReasons.join('; '))
    assert.equal(report.behaviorNodes[0].status, 'ok')
    assert.equal(report.dagAudit.stronglyConnectedComponents.length, 0)
})

test('self-consistent substitute static component receipts cannot escape the admission seal', async (context) =>
{
    const cases = [
        {
            name: 'implementation owner from another scan',
            mutate(input)
            {
                const owner = structuredClone(input.ownerReceipt)
                owner.bindings[0].sourcePath = 'src/substitute.cs'
                input.ownerReceipt = sealBare(Object.fromEntries(
                    Object.entries(owner).filter(([key]) => key !== 'contentDigest')
                ))
            },
            expected: /implementation owner receipt does not match static admission/u
        },
        {
            name: 'fact receipt with another semantic observation',
            mutate(input)
            {
                const fact = structuredClone(input.factObservationReceipts[0])
                fact.observations.alphaValue = false
                input.factObservationReceipts[0] = sealBare(Object.fromEntries(
                    Object.entries(fact).filter(([key]) => key !== 'contentDigest')
                ))
            },
            expected: /content digest does not match static admission/u
        },
        {
            name: 'DocClaim verification from another component bundle',
            mutate(input)
            {
                const verification = structuredClone(input.docClaimVerificationReceipt)
                verification.results[0].reason = 'substitute verification'
                input.docClaimVerificationReceipt = sealBare(Object.fromEntries(
                    Object.entries(verification).filter(([key]) => key !== 'contentDigest')
                ))
            },
            expected: /DocClaim verification receipt does not match static admission/u
        },
        {
            name: 'generated receipt from another component bundle',
            mutate(input)
            {
                const generated = structuredClone(input.generatedSectionReceipt)
                generated.sections.push({
                    sectionId: 'substitute.section', behaviorId: 'alpha-behavior',
                    documentPath: 'docs/substitute.md', factPath: 'alphaValue',
                    status: 'ok', reason: 'substitute section'
                })
                input.generatedSectionReceipt = sealBare(Object.fromEntries(
                    Object.entries(generated).filter(([key]) => key !== 'contentDigest')
                ))
            },
            expected: /generated section receipt does not match static admission/u
        }
    ]
    for (const scenario of cases)
    {
        await context.test(scenario.name, () =>
        {
            const input = fixture({ sourceRoot: sourceRepositoryFixture(context) })
            scenario.mutate(input)
            const report = buildFinalConsistencyReport(input)
            assert.equal(report.status, 'failed')
            assert.match(report.failureReasons.join('\n'), scenario.expected)
        })
    }
})

test('post-runtime seal must bind the exact pre-runtime receipt and the complete class graph', async (context) =>
{
    const cases = [
        {
            name: 'same-run receipt from another pre-runtime qualification',
            mutate(post)
            {
                post.preRuntimeReceiptDigest = `sha256:${'0'.repeat(64)}`
            },
            expected: /pre-runtime receipt digest mismatch/u
        },
        {
            name: 'duplicate runtime observation',
            mutate(post)
            {
                post.observedBehaviorResults.push(structuredClone(post.observedBehaviorResults[0]))
            },
            expected: /exact-match|schema validation failed/u,
            rejects: true
        },
        {
            name: 'nullable candidate identity in an ok seal',
            mutate(post)
            {
                post.candidateIdentity.candidateId = null
            },
            expected: /schema validation failed/u,
            rejects: true
        },
        {
            name: 'one class missing from a multi-class behavior',
            mutate(post)
            {
                post.observedBehaviorResults.pop()
            },
            expected: /exact-match/u,
            rejects: true
        },
        {
            name: 'missing individually accepted claim',
            mutate(post)
            {
                delete post.documentClaimDigests[Object.keys(post.documentClaimDigests)[0]]
            },
            expected: /post-runtime document claim IDs does not match/u
        },
        {
            name: 'orphan individually accepted claim',
            mutate(post)
            {
                post.documentClaimDigests['orphan.claim'] = `sha256:${hash({ orphan: true })}`
            },
            expected: /post-runtime document claim IDs does not match/u
        },
        {
            name: 'legacy behavior-keyed aggregate does not replace accepted claims',
            mutate(post)
            {
                post.documentClaimDigests = Object.fromEntries(post.behaviorIds.map((id) =>
                    [id, `sha256:${hash({ staticBundle: true })}`]))
            },
            expected: /post-runtime document claim IDs does not match/u
        }
    ]
    for (const scenario of cases)
    {
        await context.test(scenario.name, () =>
        {
            const input = fixture({ sourceRoot: sourceRepositoryFixture(context) })
            const post = structuredClone(input.postRuntimeReceipt)
            scenario.mutate(post)
            input.postRuntimeReceipt = seal(post)
            if (scenario.rejects)
            {
                assert.throws(() => buildFinalConsistencyReport(input), scenario.expected)
                return
            }
            const report = buildFinalConsistencyReport(input)
            assert.equal(report.status, 'failed')
            assert.match(report.failureReasons.join('\n'), scenario.expected)
        })
    }
})

test('formal terminal requires explicit files and caller run authority before publishing', (t) =>
{
    const input = fixture({ sourceRoot: sourceRepositoryFixture(t) });
    assert.throws(() => buildVerifiedFinalConsistencyReport(input), /explicit post-runtime and pre-runtime receipt paths/u);
    const directory = fs.mkdtempSync(path.join(repositorySourceRoot, '.tmp/terminal-3102-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const post = path.join(directory, 'post.json');
    const pre = path.join(directory, 'pre.json');
    const output = path.join(directory, 'report.json');
    fs.writeFileSync(post, JSON.stringify(input.postRuntimeReceipt));
    fs.writeFileSync(pre, JSON.stringify(input.preRuntimeReceipt));
    const files = { ...input, postRuntimeReceipt: post, preRuntimeReceipt: pre };
    assert.throws(() => buildVerifiedFinalConsistencyReport(files), /explicit runId/u);
    assert.throws(() => buildVerifiedFinalConsistencyReport({ ...files, runId }), /outside caller run\/source authority/u);
    const childEnv = { ...process.env };
    delete childEnv.FSUSBLOG_TEST_RUN_ID;
    for (const args of [[], ['--run-id', runId]])
    {
        const result = spawnSync(process.execPath, [
            path.join(repositorySourceRoot, 'tools/docs/behavior-document-consistency-final.mjs'),
            '--post-runtime', post, '--pre-runtime', pre, '--out', output, ...args
        ], { encoding: 'utf8', env: childEnv });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /explicit runId|outside caller run\/source authority/u);
        assert.equal(fs.existsSync(output), false);
    }
});

test('stale identities, graph cycles and legacy residue fail without repairing producers', (t) =>
{
    const sourceRoot = sourceRepositoryFixture(t, {
        'config/testing/behavior-qualification.json': JSON.stringify({ lastReviewedAt: 'now' })
    })
    const stalePost = fixture({ sourceRoot }).postRuntimeReceipt
    stalePost.sourceIdentity.commit = 'd'.repeat(40)
    stalePost.contentDigest = seal(Object.fromEntries(Object.entries(stalePost).filter(([key]) => key !== 'contentDigest'))).contentDigest
    const input = fixture({
        postRuntimeReceipt: stalePost,
        sourceRoot,
        matrix: { tiers: [{ id: 'a', executionDependsOn: ['b'] }, { id: 'b', executionDependsOn: ['a'] }] }
    })
    const report = buildFinalConsistencyReport(input)
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('identity mismatch')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('SCC')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy')))
})

test('tampered input receipt is rejected before final aggregation', (t) =>
{
    const input = fixture({ sourceRoot: sourceRepositoryFixture(t) })
    input.ownerReceipt.bindings = []
    assert.throws(() => buildFinalConsistencyReport(input), /contentDigest mismatch/u)
})

test('zero-legacy scan covers every terminal path class and rejects root-specific residue', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/behavior-qualification.json': JSON.stringify({ lastVerifiedCommit: 'a'.repeat(40) }),
        'config/testing/behavior-qualification.json': JSON.stringify({ maximum_verification_distance: 1 }),
        'tools/release/behavior-qualification.mjs': 'const lastReviewedAt = "now"\n',
        'tests/fixtures/behavior-qualification.json': JSON.stringify({ content_baseline_sha: 'b'.repeat(64) }),
        'docs/behavior-contract.md': '# Contract\n```json\n{ "approvedContentDigest": "sha256:old" }\n```\n',
        'src/frontend/package.json': JSON.stringify({ scripts: { 'check:behavior': 'node deprecated-claim-cli.mjs' } }),
        'config/testing/behavior.generated.json': JSON.stringify({ expectedValue: 'old' }),
        'config/schemas/behavior-output.schema.json': JSON.stringify({ approved_content_digest: { type: 'string' } })
    })
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.deepEqual(Object.keys(scan.pathClassCounts).sort(), [...zeroLegacyRequiredPathClasses].sort())
    for (const pathClass of zeroLegacyRequiredPathClasses) assert.ok(scan.pathClassCounts[pathClass] > 0, `${pathClass} was not scanned`)
    for (const pathClass of zeroLegacyRequiredPathClasses)
    {
        assert.ok(scan.findings.some((finding) => finding.pathClasses.includes(pathClass)), `${pathClass} residue escaped`)
    }
})

test('zero-legacy inventories tracked projections output schemas and package scripts outside source roots', (t) =>
{
    const files = {
        'artifacts/behavior.generated.json': JSON.stringify({ lastVerifiedCommit: 'a'.repeat(40) }),
        'build/schemas/behavior-output.json': JSON.stringify({ approvedContentDigest: 'sha256:old' }),
        'package.json': JSON.stringify({ scripts: { qualify: 'node deprecated-claim-cli.mjs' } }),
        'ops/private/package.json': JSON.stringify({ scripts: { latestReceipt: 'node current-claim-cli.mjs' } })
    }
    const repositoryRoot = sourceRepositoryFixture(t, files)
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    for (const file of Object.keys(files))
    {
        assert.ok(scan.findings.some((finding) => finding.file === file), `${file} escaped tracked scope`)
    }
    assert.ok(scan.pathClassCounts['generated-projection'] > 0)
    assert.ok(scan.pathClassCounts['output-schema'] > 0)
    assert.deepEqual(scan, scanZeroLegacyGovernance(repositoryRoot))

    const looseRoot = repositoryFixture(t, files)
    const looseScan = scanZeroLegacyGovernance(looseRoot)
    assert.ok(looseScan.findings.some((finding) => finding.file === 'artifacts/behavior.generated.json'))
    assert.equal(looseScan.findings.some((finding) => finding.file.startsWith('build/')), false)
})

test('zero-legacy package script selection paths cannot hide behind command file extensions', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'package.json': JSON.stringify({ scripts: {
            qualify: 'node ./tools/latest-receipt.mjs',
            verify: 'node "./tools/newest-evidence.cjs"',
            current: 'node ./tools/current-receipt.mjs --scan-source'
        } })
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const script of ['qualify', 'verify'])
    {
        assert.ok(findings.some((finding) => finding.file === 'package.json'
            && finding.location === `$.scripts.${script}`
            && finding.rule.startsWith('forbidden-evidence-selection:')))
    }
    assert.equal(findings.some((finding) => finding.location === '$.scripts.current'), false)
})

test('zero-legacy classifies only immutable regex bindings with exclusively rejecting uses', (t) =>
{
    const declaration = 'const forbiddenSelectionKey = /latest|mtime/iu;'
    const assertion = 'function insist(condition, message) { if (!condition) { throw new Error(message); } }'
    const call = 'function check(key) { insist(!forbiddenSelectionKey.test(key), "invalid input"); }'
    const cases = [
        ['direct-throw', `${declaration} function check(key) { if (forbiddenSelectionKey.test(key)) { throw new Error("invalid input"); } }`, false],
        ['local-reject', `${declaration} ${assertion} ${call}`, false],
        ['active-producer', `${declaration} export function produce(key) { return forbiddenSelectionKey.test(key); }`, true],
        ['second-use', `${declaration} ${assertion} ${call} const selected = forbiddenSelectionKey.test(input);`, true],
        ['alias', `${declaration} ${assertion} ${call} const alias = forbiddenSelectionKey;`, true],
        ['dynamic-read', `${declaration} ${assertion} ${call} eval("publish(forbiddenSelectionKey)");`, true],
        ['stateful-regex', `${declaration.replace('/iu;', '/giu;')} ${assertion} ${call}`, true],
        ['export', `export ${declaration} ${assertion} ${call}`, true],
        ['mutable', `${declaration.replace('const ', 'let ')} ${assertion} ${call}`, true],
        ['no-throw', `${declaration} function check(key) { if (forbiddenSelectionKey.test(key)) { return false; } }`, true],
        ['non-reject-assertion', `${declaration} function insist(condition, message) { return condition; } ${call}`, true],
        ['assertion-shadow', `${declaration} ${assertion} function check(key, insist) { insist(!forbiddenSelectionKey.test(key), "invalid input"); }`, true],
        ['regex-shadow', `${declaration} function check(key, forbiddenSelectionKey) { if (forbiddenSelectionKey.test(key)) { throw new Error("invalid input"); } }`, true],
        ['error-shadow', `${declaration} const Error = factory; ${assertion} ${call}`, true],
        ['caught-guard', `${declaration} function check(key) { try { if (forbiddenSelectionKey.test(key)) { throw new Error("invalid input"); } } catch {} }`, true],
        ['guard-with-else', `${declaration} function check(key) { if (forbiddenSelectionKey.test(key)) { throw new Error("invalid input"); } else { return key; } }`, true]
    ]
    for (const [name, source, rejected] of cases)
    {
        const file = `tools/release/${name}-qualification.mjs`
        const scan = scanZeroLegacyGovernance(repositoryFixture(t, { [file]: source }))
        assert.equal(scan.findings.some((finding) => finding.file === file), rejected, name)
    }
})

test('owned scanner fixture preserves representative input bytes and rejection rules', (t) =>
{
    const input = JSON.stringify({
        last_verified_commit: 'a'.repeat(40),
        'maximum-verification-distance': 1,
        lastReviewedCommit: 'b'.repeat(40),
        'last-reviewed-at': 'now',
        verified_at: 'now',
        contentBaselineSha: 'c'.repeat(64),
        approved_content_digest: 'd'.repeat(64),
        expectedValue: 1,
        baseline_value: 1,
        ignoreDifference: true,
        allow_stale_until: 'tomorrow',
        waiver: 'manual',
        verified: true,
        reviewed: true
    })
    const relative = 'config/testing/behavior-qualification.json'
    const beforeRoot = repositoryFixture(t, { [relative]: input })
    const after = createZeroLegacyScannerFixture({ [relative]: input })
    t.after(after.dispose)
    assert.notEqual(beforeRoot, after.root)
    assert.deepEqual(fs.readFileSync(path.join(beforeRoot, relative)), fs.readFileSync(path.join(after.root, relative)))
    const rejectionRules = (scan) => scan.findings.filter((finding) => finding.file === relative)
        .map((finding) => `${finding.location}:${finding.rule}`)
    assert.deepEqual(rejectionRules(scanZeroLegacyGovernance(beforeRoot)), rejectionRules(scanZeroLegacyGovernance(after.root)))
    assert.equal(rejectionRules(scanZeroLegacyGovernance(after.root)).length, 14)
    after.dispose()
    assert.equal(fs.existsSync(after.root), false)
    assert.equal(fs.existsSync(beforeRoot), true)
})

test('owned scanner fixture rejects getters aliases and parser input replacement before creating data', () =>
{
    let getterReads = 0
    const getterInput = Object.defineProperty({}, 'input.json', { enumerable: true, get() { getterReads += 1; return '{}'; } })
    const inputs = [getterInput, Object.create({ inherited: '{}' }), { '../outside.json': '{}' },
        { '/absolute.json': '{}' }, { 'nested//input.json': '{}' }, { 'nested/./input.json': '{}' },
        { 'nested\\input.json': '{}' }, { 'src/frontend/package.json': '{}' },
        { 'src/frontend/node_modules/typescript/lib/typescript.js': 'invalid' }, { 'input.json': {} }]
    for (const input of inputs) assert.throws(() => createZeroLegacyScannerFixture(input), /scanner fixture/u)
    assert.equal(getterReads, 0)
})

test('zero-legacy machine-field mutation corpus rejects separator variants and boolean self-certification', (t) =>
{
    const machineFields = {
        last_verified_commit: 'a'.repeat(40),
        'maximum-verification-distance': 1,
        lastReviewedCommit: 'b'.repeat(40),
        'last-reviewed-at': 'now',
        verified_at: 'now',
        contentBaselineSha: 'c'.repeat(64),
        approved_content_digest: 'd'.repeat(64),
        expectedValue: 1,
        baseline_value: 1,
        ignoreDifference: true,
        allow_stale_until: 'tomorrow',
        waiver: 'manual',
        verified: true,
        reviewed: true
    }
    const scannerFixture = createZeroLegacyScannerFixture({
        'config/testing/behavior-qualification.json': JSON.stringify(machineFields)
    })
    t.after(scannerFixture.dispose)
    const rules = scanZeroLegacyGovernance(scannerFixture.root).findings.map((finding) => finding.rule)
    for (const field of [
        'lastVerifiedCommit', 'maximumVerificationDistance', 'lastReviewedCommit', 'lastReviewedAt',
        'verifiedAt', 'contentBaselineSha', 'approvedContentDigest', 'expectedValue', 'baselineValue',
        'ignoreDifference', 'allowStaleUntil', 'waiver'
    ])
    {
        assert.ok(rules.includes(`forbidden-machine-field:${field}`), `${field} mutation survived`)
    }
    assert.ok(rules.includes('forbidden-self-certification:verified'))
    assert.ok(rules.includes('forbidden-self-certification:reviewed'))
})

test('zero-legacy qualification-only fields retain their exact path scope', (t) =>
{
    const fields = {
        expectedValue: 1,
        baselineValue: 1,
        verifiedAt: 'now',
        waiver: 'manual'
    };
    const qualified = 'config/testing/behavior-qualification.json';
    const ordinary = 'config/runtime/options.json';
    const scan = scanZeroLegacyGovernance(repositoryFixture(t, {
        [qualified]: JSON.stringify(fields),
        [ordinary]: JSON.stringify(fields)
    }));
    for (const field of Object.keys(fields))
    {
        assert.ok(scan.findings.some((finding) => finding.file === qualified
            && finding.rule === `forbidden-machine-field:${field}`), `${field} escaped qualification`);
        assert.equal(scan.findings.some((finding) => finding.file === ordinary
            && finding.rule === `forbidden-machine-field:${field}`), false, `${field} leaked outside qualification`);
    }
});


test('zero-legacy fixture classification requires the complete reviewed source to rejection sink', (t) =>
{
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const start = source.indexOf("test('zero-legacy machine-field mutation corpus")
    const end = source.indexOf('\ntest(', start + 1)
    const representative = source.slice(start, end)
    const imports = [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { scanZeroLegacyGovernance } from '../../tools/docs/behavior-document-consistency-final.mjs'",
        "import { createZeroLegacyScannerFixture } from './support/zero-legacy-scanner-fixture.mjs'"
    ].join('\n')
    const scannerPath = 'tools/docs/behavior-document-consistency-final.mjs'
    const helperPath = 'tests/tools/support/zero-legacy-scanner-fixture.mjs'
    const scanner = fs.readFileSync(path.join(repositorySourceRoot, scannerPath), 'utf8')
    const helper = fs.readFileSync(path.join(repositorySourceRoot, helperPath), 'utf8')
    const probe = 'tests/tools/behavior-rejection-probe.mjs'
    const variants = [
        ['complete', representative, helper, imports, false],
        ['renamed-title', representative.replace('zero-legacy machine-field mutation corpus', 'another descriptive case title'), helper, imports, false],
        ['helper-comment', representative, `// Formatting does not alter the IO program.\n${helper}`, imports, false],
        ['active-second-use', representative.replace('    const scannerFixture', '    publish(machineFields)\n    const scannerFixture'), helper, imports, true],
        ['helper-clears-input', representative, helper.replace('    const inputEntries', '    files = {}\n    const inputEntries'), imports, true],
        ['helper-other-root', representative, helper.replace('return Object.freeze({ root, dispose })', 'return Object.freeze({ root: repositoryRoot, dispose })'), imports, true],
        ['helper-parser-change', representative, helper.replace('typescript/lib/typescript.js', 'typescript/lib/other.js'), imports, true],
        ['fake-import', representative, helper, imports.replace("'../../tools/docs/behavior-document-consistency-final.mjs'", "'./fake-scanner.mjs'"), true],
        ['findings-replaced', representative.replace('scanZeroLegacyGovernance(scannerFixture.root).findings', 'inventedFindings'), helper, imports, true],
        ['missing-assertion', representative.replace(/    assert\.ok\(rules\.includes\('forbidden-self-certification:reviewed'\)\);?\n/u, ''), helper, imports, true],
        ['wrong-rule', representative.replace('forbidden-machine-field:${field}', 'other-rule:${field}'), helper, imports, true],
        ['caught-assertion', representative.replace(/        assert\.ok\(rules\.includes\(`forbidden-machine-field:\$\{field\}`\), `\$\{field\} mutation survived`\);?/u, '        try { assert.ok(rules.includes(`forbidden-machine-field:${field}`)); } catch {}'), helper, imports, true],
        ['unreachable-assertions', representative.replace('    for (const field', '    return\n    for (const field'), helper, imports, true],
        ['assert-shadow', representative.replace('    const machineFields', '    const assert = fakeAssert\n    const machineFields'), helper, imports, true],
        ['global-write', `${representative}\nJSON.stringify = replacement\n`, helper, imports, true],
        ['global-delete', `${representative}\ndelete JSON.stringify\n`, helper, imports, true],
        ['global-increment', `${representative}\nJSON.stringify++\n`, helper, imports, true],
        ['global-alias', `${representative}\nconst aliased = JSON\n`, helper, imports, true]
    ]
    for (const [name, callback, helperSource, importSource, rejected] of variants)
    {
        if (rejected)
        {
            assert.ok(callback !== representative || helperSource !== helper || importSource !== imports,
                `${name} must change a real mutation input`);
        }
        const repositoryRoot = repositoryFixture(t, {
            [scannerPath]: scanner,
            [helperPath]: helperSource,
            [probe]: `${importSource}\n${callback}`
        })
        const findings = scanZeroLegacyGovernance(repositoryRoot).findings.filter((finding) => finding.file === probe
            && finding.rule === 'forbidden-machine-field:lastVerifiedCommit')
        assert.equal(findings.length > 0, rejected, name)
    }
})

test('zero-legacy preserves matrix owner semantics for every scalar array entry', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tests/matrix-behavior-qualification.json': `${JSON.stringify({
            tiers: [{
                id: 'legacy-array',
                command: ['node', 'deprecated-claim-cli'],
                evidenceSource: ['current-receipt', 'latest-receipt']
            }, {
                id: 'current-array',
                command: ['node', 'current-claim-cli'],
                evidenceSource: ['current-receipt']
            }]
        }, null, 2)}\n`,
        'tests/current-matrix-behavior-qualification.json': `${JSON.stringify({
            tiers: [{ id: 'current-array', command: ['node', 'current-claim-cli'], evidenceSource: ['current-receipt'] }]
        }, null, 2)}\n`
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file === 'tests/matrix-behavior-qualification.json'
        && finding.location.endsWith('.command[1]')
        && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    assert.ok(findings.some((finding) => finding.file === 'tests/matrix-behavior-qualification.json'
        && finding.location.endsWith('.evidenceSource[1]')
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.equal(findings.some((finding) => finding.file === 'tests/current-matrix-behavior-qualification.json'), false)
})

test('zero-legacy source declaration mutations cannot bypass field matching', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/behavior-qualification.cs': 'public string LastVerifiedCommit { get; init; }\n',
        'tools/release/behavior-qualification.ts': 'receipt.last_reviewed_at = "now"\ninterface Receipt { allowStaleUntil?: string }\n',
        'tests/release/behavior-qualification.test.mjs': 'const lastVerifiedCommit = "deadbeef"\n',
        'tests/tools/scanner-fixture.test.mjs': 'const fixture = \'const lastVerifiedCommit = "deadbeef"\'\n',
        'docs/behavior-contract.md': '# Contract\n```yaml\nverified: true\n```\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file.endsWith('.cs') && finding.rule.endsWith(':lastVerifiedCommit')))
    assert.ok(findings.some((finding) => finding.file.endsWith('.ts') && finding.rule.endsWith(':lastReviewedAt')))
    assert.ok(findings.some((finding) => finding.file.endsWith('.ts') && finding.rule.endsWith(':allowStaleUntil')))
    assert.ok(findings.some((finding) => finding.file.endsWith('.test.mjs') && finding.rule.endsWith(':lastVerifiedCommit')))
    assert.equal(findings.some((finding) => finding.file === 'tests/tools/scanner-fixture.test.mjs'), false)
    assert.ok(findings.some((finding) => finding.file.endsWith('.md') && finding.rule.endsWith(':verified')))
})

test('zero-legacy source invocations and C# initializers cannot hide terminal residue', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/behavior-qualification.cs': [
            'using System;',
            '[AttributeUsage(AttributeTargets.Class)]',
            'sealed class BehaviorAttribute : Attribute { public string Command { get; init; } = ""; }',
            '[Behavior(Command = "deprecated-claim-cli")]',
            'sealed class Subject {',
            '    public bool Verified { get; init; } = true;',
            '    public const string FieldCommand = "deprecated-claim-cli";',
            '    public string Command { get; init; } = "deprecated-claim-cli";',
            '    public void Run() { const string localCommand = "deprecated-claim-cli"; }',
            '}'
        ].join('\n'),
        'tools/release/behavior-qualification.mjs': [
            'spawnSync("deprecated-claim-cli", ["--run"])',
            'selectReceipt("latest")',
            'const command = "deprecated-" +',
            '    "claim-cli"',
            'const commandBeforePlus = "deprecated-" // continue before plus',
            '    + "claim-cli"',
            'const commandAfterPlus = "deprecated-" + // continue after comment',
            '    "claim-cli"',
            'const commandBlockComment = "deprecated-" /* continue */ + "claim-cli"'
        ].join('\n'),
        'tools/release/comment-only-behavior-qualification.mjs': [
            'const command = "current-claim-cli" // deprecated-claim-cli',
            'const authority = "current-openapi" /* checked-in-openapi */'
        ].join('\n'),
        'tools/release/cr-behavior-qualification.mjs': [
            'const command = "deprecated-" + // continue',
            '    "claim-cli"'
        ].join('\r'),
        'tools/release/u2028-behavior-qualification.mjs': [
            'const command = "deprecated-" + // continue',
            '    "claim-cli"'
        ].join('\u2028'),
        'tools/release/u2029-behavior-qualification.mjs': [
            'const command = "deprecated-" + // continue',
            '    "claim-cli"'
        ].join('\u2029')
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file.endsWith('.cs') && finding.rule === 'forbidden-self-certification:verified'))
    assert.ok(findings.some((finding) => finding.file.endsWith('.cs')
        && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    assert.ok(findings.some((finding) => finding.file.endsWith('.mjs') && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    assert.ok(findings.some((finding) => finding.file.endsWith('.mjs') && finding.rule === 'forbidden-evidence-selection:selectReceipt=latest'))
    assert.equal(findings.some((finding) => finding.file === 'tools/release/comment-only-behavior-qualification.mjs'), false)
    for (const file of [
        'tools/release/cr-behavior-qualification.mjs',
        'tools/release/u2028-behavior-qualification.mjs',
        'tools/release/u2029-behavior-qualification.mjs'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file
            && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'), `${file} line terminator escaped`)
    }
})

test('zero-legacy source identifiers follow CSharp JavaScript PowerShell and shell grammars', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/csharp-behavior-qualification.cs': 'public string @LastVerifiedCommit { get; init; }\n',
        'src/release/csharp-escaped-behavior-qualification.cs': 'public string \\u006castVerifiedCommit { get; init; }\n',
        'tools/release/javascript-behavior-qualification.mjs': 'class Receipt { #lastVerifiedCommit = "ambient"; }\nconst $latestReceipt = "ambient"\n',
        'tools/release/javascript-escaped-behavior-qualification.mjs': 'const \\u006catestReceipt = "ambient"\n',
        'tools/release/powershell-behavior-qualification.ps1': '$latestReceipt = "ambient"\n${latestReceipt} = "ambient"\n${lastVerifiedCommit} = "ambient"\n',
        'tools/release/shell-behavior-qualification.sh': 'lastVerifiedCommit=ambient\n',
        'tools/release/javascript-grammar-current.mjs': 'const current = current-latestReceipt\nconst text = "#lastVerifiedCommit @verified"\n',
        'tools/release/csharp-grammar-current.cs': 'var current = @"lastVerifiedCommit";\n',
        'tools/release/shell-grammar-current.sh': 'latest-receipt=ambient\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    execFileSync(process.execPath, ['--check', path.join(repositoryRoot, 'tools/release/javascript-escaped-behavior-qualification.mjs')])
    assert.ok(findings.some((finding) => finding.file === 'src/release/csharp-behavior-qualification.cs'
        && finding.rule === 'forbidden-machine-field:lastVerifiedCommit'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/javascript-behavior-qualification.mjs'
        && finding.rule === 'forbidden-machine-field:lastVerifiedCommit'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/javascript-behavior-qualification.mjs'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/javascript-escaped-behavior-qualification.mjs'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'src/release/csharp-escaped-behavior-qualification.cs'
        && finding.rule === 'forbidden-machine-field:lastVerifiedCommit'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/powershell-behavior-qualification.ps1'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/powershell-behavior-qualification.ps1'
        && finding.rule === 'forbidden-machine-field:lastVerifiedCommit'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/shell-behavior-qualification.sh'
        && finding.rule === 'forbidden-machine-field:lastVerifiedCommit'))
    for (const file of [
        'tools/release/javascript-grammar-current.mjs',
        'tools/release/csharp-grammar-current.cs',
        'tools/release/shell-grammar-current.sh'
    ])
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} language grammar was overgeneralized`)
    }
})

test('zero-legacy dispatches tracked module and shell extensions and scans static imports and direct CLI', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tools/release/import-behavior-qualification.mts': [
            'import currentClaim from "./deprecated-claim-cli.mjs"',
            'import { currentReceipt as latestReceipt } from "./current-receipt.mjs"',
            'export { currentClaim } from "./latest-receipt.mjs"',
            'await import("./compat-claim-cli.mjs")'
        ].join('\n'),
        'tools/release/commonjs-behavior-qualification.cjs': 'const lastReviewedAt = "now"\n',
        'tools/release/direct-behavior-qualification.bash': [
            '# deprecated-claim-cli --comment-only',
            'env deprecated-claim-cli --run',
            '"deprecated-claim-cli" --quoted-run'
        ].join('\n'),
        'tools/release/uppercase-behavior-qualification.MTS': 'await import("./deprecated-claim-cli.mjs")\n',
        'tools/release/uppercase-commonjs-behavior-qualification.CJS': 'const lastReviewedAt = "now"\n',
        'tools/release/uppercase-direct-behavior-qualification.BASH': 'deprecated-claim-cli --run\n',
        'tools/release/current-import-qualification.mts': 'import currentReceipt from "./current-receipt.mjs"\n',
        'tools/release/current-direct-qualification.bash': '# deprecated-claim-cli\ncurrent-claim-cli --run\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file === 'tools/release/import-behavior-qualification.mts'
        && finding.rule === 'forbidden-legacy-surface:./deprecated-claim-cli.mjs'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/import-behavior-qualification.mts'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/import-behavior-qualification.mts'
        && finding.rule === 'forbidden-legacy-surface:./compat-claim-cli.mjs'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/commonjs-behavior-qualification.cjs'
        && finding.rule === 'forbidden-machine-field:lastReviewedAt'))
    assert.ok(findings.filter((finding) => finding.file === 'tools/release/direct-behavior-qualification.bash'
        && finding.rule.includes('deprecated-claim-cli')).length >= 2)
    assert.ok(findings.some((finding) => finding.file === 'tools/release/uppercase-behavior-qualification.MTS'
        && finding.rule === 'forbidden-legacy-surface:./deprecated-claim-cli.mjs'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/uppercase-commonjs-behavior-qualification.CJS'
        && finding.rule === 'forbidden-machine-field:lastReviewedAt'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/uppercase-direct-behavior-qualification.BASH'
        && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    for (const file of [
        'tools/release/current-import-qualification.mts',
        'tools/release/current-direct-qualification.bash'
    ])
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} current syntax was rejected`)
    }
})

test('zero-legacy shell and YAML hash comments do not create residue or hide active values', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tools/release/comment-only-behavior-qualification.sh': '# command="deprecated-claim-cli"\ncommand="current-claim-cli" # checked-in-openapi\necho current;# authority="checked-in-openapi"\n',
        'tools/release/active-behavior-qualification.sh': 'command="deprecated-claim-cli"\n',
        'tools/release/url-behavior-qualification.sh': 'evidenceSource=https://host/latest-receipt\n',
        'tools/release/current-url-behavior-qualification.sh': 'evidenceSource=https://host/current-receipt\n',
        'config/testing/comment-only-behavior-qualification.yaml': '# latestReceipt: stale.json\ncommand: current-claim-cli # deprecated-claim-cli\n',
        'config/testing/active-behavior-qualification.yaml': 'command: deprecated-claim-cli\n',
        'config/testing/hash-scalar-active-behavior-qualification.yaml': 'command: current#deprecated-claim-cli\n',
        'config/testing/url-behavior-qualification.yaml': 'evidenceSource: https://host/latest-receipt\n',
        'config/testing/current-url-behavior-qualification.yaml': 'evidenceSource: https://host/current-receipt\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const file of [
        'tools/release/comment-only-behavior-qualification.sh',
        'config/testing/comment-only-behavior-qualification.yaml',
        'tools/release/current-url-behavior-qualification.sh',
        'config/testing/current-url-behavior-qualification.yaml'
    ])
    {
        assert.deepEqual(findings.filter((finding) => finding.file === file), [], `${file} hash comment was scanned`)
    }
    for (const file of [
        'tools/release/active-behavior-qualification.sh',
        'config/testing/active-behavior-qualification.yaml',
        'config/testing/hash-scalar-active-behavior-qualification.yaml',
        'tools/release/url-behavior-qualification.sh',
        'config/testing/url-behavior-qualification.yaml'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file), `${file} active value escaped`)
    }
})

test('zero-legacy YAML blocks PowerShell comments encodings shebangs and NFKC forms are explicit', (t) =>
{
    const utf16Le = (value) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/block-behavior-qualification.yaml': 'command: |-\n  deprecated-claim-cli\nevidenceSource: >-\n  latest\n  receipt\n',
        'config/testing/current-block-behavior-qualification.yaml': 'command: |-\n  current-claim-cli\nevidenceSource: >-\n  current\n  receipt\n',
        'config/testing/utf16-behavior-qualification.yaml': utf16Le('command: deprecated-claim-cli\n'),
        'config/testing/utf16-no-bom-behavior-qualification.yaml': Buffer.from('command: deprecated-claim-cli\n', 'utf16le'),
        'config/testing/utf8-utf16-collision-behavior-qualification.yaml': Buffer.from([0x61, 0x00, 0x62, 0x00]),
        'config/testing/utf16-current-behavior-qualification.yaml': utf16Le('command: current-claim-cli\n'),
        'tools/release/utf16-behavior-qualification.ps1': utf16Le('$command = "deprecated-claim-cli"\n'),
        'tools/release/utf16-current-behavior-qualification.ps1': utf16Le('$command = "current-claim-cli"\n'),
        'tools/release/comment-only-behavior-qualification.ps1': '<# outer\n$command = "deprecated-claim-cli"\n<# inner\n$latestReceipt = "stale.json"\n#>\n$verified = $true\n#>\n$command = "current-claim-cli"\n',
        'tools/release/bom-shell-behavior-qualification.sh': Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('#!/usr/bin/env bash\ncommand="deprecated-claim-cli"\n')
        ]),
        'tools/release/bom-node-behavior-qualification.mjs': Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('#!/usr/bin/env deprecated-claim-cli\nexport const current = true\n')
        ]),
        'tools/release/current-node-behavior-qualification.mjs': '#!/usr/bin/env node\nexport const current = true\n',
        'config/testing/nfkc-behavior-qualification.json': JSON.stringify({
            ｌａｔｅｓｔＲｅｃｅｉｐｔ: 'ambient.json',
            command: 'ｄｅｐｒｅｃａｔｅｄ－ｃｌａｉｍ－ｃｌｉ'
        }),
        'tools/release/nfkc-source-behavior-qualification.mjs': 'const ｌａｔｅｓｔＲｅｃｅｉｐｔ = "ambient.json"\n',
        'tools/release/nfkc-syntax-behavior-qualification.mjs': '／／ const latestReceipt = "ambient.json"\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const file of [
        'config/testing/utf16-no-bom-behavior-qualification.yaml',
        'config/testing/utf8-utf16-collision-behavior-qualification.yaml'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file
            && finding.rule === 'unsupported-machine-encoding'), `${file} ambiguous encoding was guessed`)
    }
    assert.ok(findings.some((finding) => finding.file === 'config/testing/block-behavior-qualification.yaml'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/bom-node-behavior-qualification.mjs'
        && finding.rule.includes('deprecated-claim-cli')))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/nfkc-behavior-qualification.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/nfkc-behavior-qualification.json'
        && finding.rule.includes('deprecated-claim-cli')))
    for (const file of [
        'config/testing/block-behavior-qualification.yaml',
        'config/testing/utf16-behavior-qualification.yaml',
        'tools/release/utf16-behavior-qualification.ps1',
        'tools/release/bom-shell-behavior-qualification.sh',
        'tools/release/bom-node-behavior-qualification.mjs',
        'config/testing/nfkc-behavior-qualification.json',
        'tools/release/nfkc-source-behavior-qualification.mjs',
        'tools/release/nfkc-syntax-behavior-qualification.mjs'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file), `${file} canonical machine residue escaped`)
    }
    for (const file of [
        'config/testing/current-block-behavior-qualification.yaml',
        'config/testing/utf16-current-behavior-qualification.yaml',
        'tools/release/utf16-current-behavior-qualification.ps1',
        'tools/release/comment-only-behavior-qualification.ps1',
        'tools/release/current-node-behavior-qualification.mjs'
    ])
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} legal syntax was rejected`)
    }
})

test('zero-legacy canonical YAML AST covers scalar indicators tags anchors aliases and sequence mappings', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/yaml-ast-behavior-qualification.yaml': [
            'steps:',
            '  - command: &legacy !!str |2-',
            '      deprecated-claim-cli',
            '  - evidenceSource: >-2',
            '      latest',
            '      receipt',
            'taggedCommand: !tool deprecated-claim-cli',
            'aliasCommand: *legacy'
        ].join('\n'),
        'config/testing/yaml-ast-current-qualification.yaml': [
            'steps:',
            '  - command: &current |-2',
            '      current-claim-cli',
            'aliasCommand: *current'
        ].join('\n'),
        'config/testing/yaml-duplicate-behavior-qualification.yaml': 'command: current-claim-cli\ncommand: deprecated-claim-cli\n',
        'config/testing/yaml-cycle-behavior-qualification.yaml': 'root: &root\n  child: *root\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file === 'config/testing/yaml-ast-behavior-qualification.yaml'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.filter((finding) => finding.file === 'config/testing/yaml-ast-behavior-qualification.yaml'
        && finding.rule.includes('deprecated-claim-cli')).length >= 2)
    assert.equal(findings.some((finding) => finding.file === 'config/testing/yaml-ast-current-qualification.yaml'), false)
    for (const file of [
        'config/testing/yaml-duplicate-behavior-qualification.yaml',
        'config/testing/yaml-cycle-behavior-qualification.yaml'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file
            && finding.rule === 'invalid-machine-yaml'), `${file} malformed YAML was accepted`)
    }
})

test('zero-legacy scanner excludes untracked and ignored build or runtime outputs', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/release/authoritative.mjs': 'export const currentReceipt = "receipt.json"\n',
        'src/release/untracked.mjs': 'const lastVerifiedCommit = "deadbeef"\n',
        'src/frontend/dist/release.mjs': 'const lastVerifiedCommit = "deadbeef"\n',
        'tools/out/release.mjs': 'selectReceipt("latest")\n',
        'tests/coverage/release.json': JSON.stringify({ lastVerifiedCommit: 'deadbeef' }),
        'tests/TestResults/release.json': JSON.stringify({ lastVerifiedCommit: 'deadbeef' })
    })
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    fs.writeFileSync(path.join(repositoryRoot, '.git/info/exclude'), 'src/frontend/node_modules/\n')
    execFileSync('git', ['add',
        'src/release/authoritative.mjs',
        'src/frontend/package.json',
        'src/frontend/package-lock.json'
    ], { cwd: repositoryRoot })
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.equal(scan.scannedFileCount, 3)
    assert.deepEqual(scan.findings, [])
})

test('zero-legacy scanner never excludes tracked source by coverage or dist path names', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tools/coverage/behavior-qualification.mjs': 'const receiptSource = "latest-receipt"\n',
        'src/frontend/dist/behavior-qualification.mjs': 'const command = "deprecated-claim-cli"\n',
        'src/frontend/coverage/current.mjs': 'export const current = true\n'
    })
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    fs.writeFileSync(path.join(repositoryRoot, '.git/info/exclude'), 'src/frontend/node_modules/\n')
    execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.equal(scan.scannedFileCount, 5)
    assert.ok(scan.findings.some((finding) => finding.file === 'tools/coverage/behavior-qualification.mjs'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(scan.findings.some((finding) => finding.file === 'src/frontend/dist/behavior-qualification.mjs'
        && finding.rule.includes('deprecated-claim-cli')))
    assert.equal(scan.findings.some((finding) => finding.file === 'src/frontend/coverage/current.mjs'), false)
})

test('zero-legacy selection and authority mutation corpus rejects latest history fallback and self-authority fields', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/release-final-qualification.json': JSON.stringify({
            latest_receipt: 'receipt.json',
            latestRuntimeReceipt: 'runtime.json',
            evidenceHistory: [],
            historicalFactReceipt: 'old-fact.json',
            fallbackEvidence: 'old.json',
            evidence_mtime: 1,
            evidenceSelectionStrategy: 'latest',
            lastGreen: 'run-1',
            retryUntilPass: true,
            self_certification: true,
            authority: 'checked-in-openapi',
            synchronizationStrategy: 'git-diff',
            checkedInOpenapi: 'openapi.json',
            openapiRegexFallback: 'route regex',
            releaseFinalDiscovery: true,
            releaseFinalParseReceipts: true,
            llmQualification: 'accepted'
        })
    })
    const rules = scanZeroLegacyGovernance(repositoryRoot).findings.map((finding) => finding.rule)
    for (const field of [
        'latestReceipt', 'latestRuntimeReceipt', 'evidenceHistory', 'historicalFactReceipt',
        'fallbackEvidence', 'evidenceMtime', 'lastGreen', 'retryUntilPass'
    ])
    {
        assert.ok(rules.includes(`forbidden-evidence-selection:${field}`), `${field} mutation survived`)
    }
    assert.ok(rules.includes('forbidden-evidence-selection:evidenceSelectionStrategy=latest'))
    for (const field of [
        'selfCertification', 'gitDiff', 'checkedInOpenapi', 'openapiRegexFallback',
        'releaseFinalDiscovery', 'releaseFinalParseReceipts', 'llmQualification'
    ])
    {
        assert.ok(rules.includes(`forbidden-self-authority:${field}`), `${field} mutation survived`)
    }
})

test('zero-legacy scanner rejects legacy role surfaces but allows historical prose and skips symlinks', (t) =>
{
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zero-legacy-outside-'))
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
    fs.writeFileSync(path.join(outside, 'behavior-qualification.json'), JSON.stringify({ lastVerifiedCommit: 'a'.repeat(40) }))
    const repositoryRoot = repositoryFixture(t, {
        'docs/history.md': '# History\nIn 2025 the retired record mentioned lastVerifiedCommit deadbeef.\n',
        'tools/docs/behavior-qualification.mjs': 'class CompatRenderer {}\n',
        'config/testing/behavior-qualification.json': JSON.stringify({
            deprecatedFeatureFlag: true,
            kind: 'deprecated-claim'
        })
    })
    fs.mkdirSync(path.join(repositoryRoot, 'src'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'behavior-qualification.json'), path.join(repositoryRoot, 'src', 'linked.json'))
    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.ok(scan.findings.some((finding) => finding.rule.includes('CompatRenderer')))
    assert.ok(scan.findings.some((finding) => finding.rule.includes('deprecatedFeatureFlag')))
    assert.ok(scan.findings.some((finding) => finding.rule.includes('deprecated-claim')))
    assert.equal(scan.findings.some((finding) => finding.file === 'docs/history.md'), false)
    assert.equal(scan.findings.some((finding) => finding.file === 'src/linked.json'), false)
})

test('zero-legacy JSON not exemption requires an explicit JSON Schema dialect', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/behavior-qualification.json': JSON.stringify({
            not: { latestReceipt: 'ambient.json', verified: true }
        }),
        'config/schemas/behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            not: { properties: { latestReceipt: { type: 'string' }, verified: { const: true } } }
        }),
        'config/schemas/not-property-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            properties: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/unproven-behavior-qualification.schema.json': JSON.stringify({
            not: { latestReceipt: 'ambient.json', verified: true }
        }),
        'config/schemas/double-not-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            not: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/current-dependencies-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            dependencies: { currentField: { not: { latestReceipt: 'ambient.json' } } }
        })
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const file of [
        'config/testing/behavior-qualification.json',
        'config/schemas/unproven-behavior-qualification.schema.json'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
        assert.ok(findings.some((finding) => finding.file === file && finding.rule === 'forbidden-self-certification:verified'))
    }
    assert.equal(findings.some((finding) => finding.file === 'config/schemas/behavior-qualification.schema.json'), false)
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/not-property-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/double-not-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/current-dependencies-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
})

test('zero-legacy draft 4 6 and 7 dependencies preserve schema-valued negation', (t) =>
{
    const files = Object.fromEntries([
        ['draft-04', 'http://json-schema.org/draft-04/schema#'],
        ['draft-06', 'http://json-schema.org/draft-06/schema#'],
        ['draft-07', 'http://json-schema.org/draft-07/schema#']
    ].map(([name, dialect]) => [
        `config/schemas/${name}-behavior-qualification.schema.json`,
        JSON.stringify({
            $schema: dialect,
            dependencies: {
                currentField: { not: { properties: { latestReceipt: { type: 'string' } } } },
                otherField: ['currentField']
            }
        })
    ]))
    const repositoryRoot = repositoryFixture(t, files)
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    for (const file of Object.keys(files))
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} schema negation escaped`)
    }
})

test('zero-legacy contentSchema traversal follows only 2019-09 and 2020-12 dialects', (t) =>
{
    const files = {
        'config/schemas/2019-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2019-09/schema',
            contentSchema: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/2020-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            contentSchema: { not: { properties: { latestReceipt: { type: 'string' } } } }
        }),
        'config/schemas/2020-double-not-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            contentSchema: { not: { not: { properties: { latestReceipt: { type: 'string' } } } } }
        }),
        'config/schemas/draft-07-content-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            contentSchema: { not: { latestReceipt: 'ambient.json' } }
        })
    }
    const findings = scanZeroLegacyGovernance(repositoryFixture(t, files)).findings
    for (const file of [
        'config/schemas/2019-content-behavior-qualification.schema.json',
        'config/schemas/2020-content-behavior-qualification.schema.json'
    ])
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} contentSchema negation escaped`)
    }
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/2020-double-not-content-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/draft-07-content-behavior-qualification.schema.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
})

test('zero-legacy schema traversal switches dialect at each embedded schema resource', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/schemas/embedded-draft7-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $defs: {
                legacyResource: {
                    $id: 'legacy-resource',
                    $schema: 'http://json-schema.org/draft-07/schema#',
                    dependencies: {
                        currentField: { not: { properties: { latestReceipt: { type: 'string' } } } }
                    },
                    contentSchema: { not: { latestReceipt: 'ambient.json' } }
                }
            }
        }),
        'config/schemas/embedded-2020-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            definitions: {
                currentResource: {
                    $id: 'current-resource',
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    contentSchema: { not: { properties: { latestReceipt: { type: 'string' } } } },
                    dependencies: { currentField: { not: { latestReceipt: 'ambient.json' } } }
                }
            }
        }),
        'config/schemas/no-id-embedded-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $defs: {
                notAResource: {
                    $schema: 'http://json-schema.org/draft-07/schema#',
                    not: { latestReceipt: 'ambient.json' }
                }
            }
        }),
        'config/schemas/invalid-id-embedded-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $defs: {
                invalidResource: {
                    $id: 'bad id#fragment',
                    $schema: 'http://json-schema.org/draft-07/schema#',
                    not: { latestReceipt: 'ambient.json' }
                }
            }
        }),
        'config/schemas/unknown-dialect-embedded-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $defs: {
                unknownResource: {
                    $id: 'unknown-resource',
                    $schema: 'https://example.invalid/schema',
                    not: { latestReceipt: 'ambient.json' }
                }
            }
        }),
        'config/schemas/draft7-ref-sibling-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            $ref: '#/definitions/current',
            not: { latestReceipt: 'ambient.json' }
        }),
        'config/schemas/current-ref-sibling-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $ref: '#/$defs/current',
            not: { properties: { latestReceipt: { type: 'string' } } }
        }),
        'config/schemas/legacy-ref-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $ref: './deprecated-claim-schema.json#/$defs/current'
        }),
        'config/schemas/legacy-dynamic-ref-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $dynamicRef: './deprecated-claim-schema.json#current'
        }),
        'config/schemas/legacy-recursive-ref-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2019-09/schema',
            $recursiveRef: './compat-claim-schema.json#'
        }),
        'config/schemas/plain-behavior-qualification.json': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $dynamicRef: './deprecated-claim-schema.json#current'
        }),
        'config/schemas/uppercase-behavior-qualification.SCHEMA.JSON': JSON.stringify({
            $schema: 'https://json-schema.org/draft/2019-09/schema',
            $recursiveRef: './compat-claim-schema.json#'
        }),
        'config/schemas/nested-draft7-ref-sibling-behavior-qualification.schema.json': JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            not: {
                properties: {
                    current: {
                        $ref: '#/definitions/current',
                        not: { latestReceipt: 'ambient.json' }
                    }
                },
                allOf: [{
                    $ref: '#/definitions/current',
                    not: { latestReceipt: 'ambient.json' }
                }]
            }
        })
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.equal(findings.some((finding) => finding.file === 'config/schemas/embedded-draft7-behavior-qualification.schema.json'
        && finding.location.includes('.dependencies.')), false)
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/embedded-draft7-behavior-qualification.schema.json'
        && finding.location.endsWith('.contentSchema.not.latestReceipt')))
    assert.equal(findings.some((finding) => finding.file === 'config/schemas/embedded-2020-behavior-qualification.schema.json'
        && finding.location.includes('.contentSchema.')), false)
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/embedded-2020-behavior-qualification.schema.json'
        && finding.location.endsWith('.dependencies.currentField.not.latestReceipt')))
    for (const file of [
        'config/schemas/no-id-embedded-behavior-qualification.schema.json',
        'config/schemas/invalid-id-embedded-behavior-qualification.schema.json',
        'config/schemas/unknown-dialect-embedded-behavior-qualification.schema.json',
        'config/schemas/draft7-ref-sibling-behavior-qualification.schema.json',
        'config/schemas/nested-draft7-ref-sibling-behavior-qualification.schema.json'
    ])
    {
        assert.ok(findings.some((finding) => finding.file === file
            && finding.rule === 'forbidden-evidence-selection:latestReceipt'), `${file} invalid resource semantics escaped`)
    }
    assert.equal(findings.some((finding) => finding.file === 'config/schemas/current-ref-sibling-behavior-qualification.schema.json'), false)
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/legacy-ref-behavior-qualification.schema.json'
        && finding.location === '$.$ref'
        && finding.rule.includes('deprecated-claim-schema')))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/legacy-dynamic-ref-behavior-qualification.schema.json'
        && finding.location === '$.$dynamicRef'
        && finding.rule.includes('deprecated-claim-schema')))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/legacy-recursive-ref-behavior-qualification.schema.json'
        && finding.location === '$.$recursiveRef'
        && finding.rule.includes('compat-claim-schema')))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/plain-behavior-qualification.json'
        && finding.location === '$.$dynamicRef'
        && finding.rule.includes('deprecated-claim-schema')))
    assert.ok(findings.some((finding) => finding.file === 'config/schemas/uppercase-behavior-qualification.SCHEMA.JSON'
        && finding.location === '$.$recursiveRef'
        && finding.rule.includes('compat-claim-schema')))
    for (const keyword of ['.properties.', '.allOf[0].'])
    {
        assert.ok(findings.some((finding) => finding.file === 'config/schemas/nested-draft7-ref-sibling-behavior-qualification.schema.json'
            && finding.location.includes(keyword)
            && finding.rule === 'forbidden-evidence-selection:latestReceipt'), `${keyword} $ref sibling escaped`)
    }
})

test('zero-legacy scanner self exemptions are exact and owner names cannot suppress values', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'tools/docs/behavior-document-consistency-final.mjs': [
            "// export const zeroLegacyScanSchema = 'fsusblog.zero-legacy-governance-scan.v1'",
            "export const zeroLegacyScanSchema = 'fsusblog.zero-legacy-governance-scan.v1'",
            'const zeroLegacyScanSchema = "deprecated-claim-cli"',
            'const evidenceSelectionRuleParts = Object.freeze([["latest", "receipt"]])',
            'const authorityResidueRuleParts = Object.freeze([["checked", "in", "openapi"]])',
            'const rejectLegacyClaimCli = true'
        ].join('\n'),
        'tools/release/behavior-qualification.mjs': 'const rejectCommand = "deprecated-claim-cli"\n',
        'tools/release/compiler-behavior-qualification.mjs': [
            'const sourceFile = parser.createSourceFile(file, source, parser.ScriptTarget.Latest, true)',
            'const actionResult = records.search(query)',
            'const evidenceSource = "latest"'
        ].join('\n')
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.equal(findings.some((finding) => finding.file === 'tools/docs/behavior-document-consistency-final.mjs'
        && finding.location === 'source:line:2'), false)
    assert.ok(findings.some((finding) => finding.location === 'source:line:3'
        && finding.rule.includes('zeroLegacyScanSchema')))
    assert.ok(findings.some((finding) => finding.rule === 'forbidden-evidence-selection:latestReceipt'
        && finding.location === 'source:line:4'))
    assert.ok(findings.some((finding) => finding.rule === 'forbidden-self-authority:checkedInOpenapi'
        && finding.location === 'source:line:5'))
    assert.ok(findings.some((finding) => finding.rule === 'forbidden-legacy-surface:rejectLegacyClaimCli'))
    assert.ok(findings.some((finding) => finding.file === 'tools/release/behavior-qualification.mjs'
        && finding.rule.includes('deprecated-claim-cli')))
    assert.equal(findings.some((finding) => finding.file === 'tools/release/compiler-behavior-qualification.mjs'
        && finding.rule.includes('sourceFile=Latest')), false)
    assert.equal(findings.some((finding) => finding.file === 'tools/release/compiler-behavior-qualification.mjs'
        && finding.rule.includes('ActionResult=search')), false)
    assert.ok(findings.some((finding) => finding.file === 'tools/release/compiler-behavior-qualification.mjs'
        && finding.rule === 'forbidden-evidence-selection:evidenceSource=latest'))
})

test('zero-legacy value scanning is bounded without truncating long commands', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'config/testing/long-behavior-qualification.json': JSON.stringify({
            command: `${'x'.repeat(505)} deprecated-claim-cli ${'y'.repeat(600)}`,
            evidenceSelectionStrategy: `${'p'.repeat(500)} latest     receipt ${' padding'.repeat(90)}`,
            evidenceSource: `${'p'.repeat(500)} retry as correctness ${' padding'.repeat(90)}`,
            authorityCommand: `${'p'.repeat(500)} checked-in-openapi ${' padding'.repeat(90)}`
        }),
        'config/testing/long-benign-behavior-qualification.json': JSON.stringify({
            command: `${'x'.repeat(505)}current-claim-command${'y'.repeat(600)}`
        })
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule.startsWith('forbidden-legacy-surface:')))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule === 'forbidden-evidence-selection:retryAsCorrectness'))
    assert.ok(findings.some((finding) => finding.file === 'config/testing/long-behavior-qualification.json'
        && finding.rule === 'forbidden-self-authority:checkedInOpenapi'))
    assert.equal(findings.some((finding) => finding.file === 'config/testing/long-benign-behavior-qualification.json'), false)
})

test('zero-legacy malformed machine JSON fails closed through final aggregation', (t) =>
{
    const malformed = '{"latestReceipt":"ambient.json"} trailing-token\n'
    const scanRoot = repositoryFixture(t, {
        'config/testing/malformed-behavior-qualification.json': malformed,
        'config/testing/duplicate-behavior-qualification.json': '{"latestReceipt":"stale.json","latestReceipt":"current.json"}',
        'config/testing/duplicate-boolean-behavior-qualification.json': '{"verified":true,"verified":false}',
        'config/testing/duplicate-behavior-qualification.jsonc': '{"verified": true, "verified": false,}',
        'config/testing/comment-only-behavior-qualification.jsonc': '{\u2028  // "latestReceipt": "stale.json"\u2029  "command": "current-claim-cli",\u2028}\n',
        'src/frontend/tsconfig.behavior.json': '{\u2028  /* current config */\u2029  "compilerOptions": { "strict": true, },\u2028}\n',
        'config/testing/active-behavior-qualification.jsonc': '{\n  /* current config */\n  "latestReceipt": "stale.json"\n}\n'
    })
    const scan = scanZeroLegacyGovernance(scanRoot)
    assert.ok(scan.findings.some((finding) => finding.file === 'config/testing/malformed-behavior-qualification.json'
        && finding.rule === 'invalid-machine-json'))
    assert.equal(scan.findings.some((finding) => finding.file === 'config/testing/comment-only-behavior-qualification.jsonc'), false)
    assert.equal(scan.findings.some((finding) => finding.file === 'src/frontend/tsconfig.behavior.json'), false)
    for (const file of [
        'config/testing/duplicate-behavior-qualification.json',
        'config/testing/duplicate-boolean-behavior-qualification.json',
        'config/testing/duplicate-behavior-qualification.jsonc'
    ])
    {
        assert.ok(scan.findings.some((finding) => finding.file === file
            && finding.rule === 'invalid-machine-json'), `${file} duplicate key escaped`)
    }
    assert.ok(scan.findings.some((finding) => finding.file === 'config/testing/active-behavior-qualification.jsonc'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))

    const sourceRoot = sourceRepositoryFixture(t, {
        'config/testing/malformed-behavior-qualification.json': malformed
    })
    const report = buildFinalConsistencyReport(fixture({ sourceRoot }))
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy scan found')))
    assert.ok(report.zeroLegacyScan.findings.some((finding) => finding.rule === 'invalid-machine-json'))
})

test('zero-legacy malformed ECMAScript fails closed through final aggregation', (t) =>
{
    const malformed = 'export const current = {\n'
    const scanRoot = repositoryFixture(t, {
        'tools/release/malformed-behavior-qualification.mjs': malformed
    })
    const scan = scanZeroLegacyGovernance(scanRoot)
    assert.ok(scan.findings.some((finding) => finding.file === 'tools/release/malformed-behavior-qualification.mjs'
        && finding.rule === 'invalid-machine-source'
        && finding.location.startsWith('source:line:')))

    const sourceRoot = sourceRepositoryFixture(t, {
        'tools/release/malformed-behavior-qualification.mjs': malformed
    })
    const report = buildFinalConsistencyReport(fixture({ sourceRoot }))
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy scan found')))
    assert.ok(report.zeroLegacyScan.findings.some((finding) => finding.rule === 'invalid-machine-source'))
})

test('zero-legacy parser authority rejects link mode byte and locked dependency substitution', (t) =>
{
    const yamlFile = { 'config/testing/parser-authority-behavior-qualification.yaml': 'command: current-claim-cli\n' }
    const bundleRelative = 'src/frontend/node_modules/playwright-core/lib/utilsBundleImpl/index.js'

    const linkedRoot = repositoryFixture(t, yamlFile)
    fs.linkSync(path.join(linkedRoot, bundleRelative), path.join(linkedRoot, `${bundleRelative}.backup`))
    assert.throws(() => scanZeroLegacyGovernance(linkedRoot), /mode or link count is unsupported/u)

    const modeRoot = repositoryFixture(t, yamlFile)
    fs.chmodSync(path.join(modeRoot, bundleRelative), 0o600)
    assert.throws(() => scanZeroLegacyGovernance(modeRoot), /mode or link count is unsupported/u)

    const byteRoot = repositoryFixture(t, yamlFile)
    fs.writeFileSync(path.join(byteRoot, bundleRelative), 'module.exports = { yaml: {} }\n')
    assert.throws(() => scanZeroLegacyGovernance(byteRoot), /byte digest mismatch/u)

    const crossRoot = repositoryFixture(t, yamlFile)
    fs.unlinkSync(path.join(crossRoot, bundleRelative))
    fs.symlinkSync(path.join(repositorySourceRoot, bundleRelative), path.join(crossRoot, bundleRelative))
    assert.throws(() => scanZeroLegacyGovernance(crossRoot), /path is not canonical/u)

    const lockRoot = repositoryFixture(t, {
        ...yamlFile,
        'src/frontend/package.json': `${JSON.stringify({
            name: 'zero-legacy-fixture',
            version: '1.0.0',
            devDependencies: { '@playwright/test': '^1.58.0', typescript: '^6.0.3' }
        }, null, 4)}\n`
    })
    assert.throws(() => scanZeroLegacyGovernance(lockRoot), /consumer and package-lock chain is not exact/u)

    const jsoncRoot = repositoryFixture(t, {
        'config/testing/parser-authority-behavior-qualification.jsonc': '{ "command": "current-claim-cli", }\n'
    })
    const typescriptRelative = 'src/frontend/node_modules/typescript/lib/typescript.js'
    fs.unlinkSync(path.join(jsoncRoot, typescriptRelative))
    fs.symlinkSync(path.join(repositorySourceRoot, typescriptRelative), path.join(jsoncRoot, typescriptRelative))
    assert.throws(() => scanZeroLegacyGovernance(jsoncRoot), /path is not canonical/u)
})

test('zero-legacy lock admission preserves bytes while requiring strict duplicate-free JSON', async (t) =>
{
    const files = { 'config/testing/parser-authority-behavior-qualification.yaml': 'command: current-claim-cli\n' }
    const lockDocument = JSON.parse(parserLock)
    for (const [name, lockBytes] of [
        ['four-space', `${JSON.stringify(lockDocument, null, 4)}\n`],
        ['tabs', `${JSON.stringify(lockDocument, null, '\t')}\n`],
        ['compact', JSON.stringify(lockDocument)],
        ['whitespace', ` \n${JSON.stringify(lockDocument)}\n\t `]
    ])
    {
        await t.test(name, (context) =>
        {
            const repositoryRoot = repositoryFixture(context, files)
            const lockPath = path.join(repositoryRoot, 'src/frontend/package-lock.json')
            fs.writeFileSync(lockPath, lockBytes)
            const before = fs.readFileSync(lockPath)
            assert.deepEqual(scanZeroLegacyGovernance(repositoryRoot).findings, [])
            assert.ok(fs.readFileSync(lockPath).equals(before), 'scanner changed admitted lock bytes')
        })
    }
    for (const [name, lockBytes] of [
        ['duplicate-root', parserLock.replace('{', '{ "name": "duplicate",')],
        ['escaped-duplicate', parserLock.replace('"typescript": "^6.0.3"',
            '"typescript": "^6.0.3", "\\u0074ypescript": "^6.0.3"')],
        ['comment', parserLock.replace('{', '{ // comment')],
        ['syntax', parserLock.replace(/\}\n$/u, ',}\n')],
        ['invalid-utf8', Buffer.concat([Buffer.from(parserLock), Buffer.from([0xff])])]
    ])
    {
        await t.test(name, (context) =>
        {
            const repositoryRoot = repositoryFixture(context, files)
            const lockPath = path.join(repositoryRoot, 'src/frontend/package-lock.json')
            fs.writeFileSync(lockPath, lockBytes)
            const before = fs.readFileSync(lockPath)
            assert.throws(() => scanZeroLegacyGovernance(repositoryRoot), /strict duplicate-free JSON/u)
            assert.ok(fs.readFileSync(lockPath).equals(before), 'refusal changed lock bytes')
        })
    }
})

test('zero-legacy Markdown machine fences recognize every JavaScript line terminator', (t) =>
{
    const files = {}
    for (const [name, separator] of [['lf', '\n'], ['crlf', '\r\n'], ['cr', '\r'], ['u2028', '\u2028'], ['u2029', '\u2029']])
    {
        files[`docs/${name}-behavior-contract.md`] = ['# Contract', '```yaml', 'latestReceipt: stale.json', '```'].join(separator)
        files[`docs/${name}-current-contract.md`] = ['# Contract', '```yaml', 'currentReceipt: current.json', '```'].join(separator)
    }
    const findings = scanZeroLegacyGovernance(repositoryFixture(t, files)).findings
    for (const [name] of [['lf'], ['crlf'], ['cr'], ['u2028'], ['u2029']])
    {
        assert.ok(findings.some((finding) => finding.file === `docs/${name}-behavior-contract.md`
            && finding.rule === 'forbidden-evidence-selection:latestReceipt'), `${name} fence escaped`)
        assert.equal(findings.some((finding) => finding.file === `docs/${name}-current-contract.md`), false)
    }
})

test('zero-legacy Markdown machine fences follow CommonMark marker and length rules', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'docs/tilde-behavior-contract.md': '# Contract\n~~~yaml\nlatestReceipt: stale.json\n~~~~~\n',
        'docs/long-backtick-behavior-contract.md': [
            '# Contract',
            '````typescript',
            'const command = "deprecated-claim-cli"',
            '```',
            '`````'
        ].join('\n'),
        'docs/indented-current-contract.md': '# Contract\n    ~~~yaml\nlatestReceipt: prose-only\n    ~~~\n',
        'docs/current-tilde-contract.md': '# Contract\n~~~yaml\ncurrentReceipt: current.json\n~~~\n'
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file === 'docs/tilde-behavior-contract.md'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'docs/long-backtick-behavior-contract.md'
        && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    for (const file of ['docs/indented-current-contract.md', 'docs/current-tilde-contract.md'])
    {
        assert.equal(findings.some((finding) => finding.file === file), false, `${file} non-machine prose was scanned`)
    }
})

test('zero-legacy Markdown machine fences scan explicit block quote containers', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'docs/blockquote-behavior-contract.md': [
            '# Contract',
            '> ~~~yaml',
            '> latestReceipt: stale.json',
            '> ~~~'
        ].join('\n'),
        'docs/nested-blockquote-behavior-contract.md': [
            '# Contract',
            '> > ````typescript',
            '> > await import("./deprecated-claim-cli.mjs")',
            '> > ````'
        ].join('\n'),
        'docs/current-blockquote-contract.md': [
            '# Contract',
            '> ~~~yaml',
            '> currentReceipt: current.json',
            '> ~~~'
        ].join('\n')
    })
    const findings = scanZeroLegacyGovernance(repositoryRoot).findings
    assert.ok(findings.some((finding) => finding.file === 'docs/blockquote-behavior-contract.md'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.ok(findings.some((finding) => finding.file === 'docs/nested-blockquote-behavior-contract.md'
        && finding.rule === 'forbidden-legacy-surface:./deprecated-claim-cli.mjs'))
    assert.equal(findings.some((finding) => finding.file === 'docs/current-blockquote-contract.md'), false)
})

test('zero-legacy tracked gitlinks fail closed without pretending their contents were scanned', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {})
    const gitlink = path.join(repositoryRoot, 'src/vendor-behavior')
    fs.mkdirSync(gitlink, { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: gitlink })
    execFileSync('git', ['config', 'user.email', 'tests@fsusblog.local'], { cwd: gitlink })
    execFileSync('git', ['config', 'user.name', 'FsusBlog Tests'], { cwd: gitlink })
    fs.writeFileSync(path.join(gitlink, 'behavior-qualification.mjs'), 'const command = "deprecated-claim-cli"\n')
    execFileSync('git', ['add', '.'], { cwd: gitlink })
    execFileSync('git', ['commit', '--quiet', '-m', 'test: seal gitlink source'], { cwd: gitlink })
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    fs.writeFileSync(path.join(repositoryRoot, '.git/info/exclude'), 'src/frontend/node_modules/\n')
    execFileSync('git', ['add', 'src/vendor-behavior'], { cwd: repositoryRoot })

    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.equal(scan.scannedFileCount, 0)
    assert.ok(scan.findings.some((finding) => finding.file === 'src/vendor-behavior'
        && finding.rule === 'unsupported-tracked-gitlink'
        && finding.location === 'git-index'))
})

test('zero-legacy tracked symlinks are unsupported and expose target or worktree splits', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/current-target.mjs': 'export const current = true\n'
    })
    fs.symlinkSync('current-target.mjs', path.join(repositoryRoot, 'src/current-link.mjs'))
    fs.symlinkSync('deprecated-claim-cli.mjs', path.join(repositoryRoot, 'src/target-policy-link.mjs'))
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    fs.writeFileSync(path.join(repositoryRoot, '.git/info/exclude'), 'src/frontend/node_modules/\n')
    execFileSync('git', ['config', 'user.email', 'tests@fsusblog.local'], { cwd: repositoryRoot })
    execFileSync('git', ['config', 'user.name', 'FsusBlog Tests'], { cwd: repositoryRoot })
    execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
    execFileSync('git', ['commit', '--quiet', '-m', 'test: seal symlink policy'], { cwd: repositoryRoot })

    const clean = scanZeroLegacyGovernance(repositoryRoot)
    assert.equal(clean.scannedFileCount, 3)
    for (const file of ['src/current-link.mjs', 'src/target-policy-link.mjs'])
    {
        assert.ok(clean.findings.some((finding) => finding.file === file
            && finding.rule === 'unsupported-tracked-symlink'))
    }
    assert.ok(clean.findings.some((finding) => finding.file === 'src/target-policy-link.mjs'
        && finding.rule.includes('deprecated-claim-cli.mjs')))
    assert.equal(clean.findings.some((finding) => finding.rule.startsWith('tracked-worktree-index-split:')), false)

    fs.unlinkSync(path.join(repositoryRoot, 'src/current-link.mjs'))
    fs.writeFileSync(path.join(repositoryRoot, 'src/current-link.mjs'), 'export const current = true\n')
    fs.unlinkSync(path.join(repositoryRoot, 'src/target-policy-link.mjs'))
    fs.symlinkSync('current-target.mjs', path.join(repositoryRoot, 'src/target-policy-link.mjs'))
    const split = scanZeroLegacyGovernance(repositoryRoot)
    assert.ok(split.findings.some((finding) => finding.file === 'src/current-link.mjs'
        && finding.rule === 'tracked-worktree-index-split:mode'))
    assert.ok(split.findings.some((finding) => finding.file === 'src/target-policy-link.mjs'
        && finding.rule === 'tracked-worktree-index-split:oid'))
})

test('zero-legacy tracked files fail closed when an ancestor directory redirects outside the repository', (t) =>
{
    const content = 'export const current = true\n'
    const repositoryRoot = sourceRepositoryFixture(t, {
        'tools/release/nested/current-behavior-qualification.mjs': content
    })
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-zero-legacy-outside-'))
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(outsideRoot, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(outsideRoot, 'nested/current-behavior-qualification.mjs'), content)
    fs.rmSync(path.join(repositoryRoot, 'tools/release'), { recursive: true })
    fs.symlinkSync(outsideRoot, path.join(repositoryRoot, 'tools/release'), 'dir')

    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.ok(scan.findings.some((finding) => finding.file === 'tools/release/nested/current-behavior-qualification.mjs'
        && finding.rule === 'tracked-worktree-index-split:path'))
})

test('zero-legacy scans sparse and skip-worktree files from their exact index blobs', (t) =>
{
    const repositoryRoot = sourceRepositoryFixture(t, {
        'tools/current.mjs': 'export const current = true\n',
        'src/behavior-qualification.mjs': 'const command = "deprecated-claim-cli"\n'
    })
    const identityBefore = sealSourceIdentity(repositoryRoot)
    const hiddenOid = execFileSync('git', ['rev-parse', ':src/behavior-qualification.mjs'], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    }).trim()
    const replacementOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        input: 'export const current = true\n'
    }).trim()
    execFileSync('git', ['replace', hiddenOid, replacementOid], { cwd: repositoryRoot })
    assert.equal(execFileSync('git', ['cat-file', 'blob', hiddenOid], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    }), 'export const current = true\n')
    execFileSync('git', ['sparse-checkout', 'init', '--no-cone'], { cwd: repositoryRoot })
    execFileSync('git', ['sparse-checkout', 'set', 'tools'], { cwd: repositoryRoot })
    const identityAfter = sealSourceIdentity(repositoryRoot)
    assert.deepEqual(identityAfter, identityBefore)
    assert.equal(fs.existsSync(path.join(repositoryRoot, 'src/behavior-qualification.mjs')), false)

    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.equal(scan.scannedFileCount, 4)
    assert.ok(scan.findings.some((finding) => finding.file === 'src/behavior-qualification.mjs'
        && finding.rule.includes('deprecated-claim-cli')))
    assert.equal(scan.findings.some((finding) => finding.rule.startsWith('tracked-worktree-index-split:')), false)
})

test('zero-legacy Git authority ignores ambient index worktree alternate and config injection', (t) =>
{
    const repositoryRoot = sourceRepositoryFixture(t, {
        'src/behavior-qualification.mjs': 'const command = "deprecated-claim-cli"\n'
    })
    const alternateRoot = sourceRepositoryFixture(t, {
        'src/current.mjs': 'export const current = true\n'
    })
    const alternateIndex = path.join(alternateRoot, 'alternate.index')
    execFileSync('git', ['read-tree', '--empty'], {
        cwd: alternateRoot,
        env: { ...process.env, GIT_INDEX_FILE: alternateIndex }
    })
    const before = sealSourceIdentity(repositoryRoot)
    const poison = {
        GIT_INDEX_FILE: alternateIndex,
        GIT_DIR: path.join(alternateRoot, '.git'),
        GIT_WORK_TREE: alternateRoot,
        GIT_OBJECT_DIRECTORY: path.join(alternateRoot, '.git/objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repositoryRoot, '.git/objects'),
        GIT_REPLACE_REF_BASE: 'refs/poison/',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.repositoryformatversion',
        GIT_CONFIG_VALUE_0: '99'
    }
    const previous = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]))
    try
    {
        Object.assign(process.env, poison)
        assert.deepEqual(sealSourceIdentity(repositoryRoot), before)
        const scan = scanZeroLegacyGovernance(repositoryRoot)
        assert.equal(scan.scannedFileCount, 3)
        assert.ok(scan.findings.some((finding) => finding.file === 'src/behavior-qualification.mjs'
            && finding.rule === 'forbidden-legacy-surface:deprecated-claim-cli'))
    }
    finally
    {
        for (const [key, value] of Object.entries(previous))
        {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
})

test('zero-legacy and source identity consistently reject non-SHA1 repositories', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/current.mjs': 'export const current = true\n'
    })
    execFileSync('git', ['init', '--quiet', '--object-format=sha256'], { cwd: repositoryRoot })
    execFileSync('git', ['config', 'user.email', 'tests@fsusblog.local'], { cwd: repositoryRoot })
    execFileSync('git', ['config', 'user.name', 'FsusBlog Tests'], { cwd: repositoryRoot })
    execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
    execFileSync('git', ['commit', '--quiet', '-m', 'test: sha256 repository'], { cwd: repositoryRoot })
    assert.throws(() => sealSourceIdentity(repositoryRoot), /object format must be sha1/u)
    assert.throws(() => scanZeroLegacyGovernance(repositoryRoot), /object format must be sha1/u)
})

test('zero-legacy Git inventory survives symlink root spelling and excludes untracked files', (t) =>
{
    const repositoryRoot = sourceRepositoryFixture(t, {
        'src/frontend/dist/behavior-qualification.mjs': 'const receiptSource = "latest-receipt"\n'
    })
    fs.mkdirSync(path.join(repositoryRoot, 'tools'), { recursive: true })
    fs.writeFileSync(path.join(repositoryRoot, 'tools/untracked-behavior-qualification.mjs'), 'const command = "deprecated-claim-cli"\n')
    const alias = `${repositoryRoot}-alias`
    t.after(() => fs.rmSync(alias, { force: true }))
    fs.symlinkSync(repositoryRoot, alias, 'dir')

    const scan = scanZeroLegacyGovernance(alias)
    assert.equal(scan.scannedFileCount, 3)
    assert.ok(scan.findings.some((finding) => finding.file === 'src/frontend/dist/behavior-qualification.mjs'
        && finding.rule === 'forbidden-evidence-selection:latestReceipt'))
    assert.equal(scan.findings.some((finding) => finding.file === 'tools/untracked-behavior-qualification.mjs'), false)
})

test('zero-legacy reports worktree mode and content splits while scanning active bytes', (t) =>
{
    const repositoryRoot = sourceRepositoryFixture(t, {
        'tools/release/behavior-qualification.mjs': 'export const current = true\n'
    })
    const file = path.join(repositoryRoot, 'tools/release/behavior-qualification.mjs')
    fs.writeFileSync(file, 'const command = "deprecated-claim-cli"\n')
    fs.chmodSync(file, 0o755)

    const scan = scanZeroLegacyGovernance(repositoryRoot)
    assert.ok(scan.findings.some((finding) => finding.file === 'tools/release/behavior-qualification.mjs'
        && finding.rule === 'tracked-worktree-index-split:mode'))
    assert.ok(scan.findings.some((finding) => finding.file === 'tools/release/behavior-qualification.mjs'
        && finding.rule === 'tracked-worktree-index-split:oid'))
    assert.ok(scan.findings.some((finding) => finding.file === 'tools/release/behavior-qualification.mjs'
        && finding.rule.includes('deprecated-claim-cli')))
})

test('final builder recomputes zero-legacy findings from the sealed source state', (t) =>
{
    const residueRoot = sourceRepositoryFixture(t, {
        'config/testing/behavior-qualification.json': JSON.stringify({ latestReceipt: 'ambient.json' })
    })
    const injected = buildFinalConsistencyReport(fixture({
        sourceRoot: residueRoot,
        zeroLegacyScan: emptyZeroLegacyScan()
    }))
    assert.equal(injected.status, 'failed')
    assert.ok(injected.zeroLegacyScan.findings.some((finding) => finding.rule === 'forbidden-evidence-selection:latestReceipt'))

    const driftRoot = sourceRepositoryFixture(t, { 'src/current.mjs': 'export const current = true\n' })
    const drifted = fixture({ sourceRoot: driftRoot })
    fs.writeFileSync(path.join(driftRoot, 'src/current.mjs'), 'export const current = false\n')
    assert.throws(() => buildFinalConsistencyReport(drifted), /source\/worktree identity mismatch before scan/u)

    const parentRoot = sourceRepositoryFixture(t, Object.fromEntries(
        ['config', 'docs', 'src', 'tests', 'tools'].map((directory) => [
            `nested/${directory}/current.txt`,
            'current\n'
        ])
    ))
    const nested = fixture({ sourceRoot: parentRoot, admittedSourceRoot: path.join(parentRoot, 'nested') })
    assert.throws(() => buildFinalConsistencyReport(nested), /repository root must equal the Git top-level/u)
})

test('zero-legacy scan and final report schema are deterministic and structurally closed', (t) =>
{
    const repositoryRoot = repositoryFixture(t, {
        'src/behavior-qualification.ts': 'const last_reviewed_commit = "a"\n',
        'config/schemas/behavior.schema.json': JSON.stringify({ type: 'object' }),
        'tools/noop.mjs': 'export const value = 1\n',
        'tests/noop.test.mjs': 'export const value = 1\n',
        'docs/history.md': '# History\nNo active contract.\n'
    })
    const first = scanZeroLegacyGovernance(repositoryRoot)
    const second = scanZeroLegacyGovernance(repositoryRoot)
    assert.deepEqual(first, second)
    assert.equal(validateZeroLegacyScan(first), first)
    assert.throws(() => validateZeroLegacyScan({ ...first, unowned: true }), /scan shape is open/u)
    assert.throws(() => validateZeroLegacyScan({ ...first, scanRoots: first.scanRoots.slice(1) }), /roots are incomplete/u)
    assert.throws(() => validateZeroLegacyScan({ ...first, pathClassCounts: { production: 1 } }), /classes are incomplete/u)

    const openFinding = structuredClone(first)
    openFinding.findings[0].unowned = true
    assert.throws(() => validateZeroLegacyScan(openFinding), /finding shape is invalid/u)

    const duplicateFindingClass = structuredClone(first)
    duplicateFindingClass.findings[0].pathClasses.push(duplicateFindingClass.findings[0].pathClasses[0])
    assert.throws(() => validateZeroLegacyScan(duplicateFindingClass), /finding shape is invalid/u)

    const report = buildFinalConsistencyReport(fixture({ sourceRoot: sourceRepositoryFixture(t) }))
    const forgedOk = structuredClone(report)
    forgedOk.zeroLegacyScan.findings.push({
        file: 'config/testing/forged.json',
        pathClasses: ['config'],
        rule: 'forged-residue',
        location: '$'
    })
    forgedOk.contentDigest = `sha256:${hash(Object.fromEntries(
        Object.entries(forgedOk).filter(([key]) => key !== 'contentDigest')
    ))}`
    assert.throws(() => validateFinalReport(forgedOk), /ok report has zero-legacy findings/u)

    const schema = JSON.parse(fs.readFileSync('config/schemas/behavior-document-consistency-final-report.schema.json', 'utf8'))
    assert.deepEqual(validateJsonSchema(report, schema), [])
    assert.match(validateJsonSchema(forgedOk, schema).join('\n'), /more than 0 items/u)
    const failedWithFindings = structuredClone(forgedOk)
    failedWithFindings.status = 'failed'
    failedWithFindings.failureReasons = ['zero-legacy findings remain']
    assert.deepEqual(validateJsonSchema(failedWithFindings, schema), [])
    const openScan = structuredClone(report)
    openScan.zeroLegacyScan.unowned = true
    assert.match(validateJsonSchema(openScan, schema).join('\n'), /additional properties/u)
    const mismatchedRoot = structuredClone(report)
    mismatchedRoot.zeroLegacyScan.scanRoots[0].pathClass = 'production'
    assert.match(validateJsonSchema(mismatchedRoot, schema).join('\n'), /must be equal to constant/u)
})
