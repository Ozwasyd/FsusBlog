import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
    distributionCatalog,
    distributionCatalogDigest,
    distributionScenarioDigest,
    distributionScenarioIds,
    validateDistributionCatalog
} = await import(new URL('../../tools/data-scale/distribution-catalog.mjs', import.meta.url));
const { canonicalDigest } = await import(new URL('../../tools/data-scale/distribution-contract.mjs', import.meta.url));
const { inspectQueryScenarioApplicability } = await import(new URL('../../tools/data-scale/distribution-query-binding.mjs', import.meta.url));
const { inspectExpectedQueryScenarioApplicability } = await import(new URL('../../tools/data-scale/expected-query-case-catalog.mjs', import.meta.url));
const { queryCaseIds } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function nonUniformScenario()
{
    const scenario = distributionCatalog.scenarios.find((row) => row.releaseEvidenceEligible === true);
    assert.ok(scenario, 'real source catalog must supply a non-uniform policy scenario');
    return scenario;
}

/** Synthetic owner declarations only; no measured statistics, expected cases, or receipts. */
function syntheticStructuralRows(scenario = nonUniformScenario(), metricStatus = 'specified')
{
    const metric = scenario.expectedStatistics.find((row) => row.status === metricStatus);
    assert.ok(metric, 'choose a real catalog metric by its explicit status');
    return queryCaseIds.map((caseId) => ({
        caseId,
        requiredScenarioIds: [scenario.id],
        minimumNonUniformCoverage: 1,
        requiredMetricIds: [metric.metricId],
        owner: 'synthetic-structural-control-only'
    }));
}

function originalReport(applicability)
{
    return inspectQueryScenarioApplicability({ caseIds: queryCaseIds, applicability });
}

function assertOriginalReport(applicability)
{
    const result = inspectExpectedQueryScenarioApplicability(applicability);
    assert.deepEqual(result, originalReport(applicability));
    assert.deepEqual(result.caseIds, queryCaseIds);
    assert.equal(result.qualification, false);
    assert.equal(result.releaseEvidenceEligible, false);
    assert.ok(result.blockers.includes('query_owner_scenario_receipt_intake_missing'));
    return result;
}

test('original source catalog identities match current authority bytes and all eight blockers remain visible', () =>
{
    assert.equal(distributionCatalog.contentDigest, distributionCatalogDigest(distributionCatalog));
    assert.deepEqual(distributionCatalog.scenarios.map((row) => row.id), distributionScenarioIds);
    for (const scenario of distributionCatalog.scenarios)
    {
        assert.equal(scenario.contentDigest, distributionScenarioDigest(scenario));
    }
    for (const reference of Object.values(distributionCatalog.authorities))
    {
        const source = fs.readFileSync(path.join(repositoryRoot, reference.path), 'utf8');
        assert.equal(reference.sourceDigest, canonicalDigest({ source }), reference.path);
    }
    const catalogResult = validateDistributionCatalog();
    assert.equal(catalogResult.status, 'blocked');
    assert.equal(catalogResult.valid, false);
    assert.deepEqual(catalogResult.errors, []);
    assert.equal(distributionCatalog.requiredCapabilities.length, 8);
    assert.deepEqual(catalogResult.blockers, distributionCatalog.requiredCapabilities
        .map((id) => `distribution_authority_unavailable:${id}`));
    const result = assertOriginalReport();
    for (const blocker of catalogResult.blockers)
    {
        assert.ok(result.blockers.includes(`catalog:${blocker}`), blocker);
    }
});

for (const value of [undefined, null, {}, 'synthetic-only', 0])
{
    test(`absent owner applicability ${JSON.stringify(value)} blocks the original full case inventory`, () =>
    {
        const result = assertOriginalReport(value);
        assert.equal(result.status, 'blocked');
        assert.ok(result.blockers.includes('query_owner_scenario_applicability_missing'));
        assert.equal(result.applicabilityDigest, null);
    });
}

test('explicit non-uniform synthetic structural rows exactly preserve the upstream report without qualification', () =>
{
    const scenario = nonUniformScenario();
    assert.equal(scenario.releaseEvidenceEligible, true);
    const rows = syntheticStructuralRows(scenario);
    assert.deepEqual(rows.map((row) => row.caseId), queryCaseIds);
    const before = structuredClone(rows);
    const result = assertOriginalReport(rows);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.errors, []);
    assert.equal(result.applicabilityDigest, canonicalDigest(rows));
    assert.deepEqual(rows, before);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.caseIds));
    assert.ok(Object.isFrozen(result.blockers));
});

test('original blocked metric references retain a separate blocker for every actual query case', () =>
{
    const rows = syntheticStructuralRows(nonUniformScenario(), 'blocked');
    const result = assertOriginalReport(rows);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.errors, []);
    for (const row of rows)
    {
        assert.ok(result.blockers.includes(`query:${row.caseId}:scenario:${row.requiredScenarioIds[0]}:metric:${row.requiredMetricIds[0]}:contract_blocked`));
    }
});

test('uniform-only structural rows fail independently for every original query case', () =>
{
    const uniform = distributionCatalog.scenarios.find((row) => row.releaseEvidenceEligible === false);
    assert.ok(uniform);
    const result = assertOriginalReport(syntheticStructuralRows(uniform));
    assert.equal(result.status, 'invalid');
    for (const caseId of queryCaseIds)
    {
        assert.ok(result.errors.includes(`query:${caseId}:required_nonuniform_coverage_missing`));
    }
});

test('empty applicability exposes each original missing case rather than qualifying an empty inventory', () =>
{
    const result = assertOriginalReport([]);
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.errors, queryCaseIds.map((caseId) => `query:${caseId}:applicability_missing`));
});

test('caller-provided wrapper object cannot replace the original query inventory', () =>
{
    const result = assertOriginalReport({ caseIds: ['synthetic-replacement'], applicability: [] });
    assert.equal(result.status, 'blocked');
    assert.ok(result.blockers.includes('query_owner_scenario_applicability_missing'));
    assert.deepEqual(result.caseIds, queryCaseIds);
});

for (const [name, mutate, expectedError] of [
    ['missing original case', (rows) =>
    {
        rows.pop();
    }, () => `query:${queryCaseIds.at(-1)}:applicability_missing`],
    ['duplicate original case', (rows) =>
    {
        rows.push(structuredClone(rows[0]));
    }, () => `query:${queryCaseIds[0]}:case_unknown_or_duplicate`],
    ['extra unregistered case', (rows) =>
    {
        rows.push({ ...structuredClone(rows[0]), caseId: 'synthetic-unregistered' });
    }, () => 'query:synthetic-unregistered:case_unknown_or_duplicate'],
    ['unknown scenario', (rows) =>
    {
        rows[0].requiredScenarioIds = ['synthetic-unregistered-scenario'];
    }, () => `query:${queryCaseIds[0]}:scenario_unknown:synthetic-unregistered-scenario`],
    ['unknown metric', (rows) =>
    {
        rows[0].requiredMetricIds = ['synthetic-unregistered-metric'];
    }, (rows) => `query:${queryCaseIds[0]}:metric_unknown:${rows[0].requiredScenarioIds[0]}:synthetic-unregistered-metric`],
    ['duplicate scenario', (rows) =>
    {
        rows[0].requiredScenarioIds.push(rows[0].requiredScenarioIds[0]);
    }, () => `query:${queryCaseIds[0]}:requiredScenarioIds_invalid`],
    ['duplicate metric', (rows) =>
    {
        rows[0].requiredMetricIds.push(rows[0].requiredMetricIds[0]);
    }, () => `query:${queryCaseIds[0]}:requiredMetricIds_invalid`],
    ['zero coverage', (rows) =>
    {
        rows[0].minimumNonUniformCoverage = 0;
    }, () => `query:${queryCaseIds[0]}:nonuniform_requirement_invalid`],
    ['missing owner', (rows) =>
    {
        rows[0].owner = '';
    }, () => `query:${queryCaseIds[0]}:owner_missing`],
    ['private threshold', (rows) =>
    {
        rows[0].maxLatencyMs = 1;
    }, () => `query:${queryCaseIds[0]}:applicability_fields_invalid`],
    ['SQL field', (rows) =>
    {
        rows[0].sql = 'SELECT 1';
    }, () => `query:${queryCaseIds[0]}:applicability_fields_invalid`],
    ['copied actual statistics', (rows) =>
    {
        rows[0].actualStatistics = {};
    }, () => `query:${queryCaseIds[0]}:applicability_fields_invalid`],
    ['second inventory field', (rows) =>
    {
        rows[0].caseIds = ['synthetic-replacement'];
    }, () => `query:${queryCaseIds[0]}:applicability_fields_invalid`],
    ['null row', (rows) =>
    {
        rows[0] = null;
    }, () => 'query:unknown:applicability_object_invalid']
])
{
    test(`original inspector rejection is preserved exactly for ${name}`, () =>
    {
        const rows = syntheticStructuralRows();
        mutate(rows);
        const result = assertOriginalReport(rows);
        assert.equal(result.status, 'invalid');
        assert.ok(result.errors.includes(expectedError(rows)), JSON.stringify(result.errors));
    });
}

for (const [name, applicability] of [['undefined row', [undefined]], ['bigint row', [1n]]])
{
    test(`original canonical serializer exception is forwarded unchanged for ${name}`, () =>
    {
        let originalError;
        assert.throws(() => originalReport(applicability), (error) =>
        {
            originalError = error;
            return error.message === 'distribution_noncanonical_json';
        });
        assert.throws(() => inspectExpectedQueryScenarioApplicability(applicability), (error) =>
        {
            assert.equal(error.constructor, originalError.constructor);
            assert.equal(error.message, originalError.message);
            return true;
        });
    });
}
