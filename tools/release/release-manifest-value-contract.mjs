/* eslint-disable import-x/no-relative-parent-imports -- Candidate sealing uses the repository's canonical pure semantic digest owner. */
import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs';

import { createReleaseIdValueContract } from './release-id-value-contract.mjs';
import { releaseIdentityRosterContent, validateReleaseIdentityRoster } from './release-manifest-identity-contract.mjs';


export const RELEASE_MANIFEST_SCHEMA = 'fsusblog.release-manifest.v3';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ZERO_SHA256 = `sha256:${'0'.repeat(64)}`;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const IMAGE_REPOSITORY = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[0-9]+(?:\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?)?$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const TOP_LEVEL_FIELDS = new Set([
    'schema',
    'candidateId',
    'contentDigest',
    'signature',
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
    'currentSchema',
    'identity',
    'toolchain',
    'runtimeProfile',
    'build'
]);
const currentSchemaFields = new Set(['receiptFormat', 'receipt', 'receiptContentDigest', 'target', 'database', 'actualSchemaDigest']);
const receiptReferenceFields = new Set(['reference', 'sha256']);
const targetFields = new Set(['modelVersion', 'extractorVersion', 'generatorVersion', 'sourceDigest', 'contentDigest']);
const databaseFields = new Set(['provider', 'instanceId', 'databaseId']);
const hexDigest = /^[0-9a-f]{64}$/u;
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


function hasControlCharacter(value)
{
    return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Validates a release projection of the existing receipt; it does not verify a database or issue a receipt. */
export function validateCurrentSchemaBinding(binding)
{
    const errors = [];
    function closed(value, fields, label)
    {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).sort().join(',') !== [...fields].sort().join(','))
        {
            errors.push(`${label} fields must be closed exact`);
            return false;
        }
        return true;
    }
    if (!closed(binding, currentSchemaFields, 'currentSchema'))
    {
        return errors;
    }
    if (binding.receiptFormat !== 'fsusblog.current-schema-receipt.v1')
    {
        errors.push('currentSchema.receiptFormat must reference the canonical current-schema receipt v1');
    }
    for (const key of ['receiptContentDigest', 'actualSchemaDigest'])
    {
        if (!hexDigest.test(String(binding[key] ?? '')))
        {
            errors.push(`currentSchema.${key} must be a lowercase SHA-256`);
        }
    }
    if (closed(binding.receipt, receiptReferenceFields, 'currentSchema.receipt'))
    {
        const reference = binding.receipt.reference;
        if (typeof reference !== 'string' || !/^(?:\/|[A-Za-z]:[\\/])/u.test(reference)
            || reference !== reference.trim() || hasControlCharacter(reference)
            || /(?:^|[\\/])(?:latest|previous|stable)(?:[\\/]|$)/u.test(reference))
        {
            errors.push('currentSchema.receipt.reference must be an explicit absolute artifact path');
        }
        if (!hexDigest.test(String(binding.receipt.sha256 ?? '')))
        {
            errors.push('currentSchema.receipt.sha256 must be a lowercase artifact SHA-256');
        }
    }
    if (closed(binding.target, targetFields, 'currentSchema.target'))
    {
        for (const key of ['modelVersion', 'extractorVersion', 'generatorVersion'])
        {
            if (typeof binding.target[key] !== 'string' || binding.target[key].trim() !== binding.target[key]
                || !binding.target[key] || hasControlCharacter(binding.target[key]))
            {
                errors.push(`currentSchema.target.${key} must be an exact nonempty value`);
            }
        }
        for (const key of ['sourceDigest', 'contentDigest'])
        {
            if (!hexDigest.test(String(binding.target[key] ?? '')))
            {
                errors.push(`currentSchema.target.${key} must be a lowercase SHA-256`);
            }
        }
    }
    if (closed(binding.database, databaseFields, 'currentSchema.database'))
    {
        if (![0, 1, 2].includes(binding.database.provider))
        {
            errors.push('currentSchema.database.provider must be the canonical PostgreSQL/MySQL/SQLite enum value');
        }
        for (const key of ['instanceId', 'databaseId'])
        {
            if (typeof binding.database[key] !== 'string' || !binding.database[key]
                || binding.database[key] !== binding.database[key].trim() || hasControlCharacter(binding.database[key]))
            {
                errors.push(`currentSchema.database.${key} must be an exact nonempty value`);
            }
        }
    }
    return errors;
}

/** A candidate is identified by artifact and contract content, never by a deployment label or artifact location. */
export function deriveReleaseCandidateId(manifest)
{
    const binding = manifest.currentSchema;
    return `sha256:${digestValue(stable({
        schema: RELEASE_MANIFEST_SCHEMA,
        identity: releaseIdentityRosterContent(manifest.identity),
        commitSha: manifest.commitSha,
        imageDigest: manifest.imageDigest,
        frontendManifestHash: manifest.frontendManifestHash,
        wasmArtifactHash: manifest.wasmArtifactHash,
        currentSchema: binding ? {
            receiptFormat: binding.receiptFormat,
            receiptArtifactSha256: binding.receipt?.sha256,
            receiptContentDigest: binding.receiptContentDigest,
            target: binding.target,
            database: binding.database,
            actualSchemaDigest: binding.actualSchemaDigest
        } : null,
        toolchain: manifest.toolchain,
        runtimeProfile: manifest.runtimeProfile,
        build: manifest.build
    }))}`;
}

export function deriveReleaseManifestContentDigest(manifest)
{
    const unsigned = { ...manifest };
    delete unsigned.contentDigest;
    delete unsigned.signature;
    return `sha256:${digestValue(stable(unsigned))}`;
}

export function createReleaseManifestValueContract({ releaseIdContract })
{
    const { assertReleaseIdentity } = createReleaseIdValueContract(releaseIdContract);
    function createReleaseManifest(input)
    {
        if (Object.hasOwn(input, 'candidateId') || Object.hasOwn(input, 'contentDigest'))
        {
            throw new Error('candidateId and contentDigest must be computed from the current manifest');
        }
        if (Object.hasOwn(input, 'schemaMinimumCoordinate') || Object.hasOwn(input, 'schemaMaximumCoordinate')
            || Object.hasOwn(input, 'schemaCompatibility'))
        {
            throw new Error('schema compatibility inputs are unsupported; use the exact current-schema receipt binding');
        }
        const inputFields = new Set(['releaseId', 'commitSha', 'imageRepository', 'imageTag', 'imageDigest',
            'registryDigestVerified', 'createdAtUtc', 'frontendManifestHash', 'wasmArtifactHash', 'currentSchema',
            'identity', 'dotnetVersion', 'nodeVersion', 'dockerVersion', 'dockerfileDigest', 'runtimeProfile', 'target', 'signature']);
        for (const key of Object.keys(input))
        {
            if (!inputFields.has(key))
            {
                throw new Error(`unsupported release manifest input: ${key}`);
            }
        }
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
            currentSchema: input.currentSchema,
            identity: input.identity,
            signature: input.signature ?? null,
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
        manifest.candidateId = deriveReleaseCandidateId(manifest);
        manifest.contentDigest = deriveReleaseManifestContentDigest(manifest);
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

    function validateReleaseManifest(manifest, options = {})
    {
        return validateManifest(manifest, options);
    }

    function validateManifest(manifest, options)
    {
        const errors = [];
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
        {
            return ['release manifest must be an object'];
        };
        rejectUnknownFields(manifest, TOP_LEVEL_FIELDS, 'manifest', errors);
        if (manifest.schema !== RELEASE_MANIFEST_SCHEMA)
        {
            errors.push(`schema must be ${RELEASE_MANIFEST_SCHEMA}`);
        };
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
        errors.push(...validateCurrentSchemaBinding(manifest.currentSchema));
        errors.push(...validateReleaseIdentityRoster(manifest));
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
        if (!SHA256.test(String(manifest.candidateId ?? '')) || manifest.candidateId !== deriveReleaseCandidateId(manifest))
        {
            errors.push('candidateId must equal the current manifest content identity');
        }
        if (!SHA256.test(String(manifest.contentDigest ?? '')) || manifest.contentDigest !== deriveReleaseManifestContentDigest(manifest))
        {
            errors.push('contentDigest must equal the sealed manifest bytes projection');
        }
        if (manifest.signature !== null && (typeof manifest.signature !== 'string'
            || !/^[A-Za-z0-9+/]{86}==$/u.test(manifest.signature)
            || Buffer.from(manifest.signature, 'base64').toString('base64') !== manifest.signature))
        {
            errors.push('signature must be a canonical 64-byte Ed25519 signature or an explicitly unsigned draft');
        }
        if (options.requireSignature === true && manifest.signature === null)
        {
            errors.push('unsigned manifest cannot enter artifact verification or activation');
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

    return { createReleaseManifest, validateReleaseManifest };
}
