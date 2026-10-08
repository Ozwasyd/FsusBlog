import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

const { compileCoverageProducerDag } = await import(new URL('../../tools/coverage/atomic-coverage-compiler-bridge.mjs', import.meta.url));
const { executeCoverageProducerDag } = await import(new URL('../../tools/coverage/atomic-coverage-execution.mjs', import.meta.url));

import { coverageCompilerFixture } from './support/atomic-coverage-compiler-fixtures.mjs';

function launch(result, id)
{
    return result.launches.find((item) => item.producerId === id);
}

test('canonical compiler and existing attempts execute seven isolated actions once, preserving real merger/checker outputs', async (t) =>
{
    const fixture = coverageCompilerFixture(t);
    const compiled = compileCoverageProducerDag(fixture);
    assert.equal(compiled.steps.length, 9);
    const result = await executeCoverageProducerDag(fixture);
    assert.equal(result.status, 'success');
    assert.equal(result.qualificationEligible, false);
    assert.ok(result.launches.every((item) => item.attemptSpawnCount === 1 && item.physicalSpawnCount === 1));
    assert.ok(result.projections.every((projection) => projection.status === 'clean-success'));
    const merged = JSON.parse(fs.readFileSync(path.join(fixture.root, '.tmp/coverage/merged/Summary.json')));
    assert.deepEqual(merged.totals.lines, { covered: 200, total: 200 });
    assert.deepEqual(Object.keys(result.projections[0].summaryRefs).sort(), ['backend', 'frontend', 'merged']);
});

for (const failedDomain of ['backend', 'frontend'])
{
    test(`actual ${failedDomain} fixture collection failure preserves sibling and blocks merge with zero attempt/physical spawn`, async (t) =>
    {
        const fixture = coverageCompilerFixture(t, { failedDomain });
        const result = await executeCoverageProducerDag(fixture);
        const sibling = failedDomain === 'backend' ? 'frontend' : 'backend';
        assert.equal(result.status, 'failed');
        assert.equal(launch(result, `coverage-${failedDomain}`).physicalSpawnCount, 1);
        assert.equal(launch(result, `coverage-${sibling}`).terminalState, 'success');
        assert.equal(launch(result, `coverage-${sibling}`).physicalSpawnCount, 1);
        assert.deepEqual(launch(result, 'coverage-merge'), { producerId: 'coverage-merge', terminalState: 'blocked', attemptSpawnCount: 0, physicalSpawnCount: 0 });
        assert.equal(launch(result, `coverage-threshold-${sibling}`).terminalState, 'success');
        assert.equal(launch(result, `coverage-threshold-${failedDomain}`).attemptSpawnCount, 0);
        assert.equal(fs.existsSync(path.join(fixture.root, '.tmp/attempts/coverage-compiled-run/coverage-merge')), false);
        assert.equal(fs.existsSync(path.join(fixture.root, '.tmp/coverage/merged/Summary.json')), false);
        assert.equal(result.projections[0].nodes.length, 3);
        assert.equal(result.projections[1].nodes.length, 4);
    });
}

test('real merged/backend threshold failures remain independent and all four terminals survive projection', async (t) =>
{
    const fixture = coverageCompilerFixture(t, { backendCoverage: 0, environment: { FSUSBLOG_COVERAGE_LINE_THRESHOLD: '101' } });
    const result = await executeCoverageProducerDag(fixture);
    assert.equal(launch(result, 'coverage-threshold-merged').terminalState, 'failed');
    assert.equal(launch(result, 'coverage-threshold-backend').terminalState, 'failed');
    assert.equal(launch(result, 'coverage-threshold-frontend').terminalState, 'success');
    assert.equal(launch(result, 'coverage-scope-snapshot').terminalState, 'success');
    assert.ok(result.launches.every((item) => item.attemptSpawnCount === 1 && item.physicalSpawnCount === 1));
    assert.deepEqual(result.projections[1].nodes.map((node) => node.terminalState), ['clean-success', 'failed-no-retry', 'failed-no-retry', 'clean-success']);
});

test('native membership plan without original execution receipt never becomes clean collection or unlocks merge', async (t) =>
{
    const fixture = coverageCompilerFixture(t, { nativePlanWithoutReceipt: true });
    const result = await executeCoverageProducerDag(fixture);
    assert.equal(launch(result, 'coverage-backend').terminalState, 'failed');
    assert.equal(launch(result, 'coverage-frontend').terminalState, 'failed');
    assert.equal(launch(result, 'coverage-merge').attemptSpawnCount, 0);
    for (const id of ['coverage-backend', 'coverage-frontend'])
    {
        const receipt = JSON.parse(fs.readFileSync(path.join(fixture.root, `.tmp/attempts/coverage-compiled-run/${id}/attempt-1/receipt.json`)));
        assert.deepEqual(receipt.executedTestIds, []);
        assert.equal(receipt.status, 'failed-no-retry');
        const log = fs.readFileSync(path.join(fixture.root, `.tmp/attempts/coverage-compiled-run/${id}/attempt-1/stderr.log`), 'utf8');
        assert.match(log, /native collection execution receipt unavailable/u);
    }
});
