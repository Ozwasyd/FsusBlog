#!/usr/bin/env node

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
    requireVerifiedFsusuiEvent,
    reverifyFsusuiEventReceipt
} from './verify-fsusui-release-event.mjs';

const defaultRoot = path.resolve(import.meta.dirname, '../..');

export const PACKAGE_NAME = '@ozwasyd/element-plus';
export const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const RELEASE_TRAIN_BRANCH = 'deps/fsusui-release-train';
export const PACKAGE_JSON_PATH = 'src/frontend/package.json';
export const PACKAGE_LOCK_PATH = 'src/frontend/package-lock.json';
export const PACKAGE_LOCK_LOCATION = `node_modules/${PACKAGE_NAME}`;
export const RELEASE_TITLE_PREFIX = `deps: update ${PACKAGE_NAME} to `;

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function releaseError(detail) {
    return new Error(`FsusUI release train: ${detail}`);
}

function requireCondition(condition, detail) {
    if (!condition) {
        throw releaseError(detail);
    }
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

function equalJson(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function parseStableVersion(value, label = 'version') {
    const match = typeof value === 'string' ? stableVersionPattern.exec(value) : null;
    requireCondition(match, `${label} must be a stable X.Y.Z version`);
    return match.slice(1).map(Number);
}

export function compareStableVersions(left, right) {
    const leftParts = parseStableVersion(left, 'left version');
    const rightParts = parseStableVersion(right, 'right version');
    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] > rightParts[index] ? 1 : -1;
        }
    }
    return 0;
}

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw releaseError(`invalid JSON: ${file}`);
    }
}

export function readFrontendFiles(repository) {
    const frontend = path.join(repository, 'src/frontend');
    return {
        manifest: readJsonFile(path.join(frontend, 'package.json')),
        lockfile: readJsonFile(path.join(frontend, 'package-lock.json'))
    };
}

function withoutTargetDependency(value) {
    const copy = structuredClone(value);
    for (const section of dependencySections) {
        if (copy[section] && typeof copy[section] === 'object') {
            delete copy[section][PACKAGE_NAME];
        }
    }
    return copy;
}

function withoutTargetRootDependency(lockfile) {
    const root = structuredClone(lockfile?.packages?.[''] ?? {});
    for (const section of dependencySections) {
        if (root[section] && typeof root[section] === 'object') {
            delete root[section][PACKAGE_NAME];
        }
    }
    return root;
}

function assertManifestTargetOnly(beforeManifest, afterManifest) {
    requireCondition(
        equalJson(withoutTargetDependency(beforeManifest), withoutTargetDependency(afterManifest)),
        'package.json changed a dependency or field outside @ozwasyd/element-plus'
    );
    requireCondition(
        Object.hasOwn(afterManifest.dependencies ?? {}, PACKAGE_NAME),
        'package.json target dependency is missing'
    );
    for (const section of dependencySections.slice(1)) {
        requireCondition(
            !Object.hasOwn(afterManifest[section] ?? {}, PACKAGE_NAME),
            `package.json must not duplicate ${PACKAGE_NAME} in ${section}`
        );
    }
}

export function assertPublicNpmTarballUrl(value, version) {
    let url;
    try {
        url = new URL(value);
    } catch {
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

export function assertPublicReleaseLock(lockfile, payload) {
    const entry = lockfile?.packages?.[PACKAGE_LOCK_LOCATION];
    requireCondition(entry && typeof entry === 'object' && !Array.isArray(entry), 'package-lock target entry is missing');
    requireCondition(entry.link !== true, 'package-lock target entry must not be a link');
    requireCondition(entry.version === payload.version, 'package-lock target version does not match the verified event');
    requireCondition(entry.integrity === payload.npmIntegrity, 'package-lock target integrity does not match the verified event');
    requireCondition(typeof entry.resolved === 'string', 'package-lock target resolved URL is missing');
    assertPublicNpmTarballUrl(entry.resolved, payload.version);
    return entry;
}

export function currentPackageVersion(manifest, lockfile) {
    const manifestVersion = manifest?.dependencies?.[PACKAGE_NAME];
    const lockRootVersion = lockfile?.packages?.['']?.dependencies?.[PACKAGE_NAME];
    const lockTargetVersion = lockfile?.packages?.[PACKAGE_LOCK_LOCATION]?.version;
    parseStableVersion(manifestVersion, 'current package.json version');
    requireCondition(lockRootVersion === manifestVersion, 'package.json and package-lock direct versions disagree');
    requireCondition(lockTargetVersion === manifestVersion, 'package-lock target version disagrees with package.json');
    return manifestVersion;
}

function directDependencyNames(manifest) {
    return new Set(dependencySections.flatMap((section) => Object.keys(manifest?.[section] ?? {})));
}

function assertGeneratedFiles(beforeManifest, beforeLockfile, afterManifest, afterLockfile, payload) {
    assertManifestTargetOnly(beforeManifest, afterManifest);
    requireCondition(afterManifest.dependencies?.[PACKAGE_NAME] === payload.version, 'package.json target must be exact verified version');
    requireCondition(afterLockfile.packages?.['']?.dependencies?.[PACKAGE_NAME] === payload.version, 'package-lock direct target must be exact verified version');
    requireCondition(
        equalJson(withoutTargetRootDependency(beforeLockfile), withoutTargetRootDependency(afterLockfile)),
        'package-lock changed root metadata outside the target dependency'
    );
    for (const packageName of directDependencyNames(beforeManifest)) {
        if (packageName === PACKAGE_NAME) {
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

export function formatReleaseTrainBody(payload, receipt, { firstPublicNpmMigration = false } = {}) {
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

export function buildReleasePlan({ manifest, lockfile, receipt, generatedManifest, generatedLockfile, firstPublicNpmMigration = false }) {
    const payload = requireVerifiedFsusuiEvent(receipt);
    requireCondition(payload.package === PACKAGE_NAME, 'verified event package is not the managed package');
    const currentVersion = currentPackageVersion(manifest, lockfile);
    const ordering = compareStableVersions(payload.version, currentVersion);
    if (ordering < 0) {
        throw releaseError(`verified version ${payload.version} is older than current ${currentVersion}`);
    }
    if (ordering === 0) {
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

function npmCommand(environment) {
    const npmExecPath = environment.npm_execpath;
    return npmExecPath ? { command: process.execPath, prefix: [npmExecPath] } : { command: 'npm', prefix: [] };
}

function runNpmCommand({ cwd, args, env }) {
    const npm = npmCommand(env);
    return new Promise((resolve, reject) => {
        execFile(npm.command, [...npm.prefix, ...args], {
            cwd,
            env,
            maxBuffer: 4 * 1024 * 1024
        }, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function cleanNpmEnvironment(tempRoot) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(?:npm_config_|NPM_CONFIG_)/u.test(key)) {
            delete env[key];
        }
    }
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PACKAGES_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
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

export async function regeneratePublicLock({ manifest, lockfile, version, runNpm = runNpmCommand }) {
    parseStableVersion(version, 'verified version');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-release-train-'));
    try {
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
        try {
            await runNpm({ cwd: temporary, args, env });
        } catch {
            throw releaseError('public npm lock regeneration failed');
        }
        return {
            manifest: readJsonFile(path.join(temporary, 'package.json')),
            lockfile: readJsonFile(path.join(temporary, 'package-lock.json'))
        };
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

export function writeReleaseFiles(repository, plan) {
    requireCondition(plan?.manifest && plan?.lockfile, 'release plan package files are missing');
    const frontend = path.join(repository, 'src/frontend');
    const manifestFile = path.join(frontend, 'package.json');
    const lockfileFile = path.join(frontend, 'package-lock.json');
    const beforeManifest = fs.readFileSync(manifestFile);
    const beforeLockfile = fs.readFileSync(lockfileFile);
    try {
        fs.writeFileSync(manifestFile, `${JSON.stringify(plan.manifest, null, 4)}\n`);
        fs.writeFileSync(lockfileFile, `${JSON.stringify(plan.lockfile, null, 4)}\n`);
    } catch {
        try {
            fs.writeFileSync(manifestFile, beforeManifest);
            fs.writeFileSync(lockfileFile, beforeLockfile);
        } catch {
            throw releaseError('failed to restore package files after an interrupted write');
        }
        throw releaseError('failed to write package files');
    }
}

export async function applyReleaseUpdate({ repository = defaultRoot, receipt, runNpm = runNpmCommand }) {
    const before = readFrontendFiles(repository);
    const payload = requireVerifiedFsusuiEvent(receipt);
    const currentVersion = currentPackageVersion(before.manifest, before.lockfile);
    const ordering = compareStableVersions(payload.version, currentVersion);
    if (ordering < 0) {
        throw releaseError(`verified version ${payload.version} is older than current ${currentVersion}`);
    }
    if (ordering === 0) {
        return buildReleasePlan({ ...before, receipt });
    }
    const generated = await regeneratePublicLock({
        manifest: before.manifest,
        lockfile: before.lockfile,
        version: payload.version,
        runNpm
    });
    const plan = buildReleasePlan({
        ...before,
        receipt,
        generatedManifest: generated.manifest,
        generatedLockfile: generated.lockfile
    });
    writeReleaseFiles(repository, plan);
    return plan;
}

function git(repository, args, { allowFailure = false } = {}) {
    try {
        return execFileSync('git', args, {
            cwd: repository,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 4 * 1024 * 1024
        }).trim();
    } catch (error) {
        if (allowFailure) {
            return '';
        }
        throw releaseError(`git command failed: git ${args.join(' ')}`);
    }
}

function assertCleanWorktree(repository) {
    requireCondition(git(repository, ['status', '--porcelain']) === '', 'worktree must be clean before release-train branch preparation');
}

export function prepareReleaseTrainBranch(repository, baseBranch = 'master') {
    requireCondition(baseBranch !== RELEASE_TRAIN_BRANCH, 'release-train branch must not be the default branch');
    assertCleanWorktree(repository);
    git(repository, ['fetch', 'origin', baseBranch]);
    const remoteRef = `refs/heads/${RELEASE_TRAIN_BRANCH}`;
    const remoteBranch = git(repository, ['ls-remote', '--exit-code', 'origin', remoteRef], { allowFailure: true });
    const exists = remoteBranch.length > 0;
    if (exists) {
        git(repository, ['fetch', 'origin', `${remoteRef}:refs/remotes/origin/${RELEASE_TRAIN_BRANCH}`]);
        git(repository, ['checkout', '--force', '-B', RELEASE_TRAIN_BRANCH, `origin/${RELEASE_TRAIN_BRANCH}`]);
        git(repository, ['merge', '--no-edit', `origin/${baseBranch}`]);
    } else {
        git(repository, ['checkout', '-B', RELEASE_TRAIN_BRANCH, `origin/${baseBranch}`]);
    }
    return { branch: RELEASE_TRAIN_BRANCH, baseBranch, existed: exists };
}

function repositoryParts(repository) {
    const match = /^(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+)$/u.exec(repository ?? '');
    requireCondition(match, 'GITHUB_REPOSITORY must be owner/name');
    return match.groups;
}

export function createGithubApi({ token, repository, fetchImpl = fetch }) {
    requireCondition(typeof token === 'string' && token.length > 0, 'GitHub write token is required');
    repositoryParts(repository);
    const apiRoot = `https://api.github.com/repos/${repository}`;
    const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28'
    };
    async function request(url, options = {}) {
        let response;
        try {
            response = await fetchImpl(url, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
        } catch {
            throw releaseError('GitHub API network request failed');
        }
        let body;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok) {
            throw releaseError(`GitHub API request failed (${response.status})`);
        }
        return body;
    }
    return {
        async getRepository() {
            return request(apiRoot);
        },
        async listOpenPullRequests(baseBranch) {
            const url = new URL(`${apiRoot}/pulls`);
            url.searchParams.set('state', 'open');
            url.searchParams.set('base', baseBranch);
            url.searchParams.set('per_page', '100');
            return request(url.href);
        },
        async createPullRequest(payload) {
            return request(`${apiRoot}/pulls`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        async updatePullRequest(number, payload) {
            return request(`${apiRoot}/pulls/${number}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        async enableAutoMerge(nodeId) {
            const body = await request('https://api.github.com/graphql', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: 'mutation($pullRequestId: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) { pullRequest { number } } }',
                    variables: { pullRequestId: nodeId }
                })
            });
            if (body?.errors?.length) {
                throw releaseError('GitHub platform auto-merge could not be enabled');
            }
            return body?.data?.enablePullRequestAutoMerge?.pullRequest;
        }
    };
}

export function selectReleaseTrainPullRequest(pullRequests, baseBranch) {
    const relevant = (pullRequests ?? []).filter((pullRequest) => {
        const sameBranch = pullRequest.head?.ref === RELEASE_TRAIN_BRANCH;
        const samePackage = typeof pullRequest.title === 'string' && pullRequest.title.startsWith(RELEASE_TITLE_PREFIX);
        return pullRequest.base?.ref === baseBranch && (sameBranch || samePackage);
    });
    requireCondition(relevant.length <= 1, 'multiple open FsusUI release-train PRs exist');
    const selected = relevant[0];
    if (selected && selected.head?.ref !== RELEASE_TRAIN_BRANCH) {
        throw releaseError('another open PR owns the FsusUI release-train package');
    }
    return selected ?? null;
}

export async function ensureSingleReleaseTrainPullRequest({ api, payload, receipt, baseBranch, firstPublicNpmMigration = false }) {
    const verifiedPayload = requireVerifiedFsusuiEvent(receipt);
    requireCondition(payload === undefined || payload === verifiedPayload, 'PR payload must be the sealed verified event payload');
    const eventPayload = verifiedPayload;
    const desired = {
        title: `${RELEASE_TITLE_PREFIX}${eventPayload.version}`,
        head: RELEASE_TRAIN_BRANCH,
        base: baseBranch,
        body: formatReleaseTrainBody(eventPayload, receipt, { firstPublicNpmMigration }),
        draft: false
    };
    const existing = selectReleaseTrainPullRequest(await api.listOpenPullRequests(baseBranch), baseBranch);
    const pullRequest = existing
        ? await api.updatePullRequest(existing.number, { title: desired.title, body: desired.body, draft: false })
        : await api.createPullRequest(desired);
    requireCondition(pullRequest?.draft !== true, 'release-train PR must not be draft');
    requireCondition(pullRequest?.title === desired.title, 'release-train PR title is not exact');
    requireCondition(pullRequest?.head?.ref === undefined || pullRequest.head.ref === RELEASE_TRAIN_BRANCH, 'release-train PR head is not fixed');
    requireCondition(pullRequest?.base?.ref === undefined || pullRequest.base.ref === baseBranch, 'release-train PR base is not the default branch');
    requireCondition(typeof pullRequest?.node_id === 'string', 'release-train PR node identity is missing');
    await api.enableAutoMerge(pullRequest.node_id);
    return pullRequest;
}

function equalPathLists(left, right) {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function stageAndCommit(repository, plan) {
    const files = [...new Set(plan.changedFiles ?? [])].sort();
    requireCondition(files.length > 0, 'release-train plan has no files to commit');
    git(repository, ['add', '--', ...files]);
    const staged = git(repository, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    requireCondition(equalPathLists(staged, files), 'release-train commit scope is not exact');
    git(repository, ['commit', '-m', plan.title]);
}

function parseArguments(args) {
    const options = { repository: defaultRoot, receipt: null, apply: false, firstMigration: false };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--receipt') {
            options.receipt = path.resolve(args[++index] ?? '');
        } else if (argument === '--root') {
            options.repository = path.resolve(args[++index] ?? '');
        } else if (argument === '--apply') {
            options.apply = true;
        } else if (argument === '--first-migration') {
            options.firstMigration = true;
        } else {
            throw releaseError('usage: --receipt FILE [--root DIR] [--apply] [--first-migration]');
        }
    }
    requireCondition(options.receipt, 'usage: --receipt FILE [--root DIR] [--apply] [--first-migration]');
    return options;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const rawReceipt = fs.readFileSync(options.receipt, 'utf8');
    const receipt = await reverifyFsusuiEventReceipt(rawReceipt);
    const payload = requireVerifiedFsusuiEvent(receipt);
    if (!options.apply) {
        const files = readFrontendFiles(options.repository);
        const currentVersion = currentPackageVersion(files.manifest, files.lockfile);
        const ordering = compareStableVersions(payload.version, currentVersion);
        if (ordering < 0) {
            throw releaseError(`verified version ${payload.version} is older than current ${currentVersion}`);
        }
        process.stdout.write(`${JSON.stringify({ action: ordering === 0 ? 'idempotent' : 'upgrade', currentVersion, targetVersion: payload.version, firstMigration: options.firstMigration })}\n`);
        return;
    }

    const repositoryName = process.env.GITHUB_REPOSITORY;
    const api = createGithubApi({
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
        repository: repositoryName
    });
    const repositoryInfo = await api.getRepository();
    const baseBranch = repositoryInfo?.default_branch;
    requireCondition(typeof baseBranch === 'string' && baseBranch.length > 0, 'GitHub default branch is missing');
    selectReleaseTrainPullRequest(await api.listOpenPullRequests(baseBranch), baseBranch);
    prepareReleaseTrainBranch(options.repository, baseBranch);

    let plan;
    let firstPublicNpmMigration = false;
    if (options.firstMigration) {
        const { migrateVerifiedFsusuiRelease } = await import('./migrate-fsusui-public-npm.mjs');
        const migration = await migrateVerifiedFsusuiRelease({ repository: options.repository, receipt });
        if (migration.action === 'migrated') {
            firstPublicNpmMigration = true;
            plan = {
                action: 'migration',
                version: payload.version,
                currentVersion: migration.currentVersion,
                changedFiles: migration.changedFiles,
                title: `${RELEASE_TITLE_PREFIX}${payload.version}`,
                body: formatReleaseTrainBody(payload, receipt, { firstPublicNpmMigration: true })
            };
        } else {
            plan = await applyReleaseUpdate({ repository: options.repository, receipt });
        }
    } else {
        plan = await applyReleaseUpdate({ repository: options.repository, receipt });
    }

    if (plan.action === 'idempotent' || plan.action === 'not-required') {
        process.stdout.write(`${JSON.stringify({ action: plan.action, version: plan.version })}\n`);
        return;
    }
    stageAndCommit(options.repository, plan);
    git(options.repository, ['push', 'origin', `HEAD:refs/heads/${RELEASE_TRAIN_BRANCH}`]);
    const pullRequest = await ensureSingleReleaseTrainPullRequest({
        api,
        payload,
        receipt,
        baseBranch,
        firstPublicNpmMigration
    });
    process.stdout.write(`${JSON.stringify({ action: plan.action, version: plan.version, branch: RELEASE_TRAIN_BRANCH, pullRequest: pullRequest.html_url ?? pullRequest.number })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
