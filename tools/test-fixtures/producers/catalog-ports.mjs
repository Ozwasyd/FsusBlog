/**
 * Default producer ports bound to catalog strategies and implementation paths.
 * Business data logic stays in existing modules; ports only invoke them.
 * Strategy is sealed from the producer registry — never from process.env.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const { readFixtureCatalogs } = await import(new URL("../../testing/fixture-catalog.mjs", import.meta.url));

import { accountProfilePreferenceIdentityRoleRequests } from './account-profile-preference-producer.mjs';
import { observeBackendTemporalContext, observePreparedBackendTemporalContext, validateBackendTemporalObservation } from './backend-temporal-observer.mjs';
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
        async verify(context, producerResult, signal)
        {
            const { verifyAuthSession } = await import('./auth-session-producer.mjs');
            return verifyAuthSession(context, producerResult, signal);
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
                preparePublicContent, resolvePublicContentBackendUrl
            } = await import('./public-content-producer.mjs');
            const result = await preparePublicContent(context, signal);
            const backendObservation = context.temporalContext
                ? await observePreparedBackendTemporalContext(context, result.temporalObservation, signal, {
                    baseUrl: resolvePublicContentBackendUrl(context)
                })
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
            const { prepareDemoPublic, resolveDemoBackendUrl } = await import('./demo-public-producer.mjs');
            const result = await prepareDemoPublic(context, signal);
            const backendObservation = context.temporalContext
                ? await observeBackendTemporalContext(context, signal, { baseUrl: resolveDemoBackendUrl(context) })
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
            if (context.temporalContext)
            {
                try
                {
                    validateBackendTemporalObservation(context.temporalContext, producerResult?.temporalObservation);
                }
                catch (error)
                {
                    return { ok: false, producerId: producer.id, reason: error.message };
                }
            }
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
            return await cleanupSecurityFixtures(context, producerResult, signal);
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

export function createAccountMessagingPort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('account-messaging', catalogs);
    return basePort(producer, {
        identityRoleRequests: [
            {
                ownerProducerId: 'auth-session',
                consumerProducerId: 'account-messaging',
                role: 'admin',
                capabilityId: 'auth.admin.full-permission'
            },
            {
                ownerProducerId: 'auth-session',
                consumerProducerId: 'account-messaging',
                role: 'empty-recipient',
                capabilityId: 'auth.user.active'
            },
            {
                ownerProducerId: 'auth-session',
                consumerProducerId: 'account-messaging',
                role: 'primary-recipient',
                capabilityId: 'auth.user.active'
            },
            {
                ownerProducerId: 'auth-session',
                consumerProducerId: 'account-messaging',
                role: 'secondary-recipient',
                capabilityId: 'auth.user.active'
            }
        ],
        async prepare(context, signal)
        {
            requireConsumedProducerOutputs(producer, context);
            const { prepareAccountMessaging } = await import('./account-messaging-producer.mjs');
            const result = await prepareAccountMessaging(context, signal);
            return {
                ...result,
                ...variantOutputFromTypedPlan(context, producer.id),
                postconditions: [...producer.receiptPostconditions]
            };
        },
        async verify(context, producerResult, signal)
        {
            const { verifyAccountMessaging } = await import('./account-messaging-producer.mjs');
            return verifyAccountMessaging(context, producerResult, signal);
        },
        async cleanup(context, producerResult, signal)
        {
            const { cleanupAccountMessaging } = await import('./account-messaging-producer.mjs');
            await cleanupAccountMessaging(context, producerResult, signal);
        }
    });
}

export function createAccountProfilePreferencePort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('account-profile-preferences', catalogs);
    return basePort(producer, {
        identityRoleRequests: accountProfilePreferenceIdentityRoleRequests,
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            requireConsumedProducerOutputs(producer, context);
            const { prepareAccountProfilePreferences } = await import(
                './account-profile-preference-producer.mjs'
            );
            const result = await prepareAccountProfilePreferences(context, signal);
            return {
                ...result,
                producerId: producer.id,
                strategy: producer.strategy,
                postconditions: [...producer.receiptPostconditions]
            };
        },
        async verify(context, producerResult)
        {
            const { verifyAccountProfilePreferences } = await import(
                './account-profile-preference-producer.mjs'
            );
            return verifyAccountProfilePreferences(context, producerResult);
        },
        async cleanup(context, producerResult, signal)
        {
            const { cleanupAccountProfilePreferences } = await import(
                './account-profile-preference-producer.mjs'
            );
            await cleanupAccountProfilePreferences(context, producerResult, signal);
        }
    });
}

export function createAuditRecordsPort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('audit-records', catalogs);
    return basePort(producer, {
        async prepare(context, signal)
        {
            assertNoStrategyEnv();
            const { prepareAuditRecords } = await import('./audit-producer.mjs');
            const result = await prepareAuditRecords(context, signal);
            return {
                ...result,
                ...variantOutputFromTypedPlan(context, producer.id),
                postconditions: [...producer.receiptPostconditions]
            };
        },
        async verify(context, producerResult)
        {
            const { verifyAuditRecords } = await import('./audit-producer.mjs');
            return verifyAuditRecords(context, producerResult);
        },
        async cleanup(context, receipt, signal)
        {
            const { cleanupAuditRecords } = await import('./audit-producer.mjs');
            await cleanupAuditRecords(context, receipt, signal);
        }
    });
}

export function createCommentModerationPort(catalogs = readFixtureCatalogs())
{
    const producer = catalogProducer('comment-moderation', catalogs);
    return basePort(producer, {
        identityRoleRequests: [
            { ownerProducerId: 'auth-session', consumerProducerId: 'comment-moderation', role: 'admin', capabilityId: 'auth.admin.full-permission' },
            { ownerProducerId: 'auth-session', consumerProducerId: 'comment-moderation', role: 'primary-author', capabilityId: 'auth.user.active' },
            { ownerProducerId: 'auth-session', consumerProducerId: 'comment-moderation', role: 'secondary-author', capabilityId: 'auth.user.active' }
        ],
        async prepare(context, signal)
        {
            requireConsumedProducerOutputs(producer, context);
            const { prepareCommentModeration } = await import('./comment-moderation-producer.mjs');
            const result = await prepareCommentModeration(context, signal);
            return {
                ...result,
                ...variantOutputFromTypedPlan(context, producer.id),
                postconditions: [...producer.receiptPostconditions]
            };
        },
        async verify(context, result, signal)
        {
            const { verifyCommentModeration } = await import('./comment-moderation-producer.mjs');
            return verifyCommentModeration(context, result, signal);
        },
        async cleanup(context, result, signal)
        {
            const { cleanupCommentModeration } = await import('./comment-moderation-producer.mjs');
            return cleanupCommentModeration(context, result, signal);
        }
    });
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
        createAccountProfilePreferencePort(catalogs),
        createAuditRecordsPort(catalogs),
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
