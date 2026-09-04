import { spawnSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync
} from 'node:fs';
import path from 'node:path';

import {
    canonicalize,
    digestBuffer,
    digestText,
    digestValue,
    isPlainObject
} from './lib/canonicalize.mjs';

const commitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const buildReceiptSchemaPattern = /^fsusblog\.[a-z0-9-]+-build-receipt\.v([12])$/u;
export const sourceBoundBuildIdentitySchema = 'fsusblog.fact-extractor-build-identity.v2';
const legacyBuildIdentityKeys = Object.freeze([
    'artifactId',
    'receiptDigest',
    'artifactDigest'
]);
const sourceBoundBuildIdentityKeys = Object.freeze([
    'schema',
    ...legacyBuildIdentityKeys,
    'sourceDigests',
    'sourceDigest'
]);

function git(args, cwd)
{
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
}

export function resolveSourceCommit(repositoryRoot)
{
    const commit = git(['rev-parse', 'HEAD'], repositoryRoot).trim();
    if (!commitPattern.test(commit))
    {
        throw new Error(`sourceCommit must be a full lowercase SHA; got ${commit}`);
    }
    return commit;
}

/**
 * Fingerprint of tracked + relevant untracked worktree content (not HEAD alone).
 * Includes binary diff against HEAD and digests of untracked non-ignored files.
 */
export function resolveWorktreeFingerprint(repositoryRoot)
{
    const diff = git(['diff', '--binary', 'HEAD', '--'], repositoryRoot);
    const untracked = git(['ls-files', '--others', '--exclude-standard'], repositoryRoot)
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((relative) => relative.replaceAll(path.sep, '/'))
        .sort();
    const untrackedBindings = untracked.map((relative) =>
    {
        const absolute = path.join(repositoryRoot, relative);
        if (!existsSync(absolute) || !statSync(absolute).isFile())
        {
            return { path: relative, digest: digestText('') };
        }
        return { path: relative, digest: digestBuffer(readFileSync(absolute)) };
    });
    return digestValue({ diff, untrackedBindings });
}

export function digestPath(repositoryRoot, relativePath)
{
    const absolute = path.resolve(repositoryRoot, relativePath);
    const rootResolved = path.resolve(repositoryRoot);
    if (!absolute.startsWith(`${rootResolved}${path.sep}`) && absolute !== rootResolved)
    {
        throw new Error(`path escapes repository root: ${relativePath}`);
    }
    if (!existsSync(absolute))
    {
        throw new Error(`consumed input missing: ${relativePath}`);
    }
    const stat = statSync(absolute);
    if (stat.isDirectory())
    {
        const files = [];
        const walk = (directory, relativeDirectory) =>
        {
            for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)))
            {
                if (entry.name === '.git' || entry.name === 'node_modules')
                {
                    continue;
                }
                const childRelative = path.posix.join(relativeDirectory, entry.name);
                const childAbsolute = path.join(directory, entry.name);
                if (entry.isDirectory())
                {
                    walk(childAbsolute, childRelative);
                }
                else if (entry.isFile())
                {
                    files.push({ path: childRelative, digest: digestBuffer(readFileSync(childAbsolute)) });
                }
            }
        };
        walk(absolute, relativePath.replaceAll(path.sep, '/'));
        return digestValue(files);
    }
    if (!stat.isFile())
    {
        throw new Error(`consumed input is not a regular file or directory: ${relativePath}`);
    }
    return digestBuffer(readFileSync(absolute));
}

export function computeConsumedInputDigests(repositoryRoot, consumedInputs)
{
    const normalized = [...new Set(consumedInputs.map((entry) => String(entry).replaceAll(path.sep, '/')))].sort();
    return normalized.map((relative) => ({
        path: relative,
        digest: digestPath(repositoryRoot, relative)
    }));
}

function exactKeys(value, expected)
{
    return isPlainObject(value)
        && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function normalizeRelativePath(relativePath, label)
{
    if (typeof relativePath !== 'string'
        || relativePath.length === 0
        || relativePath.includes('\0')
        || relativePath.includes('\\')
        || path.isAbsolute(relativePath)
        || relativePath.split('/').includes('..')
        || path.posix.normalize(relativePath) !== relativePath)
    {
        throw new Error(`${label} must be a canonical repository-relative path`);
    }
    return relativePath;
}

function readExactRegularFile(repositoryRoot, relativePath, label)
{
    const normalized = normalizeRelativePath(relativePath, label);
    const rootResolved = realpathSync(repositoryRoot);
    const absolute = path.join(rootResolved, normalized);
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile())
    {
        throw new Error(`${label} must resolve to an existing regular non-symlink file`);
    }
    const resolved = realpathSync(absolute);
    if (!resolved.startsWith(`${rootResolved}${path.sep}`))
    {
        throw new Error(`${label} escapes repository root`);
    }
    return readFileSync(resolved);
}

function validateSourceDigests(sourceDigests, sourceDigest, repositoryRoot)
{
    if (!isPlainObject(sourceDigests) || Object.keys(sourceDigests).length === 0)
    {
        throw new Error('buildIdentity.sourceDigests must be a non-empty object');
    }
    const sourcePaths = Object.keys(sourceDigests);
    if (sourcePaths.join('\0') !== [...sourcePaths].sort().join('\0'))
    {
        throw new Error('buildIdentity.sourceDigests paths must be canonical and sorted');
    }
    for (const sourcePath of sourcePaths)
    {
        const expectedDigest = sourceDigests[sourcePath];
        if (!digestPattern.test(String(expectedDigest ?? '')))
        {
            throw new Error(`buildIdentity.sourceDigests.${sourcePath} must be lowercase sha256 hex`);
        }
        const actualDigest = digestBuffer(readExactRegularFile(
            repositoryRoot,
            sourcePath,
            `build receipt source ${sourcePath}`
        ));
        if (actualDigest !== expectedDigest)
        {
            throw new Error(`build receipt source digest mismatch for ${sourcePath}`);
        }
    }
    if (!digestPattern.test(String(sourceDigest ?? ''))
        || sourceDigest !== digestValue(sourceDigests))
    {
        throw new Error('buildIdentity.sourceDigest does not match sourceDigests');
    }
}

export function validateNormalizedBuildIdentity(buildIdentity)
{
    if (!isPlainObject(buildIdentity))
    {
        throw new Error('buildIdentity must be an object');
    }
    const keys = Object.keys(buildIdentity);
    const legacy = exactKeys(buildIdentity, legacyBuildIdentityKeys);
    const sourceBound = exactKeys(buildIdentity, sourceBoundBuildIdentityKeys);
    if (!legacy && !sourceBound)
    {
        throw new Error('buildIdentity has unsupported or missing fields');
    }
    if (typeof buildIdentity.artifactId !== 'string' || buildIdentity.artifactId.length === 0
        || !digestPattern.test(String(buildIdentity.receiptDigest ?? ''))
        || !digestPattern.test(String(buildIdentity.artifactDigest ?? '')))
    {
        throw new Error('buildIdentity artifact and digests are invalid');
    }
    if (sourceBound)
    {
        if (buildIdentity.schema !== sourceBoundBuildIdentitySchema
            || !isPlainObject(buildIdentity.sourceDigests)
            || Object.keys(buildIdentity.sourceDigests).length === 0
            || Object.keys(buildIdentity.sourceDigests).join('\0')
                !== Object.keys(buildIdentity.sourceDigests).sort().join('\0')
            || Object.entries(buildIdentity.sourceDigests).some(([sourcePath, digest]) =>
                !digestPattern.test(String(digest ?? ''))
                || normalizeRelativePath(sourcePath, `buildIdentity.sourceDigests.${sourcePath}`) !== sourcePath)
            || buildIdentity.sourceDigest !== digestValue(buildIdentity.sourceDigests))
        {
            throw new Error('buildIdentity source identity is malformed or non-canonical');
        }
    }
    return keys.length === sourceBoundBuildIdentityKeys.length ? 'source-bound-v2' : 'legacy-v1';
}

export function validateBuildIdentity(buildIdentity, requiredBuildArtifact, {
    repositoryRoot = null,
    receiptPath = null,
    expectedReceiptSchema = null,
    expectedSourcePaths = null
} = {})
{
    if (requiredBuildArtifact == null)
    {
        if (buildIdentity != null)
        {
            throw new Error('buildIdentity must be null when requiredBuildArtifact is null');
        }
        return null;
    }
    if (buildIdentity == null || typeof buildIdentity !== 'object' || Array.isArray(buildIdentity))
    {
        throw new Error(`compiled-assembly extractor requires exact buildIdentity for ${requiredBuildArtifact}`);
    }
    if (repositoryRoot === null
        || receiptPath === null
        || expectedReceiptSchema === null
        || !Array.isArray(expectedSourcePaths))
    {
        throw new Error(`compiled-assembly extractor requires canonical build receipt authority for ${requiredBuildArtifact}`);
    }
    normalizeRelativePath(receiptPath, 'build receipt path');
    if (!receiptPath.startsWith('.tmp/contracts/')
        || path.posix.basename(receiptPath) !== 'build-receipt.json')
    {
        throw new Error('compiled extractor build receipt path is not canonical');
    }
    const receiptBytes = readExactRegularFile(repositoryRoot, receiptPath, 'build receipt path');
    let receipt;
    try
    {
        receipt = JSON.parse(receiptBytes.toString('utf8'));
    }
    catch (error)
    {
        throw new Error(`build receipt JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isPlainObject(receipt)
        || receiptBytes.toString('utf8') !== `${JSON.stringify(receipt, null, 2)}\n`)
    {
        throw new Error('build receipt must use canonical JSON without duplicate or reordered fields');
    }
    const versionMatch = String(expectedReceiptSchema).match(buildReceiptSchemaPattern);
    if (versionMatch === null)
    {
        throw new Error(`unsupported authoritative build receipt schema ${expectedReceiptSchema}`);
    }
    if (receipt.schema !== expectedReceiptSchema)
    {
        throw new Error('build receipt schema does not match its authoritative expected schema');
    }
    if (!Object.hasOwn(receipt, 'buildIdentity') || !isPlainObject(receipt.buildIdentity))
    {
        throw new Error('build receipt must contain its exact buildIdentity');
    }
    const receiptBody = Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== 'buildIdentity')
    );
    const sourceFieldCount = ['sourceDigests', 'sourceDigest']
        .filter((field) => Object.hasOwn(receiptBody, field)).length;
    const receiptVersion = Number(versionMatch[1]);
    const normalizedExpectedSourcePaths = expectedSourcePaths.map((sourcePath) =>
        normalizeRelativePath(sourcePath, `expected build receipt source ${sourcePath}`));
    if (normalizedExpectedSourcePaths.join('\0')
        !== [...new Set(normalizedExpectedSourcePaths)].sort().join('\0'))
    {
        throw new Error('authoritative build receipt source paths must be unique and sorted');
    }
    if ((receiptVersion === 1 && sourceFieldCount !== 0)
        || (receiptVersion === 2 && sourceFieldCount !== 2))
    {
        throw new Error(`build receipt schema v${receiptVersion} does not match its source identity shape`);
    }
    const sourceBound = receiptVersion === 2;
    if ((sourceBound && normalizedExpectedSourcePaths.length === 0)
        || (!sourceBound && normalizedExpectedSourcePaths.length !== 0))
    {
        throw new Error('authoritative build receipt schema and source path set disagree');
    }
    const expectedIdentityKeys = sourceBound
        ? sourceBoundBuildIdentityKeys
        : legacyBuildIdentityKeys;
    if (!exactKeys(buildIdentity, expectedIdentityKeys)
        || !exactKeys(receipt.buildIdentity, expectedIdentityKeys))
    {
        throw new Error(`build receipt schema ${receipt.schema} requires a closed buildIdentity shape`);
    }
    validateNormalizedBuildIdentity(buildIdentity);
    validateNormalizedBuildIdentity(receipt.buildIdentity);
    const artifactId = String(buildIdentity.artifactId ?? '');
    const receiptDigest = String(buildIdentity.receiptDigest ?? '');
    const artifactDigest = String(buildIdentity.artifactDigest ?? '');
    if (artifactId !== requiredBuildArtifact)
    {
        throw new Error(`buildIdentity.artifactId ${artifactId || '<empty>'} does not match requiredBuildArtifact ${requiredBuildArtifact}`);
    }
    if (!digestPattern.test(receiptDigest) || !digestPattern.test(artifactDigest))
    {
        throw new Error('buildIdentity digests must be lowercase sha256 hex');
    }
    if (receiptBody.artifactId !== artifactId
        || canonicalize(receipt.buildIdentity) !== canonicalize(buildIdentity))
    {
        throw new Error('build receipt artifact/build identity mismatch');
    }
    const computedReceiptDigest = digestValue(receiptBody);
    if (receiptDigest !== computedReceiptDigest)
    {
        throw new Error('build receipt self-digest mismatch');
    }
    const artifactPathKeys = ['artifactPath', 'observationPath']
        .filter((key) => Object.hasOwn(receiptBody, key));
    if (artifactPathKeys.length !== 1)
    {
        throw new Error('build receipt must declare exactly one canonical artifact path');
    }
    const artifactPath = normalizeRelativePath(
        receiptBody[artifactPathKeys[0]],
        'build receipt artifact path'
    );
    const expectedReceiptPath = path.posix.join(path.posix.dirname(artifactPath), 'build-receipt.json');
    if (receiptPath !== expectedReceiptPath || !artifactPath.startsWith('.tmp/contracts/'))
    {
        throw new Error('build receipt and artifact paths are not the fixed canonical pair');
    }
    const computedArtifactDigest = digestBuffer(readExactRegularFile(
        repositoryRoot,
        artifactPath,
        'build receipt artifact path'
    ));
    if (receiptBody.artifactDigest !== artifactDigest
        || computedArtifactDigest !== artifactDigest)
    {
        throw new Error('build receipt artifact digest mismatch');
    }
    // Reject ambient bin/Debug style identities without a sealed receipt.
    if (/bin[/\\](?:Debug|Release)\b/iu.test(artifactId)
        || /bin[/\\](?:Debug|Release)\b/iu.test(artifactPath))
    {
        throw new Error('compiled extractor must not bind ambient bin/Debug or bin/Release paths');
    }
    const normalized = {
        artifactId,
        receiptDigest,
        artifactDigest
    };
    if (sourceBound)
    {
        if (Object.keys(receiptBody.sourceDigests).join('\0')
            !== normalizedExpectedSourcePaths.join('\0'))
        {
            throw new Error('build receipt source path set does not match producer authority');
        }
        validateSourceDigests(receiptBody.sourceDigests, receiptBody.sourceDigest, repositoryRoot);
        if (canonicalize(receiptBody.sourceDigests) !== canonicalize(buildIdentity.sourceDigests)
            || receiptBody.sourceDigest !== buildIdentity.sourceDigest)
        {
            throw new Error('build receipt source identity mismatch');
        }
        normalized.schema = sourceBoundBuildIdentitySchema;
        normalized.sourceDigests = structuredClone(receiptBody.sourceDigests);
        normalized.sourceDigest = receiptBody.sourceDigest;
    }
    validateNormalizedBuildIdentity(normalized);
    return normalized;
}

export function sealSourceIdentity(repositoryRoot)
{
    return {
        sourceCommit: resolveSourceCommit(repositoryRoot),
        worktreeFingerprint: resolveWorktreeFingerprint(repositoryRoot)
    };
}

export { canonicalize, digestText, digestValue };
