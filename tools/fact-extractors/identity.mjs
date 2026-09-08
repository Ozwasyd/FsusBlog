import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalize, digestBuffer, digestText, digestValue } from './lib/canonicalize.mjs';

const commitPattern = /^[a-f0-9]{40}$/u;
export const buildIdentitySchema = 'fsusblog.build-identity.v1';
const canonicalBuildIdentityKeys = Object.freeze(['schema', 'artifactId', 'receiptDigest', 'artifactDigest', 'sourceDigests', 'sourceDigest']);
const legacyBuildIdentityKeys = Object.freeze(['artifactId', 'receiptDigest', 'artifactDigest']);

function hasExactKeys(value, keys)
{
    return value != null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function canonicalRelativePath(value, label)
{
    if (typeof value !== 'string' || value.length === 0 || value.includes('\\')
        || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
        || value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
    {
        throw new Error(`${label} must be a canonical repository-relative path`);
    }
    return value;
}

function assertSortedUniqueSourceDigests(sourceDigests)
{
    if (!Array.isArray(sourceDigests) || sourceDigests.length === 0
        || sourceDigests.some((entry) => !hasExactKeys(entry, ['path', 'digest'])))
    {
        throw new Error('buildIdentity.sourceDigests must be a non-empty sealed array');
    }
    const paths = sourceDigests.map((entry) => canonicalRelativePath(entry.path, 'buildIdentity.sourceDigests.path'));
    if (new Set(paths).size !== paths.length) throw new Error('buildIdentity.sourceDigests must not contain duplicate paths');
    if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error('buildIdentity.sourceDigests must use canonical path order');
    if (sourceDigests.some((entry) => !/^[a-f0-9]{64}$/u.test(entry.digest ?? ''))) throw new Error('buildIdentity.sourceDigests digests must be lowercase sha256 hex');
    return sourceDigests.map((entry, index) => ({ path: paths[index], digest: entry.digest }));
}

function readCanonicalReceipt(repositoryRoot, receiptPath, receiptOverride)
{
    if (receiptOverride !== undefined) return structuredClone(receiptOverride);
    if (typeof receiptPath !== 'string' || receiptPath.length === 0) throw new Error('canonical build identity requires a canonical receipt path');
    const absolute = path.isAbsolute(receiptPath) ? path.resolve(receiptPath) : path.resolve(repositoryRoot, receiptPath);
    const relative = path.relative(path.resolve(repositoryRoot), absolute).replaceAll(path.sep, '/');
    canonicalRelativePath(relative, 'build receipt path');
    if (!existsSync(absolute)) throw new Error(`canonical build receipt is missing: ${relative}`);
    try { return JSON.parse(readFileSync(absolute, 'utf8')); }
    catch (error) { throw new Error(`canonical build receipt is not valid JSON: ${error.message}`); }
}

function validateCanonicalBuildIdentity(buildIdentity, requiredBuildArtifact, {
    repositoryRoot, receiptPath, receipt, expectedSourceIdentity = null
})
{
    if (!hasExactKeys(buildIdentity, canonicalBuildIdentityKeys)) throw new Error(`buildIdentity fields are not sealed for ${requiredBuildArtifact}`);
    if (buildIdentity.schema !== buildIdentitySchema) throw new Error(`buildIdentity.schema must be ${buildIdentitySchema}`);
    if (buildIdentity.artifactId !== requiredBuildArtifact) throw new Error(`buildIdentity.artifactId ${buildIdentity.artifactId || '<empty>'} does not match requiredBuildArtifact ${requiredBuildArtifact}`);
    if (!/^[a-f0-9]{64}$/u.test(buildIdentity.receiptDigest ?? '') || !/^[a-f0-9]{64}$/u.test(buildIdentity.artifactDigest ?? '') || !/^[a-f0-9]{64}$/u.test(buildIdentity.sourceDigest ?? '')) throw new Error('buildIdentity digests must be lowercase sha256 hex');
    const sourceDigests = assertSortedUniqueSourceDigests(buildIdentity.sourceDigests);
    if (buildIdentity.sourceDigest !== digestValue(sourceDigests)) throw new Error('buildIdentity sourceDigest does not match sourceDigests');
    if (repositoryRoot == null || typeof repositoryRoot !== 'string') throw new Error('canonical build identity requires repositoryRoot');
    const canonicalReceipt = readCanonicalReceipt(repositoryRoot, receiptPath, receipt);
    if (canonicalReceipt == null || typeof canonicalReceipt !== 'object' || Array.isArray(canonicalReceipt)) throw new Error('canonical build receipt must be an object');
    if (typeof canonicalReceipt.contentDigest !== 'string' || canonicalReceipt.contentDigest !== digestValue({ ...canonicalReceipt, contentDigest: null })) throw new Error('canonical build receipt self-digest mismatch');
    if (buildIdentity.receiptDigest !== canonicalReceipt.contentDigest) throw new Error('buildIdentity.receiptDigest does not bind the canonical receipt');
    if (canonicalReceipt.schema !== 'fsusblog.behavior-doc-minimal-contract-build-receipt.v1' || canonicalReceipt.status !== 'ok' || !Array.isArray(canonicalReceipt.failureReasons) || canonicalReceipt.failureReasons.length !== 0) throw new Error('canonical build receipt is not an admitted minimal build receipt');
    if (!commitPattern.test(canonicalReceipt.sourceCommit ?? '')
        || !/^[a-f0-9]{64}$/u.test(canonicalReceipt.worktreeFingerprint ?? '')
        || !/^[a-f0-9]{64}$/u.test(canonicalReceipt.buildKey ?? '')
        || canonicalReceipt.buildRoot !== `.tmp/behavior-doc-contract-builds/${canonicalReceipt.buildKey}`
        || !hasExactKeys(canonicalReceipt.toolchain, ['dotnet', 'configuration', 'targetFramework'])
        || canonicalReceipt.toolchain.configuration !== 'Release'
        || canonicalReceipt.toolchain.targetFramework !== 'net10.0'
        || typeof canonicalReceipt.toolchain.dotnet !== 'string'
        || canonicalReceipt.toolchain.dotnet.length === 0)
    {
        throw new Error('canonical build receipt identity is incomplete');
    }
    if (expectedSourceIdentity && (canonicalReceipt.sourceCommit !== expectedSourceIdentity.sourceCommit || canonicalReceipt.worktreeFingerprint !== expectedSourceIdentity.worktreeFingerprint)) throw new Error('canonical build receipt source/worktree identity mismatch');
    const receiptSourceDigests = canonicalReceipt.sourceClosureDigests ?? canonicalReceipt.sourceDigests;
    const normalizedReceiptSourceDigests = assertSortedUniqueSourceDigests(receiptSourceDigests);
    if (JSON.stringify(normalizedReceiptSourceDigests) !== JSON.stringify(sourceDigests)) throw new Error('buildIdentity source path set does not match the canonical receipt');
    if (canonicalReceipt.sourceDigest != null && canonicalReceipt.sourceDigest !== buildIdentity.sourceDigest) throw new Error('canonical build receipt sourceDigest mismatch');
    if (typeof canonicalReceipt.buildKey === 'string' && typeof canonicalReceipt.buildRoot === 'string' && canonicalReceipt.toolchain != null)
    {
        const expectedBuildKey = digestValue({ sourceIdentity: { sourceCommit: canonicalReceipt.sourceCommit, worktreeFingerprint: canonicalReceipt.worktreeFingerprint }, toolchain: canonicalReceipt.toolchain, sourceClosureDigests: normalizedReceiptSourceDigests });
        if (canonicalReceipt.buildKey !== expectedBuildKey || canonicalReceipt.buildRoot !== `.tmp/behavior-doc-contract-builds/${canonicalReceipt.buildKey}`) throw new Error('canonical build receipt content address mismatch');
    }
    for (const source of sourceDigests) if (digestPath(repositoryRoot, source.path) !== source.digest) throw new Error(`canonical build source digest mismatch: ${source.path}`);
    const artifact = canonicalReceipt.artifacts?.[requiredBuildArtifact];
    if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)
        || (!hasExactKeys(artifact, ['project', 'projectDigest', 'path', 'artifactDigest']) && !hasExactKeys(artifact, ['project', 'projectDigest', 'path', 'artifactPath', 'artifactDigest']))
        || typeof artifact.project !== 'string' || typeof artifact.path !== 'string'
        || !/^[a-f0-9]{64}$/u.test(artifact.projectDigest ?? '') || artifact.artifactDigest !== buildIdentity.artifactDigest)
    {
        throw new Error(`canonical build artifact identity is missing for ${requiredBuildArtifact}`);
    }
    canonicalRelativePath(artifact.project, `canonical artifact ${requiredBuildArtifact}.project`);
    canonicalRelativePath(artifact.path, `canonical artifact ${requiredBuildArtifact}.path`);
    if (digestPath(repositoryRoot, artifact.project) !== artifact.projectDigest) throw new Error(`canonical build project digest mismatch: ${requiredBuildArtifact}`);
    if (digestPath(repositoryRoot, artifact.path) !== buildIdentity.artifactDigest) throw new Error(`canonical build artifact digest mismatch: ${requiredBuildArtifact}`);
    if (artifact.artifactPath != null || artifact.outputPath != null)
    {
        const outputPath = artifact.artifactPath ?? artifact.outputPath;
        canonicalRelativePath(outputPath, `canonical artifact ${requiredBuildArtifact}.artifactPath`);
        if (digestPath(repositoryRoot, outputPath) !== buildIdentity.artifactDigest) throw new Error(`canonical published artifact digest mismatch: ${requiredBuildArtifact}`);
    }
    return { schema: buildIdentitySchema, artifactId: buildIdentity.artifactId, receiptDigest: buildIdentity.receiptDigest, artifactDigest: buildIdentity.artifactDigest, sourceDigests, sourceDigest: buildIdentity.sourceDigest };
}

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
    const untrackedBindings = untracked.map((file) =>
    {
        const absolute = path.join(repositoryRoot, file);
        if (!existsSync(absolute) || !statSync(absolute).isFile())
        {
            return { file, content: '' };
        }
        return { file, content: readFileSync(absolute).toString('base64') };
    });
    // Replay adapters and the scheduler consume this exact dirty-worktree
    // projection. Keep BehaviorDoc on the same source-identity authority so a
    // current-run receipt cannot become incomparable only because one producer
    // renamed the canonical JSON fields or pre-hashed untracked content.
    return digestValue({ diff, untracked: untrackedBindings });
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

export function validateBuildIdentity(buildIdentity, requiredBuildArtifact, options = {})
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
    if (Object.hasOwn(buildIdentity, 'schema') || Object.hasOwn(buildIdentity, 'sourceDigests') || Object.hasOwn(buildIdentity, 'sourceDigest'))
    {
        return validateCanonicalBuildIdentity(buildIdentity, requiredBuildArtifact, options);
    }
    const artifactId = String(buildIdentity.artifactId ?? '');
    const receiptDigest = String(buildIdentity.receiptDigest ?? '');
    const artifactDigest = String(buildIdentity.artifactDigest ?? '');
    if (artifactId !== requiredBuildArtifact)
    {
        throw new Error(`buildIdentity.artifactId ${artifactId || '<empty>'} does not match requiredBuildArtifact ${requiredBuildArtifact}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(receiptDigest) || !/^[a-f0-9]{64}$/u.test(artifactDigest))
    {
        throw new Error('buildIdentity digests must be lowercase sha256 hex');
    }
    if (!hasExactKeys(buildIdentity, legacyBuildIdentityKeys)) throw new Error(`buildIdentity fields are not sealed for ${requiredBuildArtifact}`);
    // Reject ambient bin/Debug style identities without a sealed receipt.
    if (/bin[/\\](?:Debug|Release)\b/iu.test(artifactId) || /bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.path ?? '')))
    {
        throw new Error('compiled extractor must not bind ambient bin/Debug or bin/Release paths');
    }
    return {
        artifactId,
        receiptDigest,
        artifactDigest
    };
}

export function sealSourceIdentity(repositoryRoot)
{
    return {
        sourceCommit: resolveSourceCommit(repositoryRoot),
        worktreeFingerprint: resolveWorktreeFingerprint(repositoryRoot)
    };
}

export { canonicalize, digestText, digestValue };
