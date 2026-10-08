import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fixture } from './support/production-fresh-performance-fixture.mjs';

const { byteDigest, digest, identityFields, loadPerformanceRun, readDocument, runSchema, seal } = await import(new URL('../../tools/perf/production-fresh-contract.mjs', import.meta.url));
const { bindPerformanceIdentityToNativeCpu, inspectNativePerformanceSources, projectNativeCpuCapacity, projectCanonicalResourceState, projectCanonicalNoise } =
    await import(new URL('../../tools/perf/production-fresh-native-adapter.mjs', import.meta.url));
const { resolveRunCpuCapacity, activateCpuCalibration } = await import(new URL('../../tools/test/cpu-calibration-loader.mjs', import.meta.url));
const { sealCpuValue, cpuDigest } = await import(new URL('../../tools/test/cpu-calibration-contract.mjs', import.meta.url));
const { createCpuCandidatePlan } = await import(new URL('../../tools/test/cpu-calibration-cohort.mjs', import.meta.url));
const { machine, identityFor, writeActivationFixture } = await import(new URL('./cpu-calibration-test-support.mjs', import.meta.url));
const { integrateResourceGrantHistory, writeResourceUtilizationEvidence } = await import(new URL('../../tools/test-matrix/resource-utilization.mjs', import.meta.url));
const { bindMeasurementNoiseAuthority, readMeasurementNoisePolicy, evaluateMeasurementObservation } =
    await import(new URL('../../tools/test/measurement-noise-envelope.mjs', import.meta.url));

function nativeFixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-native-adapter-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const put = (locator, value) =>
    {
        const bytes = `${JSON.stringify(value, null, 4)}\n`;
        fs.writeFileSync(path.join(root, locator), bytes);
        return { locator, sha256: byteDigest(bytes) };
    };
    const topology = machine();
    const plan = { steps: [{ bundleId: 'build', stepId: 'compile', cpuHeavy: true, schedulerOwnerId: 'explicit-build-owner' }] };
    const identity = { ...identityFor(topology), physicalPlan: cpuDigest(plan) };
    const cpuPlan = createCpuCandidatePlan({ topology, identity, executionAdapterDigest: cpuDigest('fixture-adapter'), mode: 'production' });
    // This reuses the CPU owner's explicit production-shaped contract fixture; no hardware qualification is claimed.
    const activated = writeActivationFixture(t, cpuPlan);
    activateCpuCalibration(activated.pointerPath, activated.reference);
    const selection = resolveRunCpuCapacity({ runId: 'current', topology, identity, activePointerPath: activated.pointerPath });
    const binding = { runId: 'current', attempt: 1, sourceDigest: digest('native-source'), buildDigest: digest('native-build'), planDigest: digest(plan) };
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${binding.sourceDigest}` };
    const grantHistory = [{ atMs: 1000, cpuUnits: 8, memoryGiB: 1 }];
    const grantIntegration = integrateResourceGrantHistory(grantHistory, 1000, 1800);
    const rawStep = { status: 'measured', startedAtMs: 1000, finishedAtMs: 1800, actualCpuSeconds: 6,
        grantedCpuSeconds: grantIntegration.cpuSeconds, grantHistory, grantIntegration,
        peakRssBytes: 1000, averageRssBytes: 500, readBytes: null, writeBytes: null,
        voluntaryContextSwitches: 20, involuntaryContextSwitches: 2,
        exitedProcessAccounting: 'kernel-rusage-including-descendants' };
    const fragment = { schema: 'fsusblog.production.bundle-resource-utilization.v1', status: 'complete', incomplete: false,
        schedulerRunId: binding.runId, physicalBundleId: 'build', sourceState, steps: { compile: rawStep } };
    const fragmentRef = put('native-fragment.json', fragment);
    const waits = { intervals: [{ ownerId: 'explicit-build-owner', category: 'dependency-blocked', detail: ['dependency-authority'],
        startedAtMs: 1800, finishedAtMs: 1900, durationMs: 100 }], totalsMs: { 'dependency-blocked': 100 } };
    const checkpoint = { runId: binding.runId, sourceState, revision: 3, mode: 'fresh', authoritative: true, status: 'success',
        startedAt: new Date(1000).toISOString(), criticalPath: { durationMs: 800, tierIds: ['explicit-build-owner'] }, resourceUtilization: { waits } };
    const checkpointRef = put('native-checkpoint.json', checkpoint);
    const report = { status: 'complete', incomplete: false, runId: binding.runId, sourceState,
        checkpoint: { path: checkpointRef.locator, digest: `sha256:${checkpointRef.sha256}`, revision: 3 },
        wallSeconds: 1, actualCpuSeconds: 6, grantedCpuSeconds: grantIntegration.cpuSeconds,
        scheduler: { waits, criticalPath: checkpoint.criticalPath },
        bundles: { build: { resourceUtilization: fragment, bundleMetrics: fragment,
            bindings: { resourceFile: fragmentRef.locator, resourceDigest: `sha256:${fragmentRef.sha256}` } } } };
    writeResourceUtilizationEvidence(path.join(root, 'native-resource.json'), report, {
        runId: binding.runId, sourceState, checkpoint: { revision: 3 }
    });
    const resourceRef = readDocument(root, 'native-resource.json').ref;
    const policy = readMeasurementNoisePolicy();
    const policyRef = put('native-noise-policy.json', policy);
    const metrics = Object.fromEntries(Object.entries(policy.metrics).map(([name, rule]) => [name, rule.minimum ?? 0]));
    const record = { observation: { durationMs: 1000, metrics }, evaluation: evaluateMeasurementObservation({ metrics }, policy) };
    const noise = bindMeasurementNoiseAuthority({ schema: 'fsusblog.measurement-noise-envelope.v1', windowId: 'benchmark', status: 'clean',
        qualificationEligible: true, productConclusionEligible: true, productOutcome: { status: 'completed' },
        timing: { admissionWaitMs: 0, measurementDurationMs: 1000, measurementStartedAfterAdmission: true },
        phases: { preflight: { status: 'clean', attempts: [record] }, during: { status: 'clean', observations: [record] }, post: record } },
    { runId: binding.runId, attemptId: 'current-benchmark-attempt-1' });
    const noiseRef = put('native-noise.json', noise);
    return { root, put, topology, plan, identity, selection, binding, sourceState, checkpoint, report, fragment, noise, activated,
        options: { root, topologyRef: put('native-topology.json', topology), selectionRef: put('native-selection.json', selection),
            planRef: put('native-plan.json', plan), expectedBinding: binding, expectedCpuIdentity: identity,
            resourceRef, checkpointRef, expectedSourceState: sourceState, sequenceRefs: [noiseRef], policyRef, windowId: 'benchmark' } };
}

test('adapter consumes exact verified calibration and keeps run-specific selection outside cohort identity', t =>
{
    const f = nativeFixture(t);
    const first = projectNativeCpuCapacity(f.options);
    assert.equal(first.status, 'verified');
    assert.equal(first.capacitySource, 'calibration');
    assert.equal(first.identityBindings.effectiveCpuCalibration.receiptDigest, f.selection.calibrationDigest.slice(7));
    const next = resolveRunCpuCapacity({ runId: 'next', topology: f.topology, identity: f.identity, activePointerPath: f.activated.pointerPath });
    const second = projectNativeCpuCapacity({ ...f.options, selectionRef: f.put('next-selection.json', next),
        expectedBinding: { ...f.binding, runId: 'next' } });
    assert.deepEqual(second.identityBindings, first.identityBindings);
    assert.notEqual(second.provenance.selectionDigest, first.provenance.selectionDigest);
});

test('adapter never reloads an active pointer after the plan selected immutable capacity', t =>
{
    const f = nativeFixture(t);
    fs.writeFileSync(f.activated.pointerPath, '{corrupt-active-pointer');
    assert.equal(projectNativeCpuCapacity(f.options).capacitySource, 'calibration');
    const calibrationPath = f.selection.calibrationReference.calibrationLocator;
    fs.appendFileSync(calibrationPath, ' ');
    // Whitespace does not change the CPU owner's semantic seal; structural tampering must still be rejected.
    const calibration = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
    calibration.effectiveCpuUnits = 100;
    fs.writeFileSync(calibrationPath, JSON.stringify(calibration));
    assert.throws(() => projectNativeCpuCapacity(f.options), /digest mismatch/u);
});

test('adapter refuses resealed capacity changes wrong-run selection and plan drift through original validators', t =>
{
    const f = nativeFixture(t);
    const { contentDigest: ignored, ...raw } = f.selection;
    void ignored;
    raw.effectiveCpuUnits = 100;
    const bad = f.put('resealed-selection.json', sealCpuValue(raw));
    assert.throws(() => projectNativeCpuCapacity({ ...f.options, selectionRef: bad }), /authority\/envelope/u);
    assert.throws(() => projectNativeCpuCapacity({ ...f.options, expectedBinding: { ...f.binding, runId: 'wrong' } }), /wrong run/u);
    const drift = { ...f.plan, drift: true };
    assert.throws(() => projectNativeCpuCapacity({ ...f.options, planRef: f.put('drift-plan.json', drift),
        expectedBinding: { ...f.binding, planDigest: digest(drift) } }), /physical plan identity/u);
});

test('verified deterministic fallback remains uncalibrated and cannot become a performance baseline', t =>
{
    const f = nativeFixture(t);
    const selection = resolveRunCpuCapacity({ runId: f.binding.runId, topology: f.topology, identity: f.identity,
        activePointerPath: path.join(f.root, 'missing-pointer.json') });
    const actual = projectNativeCpuCapacity({ ...f.options, selectionRef: f.put('fallback-selection.json', selection) });
    assert.equal(actual.capacitySource, 'fallback');
    assert.equal(actual.status, 'not-evaluable');
    assert.equal(actual.baselineEligible, false);
    assert.ok(actual.provenance.fallbackReceipt.uncalibrated);
});

test('canonical resource projection reuses raw collector and integrated grant with exact scheduler-state refs', t =>
{
    const f = nativeFixture(t);
    const result = projectCanonicalResourceState(f.options);
    assert.equal(result.steps[0].samplingComplete, true);
    assert.equal(result.observations.find(item => item.name === 'actualCpuSeconds' && item.stepId === 'compile').value, 6);
    assert.equal(result.waitStates[0].classification, 'dependency-blocked');
    assert.equal(result.waitStates[0].authority, 'scheduler');
    assert.deepEqual(result.waitStates[0].owners, [{ bundleId: 'build', stepId: 'compile' }]);
    assert.equal(result.waitStates[0].provenance.ref.sha256, f.options.checkpointRef.sha256);
    assert.equal(result.status, 'not-evaluable');
    assert.ok(result.unavailableRequired.includes('swapBytes'));
});

test('canonical partial CPU and unsupported I/O never become zero through native display aggregates', t =>
{
    const f = nativeFixture(t);
    f.fragment.steps.compile.actualCpuSeconds = null;
    f.report.bundles.build.resourceUtilization = f.fragment;
    f.report.bundles.build.bundleMetrics = f.fragment;
    const ref = f.put('native-fragment.json', f.fragment);
    f.report.bundles.build.bindings.resourceDigest = `sha256:${ref.sha256}`;
    f.report.actualCpuSeconds = 0;
    const reportRef = f.put('native-resource.json', { schema: 'fsusblog.production.resource-utilization.v1', observeOnly: true, ...f.report });
    const result = projectCanonicalResourceState({ ...f.options, resourceRef: reportRef });
    assert.equal(result.observations.find(item => item.name === 'actualCpuSeconds' && item.stepId === 'run').value, null);
    assert.equal(result.observations.find(item => item.name === 'readBytes').value, null);
    assert.equal(result.steps[0].samplingComplete, false);
});

test('canonical resource wrong source checkpoint digest raw fragment and grant tampering fail closed', t =>
{
    const f = nativeFixture(t);
    assert.throws(() => projectCanonicalResourceState({ ...f.options,
        expectedSourceState: { ...f.sourceState, commit: 'b'.repeat(40) } }), /source/u);
    f.report.checkpoint.digest = `sha256:${digest('wrong')}`;
    const ref = f.put('bad-report.json', { schema: 'fsusblog.production.resource-utilization.v1', ...f.report });
    assert.throws(() => projectCanonicalResourceState({ ...f.options, resourceRef: ref }), /checkpoint byte/u);
    f.fragment.steps.compile.grantedCpuSeconds = 100;
    const fragmentRef = f.put('native-fragment.json', f.fragment);
    f.report.bundles.build.resourceUtilization = f.fragment;
    f.report.bundles.build.bundleMetrics = f.fragment;
    f.report.bundles.build.bindings.resourceDigest = `sha256:${fragmentRef.sha256}`;
    f.report.checkpoint.digest = `sha256:${f.options.checkpointRef.sha256}`;
    const reportRef = f.put('tampered-grant-report.json', { schema: 'fsusblog.production.resource-utilization.v1', ...f.report });
    assert.throws(() => projectCanonicalResourceState({ ...f.options, resourceRef: reportRef }), /integrated history/u);
});

test('readiness wait preserves scheduler authority and cannot invent a marker or guessed step', t =>
{
    const f = nativeFixture(t);
    const wait = f.checkpoint.resourceUtilization.waits.intervals[0];
    wait.ownerId = 'unmapped-owner';
    wait.category = 'readiness-marker-blocked';
    wait.detail = 'ready-marker';
    const checkpointRef = f.put('native-checkpoint.json', f.checkpoint);
    f.report.scheduler.waits = f.checkpoint.resourceUtilization.waits;
    f.report.checkpoint.digest = `sha256:${checkpointRef.sha256}`;
    const resourceRef = f.put('native-resource.json', { schema: 'fsusblog.production.resource-utilization.v1', ...f.report });
    const result = projectCanonicalResourceState({ ...f.options, checkpointRef, resourceRef });
    assert.equal(result.waitStates[0].needsMarkerAuthority, true);
    assert.equal(result.waitStates[0].authority, 'scheduler');
    assert.deepEqual(result.waitStates[0].owners, []);
});

test('native noise reuses exact terminal sequence validator without inventing machine metric floors', t =>
{
    const f = nativeFixture(t);
    const result = projectCanonicalNoise(f.options);
    assert.equal(result.cleanWindow, true);
    assert.equal(result.floors, null);
    assert.equal(result.floorStatus, 'requires-machine-metric-noise-calibration');
    assert.throws(() => projectCanonicalNoise({ ...f.options, expectedBinding: { ...f.binding, attempt: 2 } }), /wrong attempt/u);
    fs.appendFileSync(path.join(f.root, 'native-noise.json'), ' ');
    assert.throws(() => projectCanonicalNoise(f.options), /tampered evidence/u);
});

test('combined native source inspection preserves usable parts and refuses missing qualification authority', t =>
{
    const f = nativeFixture(t);
    const actual = inspectNativePerformanceSources(f.options);
    assert.equal(actual.cpu.status, 'verified');
    assert.equal(actual.noise.cleanWindow, true);
    assert.equal(actual.status, 'not-evaluable');
    assert.equal(actual.baselineEligible, false);
    assert.ok(actual.reasons.includes('native-full-run-health-authority-missing'));
    assert.ok(actual.reasons.includes('native-critical-path-interval-authority-missing'));
    assert.equal(Object.hasOwn(actual, 'verdict'), false);
    assert.deepEqual(actual, inspectNativePerformanceSources(f.options));
});


test('native CPU binding replaces opaque CPU identity facts and rejects uncalibrated normalization', t =>
{
    const f = nativeFixture(t);
    const identityValues = Object.fromEntries(identityFields.map(name => [name, { supplement: name }]));
    identityValues.os = { name: 'linux', version: 'supplement-version' };
    const result = bindPerformanceIdentityToNativeCpu({ ...f.options, identityValues });
    assert.equal(result.values.machineTopology.machineId, f.topology.raw.machineIdentityDigest.slice(7));
    assert.equal(result.values.effectiveCpuCalibration.receiptDigest, f.selection.calibrationDigest.slice(7));
    assert.equal(result.values.kernel.release, f.topology.raw.kernel);
    assert.equal(result.values.os.version, 'supplement-version');
    assert.deepEqual(result.values.physicalPlan, f.plan);
    assert.deepEqual(result.nativeCpuProvenance.selection, f.options.selectionRef);
    assert.throws(() => bindPerformanceIdentityToNativeCpu({ ...f.options, identityValues: { ...identityValues, os: { name: 'other' } } }), /OS differs/u);
    const fallback = resolveRunCpuCapacity({ runId: f.binding.runId, topology: f.topology, identity: f.identity,
        activePointerPath: path.join(f.root, 'absent-pointer.json') });
    assert.throws(() => bindPerformanceIdentityToNativeCpu({ ...f.options, identityValues,
        selectionRef: f.put('fallback-identity.json', fallback) }), /not baseline eligible/u);
});


test('independent performance input validator rechecks native CPU facts and immutable raw provenance', t =>
{
    const f = nativeFixture(t);
    const supplementFixture = fixture(t);
    const supplementRun = supplementFixture.run('current');
    const supplementaryIdentity = readDocument(supplementFixture.root, 'current-identity.json').value.values;
    const identityFacts = bindPerformanceIdentityToNativeCpu({ ...f.options, identityValues: supplementaryIdentity });
    const refs = {};
    for (const name of ['execution', 'resource', 'intervals', 'noise'])
    {
        const facts = readDocument(supplementFixture.root, `current-${name}.json`).value;
        facts.binding = f.binding;
        if (name === 'execution')
        {
            facts.plannedDigest = f.binding.planDigest;
            facts.executedDigest = f.binding.planDigest;
        }
        if (name === 'intervals')
        {
            for (const interval of facts.items)
            {
                interval.evidence = interval.evidence.map(ref =>
                {
                    const state = readDocument(supplementFixture.root, ref.locator).value;
                    state.binding = f.binding;
                    return f.put(ref.locator, state);
                });
            }
        }
        refs[name] = f.put(`materialized-${name}.json`, facts);
    }
    refs.identity = f.put('materialized-identity.json', identityFacts);
    const receipt = seal({ schema: runSchema, binding: f.binding, ...refs });
    f.put('materialized.json', receipt);
    const loaded = loadPerformanceRun(f.root, 'materialized.json');
    assert.equal(loaded.identity.values.machineTopology.machineId, f.topology.raw.machineIdentityDigest.slice(7));
    // Deliberately reseal the normalized identity without changing original native CPU bytes.
    identityFacts.values.effectiveCpuCalibration.effectiveCpuUnits = 100;
    const changedRef = f.put('materialized-identity.json', identityFacts);
    f.put('forged-materialized.json', seal({ schema: runSchema, binding: f.binding, ...refs, identity: changedRef }));
    assert.throws(() => loadPerformanceRun(f.root, 'forged-materialized.json'), /native CPU identity effectiveCpuCalibration/u);
    identityFacts.values.effectiveCpuCalibration.effectiveCpuUnits = f.selection.effectiveCpuUnits;
    assert.equal(f.put('materialized-identity.json', identityFacts).sha256, refs.identity.sha256);
    const withoutProvenance = { ...identityFacts };
    delete withoutProvenance.nativeCpuProvenance;
    const missingRef = f.put('missing-provenance.json', withoutProvenance);
    f.put('missing-provenance-run.json', seal({ schema: runSchema, binding: f.binding, ...refs, identity: missingRef }));
    assert.throws(() => loadPerformanceRun(f.root, 'missing-provenance-run.json'), /native CPU provenance required/u);
    fs.appendFileSync(path.join(f.root, f.options.topologyRef.locator), ' ');
    assert.throws(() => loadPerformanceRun(f.root, 'materialized.json'), /tampered evidence: native-topology.json/u);
    assert.equal(supplementRun.binding.runId, f.binding.runId);
});
