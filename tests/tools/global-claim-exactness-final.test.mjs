import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {digestValue} = await import(new URL('../../tools/fact-extractors/lib/canonicalize.mjs', import.meta.url));
const {buildGlobalClaimExactnessReceipt, globalExactnessScopeId, loadGlobalExactnessInputs, root, runGlobalMutationAggregate, scanGlobalDocResidue, validateGlobalClaimExactnessReceipt} = await import(new URL('../../tools/docs/global-claim-exactness-final.mjs', import.meta.url));
const {produceAuthSessionObservation} = await import(new URL('../../tools/contracts/lib/auth-session-observation.mjs', import.meta.url));
const {produceConfigErrorSecurityObservation} = await import(new URL('../../tools/contracts/lib/config-error-security-observation.mjs', import.meta.url));
const {produceContentLifecycleObservation} = await import(new URL('../../tools/contracts/lib/content-lifecycle-observation.mjs', import.meta.url));
const {produceOpenApiObservation} = await import(new URL('../../tools/contracts/lib/openapi-observation.mjs', import.meta.url));
const {produceRuntimeRoleObservation} = await import(new URL('../../tools/contracts/lib/runtime-role-observation.mjs', import.meta.url));
const {sealSourceIdentity} = await import(new URL('../../tools/fact-extractors/identity.mjs', import.meta.url));
const {runExtractor} = await import(new URL('../../tools/fact-extractors/runner.mjs', import.meta.url));
const {sealReceipt} = await import(new URL('../../tools/fact-extractors/receipt.mjs', import.meta.url));
const extractorIds = Object.freeze([
    'test-asset-audit-fact-extractor',
    'code-intent-fact-extractor',
    'document-lifecycle-fact-extractor',
    'test-matrix-fact-extractor',
    'openapi-aeds-fact-extractor',
    'auth-session-permission-fact-extractor',
    'config-error-security-policy-fact-extractor',
    'content-lifecycle-fact-extractor'
]);

const buildProviders = Object.freeze({
    'test-matrix-fact-extractor': () => produceRuntimeRoleObservation({ repositoryRoot: root }).buildIdentity,
    'openapi-aeds-fact-extractor': () => produceOpenApiObservation({ repositoryRoot: root }).buildIdentity,
    'auth-session-permission-fact-extractor': () => produceAuthSessionObservation({ repositoryRoot: root }).buildIdentity,
    'config-error-security-policy-fact-extractor': () => produceConfigErrorSecurityObservation({ repositoryRoot: root }).buildIdentity,
    'content-lifecycle-fact-extractor': () => produceContentLifecycleObservation({ repositoryRoot: root }).buildIdentity
});

let receipts;
let receiptDir;

test.before(async () =>
{
    receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-exactness-'));
    // Warm every compiled producer first so no build mutates the worktree
    // between extractor identities; then run each extractor and converge all
    // receipts onto one shared source identity (concurrent test files may
    // legitimately shift the untracked fingerprint mid-run; a shifted
    // extractor is simply re-run against the converged identity).
    const run = async (extractorId) =>
    {
        const buildIdentity = buildProviders[extractorId] ? buildProviders[extractorId]() : null;
        const { receipt } = await runExtractor({
            extractorId,
            repositoryRoot: root,
            buildIdentity,
            useCache: false
        });
        if (receipt.status !== 'ok')
        {
            assert.fail(`${extractorId} failed: ${receipt.failureReasons.join('; ')}`);
        }
        return receipt;
    };
    for (const extractorId of Object.keys(buildProviders))
    {
        buildProviders[extractorId]();
    }
    const byExtractor = new Map();
    for (const extractorId of extractorIds)
    {
        byExtractor.set(extractorId, await run(extractorId));
    }
    const identityOf = (receipt) => `${receipt.sourceCommit}:${receipt.worktreeFingerprint}`;
    for (let pass = 0; pass < 2; pass += 1)
    {
        const identities = new Set([...byExtractor.values()].map(identityOf));
        if (identities.size === 1)
        {
            break;
        }
        const current = sealSourceIdentity(root);
        for (const extractorId of extractorIds)
        {
            const receipt = byExtractor.get(extractorId);
            if (identityOf(receipt) !== `${current.sourceCommit}:${current.worktreeFingerprint}`)
            {
                byExtractor.set(extractorId, await run(extractorId));
            }
        }
    }
    const identities = new Set([...byExtractor.values()].map(identityOf));
    assert.equal(identities.size, 1, 'all extractor receipts must share one source identity');
    for (const [extractorId, receipt] of byExtractor)
    {
        fs.writeFileSync(path.join(receiptDir, `${extractorId}.json`), JSON.stringify(receipt));
    }
    receipts = fs.readdirSync(receiptDir).map((entry) => path.join(receiptDir, entry));
});

test('global mutation aggregate kills every negative class', () =>
{
    const aggregate = runGlobalMutationAggregate();
    assert.equal(aggregate.killed, aggregate.total);
    assert.ok(aggregate.total >= 12);
});

test('global residue scanner rejects forbidden manual authority surfaces', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-residue-'));
    try
    {
        fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
        const documentPath = 'docs/global-residue-probe.md';
        fs.writeFileSync(path.join(directory, documentPath), 'reviewed: lastReviewedAt: 2026-01-01\n');
        const findings = scanGlobalDocResidue(directory, [documentPath]);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].classId, 'global-self-certification');
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    assert.deepEqual(scanGlobalDocResidue(root, ['docs/testing.md', 'docs/api.md']), []);
});

test('global exactness terminal receipt is ok with warnings=0', async () =>
{
    const first = JSON.parse(fs.readFileSync(receipts[0], 'utf8'));
    const receipt = await buildGlobalClaimExactnessReceipt({
        repositoryRoot: root,
        observationReceiptPaths: receipts,
        runId: 'global-claim-exactness-test',
        sourceCommit: first.sourceCommit,
        worktreeFingerprint: first.worktreeFingerprint
    });
    validateGlobalClaimExactnessReceipt(receipt, { expectedRunId: 'global-claim-exactness-test' });
    assert.equal(receipt.runId, 'global-claim-exactness-test');
    await assert.rejects(() => buildGlobalClaimExactnessReceipt({
        repositoryRoot: root,
        observationReceiptPaths: receipts,
        sourceCommit: first.sourceCommit,
        worktreeFingerprint: first.worktreeFingerprint
    }), /runId is required/u);
    const crossRun = structuredClone(receipt);
    crossRun.runId = 'global-claim-exactness-other-run';
    crossRun.contentDigest = digestValue({ ...crossRun, contentDigest: null });
    assert.throws(() => validateGlobalClaimExactnessReceipt(crossRun, {
        expectedRunId: 'global-claim-exactness-test'
    }), /runId mismatch/u);
    const expanded = structuredClone(receipt);
    expanded.unclaimedAuthority = true;
    expanded.contentDigest = digestValue({ ...expanded, contentDigest: null });
    assert.throws(() => validateGlobalClaimExactnessReceipt(expanded), /fields are not sealed/u);
    assert.equal(receipt.scopeId, globalExactnessScopeId);
    assert.equal(receipt.counts.requiredBehaviors, 9);
    assert.equal(receipt.counts.scopes, 6);
    assert.equal(receipt.counts.missing, 0);
    assert.equal(receipt.counts.extra, 0);
    assert.equal(receipt.counts.warnings, 0);
    assert.equal(receipt.claimAcceptance.length,
        receipt.counts.generatedClaimCount + receipt.counts.proseClaimCount);
    assert.equal(new Set(receipt.claimAcceptance.map((claim) => claim.claimId)).size,
        receipt.claimAcceptance.length);
    assert.ok(receipt.claimAcceptance
        .filter((claim) => claim.behaviorId === 'browserless-production-correctness')
        .every((claim) => /^sha256:[a-f0-9]{64}$/u.test(claim.claimDigest)));

    for (const mutate of [
        (value) => value.claimAcceptance.push(structuredClone(value.claimAcceptance[0])),
        (value) =>
        {
            value.claimAcceptance[0].claimDigest = 'sha256:invalid';
        }
    ])
    {
        const changed = structuredClone(receipt);
        mutate(changed);
        changed.contentDigest = digestValue({ ...changed, contentDigest: null });
        assert.throws(() => validateGlobalClaimExactnessReceipt(changed),
            /global exactness claim acceptance is invalid/u);
    }
});

test('global exactness fails closed on ledger, claim and observation tamper', async () =>
{
    const input = await loadGlobalExactnessInputs(root, receipts);
    const first = input.receipts[0].raw;
    const base = {
        repositoryRoot: root,
        observationReceiptPaths: receipts,
        runId: 'global-claim-exactness-test',
        sourceCommit: first.sourceCommit,
        worktreeFingerprint: first.worktreeFingerprint
    };

    let stale = structuredClone(input.receipts.find((entry) => entry.view.extractorId === 'test-matrix-fact-extractor').raw);
    stale.worktreeFingerprint = 'f'.repeat(64);
    stale = sealReceipt(stale);
    const staleResult = await buildGlobalClaimExactnessReceipt({
        ...base,
        observationReceiptPaths: receipts.map((entry) => (
            entry.includes('test-matrix-fact-extractor') ? writeReceipt(stale) : entry
        ))
    });
    assert.equal(staleResult.status, 'failed');
    assert.ok(staleResult.failureReasons.some((reason) => /stale observation source identity/u.test(reason)));

    let drifted = structuredClone(input.receipts.find((entry) => entry.view.extractorId === 'test-matrix-fact-extractor').raw);
    drifted.observations.releaseFinalAggregate.artifactOnly = false;
    drifted = sealReceipt(drifted);
    const driftedResult = await buildGlobalClaimExactnessReceipt({
        ...base,
        observationReceiptPaths: receipts.map((entry) => (
            entry.includes('test-matrix-fact-extractor') ? writeReceipt(drifted) : entry
        ))
    });
    assert.equal(driftedResult.status, 'failed');
    assert.ok(driftedResult.failureReasons.some((reason) =>
        /prose verification|generated section drift/u.test(reason)));
});

function writeReceipt(receipt)
{
    const file = path.join(receiptDir, `tampered-${receipt.extractorId}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(receipt));
    return file;
}
