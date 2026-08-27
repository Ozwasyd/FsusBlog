import assert from 'node:assert/strict';
import test from 'node:test';

import { qualificationTemporalContext } from '../../tools/test/temporal-context.mjs';
import {
    buildSecurityFixtureOperationPlan,
    cleanupSecurityFixtures,
    prepareSecurityFixtures,
    SECURITY_FIXTURE_OBSERVATION_SCHEMA,
    validateSecurityFixtureObservation,
    verifySecurityFixtures
} from '../../tools/test-fixtures/producers/security-fixture-producer.mjs';
import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs';

const capabilityDecisions = Object.freeze({
    'security.audit.active-window': 'active-window',
    'security.clean': 'clean',
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

function withDigest(body)
{
    return { ...body, contentDigest: digestCanonical(body) };
}

function contextFor(capabilities = Object.keys(capabilityDecisions).sort(), overrides = {})
{
    const runId = overrides.runId ?? 'security-run';
    const namespace = overrides.namespace ?? 'security-namespace';
    const profileId = overrides.profileId ?? 'security-state-matrix';
    const variants = capabilities.map((capabilityId) => ({
        id: `canonical.${capabilityId}`,
        capabilityId,
        ownerProducerId: 'security-state',
        expectedBoundary: 'Current writer-contract boundary; no undeclared producer fallback.'
    }));
    return {
        runIdentity: runId,
        namespace,
        profileIdentity: { profileId },
        plan: {
            capabilities,
            catalogDigest: `sha256:${'1'.repeat(64)}`,
            variantPlanDigest: `sha256:${'7'.repeat(64)}`
        },
        variantPlan: {
            schema: 'fsusblog.fixture-producer-variant-plan.v1',
            producerId: 'security-state',
            producerVariantPlanDigest: `sha256:${'2'.repeat(64)}`,
            variants
        },
        producerOutputs: {},
        temporalContext: qualificationTemporalContext({
            sourceCommit: 'a'.repeat(40),
            sourceFingerprint: `sha256:${'b'.repeat(64)}`,
            producerId: 'security-state',
            schedulerRunId: runId,
            businessEpochUtc: '2026-01-15T12:00:00.000Z',
            locale: 'en-US',
            uiLocale: 'en-US',
            timeoutPolicyDigest: `sha256:${'5'.repeat(64)}`
        }),
        handles: {
            authIdentityPrepareRef: {
                schema: 'fsusblog.fixture-identity-prepare-reference.v1',
                verified: false,
                ownerProducerId: 'auth-session',
                runId,
                namespace,
                profileId,
                role: 'user.active',
                publicId: 'fixture-user-active',
                fixtureIdentity: 'fixture-user-active',
                digest: `sha256:${'3'.repeat(64)}`,
                producerResultDigest: `sha256:${'4'.repeat(64)}`,
                planDigests: {
                    authSessionPlanDigest: `sha256:${'6'.repeat(64)}`,
                    catalogDigest: `sha256:${'1'.repeat(64)}`,
                    fixtureVariantPlanDigest: `sha256:${'7'.repeat(64)}`,
                    producerVariantPlanDigest: `sha256:${'8'.repeat(64)}`
                }
            }
        }
    };
}

function observation(plan, family, mutate = (value) => value)
{
    const operations = plan.operations.filter((operation) => operation.family === family);
    const facts = operations.map((operation) =>
    {
        const clean = operation.capabilityId === 'security.clean';
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
                present: !clean,
                version: 1,
                reason: clean ? 'owned-state-absent' : 'fixture-state',
                windowStartUtc: plan.temporal.businessEpochUtc,
                expiresAtUtc: clean ? null : '2035-01-01T00:00:00Z'
            },
            redis: {
                present: !clean,
                namespace: plan.namespace,
                hashVersion: 'sha256-v1',
                ttlSeconds: clean ? null : 120,
                keyIdentity: operation.operationId,
                valueDigest: `sha256:${'5'.repeat(64)}`
            },
            service: { observed: true, decision: capabilityDecisions[operation.capabilityId] },
            cache: { invalidationObserved: true, generation: 1 },
            audit: { present: true, eventDigest: `sha256:${'6'.repeat(64)}` },
            counter
        };
    });
    const body = mutate({
        schema: SECURITY_FIXTURE_OBSERVATION_SCHEMA,
        planDigest: plan.contentDigest,
        runId: plan.runId,
        namespace: plan.namespace,
        family,
        businessEpochUtc: plan.temporal.businessEpochUtc,
        capabilities: operations.map((operation) => operation.capabilityId),
        partial: false,
        warnings: [],
        privacyLeaks: [],
        facts
    });
    return withDigest(body);
}

function fakeAdapters(context, { failFamily = null, observationMutation = null } = {})
{
    const plan = buildSecurityFixtureOperationPlan(context);
    const calls = [];
    const ports = {};
    for (const [handle, family] of [
        ['riskPowRateLimit', 'risk-pow-rate-limit'],
        ['ban', 'ban'],
        ['credential', 'credential']
    ])
    {
        ports[handle] = {
            async apply(fragment)
            {
                calls.push(`apply:${family}`);
                if (failFamily === family)
                {
                    throw new Error(`fail ${family}`);
                }
                const receiptBody = {
                    schema: 'fsusblog.security-fixture-recovery-receipt.v1',
                    status: 'ready',
                    planDigest: plan.contentDigest,
                    family,
                    ownedOperationIds: fragment.operations.map((operation) => operation.operationId).sort()
                };
                return {
                    status: 'applied',
                    planDigest: plan.contentDigest,
                    partial: false,
                    warningOnly: false,
                    recoveryReceipt: withDigest(receiptBody)
                };
            },
            async observe()
            {
                calls.push(`observe:${family}`);
                return observation(plan, family, observationMutation ?? ((value) => value));
            },
            async cleanup(cleanupPlan)
            {
                calls.push(`cleanup:${family}`);
                return {
                    status: 'cleaned',
                    planDigest: plan.contentDigest,
                    removedOperationIds: cleanupPlan.ownedOperationIds,
                    nonOwnedMutationCount: 0
                };
            },
            async observeCleanup(cleanupPlan)
            {
                calls.push(`observe-cleanup:${family}`);
                return withDigest({
                    schema: 'fsusblog.security-fixture-cleanup-observation.v1',
                    planDigest: plan.contentDigest,
                    family,
                    removedOperationIds: cleanupPlan.ownedOperationIds,
                    residualOwnedOperationIds: [],
                    nonOwnedMutationCount: 0,
                    preservedNamespaceDigests: [`sha256:${'7'.repeat(64)}`]
                });
            }
        };
    }
    context.handles = { ...context.handles, securityFixturePorts: ports };
    return { calls, plan };
}

test('single producer routes every capability through its sealed family and independently verifies it', async () =>
{
    const context = contextFor();
    const { calls } = fakeAdapters(context);
    const result = await prepareSecurityFixtures(context);
    assert.deepEqual(result.providedCapabilities, Object.keys(capabilityDecisions).sort());
    assert.equal(result.domainObservations.length, 3);
    assert.equal(result.cleanupContract.ownedEntityDigests.length, result.providedCapabilities.length * 5);
    assert.equal(result.operationPlan.temporal.shape.id, 'auth-security-messaging-account-lifecycle');
    assert.ok(result.operationPlan.temporal.roles.every((role) => role.precision === 'millisecond'));
    assert.ok(result.operationPlan.operations.every((operation) =>
        operation.temporalRoles.length > 0 && operation.temporalRoles.every(Boolean)));
    assert.equal((await verifySecurityFixtures(context, result)).ok, true);
    await cleanupSecurityFixtures(context, result);
    assert.equal(calls.filter((item) => item.startsWith('observe:')).length, 6);
    assert.equal(calls.filter((item) => item.startsWith('observe-cleanup:')).length, 3);
});

test('partial family failure recovers already applied state before rejecting', async () =>
{
    const context = contextFor(['security.subject.banned', 'security.credential.revoked']);
    const { calls } = fakeAdapters(context, { failFamily: 'credential' });
    await assert.rejects(prepareSecurityFixtures(context), /fail credential/u);
    assert.deepEqual(calls, [
        'apply:ban',
        'observe:ban',
        'apply:credential',
        'cleanup:ban',
        'observe-cleanup:ban'
    ]);
});

for (const [name, mutate, pattern] of [
    ['Redis TTL drift', (value) => { value.facts[0].redis.ttlSeconds = 0; return value; }, /Redis\/TTL/u],
    ['hash version drift', (value) => { value.facts[0].hashVersion = 'sha1-v0'; return value; }, /identity mismatch/u],
    ['expired persisted state', (value) => { value.facts[0].database.expiresAtUtc = '2020-01-01T00:00:00Z'; return value; }, /expiry\/window/u],
    ['revoked credential accepted', (value) => { value.facts[0].service.decision = 'accepted'; return value; }, /revoked credential/u],
    ['partial observation', (value) => { value.partial = true; return value; }, /identity\/status/u],
    ['warning observation', (value) => { value.warnings.push('degraded'); return value; }, /identity\/status/u],
    ['raw IP leakage', (value) => { value.facts[0].rawIp = '192.0.2.1'; return value; }, /raw IP/u]
])
{
    test(`security observation rejects ${name}`, () =>
    {
        const capability = name === 'revoked credential accepted'
            ? 'security.credential.revoked'
            : 'security.risk.escalated';
        const context = contextFor([capability]);
        const plan = buildSecurityFixtureOperationPlan(context);
        const family = plan.operations[0].family;
        assert.throws(() => validateSecurityFixtureObservation(observation(plan, family, mutate), plan, family), pattern);
    });
}

test('security plan rejects cross-run auth identity and wildcard namespaces', () =>
{
    const crossRun = contextFor(['security.subject.banned']);
    crossRun.handles.authIdentityPrepareRef.runId = 'other-run';
    assert.throws(() => buildSecurityFixtureOperationPlan(crossRun), /not current\/digest-bound/u);

    const wildcard = contextFor(['security.clean'], { namespace: 'global-*' });
    assert.throws(() => buildSecurityFixtureOperationPlan(wildcard), /global\/wildcard/u);
});
