import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
    if (new Set(paths).size !== paths.length)
    {
        throw new Error('buildIdentity.sourceDigests must not contain duplicate paths');
    }
    if (JSON.stringify(paths) !== JSON.stringify([...paths].sort()))
    {
        throw new Error('buildIdentity.sourceDigests must use canonical path order');
    }
    if (sourceDigests.some((entry) => !/^[a-f0-9]{64}$/u.test(entry.digest ?? '')))
    {
        throw new Error('buildIdentity.sourceDigests digests must be lowercase sha256 hex');
    }
    return sourceDigests.map((entry, index) => ({ path: paths[index], digest: entry.digest }));
}

function readCanonicalReceipt(repositoryRoot, receiptPath, receiptOverride)
{
    if (receiptOverride !== undefined)
    {
        return structuredClone(receiptOverride);
    }
    if (typeof receiptPath !== 'string' || receiptPath.length === 0)
    {
        throw new Error('canonical build identity requires a canonical receipt path');
    }
    const absolute = path.isAbsolute(receiptPath) ? path.resolve(receiptPath) : path.resolve(repositoryRoot, receiptPath);
    const relative = path.relative(path.resolve(repositoryRoot), absolute).replaceAll(path.sep, '/');
    canonicalRelativePath(relative, 'build receipt path');
    if (!existsSync(absolute))
    {
        throw new Error(`canonical build receipt is missing: ${relative}`);
    }
    try
    {
        return JSON.parse(readFileSync(absolute, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`canonical build receipt is not valid JSON: ${error.message}`, { cause: error });
    }
}

function validateCanonicalBuildIdentity(buildIdentity, requiredBuildArtifact, {
    repositoryRoot, receiptPath, receipt, expectedSourceIdentity = null
})
{
    if (!hasExactKeys(buildIdentity, canonicalBuildIdentityKeys))
    {
        throw new Error(`buildIdentity fields are not sealed for ${requiredBuildArtifact}`);
    }
    if (buildIdentity.schema !== buildIdentitySchema)
    {
        throw new Error(`buildIdentity.schema must be ${buildIdentitySchema}`);
    }
    if (buildIdentity.artifactId !== requiredBuildArtifact)
    {
        throw new Error(`buildIdentity.artifactId ${buildIdentity.artifactId || '<empty>'} does not match requiredBuildArtifact ${requiredBuildArtifact}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(buildIdentity.receiptDigest ?? '') || !/^[a-f0-9]{64}$/u.test(buildIdentity.artifactDigest ?? '') || !/^[a-f0-9]{64}$/u.test(buildIdentity.sourceDigest ?? ''))
    {
        throw new Error('buildIdentity digests must be lowercase sha256 hex');
    }
    const sourceDigests = assertSortedUniqueSourceDigests(buildIdentity.sourceDigests);
    if (buildIdentity.sourceDigest !== digestValue(sourceDigests))
    {
        throw new Error('buildIdentity sourceDigest does not match sourceDigests');
    }
    if (repositoryRoot == null || typeof repositoryRoot !== 'string')
    {
        throw new Error('canonical build identity requires repositoryRoot');
    }
    const canonicalReceipt = readCanonicalReceipt(repositoryRoot, receiptPath, receipt);
    if (canonicalReceipt == null || typeof canonicalReceipt !== 'object' || Array.isArray(canonicalReceipt))
    {
        throw new Error('canonical build receipt must be an object');
    }
    if (typeof canonicalReceipt.contentDigest !== 'string' || canonicalReceipt.contentDigest !== digestValue({ ...canonicalReceipt, contentDigest: null }))
    {
        throw new Error('canonical build receipt self-digest mismatch');
    }
    if (buildIdentity.receiptDigest !== canonicalReceipt.contentDigest)
    {
        throw new Error('buildIdentity.receiptDigest does not bind the canonical receipt');
    }
    if (canonicalReceipt.schema !== 'fsusblog.behavior-doc-minimal-contract-build-receipt.v1' || canonicalReceipt.status !== 'ok' || !Array.isArray(canonicalReceipt.failureReasons) || canonicalReceipt.failureReasons.length !== 0)
    {
        throw new Error('canonical build receipt is not an admitted minimal build receipt');
    }
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
    if (expectedSourceIdentity && (canonicalReceipt.sourceCommit !== expectedSourceIdentity.sourceCommit || canonicalReceipt.worktreeFingerprint !== expectedSourceIdentity.worktreeFingerprint))
    {
        throw new Error('canonical build receipt source/worktree identity mismatch');
    }
    const receiptSourceDigests = canonicalReceipt.sourceClosureDigests ?? canonicalReceipt.sourceDigests;
    const normalizedReceiptSourceDigests = assertSortedUniqueSourceDigests(receiptSourceDigests);
    if (JSON.stringify(normalizedReceiptSourceDigests) !== JSON.stringify(sourceDigests))
    {
        throw new Error('buildIdentity source path set does not match the canonical receipt');
    }
    if (canonicalReceipt.sourceDigest != null && canonicalReceipt.sourceDigest !== buildIdentity.sourceDigest)
    {
        throw new Error('canonical build receipt sourceDigest mismatch');
    }
    if (typeof canonicalReceipt.buildKey === 'string' && typeof canonicalReceipt.buildRoot === 'string' && canonicalReceipt.toolchain != null)
    {
        const expectedBuildKey = digestValue({ sourceIdentity: { sourceCommit: canonicalReceipt.sourceCommit, worktreeFingerprint: canonicalReceipt.worktreeFingerprint }, toolchain: canonicalReceipt.toolchain, sourceClosureDigests: normalizedReceiptSourceDigests });
        if (canonicalReceipt.buildKey !== expectedBuildKey || canonicalReceipt.buildRoot !== `.tmp/behavior-doc-contract-builds/${canonicalReceipt.buildKey}`)
        {
            throw new Error('canonical build receipt content address mismatch');
        }
    }
    for (const source of sourceDigests)
    {
        if (digestPath(repositoryRoot, source.path) !== source.digest)
        {
            throw new Error(`canonical build source digest mismatch: ${source.path}`);
        }
    }
    const artifact = canonicalReceipt.artifacts?.[requiredBuildArtifact];
    const baseArtifactKeys = ['project', 'projectDigest', 'path', 'artifactDigest'];
    const acceptedArtifactShapes = [
        baseArtifactKeys,
        [...baseArtifactKeys, 'artifactPath'],
        [...baseArtifactKeys, 'buildReceipt'],
        [...baseArtifactKeys, 'artifactPath', 'buildReceipt'],
        [
            ...baseArtifactKeys,
            'assemblyPath',
            'assemblyDigest',
            'deploymentArtifactPath',
            'deploymentArtifactDigest',
            'buildReceipt'
        ],
        [
            ...baseArtifactKeys,
            'artifactPath',
            'assemblyPath',
            'assemblyDigest',
            'deploymentArtifactPath',
            'deploymentArtifactDigest',
            'buildReceipt'
        ]
    ];
    if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)
        || !acceptedArtifactShapes.some((keys) => hasExactKeys(artifact, keys))
        || typeof artifact.project !== 'string' || typeof artifact.path !== 'string'
        || !/^[a-f0-9]{64}$/u.test(artifact.projectDigest ?? '') || artifact.artifactDigest !== buildIdentity.artifactDigest)
    {
        throw new Error(`canonical build artifact identity is missing for ${requiredBuildArtifact}`);
    }
    canonicalRelativePath(artifact.project, `canonical artifact ${requiredBuildArtifact}.project`);
    canonicalRelativePath(artifact.path, `canonical artifact ${requiredBuildArtifact}.path`);
    if (digestPath(repositoryRoot, artifact.project) !== artifact.projectDigest)
    {
        throw new Error(`canonical build project digest mismatch: ${requiredBuildArtifact}`);
    }
    if (digestPath(repositoryRoot, artifact.path) !== buildIdentity.artifactDigest)
    {
        throw new Error(`canonical build artifact digest mismatch: ${requiredBuildArtifact}`);
    }
    if (artifact.artifactPath != null || artifact.outputPath != null)
    {
        const outputPath = artifact.artifactPath ?? artifact.outputPath;
        canonicalRelativePath(outputPath, `canonical artifact ${requiredBuildArtifact}.artifactPath`);
        if (digestPath(repositoryRoot, outputPath) !== buildIdentity.artifactDigest)
        {
            throw new Error(`canonical published artifact digest mismatch: ${requiredBuildArtifact}`);
        }
    }
    if (artifact.assemblyPath != null)
    {
        canonicalRelativePath(artifact.assemblyPath, `canonical artifact ${requiredBuildArtifact}.assemblyPath`);
        canonicalRelativePath(
            artifact.deploymentArtifactPath,
            `canonical artifact ${requiredBuildArtifact}.deploymentArtifactPath`
        );
        if (!/^[a-f0-9]{64}$/u.test(artifact.assemblyDigest ?? '')
            || !/^[a-f0-9]{64}$/u.test(artifact.deploymentArtifactDigest ?? '')
            || digestPath(repositoryRoot, artifact.assemblyPath) !== artifact.assemblyDigest
            || digestPath(repositoryRoot, artifact.deploymentArtifactPath)
                !== artifact.deploymentArtifactDigest)
        {
            throw new Error(`canonical extended artifact digest mismatch: ${requiredBuildArtifact}`);
        }
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
                if (entry.name === '.git' || entry.name === 'bin'
                    || entry.name === 'node_modules' || entry.name === 'obj')
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
    if (!hasExactKeys(buildIdentity, legacyBuildIdentityKeys))
    {
        throw new Error(`buildIdentity fields are not sealed for ${requiredBuildArtifact}`);
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
    return {
        sourceCommit: resolveSourceCommit(repositoryRoot),
        worktreeFingerprint: resolveWorktreeFingerprint(repositoryRoot)
    };
}

export { canonicalize, digestText, digestValue };
