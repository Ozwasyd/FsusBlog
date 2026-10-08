import assert from 'node:assert/strict';
import test from 'node:test';

const { distributionCatalog } = await import(new URL('../../tools/data-scale/distribution-catalog.mjs', import.meta.url));
const { canonicalDigest, deepFreeze, exactKeys } = await import(new URL('../../tools/data-scale/distribution-contract.mjs', import.meta.url));
const { inspectQueryScenarioApplicability } = await import(new URL('../../tools/data-scale/distribution-query-binding.mjs', import.meta.url));

// These owner inputs are synthetic structural controls; none is production evidence.
const caseIds = ['unit-query-one', 'unit-query-two'];

function applicability(scenarioId = 'zipf-hot-content')
{
    return caseIds.map((caseId) => ({
        caseId,
        requiredScenarioIds: [scenarioId],
        minimumNonUniformCoverage: 1,
        requiredMetricIds: ['hotness.gini'],
        owner: 'unit-only-query-owner'
    }));
}

test('canonical serialization refuses lossy fields, accessors, prototypes and sparse arrays', () =>
{
    const hidden = Object.defineProperty({}, 'x', { value: 1 });
    const accessor = Object.defineProperty({}, 'x', { get: () => 1, enumerable: true });
    const changedPrototype = Object.setPrototypeOf([1, 2], { map: () => [9] });
    for (const value of [hidden, accessor, changedPrototype, { x: undefined }, { x: NaN }, { x: -0 }, Array(2), new Date(), JSON.parse('{"__proto__":{"bad":1}}')])
    {
        assert.throws(() => canonicalDigest(value));
        assert.throws(() => deepFreeze(value));
    }
    assert.throws(() => exactKeys(hidden, ['x']));
    assert.throws(() => exactKeys({ x: 1, sql: 'unit-only-invalid-field' }, ['x']));
    assert.equal(canonicalDigest({ x: 1, y: 2 }), canonicalDigest({ y: 2, x: 1 }));
    assert.notEqual(canonicalDigest([1, 2]), canonicalDigest([2, 1]));
    const cycle = {};
    cycle.x = cycle;
    assert.throws(() => canonicalDigest(cycle));
});

test('missing original applicability remains blocked and cannot issue release evidence', () =>
{
    const result = inspectQueryScenarioApplicability({ caseIds });
    assert.equal(result.qualification, false);
    assert.equal(result.releaseEvidenceEligible, false);
    assert.ok(result.blockers.includes('query_owner_scenario_applicability_missing'));
    assert.ok(result.blockers.includes('query_owner_scenario_receipt_intake_missing'));
});

test('uniform-only applicability cannot meet any case requirement', () =>
{
    const result = inspectQueryScenarioApplicability({ caseIds, applicability: applicability('uniform-baseline') });
    assert.equal(result.status, 'invalid');
    assert.ok(result.errors.some((error) => error.includes('required_nonuniform_coverage_missing')));
});

test('non-uniform structural controls never qualify absent actual statistics and owner intake', () =>
{
    const result = inspectQueryScenarioApplicability({ caseIds, applicability: applicability() });
    assert.equal(result.qualification, false);
    assert.equal(result.releaseEvidenceEligible, false);
    assert.ok(result.blockers.length > 0);
    assert.equal(typeof result.applicabilityDigest, 'string');
    assert.ok(Object.isFrozen(result.caseIds));
});

test('missing, duplicate and unknown cases remain attributed independently', () =>
{
    const rows = applicability();
    rows[1] = { ...rows[0] };
    rows.push({ ...rows[0], caseId: 'unit-query-unknown' });
    const result = inspectQueryScenarioApplicability({ caseIds, applicability: rows });
    assert.ok(result.errors.some((error) => error.includes('unit-query-two:applicability_missing')));
    assert.ok(result.errors.some((error) => error.includes('case_unknown_or_duplicate')));
});

test('unknown scenario, metric, private threshold and zero nonuniform minimum fail closed', () =>
{
    const mutations = [
        (row) =>
        {
            row.requiredScenarioIds = ['unit-unknown-scenario'];
        },
        (row) =>
        {
            row.requiredMetricIds = ['unit-unknown-metric'];
        },
        (row) =>
        {
            row.minimumNonUniformCoverage = 0;
        },
        (row) =>
        {
            row.maxLatencyMs = 1;
        },
        (row) =>
        {
            row.requiredScenarioIds = ['zipf-hot-content', 'zipf-hot-content'];
        }
    ];
    for (const mutate of mutations)
    {
        const rows = applicability();
        mutate(rows[0]);
        assert.equal(inspectQueryScenarioApplicability({ caseIds, applicability: rows }).status, 'invalid');
    }
});

test('inventory invalidity and catalogue tamper cannot be masked by another case', () =>
{
    const catalog = structuredClone(distributionCatalog);
    catalog.scenarios[0].releaseEvidenceEligible = true;
    assert.equal(inspectQueryScenarioApplicability({ caseIds, applicability: applicability(), catalog }).status, 'invalid');
    assert.equal(inspectQueryScenarioApplicability({ caseIds: [...caseIds, caseIds[0]], applicability: applicability() }).status, 'invalid');
});

test('malformed catalogues preserve a structured invalid report', () =>
{
    for (const catalog of [null, {}, { ...distributionCatalog, scenarios: null }])
    {
        const result = inspectQueryScenarioApplicability({ caseIds, applicability: applicability(), catalog });
        assert.equal(result.status, 'invalid');
        assert.equal(result.qualification, false);
        assert.ok(result.errors.length > 0);
    }
});
