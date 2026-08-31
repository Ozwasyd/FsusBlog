import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs';
import {
    buildFinalConsistencyReport,
    validateFinalReport
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/docs/behavior-document-consistency-final.mjs';

const commit = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const runId = 'final-round';
const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value;
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const seal = (value, keepNull = false) =>
{
    const receipt = { ...value, contentDigest: null };
    const content = keepNull ? receipt : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'));
    receipt.contentDigest = `sha256:${hash(content)}`;
    return receipt;
};

function fixture(overrides = {})
{
    const catalog = {
        schema: 'fsusblog.behavior-contract-catalog.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        domains: ['testing'],
        extractors: [{ id: 'alpha-facts', path: 'tools/alpha.mjs' }],
        contracts: [{
            id: 'alpha-behavior', domain: 'testing', risk: 'high', status: 'active',
            implementationOwnerCardinality: 'one', allowedImplementationOwnerRoles: [],
            factExtractorId: 'alpha-facts', requiredTestKinds: ['positive'],
            documentationPolicy: 'required', documentationRationale: 'Alpha is current.',
            allowedClaimTypes: ['behavioral'], releaseQualification: true,
            evidenceStage: 'pre-runtime', coverageIds: ['alpha'], documents: ['docs/alpha.md']
        }]
    };
    const catalogHash = digestCatalog(catalog);
    const admission = seal({
        schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
        run: { id: runId },
        source: { commit, worktreeFingerprint: fingerprint },
        worktree: { root: '/repo' },
        toolchain: { node: 'v24', dotnet: '10', platform: 'linux', architecture: 'x64', directoryBuildPropsDigest: '1'.repeat(64) },
        authorityDigests: {
            catalog: catalogHash, claim: '2'.repeat(64), extractorRegistry: '3'.repeat(64),
            generatedSectionCatalog: '4'.repeat(64), generatedRenderer: '5'.repeat(64),
            proseRenderer: '6'.repeat(64), mutationCatalog: '7'.repeat(64)
        },
        implementationOwner: { status: 'ok', bindingCount: 1, contentDigest: '8'.repeat(64) },
        factObservations: {},
        minimalContractBuild: { contentDigest: '9'.repeat(64) },
        generated: { status: 'ok' }, prose: { status: 'ok' }, mutationFixtures: { status: 'ok' },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: [], durationMs: 1
    }, true);
    const pre = seal({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        buildIdentities: {}, registryDigest: `sha256:${'3'.repeat(64)}`,
        catalogDigest: `sha256:${catalogHash}`, staticClaimVerificationDigest: `sha256:${'c'.repeat(64)}`,
        behaviorIds: ['alpha-behavior'], requiredTestKinds: { 'alpha-behavior': ['positive'] },
        observedTestKinds: { 'alpha-behavior': ['positive'] }, mutationStatus: {},
        runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    });
    const post = seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        candidateIdentity: { buildReceiptDigest: `sha256:${'d'.repeat(64)}`, runtimeEvidenceDigest: `sha256:${'e'.repeat(64)}`, browserContractDigest: `sha256:${'f'.repeat(64)}` },
        preRuntimeReceiptDigest: pre.contentDigest, catalogDigest: `sha256:${catalogHash}`,
        behaviorIds: [], requiredRuntimeProducers: [], observedBehaviorResults: [], documentClaimDigests: {},
        missing: [], orphans: [], conflicts: [], releaseFinalSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: []
    });
    const owner = seal({ status: 'ok', bindings: [{ behaviorId: 'alpha-behavior', sourcePath: 'src/alpha.cs' }] });
    const fact = seal({ status: 'ok', extractorId: 'alpha-facts', behaviorIds: ['alpha-behavior'], sourceCommit: commit, worktreeFingerprint: fingerprint });
    const claims = seal({ claims: [{ declaration: { behaviorId: 'alpha-behavior', claimId: 'alpha.current' } }] });
    const verification = seal({ status: 'ok' });
    const generated = seal({ status: 'ok' });
    const migrationLedger = { schema: 'fixture', scopes: [{ scopeId: 'alpha', entries: [{ behaviorId: 'alpha-behavior', documentPath: 'docs/alpha.md', claimIds: ['alpha.current'], generatedSectionIds: [] }] }] };
    const matrix = { tiers: [
        { id: 'static', executionDependsOn: [], summaryAuthority: null },
        { id: 'pre', executionDependsOn: ['static'], summaryAuthority: null },
        { id: 'post', executionDependsOn: ['pre'], summaryAuthority: null }
    ] };
    return {
        staticAdmissionReceipt: admission, preRuntimeReceipt: pre, postRuntimeReceipt: post,
        ownerReceipt: owner, factObservationReceipts: [fact], docClaimParseReceipt: claims,
        docClaimVerificationReceipt: verification, generatedSectionReceipt: generated,
        catalog, migrationLedger, matrix, zeroLegacyScan: { scannedFileCount: 10, findings: [] },
        ...overrides
    };
}

test('final consistency report deterministically closes every behavior edge', () =>
{
    const report = buildFinalConsistencyReport(fixture());
    assert.equal(validateFinalReport(report).status, 'ok', report.failureReasons.join('; '));
    assert.equal(report.behaviorNodes[0].status, 'ok');
    assert.equal(report.dagAudit.stronglyConnectedComponents.length, 0);
});

test('stale identities, graph cycles and legacy residue fail without repairing producers', () =>
{
    const stalePost = fixture().postRuntimeReceipt;
    stalePost.sourceIdentity.commit = 'd'.repeat(40);
    stalePost.contentDigest = seal(Object.fromEntries(Object.entries(stalePost).filter(([key]) => key !== 'contentDigest'))).contentDigest;
    const input = fixture({
        postRuntimeReceipt: stalePost,
        matrix: { tiers: [{ id: 'a', executionDependsOn: ['b'] }, { id: 'b', executionDependsOn: ['a'] }] },
        zeroLegacyScan: { scannedFileCount: 10, findings: [{ file: 'config/active.json', rule: 'forbidden-machine-field:lastReviewedAt', location: '$.lastReviewedAt' }] }
    });
    const report = buildFinalConsistencyReport(input);
    assert.equal(report.status, 'failed');
    assert.ok(report.failureReasons.some((reason) => reason.includes('identity mismatch')));
    assert.ok(report.failureReasons.some((reason) => reason.includes('SCC')));
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy')));
});

test('tampered input receipt is rejected before final aggregation', () =>
{
    const input = fixture();
    input.ownerReceipt.bindings = [];
    assert.throws(() => buildFinalConsistencyReport(input), /contentDigest mismatch/u);
});
