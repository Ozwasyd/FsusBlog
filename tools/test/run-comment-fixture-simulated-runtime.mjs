#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestCommentFixtureValue } from './comment-fixture-contract.mjs';
import {
    buildCanonicalCommentFixtureRuntimeEvidence,
    buildCommentFixtureModelReport,
    resolveCommentFixtureSourceIdentity
} from './comment-fixture-governance.mjs';
import { defaultTimeoutPolicyDigest, qualificationTemporalContext } from './temporal-context.mjs';
const { createProducerContext } = await import(new URL('../test-fixtures/producer-port.mjs', import.meta.url));
const { buildProducerReceipt, canonicalJson, digestCanonical, validateProducerReceipt } = await import(new URL('../test-fixtures/receipt/index.mjs', import.meta.url));
const { buildFixtureVariantPlan, buildProducerFixtureVariantPlan, fixtureCatalogDigest, readFixtureCatalogs } = await import(new URL('../testing/fixture-catalog.mjs', import.meta.url));
const {cleanupCommentModeration, prepareCommentModeration, verifyCommentModeration} = await import(new URL('../test-fixtures/producers/comment-moderation-producer.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Server-owned model state, never an observation copied from a caller's plan.
// The 2042 fixture epoch remains a model value, not production clock evidence.
const modelTemporalRuntime = Object.freeze({
    businessEpochUtc: '2042-05-17T09:30:00.000Z',
    backendCulture: 'Invariant',
    postgresTimezone: 'UTC'
});

function hex(value)
{
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function identityReference({ runId, namespace, role, capabilityId, publicId, producerResultDigest })
{
    const body = {
        schema: 'fsusblog.fixture-identity-prepare-reference.v1',
        ownerProducerId: 'auth-session',
        consumerProducerId: 'comment-moderation',
        runId,
        namespace,
        profileId: 'comments-moderation',
        capabilityId,
        role,
        publicId: String(publicId),
        semanticRole: `consumer.comment-moderation.${role}`,
        fixtureIdentity: `model:${namespace}:${role}`,
        planDigests: {},
        producerResultDigest,
        verified: false
    };
    return Object.freeze({ ...body, digest: hex(JSON.stringify(body)) });
}

function contextFor(index, baseUrl, source)
{
    // Sealed shape/identity contract model only: no real auth or public allocation.
    const catalogs = readFixtureCatalogs();
    const runId = `comment-sim-run-${index}`;
    const namespace = `comment-sim-${index}`;
    const producerResultDigest = hex(`auth:${runId}`);
    const refs = [
        identityReference({ runId, namespace, role: 'admin', capabilityId: 'auth.admin.full-permission', publicId: 7, producerResultDigest }),
        identityReference({ runId, namespace, role: 'primary-author', capabilityId: 'auth.user.active', publicId: 11, producerResultDigest }),
        identityReference({ runId, namespace, role: 'secondary-author', capabilityId: 'auth.user.active', publicId: 12, producerResultDigest })
    ];
    const capabilities = ['auth.admin.full-permission', 'auth.user.active', 'comment.moderation-matrix',
        'comment.threaded', 'moderation.policy-matrix', 'public.article.published'];
    const variantIds = capabilities.map((capabilityId) => catalogs.variant.variants.find(
        (item) => item.capabilityId === capabilityId && item.id.startsWith('canonical.')
    ).id).sort();
    const variantPlan = buildFixtureVariantPlan(variantIds, catalogs);
    const plan = {
        capabilities, variantIds, variantPlan, variantPlanDigest: variantPlan.variantPlanDigest,
        expandedCapabilityDigest: digestCanonical(capabilities),
        profileIdentity: { profileId: 'comments-moderation' },
        executionIdentity: { runId, namespace, sourceIdentity: source,
            handles: { serviceGeneration: `sha256:${hex(`model-generation:${runId}`)}` } }
    };
    const producerOutputs = {
        'auth-session': {
            producerId: 'auth-session',
            producerResultDigest,
            identityPrepareReferences: refs
        },
        'public-content': {
            producerId: 'public-content',
            strategy: 'transaction-fixture',
            structuralOnly: false,
            fallback: false,
            projection: { articleId: 42, slug: `comment-simulated-${index}` },
            entityIdentities: [{ kind: 'article', id: '42' }],
            observations: { database: {}, redis: {}, cache: {} },
            temporalArtifacts: { bindingDigest: `sha256:${hex(`article:${runId}`)}` }
        }
    };
    const sealModelReceipt = (producerId, entities, providedCapabilities) =>
    {
        const slice = buildProducerFixtureVariantPlan({ producerId,
            variantIds: variantIds.filter((id) => catalogs.variant.variants.find((item) => item.id === id).ownerProducerId === producerId),
            fixtureVariantIds: variantIds, fixtureVariantPlanDigest: variantPlan.variantPlanDigest, catalogs });
        const rows = entities.map(({ capabilityId, ...item }) => ({ ...item, owned: true,
            variantId: slice.variants.find((variant) => variant.capabilityId === capabilityId).id, fields: {} }));
        return buildProducerReceipt({ producerId, strategy: 'transaction-fixture', runId, namespace, source,
            profileId: plan.profileIdentity.profileId, fixtureCatalogDigest: fixtureCatalogDigest(catalogs),
            expandedCapabilityDigest: plan.expandedCapabilityDigest, fixtureVariantIds: variantIds,
            variantPlanDigest: plan.variantPlanDigest, producerVariantPlanDigest: slice.producerVariantPlanDigest,
            producedVariantIds: slice.variants.map((item) => item.id), providedCapabilities,
            serviceGeneration: plan.executionIdentity.handles.serviceGeneration,
            ownedStateDomains: catalogs.producer.producers.find((item) => item.id === producerId).stateDomains,
            entityIdentities: rows.map(({ kind, id, variantId }) => ({ kind, id, variantId })),
            databaseObservation: { namespace, schemaIdentity: 'model-only', entities: rows },
            postconditionObservations: providedCapabilities.flatMap((capabilityId) => catalogs.capability.capabilities.find(
                (item) => item.id === capabilityId
            ).postconditionIds.map((postconditionId) => ({ capabilityId, postconditionId, ok: true }))), catalogs });
    };
    return createProducerContext({ plan, producerId: 'comment-moderation', producerOutputs, catalogs,
        temporalContext: qualificationTemporalContext({
            sourceCommit: source.commit,
            sourceFingerprint: source.worktreeFingerprint,
            producerId: 'comment-moderation',
            schedulerRunId: runId,
            businessEpochUtc: modelTemporalRuntime.businessEpochUtc,
            locale: 'en-US',
            uiLocale: 'en-US',
            timeoutPolicyDigest: defaultTimeoutPolicyDigest()
        }),
        producerReceipts: {
            'auth-session': sealModelReceipt('auth-session', refs.map((item) => ({ kind: item.role === 'admin' ? 'admin' : 'user',
                id: item.publicId, semanticRole: item.semanticRole, fixtureIdentity: item.fixtureIdentity,
                capabilityId: item.capabilityId })), ['auth.admin.full-permission', 'auth.user.active']),
            'public-content': sealModelReceipt('public-content', [{ kind: 'article', id: '42', capabilityId: 'public.article.published' }], ['public.article.published'])
        }, handles: {
            ...plan.executionIdentity.handles,
            baseUrl,
            localCommentFixtureSecret: 'simulated-comment-secret',
            localPublicContentFixtureSecret: 'simulated-temporal-secret'
        } });
}

function bindingFor(plan)
{
    return {
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
}

function rawResult(plan, index)
{
    const canonical = buildCanonicalCommentFixtureRuntimeEvidence().runs[index - 1];
    const binding = bindingFor(plan);
    const crossDomain = {
        ...canonical.crossDomainBefore,
        accountIds: [
            plan.identityReferences.primaryAccountId,
            plan.identityReferences.secondaryAccountId
        ].sort((left, right) => left - right),
        adminPrincipalId: plan.identityReferences.adminPrincipalId
    };
    const zkAuthorityEvidence = ['pending', 'region-manual-review'].map((semanticRole) => ({
        schema: 'fsusblog.comment-fixture-zk-authority-evidence.v1',
        semanticRole,
        authorityClass: 'local-dev-simulation',
        backend: 'local_dev_fixture',
        simulation: true,
        productionUsable: false,
        ticketStoredInProductionOneTimeStore: true,
        ticketExposed: false,
        operationPlanDigest: hex(`${plan.runId}:${semanticRole}:operation`),
        publicInputsDigest: hex(`${plan.runId}:${semanticRole}:public-inputs`),
        rootDigest: hex(`${plan.runId}:${semanticRole}:root`)
    }));
    const cleanupReceipt = {
        schema: 'fsusblog.comment-thread-fixture-cleanup.v1',
        binding,
        ownedComments: canonical.cleanupReceipt.ownedComments,
        crossDomainBefore: crossDomain
    };
    return {
        ...canonical,
        producerId: 'comment-moderation',
        strategy: 'transaction-fixture',
        planDigest: plan.planDigest,
        inventoryDigest: plan.inventoryDigest,
        capabilityCatalogDigest: plan.capabilityCatalogDigest,
        variantCatalogDigest: plan.variantCatalogDigest,
        temporalContextDigest: plan.temporalContextDigest,
        producerPlanDigest: plan.producerPlanDigest,
        zkAuthorityEvidence,
        moderation: { ...canonical.moderation, binding },
        runtimeLease: { ...canonical.runtimeLease, binding, owner: binding.owner },
        runtimeRestore: { ...canonical.runtimeRestore, binding, owner: binding.owner },
        crossDomainBefore: crossDomain,
        crossDomainAfterPrepare: structuredClone(crossDomain),
        cleanupReceipt
    };
}

async function readJson(request)
{
    const chunks = [];
    for await (const chunk of request)
    {
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function requireInvocationHeaders(request)
{
    if (!request.headers['x-fsus-test-namespace']
        || !request.headers['x-fsus-test-run-id']
        || !request.headers['x-fsus-test-session'])
    {
        throw new Error('simulated fixture transport is missing current-run headers');
    }
}

async function startBackend({ mutateRead } = {})
{
    const requests = [];
    const sessions = new Map();
    const reads = new Map();
    const server = createServer(async (request, response) =>
    {
        try
        {
            if (request.method === 'POST' && request.url === '/api/local/comment-fixture/prepare')
            {
                requireInvocationHeaders(request);
                const plan = await readJson(request);
                const index = plan.runId.endsWith('-1') ? 1 : plan.runId.endsWith('-2') ? 2 : 0;
                if (index === 0)
                {
                    throw new Error('simulated prepare run is unknown');
                }
                const result = rawResult(plan, index);
                // A subsequent MODEL state is distinct from the prepare response. Verify only reads it.
                // This is not a production mutation, cache freshness proof, or persistence claim.
                const current = structuredClone(result);
                current.cacheGenerationAfter = String(BigInt(current.cacheGenerationAfter) + 1n);
                for (const entity of [...current.threadEntities, ...current.moderation.entities])
                {
                    entity.cacheGeneration = current.cacheGenerationAfter;
                }
                sessions.set(plan.testSession, { plan, result, current });
                requests.push({ runId: plan.runId, method: 'POST', path: request.url, status: 200 });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(result));
                return;
            }
            if (request.method === 'GET' && request.url === '/__local/temporal-observation')
            {
                const session = sessions.get(String(request.headers['x-fsus-test-session'] ?? ''));
                if (!session)
                {
                    throw new Error('simulated temporal observation is cross-run');
                }
                const runId = session.plan.runId;
                requests.push({ runId, method: 'GET', path: request.url, status: 200 });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
                    schema: 'fsusblog.comment-fixture-simulated-temporal-observation.v1',
                    runId,
                    authorityClass: 'local-simulated',
                    ...modelTemporalRuntime
                }));
                return;
            }
            if (request.method === 'POST' && request.url === '/api/local/comment-fixture/verify')
            {
                requireInvocationHeaders(request);
                const body = await readJson(request);
                const session = sessions.get(String(request.headers['x-fsus-test-session']));
                if (!session || canonicalJson(body.plan) !== canonicalJson(session.plan)
                    || canonicalJson(body.cleanupReceipt) !== canonicalJson(session.result.cleanupReceipt))
                {
                    throw new Error('model verify prepared session/ownership differs');
                }
                for (const [reference, producerId] of [[body.authReference, 'auth-session'], [body.publicReference, 'public-content']])
                {
                    const sealed = validateProducerReceipt(reference?.receipt);
                    const unsigned = Object.fromEntries(Object.entries(sealed).filter(([key]) => key !== 'producerReceiptDigest'));
                    if (sealed.producerId !== producerId || sealed.runId !== session.plan.runId
                        || sealed.namespace !== session.plan.namespace || reference.canonicalBody !== canonicalJson(unsigned))
                    {
                        throw new Error('model verify sealed prerequisite differs');
                    }
                }
                // A separate model read, sent through the actual HTTP verify export. It is NOT production data.
                const current = structuredClone(session.current);
                const read = { schema: 'fsusblog.comment-fixture-verification-result.v1', binding: bindingFor(session.plan),
                    threadEntities: current.threadEntities, moderation: current.moderation, cacheGeneration: current.cacheGenerationAfter,
                    crossDomainBefore: current.crossDomainBefore, crossDomainAfter: current.crossDomainAfterPrepare,
                    authSourceReceiptDigest: body.authReference.receipt.producerReceiptDigest,
                    publicSourceReceiptDigest: body.publicReference.receipt.producerReceiptDigest };
                if (mutateRead)
                {
                    mutateRead(read);
                }
                reads.set(session.plan.runId, { request: body, response: structuredClone(read) });
                requests.push({ runId: session.plan.runId, method: 'POST', path: request.url, status: 200 });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(read));
                return;
            }
            if (request.method === 'POST' && request.url === '/api/local/comment-fixture/cleanup')
            {
                requireInvocationHeaders(request);
                const receipt = await readJson(request);
                const ids = Object.keys(receipt.ownedComments).map(Number);
                requests.push({ runId: receipt.binding.runId, method: 'POST', path: request.url, status: 200 });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                const cleanup = {
                    schema: 'fsusblog.comment-fixture-cleanup-result.v1',
                    binding: receipt.binding,
                    deletedCommentIds: ids,
                    stillPublicCommentIds: [],
                    exact: true,
                    crossDomainBefore: receipt.crossDomainBefore,
                    crossDomainAfter: receipt.crossDomainBefore,
                    moderationObservation: {
                        schema: 'fsusblog.comment-moderation-cleanup-observation.v1',
                        binding: receipt.binding,
                        commentIds: ids,
                        queueAbsentCommentIds: ids,
                        publicHiddenCommentIds: ids,
                        softDeletedCommentIds: ids,
                        observationDigest: `sha256:${hex(`${receipt.binding.runId}:moderation-cleanup`)}`
                    }
                };
                reads.set(`${receipt.binding.runId}:cleanup`, structuredClone(cleanup));
                response.end(JSON.stringify(cleanup));
                return;
            }
            response.writeHead(404);
            response.end();
        }
        catch (error)
        {
            response.writeHead(500, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ message: error.message }));
        }
    });
    await new Promise((resolve, reject) =>
    {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        reads,
        close: () => new Promise((resolve, reject) =>
            server.close((error) => error ? reject(error) : resolve()))
    };
}

function expectedTransport(requests, runId)
{
    return requests.filter((item) => item.runId === runId).map(({ method, path: requestPath, status }) => ({
        method,
        path: requestPath,
        status
    }));
}

export async function collectSimulatedCommentFixtureRuntimeEvidence(options = {})
{
    const source = resolveCommentFixtureSourceIdentity();
    const backend = await startBackend(options);
    try
    {
        const contexts = [contextFor(1, backend.baseUrl, source), contextFor(2, backend.baseUrl, source)];
        const completed = await Promise.all(contexts.map(async (context) =>
        {
            const result = await prepareCommentModeration(context);
            try
            {
                const verified = await verifyCommentModeration(context, result);
                if (verified?.ok !== true)
                {
                    throw new Error(`simulated comment producer verification failed: ${verified?.reason ?? 'unknown'}`);
                }
                const exchange = backend.reads.get(context.runIdentity);
                if (!exchange || verified.readObservationDigest !== digestCanonical(exchange.response))
                {
                    throw new Error('model verify raw response/read digest differs');
                }
                return { result, verified, exchange };
            }
            finally
            {
                await cleanupCommentModeration(context, result);
            }
        }));
        // Cleanup response bytes are captured by the model transport below, not fabricated from prepare.
        const cleanups = completed.map((item) => backend.reads.get(`${item.result.cleanupReceipt.binding.runId}:cleanup`));
        const runs = completed.map((item, index) =>
        {
            const read = item.exchange.response;
            const unsignedRun = { ...item.result, preparedResult: item.result,
                threadEntities: read.threadEntities, moderation: read.moderation, cacheGenerationAfter: read.cacheGeneration,
                crossDomainAfterPrepare: read.crossDomainAfter, observations: item.verified.observations,
                entityIdentities: item.verified.entityIdentities,
                verification: { ...item.verified, ...item.exchange } };
            const requests = expectedTransport(backend.requests, item.result.cleanupReceipt.binding.runId);
            const expected = [
                { method: 'POST', path: '/api/local/comment-fixture/prepare', status: 200 },
                { method: 'GET', path: '/__local/temporal-observation', status: 200 },
                { method: 'POST', path: '/api/local/comment-fixture/verify', status: 200 },
                { method: 'POST', path: '/api/local/comment-fixture/cleanup', status: 200 }
            ];
            if (JSON.stringify(requests) !== JSON.stringify(expected))
            {
                throw new Error(`simulated comment producer run ${index + 1} did not execute the exact transport sequence`);
            }
            const producerInvocation = {
                schema: 'fsusblog.comment-fixture-producer-invocation.v1',
                ordinal: index + 1,
                producerId: 'comment-moderation',
                implementation: 'tools/test-fixtures/producers/comment-moderation-producer.mjs',
                prepareExport: 'prepareCommentModeration',
                verifyExport: 'verifyCommentModeration',
                cleanupExport: 'cleanupCommentModeration',
                transport: 'loopback-http',
                runId: item.result.cleanupReceipt.binding.runId,
                namespace: item.result.cleanupReceipt.binding.namespace,
                requests,
                producerResultDigest: digestCommentFixtureValue(unsignedRun),
                cleanupResultDigest: digestCommentFixtureValue(cleanups[index]),
                readObservationDigest: item.verified.readObservationDigest,
                authSourceReceiptDigest: item.verified.authSourceReceiptDigest,
                publicSourceReceiptDigest: item.verified.publicSourceReceiptDigest
            };
            return { ...unsignedRun, producerInvocation };
        });
        const invocations = runs.map((item) => item.producerInvocation);
        return {
            schema: 'fsusblog.comment-fixture-runtime-evidence.v2',
            authorityClass: 'local-simulated-producer-invocation',
            scope: 'model-contract-only',
            runtimeQualified: false,
            source,
            runs,
            cleanups,
            invocationSetDigest: digestCommentFixtureValue(invocations)
        };
    }
    finally
    {
        await backend.close();
    }
}

async function main()
{
    const output = path.resolve(
        process.cwd(),
        process.argv[2] ?? '.tmp/test-evidence/comment-fixture-model.json');
    const evidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    const report = buildCommentFixtureModelReport(evidence);
    if (report.status !== 'accepted')
    {
        throw new Error(`model contract rejected: ${JSON.stringify(report.violations)}`);
    }
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${JSON.stringify({ ...evidence, modelContract: report }, null, 4)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
        status: 'recorded',
        authorityClass: evidence.authorityClass,
        scope: evidence.scope,
        runtimeQualified: false,
        runs: evidence.runs.length,
        cleanups: evidence.cleanups.length,
        output: path.relative(root, output),
        invocationSetDigest: evidence.invocationSetDigest
    })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        process.stderr.write(`${error.stack ?? error.message ?? error}\n`);
        process.exitCode = 1;
    });
}
