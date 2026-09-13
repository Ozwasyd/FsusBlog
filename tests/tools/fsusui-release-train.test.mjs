import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const {
    activateFsusuiReleaseTrainManager,
    assertFsusuiReleaseTrainRenovateDelegation,
    assertFsusuiManagerState,
    evaluateFsusuiManagerOwnership,
    FSUSUI_ITEM_ID
} = await import(new URL('../../tools/dependencies/fsusui-manager-ownership.mjs', import.meta.url));
const {
    FSUSUI_PUBLIC_NPM_MIGRATION_PATCH,
    migrateVerifiedFsusuiRelease,
    PRIVATE_REFERENCE_MARKERS,
    scanPrivateFsusuiReferences
} = await import(new URL('../../tools/dependencies/migrate-fsusui-public-npm.mjs', import.meta.url));
const {
    applyReleaseUpdate,
    applyVerifiedReleaseTrain,
    assertPublicReleaseLock,
    buildReleasePlan,
    compareStableVersions,
    PACKAGE_LOCK_LOCATION,
    PACKAGE_NAME,
    PUBLIC_NPM_REGISTRY
} = await import(new URL('../../tools/dependencies/fsusui-release-package.mjs', import.meta.url));
const {
    ensureSingleReleaseTrainPullRequest,
    RELEASE_TRAIN_BRANCH,
    selectReleaseTrainPullRequest
} = await import(new URL('../../tools/dependencies/update-fsusui-release.mjs', import.meta.url));
const {
    requireVerifiedFsusuiEvent,
    verifyFsusuiReleaseEvent
} = await import(new URL('../../tools/dependencies/verify-fsusui-release-event.mjs', import.meta.url));
const {
    evaluateFreshness,
    exceptionsSchema,
    extractCurrentVersions
} = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const packageVersion = '1.5.2';
const oldPackageVersion = '1.5.1';
const packagePath = `/${PACKAGE_NAME}`;
const privateRegistryHost = ['npm', 'pkg', 'github', 'com'].join('.');
const privateRegistryOrigin = `https://${privateRegistryHost}`;
const privatePackageToken = ['GITHUB', 'PACKAGES', 'TOKEN'].join('_');
const privateDockerSecret = ['github', 'packages', 'token'].join('_');
const privateProviderName = ['GitHub', 'Packages'].join(' ');
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

function git(repository, args)
{
    return execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
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
                resolved: privateReferences ? `${privateRegistryOrigin}/download/${PACKAGE_NAME}/${version}/private` : publicResolved(version),
                integrity: privateReferences ? oldIntegrity : payload.npmIntegrity,
                dependencies: {}
            }
        }
    };
    fs.writeFileSync(path.join(frontend, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    fs.writeFileSync(path.join(frontend, 'package-lock.json'), `${JSON.stringify(lockfile, null, 4)}\n`);
    fs.mkdirSync(path.join(directory, 'config/dependencies'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'config/dependencies/update-surface.json'), `${JSON.stringify(preMigrationCatalog(), null, 4)}\n`);
    fs.writeFileSync(path.join(directory, 'renovate.json5'), `${JSON.stringify({ packageRules: [] }, null, 4)}\n`);
    if (privateReferences)
    {
        fs.writeFileSync(path.join(directory, '.npmrc'), `@ozwasyd:registry=${privateRegistryOrigin}\n//${privateRegistryHost}/:_authToken=\${${privatePackageToken}}\n`);
        fs.writeFileSync(path.join(frontend, '.npmrc'), `registry=${PUBLIC_NPM_REGISTRY}\n@ozwasyd:registry=${privateRegistryOrigin}\n`);
        fs.mkdirSync(path.join(directory, 'ops/docker'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'ops/docker/Dockerfile'), `RUN --mount=type=secret,id=${privateDockerSecret} echo ${privateProviderName}\n`);
        fs.mkdirSync(path.join(directory, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'tools/build.sh'), `RequireNonEmptyEnv ${privatePackageToken}\n`);
        fs.writeFileSync(path.join(directory, 'README.md'), `Install from ${privateProviderName} with ${privatePackageToken}.\n`);
    }

    execFileSync('git', ['init', '--initial-branch=master'], { cwd: directory, stdio: 'ignore' });
    git(directory, ['config', 'user.name', 'FsusBlog fixture']);
    git(directory, ['config', 'user.email', 'fixture@fsusblog.invalid']);
    git(directory, ['add', '.']);
    git(directory, ['commit', '-m', 'fixture before migration']);

    let migrationPatchSha256;
    if (privateReferences)
    {
        const retiredFiles = [
            '.npmrc',
            'README.md',
            'ops/docker/Dockerfile',
            'src/frontend/.npmrc',
            'tools/build.sh'
        ];
        const snapshots = new Map(retiredFiles.map((file) => [file, fs.readFileSync(path.join(directory, file))]));
        for (const file of retiredFiles)
        {
            fs.unlinkSync(path.join(directory, file));
        }
        const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], {
            cwd: directory,
            maxBuffer: 4 * 1024 * 1024
        });
        for (const [file, contents] of snapshots)
        {
            fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
            fs.writeFileSync(path.join(directory, file), contents);
        }
        const patchFile = path.join(directory, FSUSUI_PUBLIC_NPM_MIGRATION_PATCH);
        fs.mkdirSync(path.dirname(patchFile), { recursive: true });
        const patchArchive = gzipSync(patch);
        fs.writeFileSync(patchFile, patchArchive);
        git(directory, ['add', FSUSUI_PUBLIC_NPM_MIGRATION_PATCH]);
        git(directory, ['commit', '--amend', '--no-edit']);
        migrationPatchSha256 = sha256(patchArchive);
    }
    return { manifest, lockfile, migrationPatchSha256 };
}

function fakePublicLockGenerator(payload)
{
    return async ({ cwd, env, args }) =>
    {
        assert.equal(env.npm_config_registry, PUBLIC_NPM_REGISTRY);
        assert.equal(env[privatePackageToken], undefined);
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
    assert.equal(calls[0][2].draft, false);
    for (const value of [
        current.payload.sourceCommit,
        current.payload.releaseTag,
        current.payload.candidateSha256,
        current.payload.candidateManifestSha256,
        current.payload.npmTarballSha256,
        current.payload.crossGateReceiptSha256,
        current.payload.publishRunId,
        current.receipt.receiptSha256
    ])
    {
        assert.ok(calls[0][2].body.includes(value));
    }

    const createCalls = [];
    const createApi = {
        async listOpenPullRequests()
        {
            return [];
        },
        async updatePullRequest()
        {
            assert.fail('new release train must not update a missing PR');
        },
        async createPullRequest(body)
        {
            createCalls.push(['create', body]);
            return {
                number: 43,
                node_id: 'PR_node_43',
                head: { ref: body.head },
                base: { ref: body.base },
                ...body
            };
        },
        async enableAutoMerge(nodeId)
        {
            createCalls.push(['automerge', nodeId]);
        }
    };
    const created = await ensureSingleReleaseTrainPullRequest({
        api: createApi,
        receipt: current.receipt,
        baseBranch: 'master'
    });
    assert.equal(createCalls.filter(([operation]) => operation === 'create').length, 1);
    assert.equal(created.head, RELEASE_TRAIN_BRANCH);
    assert.equal(created.base, 'master');
    assert.equal(created.draft, false);
    assert.deepEqual(createCalls.at(-1), ['automerge', 'PR_node_43']);
    assert.throws(() => selectReleaseTrainPullRequest([existing, existing], 'master'), /multiple open/u);
    assert.throws(() => selectReleaseTrainPullRequest([{ ...existing, head: { ref: 'other-branch' } }], 'master'), /another open PR/u);
});

test('major regeneration failure keeps package state and first-migration wiring unchanged', async (t) =>
{
    const fixture = await registryFixture(t, '2.0.0');
    const directory = temporaryRoot(t);
    writeConsumerFixture(directory, { payload: fixture.payload });
    const files = [
        '.npmrc',
        'src/frontend/.npmrc',
        'src/frontend/package.json',
        'src/frontend/package-lock.json'
    ];
    const before = new Map(files.map((file) => [file, fs.readFileSync(path.join(directory, file))]));

    await assert.rejects(
        applyReleaseUpdate({
            repository: directory,
            receipt: fixture.receipt,
            runNpm: async () =>
            {
                throw new Error('major migration required');
            }
        }),
        /public npm lock regeneration failed/u
    );

    for (const [file, contents] of before)
    {
        assert.deepEqual(fs.readFileSync(path.join(directory, file)), contents);
    }
    assert.equal(scanPrivateFsusuiReferences(directory).clean, false);
});

test('first verified migration is atomic, removes private wiring, and is idempotent', async (t) =>
{
    const fixture = await registryFixture(t);
    const directory = temporaryRoot(t);
    const { migrationPatchSha256 } = writeConsumerFixture(directory, { payload: fixture.payload });
    const beforeLock = fs.readFileSync(path.join(directory, 'src/frontend/package-lock.json'));
    const plan = await migrateVerifiedFsusuiRelease({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: fakePublicLockGenerator(fixture.payload),
        migrationPatchSha256
    });
    assert.equal(plan.action, 'migrated');
    assert.equal(plan.migration, 'first-public-npm');
    assert.equal(plan.verified, true);
    assert.ok(plan.changedFiles.includes('src/frontend/package-lock.json'));
    assert.ok(plan.changedFiles.includes('config/dependencies/update-surface.json'));
    assert.ok(plan.changedFiles.includes('renovate.json5'));
    assert.equal(scanPrivateFsusuiReferences(directory).clean, true);
    assert.equal(PRIVATE_REFERENCE_MARKERS.some((marker) => fs.existsSync(path.join(directory, '.npmrc')) && fs.readFileSync(path.join(directory, '.npmrc'), 'utf8').includes(marker)), false);
    assert.equal(fs.existsSync(path.join(directory, '.npmrc')), false);
    assert.equal(assertFsusuiManagerState(JSON.parse(fs.readFileSync(path.join(directory, 'config/dependencies/update-surface.json'), 'utf8')), 'post-migration').phase, 'post-migration');
    const delegatedRenovate = JSON.parse(fs.readFileSync(path.join(directory, 'renovate.json5'), 'utf8'));
    assertFsusuiReleaseTrainRenovateDelegation(delegatedRenovate, fixture.payload.version);
    assert.equal(delegatedRenovate.packageRules.at(-1).allowedVersions, fixture.payload.version);
    assert.notEqual(delegatedRenovate.packageRules.at(-1).enabled, false);
    assert.throws(() => assertFsusuiReleaseTrainRenovateDelegation({
        packageRules: [{ ...delegatedRenovate.packageRules[0], matchPackageNames: [PACKAGE_NAME, 'other-package'] }]
    }), /match only/u);
    assert.throws(() => assertFsusuiReleaseTrainRenovateDelegation({
        packageRules: [{ ...delegatedRenovate.packageRules[0], matchFileNames: ['src/frontend/package.json'] }]
    }), /ignoreDeps or path ignores/u);
    assert.throws(() => assertFsusuiReleaseTrainRenovateDelegation({
        packageRules: [{ ...delegatedRenovate.packageRules.at(-1), enabled: false }]
    }), /permanent enabled:false/u);
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

test('first migration rejects a changed baseline or unsealed patch before repository writes', async (t) =>
{
    const fixture = await registryFixture(t);
    const directory = temporaryRoot(t);
    const { migrationPatchSha256 } = writeConsumerFixture(directory, { payload: fixture.payload });
    const protectedFiles = [
        '.npmrc',
        FSUSUI_PUBLIC_NPM_MIGRATION_PATCH,
        'src/frontend/package.json',
        'src/frontend/package-lock.json'
    ];
    const before = new Map(protectedFiles.map((file) => [file, fs.readFileSync(path.join(directory, file))]));

    await assert.rejects(migrateVerifiedFsusuiRelease({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: fakePublicLockGenerator(fixture.payload),
        migrationPatchSha256: '0'.repeat(64)
    }), /patch digest mismatch/u);
    for (const [file, contents] of before)
    {
        assert.deepEqual(fs.readFileSync(path.join(directory, file)), contents);
    }

    fs.appendFileSync(path.join(directory, 'README.md'), 'baseline drift\n');
    await assert.rejects(migrateVerifiedFsusuiRelease({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: fakePublicLockGenerator(fixture.payload),
        migrationPatchSha256
    }), /clean Git worktree/u);
    for (const [file, contents] of before)
    {
        assert.deepEqual(fs.readFileSync(path.join(directory, file)), contents);
    }
});

test('checked-in migration patch produces a structurally valid clean checkout transition', async (t) =>
{
    const fixture = await registryFixture(t);
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-production-migration-'));
    const repository = path.join(container, 'repository');
    execFileSync('git', ['worktree', 'add', '--detach', repository, 'HEAD'], {
        cwd: repositoryRoot,
        stdio: 'ignore'
    });
    t.after(() =>
    {
        execFileSync('git', ['worktree', 'remove', '--force', repository], {
            cwd: repositoryRoot,
            stdio: 'ignore'
        });
        fs.rmSync(container, { recursive: true, force: true });
    });

    const plan = await migrateVerifiedFsusuiRelease({
        repository,
        receipt: fixture.receipt,
        runNpm: fakePublicLockGenerator(fixture.payload)
    });
    assert.equal(plan.action, 'migrated');
    assert.equal(scanPrivateFsusuiReferences(repository).clean, true);
    assert.equal(fs.existsSync(path.join(repository, FSUSUI_PUBLIC_NPM_MIGRATION_PATCH)), false);
    const actualFiles = git(repository, ['diff', '--name-only']).split('\n').filter(Boolean).sort();
    assert.deepEqual(actualFiles, [...plan.changedFiles].sort());
    git(repository, ['diff', '--check']);

    for (const file of actualFiles)
    {
        const absolute = path.join(repository, file);
        if (!fs.existsSync(absolute))
        {
            continue;
        }
        if (file.endsWith('.mjs'))
        {
            execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' });
        }
        else if (file.endsWith('.sh'))
        {
            execFileSync('bash', ['-n', absolute], { stdio: 'pipe' });
        }
    }
    JSON.parse(fs.readFileSync(path.join(repository, 'config/application/backend-configuration-contract.json'), 'utf8'));
    const dockerfile = fs.readFileSync(path.join(repository, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
    const frontendStage = dockerfile.slice(
        dockerfile.indexOf('FROM node-runtime-musl AS frontend-build'),
        dockerfile.indexOf('FROM base AS final')
    );
    assert.match(frontendStage, /RUN npm ci[\s\S]*?--fetch-retries=0/u);
    assert.doesNotMatch(frontendStage, /_authToken|--mount=type=secret/u);
});

test('release train automatically performs the first public migration from sealed receipt and repository state', async (t) =>
{
    const fixture = await registryFixture(t);
    const directory = temporaryRoot(t);
    const { migrationPatchSha256 } = writeConsumerFixture(directory, { payload: fixture.payload });

    const first = await applyVerifiedReleaseTrain({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: fakePublicLockGenerator(fixture.payload),
        migrationPatchSha256
    });
    assert.equal(first.firstPublicNpmMigration, true);
    assert.equal(first.plan.action, 'migration');
    assert.equal(first.plan.version, fixture.payload.version);
    assert.equal(scanPrivateFsusuiReferences(directory).clean, true);

    const repeat = await applyVerifiedReleaseTrain({
        repository: directory,
        receipt: fixture.receipt,
        runNpm: async () =>
        {
            throw new Error('same migrated version must not regenerate the lockfile');
        }
    });
    assert.equal(repeat.firstPublicNpmMigration, false);
    assert.equal(repeat.plan.action, 'idempotent');
});

test('local release-train protocol binds each candidate through receipt, public lockfile, and one evolving PR', async (t) =>
{
    const firstFixture = await registryFixture(t, packageVersion);
    const deterministicRepeat = await registryFixture(t, packageVersion);
    const nextFixture = await registryFixture(t, '1.5.3');
    assert.equal(firstFixture.receipt.receiptSha256, deterministicRepeat.receipt.receiptSha256);
    assert.deepEqual(Object.keys(firstFixture.payload).sort(), [
        'candidateManifestSha256', 'candidateSha256', 'crossGateReceiptSha256', 'distTag', 'npmIntegrity',
        'npmTarballSha256', 'package', 'publishRunId', 'registry', 'releaseTag', 'schemaVersion',
        'sourceCommit', 'sourceRepository', 'version'
    ]);

    const directory = temporaryRoot(t);
    const { migrationPatchSha256 } = writeConsumerFixture(directory, { payload: firstFixture.payload });
    const first = await applyVerifiedReleaseTrain({
        repository: directory,
        receipt: firstFixture.receipt,
        runNpm: fakePublicLockGenerator(firstFixture.payload),
        migrationPatchSha256
    });
    assert.equal(first.plan.action, 'migration');
    assert.equal(first.firstPublicNpmMigration, true);
    assertPublicReleaseLock(JSON.parse(fs.readFileSync(path.join(directory, 'src/frontend/package-lock.json'), 'utf8')), firstFixture.payload);

    const operations = [];
    let pullRequest = null;
    const api = {
        async listOpenPullRequests()
        {
            return pullRequest ? [pullRequest] : [];
        },
        async createPullRequest(body)
        {
            operations.push(['create', body]);
            pullRequest = { number: 1986, node_id: 'PR_1986', ...body, head: { ref: body.head }, base: { ref: body.base } };
            return pullRequest;
        },
        async updatePullRequest(number, body)
        {
            operations.push(['update', number, body]);
            pullRequest = { ...pullRequest, ...body };
            return pullRequest;
        },
        async enableAutoMerge(nodeId)
        {
            operations.push(['automerge', nodeId]);
        }
    };
    await ensureSingleReleaseTrainPullRequest({ api, receipt: firstFixture.receipt, baseBranch: 'master', firstPublicNpmMigration: true });

    const next = await applyVerifiedReleaseTrain({
        repository: directory,
        receipt: nextFixture.receipt,
        runNpm: fakePublicLockGenerator(nextFixture.payload)
    });
    assert.equal(next.plan.action, 'upgrade');
    assert.equal(next.firstPublicNpmMigration, false);
    assertPublicReleaseLock(JSON.parse(fs.readFileSync(path.join(directory, 'src/frontend/package-lock.json'), 'utf8')), nextFixture.payload);
    const renovate = JSON.parse(fs.readFileSync(path.join(directory, 'renovate.json5'), 'utf8'));
    assertFsusuiReleaseTrainRenovateDelegation(renovate, nextFixture.payload.version);
    await ensureSingleReleaseTrainPullRequest({ api, receipt: nextFixture.receipt, baseBranch: 'master' });

    assert.equal(operations.filter(([operation]) => operation === 'create').length, 1);
    assert.equal(operations.filter(([operation]) => operation === 'update').length, 1);
    assert.equal(pullRequest.head.ref, RELEASE_TRAIN_BRANCH);
    assert.equal(pullRequest.title, `deps: update ${PACKAGE_NAME} to ${nextFixture.payload.version}`);
    assert.ok(pullRequest.body.includes(nextFixture.receipt.receiptSha256));
    assert.ok(pullRequest.body.includes(nextFixture.payload.candidateSha256));
    assert.ok(pullRequest.body.includes(nextFixture.payload.npmTarballSha256));
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
