import { isDeepStrictEqual } from 'node:util';

import { canonicalDigest } from './execution-replay-contract.mjs';

export const defaultCpuSelectionPolicy = Object.freeze({ noiseFloorRatio: 0.02,
    p90RegressionRatio: 0.02, criticalPathRegressionRatio: 0, cvRegressionRatio: 0,
    thermalBiasCelsius: 5, frequencyBiasRatio: 0.05 });

export const cpuIdentityFields = Object.freeze([
    'machine', 'topology', 'finiteBoundary', 'platform', 'arch', 'kernel', 'powerPolicy',
    'toolchain', 'physicalPlan', 'fixture', 'tests', 'coverage', 'benchmark', 'source', 'worktree'
]);

export function exactCpuFields(value, fields, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort()))
    {
        throw new Error(`${label}: fields must be exact`);
    }
}

export function cpuDigest(value)
{
    return canonicalDigest(value);
}

export function cpuAssertDigest(value, label)
{
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value))
    {
        throw new Error(`${label}: digest required`);
    }
}

export function freezeCpuValue(value)
{
    if (value && typeof value === 'object')
    {
        for (const child of Object.values(value))
        {
            freezeCpuValue(child);
        }
        Object.freeze(value);
    }
    return value;
}

export function sealCpuValue(value)
{
    // Canonical serialization rejects undefined, non-finite and non-JSON input.
    const copy = structuredClone(value);
    return freezeCpuValue({ ...copy, contentDigest: cpuDigest(copy) });
}

export function verifyCpuSeal(value, schema)
{
    if (value?.schema !== schema)
    {
        throw new Error(`CPU receipt schema: expected ${schema}`);
    }
    const { contentDigest, ...body } = value;
    cpuAssertDigest(contentDigest, 'contentDigest');
    if (contentDigest !== cpuDigest(body))
    {
        throw new Error('CPU receipt digest mismatch');
    }
    return value;
}

export function assertCpuEqual(actual, expected, label)
{
    if (!isDeepStrictEqual(actual, expected))
    {
        throw new Error(`${label}: recomputation mismatch`);
    }
}

export function validateCpuIdentity(identity)
{
    exactCpuFields(identity, cpuIdentityFields, 'CPU identity');
    for (const field of cpuIdentityFields)
    {
        cpuAssertDigest(identity[field], `identity.${field}`);
    }
    return identity;
}

export function positiveCpuNumber(value, label, allowZero = false)
{
    if (typeof value !== 'number' || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0))
    {
        throw new Error(`${label}: finite ${allowZero ? 'nonnegative' : 'positive'} number required`);
    }
    return value;
}
