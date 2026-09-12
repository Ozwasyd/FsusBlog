import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    buildCommentFixtureAcceptanceReceipt,
    buildCanonicalCommentFixtureRuntimeEvidence,
    buildCommentFixtureCleanupReceipt,
    COMMENT_FIXTURE_REPOSITORY_ROOT,
    verifyCommentFixtureAcceptanceReceipt
} from '../../tools/test/comment-fixture-governance.mjs';
import { digestCommentFixtureValue } from '../../tools/test/comment-fixture-contract.mjs';
import { collectSimulatedCommentFixtureRuntimeEvidence } from '../../tools/test/run-comment-fixture-simulated-runtime.mjs';
import { normalizeCleanupContract as normalizeCommentCleanupContract } from '../../tools/test-fixtures/receipt/comment-cleanup-contract.mjs';
import {
    buildProducerReceipt,
    digestCanonical,
    validateProducerReceipt
} from '../../tools/test-fixtures/receipt/index.mjs';
import {
    buildFixtureVariantPlan,
    buildProducerFixtureVariantPlan,
    fixtureCatalogDigest,
    readFixtureCatalogs
} from '../../tools/testing/fixture-catalog.mjs';
import { createCommentFixtureBackendError } from '../../tools/test-fixtures/producers/comment-moderation-producer.mjs';

const cliEvidenceRoot = path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, '.tmp/test-evidence');
const cliRuntimeEvidence = path.join(cliEvidenceRoot, 'comment-fixture-runtime.json');
const cliCleanupReceipt = path.join(cliEvidenceRoot, 'comment-fixture-cleanup.json');
const cliAcceptanceReceipt = path.join(cliEvidenceRoot, 'comment-fixture-acceptance.json');

function clearCommentFixtureCliEvidence()
{
    for (const target of [cliRuntimeEvidence, cliCleanupReceipt, cliAcceptanceReceipt])
        rmSync(target, { force: true });
}

function runCommentFixtureCli()
{
    return spawnSync(process.execPath, ['tools/test/check-comment-fixture-governance.mjs'], {
        cwd: COMMENT_FIXTURE_REPOSITORY_ROOT,
        encoding: 'utf8'
    });
}

test('comment correctness entrypoints require verified FixtureReceipt authority', () =>
{
    const browser = readFileSync(
        path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, 'tests/browser-contract/default-fixture-provider.mjs'),
        'utf8');
    const pendingStart = browser.indexOf('async function pendingComment');
    const pending = browser.slice(
        pendingStart,
        browser.indexOf('\nexport async function', pendingStart + 1));
    assert.match(pending, /readFixtureReceipt[\s\S]*requireVerified:\s*true/u);
    assert.match(pending, /producerReceipts/u);
    assert.doesNotMatch(pending, /prepare-state\.json|producerOutputs/u);

    for (const relativePath of [
        'tools/bootstrap-acceptance-env.sh',
        'tools/dev/start.sh',
        'tools/test/lanes/_suite-support.sh'
    ])
    {
        const source = readFileSync(path.join(COMMENT_FIXTURE_REPOSITORY_ROOT, relativePath), 'utf8');
        assert.match(source, /comments-moderation|comment-moderation/u);
        assert.match(source, /fixture-receipt|FIXTURE_RECEIPT/u);
    }
});

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

test('synthetic canonical runtime fixture cannot become terminal CLI evidence', () =>
{
    const cleanup = buildCommentFixtureCleanupReceipt();
    const runtimeEvidence = buildCanonicalCommentFixtureRuntimeEvidence();
    const acceptance = buildCommentFixtureAcceptanceReceipt(cleanup, runtimeEvidence);

    assert.equal(acceptance.status, 'rejected');
    assert.ok(acceptance.violations.some((item) => item.id === 'runtime.provenance'));
    assert.throws(
        () => verifyCommentFixtureAcceptanceReceipt(acceptance, cleanup, runtimeEvidence),
        /not terminal accepted/u
    );
});

test('two parallel local-simulated producer invocations produce terminal acceptance and exact sentinels', async () =>
{
    const cleanup = buildCommentFixtureCleanupReceipt();
    const runtimeEvidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    const cleanupContract = normalizeCommentCleanupContract({
        kind: 'comment-exact-receipt',
        receipt: runtimeEvidence.runs[0].cleanupReceipt
    });
    assert.deepEqual(cleanupContract.receipt, runtimeEvidence.runs[0].cleanupReceipt);
    const catalogs = readFixtureCatalogs();
    const run = runtimeEvidence.runs[0];
    const variantByCapability = new Map(
        catalogs.variant.variants
            .filter((item) => item.ownerProducerId === 'comment-moderation'
                && item.validityClass === 'canonical-positive')
            .map((item) => [item.capabilityId, item.id]));
    const capabilityForRole = (role) => role.startsWith('region-')
        ? 'moderation.policy-matrix'
        : ['approved-root', 'pending', 'rejected', 'spam'].includes(role)
            ? 'comment.moderation-matrix'
            : 'comment.threaded';
    const databaseObservation = structuredClone(run.observations.database);
    for (const entity of databaseObservation.entities)
        entity.variantId = variantByCapability.get(capabilityForRole(entity.fields.semanticRole));
    const fixtureVariantIds = [...variantByCapability.values()].sort();
    const variantPlan = buildFixtureVariantPlan(fixtureVariantIds, catalogs);
    const producerVariantPlan = buildProducerFixtureVariantPlan({
        producerId: 'comment-moderation',
        variantIds: fixtureVariantIds,
        fixtureVariantIds,
        fixtureVariantPlanDigest: variantPlan.variantPlanDigest,
        catalogs
    });
    const catalogProducer = catalogs.producer.producers.find((item) => item.id === 'comment-moderation');
    const producerReceipt = buildProducerReceipt({
        producerId: 'comment-moderation',
        strategy: 'transaction-fixture',
        runId: run.cleanupReceipt.binding.runId,
        namespace: run.cleanupReceipt.binding.namespace,
        source: runtimeEvidence.source,
        fixtureCatalogDigest: fixtureCatalogDigest(catalogs),
        profileId: 'comments-moderation',
        expandedCapabilityDigest: digestCanonical(run.capabilities),
        fixtureVariantIds,
        variantPlanDigest: variantPlan.variantPlanDigest,
        producerVariantPlanDigest: producerVariantPlan.producerVariantPlanDigest,
        producedVariantIds: fixtureVariantIds,
        serviceGeneration: 'simulated-generation',
        providedCapabilities: run.capabilities,
        ownedStateDomains: catalogProducer.stateDomains,
        entityIdentities: databaseObservation.entities.map((item) => ({
            kind: item.kind,
            id: item.id,
            variantId: item.variantId
        })),
        postconditionObservations: [],
        cleanupContract: {
            kind: 'comment-exact-receipt',
            receipt: run.cleanupReceipt
        },
        databaseObservation,
        redisObservation: run.observations.redis,
        cacheObservation: run.observations.cache,
        catalogs
    });
    assert.deepEqual(producerReceipt.cleanupContract.receipt, run.cleanupReceipt);
    assert.deepEqual(validateProducerReceipt(producerReceipt, { catalogs }), producerReceipt);
    const acceptance = buildCommentFixtureAcceptanceReceipt(cleanup, runtimeEvidence);
    assert.equal(acceptance.status, 'accepted');
    assert.deepEqual(acceptance.violations, []);
    assert.equal(acceptance.ports.length, 2);
    assert.equal(acceptance.runtimeInvocations.authorityClass, 'local-simulated-producer-invocation');
    assert.equal(acceptance.cacheQueueReadModel.status, 'accepted');
    assert.deepEqual(
        verifyCommentFixtureAcceptanceReceipt(acceptance, cleanup, runtimeEvidence),
        acceptance);

    const crossDomainCleanup = structuredClone(runtimeEvidence);
    crossDomainCleanup.cleanups[0].crossDomainAfter.securityDigest = `sha256:${'0'.repeat(64)}`;
    crossDomainCleanup.runs[0].producerInvocation.cleanupResultDigest =
        digestCommentFixtureValue(crossDomainCleanup.cleanups[0]);
    crossDomainCleanup.invocationSetDigest = digestCommentFixtureValue(
        crossDomainCleanup.runs.map((run) => run.producerInvocation));
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

test('comment governance CLI fails closed when canonical no-arg evidence is missing', () =>
{
    clearCommentFixtureCliEvidence();
    const result = runCommentFixtureCli();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /comment-fixture-runtime\.json/u);
    assert.equal(existsSync(cliCleanupReceipt), false);
    assert.equal(existsSync(cliAcceptanceReceipt), false);
});

test('comment governance CLI fails closed when canonical no-arg evidence is invalid', () =>
{
    clearCommentFixtureCliEvidence();
    mkdirSync(cliEvidenceRoot, { recursive: true, mode: 0o700 });
    writeFileSync(cliRuntimeEvidence, '{}\n', { mode: 0o600 });
    const result = runCommentFixtureCli();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not terminal accepted/u);
    assert.equal(existsSync(cliCleanupReceipt), false);
    assert.equal(existsSync(cliAcceptanceReceipt), false);
    clearCommentFixtureCliEvidence();
});

test('comment governance CLI consumes canonical no-arg current-run evidence', async () =>
{
    clearCommentFixtureCliEvidence();
    mkdirSync(cliEvidenceRoot, { recursive: true, mode: 0o700 });
    const runtimeEvidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    writeFileSync(cliRuntimeEvidence, `${JSON.stringify(runtimeEvidence, null, 4)}\n`, { mode: 0o600 });
    const result = runCommentFixtureCli();
    assert.equal(result.status, 0, result.stderr);
    const acceptance = JSON.parse(readFileSync(cliAcceptanceReceipt, 'utf8'));
    assert.equal(acceptance.status, 'accepted');
    assert.deepEqual(acceptance.warnings, []);
    assert.deepEqual(acceptance.violations, []);
    clearCommentFixtureCliEvidence();
});
