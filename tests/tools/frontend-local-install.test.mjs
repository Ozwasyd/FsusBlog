import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    prepareLocalFsusUiInstall,
    projectLocalFsusUiInstall,
    verifyLocalFsusUiInstall
} = await import(new URL('../../src/frontend/scripts/prepare-local-fsusui-install.mjs', import.meta.url));
const {
    buildStaticGovernanceExecutionPlan,
    loadStaticGovernanceRegistry
} = await import(new URL('../../tools/test/static-governance-host.mjs', import.meta.url));

const root = path.resolve(import.meta.dirname, '../..');
const packageName = '@ozwasyd/element-plus';
const location = `node_modules/${packageName}`;
const themeFiles = ['index.css', 'el-public-shell-critical.css', 'el-fsus-theme.css'];
const wasmFiles = ['ep_wasm.mjs', 'ep_wasm.wasm', 'markdown_basic.js', 'markdown_basic.wasm', 'markdown_simd.js', 'markdown_simd.wasm'];

test('local install regression has one existing canonical physical owner and matrix input closure', () =>
{
    const file = 'tests/tools/frontend-local-install.test.mjs';
    const registry = loadStaticGovernanceRegistry(path.join(root, 'tests/governance/test-lifecycle-registry.json'), root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const checks = plan.hosts.flatMap(host => host.checks).filter(check => check.file === file);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].id, 'frontend-local-install');
    assert.equal(checks[0].category, 'isolated-temporary-repository-fixture');
    assert.equal(checks[0].physicalOwner, 'host:temporary-repository');
    const lifecycle = JSON.parse(fs.readFileSync(path.join(root, 'tests/governance/test-lifecycle-registry.json'), 'utf8'));
    const entries = lifecycle.nodeTests.filter(entry => entry.file === file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].owner, 'repository-governance:static-node-contracts');
    assert.equal(entries[0].lifecycle, 'canonical-execution');
    assert.equal(entries[0].physicalExecutionCount, 1);
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    for (const input of [file, 'src/frontend/scripts/prepare-local-fsusui-install.mjs', 'src/frontend/scripts/fsusui-root.mjs'])
    {
        assert.ok(matrix.includes(`          - ${input}\n`), input);
    }
});

function inputs()
{
    const manifest = { name: 'test-consumer', dependencies: { [packageName]: '1.5.1', vue: '3.5.33' } };
    const publicEntry = (version) => ({ version, resolved: `https://registry.npmjs.org/katex/-/katex-${version}.tgz`, integrity: 'sha512-Ynl0ZXM=' });
    const lockfile = {
        name: manifest.name,
        lockfileVersion: 3,
        packages: {
            '': structuredClone(manifest),
            [location]: {
                version: '1.5.1',
                resolved: 'https://npm.pkg.github.com/download/@ozwasyd/element-plus/1.5.1/immutable',
                integrity: 'sha512-Ynl0ZXM=',
                dependencies: { katex: '^0.17.0' },
                peerDependencies: { vue: '^3.5.0' }
            },
            'node_modules/vue': publicEntry('3.5.33'),
            'node_modules/katex': publicEntry('0.16.45'),
            [`${location}/node_modules/katex`]: publicEntry('0.17.0')
        }
    };
    return { manifest, lockfile };
}

function fixture(t)
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-local-install-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const frontend = path.join(temporary, 'frontend');
    const fsusui = path.join(temporary, 'FsusUI');
    const output = path.join(temporary, 'install');
    const write = (file, value) =>
    {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
    };
    const { manifest, lockfile } = inputs();
    write(path.join(frontend, 'package.json'), JSON.stringify(manifest));
    write(path.join(frontend, 'package-lock.json'), JSON.stringify(lockfile));
    const packages = path.join(fsusui, 'vue/packages');
    write(path.join(packages, 'element-plus/index.ts'), 'export const local = true;\n');
    write(path.join(packages, 'icons-vue/src/index.ts'), 'export const icon = true;\n');
    write(path.join(packages, 'element-plus/package.json'), JSON.stringify({ name: 'element-plus', dependencies: { katex: '^0.17.0' } }));
    for (const file of themeFiles)
    {
        write(path.join(packages, 'theme-chalk/dist', file), '/* real fixture CSS */\n');
    }
    for (const file of wasmFiles)
    {
        write(path.join(packages, 'wasm/dist', file), 'fixture bytes\n');
    }
    write(path.join(frontend, 'node_modules/vue/package.json'), JSON.stringify({ name: 'vue', version: '3.5.33' }));
    write(path.join(frontend, 'node_modules/katex/package.json'), JSON.stringify({ name: 'katex', version: '0.16.45' }));
    write(path.join(frontend, 'node_modules/fsusui-local-katex/package.json'), JSON.stringify({ name: 'katex', version: '0.17.0' }));
    return { frontend, fsusui, output, write, manifest, lockfile };
}

test('local projection removes only the exact package and keeps every other lock record and integrity', () =>
{
    const before = inputs();
    const original = structuredClone(before);
    const projected = projectLocalFsusUiInstall(before);
    assert.deepEqual(before, original);
    assert.equal(projected.manifest.dependencies[packageName], undefined);
    assert.equal(projected.lockfile.packages[''].dependencies[packageName], undefined);
    assert.equal(projected.lockfile.packages[location], undefined);
    for (const [key, value] of Object.entries(before.lockfile.packages))
    {
        if (key !== '' && key !== location)
        {
            assert.deepEqual(projected.lockfile.packages[key], value, key);
        }
    }
    const restored = structuredClone(projected);
    assert.equal(restored.manifest.dependencies['fsusui-local-katex'], 'npm:katex@0.17.0');
    assert.equal(restored.lockfile.packages[''].dependencies['fsusui-local-katex'], 'npm:katex@0.17.0');
    assert.deepEqual(restored.lockfile.packages['node_modules/fsusui-local-katex'], {
        ...original.lockfile.packages[`${location}/node_modules/katex`], name: 'katex'
    });
    delete restored.manifest.dependencies['fsusui-local-katex'];
    delete restored.lockfile.packages[''].dependencies['fsusui-local-katex'];
    delete restored.lockfile.packages['node_modules/fsusui-local-katex'];
    restored.manifest.dependencies[packageName] = original.manifest.dependencies[packageName];
    restored.lockfile.packages[''].dependencies[packageName] = original.lockfile.packages[''].dependencies[packageName];
    restored.lockfile.packages[location] = original.lockfile.packages[location];
    assert.deepEqual(restored, original);
});

test('current real lock projects without altering any public or nested lock identity', () =>
{
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package-lock.json'), 'utf8'));
    const projected = projectLocalFsusUiInstall({ manifest, lockfile });
    for (const [key, value] of Object.entries(lockfile.packages))
    {
        if (key !== '' && key !== location)
        {
            assert.deepEqual(projected.lockfile.packages[key], value, key);
        }
    }
    assert.deepEqual(projected.lockfile.packages[`${location}/node_modules/katex`], lockfile.packages[`${location}/node_modules/katex`]);
});

test('source-only public dependencies remain reachable after removing the private parent', () =>
{
    const original = inputs();
    original.lockfile.packages[location].dependencies['escape-html'] = '^1.0.3';
    original.lockfile.packages['node_modules/escape-html'] = {
        version: '1.0.3', resolved: 'https://registry.npmjs.org/escape-html/-/escape-html-1.0.3.tgz', integrity: 'sha512-Ynl0ZXM='
    };
    const projected = projectLocalFsusUiInstall(original);
    assert.equal(projected.manifest.dependencies['escape-html'], '1.0.3');
    assert.equal(projected.lockfile.packages[''].dependencies['escape-html'], '1.0.3');
    assert.deepEqual(projected.lockfile.packages['node_modules/escape-html'], original.lockfile.packages['node_modules/escape-html']);
    assert.equal(projected.manifest.dependencies['fsusui-local-katex'], 'npm:katex@0.17.0');
    assert.equal(projected.lockfile.packages['node_modules/fsusui-local-katex'].integrity,
        original.lockfile.packages[`${location}/node_modules/katex`].integrity);
    assert.equal(projected.lockfile.packages['node_modules/katex'].version, '0.16.45');
});

test('temporary public aliases retain their original transitive resolution and reject name collisions', () =>
{
    const original = inputs();
    original.lockfile.packages[`${location}/node_modules/katex`].dependencies = { commander: '^8.3.0' };
    original.lockfile.packages[`${location}/node_modules/commander`] = {
        version: '8.3.0', resolved: 'https://registry.npmjs.org/commander/-/commander-8.3.0.tgz', integrity: 'sha512-Ynl0ZXM='
    };
    original.lockfile.packages['node_modules/commander'] = {
        version: '7.2.0', resolved: 'https://registry.npmjs.org/commander/-/commander-7.2.0.tgz', integrity: 'sha512-Ynl0ZXM='
    };
    const projected = projectLocalFsusUiInstall(original);
    assert.deepEqual(projected.lockfile.packages['node_modules/fsusui-local-katex/node_modules/commander'],
        original.lockfile.packages[`${location}/node_modules/commander`]);
    assert.deepEqual(projected.lockfile.packages['node_modules/commander'], original.lockfile.packages['node_modules/commander']);
    const collision = inputs();
    for (const name of ['foo.bar', 'foo_bar'])
    {
        collision.lockfile.packages[location].dependencies[name] = '1.0.0';
        collision.lockfile.packages[`${location}/node_modules/${name}`] = {
            version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: 'sha512-Ynl0ZXM='
        };
    }
    assert.throws(() => projectLocalFsusUiInstall(collision), /alias.*colli/u);
    const invalid = inputs();
    invalid.lockfile.packages[`${location}/node_modules/katex`].name = '../escape';
    assert.throws(() => projectLocalFsusUiInstall(invalid), /package name/u);
});

test('pinned npm virtual and ideal trees retain every public lock location without resolving FsusUI', async (t) =>
{
    const context = fixture(t);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package-lock.json'), 'utf8'));
    const projected = projectLocalFsusUiInstall({ manifest, lockfile });
    context.write(path.join(context.output, 'package.json'), JSON.stringify(projected.manifest));
    context.write(path.join(context.output, 'package-lock.json'), JSON.stringify(projected.lockfile));
    const npm = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'npm'))
        .find(file => fs.existsSync(file));
    assert.ok(npm, 'standard pinned npm is required for its read-only lock-tree parser');
    const require = createRequire(fs.realpathSync(npm));
    assert.equal(require('../package.json').version, '11.13.0');
    const Arborist = require('@npmcli/arborist');
    const parser = new Arborist({ path: context.output, offline: true, audit: false, ignoreScripts: true, save: false });
    const virtual = await parser.loadVirtual();
    const ideal = await parser.buildIdealTree();
    for (const [location, locked] of Object.entries(projected.lockfile.packages))
    {
        if (location !== '')
        {
            assert.equal(virtual.inventory.get(location)?.version, locked.version, location);
            assert.equal(ideal.inventory.get(location)?.version, locked.version, location);
            if (locked.resolved)
            {
                assert.equal(virtual.inventory.get(location)?.resolved, locked.resolved, location);
                assert.equal(ideal.inventory.get(location)?.resolved, locked.resolved, location);
                assert.equal(virtual.inventory.get(location)?.integrity, locked.integrity, location);
                assert.equal(ideal.inventory.get(location)?.integrity, locked.integrity, location);
            }
        }
    }
    assert.equal(ideal.inventory.has(location), false, 'the removed package must not enter npm\'s ideal tree');
    assert.equal(fs.existsSync(path.join(context.output, 'node_modules')), false, 'lock-tree parsing must not install packages');
});

test('projection fails closed on lock mismatch, another private dependency or a transitive target reference', () =>
{
    const mismatch = inputs();
    mismatch.lockfile.packages[''].dependencies[packageName] = '1.5.0';
    assert.throws(() => projectLocalFsusUiInstall(mismatch), /root dependency mismatch/u);
    const privateDependency = inputs();
    privateDependency.lockfile.packages['node_modules/vue'].resolved = 'https://npm.pkg.github.com/download/private/vue';
    assert.throws(() => projectLocalFsusUiInstall(privateDependency), /public npm/u);
    const transitive = inputs();
    transitive.lockfile.packages['node_modules/vue'].dependencies = { [packageName]: '1.5.1' };
    assert.throws(() => projectLocalFsusUiInstall(transitive), /still requires/u);
    const unpinned = inputs();
    delete unpinned.lockfile.packages['node_modules/vue'].integrity;
    assert.throws(() => projectLocalFsusUiInstall(unpinned), /integrity/u);
    const aliased = inputs();
    aliased.lockfile.packages['node_modules/vue'].dependencies = { compatibility: `npm:${packageName}@1.5.1` };
    assert.throws(() => projectLocalFsusUiInstall(aliased), /still requires an alias/u);
    const bundled = inputs();
    bundled.lockfile.packages['node_modules/unknown'] = { version: '1.0.0', inBundle: true };
    assert.throws(() => projectLocalFsusUiInstall(bundled), /bundled integrity owner/u);
});

test('bundled records require a present parent chain ending at an unchanged public tarball with SRI', () =>
{
    const nested = 'node_modules/vue/node_modules/bundled';
    const valid = inputs();
    valid.lockfile.packages[nested] = { version: '1.0.0', inBundle: true };
    valid.lockfile.packages[`${nested}/node_modules/deeper`] = { version: '2.0.0', inBundle: true };
    const projected = projectLocalFsusUiInstall(valid);
    assert.deepEqual(projected.lockfile.packages[nested], valid.lockfile.packages[nested]);
    const missingIntermediate = inputs();
    missingIntermediate.lockfile.packages[`${nested}/node_modules/deeper`] = { version: '2.0.0', inBundle: true };
    assert.throws(() => projectLocalFsusUiInstall(missingIntermediate), /bundled parent is missing/u);
    const orphan = inputs();
    orphan.lockfile.packages[`${location}/node_modules/bundled`] = { version: '1.0.0', inBundle: true };
    assert.throws(() => projectLocalFsusUiInstall(orphan), /bundled parent is missing/u);
    const invalidParent = structuredClone(valid);
    invalidParent.lockfile.packages[nested] = { version: '1.0.0', inBundle: 'true' };
    assert.throws(() => projectLocalFsusUiInstall(invalidParent));
    const privateParent = structuredClone(valid);
    privateParent.lockfile.packages['node_modules/vue'].resolved = 'https://npm.pkg.github.com/download/private/vue';
    assert.throws(() => projectLocalFsusUiInstall(privateParent), /public npm/u);
    const unsignedParent = structuredClone(valid);
    delete unsignedParent.lockfile.packages['node_modules/vue'].integrity;
    assert.throws(() => projectLocalFsusUiInstall(unsignedParent), /integrity/u);
    const unresolved = structuredClone(valid);
    unresolved.lockfile.packages[nested].inBundle = false;
    assert.throws(() => projectLocalFsusUiInstall(unresolved));
    const unknownUrl = structuredClone(valid);
    unknownUrl.lockfile.packages[nested].resolved = 'https://unknown.example/bundled.tgz';
    assert.throws(() => projectLocalFsusUiInstall(unknownUrl), /public npm/u);
});

test('prepare writes only a new install input and leaves original manifests and source intact', (t) =>
{
    const context = fixture(t);
    const manifest = fs.readFileSync(path.join(context.frontend, 'package.json'));
    const lock = fs.readFileSync(path.join(context.frontend, 'package-lock.json'));
    prepareLocalFsusUiInstall(context);
    assert.deepEqual(fs.readFileSync(path.join(context.frontend, 'package.json')), manifest);
    assert.deepEqual(fs.readFileSync(path.join(context.frontend, 'package-lock.json')), lock);
    assert.equal(JSON.parse(fs.readFileSync(path.join(context.output, 'package.json'))).dependencies[packageName], undefined);
    assert.throws(() => prepareLocalFsusUiInstall(context), /already exists/u);
});

test('prepare rejects missing source, missing dist, empty dist and escaped assets before emitting input', (t) =>
{
    const missing = fixture(t);
    fs.unlinkSync(path.join(missing.fsusui, 'vue/packages/element-plus/index.ts'));
    assert.throws(() => prepareLocalFsusUiInstall(missing), /source contract/u);
    assert.equal(fs.existsSync(missing.output), false);
    const dist = fixture(t);
    fs.unlinkSync(path.join(dist.fsusui, 'vue/packages/wasm/dist/ep_wasm.wasm'));
    assert.throws(() => prepareLocalFsusUiInstall(dist), /required local asset/u);
    const empty = fixture(t);
    fs.writeFileSync(path.join(empty.fsusui, 'vue/packages/theme-chalk/dist/index.css'), '');
    assert.throws(() => prepareLocalFsusUiInstall(empty), /required local asset/u);
    const escaped = fixture(t);
    const asset = path.join(escaped.fsusui, 'vue/packages/theme-chalk/dist/index.css');
    fs.unlinkSync(asset);
    fs.symlinkSync(path.join(escaped.frontend, 'package.json'), asset);
    assert.throws(() => prepareLocalFsusUiInstall(escaped), /required local asset/u);
});

test('installed source dependencies preserve the nested locked version without creating a fake FsusUI package', (t) =>
{
    const context = fixture(t);
    verifyLocalFsusUiInstall(context);
    const nested = path.join(context.fsusui, 'vue/packages/node_modules');
    assert.equal(fs.realpathSync(path.join(nested, 'katex')), fs.realpathSync(path.join(context.frontend, 'node_modules/fsusui-local-katex')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(nested, 'katex/package.json'))).version, '0.17.0');
    assert.equal(fs.existsSync(path.join(context.frontend, location, 'package.json')), false);
    assert.equal(fs.existsSync(path.join(context.fsusui, 'node_modules')), false);
});

test('verify rejects absent nested packages, version drift, already installed private package and source dependency drift', (t) =>
{
    const missing = fixture(t);
    fs.unlinkSync(path.join(missing.frontend, 'node_modules/fsusui-local-katex/package.json'));
    assert.throws(() => verifyLocalFsusUiInstall(missing), /installed locked dependency/u);
    const drift = fixture(t);
    drift.write(path.join(drift.frontend, 'node_modules/fsusui-local-katex/package.json'), JSON.stringify({ name: 'katex', version: '0.16.45' }));
    assert.throws(() => verifyLocalFsusUiInstall(drift), /installed locked dependency/u);
    const privatePackage = fixture(t);
    privatePackage.write(path.join(privatePackage.frontend, location, 'package.json'), '{}');
    assert.throws(() => verifyLocalFsusUiInstall(privatePackage), /must not be installed/u);
    const source = fixture(t);
    source.write(path.join(source.fsusui, 'vue/packages/element-plus/package.json'), JSON.stringify({ name: 'element-plus', dependencies: { katex: '^0.18.0' } }));
    assert.throws(() => verifyLocalFsusUiInstall(source), /source dependency/u);
});

test('Docker local mode validates alias before npm and published mode retains token-gated locked installation', () =>
{
    const dockerfile = fs.readFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
    const stage = dockerfile.slice(dockerfile.indexOf('FROM node-runtime-musl AS frontend-build'), dockerfile.indexOf('FROM base AS final'));
    assert.ok(stage.indexOf('COPY --from=fsusui') < stage.indexOf('npm ci'));
    assert.match(stage, /case "\$FSUSBLOG_USE_LOCAL_FSUSUI" in/u);
    const local = stage.slice(stage.indexOf('1)'), stage.indexOf('0)'));
    assert.match(local, /prepare-local-fsusui-install\.mjs prepare/u);
    assert.match(local, /npm ci --prefix/u);
    assert.match(local, /prepare-local-fsusui-install\.mjs verify/u);
    assert.doesNotMatch(local, /github_packages_token|npm\.pkg\.github\.com|_authToken/u);
    const published = stage.slice(stage.indexOf('0)'));
    assert.match(published, /cat \/run\/secrets\/github_packages_token/u);
    assert.match(published, /github_packages_token is required for npm ci/u);
    assert.match(published, /@ozwasyd:registry=https:\/\/npm\.pkg\.github\.com/u);
    assert.match(published, /npm ci/u);
    assert.match(stage, /unsupported FSUSBLOG_USE_LOCAL_FSUSUI/u);
    assert.match(stage, /ln -s \/app\/node_modules \/opt\/fsusui\/node_modules/u);
});

test('the original install verifies real workspace identities before exposing public dependency aliases', t =>
{
    const f = fixture(t);
    const sourceFile = path.join(f.fsusui, 'vue/packages/element-plus/package.json');
    const source = JSON.parse(fs.readFileSync(sourceFile));
    source.dependencies['@element-plus/icons-vue'] = 'workspace:*';
    source.dependencies['@element-plus/motion'] = 'workspace:*';
    f.write(sourceFile, JSON.stringify(source));
    for (const name of ['icons-vue', 'motion'])
    {
        f.write(path.join(f.fsusui, 'vue/packages', name, 'package.json'), JSON.stringify({ name: '@element-plus/' + name }));
    }
    verifyLocalFsusUiInstall(f);
    assert.equal(fs.readlinkSync(path.join(f.fsusui, 'vue/packages/node_modules/katex')),
        path.join(f.frontend, 'node_modules/fsusui-local-katex'));
    for (const name of [null, '@element-plus/other'])
    {
        const invalid = fixture(t);
        invalid.write(path.join(invalid.fsusui, 'vue/packages/element-plus/package.json'), JSON.stringify(source));
        invalid.write(path.join(invalid.fsusui, 'vue/packages/icons-vue/package.json'), JSON.stringify({ name: '@element-plus/icons-vue' }));
        if (name)
        {
            invalid.write(path.join(invalid.fsusui, 'vue/packages/motion/package.json'), JSON.stringify({ name }));
        }
        assert.throws(() => verifyLocalFsusUiInstall(invalid), /ENOENT|source workspace dependency is missing/u);
        assert.equal(fs.existsSync(path.join(invalid.fsusui, 'vue/packages/node_modules')), false);
    }
});
