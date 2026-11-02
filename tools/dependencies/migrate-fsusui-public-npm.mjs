#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
    activateFsusuiReleaseTrainManager,
    activateFsusuiReleaseTrainRenovateDelegation,
    assertFsusuiManagerState,
    assertFsusuiReleaseTrainRenovateDelegation
} from './fsusui-manager-ownership.mjs';
import {
    assertPublicReleaseLock,
    compareStableVersions,
    currentPackageVersion,
    PACKAGE_JSON_PATH,
    PACKAGE_LOCK_PATH,
    PACKAGE_NAME,
    readFrontendFiles,
    regeneratePublicLock
} from './fsusui-release-package.mjs';
import { requireVerifiedFsusuiEvent } from './verify-fsusui-release-event.mjs';

const privateRegistryHost = ['npm', 'pkg', 'github', 'com'].join('.');
const privateTokenName = ['GITHUB', 'PACKAGES', 'TOKEN'].join('_');
const privateDockerSecretId = ['github', 'packages', 'token'].join('_');
const privateMsbuildProperty = ['GitHub', 'Packages', 'Token'].join('');
const privateProviderPhrase = ['GitHub', 'Packages'].join(' ');
const updateSurfacePath = 'config/dependencies/update-surface.json';
const renovatePath = 'renovate.json5';
export const FSUSUI_PUBLIC_NPM_MIGRATION_PATCH = 'config/dependencies/fsusui-public-npm-migration.patch.gz';
export const FSUSUI_PUBLIC_NPM_MIGRATION_PATCH_SHA256 = '7cc634569551a238c331469bd042ee1aab964b8a4c794503a3e56fb80c05956c';
const migrationContextPatch = 'config/dependencies/fsusui-public-npm-migration-context.patch';
const migrationContextPatchSha256 = '5440a0bff2c66c5ab1f9b625d29c686ed58a8d52d2ecd0086486ce3d4f236ed1';
const migrationContextSources = Object.freeze({
    '.github/workflows/quality-gate.yml': 'e734a6275a2134aa10864ad9d903bea5e2f5596a8b9abaa894d3610a4d939390',
    'ops/docker/FsusBlog.Server.Dockerfile': '9e83d5321fd50655bc51686872245740bf59f750d64496624eea341d342990f1',
    'tools/build-final-image.sh': 'f0e524d0a79279c56d23979b7a3c5a0ccc4aa83b8ce41cef6ee435da66edff5b'
});

export const PRIVATE_REGISTRY_ORIGIN = `https://${privateRegistryHost}`;
export const PRIVATE_REFERENCE_MARKERS = Object.freeze([
    PRIVATE_REGISTRY_ORIGIN,
    privateRegistryHost,
    privateTokenName,
    privateDockerSecretId,
    privateMsbuildProperty,
    privateProviderPhrase
]);

function migrationError(detail)
{
    return new Error(`FsusUI public npm migration: ${detail}`);
}

function requireCondition(condition, detail)
{
    if (!condition)
    {
        throw migrationError(detail);
    }
}

function isSkippableDirectory(name)
{
    return new Set(['.git', 'node_modules', '.tmp', 'bin', 'obj']).has(name);
}

function listRepositoryFiles(repository)
{
    const files = [];
    function visit(directory)
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            if (entry.isSymbolicLink())
            {
                continue;
            }
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                if (!isSkippableDirectory(entry.name))
                {
                    visit(absolute);
                }
                continue;
            }
            if (entry.isFile())
            {
                files.push(path.relative(repository, absolute).split(path.sep).join('/'));
            }
        }
    }
    visit(repository);
    return files;
}

function normaliseFiles(repository, files)
{
    return [...new Set((files ?? listRepositoryFiles(repository)).map((file) => file.split(path.sep).join('/')))].sort();
}

function readRepositoryText(repository, relative, overrides = new Map())
{
    if (overrides.has(relative))
    {
        return overrides.get(relative);
    }
    const absolute = path.join(repository, relative);
    let stat;
    try
    {
        stat = fs.lstatSync(absolute);
    }
    catch
    {
        return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    {
        return null;
    }
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0))
    {
        return null;
    }
    return bytes.toString('utf8');
}

function scanTextFiles(repository, files, overrides = new Map())
{
    const matches = [];
    for (const file of normaliseFiles(repository, files))
    {
        const source = readRepositoryText(repository, file, overrides);
        if (source == null)
        {
            continue;
        }
        source.split(/\n/u).forEach((line, index) =>
        {
            const marker = PRIVATE_REFERENCE_MARKERS.find((candidate) => line.includes(candidate));
            if (marker)
            {
                matches.push({ file, line: index + 1, marker });
            }
        });
    }
    return matches;
}

export function scanPrivateFsusuiReferences(repository, { files, overrides = new Map() } = {})
{
    const matches = scanTextFiles(repository, files, overrides);
    return Object.freeze({ clean: matches.length === 0, matches });
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function git(repository, args, { environment, encoding = 'utf8', allowFailure = false } = {})
{
    try
    {
        return execFileSync('git', args, {
            cwd: repository,
            encoding,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 64 * 1024 * 1024
        });
    }
    catch
    {
        if (allowFailure)
        {
            return null;
        }
        throw migrationError(`git command failed: git ${args.join(' ')}`);
    }
}

function patchChangedFiles(repository, environment)
{
    const output = git(repository, [
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
        '-z',
        'HEAD'
    ], { environment, encoding: 'buffer' });
    return output.toString('utf8').split('\0').filter(Boolean).sort();
}

function readIndexFile(repository, environment, file)
{
    const exists = git(repository, ['cat-file', '-e', `:${file}`], { environment, allowFailure: true });
    if (exists == null)
    {
        return null;
    }
    return git(repository, ['show', `:${file}`], { environment, encoding: 'buffer' });
}

function currentContextPatch(repository, originalPatch)
{
    const absolute = path.join(repository, migrationContextPatch);
    const stat = fs.lstatSync(absolute);
    requireCondition(stat.isFile() && !stat.isSymbolicLink(), 'migration context patch is not a regular file');
    const repair = fs.readFileSync(absolute);
    requireCondition(sha256(repair) === migrationContextPatchSha256, 'migration context patch digest mismatch');
    for (const [file, expected] of Object.entries(migrationContextSources))
    {
        const source = path.join(repository, file);
        const sourceStat = fs.lstatSync(source);
        requireCondition(sourceStat.isFile() && !sourceStat.isSymbolicLink(), `migration context source is not a regular file: ${file}`);
        requireCondition(sha256(fs.readFileSync(source)) === expected, `migration context source digest mismatch: ${file}`);
    }

    const replacements = new Map();
    for (const section of repair.toString('utf8').split(/(?=^diff --git )/mu))
    {
        const header = /^diff --git a\/(\S+) b\/\1\n/u.exec(section);
        requireCondition(header && Object.hasOwn(migrationContextSources, header[1]), 'migration context patch has an unowned path');
        requireCondition(!replacements.has(header[1]), 'migration context patch has a duplicate path');
        replacements.set(header[1], section);
    }
    requireCondition(replacements.size === Object.keys(migrationContextSources).length, 'migration context patch coverage is incomplete');
    const replaced = new Set();
    const sections = originalPatch.toString('utf8').split(/(?=^diff --git )/mu).map((section) =>
    {
        const header = /^diff --git a\/(\S+) b\/\1\n/u.exec(section);
        if (!header || !replacements.has(header[1]))
        {
            return section;
        }
        requireCondition(!replaced.has(header[1]), 'migration archive has a duplicate context path');
        replaced.add(header[1]);
        return replacements.get(header[1]);
    });
    requireCondition(replaced.size === replacements.size, 'migration archive context paths are missing');
    return Buffer.from(sections.join(''));
}

function buildRetiredFileChanges(repository, beforeMatches, expectedPatchSha256)
{
    const relativePatch = FSUSUI_PUBLIC_NPM_MIGRATION_PATCH;
    requireCondition(git(repository, ['status', '--porcelain']).trim() === '', 'migration repository must be a clean Git worktree');
    const absolutePatch = path.join(repository, relativePatch);
    let patchArchive;
    try
    {
        const stat = fs.lstatSync(absolutePatch);
        requireCondition(stat.isFile() && !stat.isSymbolicLink(), `migration patch is not a regular file: ${relativePatch}`);
        patchArchive = fs.readFileSync(absolutePatch);
    }
    catch (error)
    {
        if (error instanceof Error && error.message.startsWith('FsusUI public npm migration:'))
        {
            throw error;
        }
        throw migrationError(`migration patch is missing: ${relativePatch}`);
    }
    requireCondition(sha256(patchArchive) === expectedPatchSha256, 'migration patch digest mismatch');

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-public-npm-index-'));
    const temporaryIndex = path.join(temporary, 'index');
    const temporaryPatch = path.join(temporary, 'migration.patch');
    try
    {
        let patch;
        try
        {
            patch = gunzipSync(patchArchive);
        }
        catch
        {
            throw migrationError('migration patch archive is invalid');
        }
        const hasCurrentContext = sha256(patchArchive) === FSUSUI_PUBLIC_NPM_MIGRATION_PATCH_SHA256;
        if (hasCurrentContext)
        {
            patch = currentContextPatch(repository, patch);
        }
        fs.writeFileSync(temporaryPatch, patch);
        const repositoryIndex = git(repository, ['rev-parse', '--git-path', 'index']).trim();
        const absoluteIndex = path.isAbsolute(repositoryIndex)
            ? repositoryIndex
            : path.join(repository, repositoryIndex);
        fs.copyFileSync(absoluteIndex, temporaryIndex);
        const environment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
        git(repository, ['apply', '--cached', '--check', '--whitespace=error-all', temporaryPatch], { environment });
        git(repository, ['apply', '--cached', '--whitespace=error-all', temporaryPatch], { environment });

        const changes = new Map();
        for (const file of patchChangedFiles(repository, environment))
        {
            changes.set(file, readIndexFile(repository, environment, file));
        }
        changes.set(relativePatch, null);
        if (hasCurrentContext)
        {
            changes.set(migrationContextPatch, null);
        }

        const matchedFiles = new Set(beforeMatches
            .map((match) => match.file)
            .filter((file) => ![PACKAGE_JSON_PATH, PACKAGE_LOCK_PATH, relativePatch].includes(file)));
        const uncovered = [...matchedFiles].filter((file) => !changes.has(file)).sort();
        requireCondition(uncovered.length === 0, `migration patch does not retire private references in: ${uncovered.join(',')}`);
        return changes;
    }
    finally
    {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

function bufferForJson(value)
{
    return Buffer.from(`${JSON.stringify(value, null, 4)}\n`);
}

function parseRepositoryJson(repository, relative, overrides = new Map())
{
    const source = readRepositoryText(repository, relative, overrides);
    requireCondition(source != null, `required repository JSON is missing: ${relative}`);
    try
    {
        return JSON.parse(source);
    }
    catch
    {
        throw migrationError(`required repository JSON is invalid: ${relative}`);
    }
}

export async function buildPublicNpmMigrationPlan({
    repository,
    receipt,
    runNpm,
    migrationPatchSha256 = FSUSUI_PUBLIC_NPM_MIGRATION_PATCH_SHA256
})
{
    const payload = requireVerifiedFsusuiEvent(receipt);
    requireCondition(payload.package === PACKAGE_NAME, 'verified event package is not managed by this migration');
    const before = readFrontendFiles(repository);
    const currentVersion = currentPackageVersion(before.manifest, before.lockfile);
    const ordering = compareStableVersions(payload.version, currentVersion);
    if (ordering < 0)
    {
        throw migrationError(`verified version ${payload.version} is older than current ${currentVersion}`);
    }

    const repositoryFiles = normaliseFiles(repository);
    const beforeScan = scanPrivateFsusuiReferences(repository, { files: repositoryFiles });
    if (beforeScan.clean)
    {
        assertFsusuiManagerState(parseRepositoryJson(repository, updateSurfacePath), 'post-migration');
        assertFsusuiReleaseTrainRenovateDelegation(parseRepositoryJson(repository, renovatePath), currentVersion);
        return Object.freeze({
            action: 'not-required',
            migration: 'first-public-npm',
            verified: true,
            verifiedReceiptSha256: receipt.receiptSha256,
            version: payload.version,
            currentVersion,
            changedFiles: [],
            privateReferencesBefore: []
        });
    }

    const generated = await regeneratePublicLock({
        manifest: before.manifest,
        lockfile: before.lockfile,
        version: payload.version,
        runNpm
    });
    assertPublicReleaseLock(generated.lockfile, payload);
    requireCondition(generated.manifest.dependencies?.[PACKAGE_NAME] === payload.version, 'generated package.json target is not exact');

    const changes = buildRetiredFileChanges(repository, beforeScan.matches, migrationPatchSha256);
    changes.set(PACKAGE_JSON_PATH, bufferForJson(generated.manifest));
    changes.set(PACKAGE_LOCK_PATH, bufferForJson(generated.lockfile));
    const afterOverrides = new Map();
    for (const [file, value] of changes)
    {
        afterOverrides.set(file, value == null ? null : value.toString('utf8'));
    }
    const afterScan = scanPrivateFsusuiReferences(repository, { files: repositoryFiles, overrides: afterOverrides });
    requireCondition(afterScan.clean, `migration leaves private references: ${afterScan.matches.map((match) => `${match.file}:${match.line}`).join(',')}`);

    const migration = {
        migration: 'first-public-npm',
        verified: true,
        verifiedReceiptSha256: receipt.receiptSha256,
        version: payload.version,
        privateReferencesAfter: afterScan.matches
    };
    const postMigrationCatalog = activateFsusuiReleaseTrainManager(parseRepositoryJson(repository, updateSurfacePath), migration);
    const postMigrationRenovate = activateFsusuiReleaseTrainRenovateDelegation(parseRepositoryJson(repository, renovatePath), payload.version);
    changes.set(updateSurfacePath, bufferForJson(postMigrationCatalog));
    changes.set(renovatePath, bufferForJson(postMigrationRenovate));

    const changedFiles = [...changes.entries()]
        .filter(([file, value]) =>
        {
            const beforeValue = readRepositoryText(repository, file);
            if (value == null)
            {
                return fs.existsSync(path.join(repository, file));
            }
            return beforeValue !== value.toString('utf8');
        })
        .map(([file]) => file)
        .sort();
    return Object.freeze({
        action: 'migrated',
        migration: 'first-public-npm',
        verified: true,
        verifiedReceiptSha256: receipt.receiptSha256,
        version: payload.version,
        currentVersion,
        changedFiles,
        privateReferencesBefore: beforeScan.matches,
        privateReferencesAfter: afterScan.matches,
        changes,
        manifest: generated.manifest,
        lockfile: generated.lockfile
    });
}

function snapshotChanges(repository, changes)
{
    const snapshots = new Map();
    for (const file of changes.keys())
    {
        const absolute = path.join(repository, file);
        let stat;
        try
        {
            stat = fs.lstatSync(absolute);
        }
        catch
        {
            snapshots.set(file, null);
            continue;
        }
        requireCondition(stat.isFile() && !stat.isSymbolicLink(), `migration refuses to overwrite non-regular file: ${file}`);
        snapshots.set(file, fs.readFileSync(absolute));
    }
    return snapshots;
}

function restoreChanges(repository, snapshots)
{
    for (const [file, before] of snapshots)
    {
        const absolute = path.join(repository, file);
        if (before == null)
        {
            if (fs.existsSync(absolute))
            {
                fs.unlinkSync(absolute);
            }
            continue;
        }
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, before);
    }
}

export async function migrateVerifiedFsusuiRelease({
    repository,
    receipt,
    runNpm,
    migrationPatchSha256 = FSUSUI_PUBLIC_NPM_MIGRATION_PATCH_SHA256
} = {})
{
    const plan = await buildPublicNpmMigrationPlan({
        repository,
        receipt,
        runNpm,
        migrationPatchSha256
    });
    if (plan.action !== 'migrated')
    {
        return plan;
    }
    const snapshots = snapshotChanges(repository, plan.changes);
    try
    {
        for (const [file, value] of [...plan.changes.entries()].sort(([left], [right]) => left.localeCompare(right)))
        {
            const absolute = path.join(repository, file);
            if (value == null)
            {
                fs.unlinkSync(absolute);
                continue;
            }
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, value);
        }
        const after = scanPrivateFsusuiReferences(repository);
        requireCondition(after.clean, 'migration postcondition still contains private registry or token references');
        const files = readFrontendFiles(repository);
        requireCondition(files.manifest.dependencies?.[PACKAGE_NAME] === plan.version, 'migration package.json postcondition failed');
        assertPublicReleaseLock(files.lockfile, receipt.payload);
        assertFsusuiManagerState(parseRepositoryJson(repository, updateSurfacePath), 'post-migration');
        assertFsusuiReleaseTrainRenovateDelegation(parseRepositoryJson(repository, renovatePath), plan.version);
        return plan;
    }
    catch (error)
    {
        try
        {
            restoreChanges(repository, snapshots);
        }
        catch
        {
            throw migrationError('migration failed and rollback could not restore every file');
        }
        throw error instanceof Error ? error : migrationError(String(error));
    }
}
