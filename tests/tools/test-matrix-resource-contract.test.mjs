import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const tiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]));

function requireTier(id)
{
    const tier = tiers.get(id);
    assert.ok(tier, `missing matrix tier: ${id}`);
    return tier;
}

test('native measurements reserve an exclusive benchmark window', () =>
{
    for (const id of ['backend-perf', 'backend-benchmark-regression', 'privacy-zk-comment-matrix'])
    {
        const tier = requireTier(id);
        assert.equal(tier.parallelizable, false, id);
        assert.equal(tier.maxParallel, 1, id);
        assert.ok(tier.exclusiveResources.includes('benchmark-window'), id);
    }
});

test('backend discovery and coverage share one instrumentation exclusion', () =>
{
    for (const id of [
        'backend-unit',
        'backend-api-integration',
        'backend-auth-state-machine',
        'backend-concurrency',
        'backend-property',
        'backend-golden',
        'coverage-backend'
    ])
    {
        assert.ok(requireTier(id).exclusiveResources.includes('backend-coverlet-instrumentation'), id);
    }
});

test('ordinary and coverage Vitest executions share one transform exclusion', () =>
{
    for (const id of ['frontend-unit-shard', 'coverage-frontend'])
    {
        assert.ok(requireTier(id).exclusiveResources.includes('frontend-vitest-unit'), id);
    }
});

test('browser-capable tiers cannot hide outside browser resources', () =>
{
    const browserTiers = matrix.tiers.filter((tier) => tier.requiresPlaywright !== 'none');
    assert.ok(browserTiers.length > 0);
    for (const tier of browserTiers)
    {
        assert.equal(tier.resourceClass, 'browser', tier.id);
    }
});
