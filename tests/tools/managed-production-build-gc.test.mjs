import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { managedProductionBuildGcTier } from '../../tools/run-test-matrix.mjs';
import { executeManagedProductionBuildGc, parseManagedBuildGcArgs } from '../../tools/test-matrix/production-build-gc.mjs';
import { finalizeProductionBuildLayout, prepareProductionBuildLayout } from '../../tools/test-matrix/production-build-layout.mjs';

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-managed-build-gc-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function completeRoot(root, runId)
{
    const layout = prepareProductionBuildLayout({ root, runId });
    fs.writeFileSync(path.join(layout.runRoot, 'artifact.bin'), runId);
    finalizeProductionBuildLayout(layout, { status: 'cancelled' });
    return layout;
}

test('managed GC deletes a stale complete root, records a post-observation, and retains the current root', t =>
{
    const root = fixture(t);
    const stale = completeRoot(root, 'stale-complete');
    const current = completeRoot(root, 'current-run');
    const report = executeManagedProductionBuildGc({
        root,
        currentRunId: 'current-run',
        byteBudget: 1024 * 1024,
        inodeBudget: 10_000,
        dryRun: false
    });
    assert.equal(report.status, 'success');
    assert.equal(fs.existsSync(stale.runRoot), false);
    assert.equal(fs.existsSync(current.runRoot), true);
    const staleReceipt = report.roots.find((entry) => entry.runId === 'stale-complete');
    assert.deepEqual(staleReceipt.deleteResult, { status: 'deleted' });
    assert.deepEqual(staleReceipt.postObservation, { exists: false });
    assert.equal(report.failureClass, null);
});

test('dry-run is never a clean measurement cleanup receipt', t =>
{
    const root = fixture(t);
    const stale = completeRoot(root, 'dry-run-stale');
    const report = executeManagedProductionBuildGc({
        root,
        currentRunId: 'current-run',
        byteBudget: 1024 * 1024,
        inodeBudget: 10_000,
        dryRun: true
    });
    assert.equal(report.status, 'failure');
    assert.equal(report.failureClass, 'infra.build-gc');
    assert.equal(fs.existsSync(stale.runRoot), true);
});

test('delete failure produces an infra.build-gc receipt and cannot qualify a clean environment', t =>
{
    const root = fixture(t);
    const report = executeManagedProductionBuildGc({
        root,
        currentRunId: 'current-run',
        byteBudget: 1024 * 1024,
        inodeBudget: 10_000,
        dryRun: false,
        collectRoots({ onRoot })
        {
            onRoot({
                runId: 'stale-complete',
                identity: { runId: 'stale-complete' },
                size: { byteCount: 1, inodeCount: 1 },
                decision: 'retain-identity-changed',
                deleteResult: { status: 'not-deleted' },
                postObservation: { exists: true }
            });
            return { removed: [], retained: ['stale-complete'], reclaimed: { byteCount: 0, inodeCount: 0 }, durationMs: 1 };
        }
    });
    assert.equal(report.status, 'failure');
    assert.equal(report.failureClass, 'infra.build-gc');
});

test('root without layout or active owner identity is unknown, retained, and fails closed', t =>
{
    const root = fixture(t);
    const unknownRoot = path.join(root, '.tmp/build/unknown-no-owner');
    fs.mkdirSync(unknownRoot, { recursive: true });
    fs.writeFileSync(path.join(unknownRoot, 'partial-artifact.bin'), 'unowned');

    const report = executeManagedProductionBuildGc({
        root,
        currentRunId: 'current-run',
        byteBudget: 1024 * 1024,
        inodeBudget: 10_000,
        dryRun: false
    });

    assert.equal(report.status, 'failure');
    assert.equal(report.failureClass, 'infra.build-gc');
    assert.equal(fs.existsSync(unknownRoot), true);
    assert.match(report.failure, /owner identity is missing: unknown-no-owner/u);
    assert.deepEqual(report.roots.map(entry => ({
        runId: entry.runId,
        decision: entry.decision,
        deleteStatus: entry.deleteResult?.status,
        exists: entry.postObservation?.exists
    })), [{
        runId: 'unknown-no-owner',
        decision: 'block-unverifiable-identity',
        deleteStatus: 'not-attempted',
        exists: true
    }]);
});

test('managed GC tier uses scheduler enum values instead of boolean metadata', () =>
{
    const tier = managedProductionBuildGcTier('enum-contract');
    assert.equal(tier.requiresBootstrap, 'none');
    assert.equal(tier.requiresPlaywright, 'none');
});

test('managed GC argument and source governance reject the detached/unref implementation', () =>
{
    assert.throws(() => parseManagedBuildGcArgs(['--current-run', 'ok', '--byte-budget', '0']), /positive integer/u);
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const runner = fs.readFileSync(path.join(repositoryRoot, 'tools/run-test-matrix.mjs'), 'utf8');
    const ciJobRunner = runner.slice(
        runner.indexOf('async function runCiJobScheduled('),
        runner.indexOf('\nasync function runCiJob(')
    );
    const localProfileRunner = runner.slice(
        runner.indexOf('export async function runLocalProfile('),
        runner.indexOf('\nasync function runCiJob(')
    );
    const layout = fs.readFileSync(path.join(repositoryRoot, 'tools/test-matrix/production-build-layout.mjs'), 'utf8');
    assert.match(runner, /prependManagedProductionBuildGc\(.*?runId/u);
    assert.match(
        ciJobRunner,
        /const scheduledTiers = prependManagedProductionBuildGc\([\s\S]*?await runDag\(\{[\s\S]*?tiers: scheduledTiers/u
    );
    assert.doesNotMatch(localProfileRunner, /throw finalizationError/u);
    assert.ok(
        localProfileRunner.indexOf('finalizationError = error;')
        < localProfileRunner.indexOf('runtime.productionCapacityReservation.release('),
        'runtime cleanup failure must be recorded before the capacity reservation is released'
    );
    assert.doesNotMatch(runner, /scheduleStaleProductionBuildGc/u);
    assert.doesNotMatch(layout, /child\.unref|detached:\s*true/u);
});
