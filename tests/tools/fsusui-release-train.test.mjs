import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs, { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
// eslint-disable-next-line import-x/order
import os from 'node:os';

const {applyReleaseUpdate, assertPublicReleaseLock, buildReleasePlan, compareStableVersions, ensureSingleReleaseTrainPullRequest, PACKAGE_LOCK_LOCATION, PACKAGE_NAME, PUBLIC_NPM_REGISTRY, RELEASE_TRAIN_BRANCH, selectReleaseTrainPullRequest} = await import(new URL('../../tools/dependencies/update-fsusui-release.mjs', import.meta.url));
const {migrateVerifiedFsusuiRelease, PRIVATE_REFERENCE_MARKERS, scanPrivateFsusuiReferences} = await import(new URL('../../tools/dependencies/migrate-fsusui-public-npm.mjs', import.meta.url));
const {activateFsusuiReleaseTrainManager, assertFsusuiManagerState, evaluateFsusuiManagerOwnership, FSUSUI_ITEM_ID, FSUSUI_RELEASE_TRAIN_MANAGER} = await import(new URL('../../tools/dependencies/fsusui-manager-ownership.mjs', import.meta.url));
const {evaluateFreshness, exceptionsSchema, extractCurrentVersions} = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
const {evaluatePlatformAutomerge} = await import(new URL('../../tools/governance/dependency-automerge.mjs', import.meta.url));
const {resolveGroupChecks} = await import(new URL('../../tools/governance/dependency-required-checks.mjs', import.meta.url));
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
const {requireVerifiedFsusuiEvent, verifyFsusuiReleaseEvent} = await import(new URL('../../tools/dependencies/verify-fsusui-release-event.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const packageVersion = '1.5.2';
const oldPackageVersion = '1.5.1';
const packagePath = `/${PACKAGE_NAME}`;

const fixedNow = new Date('2026-09-08T00:00:00.000Z');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const integrity = (value) => `sha512-${createHash('sha512').update(value).digest('base64')}`;

function archive(manifestBytes)
{
    const header = Buffer.alloc(512, 0);
    header.write('package/package.json', 0, 'utf8');
    header.write('0000644', 100, 'ascii');
    header.write('0000000', 108, 'ascii');
    header.write('0000000', 116, 'ascii');
    header.write(manifestBytes.length.toString(8).padStart(11, '0'), 124, 'ascii');
    header.write('00000000000', 136, 'ascii');
    header[156] = 48;
    header.write('        ', 148, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
    const padding = Buffer.alloc((512 - (manifestBytes.length % 512)) % 512);
    return gzipSync(Buffer.concat([header, manifestBytes, padding, Buffer.alloc(1024)]));
}

async function registryFixture(t, version = packageVersion)
{
    const manifest = { name: PACKAGE_NAME, version };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const tarball = archive(manifestBytes);
    const metadata = {
        name: PACKAGE_NAME,
        version,
        dist: {
            integrity: integrity(tarball),
            tarball: `${PUBLIC_NPM_REGISTRY}${PACKAGE_NAME}/-/${PACKAGE_NAME.slice(PACKAGE_NAME.indexOf('/') + 1)}-${version}.tgz`
        }
    };
    const payload = {
        schemaVersion: 1,
        package: PACKAGE_NAME,
        version,
        distTag: 'latest',
        registry: PUBLIC_NPM_REGISTRY,
        sourceRepository: 'Ozwasyd/FsusUI',
        sourceCommit: 'a'.repeat(40),
        releaseTag: `v${version}`,
        candidateSha256: sha256(tarball),
        candidateManifestSha256: sha256(manifestBytes),
        crossGateReceiptSha256: 'c'.repeat(64),
        npmIntegrity: integrity(tarball),
        npmTarballSha256: sha256(tarball),
        publishRunId: '1986'
    };
    const server = createServer((request, response) =>
    {
        const route = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname);
        if (route === `/${PACKAGE_NAME}/${version}` || route === `/${PACKAGE_NAME}/latest`)
        {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(metadata));
            return;
        }
        if (route === `${packagePath}/-/${PACKAGE_NAME.slice(PACKAGE_NAME.indexOf('/') + 1)}-${version}.tgz`)
        {
            response.setHeader('content-type', 'application/octet-stream');
            response.end(tarball);
            return;
        }
        response.statusCode = 404;
        response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const transport = async (target, options) =>
    {
        const targetUrl = new URL(target);
        const response = await fetch(`http://127.0.0.1:${address.port}${targetUrl.pathname}`, { signal: options?.signal });
        return {
            ok: response.ok,
            redirected: false,
            url: target,
            body: response.body
        };
    };
    t.after(() => server.close());
    const receipt = await verifyFsusuiReleaseEvent(JSON.stringify(payload), {
        transport,
        now: () => fixedNow
    });
    return { metadata, manifestBytes, payload, receipt, tarball };
}

function temporaryRoot(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-release-train-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function publicResolved(version)
{
    return `${PUBLIC_NPM_REGISTRY}${PACKAGE_NAME}/-/${PACKAGE_NAME.slice(PACKAGE_NAME.indexOf('/') + 1)}-${version}.tgz`;
}

function writeConsumerFixture(directory, { version = oldPackageVersion, payload, privateReferences = true } = {})
{
    const frontend = path.join(directory, 'src/frontend');
    fs.mkdirSync(frontend, { recursive: true });
    const oldIntegrity = `sha512-${'A'.repeat(86)}==`;
    const manifest = {
        name: 'fsusblog-client',
        private: true,
        version: '0.0.0',
        dependencies: {
            [PACKAGE_NAME]: version,
            vue: '3.5.33'
        }
    };
    const lockfile = {
        name: 'fsusblog-client',
        version: '0.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
            '': {
                name: 'fsusblog-client',
                version: '0.0.0',
                dependencies: {
                    [PACKAGE_NAME]: version,
                    vue: '3.5.33'
                }
            },
            'node_modules/vue': {
                version: '3.5.33',
                resolved: publicResolved('3.5.33'),
                integrity: 'sha512-vue-fixture'
            },
            [PACKAGE_LOCK_LOCATION]: {
                version,
                resolved: privateReferences ? `https://npm.pkg.github.com/download/${PACKAGE_NAME}/${version}/private` : publicResolved(version),
                integrity: privateReferences ? oldIntegrity : payload.npmIntegrity,
                dependencies: {}
            }
        }
    };
    fs.writeFileSync(path.join(frontend, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    fs.writeFileSync(path.join(frontend, 'package-lock.json'), `${JSON.stringify(lockfile, null, 4)}\n`);
    if (privateReferences)
    {
        fs.writeFileSync(path.join(directory, '.npmrc'), '@ozwasyd:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}\n');
        fs.writeFileSync(path.join(frontend, '.npmrc'), 'registry=https://registry.npmjs.org/\n@ozwasyd:registry=https://npm.pkg.github.com\n');
        fs.mkdirSync(path.join(directory, 'ops/docker'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'ops/docker/Dockerfile'), 'RUN --mount=type=secret,id=github_packages_token echo GitHub Packages\n');
        fs.mkdirSync(path.join(directory, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'tools/build.sh'), 'RequireNonEmptyEnv GITHUB_PACKAGES_TOKEN\n');
        fs.writeFileSync(path.join(directory, 'README.md'), 'Install from GitHub Packages with GITHUB_PACKAGES_TOKEN.\n');
    }
    return { manifest, lockfile };
}

function fakePublicLockGenerator(payload)
{
    return async ({ cwd, env, args }) =>
    {
        assert.equal(env.npm_config_registry, PUBLIC_NPM_REGISTRY);
        assert.equal(env.GITHUB_PACKAGES_TOKEN, undefined);
        assert.equal(env.NPM_TOKEN, undefined);
        assert.ok(args.includes(`--registry=${PUBLIC_NPM_REGISTRY}`));
        const manifestFile = path.join(cwd, 'package.json');
        const lockFile = path.join(cwd, 'package-lock.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const lockfile = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        const version = manifest.dependencies[PACKAGE_NAME];
        lockfile.packages[''].dependencies[PACKAGE_NAME] = version;
        lockfile.packages[PACKAGE_LOCK_LOCATION] = {
            version,
            resolved: publicResolved(version),
            integrity: payload.npmIntegrity,
            dependencies: {}
        };
        fs.writeFileSync(lockFile, `${JSON.stringify(lockfile, null, 4)}\n`);
    };
}

function preMigrationCatalog()
{
    return {
        schema: 'fsusblog.dependency-update-surface.v1',
        items: [{
            id: FSUSUI_ITEM_ID,
            datasource: 'npm',
            packageName: PACKAGE_NAME,
            manager: 'npm',
            files: ['src/frontend/package.json', 'src/frontend/package-lock.json'],
            versioning: 'npm',
            group: 'frontend-runtime',
            stabilityPolicy: 'stable-only',
            fieldPaths: ['/dependencies/@ozwasyd~1element-plus']
        }],
        exclusions: []
    };
}

test('full local registry fixture carries one candidate through strict verifier and public lock update', async (t) =>
{
    const fixture = await registryFixture(t);
    const directory = temporaryRoot(t);
    writeConsumerFixture(directory, { payload: fixture.payload });
    const plan = await applyReleaseUpdate({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: fakePublicLockGenerator(fixture.payload)
    });
    assert.equal(plan.action, 'upgrade');
    assert.deepEqual(plan.changedFiles, ['src/frontend/package.json', 'src/frontend/package-lock.json']);
    const updated = JSON.parse(fs.readFileSync(path.join(directory, 'src/frontend/package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(directory, 'src/frontend/package-lock.json'), 'utf8'));
    assert.equal(updated.dependencies[PACKAGE_NAME], packageVersion);
    assertPublicReleaseLock(lockfile, fixture.payload);
    assert.equal(fs.existsSync(path.join(directory, '.npmrc')), true, 'normal #1983 update must not execute #1984 migration');
    assert.equal(compareStableVersions(packageVersion, oldPackageVersion), 1);
    assert.throws(() => buildReleasePlan({
        manifest: updated,
        lockfile,
        receipt: JSON.parse(JSON.stringify(fixture.receipt))
    }), /sealed verified event/u);
    const repeat = buildReleasePlan({ manifest: updated, lockfile, receipt: fixture.receipt });
    assert.equal(repeat.action, 'idempotent');
});

test('release train rejects old or private idempotent states and updates one fixed PR', async (t) =>
{
    const current = await registryFixture(t, packageVersion);
    const old = await registryFixture(t, oldPackageVersion);
    const privateDirectory = temporaryRoot(t);
    writeConsumerFixture(privateDirectory, { version: packageVersion, payload: current.payload });
    const privateLockFile = path.join(privateDirectory, 'src/frontend/package-lock.json');
    const privateLock = JSON.parse(fs.readFileSync(privateLockFile, 'utf8'));
    privateLock.packages[PACKAGE_LOCK_LOCATION].integrity = current.payload.npmIntegrity;
    fs.writeFileSync(privateLockFile, `${JSON.stringify(privateLock, null, 4)}\n`);
    assert.throws(() => buildReleasePlan({
        manifest: JSON.parse(fs.readFileSync(path.join(privateDirectory, 'src/frontend/package.json'), 'utf8')),
        lockfile: JSON.parse(fs.readFileSync(path.join(privateDirectory, 'src/frontend/package-lock.json'), 'utf8')),
        receipt: current.receipt
    }), /public npm tarball/u);
    const directory = temporaryRoot(t);
    writeConsumerFixture(directory, { payload: current.payload });
    await applyReleaseUpdate({ repository: directory, receipt: current.receipt, runNpm: fakePublicLockGenerator(current.payload) });
    await assert.rejects(
        applyReleaseUpdate({ repository: directory, receipt: old.receipt, runNpm: fakePublicLockGenerator(old.payload) }),
        /older than current/u
    );

    const calls = [];
    const existing = {
        number: 42,
        node_id: 'PR_node_42',
        draft: false,
        head: { ref: RELEASE_TRAIN_BRANCH },
        base: { ref: 'master' },
        title: 'deps: update @ozwasyd/element-plus to 1.5.1'
    };
    const api = {
        async listOpenPullRequests()
        {
            return [existing];
        },
        async updatePullRequest(number, body)
        {
            calls.push(['update', number, body]);
            return { ...existing, ...body };
        },
        async createPullRequest(body)
        {
            calls.push(['create', body]);
            return { ...existing, ...body };
        },
        async enableAutoMerge(nodeId)
        {
            calls.push(['automerge', nodeId]);
        }
    };
    const pullRequest = await ensureSingleReleaseTrainPullRequest({
        api,
        payload: requireVerifiedFsusuiEvent(current.receipt),
        receipt: current.receipt,
        baseBranch: 'master'
    });
    assert.equal(pullRequest.title, 'deps: update @ozwasyd/element-plus to 1.5.2');
    assert.equal(calls[0][0], 'update');
    assert.deepEqual(calls.at(-1), ['automerge', 'PR_node_42']);
    assert.match(calls[0][2].body, /candidate manifest SHA-256/u);
    assert.throws(() => selectReleaseTrainPullRequest([existing, existing], 'master'), /multiple open/u);
    assert.throws(() => selectReleaseTrainPullRequest([{ ...existing, head: { ref: 'other-branch' } }], 'master'), /another open PR/u);
});

test('first verified migration is atomic, removes private wiring, and is idempotent', async (t) =>
{
    const fixture = await registryFixture(t);
    const directory = temporaryRoot(t);
    writeConsumerFixture(directory, { payload: fixture.payload });
    const beforeLock = fs.readFileSync(path.join(directory, 'src/frontend/package-lock.json'));
    const plan = await migrateVerifiedFsusuiRelease({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: fakePublicLockGenerator(fixture.payload)
    });
    assert.equal(plan.action, 'migrated');
    assert.equal(plan.migration, 'first-public-npm');
    assert.equal(plan.verified, true);
    assert.ok(plan.changedFiles.includes('src/frontend/package-lock.json'));
    assert.equal(scanPrivateFsusuiReferences(directory).clean, true);
    assert.equal(PRIVATE_REFERENCE_MARKERS.some((marker) => fs.existsSync(path.join(directory, '.npmrc')) && fs.readFileSync(path.join(directory, '.npmrc'), 'utf8').includes(marker)), false);
    assert.equal(fs.existsSync(path.join(directory, '.npmrc')), false);
    const lockfile = JSON.parse(fs.readFileSync(path.join(directory, 'src/frontend/package-lock.json'), 'utf8'));
    assertPublicReleaseLock(lockfile, fixture.payload);
    assert.notDeepEqual(fs.readFileSync(path.join(directory, 'src/frontend/package-lock.json')), beforeLock);
    const repeat = await migrateVerifiedFsusuiRelease({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: async () =>
        {
            throw new Error('idempotent migration must not invoke npm');
        }
    });
    assert.equal(repeat.action, 'not-required');
});

test('migration fails closed and leaves the fixture unchanged when public lock generation fails', async (t) =>
{
    const fixture = await registryFixture(t);
    const directory = temporaryRoot(t);
    writeConsumerFixture(directory, { payload: fixture.payload });
    const before = new Map(['.npmrc', 'src/frontend/package.json', 'src/frontend/package-lock.json'].map((file) => [
        file,
        fs.readFileSync(path.join(directory, file))
    ]));
    await assert.rejects(
        migrateVerifiedFsusuiRelease({
            repository: directory,
            receipt: fixture.receipt,
            runNpm: async () =>
            {
                throw new Error('registry unavailable');
            }
        }),
        /public npm lock regeneration failed/u
    );
    for (const [file, contents] of before)
    {
        assert.deepEqual(fs.readFileSync(path.join(directory, file)), contents);
    }
    await assert.rejects(
        migrateVerifiedFsusuiRelease({ repository: directory, receipt: JSON.parse(JSON.stringify(fixture.receipt)) }),
        /sealed verified event/u
    );
});

test('manager activation is migration-gated and freshness retains exact-one release-train coverage', async (t) =>
{
    const fixture = await registryFixture(t);
    const directory = temporaryRoot(t);
    writeConsumerFixture(directory, { version: packageVersion, payload: fixture.payload, privateReferences: false });
    const pre = preMigrationCatalog();
    assert.equal(assertFsusuiManagerState(pre, 'pre-migration').phase, 'pre-migration');
    const migration = {
        migration: 'first-public-npm',
        verified: true,
        verifiedReceiptSha256: 'd'.repeat(64),
        privateReferencesAfter: [],
        version: packageVersion
    };
    const post = activateFsusuiReleaseTrainManager(pre, migration);
    assert.equal(assertFsusuiManagerState(post, 'post-migration').phase, 'post-migration');
    assert.equal(assertFsusuiManagerState(pre, 'pre-migration').phase, 'pre-migration');
    assert.equal(evaluateFsusuiManagerOwnership({ catalog: post, migrationComplete: true, releaseTrainPullRequests: [{}] }).status, 'pass');
    assert.equal(evaluateFsusuiManagerOwnership({ catalog: pre, migrationComplete: false, releaseTrainPullRequests: [] }).status, 'pass');
    assert.equal(evaluateFsusuiManagerOwnership({ catalog: pre, migrationComplete: false, releaseTrainPullRequests: [{}] }).status, 'fail');
    assert.equal(evaluateFsusuiManagerOwnership({ catalog: post, migrationComplete: true, renovatePullRequests: [{}] }).status, 'fail');
    assert.throws(() => activateFsusuiReleaseTrainManager({ ...pre, items: [...pre.items, { ...pre.items[0], id: 'duplicate' }] }, migration), /exactly one catalog owner/u);

    const errors = [];
    const currentVersions = extractCurrentVersions(directory, post, {}, errors);
    assert.deepEqual(errors, []);
    assert.equal(currentVersions[FSUSUI_ITEM_ID].currentVersion, packageVersion);
    const config = {
        automerge: false,
        enabledManagers: ['npm'],
        packageRules: [{ matchUpdateTypes: ['major', 'minor', 'patch', 'digest'] }]
    };
    const latest = {
        latestStable: '1.5.3',
        releasedAt: new Date(fixedNow.getTime() - 60 * 60 * 1000).toISOString()
    };
    const fresh = evaluateFreshness({
        catalog: post,
        config,
        exceptions: { schema: exceptionsSchema, exceptions: [] },
        currentVersions,
        registries: { byId: { [FSUSUI_ITEM_ID]: latest } },
        pullRequests: [{
            state: 'open',
            number: 86,
            dependencyId: FSUSUI_ITEM_ID,
            packageName: PACKAGE_NAME,
            group: 'frontend-runtime',
            targetVersion: latest.latestStable
        }],
        now: fixedNow,
        root: directory
    });
    assert.equal(fresh.status, 'pass');
    assert.equal(fresh.results[0].state, 'latest-target-pr');
    const exactOneFailure = evaluateFreshness({
        catalog: post,
        config,
        exceptions: { schema: exceptionsSchema, exceptions: [] },
        currentVersions: { [FSUSUI_ITEM_ID]: { currentVersion: latest.latestStable, datasource: 'npm', packageName: PACKAGE_NAME } },
        registries: { byId: { [FSUSUI_ITEM_ID]: latest } },
        pullRequests: [{
            state: 'open',
            number: 86,
            dependencyId: FSUSUI_ITEM_ID,
            packageName: PACKAGE_NAME,
            group: 'frontend-runtime',
            targetVersion: latest.latestStable
        }],
        now: fixedNow,
        root: directory
    });
    assert.ok(exactOneFailure.errors.some((error) => error.code === 'state-not-exact-one'));
});

test('release-train PRs use the existing required checks and platform auto-merge contract', () =>
{
    const requiredCatalog = JSON.parse(readFileSync(path.join(repositoryRoot, 'config/dependencies/required-checks.json'), 'utf8'));
    const required = resolveGroupChecks(requiredCatalog, FSUSUI_RELEASE_TRAIN_MANAGER, 'patch');
    assert.ok(required.length > 0);
    const decision = evaluatePlatformAutomerge({
        catalog: requiredCatalog,
        defaultHeadSha: 'base-sha',
        latestStable: packageVersion,
        pullRequest: {
            number: 1986,
            group: FSUSUI_RELEASE_TRAIN_MANAGER,
            updateType: 'patch',
            targetVersion: packageVersion,
            draft: false,
            mergeable: true,
            mergeableState: 'clean',
            baseSha: 'base-sha',
            platformAutomerge: true,
            automergeType: 'pr',
            checkRuns: required.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
        }
    });
    assert.equal(decision.decision, 'merge');
});

test('workflow keeps verifier-before-updater ordering and does not perform registry string replacement', () =>
{
    const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/fsusui-release-train.yml'), 'utf8');
    const verifier = workflow.indexOf('verify-fsusui-release-event.mjs');
    const updater = workflow.indexOf('update-fsusui-release.mjs');
    assert.ok(verifier >= 0 && updater > verifier);
    assert.match(workflow, /repository_dispatch:[\s\S]*fsusui-npm-published-v1/u);
    assert.match(workflow, /--receipt \.tmp\/fsusui-release-train\/receipt\.json/u);
    assert.match(workflow, /--first-migration/u);
    assert.doesNotMatch(workflow, /package\.json.*replace|replace.*package\.json/u);
    assert.doesNotMatch(workflow, /GITHUB_PACKAGES_TOKEN|npm\.pkg\.github\.com/u);
    assert.match(workflow, /actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/u);
    assert.match(workflow, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/u);
});
