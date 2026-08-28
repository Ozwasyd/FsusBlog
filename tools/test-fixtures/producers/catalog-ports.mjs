/**
 * Default producer ports bound to catalog strategies and implementation paths.
 * Business data logic stays in existing modules; ports only invoke them.
 * Strategy is sealed from the producer registry — never from process.env.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const { readFixtureCatalogs } = await import(new URL("../../testing/fixture-catalog.mjs", import.meta.url));

import {
    buildProducerChildEnv,
    repositoryRoot,
    runProcess,
    runTemporalProcess
} from './spawn-helper.mjs';

function catalogProducer(id, catalogs = readFixtureCatalogs())
{
    const producer = (catalogs.producer.producers ?? []).find((item) => item.id === id);
    if (!producer)
    {
        throw new Error(`catalog producer ${id} is missing`);
    }
    return producer;
}

function basePort(producer, handlers)
{
    return {
        id: producer.id,
        strategy: producer.strategy,
        providedCapabilities: [...producer.provides],
        consumedCapabilities: [...producer.consumes],
        identityRoleRequests: handlers.identityRoleRequests ?? [],
        prepare: async (context, signal) =>
        {
            const result = await handlers.prepare(context, signal);
            if (result?.enforceVariantEvidence === true)
            {
                const entities = result?.entityIdentities;
                const observed = result?.observations?.database?.entities ?? result?.databaseObservation?.entities;
                if (!Array.isArray(entities) || !Array.isArray(observed))
                {
                    throw new Error(`producer ${producer.id} opted into typed variant evidence but did not return entity identity and database observation arrays`);
                }
            }
            return result;
        },
        // Default verify fails closed without service observations (#1710).
        verify: handlers.verify ?? (async (_context, producerResult) =>
        {
            if (producerResult?.observations || producerResult?.databaseObservation
        || producerResult?.redisObservation || producerResult?.cacheObservation)
            {
                return { ok: true, producerId: producer.id };
            }
            return {
                ok: false,
                producerId: producer.id,
                reason: 'producer verify missing database/redis/cache observations'
            };
        }),
        cleanup: handlers.cleanup ?? (async () => undefined)
    };
}

function assertNoStrategyEnv()
{
    const banned = [
        'FSUSBLOG_FIXTURE_PRODUCER_STRATEGY',
        'FSUSBLOG_PUBLIC_FIXTURE_STRATEGY',
        'FSUSBLOG_FORCE_DIRECT_DB_SEED',
        'FSUSBLOG_FIXTURE_STRATEGY'
    ];
    for (const key of banned)
    {
        if (process.env[key])
        {
            throw new Error(`producer strategy/env override ${key} is forbidden`);
        }
    }
}

function variantIdsFromTypedPlan(context, producerId)
{
    if (context?.variantPlan?.schema !== 'fsusblog.fixture-producer-variant-plan.v1'
    || context.variantPlan.producerId !== producerId)
    {
        throw new Error(`producer ${producerId} requires its sealed typed variant plan`);
    }
    return Object.freeze(context.variantPlan.variants.map((item) => item.id).sort());
}

function variantOutputFromTypedPlan(context, producerId)
{
    return {
        variantIds: variantIdsFromTypedPlan(context, producerId),
        producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest
    };
}

async function observeBackendTemporalContext(context, signal)
{
    const baseUrl = context.handles?.debugBackendUrl
    ?? context.handles?.baseUrl
    ?? process.env.FSUSBLOG_DEBUG_BACKEND_URL
    ?? process.env.FSUSBLOG_BASE_URL
    ?? '';
    const secret = context.handles?.localPublicContentFixtureSecret
    ?? context.handles?.localAuthFixtureSecret
    ?? context.handles?.localDemoFixtureSecret
    ?? process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET
    ?? process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
    ?? process.env.FSUSBLOG_LOCAL_DEMO_FIXTURE_SECRET
    ?? '';
    if (!baseUrl || !secret)
    {
        throw new Error(
            'backend temporal observation requires the actual backend URL and local fixture secret'
        );
    }
    const response = await fetch(`${baseUrl}/__local/temporal-observation`, {
        headers: {
            'X-Fsus-Local-Temporal-Fixture-Secret': secret
        },
        signal
    });
    const text = await response.text();
    if (!response.ok)
    {
        throw new Error(
            `backend temporal observation failed HTTP ${response.status}: ${text.slice(0, 400)}`
        );
    }
    try
    {
        return JSON.parse(text);
    }
    catch
    {
        throw new Error('backend temporal observation returned invalid JSON');
    }
}

export function createAuthSessionPort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('auth-session', catalogs);
    return basePort(producer, {
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            const { prepareAuthSession } = await import('./auth-session-producer.mjs');
            const result = await prepareAuthSession(context, signal);
            return {
                ...result,
                ...variantOutputFromTypedPlan(context, producer.id),
                postconditions: [...producer.receiptPostconditions]
            };
        },
        async verify(context, producerResult)
        {
            const { verifyAuthSession } = await import('./auth-session-producer.mjs');
            return verifyAuthSession(context, producerResult);
        },
        async cleanup(context, receipt, signal)
        {
            const { cleanupAuthSession } = await import('./auth-session-producer.mjs');
            await cleanupAuthSession(context, receipt, signal);
        }
    });
}

export function createPublicContentPort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('public-content', catalogs);
    return basePort(producer, {
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            // transaction-fixture only (#1712): domain-port composition root, no API/DB fallback.
            const {
                preparePublicContent
            } = await import('./public-content-producer.mjs');
            const result = await preparePublicContent(context, signal);
            const backendObservation = context.temporalContext
                ? await observeBackendTemporalContext(context, signal)
                : null;
            return {
                ...result,
                producerId: producer.id,
                strategy: producer.strategy,
                postconditions: [...producer.receiptPostconditions],
                ...(backendObservation
                    ? {
                        temporalObservation: {
                            ...backendObservation,
                            observationBoundary: 'server-owned-public-content-backend-and-postgres-session'
                        }
                    }
                    : {})
            };
        },
        async verify(context, producerReceipt)
        {
            const {
                verifyPublicContent
            } = await import('./public-content-producer.mjs');
            return verifyPublicContent(context, producerReceipt);
        },
        async cleanup(context, receipt, signal)
        {
            const {
                cleanupPublicContent
            } = await import('./public-content-producer.mjs');
            await cleanupPublicContent(context, receipt, signal);
        }
    });
}

export function createDevelopmentDemoPort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('development-demo', catalogs);
    return basePort(producer, {
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            const { prepareDemoPublic } = await import('./demo-public-producer.mjs');
            const result = await prepareDemoPublic(context, signal);
            const backendObservation = context.temporalContext
                ? await observeBackendTemporalContext(context, signal)
                : null;
            return {
                ...result,
                producerId: producer.id,
                strategy: producer.strategy,
                ...variantOutputFromTypedPlan(context, producer.id),
                postconditions: [...producer.receiptPostconditions],
                ...(backendObservation
                    ? {
              temporalObservation: {
                ...backendObservation,
                observationBoundary: 'server-owned-demo-backend-and-postgres-session'
              }
            }
                    : {})
            };
        },
        async verify(context, producerResult)
        {
            const { verifyDemoPublic } = await import('./demo-public-producer.mjs');
            return verifyDemoPublic(context, producerResult);
        },
        async cleanup(context, receipt, signal)
        {
            const { cleanupDemoPublic } = await import('./demo-public-producer.mjs');
            await cleanupDemoPublic(context, receipt, signal);
        }
    });
}

export function createScaleDataPort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('scale-data', catalogs);
    const script = path.join(repositoryRoot, 'tools/data-scale/seed.sh');
    const cleanupScript = path.join(repositoryRoot, 'tools/data-scale/cleanup.sh');
    return basePort(producer, {
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            const tier = context.handles?.scaleTier
        ?? context.plan?.profileIdentity?.profileId
        ?? 'scale-xs';
            const execution = context.temporalContext
                ? await runTemporalProcess('bash', [script, tier], {
            env: buildProducerChildEnv(context),
            signal
          })
                : await runProcess('bash', [script, tier], {
            env: buildProducerChildEnv(context),
            signal
          });
            const outputRoot = process.env.FSUSBLOG_DATA_SCALE_OUT_DIR
        ?? path.join(
            process.env.FSUSBLOG_DATA_SCALE_ROOT ?? path.join(repositoryRoot, '.tmp/scale'),
            tier
        );
            const seedSummary = JSON.parse(readFileSync(path.join(outputRoot, 'seed.json'), 'utf8'));
            const seedOutcome = { ...seedSummary };
            delete seedOutcome.generatedAt;
            delete seedOutcome.durationMs;
            return {
                producerId: producer.id,
                strategy: producer.strategy,
                implementation: 'tools/data-scale/seed.sh',
                scaleTier: tier,
                ...variantOutputFromTypedPlan(context, producer.id),
                seedOutcome,
                postconditions: [...producer.receiptPostconditions],
                ...(execution.temporalObservation
                    ? {
              temporalObservation: {
                ...execution.temporalObservation,
                businessEpochUtc: seedSummary.temporal?.businessEpochUtc,
                postgresTimezone: seedSummary.temporal?.postgresTimezone,
                observationBoundary: 'producer-child-and-postgres-session'
              }
            }
                    : {})
            };
        },
        async cleanup(context, receipt, signal)
        {
            const tier = receipt?.scaleTier
        ?? context.handles?.scaleTier
        ?? context.plan?.profileIdentity?.profileId
        ?? 'scale-xs';
            await runProcess('bash', [cleanupScript, tier], {
                env: buildProducerChildEnv(context),
                signal
            });
        }
    });
}

export function createSecurityStatePort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('security-state', catalogs);
    return basePort(producer, {
        identityRoleRequests: [
            {
                ownerProducerId: 'auth-session',
                consumerProducerId: 'security-state',
                role: 'primary',
                capabilityId: 'auth.user.active'
            },
            {
                ownerProducerId: 'auth-session',
                consumerProducerId: 'security-state',
                role: 'subject.banned',
                capabilityId: 'auth.user.active'
            },
            {
                ownerProducerId: 'auth-session',
                consumerProducerId: 'security-state',
                role: 'subject.unbanned',
                capabilityId: 'auth.user.active'
            }
        ],
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            requireConsumedProducerOutputs(producer, context);
            const { prepareSecurityFixtures } = await import('./security-fixture-producer.mjs');
            return prepareSecurityFixtures(context, signal);
        },
        async verify(context, producerResult)
        {
            const { verifySecurityFixtures } = await import('./security-fixture-producer.mjs');
            return verifySecurityFixtures(context, producerResult);
        },
        async cleanup(context, producerResult, signal)
        {
            const { cleanupSecurityFixtures } = await import('./security-fixture-producer.mjs');
            await cleanupSecurityFixtures(context, producerResult, signal);
        }
    });
}

function requireConsumedProducerOutputs(producer, context)
{
    for (const capabilityId of producer.consumes ?? [])
    {
        const owner = context.plan?.producerSpecs?.find((item) => item.provides?.includes(capabilityId))?.id
      ?? Object.keys(context.producerOutputs ?? {}).find((id) =>
      {
          const output = context.producerOutputs[id];
          return Array.isArray(output?.postconditions) || output?.producerId === id;
      });
        // Prefer catalog owner from plan producerSpecs.
        const ownerFromPlan = (context.plan?.producerSpecs ?? []).find((item) => (item.provides ?? []).includes(capabilityId))?.id;
        const resolvedOwner = ownerFromPlan ?? owner;
        if (!resolvedOwner || !context.producerOutputs?.[resolvedOwner])
        {
            throw new Error(
                `producer ${producer.id} requires consumed capability ${capabilityId} from ${resolvedOwner ?? '<missing owner>'} before prepare`
            );
        }
    }
}

/**
 * Structural port for producers whose business seed is owned by later issues / consumer tests.
 * Still runs through the unique orchestrator (no dual lifecycle), seals catalog strategy,
 * and enforces consume ordering — but does not invent SQL/API business rows (#1709 scope).
 * Callers may inject a real adapter via handles.<id>Adapter to replace the structural path.
 */
function createStructuralBusinessPort(producer, adapterHandleName)
{
    return basePort(producer, {
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            const adapter = context.handles?.[adapterHandleName];
            if (adapter && typeof adapter.prepare === 'function')
            {
                requireConsumedProducerOutputs(producer, context);
                const result = await adapter.prepare(context, signal);
                const backendObservation = context.temporalContext
                    ? await observeBackendTemporalContext(context, signal)
                    : null;
                return {
                    producerId: producer.id,
                    strategy: producer.strategy,
                    implementation: `injected-${adapterHandleName}`,
                    structuralOnly: false,
                    ...(result && typeof result === 'object' ? result : {}),
                    ...variantOutputFromTypedPlan(context, producer.id),
                    postconditions: [...producer.receiptPostconditions],
                    ...(backendObservation
                        ? {
                            temporalObservation: {
                                ...backendObservation,
                                observationBoundary: `server-owned-${producer.id}-backend-and-postgres-session`
                            }
                        }
                        : {})
                };
            }
            requireConsumedProducerOutputs(producer, context);
            return {
                producerId: producer.id,
                strategy: producer.strategy,
                implementation: 'structural-port',
                structuralOnly: true,
                ...variantOutputFromTypedPlan(context, producer.id),
                postconditions: [...producer.receiptPostconditions]
            };
        },
        async verify(context, producerReceipt)
        {
            // #1710: structural-only prepare cannot become verified evidence.
            if (producerReceipt?.structuralOnly === true)
            {
                return {
                    ok: false,
                    structuralOnly: true,
                    producerId: producer.id,
                    reason: 'business observations required before ProducerReceipt success (#1712+)'
                };
            }
            const adapter = context.handles?.[adapterHandleName];
            if (adapter && typeof adapter.verify === 'function')
            {
                return adapter.verify(context, producerReceipt);
            }
            // Without an injected adapter or observations, fail closed.
            if (!producerReceipt?.observations && !producerReceipt?.databaseObservation)
            {
                return {
                    ok: false,
                    producerId: producer.id,
                    reason: 'producer verify missing database/redis/cache observations'
                };
            }
            return { ok: true, producerId: producer.id };
        },
        async cleanup(context, receipt, signal)
        {
            const adapter = context.handles?.[adapterHandleName];
            if (adapter && typeof adapter.cleanup === 'function')
            {
                await adapter.cleanup(context, receipt, signal);
            }
        }
    });
}

export function createAccountMessagingPort(catalogs = readFixtureCatalogs())
{
    return createStructuralBusinessPort(catalogProducer('account-messaging', catalogs), 'accountMessagingAdapter');
}

export function createCommentModerationPort(catalogs = readFixtureCatalogs())
{
    return createStructuralBusinessPort(catalogProducer('comment-moderation', catalogs), 'commentModerationAdapter');
}

/** Full default registry for catalog producers. */
export function createDefaultProducerPorts(catalogs = readFixtureCatalogs())
{
    return [
        createAuthSessionPort(catalogs),
        createPublicContentPort(catalogs),
        createDevelopmentDemoPort(catalogs),
        createScaleDataPort(catalogs),
        createSecurityStatePort(catalogs),
        createAccountMessagingPort(catalogs),
        createCommentModerationPort(catalogs)
    ];
}

/**
 * Ports required for a planned producer id list only.
 * Unknown catalog producers fail closed.
 */
export function createPortsForProducerIds(producerIds, catalogs = readFixtureCatalogs())
{
    const all = new Map(createDefaultProducerPorts(catalogs).map((port) => [port.id, port]));
    return producerIds.map((id) =>
    {
        const port = all.get(id);
        if (!port)
        {
            throw new Error(`no default port registered for producer ${id}`);
        }
        return port;
    });
}
