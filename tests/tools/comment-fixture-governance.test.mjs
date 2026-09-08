import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    buildCommentFixtureAcceptanceReceipt,
    buildCanonicalCommentFixtureRuntimeEvidence,
    buildCommentFixtureCleanupReceipt,
    COMMENT_FIXTURE_REPOSITORY_ROOT,
    verifyCommentFixtureAcceptanceReceipt
} from '../../tools/test/comment-fixture-governance.mjs';

test('comment governance kills required mutations but refuses terminal acceptance without runtime evidence', () =>
{
    const cleanup = buildCommentFixtureCleanupReceipt();
    const acceptance = buildCommentFixtureAcceptanceReceipt(cleanup, { runs: [], cleanups: [] });
    assert.equal(acceptance.schema, 'fsusblog.comment-fixture-acceptance.v1');
    assert.equal(acceptance.status, 'rejected');
    assert.deepEqual(acceptance.warnings, []);
    assert.equal(acceptance.demoIsolation.status, 'accepted');
    assert.ok(acceptance.mutations.length >= 10);
    assert.ok(acceptance.mutations.every((item) => item.killed === true));
    assert.ok(acceptance.violations.some((item) => item.id === 'runtime.parallel-rerun'));
    assert.throws(
        () => verifyCommentFixtureAcceptanceReceipt(acceptance, cleanup, { runs: [], cleanups: [] }),
        /not terminal accepted/u
    );
});

test('canonical runtime fixture can exercise terminal verification without becoming CLI evidence', () =>
{
    const cleanup = buildCommentFixtureCleanupReceipt();
    const runtimeEvidence = buildCanonicalCommentFixtureRuntimeEvidence();
    const acceptance = buildCommentFixtureAcceptanceReceipt(cleanup, runtimeEvidence);

    assert.equal(acceptance.status, 'accepted');
    assert.deepEqual(acceptance.violations, []);
    assert.deepEqual(verifyCommentFixtureAcceptanceReceipt(
        acceptance,
        cleanup,
        runtimeEvidence), acceptance);

    const tampered = structuredClone(acceptance);
    tampered.parallelRerun.status = 'rejected';
    assert.throws(
        () => verifyCommentFixtureAcceptanceReceipt(tampered, cleanup, runtimeEvidence),
        /tampered, or not terminal accepted/u
    );

    const crossDomainCleanup = structuredClone(runtimeEvidence);
    crossDomainCleanup.cleanups[0].deletedCommentIds.push(999999);
    const rejected = buildCommentFixtureAcceptanceReceipt(cleanup, crossDomainCleanup);
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.violations.some((item) => item.id === 'runtime.cleanup-1'));
});

test('comment terminal verifier requires two independent canonical production runs and cleanup observations', () =>
{
    const cleanup = buildCommentFixtureCleanupReceipt();
    const incompleteRun = {
        producerId: 'comment-moderation',
        strategy: 'transaction-fixture',
        capabilityProofs: [],
        threadEntities: [],
        moderation: {},
        cleanupReceipt: {}
    };
    const acceptance = buildCommentFixtureAcceptanceReceipt(cleanup, {
        runs: [incompleteRun, structuredClone(incompleteRun)],
        cleanups: [{}, {}]
    });
    assert.equal(acceptance.status, 'rejected');
    assert.equal(acceptance.consumerParity.status, 'rejected');
    assert.ok(acceptance.violations.some((item) => item.detail?.includes('zk_anonymous')));
    assert.ok(acceptance.violations.some((item) => item.detail?.includes('cleanup verification')));
});

test('comment governance CLI cannot write terminal artifacts without canonical runtime evidence', () =>
{
    const output = path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, '.tmp/test-evidence/comment-fixture-acceptance.json');
    rmSync(output, { force: true });
    const result = spawnSync(process.execPath, ['tools/test/check-comment-fixture-governance.mjs'], {
        cwd: COMMENT_FIXTURE_REPOSITORY_ROOT,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical-runtime-evidence/u);
    assert.equal(existsSync(output), false);
});
