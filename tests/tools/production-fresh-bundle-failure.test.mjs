import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { createProductionFreshOutputRoot, productionFreshGovernanceOutputs, productionFreshOutputEnvironment, verifyProductionFreshReceiptInventory } = await import(new URL("../../tools/test-matrix/production-fresh-run-bound-outputs.mjs", import.meta.url));
const { createSchedulerRunOwner, schedulerCandidateIdentityDigest } = await import(new URL("../../tools/test-matrix/scheduler-run-owner.mjs", import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('a real bundle step failure preserves its reason and emits aggregate-verifiable partial receipts', {
    timeout: 30_000
}, (t) =>
{
    const runId = `bundle-failure-${process.pid}-${randomUUID()}`;
    const runsRoot = path.join(root, '.tmp', 'test-runs');
    const buildRoot = path.join(root, '.tmp', 'build', runId);
    const runDirectory = path.join(runsRoot, runId);
    const lockDirectory = path.join(runsRoot, '.locks', `${runId}.lock`);
    t.after(() =>
    {
        fs.rmSync(runDirectory, { recursive: true, force: true });
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        fs.rmSync(buildRoot, { recursive: true, force: true });
    });

    const layout = createProductionFreshOutputRoot({ root, runId });
    const targetTierId = 'production';
    const namespace = `${runId}-namespace`;
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`
    };
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId,
        targetTierId,
        namespace,
        sourceState
    });
    const owner = createSchedulerRunOwner({
        runId,
        candidateIdentityDigest,
        targetTierId
    });
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify(owner)}\n`);
    fs.writeFileSync(path.join(runDirectory, 'checkpoint.json'), `${JSON.stringify({
        schema: 'fsusblog.test-matrix.checkpoint.v1',
        runId,
        targetTierId,
        namespace,
        schedulerCandidateIdentityDigest: candidateIdentityDigest,
        mode: 'fresh',
        authoritative: true,
        status: 'failure',
        revision: 1,
        budgetPolicyDigest: null,
        sourceState,
        tiers: {
            'local-production-backend-tests': {
                status: 'failure',
                reason: 'fixture backend producer failed'
            },
            'local-production-build-static': {
                status: 'failure',
                reason: 'fixture build producer failed'
            }
        }
    }, null, 2)}\n`);

    const child = spawnSync(process.execPath, [
        path.join(root, 'tools/test/bundles/run-bundle.mjs'),
        'runtime-browser'
    ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
            ...process.env,
            ...productionFreshOutputEnvironment(layout, 'local-production-runtime-browser'),
            FSUSBLOG_LOCAL_PROFILE: 'production',
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: buildRoot,
            FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT: layout.outputRoot,
            FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID: layout.attemptId,
            FSUSBLOG_BUNDLE_CPU_BUDGET: '1',
            FSUSBLOG_BUNDLE_MEMORY_GIB: '4',
            FSUSBLOG_BUNDLE_DEADLINE_MS: '100',
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '',
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: ''
        }
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 1, `${child.stdout}\n${child.stderr}`);

    const bundleRoot = path.join(layout.outputRoot, 'bundles', 'runtime-browser');
    const summary = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'summary.json'), 'utf8'));
    const resourceUtilization = JSON.parse(fs.readFileSync(
        path.join(bundleRoot, 'resource-utilization.json'),
        'utf8'
    ));
    assert.equal(summary.status, 'partial');
    assert.equal(resourceUtilization.status, 'partial');

    const primaryPrefix = '[local-production:runtime-browser] ';
    const primaryLine = child.stderr.split(/\r?\n/u)
        .find((line) => line.startsWith(primaryPrefix) && !line.includes('failure finalization:'));
    assert.ok(primaryLine, child.stderr);
    assert.doesNotMatch(child.stderr, /failure finalization:/u);
    const primaryFailure = primaryLine.slice(primaryPrefix.length);
    assert.equal(summary.failure.message, primaryFailure);

    const receiptRoot = path.join(
        layout.outputRoot,
        'artifacts',
        'producer-receipts',
        'runtime-browser'
    );
    const receipts = fs.readdirSync(receiptRoot)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => JSON.parse(fs.readFileSync(path.join(receiptRoot, name), 'utf8')));
    const finalizer = receipts.find((receipt) => (
        receipt.producerId === 'runtime-browser/failure-finalizer'
    ));
    assert.ok(finalizer);
    assert.equal(finalizer.status, 'partial');
    assert.equal(finalizer.failure, primaryFailure);
    assert.deepEqual(finalizer.relativeOutputs, [
        'bundles/runtime-browser/resource-utilization.json',
        'bundles/runtime-browser/summary.json'
    ]);
    assert.ok(receipts.some((receipt) => (
        receipt.status === 'partial'
    && receipt.relativeOutputs.some((relative) => relative.endsWith('.log'))
    )));

    const aggregate = verifyProductionFreshReceiptInventory({
        layout,
        receipts,
        governanceOutputs: productionFreshGovernanceOutputs(layout)
    });
    assert.ok(aggregate.relativeOutputs.includes('bundles/runtime-browser/summary.json'));
    assert.ok(aggregate.relativeOutputs.includes('bundles/runtime-browser/resource-utilization.json'));
});
