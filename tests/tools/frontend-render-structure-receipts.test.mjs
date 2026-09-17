/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tool under test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';


import {
    joinFrontendRenderStructureReceipts,
    sealFrontendStructureProducerReceipt,
    writeFrontendStructureProducerReceipt
} from '../../tools/test/frontend-render-structure-receipts.mjs';
import { buildLocalStaticManifest } from '../../tools/test/local-static-governance.mjs';
import { loadCommandGroup } from '../../tools/test-matrix/command-groups.mjs';

const identity = {
    runId: 'production-run-1',
    source: { commit: 'abc123', worktreeFingerprint: 'def456' }
};

function producer(checkId, artifact, overrides = {})
{
    return sealFrontendStructureProducerReceipt({
        checkId,
        status: 'ok',
        artifact,
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        ...identity,
        ...overrides
    });
}

test('frontend render structure joins current producer receipts without executing checkers', () =>
{
    const result = joinFrontendRenderStructureReceipts({
        ...identity,
        receipts: [
            producer('dom-depth-static', '.tmp/frontend/dom-depth-static.json'),
            producer('markdown-render-budget', '.tmp/frontend/markdown-render-budget.json')
        ]
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.checks, ['dom-depth-static', 'markdown-render-budget']);
    assert.equal(result.physicalExecutions['dom-depth-static'], 1);
    assert.equal(result.physicalExecutions['markdown-render-budget'], 1);
});

test('failed, stale, wrong-source, missing and duplicate producer receipts fail closed', () =>
{
    const current = [
        producer('dom-depth-static', '.tmp/frontend/dom-depth-static.json'),
        producer('markdown-render-budget', '.tmp/frontend/markdown-render-budget.json')
    ];
    assert.throws(() => joinFrontendRenderStructureReceipts({
        ...identity,
        receipts: [current[0], { ...current[1], status: 'failed' }]
    }), /producer failed/u);
    assert.throws(() => joinFrontendRenderStructureReceipts({
        ...identity,
        receipts: [current[0], { ...current[1], runId: 'old-run' }]
    }), /run identity mismatch/u);
    assert.throws(() => joinFrontendRenderStructureReceipts({
        ...identity,
        receipts: [current[0], { ...current[1], source: { ...identity.source, commit: 'old' } }]
    }), /source identity mismatch/u);
    assert.throws(() => joinFrontendRenderStructureReceipts({
        ...identity,
        receipts: current.slice(0, 1)
    }), /missing producer receipt/u);
    assert.throws(() => joinFrontendRenderStructureReceipts({
        ...identity,
        receipts: [...current, current[0]]
    }), /duplicate producer receipt/u);
});

test('producer receipt is digest-sealed and atomically persisted', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-structure-receipt-'));
    const file = path.join(directory, 'receipt.json');
    const receipt = producer('dom-depth-static', '.tmp/frontend/dom-depth-static.json');
    writeFrontendStructureProducerReceipt(file, receipt);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), receipt);
    assert.ok(receipt.contentDigest.startsWith('sha256:'));
});

test('frontend-render-structure lane is a receipt join and never invokes either checker', () =>
{
    const lane = fs.readFileSync(
        new URL('../../tools/test/lanes/frontend-render-structure.sh', import.meta.url),
        'utf8'
    );
    assert.match(lane, /join-frontend-render-structure-receipts\.mjs/u);
    assert.doesNotMatch(lane, /npm .*check:dom-depth-static/u);
    assert.doesNotMatch(lane, /npm .*check:markdown-render-budget/u);
});

test('local production plan physically owns each structure producer exactly once', () =>
{
    const root = path.resolve(new URL('../..', import.meta.url).pathname);
    const group = loadCommandGroup(root, 'frontend-static-governance');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
    const local = buildLocalStaticManifest(group, packageJson.scripts);
    for (const script of ['check:dom-depth-static', 'check:markdown-render-budget'])
    {
        assert.equal(local.commands.filter((entry) => entry.script === script).length, 1);
    }
});
