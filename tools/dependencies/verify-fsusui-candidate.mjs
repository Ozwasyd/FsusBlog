import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readFsusuiTarballManifest } from './verify-fsusui-release-event.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const packageName = '@ozwasyd/element-plus';
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function check(value, message) {
    if (!value) {
        throw new Error(`FsusUI candidate: ${message}`);
    }
}

function npmTooling() {
    const npmPath = process.env.npm_execpath || (process.env.PATH ?? '').split(path.delimiter)
        .map((directory) => path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'))
        .find((candidate) => fs.existsSync(candidate));
    check(npmPath, 'npm executable is required');
    const npmCli = fs.realpathSync(npmPath);
    const require = createRequire(npmCli);
    // These are npm's own spec parsers, not global runtime packages consumed by the fixture.
    return { semver: require('semver'), packageArgument: require('npm-package-arg'), npmCli };
}

export function resolveCandidateInput(args, env = process.env) {
    check(args.length === 0 || (args.length === 2 && args[0] === '--tarball'), 'usage: --tarball /absolute/path/package.tgz');
    const values = [args[1], env.FSUSBLOG_FSUSUI_CANDIDATE].filter((value) => value !== undefined);
    check(values.length > 0, '--tarball or FSUSBLOG_FSUSUI_CANDIDATE is required');
    const files = values.map((value) => {
        check(typeof value === 'string' && path.isAbsolute(value) && value.endsWith('.tgz'), 'candidate must be an absolute .tgz file');
        const resolved = path.resolve(value);
        let stat;
        try {
            stat = fs.lstatSync(resolved);
        } catch {
            throw new Error('FsusUI candidate: tarball does not exist');
        }
        check(stat.isFile() && !stat.isSymbolicLink(), 'tarball must be a regular file, not a symlink/directory');
        check(stat.size > 0 && stat.size <= 128 * 1024 * 1024, 'tarball size must be between 1 byte and 128 MiB');
        const parent = fs.realpathSync(path.dirname(resolved));
        const canonical = path.join(parent, path.basename(resolved));
        check(fs.realpathSync(resolved) === canonical, 'tarball symlink path escape');
        return canonical;
    });
    check(files.every((file) => file === files[0]), 'CLI/environment tarball paths disagree');
    return files[0];
}

export function validateCandidatePackage(manifest, frontendManifest, lockfile) {
    const { semver, packageArgument } = npmTooling();
    check(manifest?.name === packageName, 'package.name must be @ozwasyd/element-plus');
    check(typeof manifest.version === 'string' && semver.valid(manifest.version) === manifest.version, 'package.version must be valid semver');
    for (const section of dependencySections) {
        const dependencies = manifest[section] ?? {};
        check(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies), `package.${section} must be an object`);
        for (const [name, specifier] of Object.entries(dependencies)) {
            check(typeof specifier === 'string', `package.${section}.${name} specifier type`);
            let parsed;
            try {
                parsed = packageArgument.resolve(name, specifier);
            } catch {
                throw new Error(`FsusUI candidate: package.${section}.${name} invalid specifier (workspace/local/private dependency)`);
            }
            const target = parsed.type === 'alias' ? parsed.subSpec : parsed;
            check(['range', 'version'].includes(target?.type) && target.registry, `package.${section}.${name} must be a registry semver, not workspace/file/link/Git/URL`);
        }
    }
    check(!manifest.workspaces, 'package.workspaces must not be published');
    check(!manifest.publishConfig?.registry || manifest.publishConfig.registry === 'https://registry.npmjs.org/', 'package.publishConfig.registry must be public npm');
    const vue = lockfile.packages?.['node_modules/vue']?.version;
    const peer = manifest.peerDependencies?.vue;
    check(typeof peer === 'string' && semver.validRange(peer), 'package.peerDependencies.vue must exist with a valid range');
    check(semver.valid(vue) && semver.satisfies(vue, frontendManifest.dependencies?.vue ?? '') && semver.satisfies(vue, peer), 'package.peerDependencies.vue does not satisfy locked FsusBlog Vue');
    return { name: manifest.name, version: manifest.version, vueVersion: vue };
}

export function assertOtherDependencyIdentities(beforeManifest, beforeLock, afterManifest, afterLock) {
    for (const section of dependencySections) {
        const before = { ...beforeManifest[section] };
        const after = { ...afterManifest[section] };
        delete before[packageName];
        delete after[packageName];
        assert.deepEqual(after, before, `candidate changed other direct ${section} specifiers`);
        for (const name of Object.keys(before)) {
            const location = `node_modules/${name}`;
            assert.deepEqual(afterLock.packages?.[location], beforeLock.packages?.[location], `candidate changed direct dependency lock identity: ${name}`);
        }
    }
}

function repositoryFiles(repository) {
    const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repository, maxBuffer: 32 * 1024 * 1024 });
    return [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort();
}

function fileIdentity(file) {
    if (!fs.existsSync(file)) {
        return 'missing';
    }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
        return `link:${fs.readlinkSync(file)}`;
    }
    return `${stat.mode}:${sha256(fs.readFileSync(file))}`;
}

function nodeModuleFiles(directory) {
    if (!fs.existsSync(directory)) {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? nodeModuleFiles(file) : [file];
    });
}

export function snapshotCandidateSource(repository) {
    const files = new Set(repositoryFiles(repository).map((file) => path.join(repository, file)));
    for (const file of ['.npmrc', 'src/frontend/.npmrc', ...nodeModuleFiles(path.join(repository, 'src/frontend/node_modules'))]) {
        files.add(path.resolve(repository, file));
    }
    return Object.fromEntries([...files].sort().map((file) => [path.relative(repository, file), fileIdentity(file)]));
}

export function assertCandidateSourceUnchanged(repository, snapshot) {
    assert.deepEqual(snapshotCandidateSource(repository), snapshot, 'candidate modified original worktree files or node_modules');
}

function copyConsumer(repository, fixture) {
    for (const file of repositoryFiles(repository)) {
        if (path.basename(file) === '.npmrc') {
            continue;
        }
        const source = path.join(repository, file);
        if (!fs.existsSync(source)) {
            continue;
        }
        check(!fs.lstatSync(source).isSymbolicLink(), `source symlink is not allowed in isolated consumer: ${file}`);
        const target = path.join(fixture, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    }
    const wasmRoot = path.join(repository, 'src/frontend/public/wasm');
    if (fs.existsSync(wasmRoot)) {
        fs.cpSync(wasmRoot, path.join(fixture, 'src/frontend/public/wasm'), { recursive: true });
    }
}

export function candidateEnvironment(fixture, sourceCommit, sourceEnv = process.env) {
    const env = {};
    for (const key of [
        'PATH',
        'SystemRoot',
        'COMSPEC',
        'PATHEXT',
        'LANG',
        'LC_ALL',
        'EMSDK',
        'EMSDK_NODE',
        'EMSDK_PYTHON',
        'EMSDK_QUIET',
        'FSUSBLOG_PYTHON',
        'WASM_BUILD_JOBS'
    ]) {
        if (sourceEnv[key] !== undefined) {
            env[key] = sourceEnv[key];
        }
    }
    if (env.PATH) {
        env.PATH = env.PATH.split(path.delimiter).filter((entry) => !entry.replaceAll('\\', '/').includes('/node_modules/')).join(path.delimiter);
    }
    return {
        ...env,
        HOME: fixture,
        USERPROFILE: fixture,
        TMPDIR: path.join(fixture, '.tmp'),
        TEMP: path.join(fixture, '.tmp'),
        TMP: path.join(fixture, '.tmp'),
        npm_config_userconfig: path.join(fixture, '.candidate-npmrc'),
        npm_config_globalconfig: path.join(fixture, '.candidate-global-npmrc'),
        npm_config_cache: path.join(fixture, '.npm'),
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_ignore_scripts: 'true',
        npm_config_offline: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        EM_CACHE: path.join(fixture, '.cache/emscripten'),
        FSUSBLOG_USE_LOCAL_FSUSUI: '0',
        FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit
    };
}

async function run(command, args, cwd, env) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' });
        let interrupted = false;
        let escalation;
        const stop = () => {
            interrupted = true;
            const kill = (signal) => {
                try {
                    if (process.platform === 'win32') {
                        child.kill(signal);
                    } else {
                        process.kill(-child.pid, signal);
                    }
                } catch (error) {
                    if (error.code !== 'ESRCH') {
                        reject(error);
                    }
                }
            };
            kill('SIGTERM');
            escalation = setTimeout(() => kill('SIGKILL'), 5000);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        const cleanup = () => {
            clearTimeout(escalation);
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
        };
        child.on('error', (error) => { cleanup(); reject(error); });
        child.on('close', (code, signal) => {
            cleanup();
            if (code === 0 && !interrupted) {
                resolve();
            } else {
                reject(new Error(`FsusUI candidate command failed (${interrupted ? 'interrupted' : code ?? signal}): ${path.basename(command)} ${args.join(' ')}`));
            }
        });
    });
}

function assertPublicLock(lock, candidatePath) {
    for (const [location, entry] of Object.entries(lock.packages ?? {})) {
        if (!entry.resolved) {
            continue;
        }
        if (location === `node_modules/${packageName}`) {
            check(entry.resolved.startsWith('file:')
                && path.resolve(path.dirname(candidatePath), 'src/frontend', entry.resolved.slice(5)) === candidatePath,
            'lockfile candidate must resolve to the isolated tarball');
        } else {
            check(entry.resolved.startsWith('https://registry.npmjs.org/'), `lockfile contains non-public/local dependency: ${location}`);
        }
    }
}

function readCandidateBytes(candidatePath) {
    const fd = fs.openSync(candidatePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
        const stat = fs.fstatSync(fd);
        check(stat.isFile() && stat.size > 0 && stat.size <= 128 * 1024 * 1024, 'tarball changed before reading');
        bytes = fs.readFileSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    return bytes;
}

export function verifyCandidateBoundaryInput(repository, env = process.env) {
    const candidatePath = resolveCandidateInput([], env);
    check(candidatePath === path.join(fs.realpathSync(repository), 'candidate.tgz'), 'boundary candidate must belong to this isolated consumer');
    check(/^[a-f0-9]{64}$/.test(env.FSUSBLOG_FSUSUI_CANDIDATE_SHA256 ?? ''), 'boundary candidate SHA-256 context is required');
    const bytes = readCandidateBytes(candidatePath);
    check(sha256(bytes) === env.FSUSBLOG_FSUSUI_CANDIDATE_SHA256, 'boundary candidate SHA-256 mismatch');
    const frontend = path.join(repository, 'src/frontend');
    const manifest = JSON.parse(fs.readFileSync(path.join(frontend, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(frontend, 'package-lock.json'), 'utf8'));
    const candidateManifest = readFsusuiTarballManifest(bytes);
    const identity = validateCandidatePackage(candidateManifest, manifest, lock);
    for (const specifier of [manifest.dependencies?.[packageName], lock.packages?.['']?.dependencies?.[packageName], lock.packages?.[`node_modules/${packageName}`]?.resolved]) {
        check(typeof specifier === 'string' && specifier.startsWith('file:')
            && path.resolve(frontend, specifier.slice(5)) === candidatePath, 'boundary manifest/lock must resolve to the same candidate');
    }
    const entry = lock.packages[`node_modules/${packageName}`];
    check(!entry.link && entry.version === identity.version
        && entry.integrity === `sha512-${createHash('sha512').update(bytes).digest('base64')}`, 'boundary candidate lock version/integrity mismatch');
    assertPublicLock(lock, candidatePath);
    const installedRoot = path.join(frontend, 'node_modules', packageName);
    check(fs.realpathSync(installedRoot) === installedRoot, 'boundary installed candidate must not be a link');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')), candidateManifest,
        'boundary installed manifest differs from candidate');
    return identity;
}

export async function verifyFsusuiCandidate(args, { repository = root, env = process.env, report = console.log } = {}) {
    const candidatePath = resolveCandidateInput(args, env);
    const bytes = readCandidateBytes(candidatePath);
    const frontend = path.join(repository, 'src/frontend');
    const manifest = JSON.parse(fs.readFileSync(path.join(frontend, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(frontend, 'package-lock.json'), 'utf8'));
    const candidateManifest = readFsusuiTarballManifest(bytes);
    const identity = { ...validateCandidatePackage(candidateManifest, manifest, lock), sha256: sha256(bytes) };
    report(JSON.stringify(identity));
    const snapshot = snapshotCandidateSource(repository);
    const tempRoot = path.join(repository, '.tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    execFileSync('git', ['check-ignore', '-q', '.tmp/fsusui-candidate-fixture'], { cwd: repository });
    const fixture = fs.mkdtempSync(path.join(tempRoot, 'fsusui-candidate-'));
    let error;
    const gates = [];
    try {
        copyConsumer(repository, fixture);
        fs.mkdirSync(path.join(fixture, '.tmp'), { recursive: true });
        fs.writeFileSync(path.join(fixture, '.candidate-npmrc'), '');
        fs.writeFileSync(path.join(fixture, '.candidate-global-npmrc'), '');
        const sourceCache = env.FSUSBLOG_FSUSUI_CANDIDATE_NPM_CACHE ?? path.join(os.homedir(), '.npm');
        const cache = path.join(sourceCache, '_cacache');
        if (fs.existsSync(cache)) {
            fs.cpSync(cache, path.join(fixture, '.npm/_cacache'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
        }
        const isolatedCandidate = path.join(fixture, 'candidate.tgz');
        fs.writeFileSync(isolatedCandidate, bytes);
        const isolatedFrontend = path.join(fixture, 'src/frontend');
        const candidateSpecifier = `file:${isolatedCandidate}`;
        const isolatedManifest = structuredClone(manifest);
        isolatedManifest.dependencies[packageName] = candidateSpecifier;
        const isolatedLock = structuredClone(lock);
        isolatedLock.packages[''].dependencies[packageName] = candidateSpecifier;
        isolatedLock.packages[`node_modules/${packageName}`] = {
            version: identity.version,
            resolved: candidateSpecifier,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
            ...Object.fromEntries(['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines'].filter((key) => candidateManifest[key]).map((key) => [key, candidateManifest[key]]))
        };
        assertPublicLock(isolatedLock, isolatedCandidate);
        fs.writeFileSync(path.join(isolatedFrontend, 'package.json'), `${JSON.stringify(isolatedManifest, null, 4)}\n`);
        fs.writeFileSync(path.join(isolatedFrontend, 'package-lock.json'), `${JSON.stringify(isolatedLock, null, 4)}\n`);
        const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
        const childEnv = candidateEnvironment(fixture, sourceCommit);
        childEnv.FSUSBLOG_FSUSUI_CANDIDATE = isolatedCandidate;
        childEnv.FSUSBLOG_FSUSUI_CANDIDATE_SHA256 = identity.sha256;
        const npmCli = npmTooling().npmCli;
        await run(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], isolatedFrontend, childEnv);
        const resolvedLock = JSON.parse(fs.readFileSync(path.join(isolatedFrontend, 'package-lock.json'), 'utf8'));
        assertOtherDependencyIdentities(manifest, lock, JSON.parse(fs.readFileSync(path.join(isolatedFrontend, 'package.json'), 'utf8')), resolvedLock);
        assertPublicLock(resolvedLock, isolatedCandidate);
        const installedIdentity = resolvedLock.packages[`node_modules/${packageName}`];
        check(installedIdentity.version === identity.version && installedIdentity.integrity === isolatedLock.packages[`node_modules/${packageName}`].integrity,
            'lockfile candidate version/integrity changed');
        await run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], isolatedFrontend, childEnv);
        const installedPackageRoot = path.join(isolatedFrontend, 'node_modules', packageName);
        check(fs.realpathSync(installedPackageRoot) === installedPackageRoot, 'installed candidate must not be an external link');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installedPackageRoot, 'package.json'), 'utf8')), candidateManifest,
            'installed candidate manifest differs from the supplied tarball');
        const installedPackageIdentity = () => Object.fromEntries(nodeModuleFiles(installedPackageRoot)
            .map((file) => [path.relative(installedPackageRoot, file), fileIdentity(file)]));
        const packageSnapshot = installedPackageIdentity();
        const commands = [
            ['published-package-typecheck', process.execPath, [npmCli, 'run', 'typecheck:published-fsusui']],
            ['fsusui-export-boundary', process.execPath, [npmCli, 'run', 'check:fsusui-boundary']],
            ['frontend-production-build', process.execPath, [npmCli, 'run', 'build']],
            ['worker-wasm-package-path', process.execPath, [path.join(fixture, 'tools/dependencies/fsusui-candidate-package-smoke.mjs'), '--worker-wasm']],
            ['single-vue-runtime', process.execPath, [path.join(fixture, 'tools/dependencies/fsusui-candidate-package-smoke.mjs'), '--single-vue']]
        ];
        for (const [id, command, commandArgs] of commands) {
            verifyCandidateBoundaryInput(fixture, childEnv);
            check(sha256(fs.readFileSync(isolatedCandidate)) === identity.sha256, 'candidate bytes changed between gates');
            assert.deepEqual(installedPackageIdentity(), packageSnapshot, 'installed candidate changed between gates');
            await run(command, commandArgs, isolatedFrontend, childEnv);
            gates.push({ id, status: 'passed', candidateSha256: identity.sha256 });
        }
        assert.deepEqual(installedPackageIdentity(), packageSnapshot, 'final gate changed the installed candidate');
        check(sha256(fs.readFileSync(candidatePath)) === identity.sha256, 'original candidate bytes changed');
    } catch (failure) {
        error = failure;
    } finally {
        if (env.FSUSBLOG_KEEP_FSUSUI_CANDIDATE_FIXTURE === '1') {
            report(`FsusUI candidate fixture retained: ${fixture}`);
        } else {
            fs.rmSync(fixture, { recursive: true, force: true });
        }
        assertCandidateSourceUnchanged(repository, snapshot);
    }
    if (error) {
        throw error;
    }
    const receipt = { schema: 'fsusblog.fsusui-candidate-consumption.v1', ...identity, gates };
    report(JSON.stringify(receipt));
    return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await verifyFsusuiCandidate(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
