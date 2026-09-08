#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { requireVerifiedFsusuiEvent } from './verify-fsusui-release-event.mjs';
import {
    assertPublicReleaseLock,
    compareStableVersions,
    currentPackageVersion,
    PACKAGE_JSON_PATH,
    PACKAGE_LOCK_PATH,
    PACKAGE_NAME,
    readFrontendFiles,
    regeneratePublicLock
} from './update-fsusui-release.mjs';

const privateRegistryHost = ['npm', 'pkg', 'github', 'com'].join('.');
const privateTokenName = ['GITHUB', 'PACKAGES', 'TOKEN'].join('_');
const privateDockerSecretId = ['github', 'packages', 'token'].join('_');
const privateMsbuildProperty = ['GitHub', 'Packages', 'Token'].join('');
const privateProviderPhrase = ['GitHub', 'Packages'].join(' ');

export const PRIVATE_REGISTRY_ORIGIN = `https://${privateRegistryHost}`;
export const PRIVATE_REFERENCE_MARKERS = Object.freeze([
    PRIVATE_REGISTRY_ORIGIN,
    privateTokenName,
    privateDockerSecretId,
    privateMsbuildProperty,
    privateProviderPhrase
]);

function migrationError(detail) {
    return new Error(`FsusUI public npm migration: ${detail}`);
}

function requireCondition(condition, detail) {
    if (!condition) {
        throw migrationError(detail);
    }
}

function isSkippableDirectory(name) {
    return new Set(['.git', 'node_modules', '.tmp', 'bin', 'obj']).has(name);
}

function listRepositoryFiles(repository) {
    const files = [];
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!isSkippableDirectory(entry.name)) {
                    visit(absolute);
                }
                continue;
            }
            if (entry.isFile()) {
                files.push(path.relative(repository, absolute).split(path.sep).join('/'));
            }
        }
    }
    visit(repository);
    return files;
}

function normaliseFiles(repository, files) {
    return [...new Set((files ?? listRepositoryFiles(repository)).map((file) => file.split(path.sep).join('/')))].sort();
}

function readRepositoryText(repository, relative, overrides = new Map()) {
    if (overrides.has(relative)) {
        return overrides.get(relative);
    }
    const absolute = path.join(repository, relative);
    let stat;
    try {
        stat = fs.lstatSync(absolute);
    } catch {
        return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
        return null;
    }
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) {
        return null;
    }
    return bytes.toString('utf8');
}

function scanTextFiles(repository, files, overrides = new Map()) {
    const matches = [];
    for (const file of normaliseFiles(repository, files)) {
        const source = readRepositoryText(repository, file, overrides);
        if (source == null) {
            continue;
        }
        source.split(/\n/u).forEach((line, index) => {
            const marker = PRIVATE_REFERENCE_MARKERS.find((candidate) => line.includes(candidate));
            if (marker) {
                matches.push({ file, line: index + 1, marker });
            }
        });
    }
    return matches;
}

export function scanPrivateFsusuiReferences(repository, { files, overrides = new Map() } = {}) {
    const matches = scanTextFiles(repository, files, overrides);
    return Object.freeze({ clean: matches.length === 0, matches });
}

function removePrivateLines(source) {
    return source.split(/(?<=\n)/u).filter((line) => !PRIVATE_REFERENCE_MARKERS.some((marker) => line.includes(marker))).join('');
}

function isNpmrc(file) {
    return path.basename(file) === '.npmrc';
}

function buildRetiredFileChanges(repository, files, beforeMatches, overrides) {
    const changes = new Map();
    const matchedFiles = [...new Set(beforeMatches.map((match) => match.file))].sort();
    for (const file of matchedFiles) {
        if ([PACKAGE_JSON_PATH, PACKAGE_LOCK_PATH].includes(file)) {
            continue;
        }
        const before = readRepositoryText(repository, file, overrides);
        requireCondition(before != null, `private reference is not a regular text file: ${file}`);
        const after = removePrivateLines(before);
        if (isNpmrc(file) && after.trim() === '') {
            changes.set(file, null);
        } else {
            changes.set(file, Buffer.from(after));
        }
    }
    return changes;
}

function bufferForJson(value) {
    return Buffer.from(`${JSON.stringify(value, null, 4)}\n`);
}

export async function buildPublicNpmMigrationPlan({ repository, receipt, runNpm }) {
    const payload = requireVerifiedFsusuiEvent(receipt);
    requireCondition(payload.package === PACKAGE_NAME, 'verified event package is not managed by this migration');
    const before = readFrontendFiles(repository);
    const currentVersion = currentPackageVersion(before.manifest, before.lockfile);
    const ordering = compareStableVersions(payload.version, currentVersion);
    if (ordering < 0) {
        throw migrationError(`verified version ${payload.version} is older than current ${currentVersion}`);
    }

    const repositoryFiles = normaliseFiles(repository);
    const beforeScan = scanPrivateFsusuiReferences(repository, { files: repositoryFiles });
    if (beforeScan.clean) {
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

    const overrides = new Map([
        [PACKAGE_JSON_PATH, bufferForJson(generated.manifest).toString('utf8')],
        [PACKAGE_LOCK_PATH, bufferForJson(generated.lockfile).toString('utf8')]
    ]);
    const changes = buildRetiredFileChanges(repository, repositoryFiles, beforeScan.matches, overrides);
    changes.set(PACKAGE_JSON_PATH, bufferForJson(generated.manifest));
    changes.set(PACKAGE_LOCK_PATH, bufferForJson(generated.lockfile));
    const afterOverrides = new Map();
    for (const [file, value] of changes) {
        afterOverrides.set(file, value == null ? null : value.toString('utf8'));
    }
    const afterScan = scanPrivateFsusuiReferences(repository, { files: repositoryFiles, overrides: afterOverrides });
    requireCondition(afterScan.clean, `migration leaves private references: ${afterScan.matches.map((match) => `${match.file}:${match.line}`).join(',')}`);

    const changedFiles = [...changes.entries()]
        .filter(([file, value]) => {
            const beforeValue = readRepositoryText(repository, file);
            if (value == null) return beforeValue != null;
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

function snapshotChanges(repository, changes) {
    const snapshots = new Map();
    for (const file of changes.keys()) {
        const absolute = path.join(repository, file);
        let stat;
        try {
            stat = fs.lstatSync(absolute);
        } catch {
            snapshots.set(file, null);
            continue;
        }
        requireCondition(stat.isFile() && !stat.isSymbolicLink(), `migration refuses to overwrite non-regular file: ${file}`);
        snapshots.set(file, fs.readFileSync(absolute));
    }
    return snapshots;
}

function restoreChanges(repository, snapshots) {
    for (const [file, before] of snapshots) {
        const absolute = path.join(repository, file);
        if (before == null) {
            if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
            continue;
        }
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, before);
    }
}

export async function migrateVerifiedFsusuiRelease({ repository, receipt, runNpm } = {}) {
    const plan = await buildPublicNpmMigrationPlan({ repository, receipt, runNpm });
    if (plan.action !== 'migrated') {
        return plan;
    }
    const snapshots = snapshotChanges(repository, plan.changes);
    try {
        for (const [file, value] of [...plan.changes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            const absolute = path.join(repository, file);
            if (value == null) {
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
        return plan;
    } catch (error) {
        try {
            restoreChanges(repository, snapshots);
        } catch {
            throw migrationError('migration failed and rollback could not restore every file');
        }
        throw error instanceof Error ? error : migrationError(String(error));
    }
}
