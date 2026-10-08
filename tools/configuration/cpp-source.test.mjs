import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cppCompileContext, inspectCppSource } from './check-cpp-source.mjs';

function fixture(action)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cpp-source-'));
    const compiler = execFileSync('which', ['g++'], { encoding: 'utf8' }).trim();
    function put(file, text)
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    }
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    const commit = () =>
    {
        git('add', '.');
        git('-c', 'user.name=CppSourceTest', '-c', 'user.email=cpp-source@example.invalid', 'commit', '-qm', 'test');
    };
    const database = path.join(root, '.tmp/cmake/native-basic/compile_commands.json');
    const configure = () => execFileSync('cmake', ['-S', root, '-B', path.dirname(database),
        `-DCMAKE_CXX_COMPILER=${compiler}`, '-G', 'Ninja'], { stdio: 'pipe' });
    const mutate = change =>
    {
        const entries = JSON.parse(fs.readFileSync(database, 'utf8'));
        change(entries[0]);
        fs.writeFileSync(database, JSON.stringify(entries));
    };
    try
    {
        put('.gitignore', '.tmp/\n');
        put('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.25)\nproject(FsusBlogNativeTooling LANGUAGES CXX)\nset(CMAKE_CXX_STANDARD 23)\nset(CMAKE_CXX_EXTENSIONS OFF)\nset(CMAKE_EXPORT_COMPILE_COMMANDS ON)\nadd_subdirectory(tests/native)\n');
        put('tests/native/CMakeLists.txt', 'add_library(SourceProbe STATIC ../../src/Example.cpp)\ntarget_include_directories(SourceProbe PRIVATE ../../src)\n');
        put('cmake/FsusWarnings.cmake', '# Source probe uses no additional warning flags.\n');
        put('config/development/native-tooling-style-policy.json', JSON.stringify({ standardTools: { cppLint: { compileDatabaseCandidates: ['.tmp/cmake/native-basic'] } } }));
        put('src/Value.hpp', '#pragma once\n#include <cstddef>\ninline constexpr int sourceValue = 3;\n');
        put('src/Example.cpp', '#include "Value.hpp"\nint ReadValue() { return sourceValue; }\n');
        put('src/Unrelated.hpp', '#pragma once\n');
        git('init', '-q');
        commit();
        configure();
        action({ root, put, commit, configure, database, mutate, compiler });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('actual CMake C++23 context checks both changed translation unit and included header with real compiler dependencies', () =>
{
    fixture(({ root }) =>
    {
        const result = inspectCppSource({ repositoryRoot: root, files: ['src/Example.cpp', 'src/Value.hpp'] });
        assert.equal(result.qualificationEligible, false);
        assert.equal(result.contexts.length, 1);
        const context = result.contexts[0];
        assert.deepEqual(context.files, ['src/Example.cpp', 'src/Value.hpp']);
        assert.deepEqual(context.localInputs.map(value => value.file), ['src/Example.cpp', 'src/Value.hpp']);
        assert.ok(context.compiler.version.includes('Free Software Foundation'));
        assert.match(context.compiler.digest, /^sha256:[a-f0-9]{64}$/u);
        assert.equal(context.observations.length, 3);
        assert.ok(context.closure.some(value => !value.path.startsWith(`${root}${path.sep}`)));
        assert.ok(context.observations.every(value => value.exitCode === 0));
        assert.ok(context.observations[2].arguments.includes('-fsyntax-only'));
        assert.equal(fs.existsSync(path.join(root, '.tmp/cmake/native-basic/tests/native/CMakeFiles/SourceProbe.dir/__/__/src/Example.cpp.o')), false);
    });
});

test('missing actual compile database and unrelated header contexts are strict refusals', () =>
{
    fixture(({ root, database }) =>
    {
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: ['src/Unrelated.hpp'] }), /compile context missing/u);
        fs.unlinkSync(database);
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: ['src/Value.hpp'] }), /compile context missing/u);
    });
});

test('missing dependency input and actual compiler syntax errors are strict refusals', () =>
{
    fixture(({ root, put, commit }) =>
    {
        fs.unlinkSync(path.join(root, 'src/Value.hpp'));
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: ['src/Example.cpp'] }), /C\+\+ compiler refused/u);
        put('src/Value.hpp', '#pragma once\ninline constexpr int sourceValue = 5;\n');
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: ['src/Example.cpp'] }), /HEAD\/index bytes/u);
        put('src/Value.hpp', '#pragma once\nthis is invalid C++;\n');
        commit();
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: ['src/Value.hpp'] }), /C\+\+ compiler refused/u);
    });
});

test('ordinary unsupported or incomplete compile arguments are refused before compiler execution', () =>
{
    fixture(({ root, database }) =>
    {
        const entry = JSON.parse(fs.readFileSync(database, 'utf8'))[0];
        for (const argument of ['-std=c++20', '-include', '@flags', '-fplugin=unknown'])
        {
            const unsupported = { ...entry, command: entry.command.replace('-std=c++23', argument) };
            assert.throws(() => cppCompileContext(root, unsupported), /unsupported|incomplete/u);
        }
        assert.throws(() => cppCompileContext(root, { ...entry, command: entry.command.replace(' -c ', ' ') }), /incomplete/u);
    });
});

test('missing compiler and incomplete CMake context retain strict refusal', () =>
{
    fixture(({ root, mutate }) =>
    {
        mutate(entry =>
        {
            entry.command = entry.command.replace(/^\S+/u, '/unavailable/g++');
        });
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: ['src/Value.hpp'] }), /compiler unavailable/u);
    });
    fixture(({ root }) =>
    {
        fs.unlinkSync(path.join(root, '.tmp/cmake/native-basic/CMakeCache.txt'));
        assert.throws(() => inspectCppSource({ repositoryRoot: root, files: ['src/Value.hpp'] }), /ENOENT/u);
    });
});
