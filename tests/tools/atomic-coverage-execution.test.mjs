import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

const { compileCoverageProducerDag } = await import(new URL('../../tools/coverage/atomic-coverage-compiler-bridge.mjs', import.meta.url));
const { executeCoverageProducerDag } = await import(new URL('../../tools/coverage/atomic-coverage-execution.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));

import { coverageCompilerFixture } from './support/atomic-coverage-compiler-fixtures.mjs';

function launch(result, id)
{
    return result.launches.find((item) => item.producerId === id);
}

test('ordinary coverage required input absence fails before an attempt and retains the real rejection in both projections', async (t) =>
{
    const fixture = coverageCompilerFixture(t);
    const compiled = compileCoverageProducerDag(fixture);
    const step = compiled.steps.find((item) => item.id === 'coverage-merge');
    const runRoot = path.join(fixture.executionOptions.context.evidenceRoot, fixture.plan.identity.runId);
    let checks = 0;
    let original;
    fixture.executionOptions.producerContexts[step.id].requiredInputAdmission = {
        inputClosureRef: step.inputClosureRef,
        validate: (ready) =>
        {
            checks += 1;
            assert.deepEqual(ready.dependencyOutcomes, { 'coverage-backend': 'success', 'coverage-frontend': 'success' });
            assert.ok(ready.runtimeCapacity.cpuUnits > 0);
            assert.equal(fs.existsSync(path.join(runRoot, step.id)), false);
            try
            {
                fs.readFileSync(path.join(fixture.root, 'ordinary-required-input.json'));
            }
            catch (error)
            {
                original = error;
                throw error;
            }
        }
    };
    const result = await executeCoverageProducerDag(fixture);
    assert.equal(checks, 1);
    assert.equal(original.code, 'ENOENT');
    assert.equal(result.status, 'failed');
    const refused = launch(result, step.id);
    assert.equal(refused.terminalState, 'failed');
    assert.equal(refused.reasonCode, 'required-input-admission-failed');
    assert.equal(refused.attemptSpawnCount, 0);
    assert.equal(refused.physicalSpawnCount, 0);
    assert.equal(fs.existsSync(path.join(runRoot, step.id)), false);
    assert.equal(fs.existsSync(path.join(fixture.root, '.tmp/coverage/merged/Summary.json')), false);
    const evidence = JSON.parse(fs.readFileSync(path.join(fixture.root, refused.admissionRef.path)));
    assert.equal(evidence.reason, original.message);
    assert.deepEqual(evidence.inputClosureRef, step.inputClosureRef);
    const terminal = result.terminalVector.receipts.find((item) => item.producerId === step.id);
    assert.equal(terminal.attemptRef, null);
    assert.deepEqual(terminal.primaryFailureRefs, [step.id]);
    const projected = result.projections[0].nodes.find((item) => item.producerId === step.id);
    assert.equal(projected.terminalState, 'failed');
    assert.equal(projected.reasonCode, terminal.reasonCode);
    assert.equal(projected.reason, original.message);
    assert.deepEqual(projected.primaryFailureRefs, terminal.primaryFailureRefs);
    assert.deepEqual(projected.admissionRef, refused.admissionRef);
    assert.deepEqual(Object.keys(result.projections[0].summaryRefs).sort(), ['backend', 'frontend']);
    assert.deepEqual(result.projections[1].nodes.map((item) => item.terminalState), ['blocked', 'blocked', 'clean-success', 'clean-success']);
    for (const id of ['coverage-threshold-backend', 'coverage-threshold-frontend'])
    {
        assert.equal(launch(result, id).terminalState, 'success');
        assert.equal(launch(result, id).physicalSpawnCount, 1);
    }
    assert.equal(result.qualificationEligible, false);
});

test('ordinary coverage required input validation preserves admitted ordering and exactly one unchanged merge attempt', async (t) =>
{
    const fixture = coverageCompilerFixture(t);
    const compiled = compileCoverageProducerDag(fixture);
    const step = compiled.steps.find((item) => item.id === 'coverage-merge');
    const runRoot = path.join(fixture.executionOptions.context.evidenceRoot, fixture.plan.identity.runId);
    const requiredPath = path.join(fixture.root, 'ordinary-required-input.json');
    fs.writeFileSync(requiredPath, '{"required":true}');
    let checks = 0;
    fixture.executionOptions.producerContexts[step.id].requiredInputAdmission = {
        inputClosureRef: step.inputClosureRef,
        validate: async (ready) =>
        {
            checks += 1;
            assert.ok(Object.isFrozen(ready));
            assert.deepEqual(ready.command, step.command);
            assert.deepEqual(ready.inputClosureRef, step.inputClosureRef);
            assert.deepEqual(ready.dependencyOutcomes, { 'coverage-backend': 'success', 'coverage-frontend': 'success' });
            assert.ok(ready.runtimeCapacity.cpuUnits > 0);
            assert.equal(fs.existsSync(path.join(runRoot, step.id)), false);
            for (const id of step.dependsOn)
            {
                const receipt = JSON.parse(fs.readFileSync(path.join(runRoot, id, 'attempt-1/receipt.json')));
                assert.equal(receipt.status, 'clean-success');
            }
            await fs.promises.access(requiredPath, fs.constants.R_OK);
        }
    };
    const result = await executeCoverageProducerDag(fixture);
    assert.equal(checks, 1);
    assert.equal(result.status, 'success');
    assert.equal(launch(result, step.id).attemptSpawnCount, 1);
    assert.equal(launch(result, step.id).physicalSpawnCount, 1);
    const attempt = JSON.parse(fs.readFileSync(path.join(runRoot, step.id, 'attempt-1/receipt.json')));
    assert.equal(attempt.attemptNumber, 1);
    assert.equal(attempt.maxAttempts, 1);
    assert.deepEqual(attempt.command, step.command);
    assert.equal(fs.existsSync(path.join(runRoot, step.id, 'attempt-2')), false);
    const observation = JSON.parse(fs.readFileSync(path.join(runRoot, step.id, 'attempt-1/coverage-launch.json')));
    assert.equal(observation.commandDigest, digestCanonical(fixture.plan.producers.find((item) => item.id === step.id).command));
    assert.ok(result.projections.every((item) => item.status === 'clean-success'));
    assert.equal(result.qualificationEligible, false);
});

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
