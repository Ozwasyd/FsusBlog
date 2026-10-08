import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { URL } from 'node:url';

import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

const { createSecurityFixtureLifecycle } = await import(new URL('../../tools/test/security-atomic/fixture-lifecycle.mjs', import.meta.url));
const { qualificationTemporalContext } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));

function lifecycleFixture(testContext, { failVerify = false, failCleanup = false } = {})
{
    const fixture = createSecurityAtomicFixture();
    // Ordinary auth-profile transport control, not full security acceptance.
    fixture.context.profileId = 'auth-basic';
    const runtimeReference = fixture.reference('runtime', 'lifecycle-runtime');
    const fingerprint = `sha256:${'c'.repeat(64)}`;
    const savedTemporal = process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON;
    process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = JSON.stringify(qualificationTemporalContext({
        sourceCommit: fixture.context.sourceRevision, sourceFingerprint: fingerprint,
        producerId: 'auth-session', schedulerRunId: fixture.context.runId,
        businessEpochUtc: '2026-01-15T12:00:00.000Z', locale: 'en-US', uiLocale: 'en-US',
        timeoutPolicyDigest: `sha256:${'d'.repeat(64)}`
    }));
    testContext.after(() =>
    {
        if (savedTemporal === undefined)
        {
            delete process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON;
        }
        else
        {
            process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = savedTemporal;
        }
    });
    const calls = [];
    let observation;
    const verificationFailure = new Error('independent fixture verification unavailable');
    const cleanupFailure = new Error('owned cleanup transport failed');
    const authFixtureAdapter = {
        async prepare({ authFixturePlan })
        {
            calls.push('prepare');
            const entities = authFixturePlan.roles.map((role, index) => ({
                kind: role.kind, id: role.sessionIdentities?.[0] ?? String(100 + index), owned: true,
                semanticRole: role.semanticRole, fixtureIdentity: role.fixtureIdentity,
                capabilityHint: role.capabilityId,
                postconditionId: role.kind === 'admin' ? 'admin-full-permission' : 'user-active',
                fields: { state: role.expectedState, status: role.expectedState,
                    permissionCatalogDigest: `sha256:${'e'.repeat(64)}`, authorizationVerified: true,
                    allowedActions: ['article.publish'], deniedActions: [], activeDeviceCount: 1,
                    databaseStateVerified: true, claimStateVerified: true, cacheStateVerified: true, live: true }
            }));
            observation = { source: 'application-read-model',
                database: { namespace: authFixturePlan.namespace, entities },
                redis: { namespace: authFixturePlan.namespace, keys: [] },
                cache: { namespace: authFixturePlan.namespace, entries: [] } };
            return { strategy: 'transaction-fixture', implementation: 'ordinary-control-transport',
                providedCapabilities: authFixturePlan.capabilities, observations: observation,
                temporalObservation: { businessEpochUtc: authFixturePlan.temporalContext.businessEpochUtc,
                    backendCulture: 'Invariant', postgresTimezone: 'UTC' } };
        },
        async verify(_context, producerResult)
        {
            calls.push('verify');
            if (failVerify)
            {
                throw verificationFailure;
            }
            return { ok: true, observations: observation,
                receiptDigest: createHash('sha256').update(JSON.stringify(producerResult)).digest('hex') };
        },
        async cleanup(_context, _result, signal)
        {
            calls.push('cleanup');
            assert.notEqual(signal?.aborted, true);
            if (failCleanup)
            {
                throw cleanupFailure;
            }
            observation = null;
        }
    };
    const lifecycle = createSecurityFixtureLifecycle({ ...fixture, runtimeReference,
        profileIdentity: { profileId: fixture.context.profileId, profileSource: 'dev-cli' },
        executionIdentity: { runId: fixture.context.runId, namespace: fixture.context.namespace,
            sourceIdentity: { commit: fixture.context.sourceRevision, worktreeFingerprint: fingerprint },
            handles: { authFixtureAdapter } } });
    return { ...fixture, lifecycle, calls, verificationFailure, cleanupFailure };
}

test('fixture lifecycle runs canonical prepare/verify once and cleans after producer cancellation', async (t) =>
{
    const fixture = lifecycleFixture(t);
    const receipt = await fixture.lifecycle.prepareFixture();
    assert.equal(receipt.terminalStatus, 'verified');
    assert.equal(await fixture.lifecycle.prepareFixture(), receipt);
    const abortedProducer = new AbortController();
    abortedProducer.abort(new Error('producer cancelled'));
    // The aborted producer signal does not become the cleanup budget signal.
    const result = await fixture.lifecycle.finalizeFixture();
    assert.equal(result.cleanedState.terminalState, 'cleaned');
    assert.equal(result.fixtureReceipt, receipt);
    assert.equal(await fixture.lifecycle.finalizeFixture(), result);
    assert.deepEqual(fixture.calls, ['prepare', 'verify', 'cleanup']);
    assert.equal(result.qualificationEligible, false);
});

test('verification failure keeps canonical prepared mutations available for cleanup', async (t) =>
{
    const fixture = lifecycleFixture(t, { failVerify: true });
    let originalError;
    await assert.rejects(fixture.lifecycle.prepareFixture(), (error) =>
    {
        originalError = error;
        return error.cause === fixture.verificationFailure;
    });
    const result = await fixture.lifecycle.finalizeFixture();
    assert.equal(result.primaryFailure, originalError);
    assert.equal(result.fixtureReceipt, null);
    assert.equal(result.cleanedState.terminalState, 'cleaned');
    assert.deepEqual(fixture.calls, ['prepare', 'verify', 'cleanup']);
});

test('cleanup failure preserves the original verification failure and is not retried', async (t) =>
{
    const fixture = lifecycleFixture(t, { failVerify: true, failCleanup: true });
    let verificationError;
    await assert.rejects(fixture.lifecycle.prepareFixture(), (error) =>
    {
        verificationError = error;
        return true;
    });
    let cleanupError;
    await assert.rejects(fixture.lifecycle.finalizeFixture(), (error) =>
    {
        cleanupError = error;
        return error.name === 'SecurityFixtureFinalizationError'
            && error.cleanupFailure.cause === fixture.cleanupFailure;
    });
    await assert.rejects(fixture.lifecycle.finalizeFixture(), (error) => error === cleanupError);
    assert.equal(cleanupError.cleanupFailure.receipt.terminalState, 'cleanup-failed');
    assert.equal(cleanupError.primaryFailure, verificationError);
    assert.equal(verificationError.cause, fixture.verificationFailure);
    assert.deepEqual(fixture.calls, ['prepare', 'verify', 'cleanup']);
});
