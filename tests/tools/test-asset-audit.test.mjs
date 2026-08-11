import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { behaviorTest } from '../../tools/contracts/behavior-test.mjs';
import { executeAuditLayers, redactAuditText, summarizeAuditLayers } from '../../tools/test/test-asset-audit/execution.mjs';
import { assignAuditRecords, compareAuditSnapshots } from '../../tools/test/test-asset-audit/inventory.mjs';
import { detectAuditPreflight } from '../../tools/test/test-asset-audit/preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

behaviorTest('test-asset-audit-reconciliation', 'positive', 'profile derives the live private registry posture without exposing credentials', () =>
{
    const preflight = detectAuditPreflight(root, { env: { GITHUB_TOKEN: 'irrelevant-token' } });
    assert.equal(preflight.package.privateAuthRequired, true);
    assert.equal(preflight.package.registryMode, 'private-auth-required');
    assert.equal(preflight.capabilities.packages.status, 'blocked');
    assert.ok(Object.values(preflight.configuration).every((value) => /^[a-f0-9]{64}$/u.test(value)));
    assert.equal(JSON.stringify(preflight).includes('TOKEN'), false);
});

behaviorTest('test-asset-audit-reconciliation', 'negative', {
    title: 'authoritative records require exactly one audit layer owner',
    invariantIds: ['audit-layer-owner-cardinality']
}, () =>
{
    const records = [{ id: 'node-test:a#b', path: 'tests/a.test.mjs', framework: 'node-test' }];
    const missing = assignAuditRecords(records, []);
    assert.match(missing.errors[0], /exactly one/u);
    const duplicate = assignAuditRecords(records, [
        { id: 'one', frameworks: ['node-test'] },
        { id: 'two', frameworks: ['node-test'] }
    ]);
    assert.match(duplicate.errors[0], /found 2/u);
});

test('path selectors separate browser contracts from general Node governance', () =>
{
    const layers = [
        { id: 'browser', frameworks: ['node-test'], pathPrefixes: ['tests/browser-contract/'] },
        { id: 'node', frameworks: ['node-test'], excludePathPrefixes: ['tests/browser-contract/'] }
    ];
    const result = assignAuditRecords([
        { id: 'browser-id', path: 'tests/browser-contract/run.test.mjs', framework: 'node-test' },
        { id: 'node-id', path: 'tests/tools/governance.test.mjs', framework: 'node-test' }
    ], layers);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.assignments.map((entry) => entry.layerId), ['browser', 'node']);
});

test('live profile assigns canonical Playwright records to the browser diagnostics owner', () =>
{
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/test-asset-audit-profile.json'), 'utf8'));
    const result = assignAuditRecords([
        {
            id: 'vitest:tests/frontend/e2e/acceptance/public-routes.spec.ts#loads',
            path: 'tests/frontend/e2e/acceptance/public-routes.spec.ts',
            framework: 'playwright'
        },
        {
            id: 'playwright-dynamic:tests/frontend/e2e/acceptance/dynamic.spec.ts',
            path: 'tests/frontend/e2e/acceptance/dynamic.spec.ts',
            framework: 'playwright-dynamic'
        }
    ], profile.layers);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.assignments.map((entry) => entry.layerId), [
        'playwright-diagnostics',
        'playwright-diagnostics'
    ]);
});

test('snapshot comparison rejects unmapped test deletion and coverage universe shrink', () =>
{
    const before = { testIds: ['old', 'kept'], frontendCoverageUniverse: { files: ['src/frontend/src/a.ts', 'src/frontend/src/b.ts'] } };
    const after = { testIds: ['kept', 'replacement'], frontendCoverageUniverse: { files: ['src/frontend/src/a.ts'] } };
    const errors = compareAuditSnapshots(before, after, { deletedTests: [] });
    assert.ok(errors.some((entry) => entry.includes('old')));
    assert.ok(errors.some((entry) => entry.includes('b.ts')));
    const mapped = compareAuditSnapshots(
        { testIds: ['old'], frontendCoverageUniverse: { files: [] } },
        { testIds: ['replacement'], frontendCoverageUniverse: { files: [] } },
        { deletedTests: [{ id: 'old', replacementTestIds: ['replacement'] }] }
    );
    assert.deepEqual(mapped, []);
});

test('snapshot comparison rejects replacement evidence regression', () =>
{
    const before = {
        testIds: ['old'],
        assignments: [{ id: 'old', assertionTargets: ['negative:reject'], coverageIds: ['security'], tierIds: ['release-old'] }],
        frontendCoverageUniverse: { files: [] }
    };
    const after = {
        testIds: ['replacement'],
        assignments: [{ id: 'replacement', assertionTargets: [], coverageIds: [], tierIds: [] }],
        frontendCoverageUniverse: { files: [] }
    };
    const errors = compareAuditSnapshots(before, after, { deletedTests: [{ id: 'old', replacementTestIds: ['replacement'] }] });
    assert.ok(errors.some((entry) => entry.includes('negative evidence')));
    assert.ok(errors.some((entry) => entry.includes('coverage evidence')));
    assert.ok(errors.some((entry) => entry.includes('release evidence')));
});

test('layer failures do not prevent independent diagnostics and secrets are redacted', () =>
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-test-audit-'));
    const profile = {
        layers: [
            { id: 'first', producerTier: 'first-tier', requirements: [], frameworks: ['xunit'], command: ['first'] },
            { id: 'second', producerTier: 'second-tier', requirements: [], frameworks: ['vitest'], command: ['second'] }
        ]
    };
    const inventory = {
        assignments: [
            { id: 'xunit:test', layerId: 'first', invocationCount: 1, tierIds: ['first-tier'] },
            { id: 'vitest:test', layerId: 'second', invocationCount: 1, tierIds: ['second-tier'] }
        ]
    };
    const calls = [];
    const sourceCommits = [];
    const receipts = executeAuditLayers({
        root: temporaryRoot,
        profile,
        preflight: { capabilities: {}, source: { commit: 'abc', worktreeFingerprint: 'def' } },
        inventory,
        runId: 'audit-run',
        env: { PACKAGE_TOKEN: 'sensitive-value' },
        executor: (_root, command, executionEnv) =>
        {
            calls.push(command[0]);
            sourceCommits.push(executionEnv.FSUSBLOG_TEST_SOURCE_COMMIT);
            return { status: command[0] === 'first' ? 1 : 0, output: 'sensitive-value' };
        }
    });
    assert.deepEqual(calls, ['first', 'second']);
    assert.deepEqual(sourceCommits, ['abc', 'abc']);
    assert.equal(receipts[0].producerTier, 'first-tier');
    assert.equal(summarizeAuditLayers(receipts).outcome, 'failed');
    assert.equal(fs.readFileSync(path.join(temporaryRoot, '.tmp/test-asset-audit/logs/first.log'), 'utf8'), '[REDACTED]');
});

test('missing capabilities block owned IDs without fabricating execution', () =>
{
    const receipts = executeAuditLayers({
        root,
        profile: { layers: [{ id: 'browser', producerTier: 'browser', requirements: ['playwrightAll'], frameworks: ['playwright-dynamic'], command: ['never'] }] },
        preflight: { capabilities: { playwrightAll: { status: 'blocked' } }, source: { commit: 'abc', worktreeFingerprint: 'def' } },
        inventory: { assignments: [{ id: 'playwright:test', layerId: 'browser', invocationCount: 1, tierIds: ['browser'] }] },
        runId: 'audit-run',
        executor: () =>
        {
            throw new Error('must not execute');
        }
    });
    assert.equal(receipts[0].outcome, 'blocked');
    assert.equal(receipts[0].counts.executed, 0);
    assert.equal(receipts[0].counts.blocked, 1);
    assert.deepEqual(receipts[0].blockedTestIds, ['playwright:test']);
    assert.match(receipts[0].unexecuted[0].reason, /missing-capability/u);
});

test('a layer never reports tests owned by another canonical producer as executed', () =>
{
    const receipts = executeAuditLayers({
        root,
        profile: { layers: [{ id: 'node', producerTier: 'static-governance', requirements: [], frameworks: ['node-test'], command: ['ok'] }] },
        preflight: { capabilities: {}, source: { commit: 'abc', worktreeFingerprint: 'def' } },
        inventory: { assignments: [{ id: 'node:release-only', layerId: 'node', invocationCount: 1, tierIds: ['release-final'] }] },
        runId: 'audit-run',
        executor: () => ({ status: 0, output: '' })
    });
    assert.equal(receipts[0].counts.executed, 0);
    assert.equal(receipts[0].counts.skipped, 1);
    assert.deepEqual(receipts[0].skippedTestIds, ['node:release-only']);
    assert.equal(receipts[0].unexecuted[0].reason, 'canonical-producer-outside-audit-profile');
});

test('redaction removes every credential value without persisting its key', () =>
{
    const redacted = redactAuditText('token=abcd1234 password=secret5678', {
        NPM_TOKEN: 'abcd1234',
        DATABASE_PASSWORD: 'secret5678'
    });
    assert.equal(redacted, 'token=[REDACTED] password=[REDACTED]');
});
