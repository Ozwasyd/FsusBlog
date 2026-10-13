import { createReleaseIdValueContract } from './release-id-value-contract.mjs';
import { isDeepStrictEqual } from 'node:util';

export const RELEASE_MANIFEST_SCHEMA = 'fsusblog.release-manifest.v3';
export const LEGACY_RELEASE_MANIFEST_SCHEMA = 'fsusblog.release-manifest.v1';
export const LEGACY_RELEASE_MANIFEST_RETIREMENT =
    'Legacy compatibility-window and image-only rollback manifests are retired; rebuild a current-only release manifest.';
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
    'currentSchema',
    'toolchain',
    'runtimeProfile',
    'build'
]);
const TOOLCHAIN_FIELDS = new Set(['dotnetVersion', 'nodeVersion', 'dockerVersion', 'dockerfileDigest']);
const BUILD_FIELDS = new Set(['dockerfile', 'target']);
const RUNTIME_PROFILE_FIELDS = new Set([
  'id', 'manifestDigest', 'profileDigest', 'baseImageFamily', 'targetRuntime',
  'singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops', 'serverGc',
  'nativeAot', 'threadPoolMode', 'topologyMode'
])
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
})


export function createReleaseManifestValueContract({ releaseIdContract })
{
    const { assertReleaseIdentity, isValidReleaseId } = createReleaseIdValueContract(releaseIdContract);
function createReleaseManifest(input) {
    if (Object.hasOwn(input, 'schemaMinimumCoordinate') || Object.hasOwn(input, 'schemaMaximumCoordinate'))
    {
        throw new Error('schema compatibility windows are retired');
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
        currentSchema: structuredClone(input.currentSchema),
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
  }
  const errors = validateReleaseManifest(manifest, {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true
  })
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return manifest
}

function validateReleaseManifest(manifest, options = {})
{
    return validateManifest(manifest, options, {
        schema: RELEASE_MANIFEST_SCHEMA,
        requireCanonicalIdentity: true
    });
}

function validateManifest(manifest, options, contract)
{
    const errors = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {return ['release manifest must be an object']};
    rejectUnknownFields(manifest, TOP_LEVEL_FIELDS, 'manifest', errors);
    if (manifest.schema !== contract.schema) {errors.push(`schema must be ${contract.schema}`)};
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
    if (!COMMIT_SHA.test(String(manifest.commitSha ?? ''))) {errors.push('commitSha must be a lowercase full Git SHA')};
    if (!IMAGE_REPOSITORY.test(String(manifest.imageRepository ?? ''))) {errors.push('imageRepository is invalid or mutable')};
    if (manifest.imageTag !== `${manifest.imageRepository}:${manifest.releaseId}`) {errors.push('imageTag must equal imageRepository:releaseId')};
  if (!SHA256.test(String(manifest.imageDigest ?? ''))) errors.push('imageDigest must be sha256:<64 lowercase hex>')
  if (manifest.imageRef !== `${manifest.imageRepository}@${manifest.imageDigest}`) errors.push('imageRef must be repository@digest')
    if (options.requireRegistryDigest !== false && manifest.registryDigestVerified !== true) {errors.push('registryDigestVerified must be true')};
    const createdAtUtc = String(manifest.createdAtUtc ?? '');
    if (!isIsoUtcTimestamp(createdAtUtc)) {errors.push('createdAtUtc must be an ISO UTC timestamp')};
    for (const field of ['frontendManifestHash', 'wasmArtifactHash'])
{
        if (!SHA256.test(String(manifest[field] ?? ''))) {errors.push(`${field} must be sha256:<64 lowercase hex>`)};
    }
    validateCurrentSchemaBinding(manifest.currentSchema, errors);
    if (!manifest.toolchain || typeof manifest.toolchain !== 'object')
{
    errors.push('toolchain is required')
  } else {
    rejectUnknownFields(manifest.toolchain, TOOLCHAIN_FIELDS, 'toolchain', errors)
    for (const field of ['dotnetVersion', 'nodeVersion', 'dockerVersion']) {
      const value = String(manifest.toolchain[field] ?? '').trim()
      if (!value || value.length > 128 || /[\r\n]/u.test(value)) errors.push(`toolchain.${field} is invalid`)
    }
    if (!SHA256.test(String(manifest.toolchain.dockerfileDigest ?? ''))) errors.push('toolchain.dockerfileDigest must be sha256:<64 lowercase hex>')
  }
  if (!manifest.build || typeof manifest.build !== 'object' || Array.isArray(manifest.build)) {
    errors.push('build is required')
  } else {
    rejectUnknownFields(manifest.build, BUILD_FIELDS, 'build', errors)
  }
  if (manifest.build?.dockerfile !== 'ops/docker/FsusBlog.Server.Dockerfile') errors.push('build.dockerfile is invalid')
  if (manifest.build?.target !== 'final') errors.push('build.target must be final')
  if (manifest.runtimeProfile !== undefined) validateRuntimeProfile(manifest.runtimeProfile, errors, options)
  else if (options.requireConcreteRuntimeProfile === true) errors.push('runtimeProfile is required for a final release manifest')
  if (options.expectedReleaseId && manifest.releaseId !== options.expectedReleaseId) errors.push('releaseId does not match requested release')
  if (options.expectedImageRef && manifest.imageRef !== options.expectedImageRef) errors.push('imageRef does not match requested image')
  if (options.expectedImageDigest && manifest.imageDigest !== options.expectedImageDigest) errors.push('imageDigest does not match requested digest')
  if (options.expectedCommitSha && manifest.commitSha !== options.expectedCommitSha) errors.push('commitSha does not match requested commit')
  if (containsSensitiveField(manifest)) errors.push('release manifest contains a sensitive field name')
  return errors
}

function validateRuntimeProfile(value, errors, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('runtimeProfile must be an object')
    return
  }
  rejectUnknownFields(value, RUNTIME_PROFILE_FIELDS, 'runtimeProfile', errors)
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(String(value.id ?? ''))) errors.push('runtimeProfile.id is invalid')
  for (const field of ['manifestDigest', 'profileDigest']) {
    if (!SHA256.test(String(value[field] ?? ''))) errors.push(`runtimeProfile.${field} must be sha256:<64 lowercase hex>`)
    else if (options.requireConcreteRuntimeProfile === true && value[field] === ZERO_SHA256) errors.push(`runtimeProfile.${field} must not be the zero digest`)
  }
  if (!['musl', 'glibc'].includes(value.baseImageFamily)) errors.push('runtimeProfile.baseImageFamily is invalid')
  if (!['linux-musl-x64', 'linux-x64'].includes(value.targetRuntime)) errors.push('runtimeProfile.targetRuntime is invalid')
  if (value.baseImageFamily === 'musl' && value.targetRuntime !== 'linux-musl-x64') errors.push('runtimeProfile musl targetRuntime mismatch')
  if (value.baseImageFamily === 'glibc' && value.targetRuntime !== 'linux-x64') errors.push('runtimeProfile glibc targetRuntime mismatch')
  for (const field of ['singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops', 'serverGc', 'nativeAot']) {
    if (typeof value[field] !== 'boolean') errors.push(`runtimeProfile.${field} must be boolean`)
  }
  if (value.nativeAot === true) errors.push('runtimeProfile.nativeAot cannot enter the full production release manifest without narrow prototype parity promotion')
  if (!['runtime-default', 'evidence-derived', 'overprovisioned-negative-control'].includes(value.threadPoolMode)) errors.push('runtimeProfile.threadPoolMode is invalid')
  if (!['smt-visible', 'physical-core-only', 'numa-local'].includes(value.topologyMode)) errors.push('runtimeProfile.topologyMode is invalid')
}

function validateLegacyReleaseManifestV1()
{
    return [LEGACY_RELEASE_MANIFEST_RETIREMENT];
}

/** Validates only the release's explicit current-only references; it never grants database admission. */
    return { createReleaseManifest, validateReleaseManifest, validateLegacyReleaseManifestV1 };
}

export function validateCurrentSchemaBinding(value, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        errors.push('currentSchema is required');
        return;
    }
    rejectUnknownFields(value, new Set(['receipt', 'target', 'database', 'actualSchemaDigest']), 'currentSchema', errors);
    const object = (part, fields, label) =>
    {
        if (!part || typeof part !== 'object' || Array.isArray(part))
        {
            errors.push(`${label} is required`);
            return false;
        }
        rejectUnknownFields(part, new Set(fields), label, errors);
        return true;
    };
    const text = (value, label) =>
    {
        if (typeof value !== 'string' || !value.trim() || value !== value.trim()
            || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
            || Buffer.from(value, 'utf8').toString('utf8') !== value)
        {
            errors.push(`${label} must be exact nonempty text`);
        }
    };
    const digest = (value, label) =>
    {
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
        {
            errors.push(`${label} must be a raw lowercase SHA-256`);
        }
    };
    if (object(value.receipt, ['reference', 'sha256'], 'currentSchema.receipt'))
    {
        text(value.receipt.reference, 'currentSchema.receipt.reference');
        if (typeof value.receipt.reference === 'string'
            && value.receipt.reference.split(/[\\/]/u).some(part => part.toLowerCase() === 'latest'))
        {
            errors.push('currentSchema.receipt.reference cannot select latest');
        }
        digest(value.receipt.sha256, 'currentSchema.receipt.sha256');
    }
    if (object(value.target, ['modelVersion', 'extractorVersion', 'generatorVersion', 'sourceDigest', 'contentDigest'], 'currentSchema.target'))
    {
        for (const field of ['modelVersion', 'extractorVersion', 'generatorVersion'])
        {
            text(value.target[field], `currentSchema.target.${field}`);
        }
        for (const field of ['sourceDigest', 'contentDigest'])
        {
            digest(value.target[field], `currentSchema.target.${field}`);
        }
    }
    if (object(value.database, ['provider', 'instanceId', 'databaseId'], 'currentSchema.database'))
    {
        if (![0, 1, 2].includes(value.database.provider))
        {
            errors.push('currentSchema.database.provider must be a closed CurrentSchemaProviderKind value');
        }
        text(value.database.instanceId, 'currentSchema.database.instanceId');
        text(value.database.databaseId, 'currentSchema.database.databaseId');
    }
    digest(value.actualSchemaDigest, 'currentSchema.actualSchemaDigest');
}

function rejectUnknownFields(value, allowed, label, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return};
    for (const field of Object.keys(value))
{
    if (!allowed.has(field)) errors.push(`${label}.${field} is not allowed`)
  }
}

function isIsoUtcTimestamp(value) {
  if (!ISO_UTC.test(value)) return false
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return false
  const canonical = new Date(timestamp).toISOString()
  return value === canonical || (canonical.endsWith('.000Z') && value === canonical.replace('.000Z', 'Z'))
}

function containsSensitiveField(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveField)
  if (!value || typeof value !== 'object') return false
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase()
    if (/(?:password|passwd|token|privatekey|secret|credential)$/u.test(normalized)) return true
    if (containsSensitiveField(nested)) return true
  }
  return false
}

/** Checks only bindings of the sole Server command's output, never substitutes for executing that command. */
export function validateCurrentSchemaAdmissionOutput(value, binding, candidateSourceRevision)
{
    const errors = [];
    validateCurrentSchemaBinding(binding, errors);
    if (typeof candidateSourceRevision !== 'string' || !/^[0-9a-f]{40}$/u.test(candidateSourceRevision) || /^0+$/u.test(candidateSourceRevision))
    {
        errors.push('candidate source revision must be an exact nonzero Git SHA');
    }
    const fields = ['status', 'candidateSourceRevision', 'artifactSha256', 'target', 'database', 'actualSchemaDigest'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\n') !== [...fields].sort().join('\n'))
    {
        errors.push('current schema admission output must contain the exact Server output fields');
        return errors;
    }
    if (value.status !== 'verified-current' || value.candidateSourceRevision !== candidateSourceRevision
        || value.artifactSha256 !== binding?.receipt?.sha256
        || !isDeepStrictEqual(value.target, binding?.target)
        || !isDeepStrictEqual(value.database, binding?.database)
        || value.actualSchemaDigest !== binding?.actualSchemaDigest)
    {
        errors.push('current schema admission output does not match the immutable candidate receipt bindings');
    }
    return errors;
}
