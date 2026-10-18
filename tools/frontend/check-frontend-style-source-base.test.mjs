import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./check-frontend-style.mjs', import.meta.url), 'utf8');
const { parse } = createRequire(new URL('./style-toolchain/package.json', import.meta.url))('espree');
const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .find((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'materializeSourceDiffBase')
    ?.declaration;
assert.ok(declaration, 'the actual checker must contain the materializer');
// Execute only the actual pure-data helper body, never the checker main or an imported repository module.
const materialize = new vm.Script(`(${source.slice(declaration.start, declaration.end)})`).runInNewContext({
    fs, path, spawnSync, createRequire, Buffer,
    sha256: (value) => crypto.createHash('sha256').update(value).digest('hex'),
    gitBlobDigest: (value) => crypto.createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex')
});
const toolchain = fileURLToPath(new URL('./style-toolchain/package.json', import.meta.url));

function importContext(root)
{
    const node = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .find((candidate) => candidate.type === 'FunctionDeclaration' && candidate.id.name === 'sourceDiffImportContext');
    return new vm.Script(`(${source.slice(node.start, node.end)})`).runInNewContext({
        root, fs, path, createRequire, process,
        toPosix: (value) => value.split(path.sep).join('/'),
        command: (args) => spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8' }),
        sha256: (value) => crypto.createHash('sha256').update(value).digest('hex'),
        gitBlobDigest: (value) => crypto.createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex')
    });
}

function withRepository(callback)
{
    const root = fs.mkdtempSync(path.join(tmpdir(), 'fsusblog-source-base-'));
    const scratch = path.join(root, '.scratch');
    fs.mkdirSync(scratch);
    function write(file, value)
    {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, value);
    }
    function git(args)
    {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    }
    try
    {
        git(['init', '-q']);
        git(['config', 'user.name', 'Source Test']);
        git(['config', 'user.email', 'source-test@example.invalid']);
        write('tools/frontend/style-toolchain/package.json', fs.readFileSync(toolchain));
        fs.symlinkSync(fs.realpathSync(path.join(path.dirname(toolchain), 'node_modules')),
            path.join(root, 'tools/frontend/style-toolchain/node_modules'), 'dir');
        const commit = () =>
        {
            git(['add', '--all', ':!.scratch', ':!tools/frontend/style-toolchain/node_modules']);
            git(['commit', '-qm', 'base fixture']);
            return git(['rev-parse', 'HEAD']);
        };
        callback({ root, scratch, write, git, commit });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('materializes recursive static imports and package inputs from exact base blobs instead of candidate bytes', () =>
{
    withRepository(({ root, scratch, write, commit }) =>
    {
        write('tools/a/entry.mjs', "import { value } from '../b/input.mjs';\nexport { other } from '../b/reexport.mjs';\n");
        write('tools/b/package.json', '{"type":"module"}\n');
        write('tools/b/input.mjs', "export { value } from './deep.mjs';\n");
        write('tools/b/deep.mjs', 'export const value = 1;\n');
        write('tools/b/reexport.mjs', 'export const other = 2;\n');
        const base = commit();
        write('tools/b/deep.mjs', 'throw new Error("candidate must not enter base");\n');
        const result = materialize({ repositoryRoot: root, baseCommit: base, scratch, files: ['tools/a/entry.mjs'] });
        assert.equal(fs.readFileSync(path.join(scratch, 'tools/b/deep.mjs'), 'utf8'), 'export const value = 1;\n');
        assert.equal(fs.readFileSync(path.join(scratch, 'tools/b/package.json'), 'utf8'), '{"type":"module"}\n');
        assert.equal(result.dependencies.length, 3);
        assert.equal(result.qualification, false);
        for (const record of result.files)
        {
            assert.equal(record.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(scratch, record.file))).digest('hex'));
            assert.ok(['100644', '100755'].includes(record.mode));
        }
    });
});

test('preserves a genuinely missing base dependency instead of filling it from the current candidate', () =>
{
    withRepository(({ root, scratch, write, commit }) =>
    {
        write('tools/a/entry.mjs', "import '../b/missing.mjs';\n");
        const base = commit();
        write('tools/b/missing.mjs', 'export const added = true;\n');
        const result = materialize({ repositoryRoot: root, baseCommit: base, scratch, files: ['tools/a/entry.mjs'] });
        assert.equal(result.unresolved.length, 1);
        assert.equal(result.unresolved[0].reference, '../b/missing.mjs');
        assert.equal(fs.existsSync(path.join(scratch, 'tools/b/missing.mjs')), false);
    });
});

test('resolves a tracked package main and a literal CommonJS import without executing either', () =>
{
    withRepository(({ root, scratch, write, commit }) =>
    {
        write('tools/entry.cjs', "const input = require('./package');\n");
        write('tools/package/package.json', '{"main":"source.mjs"}\n');
        write('tools/package/source.mjs', 'throw new Error("must never execute");\n');
        const result = materialize({ repositoryRoot: root, baseCommit: commit(), scratch, files: ['tools/entry.cjs'] });
        assert.ok(result.files.some((record) => record.file === 'tools/package/source.mjs'));
    });
});

test('import context proves the same actual repository and builtin inputs and rejects candidate working-byte drift', () =>
{
    withRepository(({ root, scratch, write, commit }) =>
    {
        const file = 'tools/a/entry.mjs';
        const entry = "import fs from 'node:fs';\nimport { value } from '../b/input.mjs';\n";
        write(file, entry);
        write('tools/b/input.mjs', 'export const value = 1;\n');
        const baseInputs = materialize({ repositoryRoot: root, baseCommit: commit(), scratch, files: [file] });
        const context = importContext(root)({ file, baseSource: entry, candidateSource: entry, baseInputs, identities: [] });
        assert.deepEqual(JSON.parse(JSON.stringify(context.base)), JSON.parse(JSON.stringify(context.candidate)));
        assert.equal(context.base.dependencies.length, 2);
        write('tools/b/input.mjs', 'export const value = 99;\n');
        assert.equal(importContext(root)({ file, baseSource: entry, candidateSource: entry, baseInputs, identities: [] }), null);
    });
});

test('independent candidate resolver witnesses a changed package main rather than reusing the base target', () =>
{
    withRepository(({ root, scratch, write, commit }) =>
    {
        const file = 'tools/a/entry.mjs';
        const entry = "import value from '../package';\n";
        write(file, entry);
        write('tools/package/package.json', '{"main":"original.js"}\n');
        write('tools/package/original.js', 'module.exports = 1;\n');
        const baseInputs = materialize({ repositoryRoot: root, baseCommit: commit(), scratch, files: [file] });
        write('tools/package/package.json', '{"main":"changed.js"}\n');
        write('tools/package/changed.js', 'module.exports = 2;\n');
        commit();
        const context = importContext(root)({ file, baseSource: entry, candidateSource: entry, baseInputs, identities: [] });
        assert.equal(context.base.dependencies[0].path, 'tools/package/original.js');
        assert.equal(context.candidate.dependencies[0].path, 'tools/package/changed.js');
        assert.notDeepEqual(context.base, context.candidate);
    });
});

for (const kind of ['escape', 'symlink', 'invalid-utf8'])
{
    test(`rejects ${kind} base inputs without replacing them with candidate data`, () =>
    {
        withRepository(({ root, scratch, write, commit }) =>
        {
            const reference = kind === 'escape' ? '../../../outside.mjs' : '../b/input.mjs';
            write('tools/a/entry.mjs', `import '${reference}';\n`);
            if (kind === 'symlink')
            {
                write('tools/b/actual.mjs', 'export const value = 1;\n');
                fs.symlinkSync('actual.mjs', path.join(root, 'tools/b/input.mjs'));
            }
            else if (kind === 'invalid-utf8')
            {
                write('tools/b/input.mjs', Buffer.from([0xff]));
            }
            const base = commit();
            assert.throws(() => materialize({ repositoryRoot: root, baseCommit: base, scratch, files: ['tools/a/entry.mjs'] }),
                kind === 'escape' ? /escapes repository/u : kind === 'symlink' ? /tracked regular file/u : /exact UTF-8/u);
        });
    });
}


test('original ESLint isolates untyped scratch from frontend dependencies and retains typed alias refusal', () =>
{
    withRepository(({ root, write }) =>
    {
        const actualRoot = fileURLToPath(new URL('../../', import.meta.url));
        for (const file of ['eslint.config.mjs', 'tools/frontend/style-toolchain/eslint.config.mjs',
            'src/frontend/scripts/run-local-fsusui-typecheck.mjs', 'src/frontend/scripts/fsusui-root.mjs',
            'src/frontend/package.json', 'src/frontend/package-lock.json'])
        {
            write(file, fs.readFileSync(path.join(actualRoot, file)));
        }
        // This is an isolated configuration fixture, not frontend/product qualification.
        write('src/frontend/tsconfig.app.json', JSON.stringify({ compilerOptions: {
            target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
            noEmit: true, types: [], ignoreDeprecations: '6.0'
        }, include: ['src/**/*.ts'] }));
        for (const file of ['vue/packages/element-plus/index.ts', 'vue/packages/icons-vue/src/index.ts',
            'vue/global.d.ts', 'vue/typings/components.d.ts', 'vue/typings/env.d.ts'])
        {
            write(`.fixture-ui/${file}`, 'export {};\n');
        }
        write('src/frontend/src/probe.vue', '<script setup lang="ts">const value = 1;</script><template>{{ value }}</template>\n');
        write('tools/probe.mjs', 'export const value = 1;\n');
        write('src/frontend/src/probe.ts', 'export const value = 1;\n');
        const cli = path.join(path.dirname(toolchain), 'node_modules/eslint/bin/eslint.js');
        const env = { ...process.env, FSUSBLOG_STYLE_ROOT: root, FSUSBLOG_USE_LOCAL_FSUSUI: '1',
            FSUSBLOG_LOCAL_FSUSUI_ROOT: path.join(root, '.fixture-ui') };
        const run = args => spawnSync(process.execPath, [cli, '--config', path.join(root, 'eslint.config.mjs'), ...args],
            { cwd: root, env, encoding: 'utf8' });
        const untyped = run(['--format', 'json', 'tools/probe.mjs']);
        assert.equal(untyped.status, 0, untyped.stderr);
        assert.deepEqual(JSON.parse(untyped.stdout)[0].messages, []);
        const absent = run(['--print-config', 'src/frontend/src/probe.ts']);
        assert.equal(absent.status, 2);
        assert.match(absent.stderr, /Cannot find module 'typescript'/u);
        const lock = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package-lock.json'), 'utf8'));
        const toolLock = JSON.parse(fs.readFileSync(path.join(path.dirname(toolchain), 'package-lock.json'), 'utf8'));
        const frontendCompiler = lock.packages['node_modules/typescript'];
        const toolCompiler = toolLock.packages['node_modules/typescript'];
        for (const field of ['version', 'resolved', 'integrity'])
        {
            assert.equal(toolCompiler[field], frontendCompiler[field]);
        }
        const compiler = fs.realpathSync(path.join(path.dirname(toolchain), 'node_modules/typescript'));
        const installed = JSON.parse(fs.readFileSync(path.join(compiler, 'package.json'), 'utf8'));
        assert.equal(lock.packages['node_modules/typescript'].version, '6.0.3');
        assert.equal(installed.version, lock.packages['node_modules/typescript'].version);
        fs.mkdirSync(path.join(root, 'src/frontend/node_modules'), { recursive: true });
        fs.symlinkSync(compiler, path.join(root, 'src/frontend/node_modules/typescript'), 'dir');
        const typed = run(['--print-config', 'src/frontend/src/probe.ts']);
        assert.equal(typed.status, 0, typed.stderr);
        const options = JSON.parse(typed.stdout).languageOptions.parserOptions;
        assert.equal(options.projectService, false);
        // The original CLI serializes parser-option arrays as numeric-key JSON objects.
        assert.deepEqual(Object.values(options.project),
            [path.join(root, 'src/frontend/.tmp/typecheck/tsconfig.fsusui-local.app.generated.json')]);
        assert.deepEqual(Object.values(options.extraFileExtensions), ['.vue']);
        assert.equal(options.tsconfigRootDir, path.join(root, 'src/frontend'));
        const checked = run(['--format', 'json', 'src/frontend/src/probe.ts']);
        assert.equal(checked.status, 0, checked.stderr);
        assert.deepEqual(JSON.parse(checked.stdout)[0].messages, []);
        const vue = run(['--print-config', 'src/frontend/src/probe.vue']);
        assert.equal(vue.status, 0, vue.stderr);
        const vueOptions = JSON.parse(vue.stdout).languageOptions.parserOptions;
        assert.equal(vueOptions.projectService, false);
        assert.deepEqual(vueOptions.project, options.project);
        env.FSUSBLOG_LOCAL_FSUSUI_ROOT = path.join(root, 'missing-ui');
        const invalid = run(['--print-config', 'src/frontend/src/probe.ts']);
        assert.equal(invalid.status, 2);
        assert.match(invalid.stderr, /does not contain the FsusUI source contract/u);
    });
});
