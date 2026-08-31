import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalize, digestBuffer, digestText, digestValue } from './lib/canonicalize.mjs';

const commitPattern = /^[a-f0-9]{40}$/u;
const gitExecutable = '/usr/bin/git';
const fixedGitEnvironment = Object.freeze({
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0'
});

function runGit(args, { encoding = 'utf8', input = undefined, maxBuffer = 64 * 1024 * 1024 } = {})
{
    const result = spawnSync(gitExecutable, args, {
        encoding,
        env: fixedGitEnvironment,
        input,
        maxBuffer
    });
    if (result.status !== 0)
    {
        const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
        throw new Error(stderr?.trim() || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
}

export function resolveGitRepositoryAuthority(repositoryRoot)
{
    const requestedRoot = realpathSync(path.resolve(repositoryRoot));
    const bootstrap = (arguments_) => runGit(['-C', requestedRoot, '--no-replace-objects', ...arguments_]).trim();
    const workTree = realpathSync(bootstrap(['rev-parse', '--show-toplevel']));
    if (workTree !== requestedRoot)
    {
        throw new Error(`repository root must equal the Git top-level: ${requestedRoot}`);
    }
    const gitDirectory = realpathSync(bootstrap(['rev-parse', '--absolute-git-dir']));
    const commonDirectory = realpathSync(bootstrap(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const objectFormat = bootstrap(['rev-parse', '--show-object-format']);
    if (objectFormat !== 'sha1')
    {
        throw new Error(`Git object format must be sha1 for source identity; got ${objectFormat}`);
    }
    const alternateFile = path.join(commonDirectory, 'objects/info/alternates');
    if (existsSync(alternateFile) && readFileSync(alternateFile, 'utf8').trim().length > 0)
    {
        throw new Error('Git object database alternates are unsupported for source identity');
    }
    return Object.freeze({ commonDirectory, gitDirectory, objectFormat, workTree });
}

export function runGitRepository(authority, arguments_, options = {})
{
    return runGit([
        '-C', authority.workTree,
        `--git-dir=${authority.gitDirectory}`,
        `--work-tree=${authority.workTree}`,
        '--no-replace-objects',
        '-c', 'core.attributesFile=/dev/null',
        '-c', 'core.excludesFile=/dev/null',
        ...arguments_
    ], options);
}

export function resolveSourceCommit(repositoryRoot, authority = resolveGitRepositoryAuthority(repositoryRoot))
{
    const commit = runGitRepository(authority, ['rev-parse', 'HEAD']).trim();
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
export function resolveWorktreeFingerprint(repositoryRoot, authority = resolveGitRepositoryAuthority(repositoryRoot))
{
    const diff = runGitRepository(authority, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
    const untracked = runGitRepository(authority, ['ls-files', '--others', '--exclude-standard'])
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

export function validateBuildIdentity(buildIdentity, requiredBuildArtifact)
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
    const authority = resolveGitRepositoryAuthority(repositoryRoot);
    return {
        sourceCommit: resolveSourceCommit(repositoryRoot, authority),
        worktreeFingerprint: resolveWorktreeFingerprint(repositoryRoot, authority)
    };
}

export { canonicalize, digestText, digestValue };
