import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLocalFsusUiRepositoryRoot } from './fsusui-root.mjs';

const packageName = '@ozwasyd/element-plus';
const packageLocation = `node_modules/${packageName}`;
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const themeAssets = ['index.css', 'el-public-shell-critical.css', 'el-fsus-theme.css'];
const wasmAssets = ['ep_wasm.mjs', 'ep_wasm.wasm', 'markdown_basic.js', 'markdown_basic.wasm', 'markdown_simd.js', 'markdown_simd.wasm'];

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validatePublicTarball(entry, location)
{
    assert.notEqual(entry.link, true, `local install requires locked public npm records: ${location}`);
    const url = new URL(entry.resolved);
    assert.ok(url.origin === 'https://registry.npmjs.org' && !url.username && !url.password, `local install requires public npm: ${location}`);
    assert.match(entry.integrity ?? '', /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u, `locked integrity is missing: ${location}`);
}

function validateBundledParent(packages, location)
{
    let parent = location;
    while (parent.includes('/node_modules/'))
    {
        parent = parent.slice(0, parent.lastIndexOf('/node_modules/'));
        const record = packages[parent];
        assert.ok(record, `bundled parent is missing: ${parent}`);
        assert.notEqual(record.link, true, `bundled parent must be a locked package: ${parent}`);
        if (record.resolved !== undefined)
        {
            validatePublicTarball(record, parent);
            return;
        }
        assert.equal(record.inBundle, true, `bundled parent has no tarball owner: ${parent}`);
    }
    assert.fail(`bundled integrity owner is missing: ${location}`);
}

function sourceDependencyBindings({ manifest, lockfile })
{
    const dependencies = { ...lockfile.packages[packageLocation].dependencies, ...lockfile.packages[packageLocation].peerDependencies };
    const installNames = new Set();
    return Object.keys(dependencies).map(name =>
    {
        validatePackageName(name);
        const lockedLocation = lockedDependencyLocation(lockfile, name);
        const locked = lockfile.packages[lockedLocation];
        validatePackageName(locked.name ?? name);
        assert.match(locked.version ?? '', /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u, 'locked source version must be exact');
        const nested = lockedLocation !== `node_modules/${name}`;
        const installName = nested ? `fsusui-local-${name.replaceAll(/[^a-z0-9-]/gu, '-')}` : name;
        validatePackageName(installName);
        assert.equal(installNames.has(installName), false, 'source dependency alias collision');
        installNames.add(installName);
        if (nested)
        {
            assert.equal(lockfile.packages[`node_modules/${installName}`], undefined, 'source dependency alias collides with a locked package');
            for (const section of dependencySections)
            {
                assert.equal(manifest[section]?.[installName], undefined, 'source dependency alias collides with a declared package');
            }
        }
        return { name, lockedLocation, locked, installName, location: `node_modules/${installName}`, nested };
    });
}

function validatePackageName(name)
{
    assert.ok(typeof name === 'string' && name.length <= 214
        && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name), 'invalid source package name');
}

function resolveLockedChild(packages, parent, name)
{
    validatePackageName(name);
    let ancestor = parent;
    while (ancestor)
    {
        const candidate = `${ancestor}/node_modules/${name}`;
        if (Object.hasOwn(packages, candidate))
        {
            return candidate;
        }
        const marker = ancestor.lastIndexOf('/node_modules/');
        ancestor = marker >= 0 ? ancestor.slice(0, marker) : '';
    }
    const candidate = `node_modules/${name}`;
    assert.ok(Object.hasOwn(packages, candidate), `locked transitive dependency is missing: ${name}`);
    return candidate;
}

function copyPublicAliasClosure(original, projected, source, destination, ancestors = new Set())
{
    assert.ok(!ancestors.has(source) && ancestors.size < 32, 'cyclic or excessive source alias dependency closure');
    const record = original[source];
    validatePublicTarball(record, source);
    const next = new Set([...ancestors, source]);
    for (const name of Object.keys({ ...record.dependencies, ...record.optionalDependencies, ...record.peerDependencies }))
    {
        const child = resolveLockedChild(original, source, name);
        const relocated = `${destination}/node_modules/${name}`;
        assert.equal(projected[relocated], undefined, 'source dependency alias closure collision');
        projected[relocated] = structuredClone(original[child]);
        copyPublicAliasClosure(original, projected, child, relocated, next);
    }
}

/** Derive install-only inputs; all non-FsusUI lock records remain byte-value identical. */
export function projectLocalFsusUiInstall({ manifest, lockfile })
{
    assert.equal(lockfile.lockfileVersion, 3, 'local source install requires the current v3 lock');
    assert.ok(lockfile.packages?.[packageLocation], 'locked FsusUI package is missing');
    assert.ok(manifest.dependencies?.[packageName], 'direct FsusUI dependency is missing');
    assert.equal(lockfile.packages[packageLocation].version, manifest.dependencies[packageName], 'locked FsusUI version mismatch');
    for (const section of dependencySections)
    {
        assert.deepEqual(manifest[section] ?? {}, lockfile.packages['']?.[section] ?? {}, 'root dependency mismatch');
    }
    const projectedManifest = structuredClone(manifest);
    const projectedLock = structuredClone(lockfile);
    for (const section of dependencySections)
    {
        if (projectedManifest[section])
        {
            delete projectedManifest[section][packageName];
        }
        if (projectedLock.packages[''][section])
        {
            delete projectedLock.packages[''][section][packageName];
        }
    }
    delete projectedLock.packages[packageLocation];
    for (const [location, entry] of Object.entries(projectedLock.packages))
    {
        if (location === '')
        {
            continue;
        }
        assert.match(location, /^(?:node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)(?:\/node_modules\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)*$/u, 'invalid locked package location');
        assert.ok(!location.split('/').some(segment => segment === '.' || segment === '..'), 'invalid locked package location');
        for (const section of dependencySections)
        {
            assert.equal(entry[section]?.[packageName], undefined, `${location} still requires ${packageName}`);
            assert.ok(!Object.values(entry[section] ?? {}).some(specifier => /^npm:@ozwasyd\/element-plus(?:@|$)/u.test(specifier)), `${location} still requires an alias of ${packageName}`);
        }
        assert.notEqual(entry.link, true, `local install requires locked public npm records: ${location}`);
        if (entry.inBundle === true && entry.resolved === undefined)
        {
            // Every parent must exist; the covering public tarball must retain its SRI.
            validateBundledParent(projectedLock.packages, location);
            continue;
        }
        validatePublicTarball(entry, location);
    }
    // npm ci prunes unreachable records. Make the real source's locked public
    // dependencies reachable without installing or manufacturing a FsusUI package.
    for (const binding of sourceDependencyBindings({ manifest, lockfile }))
    {
        const { installName, locked, nested } = binding;
        const alreadyDeclared = dependencySections.some(section => projectedManifest[section]?.[installName] !== undefined);
        if (!alreadyDeclared)
        {
            const actualName = locked.name ?? binding.name;
            const specifier = actualName === installName ? locked.version : `npm:${actualName}@${locked.version}`;
            projectedManifest.dependencies[installName] = specifier;
            projectedLock.packages[''].dependencies[installName] = specifier;
        }
        if (nested)
        {
            projectedLock.packages[binding.location] = { ...structuredClone(locked), name: locked.name ?? binding.name };
            copyPublicAliasClosure(lockfile.packages, projectedLock.packages, binding.lockedLocation, binding.location);
        }
    }
    return { manifest: projectedManifest, lockfile: projectedLock };
}

function validateLocalSource(frontend, fsusui)
{
    const root = resolveLocalFsusUiRepositoryRoot({ override: fsusui, repositoryRoot: path.resolve(frontend, '../..') });
    assert.ok(fsusui && root, 'explicit FsusUI source is required');
    const canonical = fs.realpathSync(root);
    for (const asset of [
        'element-plus/package.json',
        'element-plus/index.ts',
        'icons-vue/src/index.ts',
        ...themeAssets.map(file => `theme-chalk/dist/${file}`),
        ...wasmAssets.map(file => `wasm/dist/${file}`)
    ])
    {
        const file = path.join(root, 'vue/packages', asset);
        assert.ok(fs.existsSync(file), `required local asset is missing: ${asset}`);
        const stat = fs.lstatSync(file);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0
            && fs.realpathSync(file).startsWith(`${canonical}${path.sep}`), `required local asset is invalid: ${asset}`);
    }
    const sourceManifest = readJson(path.join(root, 'vue/packages/element-plus/package.json'));
    assert.equal(sourceManifest.name, 'element-plus', 'named context must contain the real FsusUI source package');
    return root;
}

function originalInputs(frontend)
{
    return {
        manifest: readJson(path.join(frontend, 'package.json')),
        lockfile: readJson(path.join(frontend, 'package-lock.json'))
    };
}

/** Write a new transient npm-ci input directory, never the checked-in package files. */
export function prepareLocalFsusUiInstall({ frontend, fsusui, output })
{
    validateLocalSource(frontend, fsusui);
    assert.ok(output && !fs.existsSync(output), 'local install output already exists or is missing');
    const projected = projectLocalFsusUiInstall(originalInputs(frontend));
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'package.json'), `${JSON.stringify(projected.manifest, null, 4)}\n`, { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'package-lock.json'), `${JSON.stringify(projected.lockfile, null, 4)}\n`, { flag: 'wx' });
}

function lockedDependencyLocation(lockfile, name)
{
    const nested = `${packageLocation}/node_modules/${name}`;
    const location = Object.hasOwn(lockfile.packages, nested) ? nested : `node_modules/${name}`;
    assert.ok(lockfile.packages[location], `source dependency is not locked: ${name}`);
    return location;
}

function assertSourceVueIdentity(frontend, root, bindings)
{
    const consumer = createRequire(path.join(frontend, 'package.json'));
    const vuePackages = ['vue', '@vue/runtime-core', '@vue/runtime-dom', '@vue/reactivity', '@vue/shared'];
    const hosts = ['package.json', 'vue/package.json', 'vue/typings/env.d.ts', 'vue/typings/components.d.ts']
        .map(host => ({ host, file: path.join(root, host) }));
    for (const binding of bindings)
    {
        const manifest = fs.realpathSync(path.join(frontend, binding.location, 'package.json'));
        if (vuePackages.includes(binding.name))
        {
            assert.equal(manifest, fs.realpathSync(consumer.resolve(`${binding.name}/package.json`)),
                `independent source Vue identity at ${binding.location}: ${binding.name}`);
        }
        // Node follows the injected symlink to this real provider. Its nested
        // dependencies must share the family used by declarations and the app.
        hosts.push({ host: binding.location, file: manifest });
    }
    for (const { host, file } of hosts)
    {
        const source = createRequire(file);
        for (const name of vuePackages)
        {
            let sourceManifest;
            try
            {
                sourceManifest = source.resolve(`${name}/package.json`);
            }
            catch (error)
            {
                if (error.code === 'MODULE_NOT_FOUND')
                {
                    continue;
                }
                throw error;
            }
            const consumerManifest = consumer.resolve(`${name}/package.json`);
            assert.equal(fs.realpathSync(sourceManifest), fs.realpathSync(consumerManifest),
                `independent source Vue identity at ${host}: ${name}; use an isolated FsusUI source checkout for Blog consumption, not the standalone UI install`);
        }
    }
}

/** Verify the real public install and expose exact locked public dependencies to source aliases. */
export function verifyLocalFsusUiInstall({ frontend, fsusui })
{
    const root = validateLocalSource(frontend, fsusui);
    const original = originalInputs(frontend);
    projectLocalFsusUiInstall(original);
    assert.equal(fs.existsSync(path.join(frontend, packageLocation, 'package.json')), false, 'FsusUI registry package must not be installed in local mode');
    const sourceManifest = readJson(path.join(root, 'vue/packages/element-plus/package.json'));
    const lockedPackage = original.lockfile.packages[packageLocation];
    const bindings = sourceDependencyBindings(original);
    for (const [name, specifier] of Object.entries({ ...sourceManifest.dependencies, ...sourceManifest.peerDependencies }))
    {
        if (specifier.startsWith('workspace:'))
        {
            assert.match(name, /^@element-plus\/[a-z0-9-]+$/u, 'source workspace dependency must belong to FsusUI');
            assert.equal(readJson(path.join(root, 'vue/packages', name.split('/')[1], 'package.json')).name, name, `source workspace dependency is missing: ${name}`);
            continue;
        }
        const binding = bindings.find(candidate => candidate.name === name);
        assert.ok(binding, `source dependency is not locked: ${name}`);
        const { location, locked } = binding;
        assert.ok(specifier === lockedPackage.dependencies?.[name]
            || specifier === lockedPackage.peerDependencies?.[name]
            || specifier === locked.version, `source dependency differs from locked runtime input: ${name}`);
        const manifestFile = path.join(frontend, location, 'package.json');
        assert.ok(fs.existsSync(manifestFile), `installed locked dependency is missing: ${name}`);
        const installed = readJson(manifestFile);
        assert.equal(installed.version, locked.version, `installed locked dependency version differs: ${name}`);
        assert.equal(installed.name, locked.name ?? name, `installed locked dependency identity differs: ${name}`);
    }
    const destination = path.join(root, 'vue/packages/node_modules');
    assert.equal(fs.existsSync(destination), false, 'source package dependency directory already exists');
    // Link each original import name to the verified public install, including
    // version-conflicting dependencies installed under dedicated npm aliases.
    for (const binding of bindings)
    {
        const target = path.join(frontend, binding.location);
        const installed = readJson(path.join(target, 'package.json'));
        assert.equal(installed.version, binding.locked.version, `installed locked dependency version differs: ${binding.name}`);
        assert.equal(installed.name, binding.locked.name ?? binding.name, `installed locked dependency identity differs: ${binding.name}`);
    }
    // A standalone UI program resolves augmentations above packages/. Shadowing
    // only its component imports would split the Vue declarations and runtime.
    // The Docker/source consumer has no independent install at those hosts.
    assertSourceVueIdentity(frontend, root, bindings);
    for (const binding of bindings)
    {
        const link = path.join(destination, binding.name);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.join(frontend, binding.location), link, 'dir');
    }
}

function main(args)
{
    const command = args[0];
    assert.ok(['prepare', 'verify'].includes(command), 'usage: prepare-local-fsusui-install.mjs prepare|verify --frontend-root PATH --fsusui-root PATH [--output PATH]');
    const options = {};
    const flags = { '--frontend-root': 'frontend', '--fsusui-root': 'fsusui', '--output': 'output' };
    for (let index = 1; index < args.length; index += 2)
    {
        const key = flags[args[index]];
        assert.ok(key && args[index + 1] && !Object.hasOwn(options, key), 'unknown, duplicate or missing local install argument');
        options[key] = path.resolve(args[index + 1]);
    }
    assert.ok(options.frontend && options.fsusui, 'explicit frontend and FsusUI roots are required');
    if (command === 'prepare')
    {
        prepareLocalFsusUiInstall(options);
    }
    else
    {
        assert.equal(options.output, undefined, 'verify does not accept output');
        verifyLocalFsusUiInstall(options);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main(process.argv.slice(2));
}
