import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildCommentFixtureCleanupReceipt,
    verifyCommentFixtureCleanupReceipt
} from '../../tools/test/comment-fixture-governance.mjs';

const ownerPaths = [
    'src/backend/Modules/Endpoints/LocalCommentFixtureEndpoints.cs',
    'src/backend/Services/Fixtures/CommentFixtureSeeder.cs',
    'src/backend/Services/Fixtures/CommentAnonymousFixtureProvider.cs',
    'src/backend/Services/Fixtures/CommentModerationFixturePort.cs',
    'src/backend/Services/Fixtures/CommentThreadFixturePort.cs',
    'tools/test-fixtures/producers/comment-moderation-producer.mjs'
];

function fixtureRepository(context, files = {})
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-comment-cleanup-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    const sources = Object.fromEntries(ownerPaths.map((relativePath) => [
        relativePath,
        `// fixture-${'catalog: producer comment-moderation'}\nexport const owner = true;\n`
    ]));
    sources['src/backend/Services/Fixtures/CommentAnonymousFixtureProvider.cs'] = 'export const anonymousSupport = true;\n';
    sources['tests/browser-contract/default-fixture-provider.mjs'] = 'export const receiptConsumer = true;\n';
    for (const [relativePath, source] of Object.entries({ ...sources, ...files }))
    {
        mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
        writeFileSync(path.join(root, relativePath), source);
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'test fixture'], { cwd: root });
    return root;
}

test('comment cleanup ownership is exact and independently reproducible', () =>
{
    const receipt = buildCommentFixtureCleanupReceipt();
    assert.equal(receipt.scanner.status, 'accepted');
    assert.deepEqual(receipt.scanner.violations, []);
    assert.equal(receipt.exactOwnership, true);
    assert.deepEqual(receipt.warnings, []);
    assert.deepEqual(verifyCommentFixtureCleanupReceipt(receipt), receipt);
});

test('comment cleanup scanner rejects direct SQL, first-row discovery, and a second producer', (context) =>
{
    const root = fixtureRepository(context, {
        'tests/browser-contract/default-fixture-provider.mjs': `
// fixture-${'catalog: producer comment-moderation'}
const row = comments.FirstAsync();
const sql = 'INSERT INTO comment (id) VALUES (1)';
const crossDomain = 'DELETE FROM article WHERE id = 1';
`
    });
    const receipt = buildCommentFixtureCleanupReceipt({ root });
    assert.equal(receipt.scanner.status, 'rejected');
    assert.ok(receipt.scanner.violations.some((item) => item.id === 'direct-comment-storage'));
    assert.ok(receipt.scanner.violations.some((item) => item.id === 'cross-domain-storage-write'));
    assert.ok(receipt.scanner.violations.some((item) => item.id === 'first-row-discovery'));
    assert.ok(receipt.scanner.violations.some((item) => item.id === 'second-producer'));
    assert.ok(receipt.scanner.violations.some((item) => item.id === 'producer-owner-exactness'));
});

test('comment cleanup receipt rejects stale source identity and content tamper', () =>
{
    const receipt = buildCommentFixtureCleanupReceipt();
    const stale = structuredClone(receipt);
    stale.source.worktreeFingerprint = `sha256:${'0'.repeat(64)}`;
    assert.throws(
        () => verifyCommentFixtureCleanupReceipt(stale),
        /missing, stale, tampered, or rejected/u
    );
});
