import {
    assertCpuEqual, cpuDigest, sealCpuValue, verifyCpuSeal
} from './cpu-calibration-contract.mjs';
import { validateMachineCpuTopology } from './machine-cpu-topology.mjs';

export const effectiveCpuFallbackSchema = 'fsusblog.effective-cpu-fallback-receipt.v1';

export function calculateEffectiveCpuFallback(topology, expectedTopologyDigest)
{
    if (typeof expectedTopologyDigest !== 'string')
    {
        throw new Error('current topology digest required');
    }
    validateMachineCpuTopology(topology, expectedTopologyDigest);
    const { allowed, physical, finiteBoundary } = topology.projection;
    if (allowed.disposition !== 'observed' || finiteBoundary.disposition !== 'observed'
        || finiteBoundary.value.verified !== true)
    {
        throw new Error('Production CPU fallback requires verified finite process boundary and allowed CPUs');
    }
    const allowedLogicalCpuCount = allowed.value.length;
    const verifiedFiniteCpuLimitCores = finiteBoundary.value.cores;
    const finiteVisibleLogicalUnits = Math.max(1, Math.floor(Math.min(allowedLogicalCpuCount, verifiedFiniteCpuLimitCores)));
    const physicalCount = physical.disposition === 'observed' ? physical.value.count : null;
    const effectiveCpuUnits = physicalCount === null
        ? Math.max(1, Math.floor(finiteVisibleLogicalUnits * 0.5))
        : Math.max(1, Math.min(physicalCount, finiteVisibleLogicalUnits));
    return sealCpuValue({ schema: effectiveCpuFallbackSchema, topologyDigest: topology.topologyDigest,
        finiteBoundaryDigest: cpuDigest(finiteBoundary), allowedLogicalCpuCount, allowedPhysicalCoreCount: physicalCount,
        verifiedFiniteCpuLimitCores, finiteVisibleLogicalUnits, effectiveCpuUnits,
        schedulerEnvelopeCpuUnits: Math.min(effectiveCpuUnits, verifiedFiniteCpuLimitCores),
        fallbackKind: physicalCount === null ? 'uncalibrated-half-visible-logical' : 'uncalibrated-physical-cores',
        uncalibrated: true, calibrationSampleEligible: false });
}

export function validateEffectiveCpuFallback(receipt, topology, expectedTopologyDigest)
{
    verifyCpuSeal(receipt, effectiveCpuFallbackSchema);
    assertCpuEqual(receipt, calculateEffectiveCpuFallback(topology, expectedTopologyDigest), 'CPU fallback');
    return receipt;
}
