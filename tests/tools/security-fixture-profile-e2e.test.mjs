import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { qualificationTemporalContext } from '../../tools/test/temporal-context.mjs';
import {
    cleanup,
    plan,
    prepare,
    verify
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test-fixtures/orchestrator.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { createPortsForProducerIds } from '../../tools/test-fixtures/producers/catalog-ports.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs';

const decisions = Object.freeze({
    'security.audit.active-window': 'active-window',
    'security.credential.active': 'accepted',
    'security.credential.revoked': 'rejected',
    'security.issuance.replay-observed': 'replay-rejected',
    'security.nullifier.blocked': 'rejected',
    'security.pow.elevated': 'elevated',
    'security.rate-limit.blocked': 'blocked',
    'security.rate-limit.near-limit': 'near-limit',
    'security.risk.escalated': 'escalated',
    'security.risk.low': 'low',
    'security.subject.banned': 'rejected',
    'security.subject.unbanned': 'accepted'
});

function stableDigest(value)
{
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function withDigest(body)
{
    return { ...body, contentDigest: digestCanonical(body) };
}

function authAdapter()
{
    let observed = null;
    return {
        async prepare({ authFixturePlan })
        {
            const entities = authFixturePlan.roles.map((role, index) => ({
                kind: role.kind,
                id: String(101 + index),
                owned: true,
                semanticRole: role.semanticRole,
                fixtureIdentity: role.fixtureIdentity,
                capabilityHint: role.capabilityId,
                postconditionId: 'user-active',
                fields: { state: role.expectedState, status: role.expectedState }
            }));
            observed = {
                source: 'application-read-model',
                database: { namespace: authFixturePlan.namespace, entities },
                redis: { namespace: authFixturePlan.namespace, keys: [] },
                cache: { namespace: authFixturePlan.namespace, entries: [] }
            };
            return {
                strategy: 'transaction-fixture',
                implementation: 'test-only-auth-fixture-composition-root',
                providedCapabilities: authFixturePlan.capabilities,
                observations: observed,
                temporalObservation: {
                    businessEpochUtc: authFixturePlan.temporalContext.businessEpochUtc
                }
            };
        },
        async verify(_context, producerResult)
        {
            return {
                ok: true,
                receiptDigest: stableDigest(producerResult),
                observations: observed
            };
        },
        async cleanup()
        {
            observed = null;
        }
    };
}

function securityPorts()
{
    const stored = new Map();
    const ports = {};
    for (const [name, family] of [
        ['riskPowRateLimit', 'risk-pow-rate-limit'],
        ['ban', 'ban'],
        ['credential', 'credential']
    ])
    {
        ports[name] = {
            async apply(fragment)
            {
                stored.set(family, fragment);
                const receipt = {
                    schema: 'fsusblog.security-fixture-recovery-receipt.v1',
                    status: 'ready',
                    planDigest: fragment.planDigest,
                    family,
                    ownedOperationIds: fragment.operations.map((item) => item.operationId).sort()
                };
                return {
                    status: 'applied',
                    planDigest: fragment.planDigest,
                    partial: false,
                    warningOnly: false,
                    recoveryReceipt: withDigest(receipt)
                };
            },
            async observe(fragment)
            {
                const businessEpochUtc = fragment.operations[0].temporal.businessEpochUtc;
                const facts = fragment.operations.map((operation) =>
                {
                    const counter = operation.capabilityId === 'security.rate-limit.near-limit'
                        ? { current: 9, limit: 10, blocked: false }
                        : operation.capabilityId === 'security.rate-limit.blocked'
                            ? { current: 10, limit: 10, blocked: true }
                            : null;
                    return {
                        capabilityId: operation.capabilityId,
                        operationId: operation.operationId,
                        subjectDigest: operation.subject.digest,
                        ipPseudonymDigest: operation.ipPseudonym.digest,
                        credentialDigest: operation.credential.digest,
                        nullifierDigest: operation.nullifier.digest,
                        issuanceDigest: operation.issuance.digest,
                        hashVersion: 'sha256-v1',
                        database: {
                            present: true,
                            version: 1,
                            reason: 'production-service-observation',
                            windowStartUtc: businessEpochUtc,
                            expiresAtUtc: '2035-01-01T00:00:00.000Z'
                        },
                        redis: {
                            present: true,
                            namespace: fragment.namespace,
                            hashVersion: 'sha256-v1',
                            ttlSeconds: 120,
                            keyIdentity: operation.operationId,
                            valueDigest: `sha256:${'5'.repeat(64)}`
                        },
                        service: { observed: true, decision: decisions[operation.capabilityId] },
                        cache: { invalidationObserved: true, generation: 1 },
                        audit: { present: true, eventDigest: `sha256:${'6'.repeat(64)}` },
                        counter
                    };
                });
                return withDigest({
                    schema: 'fsusblog.security-fixture-observation.v1',
                    planDigest: fragment.planDigest,
                    runId: fragment.runId,
                    namespace: fragment.namespace,
                    family,
                    businessEpochUtc,
                    capabilities: fragment.capabilities,
                    partial: false,
                    warnings: [],
                    privacyLeaks: [],
                    facts
                });
            },
            async cleanup(cleanupPlan)
            {
                stored.delete(family);
                return {
                    status: 'cleaned',
                    planDigest: cleanupPlan.planDigest,
                    removedOperationIds: cleanupPlan.ownedOperationIds,
                    nonOwnedMutationCount: 0
                };
            },
            async observeCleanup(cleanupPlan)
            {
                return withDigest({
                    schema: 'fsusblog.security-fixture-cleanup-observation.v1',
                    planDigest: cleanupPlan.planDigest,
                    family,
                    removedOperationIds: cleanupPlan.ownedOperationIds,
                    residualOwnedOperationIds: stored.has(family) ? cleanupPlan.ownedOperationIds : [],
                    nonOwnedMutationCount: 0,
                    preservedNamespaceDigests: [`sha256:${'7'.repeat(64)}`]
                });
            }
        };
    }
    return ports;
}

test('security-state-matrix runs auth allocation before all three real producer families', async (context) =>
{
    const sourceCommit = 'a'.repeat(40);
    const sourceFingerprint = `sha256:${'b'.repeat(64)}`;
    const previousTemporalContext = process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON;
    const previousTimezone = process.env.TZ;
    process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = JSON.stringify(qualificationTemporalContext({
        sourceCommit,
        sourceFingerprint,
        producerId: 'auth-session',
        schedulerRunId: 'security-profile-e2e-run',
        businessEpochUtc: '2026-01-15T12:00:00.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: `sha256:${'c'.repeat(64)}`
    }));
    process.env.TZ = 'UTC';
    context.after(() =>
    {
        if (previousTemporalContext === undefined)
        {
            delete process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON;
        }
        else
        {
            process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = previousTemporalContext;
        }
        if (previousTimezone === undefined)
        {
            delete process.env.TZ;
        }
        else
        {
            process.env.TZ = previousTimezone;
        }
    });
    const authFixtureAdapter = authAdapter();
    const securityFixturePorts = securityPorts();
    const planned = plan(
        { profileId: 'security-state-matrix', profileSource: 'dev-cli' },
        {
            runId: 'security-profile-e2e-run',
            namespace: 'security-profile-e2e-namespace',
            sourceIdentity: { commit: sourceCommit, worktreeFingerprint: sourceFingerprint },
            handles: { authFixtureAdapter, securityFixturePorts }
        }
    );
    assert.deepEqual(planned.waves, [['auth-session'], ['security-state']]);
    const ports = createPortsForProducerIds(planned.producers);
    const prepared = await prepare(planned, ports);
    const authReferences = prepared.producerOutputs['auth-session'].identityPrepareReferences
        .filter((item) => item.consumerProducerId === 'security-state');
    assert.deepEqual(authReferences.map((item) => item.role).sort(), [
        'primary',
        'subject.banned',
        'subject.unbanned'
    ]);
    assert.ok(prepared.producerOutputs['security-state'].operationPlan.operations.every((operation) =>
        operation.authIdentityRef == null
        || operation.authIdentityRef.consumerProducerId === 'security-state'));
    assert.ok(prepared.producerOutputs['auth-session'].observations.database.entities.every((entity) =>
        prepared.producerOutputs['auth-session'].variantIds.includes(entity.variantId)), JSON.stringify({
        entities: prepared.producerOutputs['auth-session'].observations.database.entities,
        variantIds: prepared.producerOutputs['auth-session'].variantIds
    }));

    const receipt = await verify(prepared, ports);
    assert.equal(receipt.terminalStatus, 'verified');
    assert.deepEqual(receipt.producerReceipts.map((item) => item.producerId), [
        'auth-session',
        'security-state'
    ]);
    const cleaned = await cleanup(prepared, ports);
    assert.equal(cleaned.terminalState, 'cleaned');
});
