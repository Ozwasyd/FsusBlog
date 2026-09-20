#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
    FSUSUI_PACKAGE,
    assertFsusuiReleaseTrainRenovateDelegation,
    synchronizeFsusuiReleaseTrainRenovateDelegation
} from './fsusui-manager-ownership.mjs';
import {
    requireVerifiedFsusuiEvent
} from './verify-fsusui-release-event.mjs';

const defaultRoot = path.resolve(import.meta.dirname, '../..');

export const PACKAGE_NAME = '@ozwasyd/element-plus';
export const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const RELEASE_TRAIN_BRANCH = 'deps/fsusui-release-train';
export const PACKAGE_JSON_PATH = 'src/frontend/package.json';
export const PACKAGE_LOCK_PATH = 'src/frontend/package-lock.json';
export const RENOVATE_PATH = 'renovate.json5';
export const PACKAGE_LOCK_LOCATION = `node_modules/${PACKAGE_NAME}`;
export const RELEASE_TITLE_PREFIX = `deps: update ${PACKAGE_NAME} to `;

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function releaseError(detail)
{
    return new Error(`FsusUI release train: ${detail}`);
}

function requireCondition(condition, detail)
{
    if (!condition)
    {
        throw releaseError(detail);
    }
}

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

function equalJson(left, right)
{
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function parseStableVersion(value, label = 'version')
{
    const match = typeof value === 'string' ? stableVersionPattern.exec(value) : null;
    requireCondition(match, `${label} must be a stable X.Y.Z version`);
    return match.slice(1).map(Number);
}

export function compareStableVersions(left, right)
{
    const leftParts = parseStableVersion(left, 'left version');
    const rightParts = parseStableVersion(right, 'right version');
    for (let index = 0; index < leftParts.length; index += 1)
    {
        if (leftParts[index] !== rightParts[index])
        {
            return leftParts[index] > rightParts[index] ? 1 : -1;
        }
    }
    return 0;
}

function readJsonFile(file)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch
    {
        throw releaseError(`invalid JSON: ${file}`);
    }
}

export function readFrontendFiles(repository)
{
    const frontend = path.join(repository, 'src/frontend');
    return {
        manifest: readJsonFile(path.join(frontend, 'package.json')),
        lockfile: readJsonFile(path.join(frontend, 'package-lock.json'))
    };
}

function withoutTargetDependency(value)
{
    const copy = structuredClone(value);
    for (const section of dependencySections)
    {
        if (copy[section] && typeof copy[section] === 'object')
        {
            delete copy[section][PACKAGE_NAME];
        }
    }
    return copy;
}

function withoutTargetRootDependency(lockfile)
{
    const root = structuredClone(lockfile?.packages?.[''] ?? {});
    for (const section of dependencySections)
    {
        if (root[section] && typeof root[section] === 'object')
        {
            delete root[section][PACKAGE_NAME];
        }
    }
    return root;
}

function assertManifestTargetOnly(beforeManifest, afterManifest)
{
    requireCondition(
        equalJson(withoutTargetDependency(beforeManifest), withoutTargetDependency(afterManifest)),
        'package.json changed a dependency or field outside @ozwasyd/element-plus'
    );
    requireCondition(
        Object.hasOwn(afterManifest.dependencies ?? {}, PACKAGE_NAME),
        'package.json target dependency is missing'
    );
    for (const section of dependencySections.slice(1))
    {
        requireCondition(
            !Object.hasOwn(afterManifest[section] ?? {}, PACKAGE_NAME),
            `package.json must not duplicate ${PACKAGE_NAME} in ${section}`
        );
    }
}

export function assertPublicNpmTarballUrl(value, version)
{
    let url;
    try
    {
        url = new URL(value);
    }
    catch
    {
        throw releaseError('package-lock resolved URL is invalid');
    }
    requireCondition(
        url.protocol === 'https:'
            && url.origin === new URL(PUBLIC_NPM_REGISTRY).origin
            && !url.username
            && !url.password
            && !url.search
            && !url.hash,
        'package-lock resolved URL must be a public npm tarball'
    );
    const packagePath = PACKAGE_NAME.slice(PACKAGE_NAME.indexOf('/') + 1);
    const expectedPath = `/${PACKAGE_NAME}/-/${packagePath}-${version}.tgz`;
    requireCondition(decodeURIComponent(url.pathname) === expectedPath, 'package-lock resolved URL package/version mismatch');
}

export function assertPublicReleaseLock(lockfile, payload)
{
    const entry = lockfile?.packages?.[PACKAGE_LOCK_LOCATION];
    requireCondition(entry && typeof entry === 'object' && !Array.isArray(entry), 'package-lock target entry is missing');
    requireCondition(entry.link !== true, 'package-lock target entry must not be a link');
    requireCondition(entry.version === payload.version, 'package-lock target version does not match the verified event');
    requireCondition(entry.integrity === payload.npmIntegrity, 'package-lock target integrity does not match the verified event');
    requireCondition(typeof entry.resolved === 'string', 'package-lock target resolved URL is missing');
    assertPublicNpmTarballUrl(entry.resolved, payload.version);
    return entry;
}

export function currentPackageVersion(manifest, lockfile)
{
    const manifestVersion = manifest?.dependencies?.[PACKAGE_NAME];
    const lockRootVersion = lockfile?.packages?.['']?.dependencies?.[PACKAGE_NAME];
    const lockTargetVersion = lockfile?.packages?.[PACKAGE_LOCK_LOCATION]?.version;
    parseStableVersion(manifestVersion, 'current package.json version');
    requireCondition(lockRootVersion === manifestVersion, 'package.json and package-lock direct versions disagree');
    requireCondition(lockTargetVersion === manifestVersion, 'package-lock target version disagrees with package.json');
    return manifestVersion;
}

function directDependencyNames(manifest)
{
    return new Set(dependencySections.flatMap((section) => Object.keys(manifest?.[section] ?? {})));
}

function assertGeneratedFiles(beforeManifest, beforeLockfile, afterManifest, afterLockfile, payload)
{
    assertManifestTargetOnly(beforeManifest, afterManifest);
    requireCondition(afterManifest.dependencies?.[PACKAGE_NAME] === payload.version, 'package.json target must be exact verified version');
    requireCondition(afterLockfile.packages?.['']?.dependencies?.[PACKAGE_NAME] === payload.version, 'package-lock direct target must be exact verified version');
    requireCondition(
        equalJson(withoutTargetRootDependency(beforeLockfile), withoutTargetRootDependency(afterLockfile)),
        'package-lock changed root metadata outside the target dependency'
    );
    for (const packageName of directDependencyNames(beforeManifest))
    {
        if (packageName === PACKAGE_NAME)
        {
            continue;
        }
        const location = `node_modules/${packageName}`;
        requireCondition(
            equalJson(beforeLockfile.packages?.[location], afterLockfile.packages?.[location]),
            `package-lock changed direct dependency outside ${PACKAGE_NAME}: ${packageName}`
        );
    }
    assertPublicReleaseLock(afterLockfile, payload);
}

export function formatReleaseTrainBody(payload, receipt, { firstPublicNpmMigration = false } = {})
{
    return [
        'Refs #1983',
        '',
        '## Verified FsusUI release',
        '',
        `- package: \`${payload.package}\``,
        `- version: \`${payload.version}\``,
        `- source commit: \`${payload.sourceCommit}\``,
        `- release tag: \`${payload.releaseTag}\``,
        `- candidate SHA-256: \`${payload.candidateSha256}\``,
        `- candidate manifest SHA-256: \`${payload.candidateManifestSha256}\``,
        `- npm tarball SHA-256: \`${payload.npmTarballSha256}\``,
        `- cross-gate receipt SHA-256: \`${payload.crossGateReceiptSha256}\``,
        `- publish run: \`${payload.publishRunId}\``,
        `- verified event receipt: \`${receipt.receiptSha256}\``,
        ...(firstPublicNpmMigration ? ['', 'This is the first verified public npm migration; registry and token retirement are part of this same PR.'] : []),
        '',
        'This PR is generated by the FsusUI release train. It remains subject to the required checks and platform auto-merge policy.'
    ].join('\n');
}

export function buildReleasePlan({ manifest, lockfile, receipt, generatedManifest, generatedLockfile, firstPublicNpmMigration = false })
{
    const payload = requireVerifiedFsusuiEvent(receipt);
    requireCondition(payload.package === PACKAGE_NAME, 'verified event package is not the managed package');
    const currentVersion = currentPackageVersion(manifest, lockfile);
    const ordering = compareStableVersions(payload.version, currentVersion);
    if (ordering < 0)
    {
        throw releaseError(`verified version ${payload.version} is older than current ${currentVersion}`);
    }
    if (ordering === 0)
    {
        assertPublicReleaseLock(lockfile, payload);
        return Object.freeze({
            action: 'idempotent',
            version: payload.version,
            currentVersion,
            changedFiles: [],
            title: `${RELEASE_TITLE_PREFIX}${payload.version}`,
            body: formatReleaseTrainBody(payload, receipt, { firstPublicNpmMigration })
        });
    }

    requireCondition(generatedManifest && generatedLockfile, 'generated package files are required for an upgrade');
    assertGeneratedFiles(manifest, lockfile, generatedManifest, generatedLockfile, payload);
    return Object.freeze({
        action: 'upgrade',
        version: payload.version,
        currentVersion,
        manifest: generatedManifest,
        lockfile: generatedLockfile,
        changedFiles: [PACKAGE_JSON_PATH, PACKAGE_LOCK_PATH],
        title: `${RELEASE_TITLE_PREFIX}${payload.version}`,
        body: formatReleaseTrainBody(payload, receipt, { firstPublicNpmMigration })
    });
}

function npmCommand(environment)
{
    const npmExecPath = environment.npm_execpath;
    return npmExecPath ? { command: process.execPath, prefix: [npmExecPath] } : { command: 'npm', prefix: [] };
}

function runNpmCommand({ cwd, args, env })
{
    const npm = npmCommand(env);
    return new Promise((resolve, reject) =>
    {
        execFile(npm.command, [...npm.prefix, ...args], {
            cwd,
            env,
            maxBuffer: 4 * 1024 * 1024
        }, (error) =>
        {
            if (error)
            {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function cleanNpmEnvironment(tempRoot)
{
    const env = { ...process.env };
    for (const key of Object.keys(env))
    {
        if (/^(?:npm_config_|NPM_CONFIG_)/u.test(key))
        {
            delete env[key];
        }
    }
    const retiredPrivatePackageToken = ['GITHUB', 'PACKAGES', 'TOKEN'].join('_');
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', retiredPrivatePackageToken, 'NODE_AUTH_TOKEN', 'NPM_TOKEN'])
    {
        delete env[key];
    }
    const userConfig = path.join(tempRoot, 'npmrc');
    fs.writeFileSync(userConfig, '');
    return {
        ...env,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: userConfig,
        npm_config_registry: PUBLIC_NPM_REGISTRY,
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false'
    };
}

export async function regeneratePublicLock({ manifest, lockfile, version, runNpm = runNpmCommand })
{
    parseStableVersion(version, 'verified version');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-release-train-'));
    try
    {
        const nextManifest = {
            ...manifest,
            dependencies: { ...manifest.dependencies, [PACKAGE_NAME]: version }
        };
        fs.writeFileSync(path.join(temporary, 'package.json'), `${JSON.stringify(nextManifest, null, 4)}\n`);
        fs.writeFileSync(path.join(temporary, 'package-lock.json'), `${JSON.stringify(lockfile, null, 4)}\n`);
        const env = cleanNpmEnvironment(temporary);
        const args = [
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            `--registry=${PUBLIC_NPM_REGISTRY}`,
            '--save-exact',
            `${PACKAGE_NAME}@${version}`
        ];
        try
        {
            await runNpm({ cwd: temporary, args, env });
        }
        catch
        {
            throw releaseError('public npm lock regeneration failed');
        }
        return {
            manifest: readJsonFile(path.join(temporary, 'package.json')),
            lockfile: readJsonFile(path.join(temporary, 'package-lock.json'))
        };
    }
    finally
    {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

export function writeReleaseFiles(repository, plan)
{
    requireCondition(plan?.manifest && plan?.lockfile, 'release plan package files are missing');
    const files = new Map([
        [PACKAGE_JSON_PATH, `${JSON.stringify(plan.manifest, null, 4)}\n`],
        [PACKAGE_LOCK_PATH, `${JSON.stringify(plan.lockfile, null, 4)}\n`]
    ]);
    if (plan.renovate)
    {
        files.set(RENOVATE_PATH, `${JSON.stringify(plan.renovate, null, 4)}\n`);
    }
    const snapshots = new Map([...files.keys()].map((relative) => [relative, fs.readFileSync(path.join(repository, relative))]));
    try
    {
        for (const [relative, contents] of files)
        {
            fs.writeFileSync(path.join(repository, relative), contents);
        }
    }
    catch
    {
        try
        {
            for (const [relative, contents] of snapshots)
            {
                fs.writeFileSync(path.join(repository, relative), contents);
            }
        }
        catch
        {
            throw releaseError('failed to restore release-train files after an interrupted write');
        }
        throw releaseError('failed to write release-train files');
    }
}

export async function applyReleaseUpdate({ repository = defaultRoot, receipt, runNpm = runNpmCommand })
{
    const before = readFrontendFiles(repository);
    const payload = requireVerifiedFsusuiEvent(receipt);
    const currentVersion = currentPackageVersion(before.manifest, before.lockfile);
    const ordering = compareStableVersions(payload.version, currentVersion);
    if (ordering < 0)
    {
        throw releaseError(`verified version ${payload.version} is older than current ${currentVersion}`);
    }
    if (ordering === 0)
    {
        const renovate = readJsonFile(path.join(repository, RENOVATE_PATH));
        if ((renovate.packageRules ?? []).some((rule) => (rule.matchPackageNames ?? []).includes(FSUSUI_PACKAGE)))
        {
            assertFsusuiReleaseTrainRenovateDelegation(renovate, payload.version);
        }
        return buildReleasePlan({ ...before, receipt });
    }
    const generated = await regeneratePublicLock({
        manifest: before.manifest,
        lockfile: before.lockfile,
        version: payload.version,
        runNpm
    });
    const packagePlan = buildReleasePlan({
        ...before,
        receipt,
        generatedManifest: generated.manifest,
        generatedLockfile: generated.lockfile
    });
    const currentRenovate = readJsonFile(path.join(repository, RENOVATE_PATH));
    const hasDelegation = (currentRenovate.packageRules ?? []).some((rule) => (rule.matchPackageNames ?? []).includes(FSUSUI_PACKAGE));
    const plan = hasDelegation ? Object.freeze({
        ...packagePlan,
        renovate: synchronizeFsusuiReleaseTrainRenovateDelegation(currentRenovate, payload.version),
        changedFiles: [...packagePlan.changedFiles, RENOVATE_PATH]
    }) : packagePlan;
    writeReleaseFiles(repository, plan);
    return plan;
}

export async function applyVerifiedReleaseTrain({
    repository = defaultRoot,
    receipt,
    runNpm = runNpmCommand,
    migrationPatchSha256
})
{
    const { migrateVerifiedFsusuiRelease } = await import('./migrate-fsusui-public-npm.mjs');
    const migration = await migrateVerifiedFsusuiRelease({
        repository,
        receipt,
        runNpm,
        migrationPatchSha256
    });
    if (migration.action === 'migrated')
    {
        return {
            migration,
            firstPublicNpmMigration: true,
            plan: {
                action: 'migration',
                version: migration.version,
                currentVersion: migration.currentVersion,
                changedFiles: migration.changedFiles,
                title: `${RELEASE_TITLE_PREFIX}${migration.version}`,
                body: formatReleaseTrainBody(requireVerifiedFsusuiEvent(receipt), receipt, { firstPublicNpmMigration: true })
            }
        };
    }
    return {
        migration,
        firstPublicNpmMigration: false,
        plan: await applyReleaseUpdate({ repository, receipt, runNpm })
    };
}
