import {
    assert, canonical, readRef, resolveLocator, seal, validateBinding
} from './production-fresh-contract.mjs';
import { projectNativeCpuCapacity, readNativePhysicalPlan } from './production-fresh-native-cpu-binding.mjs';
export { projectNativeCpuCapacity, bindPerformanceIdentityToNativeCpu } from './production-fresh-native-cpu-binding.mjs';

const { integrateResourceGrantHistory, validateResourceUtilizationBinding } = await import(new URL('../test-matrix/resource-utilization.mjs', import.meta.url));
const {
    readMeasurementNoisePolicy, validateMeasurementNoiseAuthoritySequence, validateMeasurementNoiseReceipt
} = await import(new URL('../test/measurement-noise-envelope.mjs', import.meta.url));

export const nativeAdapterSchema = 'fsusblog.production-fresh.native-performance-source-projection.v1';
const waitDisposition = Object.freeze({
    'dependency-blocked': 'dependency-blocked', 'readiness-marker-blocked': 'readiness-blocked',
    'waiting-for-startup-capacity': 'capacity-blocked', 'capacity-blocked': 'capacity-blocked',
    'counted-resource-blocked': 'capacity-blocked', 'exclusive-resource-blocked': 'exclusive-blocked',
    'external-service-io-blocked': 'external-io', 'benchmark-isolation-cooldown': 'legitimate-isolation'
});
const plainDigest = value => value.startsWith('sha256:') ? value.slice(7) : value;
const same = (actual, expected, label) => assert(canonical(actual) === canonical(expected), `${label} mismatch`);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;


function observation(bundleId, stepId, name, value, sourceRef, pointer, supported = true)
{
    return { bundleId, stepId, name, status: !supported ? 'unsupported' : finite(value) ? 'measured' : 'unavailable',
        value: supported && finite(value) ? value : null, provenance: { ref: sourceRef, pointer } };
}

/** Verify canonical bytes and owners, then project only fields actually emitted by the collector. */
export function projectCanonicalResourceState({ root, resourceRef, checkpointRef, planRef, expectedBinding, expectedSourceState })
{
    validateBinding(expectedBinding);
    assert(plainDigest(expectedSourceState.worktreeFingerprint) === expectedBinding.sourceDigest, 'native source fingerprint binding mismatch');
    const report = readRef(root, resourceRef);
    const checkpoint = readRef(root, checkpointRef);
    const plan = readNativePhysicalPlan(root, planRef, expectedBinding);
    const errors = validateResourceUtilizationBinding(report, {
        runId: expectedBinding.runId, sourceState: expectedSourceState, checkpoint: { revision: checkpoint.revision }
    });
    assert(errors.length === 0, `canonical resource binding: ${errors.join(',')}`);
    assert(report.checkpoint.path === checkpointRef.locator && plainDigest(report.checkpoint.digest) === checkpointRef.sha256,
        'canonical resource checkpoint byte locator mismatch');
    same(checkpoint.sourceState, expectedSourceState, 'native checkpoint source');
    assert(checkpoint.runId === expectedBinding.runId, 'native checkpoint wrong run');
    same(report.scheduler?.waits, checkpoint.resourceUtilization?.waits, 'scheduler wait ledger projection');
    same(report.scheduler?.criticalPath, checkpoint.criticalPath, 'scheduler critical path projection');
    const observations = [
        observation('production', 'run', 'wallClockMs', finite(report.wallSeconds) ? report.wallSeconds * 1000 : null, resourceRef, '/wallSeconds'),
        observation('production', 'run', 'criticalPathMs', report.scheduler?.criticalPath?.durationMs, checkpointRef, '/criticalPath/durationMs')
    ];
    const fragments = new Map();
    const projectedSteps = [];
    for (const [index, step] of plan.steps.entries())
    {
        const entry = report.bundles?.[step.bundleId];
        assert(entry?.bindings?.resourceFile && entry.bindings.resourceDigest, `missing canonical bundle fragment: ${step.bundleId}`);
        const ref = { locator: entry.bindings.resourceFile, sha256: plainDigest(entry.bindings.resourceDigest) };
        if (!fragments.has(step.bundleId))
        {
            const raw = readRef(root, ref);
            assert(raw.schema === 'fsusblog.production.bundle-resource-utilization.v1'
                && raw.schedulerRunId === expectedBinding.runId && raw.physicalBundleId === step.bundleId, 'bundle resource authority mismatch');
            same(raw.sourceState, expectedSourceState, 'bundle resource source');
            same(entry.resourceUtilization, raw, 'canonical bundle resource projection');
            // These fields must come from the raw step collector, not the display summary overlay.
            same(entry.bundleMetrics?.steps, raw.steps, 'canonical raw step projection');
            fragments.set(step.bundleId, { raw, ref });
        }
        const { raw } = fragments.get(step.bundleId);
        const value = raw.steps?.[step.stepId];
        assert(value, `missing sealed-plan native step: ${step.bundleId}/${step.stepId}`);
        const prefix = `/steps/${step.stepId}`;
        const names = ['actualCpuSeconds', 'grantedCpuSeconds', 'peakRssBytes', 'averageRssBytes', 'readBytes', 'writeBytes',
            'voluntaryContextSwitches', 'involuntaryContextSwitches'];
        for (const name of names)
        {
            observations.push(observation(step.bundleId, step.stepId, name, value[name], ref, `${prefix}/${name}`, value.status !== 'unsupported'));
        }
        let grantVerified = false;
        if (Array.isArray(value.grantHistory) && finite(value.startedAtMs) && finite(value.finishedAtMs))
        {
            const integrated = integrateResourceGrantHistory(value.grantHistory, value.startedAtMs, value.finishedAtMs);
            same(value.grantIntegration, integrated, 'native integrated grant authority');
            if (integrated.status === 'measured')
            {
                assert(value.grantedCpuSeconds === integrated.cpuSeconds, 'native granted CPU differs from integrated history');
                grantVerified = true;
            }
        }
        const samplingComplete = grantVerified && value.exitedProcessAccounting === 'kernel-rusage-including-descendants'
            && value.status === 'measured' && value.grantIntegration?.status === 'measured'
            && value.grantIntegration.unmeasuredDurationMs === 0 && finite(value.actualCpuSeconds) && finite(value.grantedCpuSeconds) && value.grantedCpuSeconds > 0;
        projectedSteps.push({ bundleId: step.bundleId, stepId: step.stepId, cpuHeavy: step.cpuHeavy, samplingComplete,
            provenance: { plan: planRef, planPointer: `/steps/${index}`, resource: ref, resourcePointer: prefix } });
    }
    const exactStepKeys = [...fragments.values()].flatMap(({ raw }) => Object.keys(raw.steps ?? {})
        .filter(stepId => raw.steps[stepId].status !== 'not-applicable').map(stepId => canonical([raw.physicalBundleId, stepId]))).sort();
    same(exactStepKeys, plan.steps.map(step => canonical([step.bundleId, step.stepId])).sort(), 'canonical executable step roster');
    for (const name of ['actualCpuSeconds', 'grantedCpuSeconds'])
    {
        const values = observations.filter(item => item.name === name).map(item => item.value);
        const total = values.length > 0 && values.every(finite) ? values.reduce((sum, value) => sum + value, 0) : null;
        observations.push(observation('production', 'run', name, total, resourceRef, `/bundles/*/resourceUtilization/steps/*/${name}`));
        if (total !== null)
        {
            assert(finite(report[name]) && Math.abs(report[name] - total) <= 1e-6, `canonical ${name} aggregate differs from raw steps`);
        }
    }
    const start = Date.parse(checkpoint.startedAt);
    const waits = checkpoint.resourceUtilization.waits?.intervals;
    assert(Number.isFinite(start) && Array.isArray(waits), 'native scheduler wait time authority missing');
    const waitStates = waits.map((wait, index) =>
    {
        const owners = plan.steps.filter(step => step.schedulerOwnerId === wait.ownerId);
        const classification = waitDisposition[wait.category];
        assert(classification && finite(wait.startedAtMs) && finite(wait.finishedAtMs)
            && wait.finishedAtMs >= wait.startedAtMs && wait.startedAtMs >= start
            && wait.durationMs === wait.finishedAtMs - wait.startedAtMs, 'invalid canonical scheduler wait');
        // Bundle-level waits cannot silently become one guessed critical-path step or marker event.
        return { ownerId: wait.ownerId, owners: owners.map(step => ({ bundleId: step.bundleId, stepId: step.stepId })),
            startMs: wait.startedAtMs - start, endMs: wait.finishedAtMs - start,
            classification, kind: wait.category, detail: wait.detail, authority: 'scheduler',
            needsMarkerAuthority: classification === 'readiness-blocked',
            needsIsolationAuthority: classification === 'legitimate-isolation',
            provenance: { ref: checkpointRef, pointer: `/resourceUtilization/waits/intervals/${index}` } };
    });
    const reasons = ['native-full-run-health-authority-missing', 'native-critical-path-interval-authority-missing',
        'native-current-attempt-terminal-authority-missing'];
    if (checkpoint.mode !== 'fresh' || checkpoint.authoritative !== true || checkpoint.status !== 'success'
        || report.status !== 'complete' || report.incomplete !== false)
    {
        reasons.push('native-run-not-clean-complete-fresh');
    }
    if (projectedSteps.some(step => step.cpuHeavy && !step.samplingComplete))
    {
        reasons.push('native-cpu-heavy-sampling-incomplete');
    }
    return { status: 'not-evaluable', reasons, observations, steps: projectedSteps, waitStates,
        provenance: { resource: resourceRef, checkpoint: checkpointRef, physicalPlan: planRef,
            fragments: [...fragments.values()].map(entry => entry.ref) },
        unavailableRequired: ['peakRssBytes:full-run', 'cpuPressure:full-run', 'memoryPressure:full-run', 'ioPressure:full-run',
            'swapBytes', 'oomCount', 'resourceKillCount', 'thermalValid', 'isolationValid', 'benchmarkCv', 'terminal-first-attempt', 'critical-path-intervals'] };
}

/** Use the original sequence/policy validators; clean windows do not invent learned machine floors. */
export function projectCanonicalNoise({ root, sequenceRefs, policyRef, expectedBinding, windowId })
{
    validateBinding(expectedBinding);
    assert(Array.isArray(sequenceRefs) && sequenceRefs.length > 0, 'explicit native noise sequence required');
    readRef(root, policyRef);
    const policy = readMeasurementNoisePolicy(resolveLocator(root, policyRef.locator));
    const receipts = sequenceRefs.map(ref => readRef(root, ref));
    const sequence = validateMeasurementNoiseAuthoritySequence(receipts, { expectedRunId: expectedBinding.runId, expectedWindowId: windowId, policy });
    const terminal = sequence.at(-1);
    assert(terminal.authority.attemptSequence === expectedBinding.attempt, 'native noise wrong attempt');
    const reasons = [];
    try
    {
        validateMeasurementNoiseReceipt(terminal, { expectedWindowId: windowId, policy, authoritySequence: sequence });
    }
    catch (error)
    {
        reasons.push(`native-noise-not-qualified:${error.message}`);
    }
    return { status: reasons.length ? 'not-evaluable' : 'verified', cleanWindow: reasons.length === 0,
        reasons, floors: null, floorStatus: 'requires-machine-metric-noise-calibration',
        observations: sequence.flatMap(receipt => receipt.phases?.during?.observations ?? []).map(record => record.observation),
        provenance: { sequence: sequenceRefs, policy: policyRef, authorityDigest: terminal.authority.contentDigest } };
}

/** A source projection cannot be substituted for a performance input, cohort or verdict receipt. */
export function inspectNativePerformanceSources(options)
{
    const cpu = projectNativeCpuCapacity(options);
    const resources = projectCanonicalResourceState(options);
    const noise = projectCanonicalNoise(options);
    return seal({ schema: nativeAdapterSchema, binding: options.expectedBinding, status: 'not-evaluable', baselineEligible: false,
        reasons: [...cpu.reasons, ...resources.reasons, ...noise.reasons, 'native-machine-metric-noise-floors-missing'], cpu, resources, noise });
}
