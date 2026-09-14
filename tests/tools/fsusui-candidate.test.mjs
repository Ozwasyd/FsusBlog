import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const {assertCandidateSourceUnchanged, assertOtherDependencyIdentities, candidateEnvironment, resolveCandidateInput, snapshotCandidateSource, validateCandidatePackage, verifyCandidateBoundaryInput, verifyFsusuiCandidate} = await import(new URL('../../tools/dependencies/verify-fsusui-candidate.mjs', import.meta.url));
const {verifySingleVue, verifyWorkerWasm} = await import(new URL('../../tools/dependencies/fsusui-candidate-package-smoke.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const name = '@ozwasyd/element-plus';
const sourceManifest = { dependencies: { [name]: '1.5.1', vue: '^3.5.33' } };
const sourceLock = {
    lockfileVersion: 3,
    packages: {
        '': { ...sourceManifest },
        'node_modules/vue': { version: '3.5.33', resolved: 'https://registry.npmjs.org/vue/-/vue-3.5.33.tgz', integrity: 'sha512-test' },
        [`node_modules/${name}`]: { version: '1.5.1' }
    }
};
const packageManifest = () => ({ name, version: '1.5.2', peerDependencies: { vue: '^3.5.0' } });

function write(directory, file, value)
{
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function temporary(t)
{
    const directory = path.join(root, '.tmp');
    fs.mkdirSync(directory, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(directory, 'candidate-tests-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    return fixture;
}

function tarball(directory, manifest = packageManifest())
{
    write(directory, 'archive/package/package.json', manifest);
    const file = path.join(directory, 'candidate.tgz');
    execFileSync('tar', ['-czf', file, '-C', path.join(directory, 'archive'), 'package'], { stdio: 'pipe' });
    return file;
}

function repositoryFixture(directory)
{
    const repository = path.join(directory, 'consumer-source');
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    write(repository, '.gitignore', '.tmp/\nnode_modules/\n');
    write(repository, 'src/frontend/package.json', sourceManifest);
    write(repository, 'src/frontend/package-lock.json', sourceLock);
    write(repository, '.npmrc', 'sentinel-original-config\n');
    write(repository, 'src/frontend/src/sentinel.ts', 'export const sentinel = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: repository });
    return repository;
}

function boundaryFixture(t, candidate = packageManifest())
{
    const directory = temporary(t);
    const file = tarball(directory, candidate);
    const bytes = fs.readFileSync(file);
    const manifest = structuredClone(sourceManifest);
    manifest.dependencies[name] = `file:${file}`;
    const lock = structuredClone(sourceLock);
    lock.packages[''] = structuredClone(manifest);
    lock.packages[`node_modules/${name}`] = {
        version: candidate.version,
        resolved: 'file:../../candidate.tgz',
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    };
    write(directory, 'src/frontend/package.json', manifest);
    fs.mkdirSync(path.join(directory, 'src/frontend/src'), { recursive: true });
    write(directory, 'src/frontend/package-lock.json', lock);
    write(directory, `src/frontend/node_modules/${name}/package.json`, candidate);
    return { directory, file, manifest, lock, env: {
        FSUSBLOG_FSUSUI_CANDIDATE: file,
        FSUSBLOG_FSUSUI_CANDIDATE_SHA256: createHash('sha256').update(bytes).digest('hex')
    } };
}

function runBoundary(fixture, env = fixture.env)
{
    const childEnv = { ...process.env, FSUSBLOG_FSUSUI_BOUNDARY_ROOT: fixture.directory };
    delete childEnv.FSUSBLOG_FSUSUI_CANDIDATE;
    delete childEnv.FSUSBLOG_FSUSUI_CANDIDATE_SHA256;
    const result = spawnSync(process.execPath, [path.join(root, 'tests/frontend/checks/static/check-fsusui-boundary.mjs')], {
        env: { ...childEnv, ...env }, encoding: 'utf8'
    });
    assert.equal(result.stderr, '', 'boundary subprocess must reach its diagnostic checks');
    return result;
}

test('boundary revalidates candidate bytes and legal semver without weakening other checks', (t) =>
{
    for (const version of ['1.5.2', '1.6.0-preview.1'])
    {
        const fixture = boundaryFixture(t, { ...packageManifest(), version });
        assert.equal(verifyCandidateBoundaryInput(fixture.directory, fixture.env).version, version);
        const result = runBoundary(fixture);
        assert.doesNotMatch(result.stdout, /fsusui-candidate:|fsusui-version:/);
        // The deliberately incomplete consumer still fails the other real boundary checks.
        assert.equal(result.status, 1);
        assert.match(result.stdout, /warnings=/);
    }
});

test('ordinary file dependencies and incomplete candidate environment do not bypass the normal pin', (t) =>
{
    const fixture = boundaryFixture(t);
    assert.match(runBoundary(fixture, {}).stdout, /fsusui-version:/);
    assert.match(runBoundary(fixture, { FSUSBLOG_FSUSUI_CANDIDATE: fixture.file }).stdout, /fsusui-candidate:/);
    assert.match(runBoundary(fixture, { FSUSBLOG_FSUSUI_CANDIDATE_SHA256: fixture.env.FSUSBLOG_FSUSUI_CANDIDATE_SHA256 }).stdout, /fsusui-candidate:/);
    fixture.manifest.dependencies[name] = '1.5.1';
    write(fixture.directory, 'src/frontend/package.json', fixture.manifest);
    assert.doesNotMatch(runBoundary(fixture, {}).stdout, /fsusui-version:/);
    fixture.manifest.dependencies[name] = '1.5.2';
    write(fixture.directory, 'src/frontend/package.json', fixture.manifest);
    assert.match(runBoundary(fixture, {}).stdout, /fsusui-version:/);
});

test('boundary rejects candidate, manifest, lock and installed identity mismatches', (t) =>
{
    const mutations = [
        (f) =>
        {
            f.env.FSUSBLOG_FSUSUI_CANDIDATE_SHA256 = '0'.repeat(64);
        },
        (f) =>
        {
            fs.appendFileSync(f.file, 'changed');
        },
        (f) =>
        {
            f.manifest.dependencies[name] = 'file:../../other.tgz';
        },
        (f) =>
        {
            f.lock.packages[''].dependencies[name] = '1.5.2';
        },
        (f) =>
        {
            f.lock.packages[`node_modules/${name}`].resolved = 'file:../../other.tgz';
        },
        (f) =>
        {
            f.lock.packages[`node_modules/${name}`].version = '1.5.3';
        },
        (f) =>
        {
            f.lock.packages[`node_modules/${name}`].integrity = 'sha512-wrong';
        },
        (f) =>
        {
            f.lock.packages[`node_modules/${name}`].link = true;
        },
        (f) =>
        {
            f.lock.packages['node_modules/vue'].version = '4.0.0';
        },
        (f) =>
        {
            write(f.directory, `src/frontend/node_modules/${name}/package.json`, { ...packageManifest(), version: '1.5.3' });
        }
    ];
    for (const mutate of mutations)
    {
        const fixture = boundaryFixture(t);
        mutate(fixture);
        write(fixture.directory, 'src/frontend/package.json', fixture.manifest);
        write(fixture.directory, 'src/frontend/package-lock.json', fixture.lock);
        assert.throws(() => verifyCandidateBoundaryInput(fixture.directory, fixture.env));
        const result = runBoundary(fixture);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /fsusui-candidate:/);
    }
    for (const candidate of [
        { ...packageManifest(), name: 'wrong-package' },
        { ...packageManifest(), version: 'latest' },
        { ...packageManifest(), peerDependencies: { vue: '^4.0.0' } }
    ])
    {
        const fixture = boundaryFixture(t, candidate);
        assert.throws(() => verifyCandidateBoundaryInput(fixture.directory, fixture.env));
        assert.match(runBoundary(fixture).stdout, /fsusui-candidate:/);
    }
});

test('local tgz CLI and environment must select exactly the same regular file', (t) =>
{
    const directory = temporary(t);
    const file = tarball(directory);
    const canonical = fs.realpathSync(file);
    assert.equal(resolveCandidateInput(['--tarball', file], {}), canonical);
    assert.equal(resolveCandidateInput([], { FSUSBLOG_FSUSUI_CANDIDATE: file }), canonical);
    assert.equal(resolveCandidateInput(['--tarball', file], { FSUSBLOG_FSUSUI_CANDIDATE: path.join(directory, '.', 'candidate.tgz') }), canonical);
    const aliasedRoot = path.join(directory, 'aliased-root');
    fs.symlinkSync(directory, aliasedRoot);
    assert.equal(resolveCandidateInput(['--tarball', path.join(aliasedRoot, 'candidate.tgz')], {}), canonical);
    const second = path.join(directory, 'second.tgz');
    fs.copyFileSync(file, second);
    assert.throws(() => resolveCandidateInput(['--tarball', file], { FSUSBLOG_FSUSUI_CANDIDATE: second }), /disagree/);
    for (const args of [[], ['--tarball'], ['--unknown', file], ['--tarball', file, '--tarball', file], ['--tarball', 'candidate.tgz'], ['--tarball', path.join(directory, 'absent.tgz')]])
    {
        assert.throws(() => resolveCandidateInput(args, {}), /required|usage|absolute|exist/);
    }
    fs.symlinkSync(file, path.join(directory, 'link.tgz'));
    assert.throws(() => resolveCandidateInput(['--tarball', path.join(directory, 'link.tgz')], {}), /regular file/);
    fs.mkdirSync(path.join(directory, 'directory.tgz'));
    assert.throws(() => resolveCandidateInput(['--tarball', path.join(directory, 'directory.tgz')], {}), /regular file/);
});

test('candidate semver and Vue peer use actual npm parsers against the exact locked Vue', () =>
{
    assert.deepEqual(validateCandidatePackage(packageManifest(), sourceManifest, sourceLock), { name, version: '1.5.2', vueVersion: '3.5.33' });
    assert.equal(validateCandidatePackage({ ...packageManifest(), version: '1.6.0-preview.1' }, sourceManifest, sourceLock).version, '1.6.0-preview.1');
    for (const version of ['latest', '01.5.2', 'v1.5.2', '1.5', 1])
    {
        assert.throws(() => validateCandidatePackage({ ...packageManifest(), version }, sourceManifest, sourceLock), /package.version/);
    }
    assert.throws(() => validateCandidatePackage({ ...packageManifest(), name: 'element-plus' }, sourceManifest, sourceLock), /package.name/);
    assert.throws(() => validateCandidatePackage({ ...packageManifest(), peerDependencies: {} }, sourceManifest, sourceLock), /peerDependencies.vue/);
    assert.throws(() => validateCandidatePackage({ ...packageManifest(), peerDependencies: { vue: '^4.0.0' } }, sourceManifest, sourceLock), /peerDependencies.vue/);
});

for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
{
    test(`candidate rejects workspace/local/Git/private protocols in ${section}`, () =>
    {
        for (const specifier of ['workspace:*', 'file:../sibling', 'link:../sibling', 'git+https://github.com/example/fixture.git', 'github:example/fixture', 'https://npm.pkg.github.com/fixture.tgz', 'https://registry.npmjs.org/fixture.tgz'])
        {
            const manifest = packageManifest();
            manifest[section] = { ...manifest[section], fixture: specifier };
            assert.throws(() => validateCandidatePackage(manifest, sourceManifest, sourceLock), new RegExp(section));
        }
    });
}

test('private publish registry and workspace root fail closed', () =>
{
    assert.throws(() => validateCandidatePackage({ ...packageManifest(), publishConfig: { registry: 'https://npm.pkg.github.com/' } }, sourceManifest, sourceLock), /publishConfig.registry/);
    assert.throws(() => validateCandidatePackage({ ...packageManifest(), workspaces: ['packages/*'] }, sourceManifest, sourceLock), /workspaces/);
});

test('other direct specifiers and lock identities cannot drift even to a compatible version', () =>
{
    const manifest = structuredClone(sourceManifest);
    const lock = structuredClone(sourceLock);
    manifest.dependencies[name] = 'file:/isolated/candidate.tgz';
    lock.packages[`node_modules/${name}`].version = '1.5.2';
    assert.doesNotThrow(() => assertOtherDependencyIdentities(sourceManifest, sourceLock, manifest, lock));
    manifest.dependencies.vue = '^3.5.34';
    assert.throws(() => assertOtherDependencyIdentities(sourceManifest, sourceLock, manifest, lock), /specifiers/);
    manifest.dependencies.vue = '^3.5.33';
    for (const key of ['version', 'resolved', 'integrity'])
    {
        const mutated = structuredClone(lock);
        mutated.packages['node_modules/vue'][key] = 'changed';
        assert.throws(() => assertOtherDependencyIdentities(sourceManifest, sourceLock, manifest, mutated), /lock identity/);
    }
});

test('child environment isolates configs/cache, forbids install scripts and disables alias consumption', () =>
{
    const env = candidateEnvironment('/isolated-consumer', 'a'.repeat(40));
    assert.equal(env.npm_config_ignore_scripts, 'true');
    assert.equal(env.npm_config_offline, 'true');
    assert.equal(env.FSUSBLOG_USE_LOCAL_FSUSUI, '0');
    assert.equal(env.npm_config_userconfig, '/isolated-consumer/.candidate-npmrc');
    assert.equal(env.npm_config_cache, '/isolated-consumer/.npm');
    assert.equal(env.GITHUB_PACKAGES_TOKEN, undefined);
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
    assert.equal(env.FSUSBLOG_LOCAL_FSUSUI_ROOT, undefined);
    assert.equal(env.FSUSBLOG_SKIP_ENSURE_WASM, undefined);
});

test('child environment carries only explicit native toolchain selectors', () =>
{
    const env = candidateEnvironment('/isolated-consumer', 'a'.repeat(40), {
        PATH: '/opt/emsdk/upstream/emscripten:/usr/bin',
        EMSDK: '/opt/emsdk',
        EMSDK_NODE: '/opt/emsdk/node/bin/node',
        EMSDK_PYTHON: '/opt/emsdk/python/bin/python3',
        FSUSBLOG_PYTHON: '/opt/emsdk/python/bin/python3',
        GITHUB_PACKAGES_TOKEN: 'must-not-cross-boundary'
    });
    assert.equal(env.EMSDK, '/opt/emsdk');
    assert.equal(env.EMSDK_NODE, '/opt/emsdk/node/bin/node');
    assert.equal(env.EMSDK_PYTHON, '/opt/emsdk/python/bin/python3');
    assert.equal(env.FSUSBLOG_PYTHON, '/opt/emsdk/python/bin/python3');
    assert.equal(env.GITHUB_PACKAGES_TOKEN, undefined);
});

test('original source, manifest, config and ignored node_modules mutations are detected', (t) =>
{
    const directory = temporary(t);
    const repository = repositoryFixture(directory);
    write(repository, 'src/frontend/node_modules/vue/sentinel', 'original');
    const snapshot = snapshotCandidateSource(repository);
    assert.doesNotThrow(() => assertCandidateSourceUnchanged(repository, snapshot));
    for (const file of ['src/frontend/src/sentinel.ts', 'src/frontend/package.json', 'src/frontend/package-lock.json', '.npmrc', 'src/frontend/node_modules/vue/sentinel'])
    {
        const location = path.join(repository, file);
        const original = fs.readFileSync(location);
        fs.appendFileSync(location, '\nchanged');
        assert.throws(() => assertCandidateSourceUnchanged(repository, snapshot), /original worktree/);
        fs.writeFileSync(location, original);
    }
});

test('non-tarball input fails before fixture creation or npm invocation', async (t) =>
{
    const directory = temporary(t);
    const repository = repositoryFixture(directory);
    write(directory, 'broken.tgz', 'not an archive');
    const before = snapshotCandidateSource(repository);
    await assert.rejects(verifyFsusuiCandidate(['--tarball', path.join(directory, 'broken.tgz')], { repository, env: {}, report()
    {} }), /tarball package/);
    assertCandidateSourceUnchanged(repository, before);
    assert.equal(fs.existsSync(path.join(repository, '.tmp')), false);
});

for (const keep of [false, true])
{
    test(`actual offline install failure preserves original source and ${keep ? 'explicitly retains' : 'removes'} its fixture`, async (t) =>
    {
        const directory = temporary(t);
        const repository = repositoryFixture(directory);
        const file = tarball(directory);
        const before = snapshotCandidateSource(repository);
        const messages = [];
        const env = { FSUSBLOG_FSUSUI_CANDIDATE_NPM_CACHE: path.join(directory, 'empty-cache'), ...(keep ? { FSUSBLOG_KEEP_FSUSUI_CANDIDATE_FIXTURE: '1' } : {}) };
        // The empty cache deliberately fails actual npm. No typecheck/build/worker gate is stubbed or claimed passed.
        await assert.rejects(verifyFsusuiCandidate(['--tarball', file], { repository, env, report: (message) => messages.push(message) }), /command failed/);
        assertCandidateSourceUnchanged(repository, before);
        assert.equal(JSON.parse(messages[0]).sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
        const fixtures = fs.readdirSync(path.join(repository, '.tmp'));
        assert.equal(fixtures.length, keep ? 1 : 0);
        assert.equal(messages.some((message) => message.startsWith('FsusUI candidate fixture retained:')), keep);
        if (keep)
        {
            const isolated = path.join(repository, '.tmp', fixtures[0]);
            assert.equal(fs.existsSync(path.join(isolated, '.npmrc')), false);
            assert.equal(fs.readFileSync(path.join(isolated, '.candidate-npmrc'), 'utf8'), '');
            assert.deepEqual(fs.readFileSync(path.join(isolated, 'candidate.tgz')), fs.readFileSync(file));
        }
    });
}

test('single Vue check rejects duplicate physical runtimes', (t) =>
{
    const directory = temporary(t);
    write(directory, 'package.json', { private: true });
    write(directory, 'node_modules/vue/package.json', { name: 'vue', version: '3.5.33' });
    write(directory, `node_modules/${name}/package.json`, packageManifest());
    assert.equal(verifySingleVue(directory).vuePath, path.join(directory, 'node_modules/vue'));
    write(directory, `node_modules/${name}/node_modules/vue/package.json`, { name: 'vue', version: '3.5.33' });
    assert.throws(() => verifySingleVue(directory), /exactly one Vue/);
});

test('worker smoke rejects missing public package instead of consuming adjacent source', async (t) =>
{
    const directory = temporary(t);
    write(directory, 'package.json', { private: true });
    await assert.rejects(verifyWorkerWasm(directory), /Cannot find module/);
});
