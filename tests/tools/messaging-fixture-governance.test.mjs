import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildMessagingFixtureAcceptanceReceipt,
    buildMessagingFixtureCleanupReceipt,
    verifyMessagingFixtureAcceptanceReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/messaging-fixture-governance.mjs';

test('messaging terminal acceptance binds cleanup, parity, mutations, and privacy with zero warnings', () =>
{
    const cleanup = buildMessagingFixtureCleanupReceipt();
    const acceptance = buildMessagingFixtureAcceptanceReceipt(cleanup);
    assert.equal(acceptance.schema, 'fsusblog.messaging-fixture-acceptance.v1');
    assert.equal(acceptance.status, 'accepted');
    assert.equal(acceptance.inputDigest, cleanup.contentDigest);
    assert.deepEqual(acceptance.violations, []);
    assert.deepEqual(acceptance.warnings, []);
    assert.ok(acceptance.mutations.length >= 10);
    assert.ok(acceptance.mutations.every((item) => item.killed === true));
    assert.equal(acceptance.consumerParity.status, 'accepted');
    assert.deepEqual(acceptance.consumerParity.domains, ['api', 'cache', 'database', 'outbox', 'stream']);
    assert.equal(acceptance.parallelRerun.status, 'accepted');
    assert.equal(acceptance.privacy.status, 'accepted');
    assert.deepEqual(acceptance.privacy.leaks, []);
    assert.deepEqual(verifyMessagingFixtureAcceptanceReceipt(acceptance, cleanup), acceptance);
});

test('messaging terminal acceptance rejects stale input and receipt tamper', () =>
{
    const cleanup = buildMessagingFixtureCleanupReceipt();
    const acceptance = buildMessagingFixtureAcceptanceReceipt(cleanup);
    const tampered = structuredClone(acceptance);
    tampered.status = 'rejected';
    assert.throws(
        () => verifyMessagingFixtureAcceptanceReceipt(tampered, cleanup),
        /missing, stale, or tampered/u
    );

    const crossSource = structuredClone(cleanup);
    crossSource.contentDigest = `sha256:${'f'.repeat(64)}`;
    assert.throws(
        () => buildMessagingFixtureAcceptanceReceipt(crossSource),
        /missing, stale, tampered, or cross-source/u
    );
});

test('messaging terminal artifact contains no ordinary private payload fields', () =>
{
    const cleanup = buildMessagingFixtureCleanupReceipt();
    const acceptance = buildMessagingFixtureAcceptanceReceipt(cleanup);
    const serialized = JSON.stringify(acceptance);
    for (const key of ['"body"', '"cookie"', '"notificationPayload"', '"sessionId"', '"token"'])
    {
        assert.equal(serialized.includes(key), false, `${key} must not occur in terminal evidence`);
    }
});
