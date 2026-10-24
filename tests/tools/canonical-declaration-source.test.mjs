import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { readFileSync as namedReadFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

const { inspectCanonicalDeclarationSource, validateCanonicalDeclarationSourceReceipt } = await import(
    new URL('../../tools/configuration/check-canonical-declaration-source.mjs', import.meta.url)
);
const {
    canonicalTestDeclarationProducer, canonicalTestDeclarationModules, canonicalTestDeclarationOutputs,
    canonicalTestDeclarationReadOnlyInputs, canonicalTestDeclarationBindingFile
} = await import(new URL('../../tools/frontend/canonical-test-declaration-inputs.mjs', import.meta.url));
const { generateCanonicalTestDeclarations } = await import(
    new URL('../../tools/frontend/generate-canonical-test-declarations.mjs', import.meta.url)
);
const { inspectLocalFsusUiPublicDependencyBindings, projectLocalFsusUiInstall } = await import(
    new URL('../../src/frontend/scripts/prepare-local-fsusui-install.mjs', import.meta.url)
);
const authorityRoot = fileURLToPath(new URL('../../', import.meta.url));
const ts = createRequire(new URL('../../tools/frontend/style-toolchain/package.json', import.meta.url))('typescript');
const inputOwner = 'tools/frontend/canonical-test-declaration-inputs.mjs';

function write(root, file, content)
{
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
}

function git(root, ...args)
{
    return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 'Canonical Source Fixture',
            GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Canonical Source Fixture',
            GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
    }).trim();
}

function commit(root)
{
    git(root, 'add', '--all');
    git(root, 'commit', '-qm', 'fixture source');
    return git(root, 'rev-parse', 'HEAD');
}

function fixture(context)
{
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'canonical-declaration-source-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'blog');
    const localRoot = path.join(directory, 'ui');
    fs.mkdirSync(root);
    fs.mkdirSync(localRoot);
    git(root, 'init', '-q');
    git(localRoot, 'init', '-q');
    for (const file of [canonicalTestDeclarationProducer, inputOwner,
        'src/frontend/scripts/fsusui-root.mjs', 'src/frontend/scripts/run-local-fsusui-typecheck.mjs',
        'src/frontend/scripts/prepare-local-fsusui-install.mjs'])
    {
        write(root, file, fs.readFileSync(path.join(authorityRoot, file)));
    }
    for (const file of canonicalTestDeclarationReadOnlyInputs)
    {
        if (!fs.existsSync(path.join(root, file)))
        {
            write(root, file, file === 'src/frontend/package-lock.json'
                ? fs.readFileSync(path.join(authorityRoot, file)) : 'export {};\n');
        }
    }
    write(root, 'src/frontend/package.json', '{"type":"module"}\n');
    write(root, '.gitignore', 'src/frontend/.tmp/\n**/node_modules/\n');
    write(root, 'src/frontend/fixture.ts', 'export const fixture = 7;\n');
    write(root, 'src/frontend/tsconfig.playwright.json', JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            types: [], strict: true, skipLibCheck: true, allowJs: true, checkJs: true },
        include: ['fixture.ts']
    }));
    for (const file of canonicalTestDeclarationModules)
    {
        write(root, file, 'export const fixture = 7;\n');
    }
    for (const name of ['vitest', 'fake-indexeddb', 'happy-dom', 'pinia', 'pinia-plugin-persistedstate',
        'vue-router', '@vue/test-utils'])
    {
        write(root, 'src/frontend/node_modules/' + name + '/package.json',
            JSON.stringify({ name, version: '1.0.0', type: 'module', types: './index.d.ts' }));
        write(root, 'src/frontend/node_modules/' + name + '/index.d.ts', 'export {};\n');
    }
    write(root, 'src/frontend/node_modules/@noble/hashes/package.json', JSON.stringify({
        name: '@noble/hashes', version: '1.0.0', type: 'module',
        exports: { './sha2.js': { types: './sha2.d.ts' }, './utils.js': { types: './utils.d.ts' } }
    }));
    write(root, 'src/frontend/node_modules/@noble/hashes/sha2.d.ts', 'export {};\n');
    write(root, 'src/frontend/node_modules/@noble/hashes/utils.d.ts', 'export {};\n');
    for (const file of ['vue/packages/element-plus/index.ts', 'vue/packages/icons-vue/src/index.ts',
        'vue/global.d.ts', 'vue/typings/components.d.ts', 'vue/typings/env.d.ts'])
    {
        write(localRoot, file, 'export {};\n');
    }
    write(localRoot, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    write(localRoot, 'vue/packages/element-plus/package.json', '{"name":"element-plus","dependencies":{}}\n');
    commit(localRoot);
    const original = generateCanonicalTestDeclarations({ repositoryRoot: root, typescript: ts, localRoot });
    for (const [file, content] of original)
    {
        write(root, file, content);
    }
    const head = commit(root);
    return { root, localRoot, head, inspect: files => inspectCanonicalDeclarationSource({
        repositoryRoot: root, localRoot, files: files ?? [...canonicalTestDeclarationOutputs]
    }) };
}

function regenerate(f)
{
    for (const [file, content] of generateCanonicalTestDeclarations({ repositoryRoot: f.root, typescript: ts, localRoot: f.localRoot }))
    {
        write(f.root, file, content);
    }
    if (git(f.localRoot, 'status', '--porcelain'))
    {
        commit(f.localRoot);
    }
    f.head = commit(f.root);
}

function publicAliases(f)
{
    const manifest = JSON.parse(fs.readFileSync(path.join(authorityRoot, 'src/frontend/package.json')));
    const lockfile = JSON.parse(fs.readFileSync(path.join(f.root, 'src/frontend/package-lock.json')));
    const sourceManifest = { name: 'element-plus', dependencies: {
        '@element-plus/icons-vue': 'workspace:*', '@element-plus/motion': 'workspace:*'
    } };
    write(f.localRoot, 'vue/packages/element-plus/package.json', JSON.stringify(sourceManifest));
    for (const name of Object.keys(sourceManifest.dependencies))
    {
        write(f.localRoot, 'vue/packages/' + name.split('/')[1] + '/package.json', JSON.stringify({ name }));
    }
    write(f.root, 'src/frontend/package.json', JSON.stringify(manifest));
    const projected = projectLocalFsusUiInstall({ manifest, lockfile });
    const bindings = inspectLocalFsusUiPublicDependencyBindings({ manifest, lockfile, sourceManifest,
        readInstalledManifest(location, name)
        {
            const locked = projected.lockfile.packages[location];
            const installed = { name: locked.name ?? name, version: locked.version, types: './index.d.ts' };
            write(f.root, 'src/frontend/' + location + '/package.json', JSON.stringify(installed));
            write(f.root, 'src/frontend/' + location + '/index.d.ts', 'export declare const dependency: 7;\n');
            return installed;
        },
        readWorkspaceManifest(name)
        {
            return JSON.parse(fs.readFileSync(path.join(f.localRoot, 'vue/packages', name.split('/')[1], 'package.json')));
        }
    });
    for (const binding of bindings)
    {
        const logical = path.join(f.localRoot, 'vue/packages/node_modules', binding.name);
        fs.mkdirSync(path.dirname(logical), { recursive: true });
        fs.symlinkSync(path.join(f.root, 'src/frontend', binding.location), logical);
    }
    write(f.localRoot, 'vue/packages/public-fixture.ts', 'import { dependency } from "dayjs";\nexport const value = dependency;\n');
    write(f.root, 'src/frontend/fixture.ts', 'import { value } from '
        + JSON.stringify(path.join(f.localRoot, 'vue/packages/public-fixture.js')) + ';\nexport const fixture = value;\n');
    regenerate(f);
    return bindings;
}

test('the original public install owns finite dual-repository aliases and every logical read is reopened', context =>
{
    const f = fixture(context);
    const bindings = publicAliases(f);
    const receipt = f.inspect();
    assert.equal(receipt.consumed.publicDependencyAliases.length, bindings.length);
    const requested = path.join(f.localRoot, 'vue/packages/node_modules/dayjs/package.json');
    const physical = path.join(f.root, 'src/frontend/node_modules/dayjs/package.json');
    assert.ok(receipt.consumed.logicalReads.some(value => value.requested === requested && value.physical === physical));
    assert.ok(receipt.consumed.probes.some(value => value.kind === 'realpath'
        && value.args[0] === path.join(f.localRoot, 'vue/packages/node_modules/dayjs/index.d.ts')
        && value.result === path.join(f.root, 'src/frontend/node_modules/dayjs/index.d.ts')));
    assert.ok(receipt.publicDependencyWitnesses.some(value => value.file === 'src/frontend/scripts/prepare-local-fsusui-install.mjs'));
    for (const name of ['icons-vue', 'motion'])
    {
        assert.ok(receipt.consumed.reads.some(value => value.kind === 'git-source'
            && value.repository === f.localRoot && value.path === 'vue/packages/' + name + '/package.json'));
    }
    assert.equal(validateCanonicalDeclarationSourceReceipt({ repositoryRoot: f.root, localRoot: f.localRoot,
        files: [...canonicalTestDeclarationOutputs], expectedHead: f.head, receipt }), receipt);
});

test('source workspace manifests retain missing and wrong-name refusals through the original binding owner', context =>
{
    const f = fixture(context);
    publicAliases(f);
    const file = path.join(f.localRoot, 'vue/packages/motion/package.json');
    const original = fs.readFileSync(file);
    fs.unlinkSync(file);
    assert.throws(() => f.inspect(), /JSON|undefined|workspace/u);
    fs.writeFileSync(file, JSON.stringify({ name: '@element-plus/other' }));
    commit(f.localRoot);
    assert.throws(() => f.inspect(), /source workspace dependency is missing/u);
    fs.writeFileSync(file, original);
});

test('a public alias with a changed target or installed identity cannot acquire cross-repository authority', context =>
{
    const f = fixture(context);
    publicAliases(f);
    const logical = path.join(f.localRoot, 'vue/packages/node_modules/dayjs');
    const original = fs.readlinkSync(logical);
    fs.unlinkSync(logical);
    fs.symlinkSync(path.join(f.root, 'src/frontend/node_modules/lodash'), logical);
    assert.throws(() => f.inspect(), /public dependency alias differs|not an original locked public dependency alias/u);
    fs.unlinkSync(logical);
    const sameRepository = path.join(f.localRoot, 'node_modules/dayjs');
    fs.mkdirSync(sameRepository, { recursive: true });
    fs.symlinkSync(sameRepository, logical);
    assert.throws(() => f.inspect(), /public dependency alias differs|public dependency namespace is not an original locked alias/u);
    fs.unlinkSync(logical);
    fs.symlinkSync(original, logical);
    write(f.root, 'src/frontend/node_modules/dayjs/package.json', '{"name":"dayjs","version":"0.0.0","types":"index.d.ts"}\n');
    assert.throws(() => f.inspect(), /installed locked dependency version differs/u);
});

test('an arbitrary cross-repository dependency link remains closed even when both repositories are bound', context =>
{
    const f = fixture(context);
    publicAliases(f);
    const logical = path.join(f.localRoot, 'vue/packages/node_modules/unregistered');
    fs.symlinkSync(path.join(f.root, 'src/frontend/node_modules/dayjs'), logical);
    write(f.localRoot, 'vue/packages/public-fixture.ts', 'import { dependency } from "unregistered";\nexport const value = dependency;\n');
    commit(f.localRoot);
    assert.throws(() => f.inspect(), /not an original locked public dependency alias|public dependency namespace is not an original locked alias/u);
});

test('glob traversal records real directory aliases even when the selected source roster does not change', context =>
{
    const f = fixture(context);
    write(f.root, 'src/frontend/scan/first/marker.txt', 'first\n');
    write(f.root, 'src/frontend/scan/second/marker.txt', 'second\n');
    const alias = path.join(f.root, 'src/frontend/scan/alias');
    const target = path.join(f.root, 'src/frontend/scan/first');
    fs.symlinkSync(target, alias);
    const configuration = JSON.parse(fs.readFileSync(path.join(f.root, 'src/frontend/tsconfig.playwright.json')));
    configuration.include = ['fixture.ts', 'scan/**/*.ts'];
    write(f.root, 'src/frontend/tsconfig.playwright.json', JSON.stringify(configuration));
    regenerate(f);
    const receipt = f.inspect();
    assert.ok(receipt.consumed.probes.some(value => value.kind === 'realpath'
        && value.args[0] === alias && value.result === target));
    fs.unlinkSync(alias);
    fs.symlinkSync(path.join(f.root, 'src/frontend/scan/second'), alias);
    assert.throws(() => validateCanonicalDeclarationSourceReceipt({ repositoryRoot: f.root, localRoot: f.localRoot,
        files: [...canonicalTestDeclarationOutputs], expectedHead: f.head, receipt }), /independent original regeneration/u);
});

test('original generated declarations retain their full finite producer and independent source receipt', context =>
{
    const f = fixture(context);
    const receipt = f.inspect();
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.qualificationEligible, false);
    assert.equal(receipt.outputs.length, 17);
    assert.equal(receipt.witnesses.length, 44);
    assert.ok(receipt.consumed.reads.some(value => value.path === 'src/frontend/fixture.ts'));
    assert.ok(receipt.consumed.reads.some(value => value.kind === 'dependency' && value.path.includes('typescript/lib/lib.')));
    assert.equal(validateCanonicalDeclarationSourceReceipt({ repositoryRoot: f.root, localRoot: f.localRoot,
        files: [...canonicalTestDeclarationOutputs], expectedHead: f.head, receipt }), receipt);
});

test('source provenance and generated output comparison consume held data without candidate pathname reads', context =>
{
    const f = fixture(context);
    const originalRead = fs.readFileSync;
    const hook = mock.method(fs, 'readFileSync', (file, ...args) =>
    {
        if (typeof file === 'string' && (file.startsWith(f.root + path.sep) || file.startsWith(f.localRoot + path.sep)))
        {
            throw new Error('unbound candidate pathname read: ' + file);
        }
        return originalRead(file, ...args);
    });
    syncBuiltinESMExports();
    try
    {
        assert.throws(() => namedReadFileSync(path.join(f.root, 'src/frontend/package.json')), /unbound candidate pathname read/u);
        const receipt = f.inspect();
        assert.equal(receipt.status, 'success');
        assert.equal(validateCanonicalDeclarationSourceReceipt({ repositoryRoot: f.root, localRoot: f.localRoot,
            files: [...canonicalTestDeclarationOutputs], expectedHead: f.head, receipt }), receipt);
    }
    finally
    {
        hook.mock.restore();
        syncBuiltinESMExports();
    }
});

test('source declaration inspection never executes candidate compiler packages or original module bodies', context =>
{
    const f = fixture(context);
    const marker = path.join(f.root, 'executed');
    write(f.root, 'src/frontend/node_modules/typescript/package.json', '{"main":"index.js","version":"6.0.3"}\n');
    write(f.root, 'src/frontend/node_modules/typescript/index.js',
        'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "executed"); throw new Error("candidate compiler ran");\n');
    for (const file of canonicalTestDeclarationModules)
    {
        write(f.root, file, 'throw new Error("candidate module ran");\nexport const fixture = 7;\n');
    }
    const outputs = generateCanonicalTestDeclarations({ repositoryRoot: f.root, typescript: ts, localRoot: f.localRoot });
    for (const [file, content] of outputs)
    {
        write(f.root, file, content);
    }
    commit(f.root);
    assert.equal(f.inspect().status, 'success');
    assert.equal(fs.existsSync(marker), false);
});

test('unknown duplicate deleted and uncommitted declarations cannot receive source coverage', context =>
{
    const f = fixture(context);
    for (const files of [[], ['tools/unknown.d.mts'],
        [canonicalTestDeclarationOutputs[0], canonicalTestDeclarationOutputs[0]]])
    {
        assert.throws(() => f.inspect(files), /distinct explicit original/u);
    }
    const file = canonicalTestDeclarationOutputs[0];
    fs.appendFileSync(path.join(f.root, file), '\n');
    assert.throws(() => f.inspect(), /HEAD\/index\/physical/u);
    git(f.root, 'checkout', '--', file);
    fs.unlinkSync(path.join(f.root, file));
    assert.throws(() => f.inspect(), /ENOENT/u);
});

test('committed declaration drift and a forged original binding are independently refused', context =>
{
    const f = fixture(context);
    write(f.root, canonicalTestDeclarationOutputs[0], 'export declare const fixture: string;\n');
    commit(f.root);
    assert.throws(() => f.inspect(), /differs from its actual original producer/u);
    const outputs = generateCanonicalTestDeclarations({ repositoryRoot: f.root, typescript: ts, localRoot: f.localRoot });
    for (const [file, content] of outputs)
    {
        write(f.root, file, content);
    }
    const binding = JSON.parse(fs.readFileSync(path.join(f.root, canonicalTestDeclarationBindingFile)));
    binding.outputs[0].sha256 = '0'.repeat(64);
    write(f.root, canonicalTestDeclarationBindingFile, JSON.stringify(binding));
    commit(f.root);
    assert.throws(() => f.inspect(), /differs from its actual original producer/u);
});

test('source owner input substitution and a different compiler archive remain refusals', context =>
{
    const f = fixture(context);
    fs.appendFileSync(path.join(f.root, canonicalTestDeclarationProducer), '\n');
    commit(f.root);
    assert.throws(() => f.inspect(), /differs from its executing authority/u);
    git(f.root, 'checkout', f.head, '--', canonicalTestDeclarationProducer);
    commit(f.root);
    const lock = JSON.parse(fs.readFileSync(path.join(f.root, 'src/frontend/package-lock.json')));
    lock.packages['node_modules/typescript'].integrity = 'sha512-' + '0'.repeat(32);
    write(f.root, 'src/frontend/package-lock.json', JSON.stringify(lock));
    commit(f.root);
    assert.throws(() => f.inspect(), /differs from the two original locked archives/u);
});

test('source and receipt validation retain hardlink path and closed caller-context refusals', context =>
{
    const f = fixture(context);
    const file = canonicalTestDeclarationOutputs[0];
    const link = path.join(f.root, 'linked-output');
    fs.linkSync(path.join(f.root, file), link);
    assert.throws(() => f.inspect(), /regular single-link/u);
    fs.unlinkSync(link);
    const receipt = f.inspect([file]);
    for (const mutate of [
        value => ({ ...value, qualificationEligible: true }),
        value => ({ ...value, unexpected: true }),
        value => ({ ...value, files: [canonicalTestDeclarationOutputs[1]] }),
        value => ({ ...value, outputs: value.outputs.slice(1) }),
        value => ({ ...value, consumed: { ...value.consumed, reads: [] } })
    ])
    {
        assert.throws(() => validateCanonicalDeclarationSourceReceipt({ repositoryRoot: f.root, localRoot: f.localRoot,
            files: [file], expectedHead: f.head, receipt: mutate(receipt) }),
        /independent caller binding|independent original regeneration/u);
    }
    assert.throws(() => validateCanonicalDeclarationSourceReceipt({ repositoryRoot: f.root, localRoot: f.localRoot,
        files: [file], expectedHead: '0'.repeat(40), receipt }), /independent caller binding/u);
});

test('compiler source reads cannot escape to an external source even when the compiler catches a read error', context =>
{
    const f = fixture(context);
    const outside = path.join(path.dirname(f.root), 'outside.ts');
    fs.writeFileSync(outside, 'export const outside = 7;\n');
    const configuration = JSON.parse(fs.readFileSync(path.join(f.root, 'src/frontend/tsconfig.playwright.json')));
    configuration.files = [outside];
    write(f.root, 'src/frontend/tsconfig.playwright.json', JSON.stringify(configuration));
    commit(f.root);
    assert.throws(() => f.inspect(), /escapes its closed repositories|refuses|outside/u);
});

test('a real additional compiler source mutation during the held descriptor read is refused', context =>
{
    const f = fixture(context);
    const source = path.join(f.root, 'src/frontend/fixture.ts');
    const identity = fs.statSync(source, { bigint: true }).ino;
    const originalRead = fs.readSync;
    let mutated = false;
    const hook = mock.method(fs, 'readSync', (descriptor, ...args) =>
    {
        const result = originalRead(descriptor, ...args);
        if (!mutated && fs.fstatSync(descriptor, { bigint: true }).ino === identity)
        {
            mutated = true;
            fs.appendFileSync(source, '\n');
        }
        return result;
    });
    try
    {
        assert.throws(() => f.inspect(), /changed during its descriptor read|HEAD\/index\/physical/u);
        assert.equal(mutated, true);
    }
    finally
    {
        hook.mock.restore();
    }
});

test('Git replacement and object alternates cannot choose the declaration source history', context =>
{
    const f = fixture(context);
    write(f.root, 'extra-input.txt', 'owned replacement fixture\n');
    const replacement = commit(f.root);
    git(f.root, 'replace', f.head, replacement);
    assert.throws(() => f.inspect(), /rewritten or alternate Git context/u);
    git(f.root, 'replace', '-d', f.head);
    const alternate = git(f.root, 'rev-parse', '--git-path', 'objects/info/alternates');
    fs.writeFileSync(path.resolve(f.root, alternate), path.join(f.localRoot, '.git/objects') + '\n');
    assert.throws(() => f.inspect(), /rewritten or alternate Git context/u);
});

test('recursive compiler directory discovery refuses symlink escapes before enumerating the external directory', context =>
{
    const f = fixture(context);
    const outside = path.join(path.dirname(f.root), 'external-directory');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'external.ts'), 'export const external = 7;\n');
    fs.symlinkSync(outside, path.join(f.root, 'src/frontend/external'));
    const configuration = JSON.parse(fs.readFileSync(path.join(f.root, 'src/frontend/tsconfig.playwright.json')));
    configuration.include = ['**/*.ts'];
    write(f.root, 'src/frontend/tsconfig.playwright.json', JSON.stringify(configuration));
    commit(f.root);
    assert.throws(() => f.inspect(), /compiler path escapes its closed repositories|directory enumeration escapes/u);
});

test('a nonregular fixed output is refused without opening an owned FIFO', context =>
{
    const f = fixture(context);
    const file = path.join(f.root, canonicalTestDeclarationOutputs[0]);
    fs.unlinkSync(file);
    execFileSync('mkfifo', [file]);
    assert.throws(() => f.inspect(), /regular single-link fixed input/u);
});

test('a cold checkout stays cold while the original configuration is supplied entirely in memory', context =>
{
    const f = fixture(context);
    const scratch = path.join(f.root, 'src/frontend/.tmp');
    fs.rmSync(scratch, { recursive: true, force: true });
    const receipt = f.inspect();
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.consumed.virtualConfigurations.length, 1);
    assert.equal(fs.existsSync(scratch), false);
    assert.equal(validateCanonicalDeclarationSourceReceipt({ repositoryRoot: f.root, localRoot: f.localRoot,
        files: [...canonicalTestDeclarationOutputs], expectedHead: f.head, receipt }), receipt);
    assert.equal(fs.existsSync(scratch), false);
});

for (const alias of ['directory-symlink', 'leaf-symlink', 'leaf-hardlink'])
{
    test('ignored scratch ' + alias + ' cannot read or overwrite an external sentinel', context =>
    {
        const f = fixture(context);
        const outside = path.join(path.dirname(f.root), 'external-scratch');
        fs.mkdirSync(outside);
        const sentinel = path.join(outside, 'sentinel.json');
        const original = Buffer.from('private owned fixture sentinel\\n');
        fs.writeFileSync(sentinel, original);
        const scratch = path.join(f.root, 'src/frontend/.tmp');
        const config = path.join(scratch, 'typecheck/tsconfig.fsusui-local.tests.generated.json');
        if (alias === 'directory-symlink')
        {
            fs.rmSync(scratch, { recursive: true, force: true });
            fs.symlinkSync(outside, scratch);
        }
        else
        {
            fs.unlinkSync(config);
            if (alias === 'leaf-symlink')
            {
                fs.symlinkSync(sentinel, config);
            }
            else
            {
                fs.linkSync(sentinel, config);
            }
        }
        assert.throws(() => f.inspect(), /scratch namespace refuses linked or nonregular/u);
        assert.deepEqual(fs.readFileSync(sentinel), original);
        assert.deepEqual(fs.readdirSync(outside), ['sentinel.json']);
    });
}
