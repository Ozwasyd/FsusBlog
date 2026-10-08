import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { RELEASE_ID_CONTRACT } from './release-id.mjs';
import { createReleaseManifestValueContract, RELEASE_MANIFEST_SCHEMA, validateCurrentSchemaBinding, deriveReleaseCandidateId, deriveReleaseManifestContentDigest } from './release-manifest-value-contract.mjs';

const { createReleaseManifest, validateReleaseManifest } = createReleaseManifestValueContract({ releaseIdContract: RELEASE_ID_CONTRACT });

export { createReleaseManifest, RELEASE_MANIFEST_SCHEMA, validateReleaseManifest, deriveReleaseCandidateId, deriveReleaseManifestContentDigest };

export function sha256File(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

/**
 * Reads an explicitly selected receipt artifact for release byte binding only.
 * The C# receipt codec, offline verifier and live Server admission remain the
 * only owners of receipt integrity, database verification and runtime readiness.
 */
export function readExplicitReleaseArtifact(reference, expectedSha256, maximumBytes = 1024 * 1024)
{
    if (typeof reference !== 'string' || !path.isAbsolute(reference) || path.resolve(reference) !== reference
        || !/^[0-9a-f]{64}$/u.test(String(expectedSha256 ?? '')))
    {
        throw new Error('current-schema receipt requires an explicit canonical path and artifact SHA-256');
    }
    const before = fs.lstatSync(reference, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size === 0n || before.size > BigInt(maximumBytes) || fs.realpathSync(reference) !== reference
        || fs.constants.O_NOFOLLOW === undefined)
    {
        throw new Error('current-schema receipt artifact is not a bounded canonical regular file');
    }
    const descriptor = fs.openSync(reference, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try
    {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1n)
        {
            throw new Error('current-schema receipt artifact identity changed before read');
        }
        bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length)
        {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count === 0)
            {
                throw new Error('current-schema receipt artifact was truncated during read');
            }
            offset += count;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        const named = fs.lstatSync(reference, { bigint: true });
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1n
            || fs.realpathSync(reference) !== reference)
        {
            throw new Error('current-schema receipt artifact changed during read');
        }
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedSha256)
    {
        throw new Error('current-schema receipt artifact digest mismatch');
    }
    return bytes;
}

export function readCurrentSchemaReceiptReleaseBinding(reference, expectedSha256)
{
    const bytes = readExplicitReleaseArtifact(reference, expectedSha256);
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (receipt.format !== 'fsusblog.current-schema-receipt.v1' || receipt.status !== 'verified-current')
    {
        throw new Error('current-schema receipt format/status cannot bind a current release');
    }
    const binding = {
        receiptFormat: receipt.format,
        receipt: { reference, sha256: expectedSha256 },
        receiptContentDigest: receipt.contentDigest,
        target: receipt.target,
        database: receipt.database,
        actualSchemaDigest: receipt.actualSchemaDigest
    };
    const errors = validateCurrentSchemaBinding(binding);
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return binding;
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
        throw new Error(`unable to read release manifest: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}
