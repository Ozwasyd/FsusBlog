import path from 'node:path';

import { assertReleaseIdentity } from './release-id.mjs';
import { readReleaseManifest } from './release-manifest.mjs';

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REF = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[0-9]+(?:\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?)?@sha256:[0-9a-f]{64}$/u;

export function readDeploymentReleaseIdentity(file, expected = {})
{
    const manifestPath = path.resolve(file);
    const manifest = readReleaseManifest(manifestPath, {
        requireRegistryDigest: true,
        requireConcreteRuntimeProfile: true,
        expectedReleaseId: expected.releaseId,
        expectedImageRef: expected.imageRef,
        expectedImageDigest: expected.imageDigest,
        expectedCommitSha: expected.commitSha
    });
    if (expected.createdAtUtc && manifest.createdAtUtc !== expected.createdAtUtc)
    {
        throw new Error('createdAtUtc does not match expected manifest identity');
    }
    return validateDeploymentReleaseIdentity({
        manifestSchema: manifest.schema,
        manifestPath,
        releaseId: manifest.releaseId,
        createdAtUtc: manifest.createdAtUtc,
        commitSha: manifest.commitSha,
        imageRef: manifest.imageRef,
        imageDigest: manifest.imageDigest
    });
}

export function validateDeploymentReleaseIdentity(value, label = 'releaseIdentity')
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} is required`);
    }
    if (value.manifestSchema !== 'fsusblog.release-manifest.v3')
    {
        throw new Error(`${label}.manifestSchema must be fsusblog.release-manifest.v3`);
    }
    const rawManifestPath = String(value.manifestPath ?? '');
    if (!rawManifestPath || !path.isAbsolute(rawManifestPath) || rawManifestPath.includes('\0'))
    {
        throw new Error(`${label}.manifestPath is invalid`);
    }
    const manifestPath = path.resolve(rawManifestPath);
    assertReleaseIdentity({
        releaseId: value.releaseId,
        createdAtUtc: value.createdAtUtc,
        commitSha: value.commitSha
    });
    if (!IMAGE_DIGEST.test(String(value.imageDigest ?? '')))
    {
        throw new Error(`${label}.imageDigest is invalid`);
    }
    if (!IMAGE_REF.test(String(value.imageRef ?? '')) || !value.imageRef.endsWith(`@${value.imageDigest}`))
    {
        throw new Error(`${label}.imageRef is invalid or does not match imageDigest`);
    }
    return Object.freeze({
        manifestSchema: value.manifestSchema,
        manifestPath,
        releaseId: value.releaseId,
        createdAtUtc: value.createdAtUtc,
        commitSha: value.commitSha,
        imageRef: value.imageRef,
        imageDigest: value.imageDigest
    });
}

export function assertDeploymentReleaseIdentityMatches(actual, expected, label = 'releaseIdentity')
{
    const identity = validateDeploymentReleaseIdentity(actual, label);
    for (const field of ['releaseId', 'createdAtUtc', 'commitSha', 'imageRef', 'imageDigest'])
    {
        if (expected?.[field] !== undefined && expected[field] !== '' && identity[field] !== expected[field])
        {
            throw new Error(`${label}.${field} does not match expected value`);
        }
    }
    return identity;
}
