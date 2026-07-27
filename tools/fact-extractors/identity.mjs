import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonicalize, digestBuffer, digestText, digestValue } from './lib/canonicalize.mjs'

const commitPattern = /^[a-f0-9]{40}$/u

function git(args, cwd)
{
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (result.status !== 0)
    {
        throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`)
    }
    return result.stdout
}

export function resolveSourceCommit(repositoryRoot)
{
    const commit = git(['rev-parse', 'HEAD'], repositoryRoot).trim()
    if (!commitPattern.test(commit))
    {
        throw new Error(`sourceCommit must be a full lowercase SHA; got ${commit}`)
    }
    return commit
}

/**
 * Fingerprint of tracked + relevant untracked worktree content (not HEAD alone).
 * Includes binary diff against HEAD and digests of untracked non-ignored files.
 */
export function resolveWorktreeFingerprint(repositoryRoot)
{
    const diff = git(['diff', '--binary', 'HEAD', '--'], repositoryRoot)
    const untracked = git(['ls-files', '--others', '--exclude-standard'], repositoryRoot)
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((relative) => relative.replaceAll(path.sep, '/'))
        .sort()
    const untrackedBindings = untracked.map((relative) =>
    {
        const absolute = path.join(repositoryRoot, relative)
        if (!existsSync(absolute) || !statSync(absolute).isFile())
        {
            return { path: relative, digest: digestText('') }
        }
        return { path: relative, digest: digestBuffer(readFileSync(absolute)) }
    })
    return digestValue({ diff, untrackedBindings })
}

export function digestPath(repositoryRoot, relativePath)
{
    const absolute = path.resolve(repositoryRoot, relativePath)
    const rootResolved = path.resolve(repositoryRoot)
    if (!absolute.startsWith(`${rootResolved}${path.sep}`) && absolute !== rootResolved)
    {
        throw new Error(`path escapes repository root: ${relativePath}`)
    }
    if (!existsSync(absolute))
    {
        throw new Error(`consumed input missing: ${relativePath}`)
    }
    const stat = statSync(absolute)
    if (stat.isDirectory())
    {
        const files = []
        const walk = (directory, relativeDirectory) =>
        {
            for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)))
            {
                if (entry.name === '.git' || entry.name === 'node_modules') continue
                const childRelative = path.posix.join(relativeDirectory, entry.name)
                const childAbsolute = path.join(directory, entry.name)
                if (entry.isDirectory()) walk(childAbsolute, childRelative)
                else if (entry.isFile()) files.push({ path: childRelative, digest: digestBuffer(readFileSync(childAbsolute)) })
            }
        }
        walk(absolute, relativePath.replaceAll(path.sep, '/'))
        return digestValue(files)
    }
    if (!stat.isFile())
    {
        throw new Error(`consumed input is not a regular file or directory: ${relativePath}`)
    }
    return digestBuffer(readFileSync(absolute))
}

export function computeConsumedInputDigests(repositoryRoot, consumedInputs)
{
    const normalized = [...new Set(consumedInputs.map((entry) => String(entry).replaceAll(path.sep, '/')))].sort()
    return normalized.map((relative) => ({
        path: relative,
        digest: digestPath(repositoryRoot, relative)
    }))
}

export function validateBuildIdentity(buildIdentity, requiredBuildArtifact)
{
    if (requiredBuildArtifact == null)
    {
        if (buildIdentity != null)
        {
            throw new Error('buildIdentity must be null when requiredBuildArtifact is null')
        }
        return null
    }
    if (buildIdentity == null || typeof buildIdentity !== 'object' || Array.isArray(buildIdentity))
    {
        throw new Error(`compiled-assembly extractor requires exact buildIdentity for ${requiredBuildArtifact}`)
    }
    const artifactId = String(buildIdentity.artifactId ?? '')
    const receiptDigest = String(buildIdentity.receiptDigest ?? '')
    const artifactDigest = String(buildIdentity.artifactDigest ?? '')
    if (artifactId !== requiredBuildArtifact)
    {
        throw new Error(`buildIdentity.artifactId ${artifactId || '<empty>'} does not match requiredBuildArtifact ${requiredBuildArtifact}`)
    }
    if (!/^[a-f0-9]{64}$/u.test(receiptDigest) || !/^[a-f0-9]{64}$/u.test(artifactDigest))
    {
        throw new Error('buildIdentity digests must be lowercase sha256 hex')
    }
    // Reject ambient bin/Debug style identities without a sealed receipt.
    if (/bin[/\\](?:Debug|Release)\b/iu.test(artifactId) || /bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.path ?? '')))
    {
        throw new Error('compiled extractor must not bind ambient bin/Debug or bin/Release paths')
    }
    return {
        artifactId,
        receiptDigest,
        artifactDigest
    }
}

export function sealSourceIdentity(repositoryRoot)
{
    return {
        sourceCommit: resolveSourceCommit(repositoryRoot),
        worktreeFingerprint: resolveWorktreeFingerprint(repositoryRoot)
    }
}

export { canonicalize, digestText, digestValue }
