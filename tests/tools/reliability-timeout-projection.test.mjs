import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {parseMatrix} = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const {loadReleaseReliabilityCatalog, releaseReliabilitySchedulerProjection, validateReleaseReliabilitySchedulerCatalog, validateReleaseReliabilitySchedulerMatrix} = await import(new URL('../../tools/test-matrix/release-reliability-scheduler-projection.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = loadReleaseReliabilityCatalog({ root });
const schedulerAuthorityAvailable = Object.hasOwn(catalog, 'schedulerTimeoutPolicies');
const schedulerAuthorityTest = {
    skip: schedulerAuthorityAvailable ? false : 'scheduler catalog authority is activated by the dependent projection slice'
};
const registry = JSON.parse(fs.readFileSync(
    path.join(root, 'config/testing/release-reliability-lifecycle-action-registry.json'),
    'utf8'
));

test('timeouts bind scenario policies and retain measurement plus independent margins', schedulerAuthorityTest, () =>
{
    assert.deepEqual(validateReleaseReliabilitySchedulerCatalog(catalog, {
        lifecycleRegistry: registry
    }), []);
    const projected = Object.fromEntries(catalog.scenarios.map((scenario) => [
        scenario.id,
        releaseReliabilitySchedulerProjection(catalog, scenario.id).timeoutMinutes
    ]));
    assert.deepEqual(projected, {
        'release-soak-min': 8,
        'release-load-peak': 3,
        'release-load-burst': 2,
        'release-data-scale-m': 22,
        'release-mutation-critical-slice': 16,
        'release-memory-leak-budget': 7,
        'release-open-handle-budget': 6
    });
});

test('data-scale measurement deadline matches the current catalog without expanding its outer budget', schedulerAuthorityTest, () =>
{
    const scenario = catalog.scenarios.find((entry) => entry.id === 'release-data-scale-m');
    const policy = catalog.schedulerTimeoutPolicies.find((entry) => entry.id === scenario.scheduler.timeoutPolicyId);
    const action = registry.actions.find((entry) => entry.actionId === scenario.isolation.lifecycle.measurement);
    assert.equal(policy.measurementBudgetMs, 1260000);
    assert.equal(policy.outerTimeoutMs, 1320000);
    assert.equal(action.timeoutPolicy.timeoutMs, policy.measurementBudgetMs);
    assert.equal(action.timeoutPolicy.terminateGraceMs, 5000);
    assert.equal(registry.actions.find((entry) => entry.actionId === 'data-scale-require-dedicated-runtime')
        .timeoutPolicy.timeoutMs, 600000);
    assert.equal(registry.actions.find((entry) => entry.actionId === 'data-scale-require-dedicated-runtime-teardown')
        .timeoutPolicy.timeoutMs, 120000);
});

test('data-scale stale and just-below-minimum measurement deadlines fail closed', schedulerAuthorityTest, () =>
{
    for (const timeoutMs of [600000, 1259999])
    {
        const candidate = structuredClone(registry);
        candidate.actions.find((action) => action.actionId === 'data-scale-run-measurement')
            .timeoutPolicy.timeoutMs = timeoutMs;
        assert.deepEqual(validateReleaseReliabilitySchedulerCatalog(catalog, {
            lifecycleRegistry: candidate
        }), ['scenario release-data-scale-m measurement deadline is below scheduler policy minimum']);
    }
});

test('uniform five-minute matrix timeout cannot pass projection validation', schedulerAuthorityTest, () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    for (const scenario of catalog.scenarios)
    {
        matrix.tiers.find((tier) => tier.id === scenario.id).timeoutMinutes = 5;
    }
    assert.match(
        validateReleaseReliabilitySchedulerMatrix(matrix, catalog).join('\n'),
        /timeoutMinutes/u
    );
});

test('measurement action deadline below memory or handle minimum fails closed', schedulerAuthorityTest, () =>
{
    for (const [actionId, timeoutMs] of [
        ['memory-run-measurement', 314999],
        ['open-handle-run-measurement', 284999]
    ])
    {
        const candidate = structuredClone(registry);
        candidate.actions.find((action) => action.actionId === actionId)
            .timeoutPolicy.timeoutMs = timeoutMs;
        assert.match(
            validateReleaseReliabilitySchedulerCatalog(catalog, {
                lifecycleRegistry: candidate
            }).join('\n'),
            /below scheduler policy minimum/u
        );
    }
});
