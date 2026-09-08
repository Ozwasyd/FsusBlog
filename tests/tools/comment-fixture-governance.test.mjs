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
import { createCommentFixtureBackendError } from '../../tools/test-fixtures/producers/comment-moderation-producer.mjs';

test('comment producer preserves only exact-plan structured recovery payloads', () =>
{
    const digest = (value) => `sha256:${value.repeat(64)}`;
    const plan = {
        schema: 'fsusblog.comment-fixture-plan.v1',
        runId: 'run-1',
        namespace: 'comment-test',
        testSession: 'fx-0123456789abcdef01234567',
        profileId: 'comments-moderation',
        capabilities: ['comment.threaded'],
        articleReference: {
            articleId: 42,
            publicContentProducerResultDigest: digest('a'),
            articleProjectionDigest: digest('b')
        },
        identityReferences: {
            authProducerResultDigest: digest('c'),
            authPrepareReferenceDigests: [digest('d'), digest('e'), digest('f')]
        },
        inventoryDigest: digest('1'),
        capabilityCatalogDigest: digest('2'),
        variantCatalogDigest: digest('3'),
        temporalContextDigest: digest('4'),
        producerPlanDigest: digest('5'),
        planDigest: digest('6')
    };
    const binding = {
        runId: plan.runId,
        namespace: plan.namespace,
        testSession: plan.testSession,
        owner: `comment-fixture:${plan.namespace}:${plan.runId}`,
        profileId: plan.profileId,
        capabilities: plan.capabilities,
        articleId: plan.articleReference.articleId,
        authProducerResultDigest: plan.identityReferences.authProducerResultDigest,
        authPrepareReferenceDigests: plan.identityReferences.authPrepareReferenceDigests,
        publicContentProducerResultDigest: plan.articleReference.publicContentProducerResultDigest,
        articleProjectionDigest: plan.articleReference.articleProjectionDigest,
        inventoryDigest: plan.inventoryDigest,
        capabilityCatalogDigest: plan.capabilityCatalogDigest,
        variantCatalogDigest: plan.variantCatalogDigest,
        temporalContextDigest: plan.temporalContextDigest,
        producerPlanDigest: plan.producerPlanDigest,
        planDigest: plan.planDigest
    };
    const payload = {
        schema: 'fsusblog.comment-fixture-prepare-failure.v1',
        status: 'failed',
        message: 'fixture preparation failed',
        originalError: { type: 'InvalidOperationException', message: 'original' },
        cleanupError: { type: 'InvalidOperationException', message: 'cleanup' },
        recoveryReceipt: { schema: 'fsusblog.comment-thread-fixture-cleanup.v1', binding, ownedComments: {} },
        cleanupResult: null
    };

    const exact = createCommentFixtureBackendError(500, payload, '', plan);
    assert.equal(exact.name, 'CommentFixtureBackendError');
    assert.equal(exact.httpStatus, 500);
    assert.equal(exact.cause, exact.recovery);
    assert.equal(exact.recovery.originalError.message, 'original');
    assert.equal(exact.recovery.cleanupError.message, 'cleanup');
    assert.equal(exact.recoveryReceipt, payload.recoveryReceipt);

    const crossPlan = structuredClone(payload);
    crossPlan.recoveryReceipt.binding.planDigest = digest('9');
    const rejected = createCommentFixtureBackendError(500, crossPlan, '', plan);
    assert.equal(rejected.recovery, undefined);
    assert.equal(rejected.recoveryReceipt, undefined);
    assert.equal(rejected.cause, undefined);
});

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
