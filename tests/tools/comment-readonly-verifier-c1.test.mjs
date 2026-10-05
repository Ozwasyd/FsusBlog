import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
const { createFixtureArtifactOutlet, readPrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
const { createCommentModerationPort } = await import(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url));

const { buildCommentFixturePlan, verifyCommentModeration } = await import(new URL('../../tools/test-fixtures/producers/comment-moderation-producer.mjs', import.meta.url));
const { buildCanonicalCommentFixtureRuntimeEvidence } = await import(new URL('../../tools/test/comment-fixture-governance.mjs', import.meta.url));
const { buildProducerReceipt, digestCanonical } = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const { buildFixtureVariantPlan, buildProducerFixtureVariantPlan, fixtureCatalogDigest, readFixtureCatalogs } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const { createProducerContext } = await import(new URL('../../tools/test-fixtures/producer-port.mjs', import.meta.url));

// HTTP contract model only. These values and the local server do not qualify DB/runtime/browser behavior.
const hex = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => `sha256:${hex(value)}`;

function model()
{
    const catalogs = readFixtureCatalogs();
    const capabilities = ['auth.admin.full-permission', 'auth.user.active', 'public.article.published',
        'comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix'];
    const fixtureVariantIds = capabilities.map((capabilityId) => catalogs.variant.variants.find(
        (item) => item.capabilityId === capabilityId && item.id.startsWith('canonical.')
    ).id).sort();
    const variantPlan = buildFixtureVariantPlan(fixtureVariantIds, catalogs);
    const producerPlan = (producerId) => buildProducerFixtureVariantPlan({ producerId,
        variantIds: fixtureVariantIds.filter((id) => catalogs.variant.variants.find((item) => item.id === id).ownerProducerId === producerId),
        fixtureVariantIds, fixtureVariantPlanDigest: variantPlan.variantPlanDigest, catalogs });
    const source = { commit: 'a'.repeat(40), worktreeFingerprint: digest('source') };
    const runId = 'comment-c1-model-run';
    const namespace = 'comment-c1-model-ns';
    const profileId = 'comments-moderation';
    const producerResultDigest = hex('auth-result');
    const identityPrepareReferences = [['admin', 'auth.admin.full-permission', '7'],
        ['primary-author', 'auth.user.active', '11'], ['secondary-author', 'auth.user.active', '12']].map(([role, capabilityId, publicId]) =>
    {
        const body = { schema: 'fsusblog.fixture-identity-prepare-reference.v1', verified: false,
            ownerProducerId: 'auth-session', consumerProducerId: 'comment-moderation', runId, namespace, profileId,
            role, capabilityId, publicId, semanticRole: `consumer.comment-moderation.${role}`,
            fixtureIdentity: `fixture-${role}`, producerResultDigest, planDigests: {} };
        return { ...body, digest: hex(JSON.stringify(body)) };
    });
    const authResult = { producerId: 'auth-session', producerResultDigest, identityPrepareReferences };
    const context = { catalogs, runIdentity: runId, namespace, profileIdentity: { profileId },
        plan: { capabilities: capabilities.filter((item) => item.startsWith('comment.') || item.startsWith('moderation.')),
            expandedCapabilityDigest: digestCanonical(capabilities), variantPlanDigest: variantPlan.variantPlanDigest,
            executionIdentity: { runId, namespace, sourceIdentity: source, handles: { serviceGeneration: digest('service') } } },
        variantPlan: producerPlan('comment-moderation'), temporalContext: { schema: 'fsusblog.test-temporal-context.v1' },
        producerOutputs: { 'auth-session': authResult, 'public-content': { producerId: 'public-content', strategy: 'transaction-fixture',
            projection: { articleId: '42' }, temporalArtifacts: { bindingDigest: digest('public-result') },
            entityIdentities: [{ kind: 'article', id: '42' }], observations: { database: {}, redis: {}, cache: {} } } },
        handles: { localCommentFixtureSecret: 'c1-model-secret', testSession: 'comment-c1-model-session' } };
    const receipt = (producerId, entities, providedCapabilities) =>
    {
        const slice = producerPlan(producerId);
        const rows = entities.map((item) => ({ ...item, owned: true,
            variantId: catalogs.variant.variants.find((variant) => variant.capabilityId === item.capabilityHint && slice.variants.some((selected) => selected.id === variant.id)).id }));
        return buildProducerReceipt({ producerId, strategy: 'transaction-fixture', runId, namespace, source, profileId,
            fixtureCatalogDigest: fixtureCatalogDigest(catalogs), expandedCapabilityDigest: context.plan.expandedCapabilityDigest,
            fixtureVariantIds, variantPlanDigest: variantPlan.variantPlanDigest,
            producerVariantPlanDigest: slice.producerVariantPlanDigest, producedVariantIds: slice.variants.map((item) => item.id),
            serviceGeneration: context.plan.executionIdentity.handles.serviceGeneration, providedCapabilities,
            ownedStateDomains: catalogs.producer.producers.find((item) => item.id === producerId).stateDomains,
            entityIdentities: rows.map(({ kind, id, variantId }) => ({ kind, id, variantId })),
            databaseObservation: { namespace, schemaIdentity: 'public', entities: rows },
            postconditionObservations: providedCapabilities.flatMap((capabilityId) => catalogs.capability.capabilities.find((item) => item.id === capabilityId)
                .postconditionIds.map((postconditionId) => ({ capabilityId, postconditionId, ok: true }))), catalogs });
    };
    context.producerReceipts = {
        'auth-session': receipt('auth-session', identityPrepareReferences.map((item) => ({ kind: item.role === 'admin' ? 'admin' : 'user',
            id: item.publicId, semanticRole: item.semanticRole, fixtureIdentity: item.fixtureIdentity,
            capabilityHint: item.capabilityId, fields: {} })), ['auth.admin.full-permission', 'auth.user.active']),
        'public-content': receipt('public-content', [{ kind: 'article', id: '42', capabilityHint: 'public.article.published', fields: {} }], ['public.article.published'])
    };
    const plan = buildCommentFixturePlan(context);
    const binding = { runId, namespace, testSession: plan.testSession, owner: `comment-fixture:${namespace}:${runId}`, profileId,
        capabilities: plan.capabilities, articleId: 42, authProducerResultDigest: plan.identityReferences.authProducerResultDigest,
        authPrepareReferenceDigests: plan.identityReferences.authPrepareReferenceDigests,
        publicContentProducerResultDigest: plan.articleReference.publicContentProducerResultDigest,
        articleProjectionDigest: plan.articleReference.articleProjectionDigest, inventoryDigest: plan.inventoryDigest,
        capabilityCatalogDigest: plan.capabilityCatalogDigest, variantCatalogDigest: plan.variantCatalogDigest,
        temporalContextDigest: plan.temporalContextDigest, producerPlanDigest: plan.producerPlanDigest, planDigest: plan.planDigest };
    const raw = structuredClone(buildCanonicalCommentFixtureRuntimeEvidence().runs[0]);
    const result = { ...raw, planDigest: plan.planDigest,
        entityIdentities: raw.threadEntities.map((item) => ({ kind: 'comment', id: String(item.commentId) })),
        observations: { database: {}, cache: { entries: [{ matchesDb: true }] } },
        zkAuthorityEvidence: ['pending', 'region-manual-review'].map((semanticRole) => ({ schema: 'fsusblog.comment-fixture-zk-authority-evidence.v1',
            semanticRole, authorityClass: 'local-dev-simulation', backend: 'local_dev_fixture', simulation: true, productionUsable: false,
            ticketStoredInProductionOneTimeStore: true, ticketExposed: false,
            operationPlanDigest: hex(semanticRole), publicInputsDigest: hex('public-input'), rootDigest: hex('root') })),
        cleanupReceipt: { ...raw.cleanupReceipt, binding }, moderation: { ...raw.moderation, binding },
        runtimeLease: { ...raw.runtimeLease, binding, owner: binding.owner }, runtimeRestore: { ...raw.runtimeRestore, binding, owner: binding.owner },
        runtimeSemantics: raw.moderation.runtimeSemantics };
    result.crossDomainBefore.accountIds = [11, 12];
    result.crossDomainBefore.adminPrincipalId = 7;
    result.crossDomainAfterPrepare = structuredClone(result.crossDomainBefore);
    result.cleanupReceipt.crossDomainBefore = structuredClone(result.crossDomainBefore);
    const read = { schema: 'fsusblog.comment-fixture-verification-result.v1', binding,
        threadEntities: structuredClone(result.threadEntities), moderation: structuredClone(result.moderation), cacheGeneration: '11',
        crossDomainBefore: structuredClone(result.crossDomainBefore), crossDomainAfter: structuredClone(result.crossDomainBefore),
        authSourceReceiptDigest: context.producerReceipts['auth-session'].producerReceiptDigest,
        publicSourceReceiptDigest: context.producerReceipts['public-content'].producerReceiptDigest };
    // Use the canonical context constructor, including its real sourceIdentity/handles layout.
    // Copies of frozen maps only permit test-owned transport and prerequisite mutations.
    const canonical = createProducerContext({ plan: { ...context.plan, profileIdentity: context.profileIdentity, variantIds: fixtureVariantIds, variantPlan },
        producerId: 'comment-moderation', producerOutputs: context.producerOutputs,
        handles: { ...context.plan.executionIdentity.handles, ...context.handles }, catalogs,
        temporalContext: context.temporalContext, producerReceipts: context.producerReceipts });
    return { context: { ...canonical, catalogs, handles: { ...canonical.handles }, producerReceipts: { ...canonical.producerReceipts } }, result, read };
}

async function gateway(t, handler)
{
    const server = createServer(async (request, response) =>
    {
        try
        {
            const chunks = [];
            for await (const chunk of request)
            {
                chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const output = await handler(request, body);
            response.writeHead(output.status ?? 200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(output.body));
        }
        catch (error)
        {
            response.writeHead(500);
            response.end(JSON.stringify({ message: error.message }));
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) =>
    {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('C1 HTTP model: no injected adapter; only verify route, sealed references and fresh observations are consumed', async (t) =>
{
    const { context, result, read } = model();
    const before = structuredClone(result);
    let requests = 0;
    read.cacheGeneration = '12';
    for (const entity of read.threadEntities)
    {
        entity.cacheGeneration = '12';
    }
    for (const entity of read.moderation.entities)
    {
        entity.cacheGeneration = '12';
    }
    context.handles.baseUrl = await gateway(t, (request, body) =>
    {
        requests++;
        assert.equal(request.url, '/api/local/comment-fixture/verify');
        assert.equal(request.headers['x-fsus-local-comment-fixture-secret'], 'c1-model-secret');
        assert.equal(request.headers['x-fsus-test-run-id'], context.runIdentity);
        assert.equal(request.headers['x-fsus-test-namespace'], context.namespace);
        assert.ok(request.headers['x-fsus-test-session']);
        assert.equal(body.authReference.receipt.producerReceiptDigest, read.authSourceReceiptDigest);
        assert.equal(body.publicReference.receipt.producerReceiptDigest, read.publicSourceReceiptDigest);
        assert.equal('observations' in body, false);
        return { body: read };
    });
    const verification = await verifyCommentModeration(context, result);
    assert.equal(verification.ok, true, verification.reason);
    assert.equal(verification.observations.cache.generation, '12');
    assert.equal(requests, 1);
    assert.deepEqual(result, before);
});

for (const [name, mutate] of [
    ['cross-run', (read) =>
    {
        read.binding.runId = 'foreign';
    }],
    ['missing-live-thread', (read) =>
    {
        read.threadEntities.pop();
    }],
    ['live-content-drift', (read) =>
    {
        read.threadEntities[0].contentDigest = digest('changed-content');
    }],
    ['live-version-drift', (read) =>
    {
        read.threadEntities[0].currentVersion++;
    }],
    ['live-delete-drift', (read) =>
    {
        read.threadEntities[0].isDeleted = !read.threadEntities[0].isDeleted;
    }],
    ['live-actor-drift', (read) =>
    {
        read.threadEntities[0].accountId = '999';
    }],
    ['live-parent-drift', (read) =>
    {
        read.threadEntities[0].parentId = '999';
    }],
    ['public-pending-leak', (read) =>
    {
        read.moderation.entities.find((item) => item.semanticRole === 'pending').publiclyVisible = true;
    }],
    ['region-evidence-missing', (read) =>
    {
        read.moderation.entities.find((item) => item.semanticRole === 'region-global').regionEvidence = [];
    }],
    ['queue-drift', (read) =>
    {
        read.moderation.entities.find((item) => item.semanticRole === 'rejected').queueMember = false;
    }],
    ['cache-missing', (read) =>
    {
        read.cacheGeneration = null;
    }],
    ['cross-domain-drift', (read) =>
    {
        read.crossDomainAfter.authDigest = digest('changed');
    }],
    ['receipt-substitution', (read) =>
    {
        read.authSourceReceiptDigest = digest('foreign');
    }]
])
{
    test(`C1 HTTP model rejects ${name}; never falls back to prepare observations`, async (t) =>
    {
        const { context, result, read } = model();
        mutate(read);
        context.handles.baseUrl = await gateway(t, () => ({ body: read }));
        assert.equal((await verifyCommentModeration(context, result)).ok, false);
    });
}

test('C1 HTTP model: failed gateway and missing sealed prerequisite cannot pass on original prepare', async (t) =>
{
    const { context, result } = model();
    let requests = 0;
    context.handles.baseUrl = await gateway(t, () =>
    {
        requests++;
        return { status: 503, body: { message: 'unavailable' } };
    });
    assert.equal((await verifyCommentModeration(context, result)).ok, false);
    assert.equal(requests, 1);
    delete context.producerReceipts['public-content'];
    assert.equal((await verifyCommentModeration(context, result)).ok, false);
    assert.equal(requests, 1);
});

for (const [name, producerId, mutate] of [
    ['failed-auth-postcondition', 'auth-session', (receipt) =>
    {
        receipt.postconditionObservations[0].ok = false;
    }],
    ['stale-auth-source', 'auth-session', (receipt) =>
    {
        receipt.source.commit = 'b'.repeat(40);
    }],
    ['unowned-public-article', 'public-content', (receipt) =>
    {
        receipt.observations.database.entities[0].owned = false;
    }],
    ['missing-public-ownership', 'public-content', (receipt) =>
    {
        delete receipt.observations.database.entities[0].owned;
    }]
])
{
    test(`C1 rejects correctly resealed ${name} before invoking gateway`, async (t) =>
    {
        const { context, result } = model();
        const receipt = structuredClone(context.producerReceipts[producerId]);
        mutate(receipt);
        delete receipt.producerReceiptDigest;
        receipt.producerReceiptDigest = digestCanonical(receipt);
        context.producerReceipts[producerId] = receipt;
        let requests = 0;
        context.handles.baseUrl = await gateway(t, () =>
        {
            requests++;
            return { body: {} };
        });
        assert.equal((await verifyCommentModeration(context, result)).ok, false);
        assert.equal(requests, 0);
    });
}

function outletForModel(t, context, signal)
{
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'comment-outlet-model-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const consumerId = 'comment-http-contract-model';
    const outlet = createFixtureArtifactOutlet(path.join(directory, 'artifacts'), {
        plan: { ...context.plan, order: ['comment-moderation'] }, consumerId, signal
    });
    context.handles.fixtureArtifactConsumerId = consumerId;
    context.handles.fixtureArtifactOutlet = outlet;
    return { outlet, directory };
}

test('outlet: actual default comment port retains original read exchange, not prepare or credential headers', async (t) =>
{
    const { context, result, read } = model();
    const { outlet } = outletForModel(t, context);
    read.cacheGeneration = '12';
    read.threadEntities.forEach((item) =>
    {
        item.cacheGeneration = '12';
    });
    read.moderation.entities.forEach((item) =>
    {
        item.cacheGeneration = '12';
    });
    let actualRequest;
    context.handles.baseUrl = await gateway(t, (_, body) =>
    {
        actualRequest = body;
        return { body: read };
    });
    const verified = await createCommentModerationPort().verify(context, result);
    assert.equal(verified.ok, true, verified.reason);
    outlet.recordPort(context, 'verify', verified);
    const refs = outlet.publish('verify');
    const documents = refs.map((ref) => readPrivateJson(ref.path));
    const exchange = documents.find((item) => item.document.exchange).document.exchange;
    assert.deepEqual(exchange.request, actualRequest);
    assert.deepEqual(exchange.response, read);
    assert.notEqual(exchange.response.cacheGeneration, result.cacheGenerationAfter);
    assert.equal(digestCanonical(exchange.response), verified.readObservationDigest);
    assert.equal(documents.every((item, index) => item.contentDigest === refs[index].digest), true);
    assert.doesNotMatch(JSON.stringify(documents), /c1-model-secret|x-fsus-local-comment-fixture-secret|authorization|cookie/iu);
});

for (const mutation of ['duplicate', 'secret', 'prepare-for-read', 'wrong-method'])
{
    test(`outlet: rejects ${mutation} RPC without a verified publication`, async (t) =>
    {
        const { context, result, read } = model();
        const { outlet, directory } = outletForModel(t, context);
        const exchange = { method: 'POST', path: '/api/local/comment-fixture/verify', status: 200,
            request: { schema: 'fsusblog.comment-fixture-verification-request.v1' }, response: read };
        if (mutation === 'secret')
        {
            exchange.response = { ...read, password: 'private-value' };
        }
        if (mutation === 'prepare-for-read')
        {
            exchange.response = result;
        }
        if (mutation === 'wrong-method')
        {
            exchange.method = 'GET';
        }
        context.handles.baseUrl = await gateway(t, () => ({ body: exchange.response }));
        const verified = await createCommentModerationPort().verify(context, result);
        assert.equal(verified.ok, mutation !== 'prepare-for-read', verified.reason);
        if (mutation === 'duplicate' || mutation === 'wrong-method')
        {
            outlet.recordRpc(context, exchange);
        }
        const expected = mutation === 'duplicate' ? /duplicate/ : mutation === 'wrong-method' ? /unowned/ : /credential|unowned/;
        assert.throws(() => outlet.recordPort(context, 'verify', verified), expected);
        assert.throws(() => outlet.publish('verify'), expected);
        assert.deepEqual(fs.readdirSync(path.join(directory, 'artifacts')), []);
    });
}

test('outlet: default comment cleanup returns validated actual RPC proof without synthesizing it', async (t) =>
{
    const { context, result } = model();
    const { outlet } = outletForModel(t, context);
    const ids = Object.keys(result.cleanupReceipt.ownedComments);
    const binding = result.cleanupReceipt.binding;
    const cleanup = { schema: 'fsusblog.comment-fixture-cleanup-result.v1', binding,
        deletedCommentIds: ids, stillPublicCommentIds: [], exact: true,
        crossDomainBefore: result.crossDomainBefore, crossDomainAfter: result.crossDomainBefore,
        moderationObservation: { schema: 'fsusblog.comment-moderation-cleanup-observation.v1', binding,
            commentIds: ids, queueAbsentCommentIds: ids, publicHiddenCommentIds: ids, softDeletedCommentIds: ids,
            observationDigest: digest('actual-model-cleanup-observation') } };
    context.handles.baseUrl = await gateway(t, (request, body) =>
    {
        assert.equal(request.url, '/api/local/comment-fixture/cleanup');
        assert.deepEqual(body, result.cleanupReceipt);
        return { body: cleanup };
    });
    const actual = await createCommentModerationPort().cleanup(context, result);
    assert.deepEqual(actual, cleanup);
    outlet.recordPort(context, 'cleanup', actual);
    const refs = outlet.publish('cleanup');
    assert.equal(refs.length, 2);
    assert.deepEqual(readPrivateJson(refs.find((item) => item.role.endsWith('port-result')).path).document.result, cleanup);
});

test('outlet: real default comment verify cancels HTTP with original signal and publishes no artifacts', async (t) =>
{
    const { context, result, read } = model();
    const controller = new AbortController();
    const reason = new Error('comment-original-outlet-abort');
    const { outlet, directory } = outletForModel(t, context, controller.signal);
    context.handles.baseUrl = await gateway(t, () =>
    {
        controller.abort(reason);
        return { body: read };
    });
    await assert.rejects(createCommentModerationPort().verify(context, result, controller.signal), (error) => error === reason);
    assert.throws(() => outlet.publish('verify'), (error) => error === reason);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'artifacts')), []);
});
