import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { verifyNativeCpuIdentityFacts } from './production-fresh-native-cpu-binding.mjs';

export const identityFields = Object.freeze([
    'machineTopology', 'effectiveCpuCalibration', 'os', 'kernel', 'libc', 'resourceEnforcement',
    'powerPolicy', 'memoryReserve', 'storage', 'toolchain', 'browser', 'services',
    'physicalPlan', 'fixtures', 'tests', 'policy', 'collector'
]);
export const runSchema = 'fsusblog.production-fresh.performance-input.v1';
export const identityRequirements = Object.freeze({
    machineTopology: ['machineId', 'topologyDigest'],
    effectiveCpuCalibration: ['receiptDigest', 'effectiveCpuUnits', 'finiteBoundaryCpuUnits'],
    os: ['name', 'version'], kernel: ['release'], libc: ['name', 'version'],
    resourceEnforcement: ['mode', 'policyDigest'], powerPolicy: ['mode'], memoryReserve: ['bytes'],
    storage: ['deviceId', 'filesystem'], toolchain: ['digest'], browser: ['digest'], services: ['digest'],
    fixtures: ['digest'], tests: ['digest'], collector: ['version', 'sourceDigest']
});


export function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

export function canonical(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value !== null && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    assert(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'non-JSON value');
    return JSON.stringify(value);
}

export function digest(value)
{
    return createHash('sha256').update(canonical(value)).digest('hex');
}

export function byteDigest(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

export function exactKeys(value, keys, label)
{
    assert(value && typeof value === 'object' && !Array.isArray(value)
        && canonical(Object.keys(value).sort()) === canonical([...keys].sort()), `${label} fields mismatch`);
}

export function validateBinding(binding)
{
    exactKeys(binding, ['runId', 'attempt', 'sourceDigest', 'buildDigest', 'planDigest'], 'run binding');
    assert(typeof binding.runId === 'string' && /^[A-Za-z0-9_-]+$/u.test(binding.runId), 'invalid runId');
    assert(Number.isSafeInteger(binding.attempt) && binding.attempt > 0, 'invalid attempt');
    for (const key of ['sourceDigest', 'buildDigest', 'planDigest'])
    {
        assert(/^[a-f0-9]{64}$/u.test(binding[key]), `invalid ${key}`);
    }
}

/** Explicit relative locators and regular files only; no discovery, aliases or symlink traversal. */
export function resolveLocator(root, locator)
{
    assert(typeof locator === 'string' && locator.length > 0 && !path.isAbsolute(locator)
        && !locator.includes('\\') && locator.split('/').every(part => part && part !== '.' && part !== '..'
        && !/^(?:latest|current|active)$/iu.test(part)), 'explicit immutable locator required');
    const resolvedRoot = fs.realpathSync(root);
    let current = resolvedRoot;
    const parts = locator.split('/');
    for (let index = 0; index < parts.length; index++)
    {
        current = path.join(current, parts[index]);
        const stat = fs.lstatSync(current);
        assert(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()),
            'locator must select a regular file through regular directories');
    }
    return current;
}

export function readRef(root, ref)
{
    exactKeys(ref, ['locator', 'sha256'], 'evidence ref');
    assert(/^[a-f0-9]{64}$/u.test(ref.sha256), 'evidence digest required');
    const bytes = fs.readFileSync(resolveLocator(root, ref.locator));
    assert(byteDigest(bytes) === ref.sha256, `tampered evidence: ${ref.locator}`);
    return JSON.parse(bytes);
}

export function readDocument(root, locator)
{
    const bytes = fs.readFileSync(resolveLocator(root, locator));
    return { value: JSON.parse(bytes), ref: { locator, sha256: byteDigest(bytes) } };
}

export function seal(value)
{
    return { ...value, digest: digest(value) };
}

export function verifySeal(value, schema)
{
    assert(value?.schema === schema && typeof value.digest === 'string', 'receipt schema/seal missing');
    const { digest: expected, ...payload } = value;
    assert(digest(payload) === expected, 'tampered receipt seal');
    return payload;
}

/** Loads owned adapter facts, retaining byte refs. It does not certify a native producer. */
export function loadPerformanceRun(root, locator)
{
    const { value: receipt, ref } = readDocument(root, locator);
    verifySeal(receipt, runSchema);
    exactKeys(receipt, ['schema', 'digest', 'binding', 'identity', 'execution', 'resource', 'intervals', 'noise'], 'performance input');
    validateBinding(receipt.binding);
    const facts = {};
    for (const key of ['identity', 'execution', 'resource', 'intervals', 'noise'])
    {
        facts[key] = readRef(root, receipt[key]);
        assert(canonical(facts[key].binding) === canonical(receipt.binding), `${key} wrong-run/attempt binding`);
    }
    if (facts.identity.nativeCpuProvenance || facts.identity.values?.effectiveCpuCalibration?.nativeIdentity)
    {
        verifyNativeCpuIdentityFacts(root, facts.identity);
    }
    const identity = facts.identity.values;
    exactKeys(identity, identityFields, 'machine identity');
    for (const key of identityFields)
    {
        assert(identity[key] && typeof identity[key] === 'object' && !Array.isArray(identity[key])
            && Object.keys(identity[key]).length > 0, `missing identity facts: ${key}`);
    }
    for (const [key, fields] of Object.entries(identityRequirements))
    {
        for (const field of fields)
        {
            const value = identity[key][field];
            if (field === 'bytes' || field.endsWith('CpuUnits'))
            {
                assert(Number.isFinite(value) && value >= 0 && (field === 'bytes' || value > 0), `invalid identity ${key}.${field}`);
            }
            else
            {
                assert(typeof value === 'string' && value.length > 0, `missing identity ${key}.${field}`);
                if (/digest$/iu.test(field))
                {
                    assert(/^[a-f0-9]{64}$/u.test(value), `invalid identity digest ${key}.${field}`);
                }
            }
        }
    }
    assert(identity.effectiveCpuCalibration.effectiveCpuUnits <= identity.effectiveCpuCalibration.finiteBoundaryCpuUnits,
        'calibration exceeds verified finite CPU boundary');
    assert(digest(identity.physicalPlan) === receipt.binding.planDigest, 'physical plan digest mismatch');
    const policy = identity.policy;
    exactKeys(policy, ['relativeTolerance', 'benchmarkCvMaximum', 'dispositionDigest'], 'comparison policy');
    assert(Number.isFinite(policy.relativeTolerance) && policy.relativeTolerance > 0
        && policy.relativeTolerance < 1 && Number.isFinite(policy.benchmarkCvMaximum)
        && policy.benchmarkCvMaximum > 0, 'invalid machine comparison policy');
    exactKeys(facts.execution, ['binding', 'mode', 'status', 'terminal', 'complete', 'resumed', 'retryCount',
        'plannedDigest', 'executedDigest'], 'execution facts');
    const resource = facts.resource;
    exactKeys(resource, ['binding', 'complete', 'health', 'metrics', 'steps'], 'resource facts');
    exactKeys(resource.health, ['swapBytes', 'oomCount', 'resourceKillCount', 'thermalValid', 'isolationValid', 'benchmarkCv'], 'resource health');
    for (const name of ['swapBytes', 'oomCount', 'resourceKillCount', 'benchmarkCv'])
    {
        assert(Number.isFinite(resource.health[name]) && resource.health[name] >= 0, `unknown health: ${name}`);
    }
    for (const name of ['thermalValid', 'isolationValid'])
    {
        assert(typeof resource.health[name] === 'boolean', `unknown health: ${name}`);
    }
    assert(typeof resource.complete === 'boolean' && Array.isArray(resource.metrics) && Array.isArray(resource.steps), 'incomplete resource shape');
    exactKeys(facts.noise, ['binding', 'valid', 'complete', 'floors'], 'noise facts');
    assert(typeof facts.noise.valid === 'boolean' && typeof facts.noise.complete === 'boolean'
        && facts.noise.floors && typeof facts.noise.floors === 'object', 'invalid noise evidence');
    for (const value of Object.values(facts.noise.floors))
    {
        assert(Number.isFinite(value) && value >= 0, 'invalid noise floor');
    }
    return { receipt, ref, ...facts, identityDigest: digest(identity), policy };
}

export function runInvalidReasons(run)
{
    const execution = run.execution;
    const health = run.resource.health;
    return [
        execution.mode !== 'fresh' && 'not-fresh', execution.status !== 'success' && 'correctness-failed',
        execution.terminal !== true && 'provisional', execution.complete !== true && 'partial',
        run.receipt.binding.attempt !== 1 && 'not-first-attempt', execution.retryCount !== 0 && 'retry',
        execution.resumed !== false && 'resume', execution.plannedDigest !== execution.executedDigest && 'planned-executed-drift',
        execution.plannedDigest !== run.receipt.binding.planDigest && 'plan-binding-drift',
        !run.resource.complete && 'resource-partial', health.swapBytes > 0 && 'swap', health.oomCount > 0 && 'oom',
        health.resourceKillCount > 0 && 'resource-kill', !health.thermalValid && 'thermal-invalid',
        !health.isolationValid && 'benchmark-isolation-invalid', health.benchmarkCv > run.policy.benchmarkCvMaximum && 'benchmark-cv-invalid',
        !run.noise.valid && 'noise-invalid', !run.noise.complete && 'noise-partial'
    ].filter(Boolean);
}

/** New artifacts only: an existing cohort/comparison/verdict is never replaced. */
export function writeNew(file, value)
{
    const fd = fs.openSync(file, 'wx', 0o600);
    try
    {
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 4)}\n`);
        fs.fsyncSync(fd);
    }
    finally
    {
        fs.closeSync(fd);
    }
}
