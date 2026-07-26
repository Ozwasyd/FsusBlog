import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    parseMatrix,
    tierExecutionDependencies
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const tiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]));

function dependencyClosure(id, seen = new Set())
{
    if (seen.has(id))
    {
        return seen;
    }
    const tier = tiers.get(id);
    assert.ok(tier, `missing matrix tier ${id}`);
    seen.add(id);
    for (const dependency of tierExecutionDependencies(tier))
    {
        dependencyClosure(dependency, seen);
    }
    return seen;
}

function runSmartGatePlan(changedFile)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-browserless-plan-'));
    const changedFiles = path.join(directory, 'changed-files.txt');
    const output = path.join(directory, 'plan.json');
    writeFileSync(changedFiles, `${changedFile}\n`);
    const result = spawnSync(process.execPath, [
        'tools/run-test-matrix.mjs',
        'ci-pr-plan',
        '--changed-files', changedFiles,
        '--event-name', 'pull_request',
        '--out', output
    ], { cwd: root, encoding: 'utf8' });
    try
    {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return JSON.parse(readFileSync(output, 'utf8'));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('production correctness dependency closure has no browser capability', () =>
{
    const closure = [...dependencyClosure('production-correctness')].map((id) => tiers.get(id));
    assert.ok(closure.length > 1);
    assert.deepEqual(closure.filter((tier) => tier.requiresPlaywright !== 'none'), []);
    assert.deepEqual(closure.filter((tier) => tier.resourceClass === 'browser'), []);
    assert.ok(closure.some((tier) => tier.id === 'production-build-artifacts'));
});

test('every browser-capable tier declares the browser resource boundary', () =>
{
    const browserTiers = matrix.tiers.filter((tier) => tier.requiresPlaywright !== 'none');
    assert.ok(browserTiers.length > 0);
    for (const tier of browserTiers)
    {
        assert.equal(tier.resourceClass, 'browser', tier.id);
    }
});

test('release final binds one immutable browser contract as evidence without scheduling it', () =>
{
    const correctness = dependencyClosure('production-correctness');
    const release = [...dependencyClosure('release-final')].map((id) => tiers.get(id));
    const browserTiers = release.filter((tier) => tier.requiresPlaywright !== 'none');
    assert.equal(browserTiers.length, 0);
    assert.ok(tiers.get('release-final').requiresEvidenceFrom.includes('browser-contract'));
    assert.ok(tierExecutionDependencies(tiers.get('browser-contract')).includes('production-build-artifacts'));
    assert.equal(correctness.has('browser-contract'), false);
});

test('smart-gate behavior selects browser work only for declared boundary inputs', () =>
{
    const ordinary = runSmartGatePlan('docs/testing.md');
    assert.equal(ordinary.selectedTierIds.includes('browser-contract'), false);
    assert.ok(ordinary.selectedTierIds.every((id) => tiers.get(id)?.requiresPlaywright === 'none'));

    for (const boundaryPath of [
        'src/frontend/src/router/index.ts',
        'src/frontend/src/api/auth.ts',
        'src/frontend/src/adapters/binary/passkeyAdapter.ts',
        'src/frontend/src/composables/usePasskeyLogin.ts',
        'src/frontend/public/sw.js',
        '.github/actions/consume-production-build/action.yml'
    ])
    {
        const plan = runSmartGatePlan(boundaryPath);
        assert.ok(plan.selectedTierIds.includes('browser-contract'), boundaryPath);
        assert.ok(plan.selectedTierIds.includes('production-build-artifacts'), boundaryPath);
    }

    for (const adjacentPath of [
        'src/frontend/src/api/article.ts',
        'src/frontend/src/composables/usePagedListState.ts',
        'src/frontend/public/unrelated-browser-file.txt'
    ])
    {
        assert.equal(runSmartGatePlan(adjacentPath).selectedTierIds.includes('browser-contract'), false, adjacentPath);
    }
});
