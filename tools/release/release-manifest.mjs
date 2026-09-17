import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertReleaseIdentity, isValidReleaseId } from './release-id.mjs';
import { assertSchemaCompatibilityWindow } from './schema-compatibility-coordinate.mjs';

export const RELEASE_MANIFEST_SCHEMA = 'fsusblog.release-manifest.v2';
export const LEGACY_RELEASE_MANIFEST_SCHEMA = 'fsusblog.release-manifest.v1';
export const LEGACY_RELEASE_MANIFEST_RETIREMENT =
    'Remove the v1 reader after every N-1 rollback artifact has expired from the supported rollback window.';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ZERO_SHA256 = `sha256:${'0'.repeat(64)}`;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const IMAGE_REPOSITORY = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[0-9]+(?:\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?)?$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const TOP_LEVEL_FIELDS = new Set([
    'schema',
    'releaseId',
    'commitSha',
    'imageRepository',
    'imageTag',
    'imageDigest',
    'imageRef',
    'registryDigestVerified',
    'createdAtUtc',
    'frontendManifestHash',
    'wasmArtifactHash',
    'schemaCompatibility',
    'toolchain',
    'runtimeProfile',
    'build'
]);
const SCHEMA_COMPATIBILITY_FIELDS = new Set(['minimumCoordinate', 'maximumCoordinate']);
const TOOLCHAIN_FIELDS = new Set(['dotnetVersion', 'nodeVersion', 'dockerVersion', 'dockerfileDigest']);
const BUILD_FIELDS = new Set(['dockerfile', 'target']);
const RUNTIME_PROFILE_FIELDS = new Set([
    'id', 'manifestDigest', 'profileDigest', 'baseImageFamily', 'targetRuntime',
    'singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops', 'serverGc',
    'nativeAot', 'threadPoolMode', 'topologyMode'
]);
const DEFAULT_RUNTIME_PROFILE = Object.freeze({
    id: 'throughput-musl',
    manifestDigest: `sha256:${'0'.repeat(64)}`,
    profileDigest: `sha256:${'0'.repeat(64)}`,
    baseImageFamily: 'musl',
    targetRuntime: 'linux-musl-x64',
    singleFile: true,
    readyToRun: false,
    tieredPgo: true,
    quickJitForLoops: true,
    serverGc: true,
    nativeAot: false,
    threadPoolMode: 'runtime-default',
    topologyMode: 'smt-visible'
});

export function sha256File(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function createReleaseManifest(input)
{
    const manifest = {
        schema: RELEASE_MANIFEST_SCHEMA,
        releaseId: input.releaseId,
        commitSha: input.commitSha,
        imageRepository: input.imageRepository,
        imageTag: input.imageTag,
        imageDigest: input.imageDigest,
        imageRef: `${input.imageRepository}@${input.imageDigest}`,
        registryDigestVerified: input.registryDigestVerified === true,
        createdAtUtc: input.createdAtUtc,
        frontendManifestHash: input.frontendManifestHash,
        wasmArtifactHash: input.wasmArtifactHash,
        schemaCompatibility: assertSchemaCompatibilityWindow(
            input.schemaMinimumCoordinate,
            input.schemaMaximumCoordinate
        ),
        toolchain: {
            dotnetVersion: input.dotnetVersion,
            nodeVersion: input.nodeVersion,
            dockerVersion: input.dockerVersion,
            dockerfileDigest: input.dockerfileDigest
        },
        runtimeProfile: { ...(input.runtimeProfile ?? DEFAULT_RUNTIME_PROFILE) },
        build: {
            dockerfile: 'ops/docker/FsusBlog.Server.Dockerfile',
            target: input.target ?? 'final'
        }
    };
    const errors = validateReleaseManifest(manifest, {
        requireRegistryDigest: true,
        requireConcreteRuntimeProfile: true
    });
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return manifest;
}

export function validateReleaseManifest(manifest, options = {})
{
    return validateManifest(manifest, options, {
        schema: RELEASE_MANIFEST_SCHEMA,
        requireCanonicalIdentity: true
    });
}

function validateManifest(manifest, options, contract)
{
    const errors = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    {
        return ['release manifest must be an object'];
    };
    rejectUnknownFields(manifest, TOP_LEVEL_FIELDS, 'manifest', errors);
    if (manifest.schema !== contract.schema)
    {
        errors.push(`schema must be ${contract.schema}`);
    };
    if (contract.requireCanonicalIdentity)
    {
        try
        {
            assertReleaseIdentity({
                releaseId: manifest.releaseId,
                createdAtUtc: manifest.createdAtUtc,
                commitSha: manifest.commitSha
            });
        }
        catch (error)
        {
            errors.push(...String(error instanceof Error ? error.message : error).split('\n'));
        }
    }
    else if (!isValidReleaseId(manifest.releaseId))
    {
        errors.push('releaseId must be a canonical immutable identifier');
    }
    if (!COMMIT_SHA.test(String(manifest.commitSha ?? '')))
    {
        errors.push('commitSha must be a lowercase full Git SHA');
    };
    if (!IMAGE_REPOSITORY.test(String(manifest.imageRepository ?? '')))
    {
        errors.push('imageRepository is invalid or mutable');
    };
    if (manifest.imageTag !== `${manifest.imageRepository}:${manifest.releaseId}`)
    {
        errors.push('imageTag must equal imageRepository:releaseId');
    };
    if (!SHA256.test(String(manifest.imageDigest ?? '')))
    {
        errors.push('imageDigest must be sha256:<64 lowercase hex>');
    }
    if (manifest.imageRef !== `${manifest.imageRepository}@${manifest.imageDigest}`)
    {
        errors.push('imageRef must be repository@digest');
    }
    if (options.requireRegistryDigest !== false && manifest.registryDigestVerified !== true)
    {
        errors.push('registryDigestVerified must be true');
    };
    const createdAtUtc = String(manifest.createdAtUtc ?? '');
    if (!isIsoUtcTimestamp(createdAtUtc))
    {
        errors.push('createdAtUtc must be an ISO UTC timestamp');
    };
    for (const field of ['frontendManifestHash', 'wasmArtifactHash'])
    {
        if (!SHA256.test(String(manifest[field] ?? '')))
        {
            errors.push(`${field} must be sha256:<64 lowercase hex>`);
        };
    }
    if (!manifest.schemaCompatibility || typeof manifest.schemaCompatibility !== 'object')
    {
        errors.push('schemaCompatibility is required');
    }
    else
    {
        rejectUnknownFields(manifest.schemaCompatibility, SCHEMA_COMPATIBILITY_FIELDS, 'schemaCompatibility', errors);
        try
        {
            assertSchemaCompatibilityWindow(
                manifest.schemaCompatibility.minimumCoordinate,
                manifest.schemaCompatibility.maximumCoordinate
            );
        }
        catch (error)
        {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    if (!manifest.toolchain || typeof manifest.toolchain !== 'object')
    {
        errors.push('toolchain is required');
    }
    else
    {
        rejectUnknownFields(manifest.toolchain, TOOLCHAIN_FIELDS, 'toolchain', errors);
        for (const field of ['dotnetVersion', 'nodeVersion', 'dockerVersion'])
        {
            const value = String(manifest.toolchain[field] ?? '').trim();
            if (!value || value.length > 128 || /[\r\n]/u.test(value))
            {
                errors.push(`toolchain.${field} is invalid`);
            }
        }
        if (!SHA256.test(String(manifest.toolchain.dockerfileDigest ?? '')))
        {
            errors.push('toolchain.dockerfileDigest must be sha256:<64 lowercase hex>');
        }
    }
    if (!manifest.build || typeof manifest.build !== 'object' || Array.isArray(manifest.build))
    {
        errors.push('build is required');
    }
    else
    {
        rejectUnknownFields(manifest.build, BUILD_FIELDS, 'build', errors);
    }
    if (manifest.build?.dockerfile !== 'ops/docker/FsusBlog.Server.Dockerfile')
    {
        errors.push('build.dockerfile is invalid');
    }
    if (manifest.build?.target !== 'final')
    {
        errors.push('build.target must be final');
    }
    if (manifest.runtimeProfile !== undefined)
    {
        validateRuntimeProfile(manifest.runtimeProfile, errors, options);
    }
    else if (options.requireConcreteRuntimeProfile === true)
    {
        errors.push('runtimeProfile is required for a final release manifest');
    }
    if (options.expectedReleaseId && manifest.releaseId !== options.expectedReleaseId)
    {
        errors.push('releaseId does not match requested release');
    }
    if (options.expectedImageRef && manifest.imageRef !== options.expectedImageRef)
    {
        errors.push('imageRef does not match requested image');
    }
    if (options.expectedImageDigest && manifest.imageDigest !== options.expectedImageDigest)
    {
        errors.push('imageDigest does not match requested digest');
    }
    if (options.expectedCommitSha && manifest.commitSha !== options.expectedCommitSha)
    {
        errors.push('commitSha does not match requested commit');
    }
    if (containsSensitiveField(manifest))
    {
        errors.push('release manifest contains a sensitive field name');
    }
    return errors;
}

function validateRuntimeProfile(value, errors, options = {})
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        errors.push('runtimeProfile must be an object');
        return;
    }
    rejectUnknownFields(value, RUNTIME_PROFILE_FIELDS, 'runtimeProfile', errors);
    if (!/^[a-z][a-z0-9-]{2,63}$/u.test(String(value.id ?? '')))
    {
        errors.push('runtimeProfile.id is invalid');
    }
    for (const field of ['manifestDigest', 'profileDigest'])
    {
        if (!SHA256.test(String(value[field] ?? '')))
        {
            errors.push(`runtimeProfile.${field} must be sha256:<64 lowercase hex>`);
        }
        else if (options.requireConcreteRuntimeProfile === true && value[field] === ZERO_SHA256)
        {
            errors.push(`runtimeProfile.${field} must not be the zero digest`);
        }
    }
    if (!['musl', 'glibc'].includes(value.baseImageFamily))
    {
        errors.push('runtimeProfile.baseImageFamily is invalid');
    }
    if (!['linux-musl-x64', 'linux-x64'].includes(value.targetRuntime))
    {
        errors.push('runtimeProfile.targetRuntime is invalid');
    }
    if (value.baseImageFamily === 'musl' && value.targetRuntime !== 'linux-musl-x64')
    {
        errors.push('runtimeProfile musl targetRuntime mismatch');
    }
    if (value.baseImageFamily === 'glibc' && value.targetRuntime !== 'linux-x64')
    {
        errors.push('runtimeProfile glibc targetRuntime mismatch');
    }
    for (const field of ['singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops', 'serverGc', 'nativeAot'])
    {
        if (typeof value[field] !== 'boolean')
        {
            errors.push(`runtimeProfile.${field} must be boolean`);
        }
    }
    if (value.nativeAot === true)
    {
        errors.push('runtimeProfile.nativeAot cannot enter the full production release manifest without narrow prototype parity promotion');
    }
    if (!['runtime-default', 'evidence-derived', 'overprovisioned-negative-control'].includes(value.threadPoolMode))
    {
        errors.push('runtimeProfile.threadPoolMode is invalid');
    }
    if (!['smt-visible', 'physical-core-only', 'numa-local'].includes(value.topologyMode))
    {
        errors.push('runtimeProfile.topologyMode is invalid');
    }
}

export function readReleaseManifest(file, options = {})
{
    const manifest = parseReleaseManifestFile(file);
    const errors = validateReleaseManifest(manifest, options);
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    };
    return manifest;
}

export function readLegacyReleaseManifestV1(file, options = {})
{
    const manifest = parseReleaseManifestFile(file);
    const errors = validateManifest(manifest, options, {
        schema: LEGACY_RELEASE_MANIFEST_SCHEMA,
        requireCanonicalIdentity: false
    });
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    };
    return Object.freeze({
        legacy: true,
        rollbackOnly: true,
        retirementCondition: LEGACY_RELEASE_MANIFEST_RETIREMENT,
        manifest
    });
}

export function writeReleaseManifestAtomic(file, manifest)
{
    const errors = validateReleaseManifest(manifest, {
        requireRegistryDigest: true,
        requireConcreteRuntimeProfile: true
    });
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        fs.linkSync(temporary, file);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

function parseReleaseManifestFile(file)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`unable to read release manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function rejectUnknownFields(value, allowed, label, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return;
    };
    for (const field of Object.keys(value))
    {
        if (!allowed.has(field))
        {
            errors.push(`${label}.${field} is not allowed`);
        }
    }
}

function isIsoUtcTimestamp(value)
{
    if (!ISO_UTC.test(value))
    {
        return false;
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
    {
        return false;
    }
    const canonical = new Date(timestamp).toISOString();
    return value === canonical || (canonical.endsWith('.000Z') && value === canonical.replace('.000Z', 'Z'));
}

function containsSensitiveField(value)
{
    if (Array.isArray(value))
    {
        return value.some(containsSensitiveField);
    }
    if (!value || typeof value !== 'object')
    {
        return false;
    }
    for (const [key, nested] of Object.entries(value))
    {
        const normalized = key.toLowerCase();
        if (/(?:password|passwd|token|privatekey|secret|credential)$/u.test(normalized))
        {
            return true;
        }
        if (containsSensitiveField(nested))
        {
            return true;
        }
    }
    return false;
}
