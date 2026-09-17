import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_PROFILE_SCHEMA = 'fsusblog.runtime-publish-profiles.v1';
const SAFE_ID = /^[a-z][a-z0-9-]{2,63}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PURPOSES = new Set(['throughput', 'startup', 'experiment', 'negative-control', 'prototype']);
const BASE_FAMILIES = new Set(['musl', 'glibc']);
const RUNTIMES = new Set(['linux-musl-x64', 'linux-x64']);
const HEAP_COUNT_MODES = new Set(['container-default', 'cpuset']);
const HEAP_LIMIT_MODES = new Set(['container-limit', 'explicit-container-percent']);
const THREAD_POOL_MODES = new Set(['runtime-default', 'evidence-derived', 'overprovisioned-negative-control']);
const TOPOLOGY_MODES = new Set(['smt-visible', 'physical-core-only', 'numa-local']);
const REQUIRED_ROUTES = ['l0', 'l1', 'l2', 'db-miss', 'notification', 'aot-ssr'];
const DEFAULT_MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-publish-profiles.json');

export function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function sha256Value(value)
{
    return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function validateRuntimeProfileManifest(manifest)
{
    const errors = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    {
        return ['profile manifest must be an object'];
    }
    rejectUnknown(manifest, new Set(['schema', 'defaultProfile', 'routes', 'profiles']), 'manifest', errors);
    if (manifest.schema !== RUNTIME_PROFILE_SCHEMA)
    {
        errors.push(`schema must be ${RUNTIME_PROFILE_SCHEMA}`);
    }
    if (!Array.isArray(manifest.routes) || canonicalJson(manifest.routes) !== canonicalJson(REQUIRED_ROUTES))
    {
        errors.push(`routes must equal ${REQUIRED_ROUTES.join(',')}`);
    }
    if (!Array.isArray(manifest.profiles) || manifest.profiles.length < 2)
    {
        errors.push('profiles must contain at least two named profiles');
        return errors;
    }
    const ids = new Set();
    for (const [index, profile] of manifest.profiles.entries())
    {
        const label = `profiles[${index}]`;
        if (!profile || typeof profile !== 'object' || Array.isArray(profile))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        rejectUnknown(profile, new Set(['id', 'purpose', 'baseImageFamily', 'targetRuntime', 'publish', 'gc', 'threadPool', 'topology', 'conditionalAdmission']), label, errors);
        if (!SAFE_ID.test(String(profile.id ?? '')))
        {
            errors.push(`${label}.id is invalid`);
        }
        if (ids.has(profile.id))
        {
            errors.push(`${label}.id is duplicated`);
        }
        ids.add(profile.id);
        if (!PURPOSES.has(profile.purpose))
        {
            errors.push(`${label}.purpose is invalid`);
        }
        if (!BASE_FAMILIES.has(profile.baseImageFamily))
        {
            errors.push(`${label}.baseImageFamily is invalid`);
        }
        if (!RUNTIMES.has(profile.targetRuntime))
        {
            errors.push(`${label}.targetRuntime is invalid`);
        }
        if (profile.baseImageFamily === 'musl' && profile.targetRuntime !== 'linux-musl-x64')
        {
            errors.push(`${label} musl must use linux-musl-x64`);
        }
        if (profile.baseImageFamily === 'glibc' && profile.targetRuntime !== 'linux-x64')
        {
            errors.push(`${label} glibc must use linux-x64`);
        }
        validatePublish(profile.publish, `${label}.publish`, errors);
        validateGc(profile.gc, `${label}.gc`, errors);
        validateThreadPool(profile.threadPool, `${label}.threadPool`, errors);
        validateTopology(profile.topology, `${label}.topology`, errors);
        validateConditionalAdmission(profile, label, errors);
    }
    if (!ids.has(manifest.defaultProfile))
    {
        errors.push('defaultProfile must identify a declared profile');
    }
    validateAxisCoverage(manifest.profiles, errors);
    validateOneFactorControls(manifest.profiles, errors);
    return errors;
}

export function readRuntimeProfileManifest(file = DEFAULT_MANIFEST)
{
    const resolved = path.resolve(file);
    let manifest;
    try
    {
        manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`unable to read runtime profile manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    const errors = validateRuntimeProfileManifest(manifest);
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return { file: resolved, manifest, digest: sha256Value(manifest) };
}

export function resolveRuntimeProfile(profileId, file = DEFAULT_MANIFEST)
{
    const loaded = readRuntimeProfileManifest(file);
    const selectedId = profileId || loaded.manifest.defaultProfile;
    const profile = loaded.manifest.profiles.find((candidate) => candidate.id === selectedId);
    if (!profile)
    {
        throw new Error(`unknown runtime profile: ${selectedId}`);
    }
    return { ...loaded, profile, profileDigest: sha256Value(profile) };
}

export function runtimeProfileBuildArgs(resolved)
{
    const { profile } = resolved;
    return {
        runtimeProfileId: profile.id,
        runtimeProfileManifestDigest: resolved.digest,
        runtimeProfileDigest: resolved.profileDigest,
        runtimeBaseFlavor: profile.baseImageFamily,
        targetRuntime: profile.targetRuntime,
        publishSingleFile: booleanText(profile.publish.singleFile),
        publishReadyToRun: booleanText(profile.publish.readyToRun),
        tieredPgo: booleanText(profile.publish.tieredPgo),
        quickJitForLoops: booleanText(profile.publish.quickJitForLoops),
        nativeAot: booleanText(profile.publish.nativeAot),
        serverGc: booleanText(profile.gc.server),
        gcHeapCountMode: profile.gc.heapCountMode,
        gcHeapHardLimitMode: profile.gc.heapHardLimitMode,
        gcHeapHardLimitPercent: String(profile.gc.heapHardLimitPercent),
        threadPoolMode: profile.threadPool.mode,
        threadPoolMinThreadsPerCpu: String(profile.threadPool.minThreadsPerCpu),
        topologyMode: profile.topology.mode
    };
}

export function assertSha256(value, label)
{
    if (!SHA256.test(String(value ?? '')))
    {
        throw new Error(`${label} must be sha256:<64 lowercase hex>`);
    }
}

function validatePublish(value, label, errors)
{
    if (!plainObject(value))
    {
        return errors.push(`${label} must be an object`);
    }
    rejectUnknown(value, new Set(['singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops', 'nativeAot']), label, errors);
    for (const key of ['singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops', 'nativeAot'])
    {
        if (typeof value[key] !== 'boolean')
        {
            errors.push(`${label}.${key} must be boolean`);
        }
    }
}

function validateConditionalAdmission(profile, label, errors)
{
    const nativeAot = profile.publish?.nativeAot === true;
    const admission = profile.conditionalAdmission;
    if (!nativeAot && admission !== undefined)
    {
        errors.push(`${label}.conditionalAdmission is only allowed for a NativeAOT prototype`);
    }
    if (!nativeAot)
    {
        return;
    }
    if (profile.purpose !== 'prototype')
    {
        errors.push(`${label} NativeAOT must remain a conditional prototype`);
    }
    if (!plainObject(admission))
    {
        errors.push(`${label}.conditionalAdmission is required for NativeAOT`);
        return;
    }
    rejectUnknown(admission, new Set(['kind', 'featureScope', 'requireFeatureParity', 'requireSecurityParity', 'onParityFailure']), `${label}.conditionalAdmission`, errors);
    if (admission.kind !== 'nativeaot-public-prototype')
    {
        errors.push(`${label}.conditionalAdmission.kind is invalid`);
    }
    if (admission.featureScope !== 'public-artifact-only')
    {
        errors.push(`${label}.conditionalAdmission.featureScope must remain narrow`);
    }
    if (admission.requireFeatureParity !== true)
    {
        errors.push(`${label}.conditionalAdmission.requireFeatureParity must be true`);
    }
    if (admission.requireSecurityParity !== true)
    {
        errors.push(`${label}.conditionalAdmission.requireSecurityParity must be true`);
    }
    if (admission.onParityFailure !== 'reject')
    {
        errors.push(`${label}.conditionalAdmission.onParityFailure must be reject`);
    }
    if (profile.publish.readyToRun !== false)
    {
        errors.push(`${label} NativeAOT prototype cannot also claim ReadyToRun`);
    }
}

function validateGc(value, label, errors)
{
    if (!plainObject(value))
    {
        return errors.push(`${label} must be an object`);
    }
    rejectUnknown(value, new Set(['server', 'heapCountMode', 'heapHardLimitMode', 'heapHardLimitPercent']), label, errors);
    if (value.server !== true)
    {
        errors.push(`${label}.server must remain true for the supported matrix`);
    }
    if (!HEAP_COUNT_MODES.has(value.heapCountMode))
    {
        errors.push(`${label}.heapCountMode is invalid`);
    }
    if (!HEAP_LIMIT_MODES.has(value.heapHardLimitMode))
    {
        errors.push(`${label}.heapHardLimitMode is invalid`);
    }
    if (!Number.isInteger(value.heapHardLimitPercent) || value.heapHardLimitPercent < 0 || value.heapHardLimitPercent > 95)
    {
        errors.push(`${label}.heapHardLimitPercent is invalid`);
    }
    if (value.heapHardLimitMode === 'container-limit' && value.heapHardLimitPercent !== 0)
    {
        errors.push(`${label} container-limit cannot force a heap percentage`);
    }
    if (value.heapHardLimitMode === 'explicit-container-percent' && value.heapHardLimitPercent < 1)
    {
        errors.push(`${label} explicit-container-percent requires a positive heap percentage`);
    }
}

function validateThreadPool(value, label, errors)
{
    if (!plainObject(value))
    {
        return errors.push(`${label} must be an object`);
    }
    rejectUnknown(value, new Set(['mode', 'minThreadsPerCpu']), label, errors);
    if (!THREAD_POOL_MODES.has(value.mode))
    {
        errors.push(`${label}.mode is invalid`);
    }
    if (!Number.isInteger(value.minThreadsPerCpu) || value.minThreadsPerCpu < 0 || value.minThreadsPerCpu > 256)
    {
        errors.push(`${label}.minThreadsPerCpu is invalid`);
    }
    if (value.mode === 'runtime-default' && value.minThreadsPerCpu !== 0)
    {
        errors.push(`${label} runtime-default cannot force minimum threads`);
    }
    if (value.mode === 'evidence-derived' && value.minThreadsPerCpu !== 0)
    {
        errors.push(`${label} evidence-derived value must be supplied by sealed run evidence, not the profile catalog`);
    }
    if (value.mode === 'overprovisioned-negative-control' && value.minThreadsPerCpu < 64)
    {
        errors.push(`${label} negative control must be deliberately overprovisioned`);
    }
}

function validateTopology(value, label, errors)
{
    if (!plainObject(value))
    {
        return errors.push(`${label} must be an object`);
    }
    rejectUnknown(value, new Set(['mode']), label, errors);
    if (!TOPOLOGY_MODES.has(value.mode))
    {
        errors.push(`${label}.mode is invalid`);
    }
}

function validateAxisCoverage(profiles, errors)
{
    const includes = (selector, expected) => profiles.some((profile) => selector(profile) === expected);
    for (const family of BASE_FAMILIES)
    {
        if (!includes((p) => p.baseImageFamily, family))
        {
            errors.push(`matrix must cover base image family ${family}`);
        }
    }
    for (const field of ['singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops'])
    {
        for (const expected of [true, false])
        {
            if (!includes((p) => p.publish?.[field], expected))
            {
                errors.push(`matrix must cover publish.${field}=${expected}`);
            }
        }
    }
    for (const mode of ['container-default', 'cpuset'])
    {
        if (!includes((p) => p.gc?.heapCountMode, mode))
        {
            errors.push(`matrix must cover gc.heapCountMode=${mode}`);
        }
    }
    for (const mode of THREAD_POOL_MODES)
    {
        if (!includes((p) => p.threadPool?.mode, mode))
        {
            errors.push(`matrix must cover threadPool.mode=${mode}`);
        }
    }
    for (const mode of TOPOLOGY_MODES)
    {
        if (!includes((p) => p.topology?.mode, mode))
        {
            errors.push(`matrix must cover topology.mode=${mode}`);
        }
    }
}

function validateOneFactorControls(profiles, errors)
{
    const baseline = profiles.find((profile) => profile.id === 'throughput-musl');
    if (!baseline)
    {
        return;
    }
    assertOneFactor(profiles, baseline, 'throughput-glibc', ['baseImageFamily', 'targetRuntime'], errors);
    assertOneFactor(profiles, baseline, 'startup-musl-r2r', ['publish.readyToRun'], errors);
    assertOneFactor(profiles, baseline, 'throughput-musl-pgo-off', ['publish.tieredPgo'], errors);
    assertOneFactor(profiles, baseline, 'throughput-musl-multifile', ['publish.singleFile'], errors);
    assertOneFactor(profiles, baseline, 'threadpool-evidence-derived', ['threadPool.mode'], errors);
    assertOneFactor(profiles, baseline, 'threadpool-overprovisioned-negative-control', ['threadPool.mode', 'threadPool.minThreadsPerCpu'], errors);
    assertOneFactor(profiles, baseline, 'throughput-musl-quickjit-off', ['publish.quickJitForLoops'], errors);
    assertOneFactor(profiles, baseline, 'physical-core-only', ['topology.mode'], errors);
    assertOneFactor(profiles, baseline, 'numa-local', ['topology.mode'], errors);
    assertOneFactor(profiles, baseline, 'gc-cpuset', ['gc.heapCountMode'], errors);
    assertOneFactor(profiles, baseline, 'gc-explicit-hard-limit', ['gc.heapHardLimitMode', 'gc.heapHardLimitPercent'], errors);
}

function assertOneFactor(profiles, baseline, profileId, allowedPaths, errors)
{
    const candidate = profiles.find((profile) => profile.id === profileId);
    if (!candidate)
    {
        return errors.push(`matrix requires one-factor control ${profileId}`);
    }
    const normalizedBaseline = structuredClone(baseline);
    const normalizedCandidate = structuredClone(candidate);
    delete normalizedBaseline.id;
    delete normalizedBaseline.purpose;
    delete normalizedCandidate.id;
    delete normalizedCandidate.purpose;
    for (const fieldPath of allowedPaths)
    {
        removePath(normalizedBaseline, fieldPath);
        removePath(normalizedCandidate, fieldPath);
    }
    if (canonicalJson(normalizedBaseline) !== canonicalJson(normalizedCandidate))
    {
        errors.push(`${profileId} must differ from throughput-musl only by ${allowedPaths.join(',')}`);
    }
}

function removePath(value, fieldPath)
{
    const segments = fieldPath.split('.');
    let current = value;
    for (let index = 0; index < segments.length - 1; index += 1)
    {
        current = current?.[segments[index]];
    }
    if (current)
    {
        delete current[segments.at(-1)];
    }
}

function rejectUnknown(value, allowed, label, errors)
{
    if (!plainObject(value))
    {
        return;
    }
    for (const key of Object.keys(value))
    {
        if (!allowed.has(key))
        {
            errors.push(`${label}.${key} is not allowed`);
        }
    }
}

function plainObject(value)
{
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function booleanText(value)
{
    return value ? 'true' : 'false';
}
