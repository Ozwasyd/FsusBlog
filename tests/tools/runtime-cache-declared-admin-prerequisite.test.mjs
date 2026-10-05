import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const { matrixFixturePrerequisites } = await import(new URL('../../tools/test-matrix/fixture-profile-contract.mjs', import.meta.url));
const { qualificationTemporalContext, defaultTimeoutPolicyDigest } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url));
const { readFixtureCatalogs, sealMatrixFixtureProfile, applySealedFixtureProfileEnvironment,
    resolveMatrixFixturePrerequisiteEnvironment, buildProducerFixtureVariantPlan } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const { plan } = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const { buildProducerReceipt, verifyCapabilityPostconditions, aggregateVerifiedFixtureReceipt,
    writePrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const { persistAuthPrivateCarrier } = await import(new URL('../../tools/test-fixtures/producers/auth-session-producer.mjs', import.meta.url));
const { createFixtureArtifactOutlet } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
const { resolveRuntimeCacheConsumer, writeRuntimeCacheFixtureInput, readRuntimeCacheFixtureInput,
    writeVerifiedAdminPrerequisiteProjection, prepareRuntimeCacheDeclaredPrerequisites,
    readVerifiedAdminRuntimeProjection } = await import(new URL('../../tools/test-fixtures/receipt/projection.mjs', import.meta.url));

const root = path.resolve(import.meta.dirname, '../..');
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const tier = matrix.tiers.find((item) => item.id === 'runtime-cache-hot-featured-frame');
const catalogs = readFixtureCatalogs();
const schema = JSON.parse(fs.readFileSync(path.join(root, 'tests/matrix.schema.json'), 'utf8'));
const sealed = sealMatrixFixtureProfile(tier);
const execution = { runId: 'declared-admin-unit', namespace: 'ns',
    sourceIdentity: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
    handles: { serviceGeneration: `sha256:${'c'.repeat(64)}`, pgContainer: 'owned-pg', redisContainer: 'owned-redis' } };

test('only hot-featured declares the exact six-field independent prerequisite; runtime is not inferred load', () =>
{
    assert.equal(matrix.tiers.filter((item) => item.fixturePrerequisites).length, 1);
    assert.deepEqual(matrixFixturePrerequisites(tier), tier.fixturePrerequisites);
    assert.equal(sealed.profileId, 'public-content-lifecycle');
    assert.equal(sealed.executionClass, 'runtime');
    assert.deepEqual(sealed.producers, ['public-content']);
    assert.ok(!sealed.capabilities.includes('auth.admin.full-permission'));
    assert.equal(sealed.prerequisites[0].profileId, 'auth-basic');
    assert.equal(sealed.prerequisites[0].executionClass, 'runtime');
    assert.equal(sealed.prerequisites[0].capabilityIds.length, 3);
    assert.equal(validateJsonSchema(matrix, schema).length, 0);
});

for (const field of ['id', 'profileId', 'producerId', 'capabilityId', 'semanticRole', 'consumerId'])
{
    test(`missing or wrong ${field} fails both closed matrix schema and actual seal`, () =>
    {
        for (const missing of [false, true])
        {
            const value = structuredClone(tier);
            if (missing)
            {
                delete value.fixturePrerequisites[0][field];
            }
            else
            {
                value.fixturePrerequisites[0][field] = 'foreign';
            }
            assert.ok(validateJsonSchema({ ...matrix, tiers: [value] }, schema).length > 0);
            assert.throws(() => sealMatrixFixtureProfile(value), /exact typed-admin-session/u);
        }
    });
}

test('missing/duplicate/extra prerequisite and another consumer fail actual matrix sealing', () =>
{
    const missing = structuredClone(tier);
    delete missing.fixturePrerequisites;
    const duplicate = structuredClone(tier);
    duplicate.fixturePrerequisites.push(duplicate.fixturePrerequisites[0]);
    const extra = structuredClone(tier);
    extra.fixturePrerequisites[0].waiver = true;
    const other = { ...tier, id: 'runtime-cache-related-reading' };
    for (const value of [missing, duplicate, extra, other])
    {
        assert.ok(validateJsonSchema({ ...matrix, tiers: [value] }, schema).length > 0);
        assert.throws(() => sealMatrixFixtureProfile(value), /prerequisite/u);
    }
    const wrongOwner = structuredClone(catalogs);
    wrongOwner.capability.capabilities.find((item) => item.id === 'auth.admin.full-permission').ownerProducerId = 'public-content';
    assert.throws(() => sealMatrixFixtureProfile(tier, wrongOwner), /owner|producer/u);
});

test('child environment binds exact separate seals and overwrites ambient consumer/prerequisite state', () =>
{
    const env = applySealedFixtureProfileEnvironment({ FSUSBLOG_SEALED_FIXTURE_PREREQUISITES: 'foreign' }, sealed);
    assert.deepEqual(resolveMatrixFixturePrerequisiteEnvironment(env, sealed), sealed.prerequisites);
    for (const field of ['id', 'profileId', 'producerId', 'capabilityId', 'semanticRole', 'consumerId',
        'catalogDigest', 'expandedCapabilityDigest', 'variantPlanDigest', 'executionClass', 'variantIds'])
    {
        const changed = structuredClone(sealed.prerequisites);
        changed[0][field] = 'foreign';
        assert.throws(() => resolveMatrixFixturePrerequisiteEnvironment({ ...env,
            FSUSBLOG_SEALED_FIXTURE_PREREQUISITES: JSON.stringify(changed) }, sealed), /binding/u);
    }
    const clean = applySealedFixtureProfileEnvironment(env, sealMatrixFixtureProfile({ fixtureProfile: tier.fixtureProfile, executionClass: 'runtime' }));
    assert.equal(clean.FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID, '');
    assert.equal(clean.FSUSBLOG_SEALED_FIXTURE_PREREQUISITES, '[]');
    assert.throws(() => resolveMatrixFixturePrerequisiteEnvironment({ ...env,
        FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: '' }, sealed), /sealed matrix consumer/u);
    assert.throws(() => resolveMatrixFixturePrerequisiteEnvironment({ ...env,
        FSUSBLOG_SEALED_FIXTURE_PREREQUISITES: '[]' }, sealed), /binding/u);
});

test('actual canonical CLI rejects absent/tampered prerequisite seal before producing state or contacting a service', (context) =>
{
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'issue-1851-declared-cli-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = applySealedFixtureProfileEnvironment({ ...process.env, FSUSBLOG_FIXTURE_PROFILE: '' }, sealed);
    const args = [path.join(root, 'tools/test-fixtures/cli.mjs'), 'run', '--profile', sealed.profileId, '--source', 'matrix',
        '--execution-class', 'runtime', '--sealed-profile-id', sealed.profileId,
        '--sealed-catalog-digest', sealed.catalogDigest, '--sealed-capability-digest', sealed.expandedCapabilityDigest,
        '--sealed-variant-ids', JSON.stringify(sealed.variantIds), '--sealed-variant-plan-digest', sealed.variantPlanDigest,
        '--run-id', execution.runId, '--namespace', execution.namespace, '--source-commit', execution.sourceIdentity.commit,
        '--source-fingerprint', execution.sourceIdentity.worktreeFingerprint, '--service-generation', execution.handles.serviceGeneration,
        '--base-url', 'http://127.0.0.1:1', '--runtime-cache-consumer-id', tier.id,
        '--runtime-cache-input-dir', directory, '--public-projection', path.join(directory, 'public.json'),
        '--prepare-state', path.join(directory, 'public-state.json'), '--fixture-receipt', path.join(directory, 'public-receipt.json')];
    for (const changed of [
        { FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID: '' },
        { FSUSBLOG_SEALED_FIXTURE_PREREQUISITES: '[]' },
        { FSUSBLOG_SEALED_FIXTURE_PREREQUISITES: JSON.stringify([...sealed.prerequisites, ...sealed.prerequisites]) },
        { FSUSBLOG_SEALED_FIXTURE_PREREQUISITES: JSON.stringify([{ ...sealed.prerequisites[0], consumerId: 'foreign' }]) }
    ])
    {
        const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...changed }, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /sealed consumer|binding mismatch/u);
        assert.equal(result.stdout, '');
        assert.deepEqual(fs.readdirSync(directory), []);
    }
});

function unitReceipt(profile, producerId, entities, executionIdentity = execution)
{
    // Pure contract observations, not actual DB/Redis/JWT or runtime qualification.
    const planned = plan(profile, executionIdentity);
    const variants = buildProducerFixtureVariantPlan({ producerId, variantIds: planned.variantIds, fixtureVariantIds: planned.variantIds,
        fixtureVariantPlanDigest: planned.variantPlanDigest });
    const observed = entities.map((item) => ({ ...item, owned: true,
        variantId: variants.variants.find((variant) => variant.capabilityId === item.capabilityHint)?.id ?? variants.variants[0].id }));
    const observations = { database: { namespace: executionIdentity.namespace, entities: observed },
        redis: { namespace: executionIdentity.namespace, keys: [{ key: 'blog:top_articles', domain: 'redis.cache.public', present: true, memberIds: ['101'] }] },
        cache: { namespace: executionIdentity.namespace, entries: [{ endpoint: 'search', matchesDb: true }] } };
    const entityIdentities = observed.map((item) => ({ kind: item.kind, id: item.id, variantId: item.variantId, owner: `${producerId}:ns:declared-admin-unit` }));
    const checked = verifyCapabilityPostconditions({ capabilities: planned.capabilities, producerId,
        providedCapabilities: planned.capabilities, observations, entityIdentities });
    assert.equal(checked.ok, true, JSON.stringify(checked));
    const produced = buildProducerReceipt({ producerId, strategy: 'transaction-fixture', runId: executionIdentity.runId,
        namespace: executionIdentity.namespace, source: executionIdentity.sourceIdentity,
        fixtureCatalogDigest: planned.catalogDigest, profileId: planned.profileIdentity.profileId,
        expandedCapabilityDigest: planned.expandedCapabilityDigest, fixtureVariantIds: planned.variantIds,
        variantPlanDigest: planned.variantPlanDigest, producerVariantPlanDigest: variants.producerVariantPlanDigest,
        producedVariantIds: variants.variants.map((item) => item.id), serviceGeneration: executionIdentity.handles.serviceGeneration,
        providedCapabilities: planned.capabilities, ownedStateDomains: planned.producerSpecs[0].stateDomains,
        entityIdentities, postconditionObservations: checked.results, databaseObservation: observations.database,
        redisObservation: observations.redis, cacheObservation: observations.cache });
    return { receipt: aggregateVerifiedFixtureReceipt({ plan: planned, producerReceipts: [produced] }),
        state: { schema: 'fsusblog.fixture-prepare-state.v1', terminalState: 'prepared', plan: planned } };
}

function publicEntities()
{
    const capabilities = catalogs.capability.capabilities.filter((item) => sealed.capabilities.includes(item.id));
    const entities = capabilities.map((item, index) => ({ kind: 'article', id: String(101 + index), capabilityHint: item.id,
        postconditionId: item.postconditionIds[0], fields: { status: item.id.match(/\.(archived|deleted|draft|scheduled)$/u)?.[1] ?? 'published',
            currentPublicationId: '201', currentRevisionId: '301', publicDetailReadable: true, hot: true,
            deleted: item.id.endsWith('.deleted'),
            revisionIds: ['301', '302', '303'], publicationIds: ['201', '202'], multipleRevisions: true, multiplePublications: true,
            revisionCount: 3, publicationCount: 2, rightsResponsibilityBound: true, immutableHistoryVerified: true,
            operations: ['create', 'publish', 'schedule', 'execute-schedule', 'scheduled-update', 'scheduled-publish', 'update', 'delete', 'restore', 'rollback'] } }));
    entities.push({ kind: 'category', id: '501' }, { kind: 'tag', id: '601' });
    return entities;
}

async function fixture(context)
{
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'issue-1851-declared-admin-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const content = unitReceipt(sealed, 'public-content', publicEntities());
    // Same existing outlet owner, contract observations only; not a service or runtime receipt.
    const artifactOutlet = createFixtureArtifactOutlet(path.join(directory, 'artifacts'), { plan: content.state.plan, consumerId: tier.id });
    const variantPlan = buildProducerFixtureVariantPlan({ producerId: 'public-content', variantIds: content.state.plan.variantIds,
        fixtureVariantIds: content.state.plan.variantIds, fixtureVariantPlanDigest: content.state.plan.variantPlanDigest });
    const artifactContext = { producerId: 'public-content', runIdentity: execution.runId, namespace: execution.namespace,
        sourceIdentity: execution.sourceIdentity, profileIdentity: content.state.plan.profileIdentity, variantPlan,
        handles: { serviceGeneration: execution.handles.serviceGeneration, fixtureArtifactConsumerId: tier.id } };
    artifactOutlet.recordPort(artifactContext, 'prepare', { producerId: 'public-content', observations: content.receipt.producerReceipts[0].observations });
    artifactOutlet.recordPort(artifactContext, 'verify', { ok: true, producerId: 'public-content' });
    content.receipt = aggregateVerifiedFixtureReceipt({ plan: content.state.plan, producerReceipts: content.receipt.producerReceipts,
        outputArtifacts: artifactOutlet.publish('verify') });
    const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const admin = { kind: 'admin', id: '7', owned: true, capabilityHint: 'auth.admin.full-permission',
        postconditionId: 'admin-full-permission', semanticRole: 'admin.full-permission', fixtureIdentity: 'unit-owned',
        fields: { permission: 'full', status: 'active', adminSessionId: 'unit-session', adminFixturePlanDigest: 'f'.repeat(64),
            adminAccessExpiresAtUtc: expiry, adminSessionIdleExpiresAtUtc: expiry, adminSessionAbsoluteExpiresAtUtc: expiry } };
    const authEntities = [admin, { kind: 'user', id: '8', capabilityHint: 'auth.user.active', postconditionId: 'user-active', fields: { status: 'active' } },
        { kind: 'session', id: 'unit-user-session', capabilityHint: 'session.single-device', postconditionId: 'session-single-device',
            fields: { state: 'active', live: true, databaseStateVerified: true, claimStateVerified: true, cacheStateVerified: true } }];
    const auth = unitReceipt(sealMatrixFixtureProfile({ fixtureProfile: sealed.prerequisites[0].profileId, executionClass: 'runtime' }), 'auth-session', authEntities);
    const receiptFile = path.join(directory, 'public-receipt.json');
    const prepareStateFile = path.join(directory, 'public-state.json');
    const authReceiptFile = path.join(directory, 'auth-receipt.json');
    const authStateFile = path.join(directory, 'auth-state.json');
    const privateAdminFile = path.join(directory, 'admin-private.json');
    const publicProjectionFile = path.join(directory, 'public.json');
    writePrivateJson(receiptFile, content.receipt);
    writePrivateJson(prepareStateFile, content.state);
    writePrivateJson(authReceiptFile, auth.receipt);
    writePrivateJson(authStateFile, auth.state);
    const carrier = { identity: { runId: execution.runId, namespace: execution.namespace, profileId: 'auth-basic',
        sourceCommit: execution.sourceIdentity.commit, sourceFingerprint: execution.sourceIdentity.worktreeFingerprint,
        serviceGeneration: execution.handles.serviceGeneration, catalogDigest: auth.receipt.catalogDigest,
        variantPlanDigest: auth.receipt.variantPlanDigest, planDigest: admin.fields.adminFixturePlanDigest },
    publicFact: { ...admin, variantId: auth.receipt.producerReceipts[0].observations.database.entities[0].variantId }, opaque: 'unit-only-opaque' };
    const carrierReference = persistAuthPrivateCarrier({ runIdentity: execution.runId, namespace: execution.namespace,
        profileIdentity: { profileId: 'auth-basic' }, sourceIdentity: execution.sourceIdentity, plan: auth.state.plan,
        handles: { ...execution.handles, authPrivateCarrierDir: directory } }, carrier);
    const oldFetch = globalThis.fetch;
    context.after(() =>
    {
        globalThis.fetch = oldFetch;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, identity: carrier.identity, publicFact: carrier.publicFact,
        carrierDigest: createHash('sha256').update(carrier.opaque).digest('hex'),
        credentials: { accessToken: 'unit-only-not-a-jwt', sessionId: 'unit-session', accessTokenExpiresAtUtc: expiry, idleExpiresAtUtc: expiry } }), { status: 200 });
    await writeVerifiedAdminPrerequisiteProjection(privateAdminFile, { authReceipt: auth.receipt, publicReceipt: content.receipt,
        carrierReference, consumerId: tier.id, consumerProfileId: tier.fixtureProfile, publicProjectionFile,
        handles: { baseUrl: 'http://127.0.0.1:1', localAuthFixtureSecret: 'unit-only-secret' } });
    const prerequisite = { declaration: resolveRuntimeCacheConsumer(tier.id).prerequisites[0],
        receiptFile: authReceiptFile, prepareStateFile: authStateFile, privateAdminFile };
    const options = { consumerId: tier.id, receiptFile, prepareStateFile, publicProjectionFile, prerequisiteInputs: [prerequisite] };
    const file = path.join(directory, 'input.json');
    writeRuntimeCacheFixtureInput(file, options);
    const admission = { consumerId: tier.id, source: execution.sourceIdentity, runId: execution.runId, namespace: execution.namespace,
        serviceGeneration: execution.handles.serviceGeneration, pgContainer: 'owned-pg', redisContainer: 'owned-redis' };
    return { file, options, admission, directory, content, auth, authEntities, privateAdminFile };
}

test('formal hot input binds complete separate matrix receipts and separate private/public refs', async (context) =>
{
    const value = await fixture(context);
    const admitted = readRuntimeCacheFixtureInput(value.file, value.admission);
    assert.equal(admitted.receipt.profileIdentity.profileId, 'public-content-lifecycle');
    assert.equal(admitted.authReceipt.profileIdentity.profileId, 'auth-basic');
    assert.equal(admitted.authReceipt.capabilityMap.length, 3);
    assert.equal(admitted.receipt.capabilityMap.length, 14);
    assert.notEqual(admitted.input.publicProjection.path, admitted.input.privateAdmin.path);
    await assert.rejects(readVerifiedAdminRuntimeProjection(value.privateAdminFile, {
        authReceipt: admitted.authReceipt, publicReceipt: admitted.receipt, consumerProfileId: tier.fixtureProfile,
        consumerId: tier.id, executionIdentity: admitted.receipt.executionIdentity, expectedContentDigest: 'foreign' }), /content binding drift/u);
    assert.doesNotMatch(fs.readFileSync(value.file, 'utf8'), /unit-only-not-a-jwt|unit-only-opaque/u);
    assert.throws(() => writeRuntimeCacheFixtureInput(value.file, { ...value.options, prerequisiteInputs: [] }), /exact declared/u);
    assert.throws(() => writeRuntimeCacheFixtureInput(value.file, { ...value.options,
        prerequisiteInputs: [...value.options.prerequisiteInputs, ...value.options.prerequisiteInputs] }), /exact declared/u);
    const manifest = JSON.parse(fs.readFileSync(value.file, 'utf8'));
    for (const field of ['id', 'profileId', 'producerId', 'capabilityId', 'semanticRole', 'consumerId', 'variantPlanDigest'])
    {
        const changed = structuredClone(manifest);
        changed.prerequisites[0].declaration[field] = 'foreign';
        writePrivateJson(value.file, changed);
        assert.throws(() => readRuntimeCacheFixtureInput(value.file, value.admission), /binding/u);
    }
    writePrivateJson(value.file, manifest);
    for (const field of ['consumerId', 'runId', 'namespace', 'serviceGeneration', 'pgContainer', 'redisContainer'])
    {
        assert.throws(() => readRuntimeCacheFixtureInput(value.file, { ...value.admission, [field]: 'foreign' }));
    }
    const extra = structuredClone(manifest);
    extra.prerequisites[0].waiver = true;
    writePrivateJson(value.file, extra);
    assert.throws(() => readRuntimeCacheFixtureInput(value.file, value.admission), /binding/u);
    writePrivateJson(value.file, manifest);
    const artifact = JSON.parse(fs.readFileSync(value.privateAdminFile, 'utf8'));
    artifact.semanticRole = 'user.active';
    writePrivateJson(value.privateAdminFile, artifact);
    assert.throws(() => readRuntimeCacheFixtureInput(value.file, value.admission), /content binding/u);
});

test('independently sealed foreign receipt and variant/service/source mismatches cannot compose', async (context) =>
{
    const value = await fixture(context);
    for (const changed of [
        { ...execution, runId: 'another-run' },
        { ...execution, namespace: 'another-namespace' },
        { ...execution, sourceIdentity: { ...execution.sourceIdentity, commit: 'd'.repeat(40) } },
        { ...execution, sourceIdentity: { ...execution.sourceIdentity, worktreeFingerprint: `sha256:${'d'.repeat(64)}` } },
        { ...execution, handles: { ...execution.handles, serviceGeneration: `sha256:${'d'.repeat(64)}` } },
        { ...execution, handles: { ...execution.handles, pgContainer: 'foreign-pg' } },
        { ...execution, handles: { ...execution.handles, redisContainer: 'foreign-redis' } }
    ])
    {
        const auth = unitReceipt(sealMatrixFixtureProfile({ fixtureProfile: sealed.prerequisites[0].profileId, executionClass: 'runtime' }), 'auth-session', value.authEntities, changed);
        writePrivateJson(value.options.prerequisiteInputs[0].receiptFile, auth.receipt);
        assert.throws(() => writeRuntimeCacheFixtureInput(value.file, value.options), /identity\/owner mismatch/u);
    }
    writePrivateJson(value.options.prerequisiteInputs[0].receiptFile, value.auth.receipt);
    const alternateClass = catalogs.profile.profiles.find((item) => item.id === sealed.prerequisites[0].profileId)
        .allowedExecutionClasses.find((item) => item !== 'runtime');
    assert.equal(alternateClass, 'browser');
    const wrongClass = unitReceipt(sealMatrixFixtureProfile({ fixtureProfile: sealed.prerequisites[0].profileId,
        executionClass: alternateClass }), 'auth-session', value.authEntities);
    writePrivateJson(value.options.prerequisiteInputs[0].receiptFile, wrongClass.receipt);
    assert.throws(() => writeRuntimeCacheFixtureInput(value.file, value.options), /complete sealed matrix profile/u);
    writePrivateJson(value.options.prerequisiteInputs[0].receiptFile, value.auth.receipt);
    const wrongState = structuredClone(value.auth.state);
    wrongState.plan.variantPlanDigest = `sha256:${'d'.repeat(64)}`;
    writePrivateJson(value.options.prerequisiteInputs[0].prepareStateFile, wrongState);
    assert.throws(() => writeRuntimeCacheFixtureInput(value.file, value.options), /prepare-state execution\/profile binding/u);
    writePrivateJson(value.options.prerequisiteInputs[0].prepareStateFile, value.auth.state);
    const wrongVariant = structuredClone(value.options);
    wrongVariant.prerequisiteInputs[0].declaration.variantIds = [];
    assert.throws(() => writeRuntimeCacheFixtureInput(value.file, wrongVariant), /declaration binding/u);
    await assert.rejects(prepareRuntimeCacheDeclaredPrerequisites({ consumerId: tier.id, directory: value.directory,
        receiptFile: value.options.receiptFile, prepareStateFile: value.options.prepareStateFile,
        publicProjectionFile: value.options.publicProjectionFile, sealedPrerequisites: [] }), /before issuance/u);
});

test('canonical prerequisite failure retains its own recovery state without overwriting primary state', async (context) =>
{
    const value = await fixture(context);
    const primary = fs.readFileSync(value.options.prepareStateFile);
    const directory = path.join(value.directory, 'failed-prerequisite-run');
    const saved = { file: process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE, json: process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON };
    context.after(() =>
    {
        for (const [key, previous] of [['FSUSBLOG_TEMPORAL_CONTEXT_FILE', saved.file], ['FSUSBLOG_TEMPORAL_CONTEXT_JSON', saved.json]])
        {
            if (previous === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = previous;
            }
        }
    });
    delete process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE;
    process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = JSON.stringify(qualificationTemporalContext({
        sourceCommit: execution.sourceIdentity.commit, sourceFingerprint: execution.sourceIdentity.worktreeFingerprint,
        schedulerRunId: execution.runId, producerId: 'auth-session', businessEpochUtc: '2024-02-29T23:59:59.000Z',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest(), locale: 'en-US', uiLocale: 'en-US' }));
    let prepares = 0;
    let failure;
    await assert.rejects(prepareRuntimeCacheDeclaredPrerequisites({ consumerId: tier.id, directory,
        receiptFile: value.options.receiptFile, prepareStateFile: value.options.prepareStateFile,
        publicProjectionFile: value.options.publicProjectionFile,
        sealedPrerequisites: sealed.prerequisites, handles: { authFixtureAdapter: { async prepare()
        {
            prepares += 1;
            throw new Error('unit-only owner prepare failure');
        } } } }), (error) =>
    {
        failure = error;
        assert.match(error.message, /separate owned recovery state retained/u);
        return true;
    });
    assert.equal(prepares, 1, failure?.cause?.message);
    assert.deepEqual(fs.readFileSync(value.options.prepareStateFile), primary);
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'prerequisites/typed-admin-session/prepare-state.json')));
    assert.equal(state.plan.profileIdentity.profileId, 'auth-basic');
    assert.notEqual(state.terminalState, 'verified');
    assert.ok(!fs.existsSync(path.join(directory, `${tier.id}.json`)));
});

test('already cancelled declared prerequisite never enters its canonical prepare port', async (context) =>
{
    const value = await fixture(context);
    const originalState = fs.readFileSync(value.options.prepareStateFile);
    const originalReceipt = fs.readFileSync(value.options.receiptFile);
    const directory = path.join(value.directory, 'cancelled-prerequisite');
    const controller = new AbortController();
    const reason = new Error('cancel-before-auth-issuance');
    controller.abort(reason);
    let prepares = 0;
    await assert.rejects(prepareRuntimeCacheDeclaredPrerequisites({ consumerId: tier.id, directory,
        receiptFile: value.options.receiptFile, prepareStateFile: value.options.prepareStateFile,
        publicProjectionFile: value.options.publicProjectionFile, sealedPrerequisites: sealed.prerequisites,
        signal: controller.signal, handles: { authFixtureAdapter: { async prepare()
        {
            prepares += 1;
            throw new Error('already aborted call reached issuance');
        } } } }), (error) => error === reason);
    assert.equal(prepares, 0);
    assert.ok(!fs.existsSync(directory));
    assert.deepEqual(fs.readFileSync(value.options.prepareStateFile), originalState);
    assert.deepEqual(fs.readFileSync(value.options.receiptFile), originalReceipt);
});

test('abort during the canonical prerequisite prepare keeps the original signal and failure without duplicate cleanup', async (context) =>
{
    const value = await fixture(context);
    const originalState = fs.readFileSync(value.options.prepareStateFile);
    const originalReceipt = fs.readFileSync(value.options.receiptFile);
    const directory = path.join(value.directory, 'inflight-cancelled-prerequisite');
    const savedFile = process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE;
    const savedJson = process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON;
    context.after(() =>
    {
        for (const [key, previous] of [['FSUSBLOG_TEMPORAL_CONTEXT_FILE', savedFile], ['FSUSBLOG_TEMPORAL_CONTEXT_JSON', savedJson]])
        {
            if (previous === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = previous;
            }
        }
    });
    delete process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE;
    process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = JSON.stringify(qualificationTemporalContext({
        sourceCommit: execution.sourceIdentity.commit, sourceFingerprint: execution.sourceIdentity.worktreeFingerprint,
        schedulerRunId: execution.runId, producerId: 'auth-session', businessEpochUtc: '2024-02-29T23:59:59.000Z',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest(), locale: 'en-US', uiLocale: 'en-US' }));
    const controller = new AbortController();
    const reason = new Error('cancel-in-auth-prepare');
    let prepares = 0;
    let cleanups = 0;
    await assert.rejects(prepareRuntimeCacheDeclaredPrerequisites({ consumerId: tier.id, directory,
        receiptFile: value.options.receiptFile, prepareStateFile: value.options.prepareStateFile,
        publicProjectionFile: value.options.publicProjectionFile, sealedPrerequisites: sealed.prerequisites,
        signal: controller.signal, handles: { authFixtureAdapter: { async prepare(_ownerContext, signal)
        {
            prepares += 1;
            assert.equal(signal, controller.signal);
            queueMicrotask(() => controller.abort(reason));
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            signal.throwIfAborted();
        }, async cleanup()
        {
            cleanups += 1;
        } } } }), (error) =>
    {
        assert.match(error.message, /separate owned recovery state retained/u);
        assert.equal(error.cause.cause, reason);
        return true;
    });
    assert.equal(prepares, 1);
    // A failed prepare is not a succeeded producer; the orchestrator owns rollback.
    assert.equal(cleanups, 0);
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'prerequisites/typed-admin-session/prepare-state.json')));
    assert.equal(state.plan.profileIdentity.profileId, 'auth-basic');
    assert.equal(state.primaryFailure.message, reason.message);
    assert.notEqual(state.terminalState, 'verified');
    assert.deepEqual(fs.readFileSync(value.options.prepareStateFile), originalState);
    assert.deepEqual(fs.readFileSync(value.options.receiptFile), originalReceipt);
    assert.ok(!fs.existsSync(path.join(directory, `${tier.id}.json`)));
    assert.ok(!fs.existsSync(path.join(directory, 'prerequisite-inputs.json')));
});

test('abort during private projection verification cannot replace private or public artifacts or release credentials', async (context) =>
{
    const value = await fixture(context);
    const originalPrivate = fs.readFileSync(value.privateAdminFile);
    const originalPublic = fs.readFileSync(value.options.publicProjectionFile);
    const artifact = JSON.parse(originalPrivate);
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const reason = new Error('cancel-private-projection-response');
    globalThis.fetch = async (...args) =>
    {
        const response = await originalFetch(...args);
        controller.abort(reason);
        return response;
    };
    await assert.rejects(writeVerifiedAdminPrerequisiteProjection(value.privateAdminFile, {
        authReceipt: value.auth.receipt, publicReceipt: value.content.receipt,
        carrierReference: artifact.carrierReference, consumerId: tier.id, consumerProfileId: tier.fixtureProfile,
        publicProjectionFile: value.options.publicProjectionFile, signal: controller.signal,
        handles: { baseUrl: 'http://127.0.0.1:1', localAuthFixtureSecret: 'unit-only-secret' }
    }), (error) => error === reason);
    assert.deepEqual(fs.readFileSync(value.privateAdminFile), originalPrivate);
    assert.deepEqual(fs.readFileSync(value.options.publicProjectionFile), originalPublic);
    await assert.rejects(readVerifiedAdminRuntimeProjection(value.privateAdminFile, {
        authReceipt: value.auth.receipt, publicReceipt: value.content.receipt, consumerId: tier.id,
        consumerProfileId: tier.fixtureProfile, executionIdentity: value.content.receipt.executionIdentity,
        signal: controller.signal
    }), (error) => error === reason);
    const readController = new AbortController();
    globalThis.fetch = async (...args) =>
    {
        const response = await originalFetch(...args);
        readController.abort(reason);
        return response;
    };
    await assert.rejects(readVerifiedAdminRuntimeProjection(value.privateAdminFile, {
        authReceipt: value.auth.receipt, publicReceipt: value.content.receipt, consumerId: tier.id,
        consumerProfileId: tier.fixtureProfile, executionIdentity: value.content.receipt.executionIdentity,
        signal: readController.signal,
        handles: { baseUrl: 'http://127.0.0.1:1', localAuthFixtureSecret: 'unit-only-secret' }
    }), (error) => error === reason);
});
