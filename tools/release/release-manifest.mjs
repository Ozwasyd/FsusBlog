import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_ID_CONTRACT } from './release-id.mjs';
import { SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT } from './schema-compatibility-coordinate.mjs';

import { createReleaseManifestValueContract, LEGACY_RELEASE_MANIFEST_RETIREMENT } from './release-manifest-value-contract.mjs';
export { RELEASE_MANIFEST_SCHEMA, LEGACY_RELEASE_MANIFEST_SCHEMA, LEGACY_RELEASE_MANIFEST_RETIREMENT } from './release-manifest-value-contract.mjs';

const manifestContract = createReleaseManifestValueContract({ releaseIdContract: RELEASE_ID_CONTRACT, schemaCompatibilityContract: SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT });
export const { createReleaseManifest, validateReleaseManifest } = manifestContract;

export function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

export function readReleaseManifest(file, options = {})
{
    const manifest = parseReleaseManifestFile(file);
    const errors = validateReleaseManifest(manifest, options);
    if (errors.length > 0) {throw new Error(errors.join('\n'))};
    return manifest;
}

export function readLegacyReleaseManifestV1(file, options = {})
{
    const manifest = parseReleaseManifestFile(file);
    const errors = manifestContract.validateLegacyReleaseManifestV1(manifest, options);
    if (errors.length > 0) {throw new Error(errors.join('\n'))};
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
    if (errors.length > 0) {throw new Error(errors.join('\n'))};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try
{
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    fs.linkSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
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
