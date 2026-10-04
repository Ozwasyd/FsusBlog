import assert from 'node:assert/strict';
import fs from 'node:fs';
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

/** Verify the real public install and expose retained nested dependencies to source aliases. */
export function verifyLocalFsusUiInstall({ frontend, fsusui })
{
    const root = validateLocalSource(frontend, fsusui);
    const original = originalInputs(frontend);
    projectLocalFsusUiInstall(original);
    assert.equal(fs.existsSync(path.join(frontend, packageLocation, 'package.json')), false, 'FsusUI registry package must not be installed in local mode');
    const sourceManifest = readJson(path.join(root, 'vue/packages/element-plus/package.json'));
    const lockedPackage = original.lockfile.packages[packageLocation];
    for (const [name, specifier] of Object.entries({ ...sourceManifest.dependencies, ...sourceManifest.peerDependencies }))
    {
        if (specifier.startsWith('workspace:'))
        {
            assert.match(name, /^@element-plus\/[a-z0-9-]+$/u, 'source workspace dependency must belong to FsusUI');
            assert.equal(readJson(path.join(root, 'vue/packages', name.split('/')[1], 'package.json')).name, name, `source workspace dependency is missing: ${name}`);
            continue;
        }
        const location = lockedDependencyLocation(original.lockfile, name);
        const locked = original.lockfile.packages[location];
        assert.ok(specifier === lockedPackage.dependencies?.[name]
            || specifier === lockedPackage.peerDependencies?.[name]
            || specifier === locked.version, `source dependency differs from locked runtime input: ${name}`);
        const manifestFile = path.join(frontend, location, 'package.json');
        assert.ok(fs.existsSync(manifestFile), `installed locked dependency is missing: ${name}`);
        const installed = readJson(manifestFile);
        assert.equal(installed.version, locked.version, `installed locked dependency version differs: ${name}`);
        assert.equal(installed.name, locked.name ?? name, `installed locked dependency identity differs: ${name}`);
    }
    const nestedLocations = Object.keys(original.lockfile.packages).filter(location => location.startsWith(`${packageLocation}/node_modules/`));
    if (nestedLocations.length > 0)
    {
        for (const location of nestedLocations)
        {
            const manifestFile = path.join(frontend, location, 'package.json');
            assert.ok(fs.existsSync(manifestFile), `installed locked dependency is missing: ${location}`);
            const installed = readJson(manifestFile);
            assert.equal(installed.version, original.lockfile.packages[location].version, `installed locked dependency version differs: ${location}`);
            assert.equal(installed.name, original.lockfile.packages[location].name ?? location.split('/node_modules/').at(-1), `installed locked dependency identity differs: ${location}`);
        }
        const destination = path.join(root, 'vue/packages/node_modules');
        assert.equal(fs.existsSync(destination), false, 'source package dependency directory already exists');
        fs.symlinkSync(path.join(frontend, packageLocation, 'node_modules'), destination, 'dir');
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
