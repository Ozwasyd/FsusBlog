import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {buildCommentFixtureAcceptanceReceipt, buildCanonicalCommentFixtureRuntimeEvidence, buildCommentFixtureCleanupReceipt, buildCommentFixtureModelReport, COMMENT_FIXTURE_REPOSITORY_ROOT, verifyCommentFixtureAcceptanceReceipt} = await import(new URL('../../tools/test/comment-fixture-governance.mjs', import.meta.url));
const {digestCommentFixtureValue, readCommentFixtureContract} = await import(new URL('../../tools/test/comment-fixture-contract.mjs', import.meta.url));
const {collectSimulatedCommentFixtureRuntimeEvidence} = await import(new URL('../../tools/test/run-comment-fixture-simulated-runtime.mjs', import.meta.url));
const {normalizeCleanupContract: normalizeCommentCleanupContract} = await import(new URL('../../tools/test-fixtures/receipt/comment-cleanup-contract.mjs', import.meta.url));
const {buildProducerReceipt, digestCanonical, validateProducerReceipt} = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const {buildFixtureVariantPlan, buildProducerFixtureVariantPlan, fixtureCatalogDigest, readFixtureCatalogs} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const {createCommentFixtureBackendError} = await import(new URL('../../tools/test-fixtures/producers/comment-moderation-producer.mjs', import.meta.url));
const cliEvidenceRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-comment-model-contract-'));
const cliRuntimeEvidence = path.join(cliEvidenceRoot, 'comment-fixture-runtime.json');
const cliCleanupReceipt = path.join(cliEvidenceRoot, 'comment-fixture-cleanup.json');
const cliAcceptanceReceipt = path.join(cliEvidenceRoot, 'comment-fixture-acceptance.json');

function clearCommentFixtureCliEvidence()
{
    for (const target of [cliRuntimeEvidence, cliCleanupReceipt, cliAcceptanceReceipt])
    {
        rmSync(target, { force: true });
    }
}

function runCommentFixtureCli(args = [])
{
    return spawnSync(process.execPath, ['tools/test/check-comment-fixture-governance.mjs', ...args], {
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

// Original terminal-model-positive intent is retained as explicit model parity plus runtime rejection.
// The old assertion/failure is preserved in c1-model-collector-first.log, not promoted to runtime proof.
test('two parallel local-simulated producer invocations preserve exact model contracts but cannot qualify runtime', async () =>
{
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
    {
        entity.variantId = variantByCapability.get(capabilityForRole(entity.fields.semanticRole));
    }
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
    const acceptance = buildCommentFixtureModelReport(runtimeEvidence);
    assert.equal(acceptance.status, 'accepted');
    assert.deepEqual(acceptance.violations, []);
    assert.equal(acceptance.scope, 'model-contract-only');
    assert.equal(acceptance.runtimeQualified, false);
    assert.equal(acceptance.sourceOwnershipQualified, false);
    assert.equal(acceptance.authority, 'local-simulated-comment-fixture-model');
    assert.throws(() => verifyCommentFixtureAcceptanceReceipt(acceptance, null, runtimeEvidence), /model-only/u);

    const crossDomainCleanup = structuredClone(runtimeEvidence);
    crossDomainCleanup.cleanups[0].crossDomainAfter.securityDigest = `sha256:${'0'.repeat(64)}`;
    crossDomainCleanup.runs[0].producerInvocation.cleanupResultDigest =
        digestCommentFixtureValue(crossDomainCleanup.cleanups[0]);
    crossDomainCleanup.invocationSetDigest = digestCommentFixtureValue(
        crossDomainCleanup.runs.map((run) => run.producerInvocation));
    const rejected = buildCommentFixtureModelReport(crossDomainCleanup);
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.violations.some((item) => item.includes('model cleanup 1')));
});

test('independent moderation verifier rejects semantic evidence tamper', async () =>
{
    for (const mutate of [
        (result) => result.moderation.entities.find((item) => item.semanticRole === 'spam').queueGroup = 'pending',
        (result) => result.moderation.entities.find((item) => item.semanticRole === 'spam').signalEvidence[0].source = '',
        (result) => result.moderation.entities.find((item) => item.semanticRole === 'region-global').regionEvidence[0].decisionReason = '',
        (result) => result.moderation.entities.find((item) => item.semanticRole === 'rejected').commentReferenceDigest = 'tampered'
    ])
    {
        let reads = 0;
        await assert.rejects(collectSimulatedCommentFixtureRuntimeEvidence({ mutateRead(read)
        {
            reads++;
            mutate(read);
        } }), /simulated comment producer verification failed/u);
        assert.ok(reads > 0, 'semantic rejection must follow an actual model verify HTTP read');
    }
});

test('model temporal transport preserves actual field refusals and never qualifies runtime', async () =>
{
    for (const mutate of [
        (observation) => delete observation.businessEpochUtc,
        (observation) => delete observation.backendCulture,
        (observation) => delete observation.postgresTimezone,
        (observation) => observation.businessEpochUtc = '2042-05-18T09:30:00.000Z',
        (observation) => observation.backendCulture = 'zh-CN',
        (observation) => observation.postgresTimezone = 'Asia/Shanghai'
    ])
    {
        let reads = 0;
        await assert.rejects(collectSimulatedCommentFixtureRuntimeEvidence({
            mutateTemporalObservation(observation)
            {
                reads++;
                mutate(observation);
            }
        }), (error) => error.message.startsWith('backend temporal observation requires actual ')
            || error.reasonCode?.startsWith('temporal.') === true);
        assert.ok(reads > 0, 'temporal rejection must follow the model HTTP observation');
    }
    const evidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    for (const run of evidence.runs)
    {
        assert.equal(run.preparedResult.temporalObservation.businessEpochUtc, '2042-05-17T09:30:00.000Z');
        assert.equal(run.preparedResult.temporalObservation.backendCulture, 'Invariant');
        assert.equal(run.preparedResult.temporalObservation.postgresTimezone, 'UTC');
        assert.equal(run.preparedResult.temporalObservation.authorityClass, 'local-simulated');
    }
    assert.equal(evidence.runtimeQualified, false);
    assert.equal(buildCommentFixtureModelReport(evidence).runtimeQualified, false);
    assert.equal(buildCommentFixtureAcceptanceReceipt(buildCommentFixtureCleanupReceipt(), evidence).status, 'rejected');
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

test('comment governance CLI fails closed when explicitly supplied evidence is invalid', () =>
{
    clearCommentFixtureCliEvidence();
    mkdirSync(cliEvidenceRoot, { recursive: true, mode: 0o700 });
    writeFileSync(cliRuntimeEvidence, '{}\n', { mode: 0o600 });
    const result = runCommentFixtureCli([cliRuntimeEvidence]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not terminal accepted/u);
    assert.equal(existsSync(cliCleanupReceipt), false);
    assert.equal(existsSync(cliAcceptanceReceipt), false);
    clearCommentFixtureCliEvidence();
});

test('comment governance CLI only accepts model evidence with an explicit model-contract scope', async () =>
{
    clearCommentFixtureCliEvidence();
    mkdirSync(cliEvidenceRoot, { recursive: true, mode: 0o700 });
    const runtimeEvidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    writeFileSync(cliRuntimeEvidence, `${JSON.stringify(runtimeEvidence, null, 4)}\n`, { mode: 0o600 });
    const rejected = runCommentFixtureCli([cliRuntimeEvidence]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /model-only/u);
    assert.equal(existsSync(cliAcceptanceReceipt), false);
    const result = runCommentFixtureCli(['--model-contract', cliRuntimeEvidence]);
    assert.equal(result.status, 0, result.stderr);
    const acceptance = JSON.parse(result.stdout);
    assert.equal(acceptance.status, 'accepted');
    assert.equal(acceptance.scope, 'model-contract-only');
    assert.equal(acceptance.runtimeQualified, false);
    assert.equal(existsSync(cliCleanupReceipt), false);
    assert.equal(existsSync(cliAcceptanceReceipt), false);
    assert.deepEqual(acceptance.violations, []);
    clearCommentFixtureCliEvidence();
});

test('model collector consumes fresh verify RPC bytes/digests instead of prepared observations', async () =>
{
    const evidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    for (const run of evidence.runs)
    {
        const { verification, preparedResult, producerInvocation } = run;
        assert.deepEqual(producerInvocation.requests.map((item) => item.path), [
            '/api/local/comment-fixture/prepare', '/__local/temporal-observation',
            '/api/local/comment-fixture/verify', '/api/local/comment-fixture/cleanup'
        ]);
        assert.notEqual(run.cacheGenerationAfter, preparedResult.cacheGenerationAfter);
        assert.notDeepEqual(run.observations, preparedResult.observations);
        assert.deepEqual(run.observations, verification.observations);
        assert.equal(verification.readObservationDigest, digestCanonical(verification.response));
        assert.equal(producerInvocation.readObservationDigest, verification.readObservationDigest);
        for (const [key, field] of [['authReference', 'authSourceReceiptDigest'], ['publicReference', 'publicSourceReceiptDigest']])
        {
            const sealed = verification.request[key].receipt;
            assert.equal(validateProducerReceipt(sealed).producerReceiptDigest, sealed.producerReceiptDigest);
            assert.equal(sealed.observations.database.schemaIdentity, 'model-only');
            assert.equal(verification[field], sealed.producerReceiptDigest);
            assert.equal(producerInvocation[field], sealed.producerReceiptDigest);
        }
        assert.deepEqual(run.negativeResults, preparedResult.negativeResults);
        assert.deepEqual(run.runtimeRestore, preparedResult.runtimeRestore);
    }
});

function resealModelInvocationSet(evidence)
{
    for (const [index, run] of evidence.runs.entries())
    {
        const unsigned = Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'producerInvocation'));
        run.producerInvocation.producerResultDigest = digestCommentFixtureValue(unsigned);
        if (evidence.cleanups[index])
        {
            run.producerInvocation.cleanupResultDigest = digestCommentFixtureValue(evidence.cleanups[index]);
        }
        else
        {
            delete run.producerInvocation.cleanupResultDigest;
        }
    }
    evidence.invocationSetDigest = digestCommentFixtureValue(evidence.runs.map((item) => item.producerInvocation));
}

const modelMutations = [
    ['missing verify transport', (e) => e.runs[0].producerInvocation.requests.splice(2, 1)],
    ['missing independent read', (e) => delete e.runs[0].verification.response],
    ['read digest drift', (e) => e.runs[0].verification.readObservationDigest = `sha256:${'0'.repeat(64)}`],
    ['response bytes drift', (e) => e.runs[0].verification.response.moderation.contentDigest = `sha256:${'0'.repeat(64)}`],
    ['prepare observation fallback', (e) => e.runs[0].observations = e.runs[0].preparedResult.observations],
    ['prepare fallback in both observation copies', (e) =>
    {
        e.runs[0].observations = e.runs[0].preparedResult.observations;
        e.runs[0].verification.observations = e.runs[0].preparedResult.observations;
    }],
    ['foreign requested role identity', (e) => e.runs[0].verification.request.roles['approved-root'].commentId = '999999'],
    ['auth read digest drift', (e) => e.runs[0].verification.authSourceReceiptDigest = `sha256:${'0'.repeat(64)}`],
    ['public read digest drift', (e) => e.runs[0].verification.publicSourceReceiptDigest = `sha256:${'0'.repeat(64)}`],
    ['sealed canonical bytes drift', (e) => e.runs[0].verification.request.authReference.canonicalBody = '{}'],
    ['cross-run public receipt', (e) => e.runs[0].verification.request.publicReference = e.runs[1].verification.request.publicReference],
    ['cleanup omitted', (e) => e.cleanups.pop()],
    ['cleanup queue evidence missing', (e) => e.cleanups[0].moderationObservation.queueAbsentCommentIds = []],
    ['cleanup sentinel drift', (e) => e.cleanups[0].crossDomainAfter.securityDigest = `sha256:${'0'.repeat(64)}`],
    ['reused parallel identities', (e) =>
    {
        e.runs[1] = structuredClone(e.runs[0]);
        e.cleanups[1] = structuredClone(e.cleanups[0]);
    }],
    ['missing explicit model scope', (e) => delete e.scope],
    ['forged runtime qualification', (e) => e.runtimeQualified = true]
];

for (const [name, mutate] of modelMutations)
{
    test(`model contract rejects ${name} even after outer invocation digests are resealed`, async () =>
    {
        const evidence = await collectSimulatedCommentFixtureRuntimeEvidence();
        mutate(evidence);
        resealModelInvocationSet(evidence);
        const report = buildCommentFixtureModelReport(evidence);
        assert.equal(report.status, 'rejected');
        assert.equal(report.runtimeQualified, false);
        assert.ok(report.violations.length > 0);
    });
}

test('model source cannot qualify runtime by changing only outer authority/scope labels', async () =>
{
    const evidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    evidence.authorityClass = 'local-runtime-producer-invocation';
    delete evidence.scope;
    delete evidence.runtimeQualified;
    assert.throws(() => verifyCommentFixtureAcceptanceReceipt(null, null, evidence), /model-only/u);
    writeFileSync(cliRuntimeEvidence, JSON.stringify(evidence), { mode: 0o600 });
    const result = runCommentFixtureCli([cliRuntimeEvidence]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /model-only/u);
    clearCommentFixtureCliEvidence();
});

test('existing collector entrypoint writes an explicit model-only artifact and default checker rejects it', () =>
{
    const file = path.join(cliEvidenceRoot, 'collector-model.json');
    const result = spawnSync(process.execPath, ['tools/test/run-comment-fixture-simulated-runtime.mjs', file], {
        cwd: COMMENT_FIXTURE_REPOSITORY_ROOT, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).scope, 'model-contract-only');
    assert.equal(JSON.parse(result.stdout).runtimeQualified, false);
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(evidence.modelContract.schema, 'fsusblog.comment-fixture-model-contract.v1');
    assert.equal(evidence.modelContract.sourceOwnershipQualified, false);
    const rejected = runCommentFixtureCli([file]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /model-only/u);
    const modelOnly = runCommentFixtureCli(['--model-contract', file]);
    assert.equal(modelOnly.status, 0, modelOnly.stderr);
    assert.equal(JSON.parse(modelOnly.stdout).runtimeQualified, false);
    // Mutating an embedded report is not an authority or digest override.
    evidence.modelContract.runtimeQualified = true;
    writeFileSync(file, JSON.stringify(evidence));
    assert.notEqual(runCommentFixtureCli(['--model-contract', file]).status, 0);
});

function temporaryScannerGit(t)
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-comment-scanner-git-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { ownership } = readCommentFixtureContract();
    const support = (ownership.supportImplementations ?? []).map((item) => item.implementation);
    const expected = [ownership.producer.implementation, ownership.composition.implementation,
        ...ownership.ports.map((item) => item.implementation), ...support,
        ...ownership.gateways.map((item) => item.implementation)];
    const consumers = ownership.consumers.map((item) => item.implementation);
    const retired = 'tools/test/lanes/backend-qps.sh';
    const runtime = 'tools/test/lanes/runtime-cache-evidence.sh';
    for (const relative of [...expected, ...consumers, retired, runtime])
    {
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, expected.includes(relative) && !support.includes(relative)
            ? `// fixture-${'catalog: producer comment-moderation'}\n`
            : '// Temporary Git scanner fixture, not runtime evidence.\n');
    }
    const git = (...args) =>
    {
        // Index/commit operations occur ONLY in this test-owned temporary repository.
        const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
            '-c', 'user.name=Comment scanner test', '-c', 'user.email=comment-scanner@example.invalid', ...args],
        { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    git('init', '--quiet');
    git('add', '--', ...expected, ...consumers, retired, runtime);
    git('commit', '--quiet', '-m', 'temporary comment scanner fixture');
    return { root, ownership, expected, consumers, retired, runtime, git };
}

test('real temporary Git dirty-deleted nonowned source is excluded without restoring retired QPS', (t) =>
{
    const fixture = temporaryScannerGit(t);
    rmSync(path.join(fixture.root, fixture.retired));
    assert.ok(fixture.git('ls-files', '--cached').split('\n').includes(fixture.retired));
    assert.deepEqual(fixture.git('ls-files', '--deleted', '-z').split('\0').filter(Boolean), [fixture.retired]);
    const receipt = buildCommentFixtureCleanupReceipt({ root: fixture.root });
    assert.equal(receipt.scanner.status, 'accepted');
    assert.deepEqual(receipt.scanner.violations, []);
    assert.equal(existsSync(path.join(fixture.root, fixture.retired)), false);
    // Current runtime lane is still enumerated; no retired-name/global lane exclusion.
    writeFileSync(path.join(fixture.root, fixture.runtime), `// fixture-${'catalog: producer comment-moderation'}\n`);
    const changed = buildCommentFixtureCleanupReceipt({ root: fixture.root });
    assert.equal(changed.scanner.status, 'rejected');
    assert.ok(changed.scanner.violations.some((item) => item.path === fixture.runtime && item.id === 'second-producer'));
});

for (const kind of ['producer', 'support', 'consumer'])
{
    test(`real temporary Git dirty-deleted declared ${kind} remains missing and rejected`, (t) =>
    {
        const fixture = temporaryScannerGit(t);
        const relative = kind === 'producer' ? fixture.ownership.producer.implementation
            : kind === 'support' ? fixture.ownership.supportImplementations[0].implementation : fixture.consumers[0];
        rmSync(path.join(fixture.root, relative));
        assert.ok(fixture.git('ls-files', '--deleted', '-z').split('\0').includes(relative));
        const receipt = buildCommentFixtureCleanupReceipt({ root: fixture.root });
        assert.equal(receipt.scanner.status, 'rejected');
        assert.ok(receipt.scanner.violations.some((item) => item.path === relative
            && item.id === (kind === 'consumer' ? 'consumer-implementation-missing' : 'owned-implementation-missing')));
    });
}

for (const [kind, dangling] of [['producer', false], ['producer', true], ['consumer', true], ['nonowned', true]])
{
    test(`real temporary Git ${kind} ${dangling ? 'dangling' : 'regular-target'} symlink is rejected`, (t) =>
    {
        const fixture = temporaryScannerGit(t);
        const relative = kind === 'producer' ? fixture.ownership.producer.implementation
            : kind === 'consumer' ? fixture.consumers[0] : fixture.retired;
        const file = path.join(fixture.root, relative);
        rmSync(file);
        symlinkSync(path.join(fixture.root, dangling ? 'absent-target' : fixture.ownership.composition.implementation), file);
        const receipt = buildCommentFixtureCleanupReceipt({ root: fixture.root });
        assert.equal(receipt.scanner.status, 'rejected');
        assert.ok(receipt.scanner.violations.some((item) => item.path === relative && item.id === 'source-file-identity'));
    });
}

test('real temporary Git source read error is propagated, never skipped', (t) =>
{
    const fixture = temporaryScannerGit(t);
    const file = path.join(fixture.root, fixture.ownership.producer.implementation);
    const original = fs.readFileSync;
    let faults = 0;
    const hook = t.mock.method(fs, 'readFileSync', (target, ...args) =>
    {
        if (target === file)
        {
            faults++;
            throw Object.assign(new Error('injected scanner filesystem read error'), { code: 'EIO' });
        }
        return original(target, ...args);
    });
    try
    {
        assert.throws(() => buildCommentFixtureCleanupReceipt({ root: fixture.root }), { code: 'EIO' });
        assert.equal(faults, 1);
    }
    finally
    {
        hook.mock.restore();
    }
});

test('real temporary Git present source disappearing after enumeration remains rejected', (t) =>
{
    const fixture = temporaryScannerGit(t);
    const file = path.join(fixture.root, fixture.ownership.producer.implementation);
    const original = fs.lstatSync;
    let raced = false;
    const hook = t.mock.method(fs, 'lstatSync', (target, options) =>
    {
        if (target === file && options === undefined && !raced)
        {
            raced = true;
            rmSync(file);
        }
        return original(target, options);
    });
    try
    {
        assert.throws(() => buildCommentFixtureCleanupReceipt({ root: fixture.root }), { code: 'ENOENT' });
        assert.equal(raced, true);
    }
    finally
    {
        hook.mock.restore();
    }
});

for (const late of [false, true])
{
    test(`real temporary Git deleted source recreated ${late ? 'during scan' : 'after Git enumeration'} is rejected`, (t) =>
    {
        const fixture = temporaryScannerGit(t);
        const file = path.join(fixture.root, fixture.retired);
        rmSync(file);
        const original = fs.lstatSync;
        let calls = 0;
        const hook = t.mock.method(fs, 'lstatSync', (target, options) =>
        {
            if (target === file && options?.throwIfNoEntry === false)
            {
                calls++;
                if (calls === (late ? 2 : 1))
                {
                    writeFileSync(file, '// Recreated real temporary Git source.\n');
                }
            }
            return original(target, options);
        });
        try
        {
            assert.throws(() => buildCommentFixtureCleanupReceipt({ root: fixture.root }), /source.*(?:changed|reappeared)/u);
            assert.equal(calls, late ? 2 : 1);
        }
        finally
        {
            hook.mock.restore();
        }
    });
}
