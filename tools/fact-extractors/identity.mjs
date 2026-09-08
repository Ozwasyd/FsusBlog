import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { canonicalize, digestBuffer, digestText, digestValue } from './lib/canonicalize.mjs';

const commitPattern = /^[a-f0-9]{40}$/u;

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
        if (!existsSync(absolute) || !lstatSync(absolute).isFile())
        {
            return { path: relative, digest: digestText('') };
        }
        return { path: relative, digest: digestBuffer(readFileSync(absolute)) };
    });
    return digestValue({ diff, untrackedBindings });
}

export function resolveContainedPath(repositoryRoot, relativePath, expectedKind = 'file')
{
    const rootLexical = path.resolve(repositoryRoot);
    const rootPhysical = realpathSync(rootLexical);
    if (rootPhysical !== rootLexical)
    {
        throw new Error(`repository root must be a canonical physical path: ${repositoryRoot}`);
    }
    const normalized = String(relativePath).replaceAll(path.sep, '/');
    if (path.isAbsolute(normalized)
        || normalized.length === 0
        || path.posix.normalize(normalized) !== normalized
        || normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
    {
        throw new Error(`path must be canonical and repository-relative: ${relativePath}`);
    }
    let lexical = rootLexical;
    for (const segment of normalized.split('/'))
    {
        lexical = path.join(lexical, segment);
        const metadata = lstatSync(lexical);
        if (metadata.isSymbolicLink())
        {
            throw new Error(`path contains a symbolic link: ${relativePath}`);
        }
        const physical = realpathSync(lexical);
        if (physical !== lexical
            || (!physical.startsWith(`${rootPhysical}${path.sep}`) && physical !== rootPhysical))
        {
            throw new Error(`path is not physically contained by the repository root: ${relativePath}`);
        }
    }
    const metadata = lstatSync(lexical);
    if ((expectedKind === 'file' && !metadata.isFile())
        || (expectedKind === 'directory' && !metadata.isDirectory())
        || (expectedKind !== 'file' && expectedKind !== 'directory' && expectedKind !== 'either'))
    {
        throw new Error(`path is not a ${expectedKind === 'either' ? 'regular file or directory' : expectedKind}: ${relativePath}`);
    }
    if (expectedKind === 'either' && !metadata.isFile() && !metadata.isDirectory())
    {
        throw new Error(`path is not a regular file or directory: ${relativePath}`);
    }
    return lexical;
}

export function digestPath(repositoryRoot, relativePath)
{
    const absolute = resolveContainedPath(repositoryRoot, relativePath, 'either');
    const stat = lstatSync(absolute);
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
                const childMetadata = lstatSync(childAbsolute);
                if (childMetadata.isSymbolicLink() || realpathSync(childAbsolute) !== childAbsolute)
                {
                    throw new Error(`consumed input contains a symbolic link: ${childRelative}`);
                }
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

const projectReferencePattern = /<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*>/gu;
const projectItemPattern = /<(Compile|EmbeddedResource|Content|AdditionalFiles)\b([^>]*)>/gu;
const includeAttributePattern = /\bInclude\s*=\s*"([^"]+)"/u;
const removeAttributePattern = /\bRemove\s*=\s*"([^"]+)"/u;
const wildcardPattern = /[*?[]/u;

function repositoryRelativePath(repositoryRoot, absolutePath, label)
{
    const root = path.resolve(repositoryRoot);
    const absolute = path.resolve(absolutePath);
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
    if (relative.length === 0 || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
    {
        throw new Error(`${label} must remain inside the repository: ${absolutePath}`);
    }
    return relative;
}

function walkRegularFiles(absoluteDirectory, repositoryRoot, files)
{
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)))
    {
        if (entry.name === '.git' || entry.name === 'bin' || entry.name === 'node_modules' || entry.name === 'obj')
        {
            continue;
        }
        const absolute = path.join(absoluteDirectory, entry.name);
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink())
        {
            throw new Error(`dotnet project source closure contains a symbolic link: ${repositoryRelativePath(repositoryRoot, absolute, 'source')}`);
        }
        if (metadata.isDirectory())
        {
            walkRegularFiles(absolute, repositoryRoot, files);
        }
        else if (metadata.isFile())
        {
            files.push(absolute);
        }
        else
        {
            throw new Error(`dotnet project source closure contains a non-regular path: ${repositoryRelativePath(repositoryRoot, absolute, 'source')}`);
        }
    }
}

function globAnchor(projectDirectory, include)
{
    const wildcardIndex = include.search(wildcardPattern);
    const prefix = include.slice(0, wildcardIndex);
    const separator = prefix.lastIndexOf('/');
    return path.resolve(projectDirectory, separator < 0 ? '.' : prefix.slice(0, separator));
}

function itemFiles(repositoryRoot, projectDirectory, include)
{
    const normalized = include.replaceAll('\\', '/');
    if (normalized.includes('$(')) return [];
    const absolute = path.resolve(projectDirectory, normalized);
    if (wildcardPattern.test(normalized))
    {
        const anchor = globAnchor(projectDirectory, normalized);
        if (!existsSync(anchor)) return [];
        const candidates = [];
        walkRegularFiles(anchor, repositoryRoot, candidates);
        return candidates;
    }
    if (!existsSync(absolute)) return [];
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink())
    {
        throw new Error(`dotnet project item contains a symbolic link: ${repositoryRelativePath(repositoryRoot, absolute, 'item')}`);
    }
    if (metadata.isDirectory())
    {
        const candidates = [];
        walkRegularFiles(absolute, repositoryRoot, candidates);
        return candidates;
    }
    return metadata.isFile() ? [absolute] : [];
}

function globRegExp(pattern)
{
    let expression = '^';
    for (let index = 0; index < pattern.length; index++)
    {
        const character = pattern[index];
        if (character === '*')
        {
            expression += '.*';
        }
        else if (character === '?')
        {
            expression += '.';
        }
        else
        {
            expression += character.replace(/[\\^$+?.()|{}]/gu, '\\$&');
        }
    }
    return new RegExp(`${expression}$`, 'u');
}

function projectItems(projectText, projectDirectory, repositoryRoot)
{
    const includeFiles = [];
    const compileRemovals = [];
    for (const match of projectText.matchAll(projectItemPattern))
    {
        const attributes = match[2];
        const include = attributes.match(includeAttributePattern)?.[1];
        const remove = attributes.match(removeAttributePattern)?.[1];
        if (match[1] === 'Compile' && remove != null)
        {
            compileRemovals.push(remove.replaceAll('\\', '/'));
        }
        if (include != null)
        {
            includeFiles.push({ itemType: match[1], include });
        }
    }
    const files = [];
    for (const item of includeFiles)
    {
        for (const absolute of itemFiles(repositoryRoot, projectDirectory, item.include))
        {
            if (item.itemType !== 'Compile' || !compileRemovals.some((removal) =>
                globRegExp(removal).test(path.relative(projectDirectory, absolute).replaceAll(path.sep, '/'))))
            {
                files.push(absolute);
            }
        }
    }
    return { files, compileRemovals };
}

function directoryBuildInputs(repositoryRoot, projectDirectory)
{
    const inputs = [];
    let current = path.resolve(projectDirectory);
    const root = path.resolve(repositoryRoot);
    while (current === root || current.startsWith(`${root}${path.sep}`))
    {
        for (const name of ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'Directory.Packages.targets'])
        {
            const candidate = path.join(current, name);
            if (existsSync(candidate)) inputs.push(candidate);
        }
        if (current === root) break;
        current = path.dirname(current);
    }
    return inputs;
}

/**
 * Resolve the repository-owned source inputs used by the SDK project graph.
 *
 * The SDK supplies the default Compile glob, so listing only hand-picked C#
 * files is not a valid build identity. This resolver follows every reachable
 * ProjectReference, includes every non-generated project source file plus
 * explicit linked build items, and seals each project's package lock file and
 * imported Directory.* build inputs.
 */
export function resolveDotnetProjectSourceClosure(repositoryRoot, projectPaths)
{
    const root = path.resolve(repositoryRoot);
    const queue = [...new Set((projectPaths ?? []).map((project) => String(project).replaceAll(path.sep, '/')))];
    if (queue.length === 0) throw new Error('dotnet project source closure requires a root project');
    const visited = new Set();
    const inputs = new Set([
        ...['global.json', 'NuGet.config', 'nuget.config'].filter((relative) => existsSync(path.join(root, relative)))
    ]);
    while (queue.length > 0)
    {
        const relativeProject = queue.shift();
        const projectAbsolute = resolveContainedPath(root, relativeProject, 'file');
        const normalizedProject = repositoryRelativePath(root, projectAbsolute, 'project');
        if (visited.has(normalizedProject)) continue;
        visited.add(normalizedProject);
        inputs.add(normalizedProject);
        const projectDirectory = path.dirname(projectAbsolute);
        const projectText = readFileSync(projectAbsolute, 'utf8');
        for (const imported of directoryBuildInputs(root, projectDirectory))
        {
            inputs.add(repositoryRelativePath(root, imported, 'build input'));
        }
        const lockFile = path.join(projectDirectory, 'packages.lock.json');
        if (existsSync(lockFile)) inputs.add(repositoryRelativePath(root, lockFile, 'lock file'));

        const allProjectFiles = [];
        walkRegularFiles(projectDirectory, root, allProjectFiles);
        const { files: explicitFiles, compileRemovals } = projectItems(projectText, projectDirectory, root);
        const removedCompile = compileRemovals.map((removal) => globRegExp(removal));
        for (const absolute of allProjectFiles)
        {
            const relativeToProject = path.relative(projectDirectory, absolute).replaceAll(path.sep, '/');
            if (path.extname(absolute).toLowerCase() === '.cs'
                && !removedCompile.some((removal) => removal.test(relativeToProject)))
            {
                inputs.add(repositoryRelativePath(root, absolute, 'compile input'));
            }
        }
        for (const absolute of explicitFiles)
        {
            inputs.add(repositoryRelativePath(root, absolute, 'project item'));
        }
        for (const match of projectText.matchAll(projectReferencePattern))
        {
            const referencedAbsolute = path.resolve(projectDirectory, match[1].replaceAll('\\', '/'));
            const referencedRelative = repositoryRelativePath(root, referencedAbsolute, 'project reference');
            if (!existsSync(referencedAbsolute))
            {
                throw new Error(`dotnet project reference is missing: ${referencedRelative}`);
            }
            queue.push(referencedRelative);
        }
    }
    return [...inputs].sort();
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
    const genericIdentity = { artifactId, receiptDigest, artifactDigest };
    if (requiredBuildArtifact !== 'runtime-role-observation')
    {
        if (Object.keys(buildIdentity).sort().join('\0') !== Object.keys(genericIdentity).sort().join('\0'))
        {
            throw new Error(`buildIdentity fields are not sealed for ${requiredBuildArtifact}`);
        }
        return genericIdentity;
    }

    const runtimeIdentity = {
        ...genericIdentity,
        sourceCommit: String(buildIdentity.sourceCommit ?? ''),
        worktreeFingerprint: String(buildIdentity.worktreeFingerprint ?? ''),
        buildKey: String(buildIdentity.buildKey ?? ''),
        minimalReceiptPath: String(buildIdentity.minimalReceiptPath ?? ''),
        minimalReceiptDigest: String(buildIdentity.minimalReceiptDigest ?? ''),
        artifactPath: String(buildIdentity.artifactPath ?? ''),
        assemblyPath: String(buildIdentity.assemblyPath ?? ''),
        assemblyDigest: String(buildIdentity.assemblyDigest ?? ''),
        deploymentArtifactPath: String(buildIdentity.deploymentArtifactPath ?? ''),
        deploymentArtifactDigest: String(buildIdentity.deploymentArtifactDigest ?? '')
    };
    if (Object.keys(buildIdentity).sort().join('\0') !== Object.keys(runtimeIdentity).sort().join('\0'))
    {
        throw new Error('runtime-role buildIdentity fields are not sealed');
    }
    if (!commitPattern.test(runtimeIdentity.sourceCommit)
        || !/^[a-f0-9]{64}$/u.test(runtimeIdentity.worktreeFingerprint)
        || !/^[a-f0-9]{64}$/u.test(runtimeIdentity.buildKey)
        || !/^[a-f0-9]{64}$/u.test(runtimeIdentity.minimalReceiptDigest)
        || !/^[a-f0-9]{64}$/u.test(runtimeIdentity.assemblyDigest)
        || !/^[a-f0-9]{64}$/u.test(runtimeIdentity.deploymentArtifactDigest)
        || !new RegExp(`^\\.tmp/behavior-doc-contract-builds/${runtimeIdentity.buildKey}/receipts/[A-Za-z0-9_.-]+\\.json$`, 'u')
            .test(runtimeIdentity.minimalReceiptPath)
        || runtimeIdentity.artifactPath !== `.tmp/behavior-doc-contract-builds/${runtimeIdentity.buildKey}/observations/runtime-role-observation.json`
        || runtimeIdentity.assemblyPath !== `.tmp/runtime-role-reproducible-builds/${runtimeIdentity.buildKey}/bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll`
        || runtimeIdentity.deploymentArtifactPath !== `.tmp/behavior-doc-contract-builds/${runtimeIdentity.buildKey}/observations/runtime-role-deployment-observation.json`)
    {
        throw new Error('runtime-role buildIdentity does not bind an exact minimal build receipt and assembly');
    }
    return runtimeIdentity;
}

export function sealSourceIdentity(repositoryRoot)
{
    return {
        sourceCommit: resolveSourceCommit(repositoryRoot),
        worktreeFingerprint: resolveWorktreeFingerprint(repositoryRoot)
    };
}

export { canonicalize, digestText, digestValue };
