import {
    assert, canonical, digest, exactKeys, identityFields, readRef, validateBinding
} from './production-fresh-contract.mjs';

const { cpuDigest } = await import(new URL('../test/cpu-calibration-contract.mjs', import.meta.url));
const { validateRunCpuCapacity } = await import(new URL('../test/cpu-calibration-loader.mjs', import.meta.url));

export const nativeCpuCapabilityCommit = '3726bae1d1fc3b0969850c90342ef16f7bfb8a2a';
const plainDigest = value => value.startsWith('sha256:') ? value.slice(7) : value;
const same = (actual, expected, label) => assert(canonical(actual) === canonical(expected), `${label} mismatch`);

export function readNativePhysicalPlan(root, planRef, binding)
{
    const plan = readRef(root, planRef);
    assert(digest(plan) === binding.planDigest, 'native physical plan binding mismatch');
    assert(Array.isArray(plan.steps) && plan.steps.length > 0, 'explicit physical step roster required');
    const keys = new Set();
    for (const step of plan.steps)
    {
        assert(typeof step.bundleId === 'string' && typeof step.stepId === 'string'
            && typeof step.cpuHeavy === 'boolean' && typeof step.schedulerOwnerId === 'string', 'native owner map must be explicit');
        const key = canonical([step.bundleId, step.stepId]);
        assert(!keys.has(key), 'duplicate physical step owner');
        keys.add(key);
    }
    return plan;
}

/** Consume a pre-seal selection; never resolve capacity or read a mutable active pointer here. */
export function projectNativeCpuCapacity({ root, topologyRef, selectionRef, planRef, expectedBinding, expectedCpuIdentity })
{
    validateBinding(expectedBinding);
    const topology = readRef(root, topologyRef);
    const selection = readRef(root, selectionRef);
    const plan = readNativePhysicalPlan(root, planRef, expectedBinding);
    validateRunCpuCapacity(selection, { topology, identity: expectedCpuIdentity });
    assert(selection.runId === expectedBinding.runId, 'native CPU selection wrong run');
    assert(selection.identity.physicalPlan === cpuDigest(plan), 'CPU/performance physical plan identity mismatch');
    const powerObserved = topology.projection.power.disposition === 'observed';
    const calibrated = selection.capacitySource === 'calibration';
    const reasons = [...(!calibrated ? ['uncalibrated-fallback-not-baseline-eligible'] : []),
        ...(!powerObserved ? ['power-policy-observation-unavailable'] : [])];
    return {
        status: reasons.length ? 'not-evaluable' : 'verified', baselineEligible: reasons.length === 0,
        reasons, capacitySource: selection.capacitySource,
        identityBindings: {
            machineTopology: { machineId: plainDigest(topology.raw.machineIdentityDigest),
                topologyDigest: plainDigest(topology.topologyDigest), projection: topology.projection },
            effectiveCpuCalibration: { receiptDigest: plainDigest(selection.calibrationDigest ?? selection.fallbackReceipt.contentDigest),
                effectiveCpuUnits: selection.effectiveCpuUnits,
                finiteBoundaryCpuUnits: Math.min(topology.projection.allowed.value.length, topology.projection.finiteBoundary.value.cores),
                capacitySource: selection.capacitySource, nativeIdentity: selection.identity },
            kernel: { release: topology.raw.kernel },
            powerPolicy: { mode: 'native-policy-observation', observation: powerObserved ? topology.projection.power.value : null },
            toolchain: { digest: plainDigest(selection.identity.toolchain) }, fixtures: { digest: plainDigest(selection.identity.fixture) },
            tests: { digest: plainDigest(selection.identity.tests) }, physicalPlan: plan
        },
        provenance: { topology: topologyRef, selection: selectionRef, physicalPlan: planRef,
            capabilityCommit: nativeCpuCapabilityCommit, selectionDigest: selection.contentDigest,
            calibrationDigest: selection.calibrationDigest, calibrationReference: selection.calibrationReference, fallbackReceipt: selection.fallbackReceipt }
    };
}

/** Bind actual CPU identity into the existing performance identity facts without changing collection policy. */
export function bindPerformanceIdentityToNativeCpu({ identityValues, ...options })
{
    exactKeys(identityValues, identityFields, 'performance identity supplement');
    const cpu = projectNativeCpuCapacity(options);
    assert(cpu.baselineEligible, `native CPU identity not baseline eligible: ${cpu.reasons.join(',')}`);
    const topology = readRef(options.root, options.topologyRef);
    assert(identityValues.os?.name === topology.raw.platform, 'performance OS differs from native CPU platform');
    const values = { ...structuredClone(identityValues), ...structuredClone(cpu.identityBindings) };
    return { binding: structuredClone(options.expectedBinding), values, nativeCpuProvenance: cpu.provenance };
}


/** Independent identity validation uses immutable selected refs, never native collection or active-pointer resolution. */
export function verifyNativeCpuIdentityFacts(root, facts)
{
    const provenance = facts.nativeCpuProvenance;
    assert(provenance, 'native CPU provenance required');
    const expected = projectNativeCpuCapacity({ root, topologyRef: provenance.topology,
        selectionRef: provenance.selection, planRef: provenance.physicalPlan,
        expectedBinding: facts.binding, expectedCpuIdentity: facts.values.effectiveCpuCalibration.nativeIdentity });
    assert(expected.baselineEligible, 'uncalibrated native CPU identity cannot enter a baseline');
    same(provenance, expected.provenance, 'native CPU identity provenance');
    for (const [field, value] of Object.entries(expected.identityBindings))
    {
        same(facts.values[field], value, `native CPU identity ${field}`);
    }
    const topology = readRef(root, provenance.topology);
    assert(facts.values.os?.name === topology.raw.platform, 'native CPU identity OS mismatch');
    return facts;
}
