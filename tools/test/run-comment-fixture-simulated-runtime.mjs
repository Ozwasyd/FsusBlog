#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestCommentFixtureValue } from './comment-fixture-contract.mjs';
import {
    buildCanonicalCommentFixtureRuntimeEvidence,
    buildCommentFixtureCleanupReceipt
} from './comment-fixture-governance.mjs';
const {cleanupCommentModeration, prepareCommentModeration, verifyCommentModeration} = await import(new URL('../test-fixtures/producers/comment-moderation-producer.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
        producerResultDigest,
        verified: false
    };
    return Object.freeze({ ...body, digest: hex(JSON.stringify(body)) });
}

function contextFor(index, baseUrl)
{
    const runId = `comment-sim-run-${index}`;
    const namespace = `comment-sim-${index}`;
    const producerResultDigest = hex(`auth:${runId}`);
    const refs = [
        identityReference({ runId, namespace, role: 'admin', capabilityId: 'auth.admin.full-permission', publicId: 7, producerResultDigest }),
        identityReference({ runId, namespace, role: 'primary-author', capabilityId: 'auth.user.active', publicId: 11, producerResultDigest }),
        identityReference({ runId, namespace, role: 'secondary-author', capabilityId: 'auth.user.active', publicId: 12, producerResultDigest })
    ];
    const capabilities = ['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix'];
    const variants = capabilities.map((capabilityId) => ({
        id: `comment-simulated-${capabilityId.replaceAll('.', '-')}`,
        capabilityId
    }));
    return {
        namespace,
        runIdentity: runId,
        profileIdentity: { profileId: 'comments-moderation' },
        plan: {
            capabilities,
            expandedCapabilityDigest: `sha256:${hex('expanded-capabilities')}`,
            variantPlanDigest: `sha256:${hex('variant-plan')}`
        },
        variantPlan: {
            variants,
            producerVariantPlanDigest: `sha256:${hex('producer-variant-plan')}`
        },
        temporalContext: {
            schema: 'fsusblog.test-temporal-context.v1',
            authorityClass: 'local-simulated',
            instantUtc: '2042-05-17T09:30:00.000Z'
        },
        producerOutputs: {
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
        },
        handles: {
            baseUrl,
            localCommentFixtureSecret: 'simulated-comment-secret',
            localPublicContentFixtureSecret: 'simulated-temporal-secret'
        }
    };
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

async function startBackend()
{
    const requests = [];
    const sessions = new Map();
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
                sessions.set(plan.testSession, plan.runId);
                requests.push({ runId: plan.runId, method: 'POST', path: request.url, status: 200 });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(result));
                return;
            }
            if (request.method === 'GET' && request.url === '/__local/temporal-observation')
            {
                const runId = sessions.get(String(request.headers['x-fsus-test-session'] ?? ''));
                if (!runId)
                {
                    throw new Error('simulated temporal observation is cross-run');
                }
                requests.push({ runId, method: 'GET', path: request.url, status: 200 });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
                    schema: 'fsusblog.comment-fixture-simulated-temporal-observation.v1',
                    runId,
                    authorityClass: 'local-simulated'
                }));
                return;
            }
            if (request.method === 'POST' && request.url === '/api/local/comment-fixture/cleanup')
            {
                requireInvocationHeaders(request);
                const receipt = await readJson(request);
                const ids = Object.keys(receipt.ownedComments).map(Number);
                requests.push({ runId: receipt.binding.runId, method: 'POST', path: request.url, status: 200 });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
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
                }));
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

export async function collectSimulatedCommentFixtureRuntimeEvidence()
{
    const backend = await startBackend();
    try
    {
        const contexts = [contextFor(1, backend.baseUrl), contextFor(2, backend.baseUrl)];
        const completed = await Promise.all(contexts.map(async (context) =>
        {
            const result = await prepareCommentModeration(context);
            const verified = await verifyCommentModeration(context, result);
            if (verified?.ok !== true)
            {
                throw new Error(`simulated comment producer verification failed: ${verified?.reason ?? 'unknown'}`);
            }
            const cleanup = await cleanupCommentModeration(context, result);
            return { result, cleanup };
        }));
        const source = buildCommentFixtureCleanupReceipt().source;
        const cleanups = completed.map((item) => item.cleanup);
        const runs = completed.map((item, index) =>
        {
            const unsignedRun = { ...item.result };
            const requests = expectedTransport(backend.requests, item.result.cleanupReceipt.binding.runId);
            const expected = [
                { method: 'POST', path: '/api/local/comment-fixture/prepare', status: 200 },
                { method: 'GET', path: '/__local/temporal-observation', status: 200 },
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
                cleanupResultDigest: digestCommentFixtureValue(item.cleanup)
            };
            return { ...unsignedRun, producerInvocation };
        });
        const invocations = runs.map((item) => item.producerInvocation);
        return {
            schema: 'fsusblog.comment-fixture-runtime-evidence.v2',
            authorityClass: 'local-simulated-producer-invocation',
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
        process.argv[2] ?? '.tmp/test-evidence/comment-fixture-runtime.json');
    const evidence = await collectSimulatedCommentFixtureRuntimeEvidence();
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${JSON.stringify(evidence, null, 4)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
        status: 'recorded',
        authorityClass: evidence.authorityClass,
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
