import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    admitBrowserReleaseCleanAttempt,
    readCleanAttemptConsumerInventory
} from '../../tools/release/browser-release-clean-attempt-consumers.mjs';
import { runProducerAttempts } from '../../tools/test/attempt-runner.mjs';
import { sha256 } from '../../tools/test/attempt-provenance.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixtureCommand = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const sourceCommit = '1'.repeat(40);
const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
const authorityReferences = [
    ['execution-envelope', '3'],
    ['replay-plan', '4'],
    ['temporal-context', '5']
].map(([kind, digit]) => ({
    kind,
    artifactPath: `${kind}.json`,
    artifactDigest: `sha256:${digit.repeat(64)}`,
    verificationReceiptPath: `${kind}.verification.json`,
    verificationReceiptDigest: `sha256:${digit.repeat(64)}`
}));

function verifyAuthority(producerId, schedulerRunId)
{
    return (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    });
}

async function evidence(directory, {
    producerId = 'shared-correctness',
    schedulerRunId = 'shared-clean-run',
    scenario = 'success',
    retryPolicyId = 'correctness-first-attempt'
} = {})
{
    const result = await runProducerAttempts({
        evidenceRoot: directory,
        producerId,
        retryPolicyId,
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, fixtureCommand, scenario],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences,
        verifyAuthority: verifyAuthority(producerId, schedulerRunId),
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    return {
        aggregateReceipt: result.aggregate,
        loadAttempt: (reference) => result.attempts[reference.attemptNumber - 1],
        verifyAuthority: verifyAuthority(producerId, schedulerRunId),
        verifyArtifact: (relative, digest, receipt) => {
            const file = path.join(result.producerRoot, `attempt-${receipt.attemptNumber}`, relative);
            return fs.existsSync(file) && sha256(fs.readFileSync(file)) === digest;
        },
        expectedIdentity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    };
}

const memberships = Object.freeze({
    'browser-contract': {
        browsers: ['chromium'],
        projects: ['public'],
        semanticArtifactIds: ['browser-contract-receipt', 'trace'],
        testIds: ['browser:public-reading']
    },
    'production-correctness': {
        selectedTierIds: ['backend-api-integration', 'frontend-tests'],
        testVectors: ['anonymous', 'binary', 'logged-in']
    },
    'release-reliability': {
        lifecyclePhases: ['measurement', 'postcondition', 'precondition', 'reset'],
        scenarioIds: [
            'release-data-scale-m',
            'release-load-burst',
            'release-load-peak',
            'release-memory-leak-budget',
            'release-mutation-critical-slice',
            'release-open-handle-budget',
            'release-soak-min'
        ]
    }
});

function admit(consumerId, attemptEvidence, membership = memberships[consumerId])
{
    return admitBrowserReleaseCleanAttempt({
        consumerId,
        attemptEvidence,
        membership,
        expected: memberships[consumerId]
    });
}

test('inventory covers the exact Browser, Reliability and Production consumers', () =>
{
    const inventory = readCleanAttemptConsumerInventory();
    assert.deepEqual(inventory.consumers.map((entry) => entry.id).sort(), [
        'browser-contract',
        'production-correctness',
        'release-reliability'
    ]);
    assert.equal(inventory.migrationState, 'migrated');
    assert.equal(inventory.qualificationEligible, true);
});

test('all three consumers admit the same clean attempt through one verifier', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-clean-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    for (const consumerId of Object.keys(memberships))
    {
        const verdict = admit(consumerId, clean);
        assert.equal(verdict.eligible, true, consumerId);
        assert.equal(verdict.attemptVerdict.eligible, true, consumerId);
        assert.deepEqual(verdict.reasons, []);
    }
});

test('recovered diagnostic verdict and canonical reason are identical across consumers', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-recovered-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const recovered = await evidence(directory, {
        producerId: 'browser-diagnostics',
        schedulerRunId: 'diagnostic-run',
        scenario: 'browser-crash-once',
        retryPolicyId: 'diagnostic-browser-process-crash'
    });
    const results = Object.keys(memberships).map((consumerId) => admit(consumerId, recovered));
    assert.ok(results.every((result) => result.eligible === false));
    assert.ok(results.every((result) => result.reasons === result.attemptVerdict.reasons));
    assert.deepEqual(
        results.map((result) => result.reasons),
        [results[0].reasons, results[0].reasons, results[0].reasons]
    );
    assert.equal(results[0].reasons[0].code, 'attempt.not-clean-first');
});

test('missing attempt provenance, cross-run authority and tampered artifacts fail closed', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-invalid-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    const invalid = [
        { ...clean, aggregateReceipt: { status: 'ok', exitCode: 0 } },
        { ...clean, expectedIdentity: { ...clean.expectedIdentity, schedulerRunId: 'other-run' } },
        { ...clean, verifyArtifact: () => false }
    ];
    for (const attemptEvidence of invalid)
    {
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, attemptEvidence));
        assert.ok(results.every((result) => result.eligible === false));
        assert.deepEqual(
            results.map((result) => result.reasons),
            [results[0].reasons, results[0].reasons, results[0].reasons]
        );
    }
});

test('domain membership remains exact and cannot be replaced by group status', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-membership-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    for (const consumerId of Object.keys(memberships))
    {
        const fields = Object.keys(memberships[consumerId]);
        const missing = structuredClone(memberships[consumerId]);
        missing[fields[0]] = missing[fields[0]].slice(1);
        assert.equal(admit(consumerId, clean, missing).eligible, false);
        assert.equal(admitBrowserReleaseCleanAttempt({
            consumerId,
            attemptEvidence: clean,
            membership: { status: 'ok' },
            expected: memberships[consumerId]
        }).eligible, false);
    }
});
