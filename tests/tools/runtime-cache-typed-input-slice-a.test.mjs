import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { plan, prepare, verify } = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const { createPublicContentPort } = await import(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url));
const { publicContentVerificationIdentity } = await import(new URL('../../tools/test-fixtures/producers/public-content-producer.mjs', import.meta.url));
const { createFixtureArtifactOutlet, writePrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
const { sealMatrixFixtureProfile } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const { buildProducerFixtureVariantPlan } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const { buildProducerReceipt, verifyCapabilityPostconditions } = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const { aggregateVerifiedFixtureReceipt } = await import(new URL('../../tools/test-fixtures/receipt/fixture-receipt.mjs', import.meta.url));
const { persistAuthPrivateCarrier } = await import(new URL('../../tools/test-fixtures/producers/auth-session-producer.mjs', import.meta.url));
const { resolveRuntimeCacheConsumer, assertRuntimeCacheConsumerSupported, writeRuntimeCacheFixtureInput,
    readRuntimeCacheFixtureInput, verifyRuntimeCacheFixtureInput, writeVerifiedAdminPrerequisiteProjection,
    readVerifiedAdminRuntimeProjection } = await import(new URL('../../tools/test-fixtures/receipt/projection.mjs', import.meta.url));
const { produceHotFeaturedFrameReceipt } = await import(new URL('../../tools/test/runtime-cache-scenarios/hot-featured-frame.mjs', import.meta.url));
const { currentSourceState } = await import(new URL('../../tools/test/runtime-cache-evidence-contract.mjs', import.meta.url));
const { resolveWorktreeFingerprint } = await import(new URL('../../tools/fact-extractors/identity.mjs', import.meta.url));

const root = path.resolve(import.meta.dirname, '../..');
const source = { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` };
const serviceGeneration = `sha256:${'c'.repeat(64)}`;

function facts()
{
    const cursors = [10, 100, 1000].map((logicalPage, index) => ({ logicalPage,
        cursor: `unit-opaque-${logicalPage}`, boundaryIdentity: { articleId: String(901 + index),
            createTimeUtc: '2026-09-14T08:00:00Z', sortValue: 0, precedingItemCount: (logicalPage - 1) * 10 } }));
    const entities = [
        ...cursors.map((cursor, index) => ({ kind: 'article', id: cursor.boundaryIdentity.articleId,
            capabilityHint: 'article-pagination-deep', fields: { status: 'published', currentPublicationId: 700,
                publicDetailReadable: true, hasCover: index < 2, coverImageUrl: index < 2 ? '/unit.svg' : null } })),
        { kind: 'pagination-keyset', id: 'article/list/home:latest:size=10', capabilityHint: 'article-pagination-deep',
            postconditionId: 'article-pagination-deep', fields: { route: 'article/list/home', sort: 'latest', pageSize: 10,
                generation: 47, articleCount: 10023, ownedArticleCount: 10023, cursors } }
    ];
    return { strategy: 'transaction-fixture', projection: { pagination: entities.at(-1).fields },
        entityIdentities: entities.map((entity) => ({ kind: entity.kind, id: entity.id,
            capabilityHint: entity.capabilityHint })), observations: { source: 'service', database: { namespace: 'ns', entities },
            redis: { namespace: 'ns', keys: [] }, cache: { namespace: 'ns', generation: 47, entries: [] } } };
}

function independent(context, result)
{
    return { ok: true, identity: publicContentVerificationIdentity(context), proofDigest: null,
        entityIdentities: structuredClone(result.entityIdentities),
        observations: { ...structuredClone(result.observations), source: 'independent-service-read' } };
}

async function input(context)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'issue-1851-slice-a-unit-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const sealed = sealMatrixFixtureProfile({ fixtureProfile: resolveRuntimeCacheConsumer('runtime-cache-pagination').profileId, executionClass: 'runtime' });
    const planned = plan(sealed, { runId: 'unit-run', namespace: 'ns', sourceIdentity: source,
        handles: { serviceGeneration, pgContainer: 'owned-pg', redisContainer: 'owned-redis' } });
    const port = createPublicContentPort();
    const artifactOutlet = createFixtureArtifactOutlet(path.join(directory, 'artifacts'), {
        plan: planned, consumerId: 'runtime-cache-pagination'
    });
    const state = await prepare(planned, [port], undefined, { handles: { publicContentAdapter: { async prepare()
    {
        return facts();
    } } }, artifactOutlet });
    const receipt = await verify(state, [port], { handles: { publicContentAdapter: { async verify(context, result)
    {
        return independent(context, result);
    } } }, artifactOutlet });
    const receiptFile = path.join(directory, 'receipt.json');
    const prepareStateFile = path.join(directory, 'state.json');
    const publicProjectionFile = path.join(directory, 'public.json');
    const file = path.join(directory, 'runtime-cache-pagination.json');
    writePrivateJson(receiptFile, receipt);
    writePrivateJson(prepareStateFile, state);
    const options = { receiptFile, prepareStateFile, publicProjectionFile, consumerId: 'runtime-cache-pagination' };
    writeRuntimeCacheFixtureInput(file, options);
    const admission = { consumerId: 'runtime-cache-pagination', source, runId: 'unit-run', namespace: 'ns',
        serviceGeneration, pgContainer: 'owned-pg', redisContainer: 'owned-redis' };
    return { file, directory, options, admission, receipt, state };
}

test('canonical source fingerprint is shared without dropping dirty/status facts', () =>
{
    const state = currentSourceState(root);
    assert.equal(state.worktreeFingerprint, `sha256:${resolveWorktreeFingerprint(root)}`);
    assert.equal(typeof state.dirty, 'boolean');
    assert.match(state.statusDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('runtime primary admission reopens actual outlet sidecars and rejects missing, drifted and unsafe artifacts', async (context) =>
{
    const fixture = await input(context);
    const planned = fixture.state.plan;
    rmSync(path.join(fixture.directory, 'artifacts'), { recursive: true });
    const outlet = createFixtureArtifactOutlet(path.join(fixture.directory, 'artifacts'), {
        plan: planned, consumerId: fixture.admission.consumerId
    });
    const port = createPublicContentPort();
    const handles = { publicContentAdapter: { async prepare()
    {
        return facts();
    }, async verify(context, result)
    {
        return independent(context, result);
    } } };
    const state = await prepare(planned, [port], undefined, { handles, artifactOutlet: outlet });
    const receipt = await verify(state, [port], { handles, artifactOutlet: outlet });
    const publish = (refs) =>
    {
        const sealed = aggregateVerifiedFixtureReceipt({ plan: planned, producerReceipts: receipt.producerReceipts,
            outputArtifacts: refs });
        writePrivateJson(fixture.options.receiptFile, sealed);
        writePrivateJson(fixture.options.prepareStateFile, state);
        writeRuntimeCacheFixtureInput(fixture.file, fixture.options);
    };
    publish(receipt.outputArtifacts);
    assert.equal(readRuntimeCacheFixtureInput(fixture.file, fixture.admission).receipt.outputArtifacts.length, 2);
    const ref = receipt.outputArtifacts[0];
    const original = readFileSync(ref.path);
    const raw = JSON.parse(original);
    writeFileSync(ref.path, `${original.toString()} `, { mode: 0o600 });
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, fixture.admission), /artifact.*digest/u);
    writeFileSync(ref.path, original);
    for (const [field, value] of [['runId', 'foreign'], ['namespace', 'foreign'], ['profileId', 'auth-basic'],
        ['serviceGeneration', `sha256:${'d'.repeat(64)}`], ['consumerId', 'runtime-cache-related-reading'],
        ['producerId', 'auth-session'], ['source', { ...source, commit: 'd'.repeat(40) }],
        ['variantIds', []], ['producerVariantPlanDigest', `sha256:${'d'.repeat(64)}`]])
    {
        const changed = writePrivateJson(ref.path, { ...raw, binding: { ...raw.binding, [field]: value } });
        assert.throws(() => publish(receipt.outputArtifacts.map((item) => item.path === ref.path
            ? { ...item, digest: changed.contentDigest } : item)), /artifact.*binding/u);
    }
    writeFileSync(ref.path, original);
    const forged = writePrivateJson(ref.path, { ...raw, result: { ...raw.result, accessToken: 'unit-forbidden' } });
    assert.throws(() => publish(receipt.outputArtifacts.map((item) => item.path === ref.path
        ? { ...item, digest: forged.contentDigest } : item)), /artifact.*unowned|secret/u);
    writeFileSync(ref.path, original);
    assert.throws(() => publish([...receipt.outputArtifacts, ref]), /artifact.*duplicate/u);
    assert.throws(() => publish(receipt.outputArtifacts.slice(1)), /artifact.*missing/u);
    assert.throws(() => publish([]), /artifact.*missing/u);
    assert.throws(() => publish(Array.from({ length: 9 }, () => ref)), /artifact.*size/u);
    assert.throws(() => publish(receipt.outputArtifacts.map((item) => ({ ...item, role: 'fixture-cleanup-port-result' }))), /artifact.*role/u);
    publish(receipt.outputArtifacts);
    chmodSync(ref.path, 0o644);
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, fixture.admission), /artifact.*private/u);
    chmodSync(ref.path, 0o600);
    rmSync(ref.path);
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, fixture.admission), /ENOENT|artifact/u);
    symlinkSync(fixture.options.publicProjectionFile, ref.path);
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, fixture.admission), /artifact.*symlink/u);
    rmSync(ref.path);
    writeFileSync(ref.path, original, { mode: 0o600 });
    const escaped = path.join(fixture.directory, 'escaped.json');
    writeFileSync(escaped, original, { mode: 0o600 });
    assert.throws(() => publish(receipt.outputArtifacts.map((item) => item.path === ref.path
        ? { ...item, path: escaped } : item)), /artifact.*path/u);
    writeFileSync(ref.path, Buffer.alloc(2 * 1024 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => publish(receipt.outputArtifacts), /artifact.*size/u);
    writeFileSync(ref.path, original);
    const directory = path.dirname(ref.path);
    const relocated = `${directory}-original`;
    const { renameSync } = await import('node:fs');
    renameSync(directory, relocated);
    symlinkSync(relocated, directory);
    assert.throws(() => publish(receipt.outputArtifacts), /artifact.*symlink/u);
    rmSync(directory);
    renameSync(relocated, directory);
    chmodSync(directory, 0o755);
    assert.throws(() => publish(receipt.outputArtifacts), /artifact.*private/u);
    chmodSync(directory, 0o700);
    publish(receipt.outputArtifacts);
    chmodSync(fixture.directory, 0o755);
    // The writer deliberately repairs its own parent mode; exercise the read-only admission instead.
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, fixture.admission), /artifact.*private/u);
    chmodSync(fixture.directory, 0o700);
    publish(receipt.outputArtifacts);
    assert.equal(readRuntimeCacheFixtureInput(fixture.file, fixture.admission).receipt.outputArtifacts.length, 2);
});

test('all thirteen consumers derive exact profiles; incomplete owners and undeclared auth stay blocked', () =>
{
    for (const id of ['public-hot-read', 'article-detail-l1', 'cache-miss-singleflight', 'l1-residency',
        'related-reading', 'revocation', 'sitemap', 'pagination'])
    {
        assert.doesNotThrow(() => assertRuntimeCacheConsumerSupported(resolveRuntimeCacheConsumer(`runtime-cache-${id}`)));
    }
    for (const id of ['distributed-invalidation', 'redis-fault-classes', 'telemetry', 'security-projections'])
    {
        assert.throws(() => readRuntimeCacheFixtureInput('/nonexistent', { consumerId: `runtime-cache-${id}` }),
            /independent verification\/allocation missing/u);
    }
    assert.throws(() => resolveRuntimeCacheConsumer('invented-consumer'), /exact matrix/u);
    const hot = resolveRuntimeCacheConsumer('runtime-cache-hot-featured-frame');
    assert.equal(hot.prerequisites.length, 1);
    assert.throws(() => assertRuntimeCacheConsumerSupported({ ...hot, prerequisites: [] }),
        /no explicit typed admin prerequisite/u);
    assert.throws(() => writeRuntimeCacheFixtureInput('/nonexistent', { consumerId: hot.consumerId }),
        /exact declared typed admin prerequisite inputs/u);
});

test('sealed receipt/derived cursor input is reopened and independently verified without prepare or refresh', async (context) =>
{
    const fixture = await input(context);
    const admitted = readRuntimeCacheFixtureInput(fixture.file, fixture.admission);
    assert.equal(admitted.input.notAuthoritative, true);
    assert.equal(admitted.input.privateAdmin, null);
    assert.deepEqual(admitted.projection.pagination.cursors.map((item) => item.logicalPage), [10, 100, 1000]);
    let calls = 0;
    await verifyRuntimeCacheFixtureInput(admitted, { handles: { publicContentAdapter: { async verify(context, result)
    {
        calls += 1;
        return independent(context, result);
    }, async prepare()
    {
        throw new Error('runtime admission must not prepare');
    } } } });
    assert.equal(calls, 1);
    for (const field of ['runId', 'namespace', 'serviceGeneration', 'pgContainer', 'redisContainer'])
    {
        assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, { ...fixture.admission, [field]: 'foreign' }), /binding/u);
    }
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, { ...fixture.admission,
        source: { ...source, commit: '0'.repeat(40) } }), /binding/u);
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, { ...fixture.admission,
        now: Date.now() + 16 * 60_000 }), /expiry/u);
    await assert.rejects(verifyRuntimeCacheFixtureInput(admitted, { handles: { publicContentAdapter: { async verify(context, result)
    {
        const observed = independent(context, result);
        observed.observations.database.entities[0].fields.currentPublicationId = null;
        return observed;
    } } } }), /verify failed|drift/u);
    const projection = JSON.parse(readFileSync(fixture.options.publicProjectionFile, 'utf8'));
    projection.pagination.cursors[2].boundaryIdentity.precedingItemCount = 0;
    writePrivateJson(fixture.options.publicProjectionFile, projection);
    assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, fixture.admission), /content binding/u);
});

test('prepared input, stale verification, symlinks, declaration and private-ref tamper fail closed', async (context) =>
{
    const fixture = await input(context);
    writePrivateJson(fixture.options.receiptFile, fixture.state);
    assert.throws(() => writeRuntimeCacheFixtureInput(fixture.file, fixture.options), /schema/u);
    writePrivateJson(fixture.options.receiptFile, fixture.receipt);
    assert.throws(() => writeRuntimeCacheFixtureInput(fixture.file, { ...fixture.options, now: Date.now() + 16 * 60_000 }),
        /current independent verification/u);
    writeRuntimeCacheFixtureInput(fixture.file, fixture.options);
    const original = JSON.parse(readFileSync(fixture.file, 'utf8'));
    for (const change of [(value) =>
    {
        value.declaration.profileId = 'auth-basic';
    }, (value) =>
    {
        value.privateAdmin = { path: '/unverified-header' };
    }, (value) =>
    {
        value.expiresAtUtc = new Date(Date.now() + 60 * 60_000).toISOString();
    }])
    {
        const tampered = structuredClone(original);
        change(tampered);
        writePrivateJson(fixture.file, tampered);
        assert.throws(() => readRuntimeCacheFixtureInput(fixture.file, fixture.admission), /binding|expiry|mismatch/u);
    }
    const link = path.join(fixture.directory, 'link.json');
    symlinkSync(fixture.file, link);
    assert.throws(() => readRuntimeCacheFixtureInput(link, fixture.admission), /symlink/u);
});

test('hot/featured runtime rejects naked headers and never calls the legacy admin endpoint', async () =>
{
    let calls = 0;
    await assert.rejects(produceHotFeaturedFrameReceipt({ scenario: { requests: 2 },
        adminHeaders: { Authorization: 'Bearer unverified' }, adminHeaderFile: '/unverified',
        fetchImpl: async () =>
        {
            calls += 1;
            throw new Error('legacy path');
        } }), /verified typed admin/u);
    assert.equal(calls, 0);
});

test('canonical CLI seals a per-consumer input and rejects undeclared auth without a wrapper or waiver', async (context) =>
{
    const fixture = await input(context);
    const out = path.join(fixture.directory, 'cli-input.json');
    const args = [path.join(root, 'tools/test-fixtures/cli.mjs'), 'project-runtime-cache-input',
        '--receipt', fixture.options.receiptFile, '--prepare-state', fixture.options.prepareStateFile,
        '--public-projection', fixture.options.publicProjectionFile, '--out', out, '--consumer-id'];
    const accepted = spawnSync(process.execPath, [...args, 'runtime-cache-pagination'], { cwd: root, encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(JSON.parse(accepted.stdout).contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).declaration.consumerId, 'runtime-cache-pagination');
    const denied = spawnSync(process.execPath, [...args, 'runtime-cache-hot-featured-frame'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /exact declared typed admin prerequisite inputs/u);
});

test('typed admin reader consumes separate public refs and original credentials after live owner verification', async (context) =>
{
    // This models carrier/receipt validation only, not real JWT or 13-scene qualification.
    const fixture = await input(context);
    const planned = plan({ profileId: 'auth-basic', profileSource: 'dev-cli', executionClass: 'runtime' }, {
        runId: 'unit-run', namespace: 'ns', sourceIdentity: source,
        handles: { serviceGeneration, pgContainer: 'owned-pg', redisContainer: 'owned-redis' }
    });
    const variants = buildProducerFixtureVariantPlan({ producerId: 'auth-session', variantIds: planned.variantIds,
        fixtureVariantIds: planned.variantIds, fixtureVariantPlanDigest: planned.variantPlanDigest });
    const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const admin = { kind: 'admin', id: '7', owned: true, capabilityHint: 'auth.admin.full-permission',
        postconditionId: 'admin-full-permission', semanticRole: 'admin.full-permission', fixtureIdentity: 'fxauth-unit-only',
        fields: { permission: 'full', status: 'active', adminSessionId: 'unit-sid', adminFixturePlanDigest: 'f'.repeat(64),
            adminAccessExpiresAtUtc: expiry, adminSessionIdleExpiresAtUtc: expiry, adminSessionAbsoluteExpiresAtUtc: expiry } };
    const entities = [admin, { kind: 'user', id: '8', owned: true, capabilityHint: 'auth.user.active',
        postconditionId: 'user-active', fields: { status: 'active' } },
    { kind: 'session', id: 'unit-user-sid', owned: true, capabilityHint: 'session.single-device',
        postconditionId: 'session-single-device', fields: { state: 'active', live: true, databaseStateVerified: true,
            claimStateVerified: true, cacheStateVerified: true } }].map((entity) => ({ ...entity,
        variantId: variants.variants.find((item) => item.capabilityId === entity.capabilityHint).id }));
    const observations = { source: 'service', database: { namespace: 'ns', entities },
        redis: { namespace: 'ns', keys: [] }, cache: { namespace: 'ns', entries: [] } };
    const entityIdentities = entities.map((entity) => ({ kind: entity.kind, id: entity.id, variantId: entity.variantId,
        owner: 'auth-session:ns:unit-run' }));
    const checked = verifyCapabilityPostconditions({ capabilities: planned.capabilities, producerId: 'auth-session',
        providedCapabilities: planned.capabilities, observations, entityIdentities });
    assert.equal(checked.ok, true);
    const produced = buildProducerReceipt({ producerId: 'auth-session', strategy: 'transaction-fixture',
        runId: 'unit-run', namespace: 'ns', source, fixtureCatalogDigest: planned.catalogDigest, profileId: 'auth-basic',
        expandedCapabilityDigest: planned.expandedCapabilityDigest, fixtureVariantIds: planned.variantIds,
        variantPlanDigest: planned.variantPlanDigest, producerVariantPlanDigest: variants.producerVariantPlanDigest,
        producedVariantIds: variants.variants.map((item) => item.id), serviceGeneration,
        providedCapabilities: planned.capabilities, ownedStateDomains: planned.producerSpecs[0].stateDomains,
        entityIdentities, postconditionObservations: checked.results, databaseObservation: observations.database,
        redisObservation: observations.redis, cacheObservation: observations.cache });
    const authReceipt = aggregateVerifiedFixtureReceipt({ plan: planned, producerReceipts: [produced] });
    const carrier = { identity: { runId: 'unit-run', namespace: 'ns', profileId: 'auth-basic',
        sourceCommit: source.commit, sourceFingerprint: source.worktreeFingerprint, serviceGeneration,
        catalogDigest: authReceipt.catalogDigest, variantPlanDigest: authReceipt.variantPlanDigest,
        planDigest: admin.fields.adminFixturePlanDigest }, publicFact: admin, opaque: 'unit-opaque-not-runtime' };
    const carrierReference = persistAuthPrivateCarrier({ runIdentity: 'unit-run', namespace: 'ns',
        profileIdentity: { profileId: 'auth-basic' }, sourceIdentity: source, plan: planned,
        handles: { serviceGeneration, authPrivateCarrierDir: fixture.directory } }, carrier);
    const originalFetch = globalThis.fetch;
    context.after(() =>
    {
        globalThis.fetch = originalFetch;
    });
    let calls = 0;
    const credentials = { accessToken: 'unit-not-production-token', sessionId: 'unit-sid',
        accessTokenExpiresAtUtc: expiry, idleExpiresAtUtc: expiry };
    globalThis.fetch = async (_url, options) =>
    {
        calls += 1;
        const request = JSON.parse(options.body);
        assert.equal(request.fixtureReceiptDigest, authReceipt.receiptDigest);
        return new Response(JSON.stringify({ ok: true, identity: carrier.identity, publicFact: admin,
            carrierDigest: (await import('node:crypto')).createHash('sha256').update(carrier.opaque).digest('hex'),
            credentials }), { status: 200 });
    };
    const file = path.join(fixture.directory, 'admin-private.json');
    const options = { authReceipt, publicReceipt: fixture.receipt, carrierReference,
        consumerProfileId: 'runtime-cache-pagination', consumerId: 'runtime-cache-pagination',
        executionIdentity: fixture.receipt.executionIdentity,
        handles: { baseUrl: 'http://127.0.0.1:1', localAuthFixtureSecret: 'unit-secret' },
        publicProjectionFile: fixture.options.publicProjectionFile };
    const summary = await writeVerifiedAdminPrerequisiteProjection(file, options);
    assert.doesNotMatch(JSON.stringify(summary), /unit-not-production-token|unit-opaque-not-runtime/u);
    const artifact = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(artifact.publicProjection, undefined);
    assert.equal(artifact.publicProjectionReference.path, fixture.options.publicProjectionFile);
    const headers = await readVerifiedAdminRuntimeProjection(file, options);
    assert.equal(headers.Authorization, 'Bearer unit-not-production-token');
    assert.equal(calls, 2);
    for (const field of ['consumerId', 'consumerProfileId', 'executionIdentity'])
    {
        await assert.rejects(readVerifiedAdminRuntimeProjection(file, { ...options, [field]: 'foreign' }));
    }
    for (const [field, value] of [['semanticRole', 'user.active'], ['adminPrincipalId', 'foreign'],
        ['expiresAtUtc', '2000-01-01T00:00:00.000Z'], ['carrierDigest', '0'.repeat(64)]])
    {
        writePrivateJson(file, { ...artifact, [field]: value });
        await assert.rejects(readVerifiedAdminRuntimeProjection(file, options), /binding|drift/u);
    }
    writePrivateJson(file, artifact);
    globalThis.fetch = async () => new Response('must-not-leak-response', { status: 409 });
    await assert.rejects(readVerifiedAdminRuntimeProjection(file, options), /HTTP 409/u);
});
