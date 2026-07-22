import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    summarizeBackendBuildAuthoritySamples,
    validateBackendBuildAuthorityComparison
} = await import(pathToFileURL(path.join(root, 'tools/test/measure-backend-production-build-authority.mjs')).href);

const sample = (overrides = {}) => ({
    status: 'success',
    buildRequestCount: 2,
    testhostStartupCount: 1,
    executedTestCaseCount: 7000,
    executedMethodCount: 1200,
    ...overrides
});

const measuredSample = (executionMode, testhostStartupCount, overrides = {}) => ({
    ...sample({ testhostStartupCount }),
    exactOnce: true,
    allPassed: true,
    executionMode,
    buildCpuSeconds: 10,
    unionCpuSeconds: 20,
    wallSeconds: 30,
    binObjBytes: 40,
    ...overrides
});

function comparisonFixture()
{
    const beforeSamples = Array.from({ length: 3 }, () => measuredSample('single-testhost-with-governance-postlude', 2));
    const afterSamples = Array.from({ length: 3 }, () => measuredSample('single-testhost-exact-union', 1));
    return {
        schema: 'fsusblog.backend-production-build-authority-comparison.v1',
        before: {
            sourceState: { commit: 'before', worktreeDigest: 'sha256:before' },
            machine: { cpu: 8, memoryBytes: 16 },
            summary: summarizeBackendBuildAuthoritySamples(beforeSamples),
            samples: beforeSamples
        },
        after: {
            sourceState: { commit: 'after', worktreeDigest: 'sha256:after' },
            machine: { cpu: 8, memoryBytes: 16 },
            summary: summarizeBackendBuildAuthoritySamples(afterSamples),
            samples: afterSamples
        }
    };
}

test('before-after evidence proves one exact union without changing the authoritative universe', () =>
{
    const fixture = comparisonFixture();
    assert.deepEqual(validateBackendBuildAuthorityComparison(fixture), {
        status: 'success',
        executedTestCaseCount: 7000,
        executedMethodCount: 1200,
        testhostStartupDelta: -1,
        beforeMetrics: {
            buildCpuSecondsMedian: 10,
            unionCpuSecondsMedian: 20,
            wallSecondsMedian: 30,
            binObjBytesMedian: 40
        },
        afterMetrics: {
            buildCpuSecondsMedian: 10,
            unionCpuSecondsMedian: 20,
            wallSecondsMedian: 30,
            binObjBytesMedian: 40
        }
    });

    const lostRequirement = structuredClone(fixture);
    lostRequirement.after.samples[0].executedTestCaseCount -= 1;
    assert.throws(() => validateBackendBuildAuthorityComparison(lostRequirement), /disagree on executedTestCaseCount/u);

    const restoredPostlude = structuredClone(fixture);
    restoredPostlude.after.samples.forEach((item) =>
    {
        item.testhostStartupCount = 2;
    });
    restoredPostlude.after.summary = summarizeBackendBuildAuthoritySamples(restoredPostlude.after.samples);
    assert.throws(() => validateBackendBuildAuthorityComparison(restoredPostlude), /retirement is not proven/u);
});

test('retained issue 1389 evidence remains internally reproducible', () =>
{
    const evidence = JSON.parse(fs.readFileSync(
        new URL('../performance/backend-production-build-authority-before-after.json', import.meta.url),
        'utf8'
    ));
    const result = validateBackendBuildAuthorityComparison(evidence);
    assert.equal(result.status, 'success');
    assert.equal(result.executedTestCaseCount, 4862);
    assert.equal(result.executedMethodCount, 3705);
    assert.equal(result.testhostStartupDelta, -1);
});

test('three successful backend fresh samples require a stable execution conclusion', () =>
{
    assert.deepEqual(summarizeBackendBuildAuthoritySamples([sample(), sample(), sample()]), {
        status: 'success',
        sampleCount: 3,
        conclusionStable: true,
        buildRequestCount: 2,
        testhostStartupCount: 1,
        executedTestCaseCount: 7000,
        executedMethodCount: 1200
    });
    assert.throws(
        () => summarizeBackendBuildAuthoritySamples([sample(), sample(), sample({ testhostStartupCount: 2 })]),
        /disagree on testhostStartupCount/u
    );
    assert.throws(
        () => summarizeBackendBuildAuthoritySamples([sample(), sample({ status: 'failed' }), sample()]),
        /three successful samples/u
    );
});
