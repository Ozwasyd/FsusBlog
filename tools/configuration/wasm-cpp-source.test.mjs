import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectCppSource, cppCompileContext } from './check-cpp-source.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const header = 'src/frontend/wasm/aeds/include/font_theme_admin_pods.hpp';

function fixture(action)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-wasm-source-'));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    const commit = () =>
    {
        git('add', '.');
        git('-c', 'user.name=WasmSourceTest', '-c', 'user.email=wasm-source@example.invalid', 'commit', '-qm', 'test');
    };
    const database = variant => path.join(root, 'src/frontend/wasm', variant, 'compile_commands.json');
    const configure = variant =>
    {
        const build = path.dirname(database(variant));
        const query = path.join(build, '.cmake/api/v1/query');
        fs.mkdirSync(query, { recursive: true });
        for (const name of ['cmakeFiles-v1', 'toolchains-v1', 'codemodel-v2'])
        {
            fs.writeFileSync(path.join(query, name), '');
        }
        execFileSync('emcmake', ['cmake', '-S', path.join(root, 'src/frontend/wasm'), '-B', build,
            '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
            `-DWASM_SIMD=${variant === 'build-basic' ? 'OFF' : 'ON'}`, '-DFSUSBLOG_WASM_IMAGE_CODEC_ENABLE=OFF',
            `-DFSUSBLOG_WASM_OUTPUT_DIR=${root}/.tmp/output`], { stdio: 'pipe' });
    };
    try
    {
        const files = execFileSync('git', ['ls-files', 'src/frontend/wasm', 'config/development/native-tooling-style-policy.json'],
            { cwd: repository, encoding: 'utf8' }).trim().split('\n');
        for (const file of files)
        {
            const target = path.join(root, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(repository, file), target);
        }
        fs.writeFileSync(path.join(root, '.gitignore'), '.tmp/\nsrc/frontend/wasm/build-*/\n');
        git('init', '-q');
        commit();
        action({ root, database, configure, commit });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('original Wasm CMake basic and SIMD contexts bind real TU header sysroot and syntax observations', () =>
{
    fixture(({ root, configure, database }) =>
    {
        for (const variant of ['build-basic', 'build-simd'])
        {
            configure(variant);
        }
        const report = inspectCppSource({ repositoryRoot: root, files: [header] });
        assert.equal(report.qualificationEligible, false);
        assert.equal(report.contexts.length, 4);
        for (const context of report.contexts)
        {
            assert.deepEqual(context.files, [header]);
            assert.ok(context.localInputs.some(input => input.file === header));
            assert.ok(context.buildInputs.some(input => input.file === 'src/frontend/wasm/aeds/CMakeLists.txt'));
            assert.ok(context.wasmContext.externalInputs.some(input => input.path.endsWith('/Platform/Emscripten.cmake')));
            assert.match(context.wasmContext.compiler.clang.digest, /^sha256:[a-f0-9]{64}$/u);
            assert.ok(context.closure.some(input => input.path.startsWith(context.wasmContext.compiler.sysroot)));
            assert.ok(context.observations.every(observation => observation.exitCode === 0));
            assert.equal(fs.existsSync(context.compileContext.outputFile), false);
        }
        const entry = JSON.parse(fs.readFileSync(database('build-basic')))[0];
        assert.throws(() => cppCompileContext(root, entry), /unsupported C\+\+ compiler/u);
    });
});

test('original Wasm SOURCE refuses missing producer context tool or tracked input and unknown argv', () =>
{
    fixture(({ root, configure, database, commit }) =>
    {
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /compile context missing/u);
        configure('build-basic');
        const db = database('build-basic');
        const bytes = fs.readFileSync(db);
        const entries = JSON.parse(bytes);
        entries[0].command += ' -fplugin=unknown';
        fs.writeFileSync(db, JSON.stringify(entries));
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /unsupported C\+\+ compile argument/u);
        entries[0].command = JSON.parse(bytes)[0].command.replace(/^[^ ]+/u, '/unavailable/em++');
        fs.writeFileSync(db, JSON.stringify(entries));
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /unsupported C\+\+ compiler/u);
        fs.writeFileSync(db, bytes);
        const python = process.env.EMSDK_PYTHON;
        try
        {
            process.env.EMSDK_PYTHON = '/unavailable/python3';
            assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /Wasm Python interpreter unavailable/u);
        }
        finally
        {
            if (python === undefined)
            {
                delete process.env.EMSDK_PYTHON;
            }
            else
            {
                process.env.EMSDK_PYTHON = python;
            }
        }
        const input = path.join(root, 'src/frontend/wasm/aeds/CMakeLists.txt');
        const source = fs.readFileSync(input);
        fs.unlinkSync(input);
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /ENOENT/u);
        fs.writeFileSync(input, Buffer.concat([source, Buffer.from('\n# changed\n')]));
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /HEAD\/index bytes/u);
        fs.writeFileSync(input, source);
        fs.writeFileSync(input, source.toString('utf8').replace('PRIVATE -Oz', 'PRIVATE -O0'));
        commit();
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /original CMake replay differs/u);
        fs.writeFileSync(input, source);
        commit();
        const dependency = path.join(root, 'src/frontend/wasm/aeds/include/pod_views.hpp');
        const dependencyBytes = fs.readFileSync(dependency);
        fs.unlinkSync(dependency);
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /C\+\+ compiler refused/u);
        fs.writeFileSync(dependency, dependencyBytes);
        const headerFile = path.join(root, header);
        const headerBytes = fs.readFileSync(headerFile);
        fs.appendFileSync(headerFile, '\ninvalid C++ syntax;\n');
        commit();
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /C\+\+ compiler refused/u);
        fs.writeFileSync(headerFile, headerBytes);
        commit();
        const cache = path.join(path.dirname(db), 'CMakeCache.txt');
        fs.unlinkSync(cache);
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: [header] }), /ENOENT/u);
    });
});
