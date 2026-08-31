import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildMessagingFixtureCleanupReceipt,
    verifyMessagingFixtureCleanupReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/messaging-fixture-governance.mjs';

function fixtureRepository(context, files)
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-message-cleanup-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    const producerMarker = `// fixture-${'catalog: producer account-messaging'}\n`;
    for (const [relativePath, source] of Object.entries({
        'tools/test-fixtures/producers/account-messaging-producer.mjs': `${producerMarker}export const owner = true;\n`,
        ...files
    }))
    {
        mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
        writeFileSync(path.join(root, relativePath), source);
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'test fixture'], { cwd: root });
    return root;
}

test('messaging cleanup ownership is exact and independently reproducible', () =>
{
    const receipt = buildMessagingFixtureCleanupReceipt();
    assert.equal(receipt.scanner.status, 'accepted');
    assert.deepEqual(receipt.scanner.violations, []);
    assert.equal(receipt.exactOwnership, true);
    assert.deepEqual(receipt.warnings, []);
    assert.deepEqual(verifyMessagingFixtureCleanupReceipt(receipt), receipt);
});

test('messaging cleanup scanner rejects renamed active sleep/mock/second-producer paths', (context) =>
{
    const root = fixtureRepository(context, {
        'tests/frontend/checks/runtime/renamed-notice-helper.mjs': `
// fixture-${'catalog: consumer account-messaging'}
setTimeout(() => {}, 50); const messageOrder = 'arrival';
const renamedFallback = mockNotificationStream;
`,
        'tests/frontend/support/second-owner.mjs': `// fixture-${'catalog: producer account-messaging'}\n`
    });
    const receipt = buildMessagingFixtureCleanupReceipt({ root });
    assert.equal(receipt.scanner.status, 'rejected');
    assert.ok(receipt.scanner.violations.some((item) => item.id === 'sleep-order'));
    assert.ok(receipt.scanner.violations.some((item) => item.id === 'producer-owner-exactness'));
});

test('messaging cleanup receipt rejects stale and tampered source identity', () =>
{
    const receipt = buildMessagingFixtureCleanupReceipt();
    const tampered = structuredClone(receipt);
    tampered.source.worktreeFingerprint = `sha256:${'0'.repeat(64)}`;
    assert.throws(
        () => verifyMessagingFixtureCleanupReceipt(tampered),
        /missing, stale, tampered, or cross-source/u
    );
});
