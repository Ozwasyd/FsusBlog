import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = path.join(root, 'tools/style/check-native-tooling-style.mjs');
const sourcePolicy = JSON.parse(fs.readFileSync(path.join(root, 'config/development/native-tooling-style-policy.json'), 'utf8'));
const fixtureSource = path.join(root, 'tests/fixtures/native-tooling-style');

function WriteFile(fixtureRoot, relativePath, content)
{
    const target = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function CreateFixtureRoot()
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-native-tooling-style-'));
    for (const file of [
        '.clang-format',
        '.clang-tidy',
        '.cmake-format.yaml',
        '.editorconfig',
        '.markdownlint-cli2.jsonc',
        '.shellcheckrc',
        '.yamllint.yml'
    ])
    {
        fs.copyFileSync(path.join(root, file), path.join(fixtureRoot, file));
    }
    WriteFile(
        fixtureRoot,
        'config/development/native-tooling-style-policy.json',
        `${JSON.stringify(sourcePolicy, null, 4)}\n`
    );
    fs.mkdirSync(path.join(fixtureRoot, 'config/development'), { recursive: true });
    fs.copyFileSync(
        path.join(root, 'config/development/native-tooling-style-exceptions.json'),
        path.join(fixtureRoot, 'config/development/native-tooling-style-exceptions.json')
    );
    fs.copyFileSync(
        path.join(root, 'config/development/authoritative-development-docs.json'),
        path.join(fixtureRoot, 'config/development/authoritative-development-docs.json')
    );
    return fixtureRoot;
}

function CopyCase(fixtureRoot, caseName)
{
    fs.cpSync(path.join(fixtureSource, caseName), path.join(fixtureRoot, 'sample'), { recursive: true });
}

function RunChecker(fixtureRoot, files, extra = [], env = {})
{
    const fileArguments = files.flatMap((file) => ['--file', file]);
    return spawnSync(process.execPath, [
        checker,
        '--root', fixtureRoot,
        '--policy', 'config/development/native-tooling-style-policy.json',
        '--mode', 'changed',
        ...extra,
        ...fileArguments
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '1',
            ...env
        },
        timeout: 60_000
    });
}

function Output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

function WithFixture(callback)
{
    const fixtureRoot = CreateFixtureRoot();
    try
    {
        callback(fixtureRoot);
    }
    finally
    {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

const allFiles = [
    'sample/NativeStyle.cpp',
    'sample/CMakeLists.txt',
    'sample/ScriptStyle.sh',
    'sample/Workflow.yml',
    'sample/contract.json',
    'sample/Guide.md'
];

test('native tooling style governance publishes standard native and tooling configurations with CMake presets', () =>
{
    const clangFormat = fs.readFileSync(path.join(root, '.clang-format'), 'utf8');
    const clangTidy = fs.readFileSync(path.join(root, '.clang-tidy'), 'utf8');
    const warnings = fs.readFileSync(path.join(root, 'cmake/FsusWarnings.cmake'), 'utf8');
    const shellcheck = fs.readFileSync(path.join(root, '.shellcheckrc'), 'utf8');
    const markdownlint = JSON.parse(
        fs.readFileSync(path.join(root, '.markdownlint-cli2.jsonc'), 'utf8')
    );
    const formatEntry = fs.readFileSync(path.join(root, 'tools/format.sh'), 'utf8');
    const lintEntry = fs.readFileSync(path.join(root, 'tools/lint.sh'), 'utf8');
    const presets = JSON.parse(fs.readFileSync(path.join(root, 'CMakePresets.json'), 'utf8'));
    const exceptions = JSON.parse(
        fs.readFileSync(path.join(root, 'config/development/native-tooling-style-exceptions.json'), 'utf8')
    );

    assert.match(clangFormat, /IndentWidth: 4/u);
    assert.match(clangFormat, /BreakBeforeBraces: Allman/u);
    assert.match(clangFormat, /IncludeBlocks: Regroup/u);
    assert.match(clangTidy, /readability-identifier-naming/u);
    assert.match(clangTidy, /cppcoreguidelines-slicing/u);
    assert.match(clangTidy, /modernize-use-nullptr/u);
    assert.match(clangTidy, /performance-unnecessary-value-param/u);
    assert.doesNotMatch(clangTidy, /bugprone-\*/u);
    assert.match(clangTidy, /GlobalVariablePrefix: 's_'/u);
    assert.match(clangTidy, /GlobalVariableIgnoredRegexp: '\^t_/u);
    assert.match(warnings, /add_library\(FsusWarnings INTERFACE\)/u);
    assert.match(warnings, /FSUSBLOG_WARNINGS_AS_ERRORS/u);
    assert.match(shellcheck, /external-sources=true/u);
    assert.doesNotMatch(shellcheck, /enable=all/u);
    assert.match(markdownlint.$schema, /markdownlint-cli2\/v0\.23\.1/u);
    assert.equal(markdownlint.config.MD007.indent, 4);
    assert.equal(markdownlint.config.MD013, false);
    assert.equal(markdownlint.config.MD029.style, 'ordered');
    assert.equal(markdownlint.noInlineConfig, true);
    assert.ok(markdownlint.ignores.includes('docs/testing.generated.md'));
    assert.ok(markdownlint.ignores.includes('docs/reports/**'));
    assert.deepEqual(markdownlint.overrides, [
        {
            filter: ['.github/PULL_REQUEST_TEMPLATE.md'],
            config: { MD041: false },
            combine: 'merge'
        }
    ]);
    assert.match(formatEntry, /--operation format/u);
    assert.match(lintEntry, /native\|scripts\|docs/u);

    const configureNames = new Set(presets.configurePresets.map((preset) => preset.name));
    const buildNames = new Set(presets.buildPresets.map((preset) => preset.name));
    for (const name of ['native-basic', 'native-speed', 'native-asan-ubsan', 'native-fuzz'])
    {
        assert.ok(configureNames.has(name), `missing configure preset ${name}`);
    }
    assert.ok(buildNames.has('format'));
    assert.ok(buildNames.has('lint'));
    assert.ok(exceptions.exceptions.every((item) =>
        item.authorityExceptionId || item.authorityClassificationId || item.precedenceClass === 'language-syntax'));
    const searchScalarBoundary = exceptions.exceptions.find(
        (item) => item.id === 'search-index-utf8-scalar-owner'
    );
    assert.deepEqual(searchScalarBoundary.paths, [
        'docs/testing.generated.md',
        'src/backend/Services/SearchIndexService.Dictionary.cs',
        'tests/backend/Fixtures/backend-test-requirements.json',
        'tests/coverage-registry.json',
        'tools/check-backend-test-governance.mjs',
        'tools/test/csharp-source-mask.mjs',
        'tools/test/search-index-utf8-scalar-governance.mjs'
    ]);
    assert.ok(searchScalarBoundary.paths.every((path) => !path.includes('*')));
});

test('native tooling style preserves only the exact registered Migration NuGet lock owner', () =>
{
    const lockPath = 'tests/migration/packages.lock.json';
    const authority = JSON.parse(fs.readFileSync(
        path.join(root, 'config/development/authoritative-development-docs.json'), 'utf8'));
    const lockClassification = authority.pathClassifications.find((entry) => entry.id === 'lock');
    assert.equal(lockClassification.owner, 'PackageManager');
    assert.deepEqual(lockClassification.patterns.filter((entry) => entry.includes('packages.lock')), [lockPath]);
    assert.deepEqual(sourcePolicy.excludedPaths.filter((entry) => entry.includes('packages.lock')), [lockPath]);
    const ownerBytes = fs.readFileSync(path.join(root, lockPath));

    WithFixture((fixtureRoot) =>
    {
        WriteFile(fixtureRoot, lockPath, ownerBytes);
        for (const operation of [
            ['--operation', 'lint'],
            ['--operation', 'format', '--write']
        ])
        {
            const result = RunChecker(fixtureRoot, [lockPath], ['--domain', 'scripts', ...operation]);
            assert.equal(result.status, 0, Output(result));
            assert.match(result.stdout, /selected=0 checked=0 .*violations=0/u);
            assert.deepEqual(fs.readFileSync(path.join(fixtureRoot, lockPath)), ownerBytes);
        }
    });
});

test('native tooling style rejects unregistered paths resembling the Migration NuGet lock owner', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const neighbors = [
            'tests/migration/extra/packages.lock.json',
            'tests/migration/packages.lock.additional.json',
            'config/testing/packages.lock.json',
            'tests/migration/handwritten.json'
        ];
        for (const file of neighbors)
        {
            WriteFile(fixtureRoot, file, '{\n  "value": 1\n}');
        }
        const result = RunChecker(fixtureRoot, neighbors, ['--domain', 'scripts']);
        const output = Output(result);
        assert.notEqual(result.status, 0, output);
        assert.match(output, /selected=4 checked=4/u);
        for (const file of neighbors)
        {
            assert.ok(output.includes(file + ':1 json-format:'), output);
            assert.ok(output.includes(file + ':3 final-newline:'), output);
        }
    });
});

test('native tooling style governance accepts positive C++, CMake, Shell, YAML, JSON and Markdown fixtures', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid');
        const result = RunChecker(fixtureRoot, allFiles);
        assert.equal(result.status, 0, Output(result));
        assert.match(result.stdout, /selected=6 checked=6 .*violations=0/u);
    });
});

test('native tooling style governance aggregates all negative fixture categories before failing', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'invalid');
        const result = RunChecker(fixtureRoot, allFiles);
        const output = Output(result);
        assert.notEqual(result.status, 0);
        for (const rule of [
            'allman-brace',
            'cpp-type-name',
            'cpp-function-name',
            'cmake-function-name',
            'cmake-variable-name',
            'shell-strict-mode',
            'shell-cleanup-trap',
            'shell-function-name',
            'shell-local-name',
            'shell-export-name',
            'shell-quote',
            'indent',
            'yaml-duplicate-key',
            'json-duplicate-key',
            'json-format',
            'markdown-heading-level',
            'markdown-fence-language',
            'markdown-fence-balance',
            'markdown-list-indent',
            'markdown-link'
        ])
        {
            assert.match(output, new RegExp(` ${rule}:`, 'u'), `missing ${rule} in ${output}`);
        }
    });
});

test('native tooling style governance preserves registered C ABI spelling but rejects leakage into internal C++', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const externalSource = `extern "C" int decode_io_buffer()\n{\n    return 0;\n}\n`;
        WriteFile(fixtureRoot, 'src/frontend/wasm/aeds/src/exports.cpp', externalSource);
        const externalResult = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/exports.cpp']);
        assert.equal(externalResult.status, 0, Output(externalResult));

        WriteFile(
            fixtureRoot,
            'src/frontend/wasm/aeds/src/exports.cpp',
            `int internal_helper()\n{\n    return 0;\n}\n\n${externalSource}`
        );
        const leakedInternalResult = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/exports.cpp']);
        assert.notEqual(leakedInternalResult.status, 0);
        assert.match(Output(leakedInternalResult), /cpp-function-name: internal_helper/u);

        WriteFile(fixtureRoot, 'src/frontend/wasm/aeds/src/Internal.cpp', externalSource);
        const internalResult = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/Internal.cpp']);
        assert.notEqual(internalResult.status, 0);
        assert.match(Output(internalResult), /cpp-function-name: decode_io_buffer/u);
    });
});

test('native tooling style governance does not classify direct-initialized C++ locals as functions', () =>
{
    WithFixture((fixtureRoot) =>
    {
        WriteFile(
            fixtureRoot,
            'src/frontend/wasm/aeds/src/Internal.cpp',
            'int BuildValues()\n{\n    std::vector<int> values(4);\n    return static_cast<int>(values.size());\n}\n'
        );
        const result = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/Internal.cpp']);
        assert.equal(result.status, 0, Output(result));
        assert.doesNotMatch(Output(result), /cpp-function-name: values/u);
    });
});

test('native tooling style governance accepts header objects initialized from visible values', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const source = `struct Input
{
    int Value;
};
struct Reader
{
    explicit Reader(const Input&);
};
void Build(const Input& argument)
{
    const Input view{argument.Value};
    Reader reader(view);
    Reader fromArgument(argument);
    const Input& borrowed = argument;
    Reader fromReference(borrowed);
}
`;
        for (const extension of ['hpp', 'cpp'])
        {
            const file = `sample/Objects.${extension}`;
            WriteFile(fixtureRoot, file, source);
            const result = RunChecker(fixtureRoot, [file]);
            assert.equal(result.status, 0, Output(result));
            assert.doesNotMatch(Output(result), /cpp-function-name/u);
        }
    });
});

test('native tooling style governance rejects incorrectly named real C++ declarations', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const declarations = [
            'int bad_name(int value);',
            'int bad_name();',
            'int bad_name(int);',
            'int bad_name(int value)\n{\n    return value;\n}',
            'void Build()\n{\n    int bad_name(int value);\n}'
        ];
        for (const extension of ['hpp', 'cpp'])
        {
            for (const source of declarations)
            {
                const file = `sample/Declarations.${extension}`;
                WriteFile(fixtureRoot, file, `${source}\n`);
                const result = RunChecker(fixtureRoot, [file]);
                assert.notEqual(result.status, 0, Output(result));
                assert.match(Output(result), /cpp-function-name: bad_name/u);
            }
        }
    });
});

test('native tooling style governance keeps ambiguous C++ parameter syntax strict', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const declarations = [
            'Reader bad_name(Unknown);',
            'Reader bad_name(Input());',
            'void Build(int input)\n{\n    {\n        using input = int;\n        Reader bad_name(input);\n    }\n}',
            'void Build()\n{\n    {\n        const int Input = 1;\n    }\n    Reader bad_name(Input);\n}',
            'const int Input = 1;\ntemplate<typename Input>\nvoid Build()\n{\n    Reader bad_name(Input);\n}',
            'const int Input = 1;\ntemplate<typename Input>\nReader bad_name(Input);',
            'const int Input = 1;\ntemplate<typename Input> Reader bad_name(Input);',
            'const int Input = 1;\ntemplate<\n    typename Input\n>\nReader bad_name(Input);',
            'const int Input = 1;\nvoid Build()\n{\n    typedef int (*Input)();\n    Reader bad_name(Input);\n}',
            'const int Input = 1;\n#define Input int\nReader bad_name(Input);',
            '#if 0\nconst int input = 1;\n#endif\nReader bad_name(input);',
            '#define DECLARE_VALUE \\\n    const int input = 1;\nReader bad_name(input);',
            '/* const int input = 1; */\nReader bad_name(input);',
            'const char* text = R"raw(\nconst int input = 1;\n)raw";\nReader bad_name(input);'
        ];
        for (const source of declarations)
        {
            const file = 'sample/Ambiguous.hpp';
            WriteFile(fixtureRoot, file, `struct Input;\nstruct Reader;\nstruct Unknown;\nusing input = int;\n${source}\n`);
            const result = RunChecker(fixtureRoot, [file]);
            assert.notEqual(result.status, 0, Output(result));
            assert.match(Output(result), /cpp-function-name: bad_name/u);
        }
    });
});

test('native tooling style governance header classification retains required external tools', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const file = 'sample/Required.hpp';
        WriteFile(fixtureRoot, file, 'int ResolveValue();\n');
        const result = RunChecker(fixtureRoot, [file], ['--require-tools']);
        assert.notEqual(result.status, 0, Output(result));
        assert.match(Output(result), /missing-tool: clang-format is required/u);
    });
});

test('native tooling style governance formatter normalizes CRLF JSON and remains idempotent', () =>
{
    WithFixture((fixtureRoot) =>
    {
        WriteFile(
            fixtureRoot,
            'sample/contract.json',
            '{\r\n  "enabled": true,  \r\n  "limit": 9007199254740993\r\n}\r\n'
        );
        const first = RunChecker(fixtureRoot, ['sample/contract.json'], ['--operation', 'format', '--write']);
        assert.equal(first.status, 0, Output(first));
        const formatted = fs.readFileSync(path.join(fixtureRoot, 'sample/contract.json'), 'utf8');
        assert.equal(formatted, '{\n    "enabled": true,\n    "limit": 9007199254740993\n}\n');

        const second = RunChecker(fixtureRoot, ['sample/contract.json'], ['--operation', 'format', '--write']);
        assert.equal(second.status, 0, Output(second));
        assert.equal(fs.readFileSync(path.join(fixtureRoot, 'sample/contract.json'), 'utf8'), formatted);
    });
});

test('native tooling style governance Markdown formatter preserves natural-language wrapping and remains idempotent', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const paragraph = 'This intentionally long natural-language paragraph remains on one line because repository formatting must not introduce destructive prose wrapping.';
        WriteFile(
            fixtureRoot,
            'sample/Guide.md',
            `\uFEFF# Fixture guide\r\n\r\n${paragraph}  \r\n\r\n- Root\r\n    - Nested\r\n\r\n`
        );
        const first = RunChecker(fixtureRoot, ['sample/Guide.md'], ['--operation', 'format', '--write']);
        assert.equal(first.status, 0, Output(first));
        const formatted = fs.readFileSync(path.join(fixtureRoot, 'sample/Guide.md'), 'utf8');
        assert.equal(formatted, `# Fixture guide\n\n${paragraph}\n\n- Root\n    - Nested\n`);

        const second = RunChecker(fixtureRoot, ['sample/Guide.md'], ['--operation', 'format', '--write']);
        assert.equal(second.status, 0, Output(second));
        assert.equal(fs.readFileSync(path.join(fixtureRoot, 'sample/Guide.md'), 'utf8'), formatted);
    });
});

test('native tooling style governance limits JSON-with-comments syntax to registered configuration contracts', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const jsonWithComments = `{
    // Host configuration comment.
    "enabled": true,
}
`;
        const registered = 'src/backend/appsettings.json';
        WriteFile(fixtureRoot, registered, jsonWithComments);
        const accepted = RunChecker(fixtureRoot, [registered]);
        assert.equal(accepted.status, 0, Output(accepted));

        WriteFile(fixtureRoot, registered, jsonWithComments.replaceAll('    ', '  '));
        const formatted = RunChecker(fixtureRoot, [registered], ['--operation', 'format', '--write']);
        assert.equal(formatted.status, 0, Output(formatted));
        const formattedSource = fs.readFileSync(path.join(fixtureRoot, registered), 'utf8');
        assert.match(formattedSource, /^ {4}\/\/ Host configuration comment\.$/mu);
        const idempotent = RunChecker(fixtureRoot, [registered], ['--operation', 'format', '--write']);
        assert.equal(idempotent.status, 0, Output(idempotent));
        assert.equal(fs.readFileSync(path.join(fixtureRoot, registered), 'utf8'), formattedSource);

        const unregistered = 'sample/contract.json';
        WriteFile(fixtureRoot, unregistered, jsonWithComments);
        const rejected = RunChecker(fixtureRoot, [unregistered]);
        assert.notEqual(rejected.status, 0);
        assert.match(Output(rejected), /json-syntax/u);
    });
});

test('native tooling style governance invokes ShellCheck through its portable automatic rc lookup', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid');
        const bin = path.join(fixtureRoot, 'bin');
        const shellcheckCapture = path.join(fixtureRoot, 'shellcheck.args');
        const shfmtCapture = path.join(fixtureRoot, 'shfmt.args');
        WriteFile(
            fixtureRoot,
            'bin/shellcheck',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_SHELLCHECK_CAPTURE}"\n'
        );
        WriteFile(
            fixtureRoot,
            'bin/shfmt',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_SHFMT_CAPTURE}"\n'
        );
        fs.chmodSync(path.join(bin, 'shellcheck'), 0o755);
        fs.chmodSync(path.join(bin, 'shfmt'), 0o755);

        const result = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh'], [], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_SHELLCHECK_CAPTURE: shellcheckCapture,
            FSUSBLOG_SHFMT_CAPTURE: shfmtCapture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        });
        assert.equal(result.status, 0, Output(result));
        assert.equal(fs.readFileSync(shellcheckCapture, 'utf8'), 'sample/ScriptStyle.sh\n');
        assert.deepEqual(
            fs.readFileSync(shfmtCapture, 'utf8').trim().split('\n'),
            ['-d', '-i', '4', '-ci', 'sample/ScriptStyle.sh']
        );
    });
});

test('native tooling style governance formats headers directly and reserves clang-tidy compile commands for translation units', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const bin = path.join(fixtureRoot, 'bin');
        const tidyCapture = path.join(fixtureRoot, 'clang-tidy.args');
        WriteFile(
            fixtureRoot,
            'sample/Header.hpp',
            '#pragma once\n\nnamespace Sample\n{\nstruct Header\n{\n    int value;\n};\n} // namespace Sample\n'
        );
        WriteFile(fixtureRoot, 'bin/clang-format', '#!/usr/bin/env bash\nset -euo pipefail\n');
        WriteFile(
            fixtureRoot,
            'bin/clang-tidy',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_CLANG_TIDY_CAPTURE}"\n'
        );
        fs.chmodSync(path.join(bin, 'clang-format'), 0o755);
        fs.chmodSync(path.join(bin, 'clang-tidy'), 0o755);

        const result = RunChecker(fixtureRoot, ['sample/Header.hpp'], [
            '--domain', 'native',
            '--require-tools'
        ], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_CLANG_TIDY_CAPTURE: tidyCapture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        });
        assert.equal(result.status, 0, Output(result));
        assert.equal(fs.existsSync(tidyCapture), false);
    });
});

test('native tooling style governance derives clang-tidy target and sysroot from the active Emscripten compiler', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const bin = path.join(fixtureRoot, 'bin');
        const source = path.join(fixtureRoot, 'sample/Native.cpp');
        const tidyCapture = path.join(fixtureRoot, 'clang-tidy.args');
        WriteFile(fixtureRoot, 'sample/Native.cpp', 'int ResolveValue()\n{\n    return 1;\n}\n');
        WriteFile(fixtureRoot, 'bin/clang-format', '#!/usr/bin/env bash\nset -euo pipefail\n');
        WriteFile(
            fixtureRoot,
            'bin/em++',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' \'-target wasm32-unknown-emscripten --sysroot=/dynamic/emscripten/sysroot\'\n'
        );
        WriteFile(
            fixtureRoot,
            'bin/clang-tidy',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_CLANG_TIDY_CAPTURE}"\n'
        );
        for (const executable of ['clang-format', 'clang-tidy', 'em++'])
        {
            fs.chmodSync(path.join(bin, executable), 0o755);
        }
        WriteFile(
            fixtureRoot,
            '.tmp/cmake/native-basic/compile_commands.json',
            `${JSON.stringify([{
                directory: fixtureRoot,
                file: source,
                arguments: [path.join(bin, 'em++'), '-c', source]
            }], null, 4)}\n`
        );

        const result = RunChecker(fixtureRoot, ['sample/Native.cpp'], [
            '--domain', 'native',
            '--require-tools'
        ], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_CLANG_TIDY_CAPTURE: tidyCapture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        });
        assert.equal(result.status, 0, Output(result));
        const argumentsList = fs.readFileSync(tidyCapture, 'utf8').trim().split('\n');
        assert.ok(argumentsList.includes('--extra-arg-before=--target=wasm32-unknown-emscripten'));
        assert.ok(argumentsList.includes('--extra-arg-before=--sysroot=/dynamic/emscripten/sysroot'));
        assert.ok(argumentsList.includes('--extra-arg-before=-isystem/dynamic/emscripten/sysroot/include/fakesdl'));
        assert.ok(argumentsList.includes('--extra-arg-before=-isystem/dynamic/emscripten/sysroot/include/compat'));
    });
});

test('native tooling style governance portable C++ fallback accepts formatter continuations but rejects block indentation debt', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const valid = `namespace Sample
{
/**
 * Intent remains aligned by clang-format.
 */
int ResolveValue(
                 int first,
                 int second)
{
    const int Values[]{first,
                       second};
    return Values[0];
}
}
`;
        WriteFile(fixtureRoot, 'sample/Continuation.cpp', valid);
        const environment = { FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '1' };
        const accepted = RunChecker(fixtureRoot, ['sample/Continuation.cpp'], ['--domain', 'native'], environment);
        assert.equal(accepted.status, 0, Output(accepted));

        WriteFile(fixtureRoot, 'sample/Continuation.cpp', valid.replace('    return Values[0];', '  return Values[0];'));
        const rejected = RunChecker(fixtureRoot, ['sample/Continuation.cpp'], ['--domain', 'native'], environment);
        assert.notEqual(rejected.status, 0);
        assert.match(Output(rejected), /C\+\+ base indentation must be a multiple of 4 spaces/u);
    });
});

test('native tooling style governance invokes Markdownlint once for the complete explicit file batch', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid');
        WriteFile(fixtureRoot, 'sample/SecondGuide.md', '# Second guide\n');
        const bin = path.join(fixtureRoot, 'bin');
        const capture = path.join(fixtureRoot, 'markdownlint.args');
        WriteFile(
            fixtureRoot,
            'bin/markdownlint-cli2',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_MARKDOWNLINT_CAPTURE}"\n'
        );
        fs.chmodSync(path.join(bin, 'markdownlint-cli2'), 0o755);

        const result = RunChecker(fixtureRoot, ['sample/Guide.md', 'sample/SecondGuide.md'], [], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_MARKDOWNLINT_CAPTURE: capture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        });
        assert.equal(result.status, 0, Output(result));
        assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), [
            '--config',
            '.markdownlint-cli2.jsonc',
            '--no-globs',
            ':sample/Guide.md',
            ':sample/SecondGuide.md'
        ]);
    });
});

test('native tooling style governance aggregates every Markdownlint diagnostic from one batch', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid');
        WriteFile(fixtureRoot, 'sample/SecondGuide.md', '# Second guide\n');
        const bin = path.join(fixtureRoot, 'bin');
        WriteFile(
            fixtureRoot,
            'bin/markdownlint-cli2',
            `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' \
    'sample/Guide.md:2 error MD012/no-multiple-blanks Multiple consecutive blank lines' \
    'sample/SecondGuide.md:1:1 error MD041/first-line-h1 First line must be a top-level heading' >&2
exit 1
`
        );
        fs.chmodSync(path.join(bin, 'markdownlint-cli2'), 0o755);

        const result = RunChecker(fixtureRoot, ['sample/Guide.md', 'sample/SecondGuide.md'], [], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        });
        const output = Output(result);
        assert.notEqual(result.status, 0);
        assert.match(output, /sample\/Guide\.md:2 markdownlint-md012:/u);
        assert.match(output, /sample\/SecondGuide\.md:1 markdownlint-md041:/u);
        assert.match(output, /violations=2/u);
    });
});

test('native tooling style governance validates schema-bound front matter and malformed internal links without aborting', () =>
{
    WithFixture((fixtureRoot) =>
    {
        WriteFile(
            fixtureRoot,
            'sample/Guide.md',
            '---\nschema: fsusblog.markdown-document.v1\ntitle: Fixture guide\n---\n# Fixture guide\n'
        );
        const accepted = RunChecker(fixtureRoot, ['sample/Guide.md']);
        assert.equal(accepted.status, 0, Output(accepted));

        WriteFile(
            fixtureRoot,
            'sample/Guide.md',
            '---\ntitle: Missing schema\ntitle: Duplicate\n---\n# Fixture guide\n\n[bad encoding](%ZZ)\n[missing][contract]\n\n[contract]: missing.json\n'
        );
        const rejected = RunChecker(fixtureRoot, ['sample/Guide.md']);
        const output = Output(rejected);
        assert.notEqual(rejected.status, 0);
        assert.match(output, /markdown-front-matter: schema must be the first front matter field/u);
        assert.match(output, /markdown-front-matter: duplicate front matter key title/u);
        assert.match(output, /markdown-front-matter: front matter requires schema/u);
        assert.match(output, /markdown-link: relative link has invalid percent encoding/u);
        assert.match(output, /markdown-link: relative link does not exist: missing\.json/u);
    });
});

test('native tooling style governance excludes only registered generated and historical Markdown evidence', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const invalid = '# Guide\n\n[missing](missing.md)\n';
        WriteFile(fixtureRoot, 'docs/testing.generated.md', invalid);
        WriteFile(fixtureRoot, 'docs/reports/history.md', invalid);
        WriteFile(fixtureRoot, 'docs/testing.generated-extra.md', invalid);
        WriteFile(fixtureRoot, 'docs/report/history.md', invalid);

        const result = RunChecker(fixtureRoot, [
            'docs/testing.generated.md',
            'docs/reports/history.md',
            'docs/testing.generated-extra.md',
            'docs/report/history.md'
        ]);
        const output = Output(result);
        assert.notEqual(result.status, 0);
        assert.match(output, /selected=2 checked=2 baseline=0/u);
        assert.match(output, /docs\/testing\.generated-extra\.md/u);
        assert.match(output, /docs\/report\/history\.md/u);
        assert.doesNotMatch(output, /docs\/testing\.generated\.md:/u);
        assert.doesNotMatch(output, /docs\/reports\/history\.md:/u);
    });
});

test('native tooling style governance preserves registered ASP.NET environment keys without accepting internal leakage', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const source = `#!/usr/bin/env bash
set -euo pipefail

export ConnectionStrings__DefaultConnection="fixture"
`;
        WriteFile(fixtureRoot, 'tools/Fixture.sh', source);
        const registered = RunChecker(fixtureRoot, ['tools/Fixture.sh']);
        assert.equal(registered.status, 0, Output(registered));

        WriteFile(fixtureRoot, 'sample/ScriptStyle.sh', source);
        const unregistered = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh']);
        assert.notEqual(unregistered.status, 0);
        assert.match(Output(unregistered), /shell-export-name/u);

        WriteFile(
            fixtureRoot,
            'tools/Fixture.sh',
            `${source}\nUseValue()\n{\n    local ConnectionStrings__DefaultConnection="fixture"\n}\n`
        );
        const internalLeak = RunChecker(fixtureRoot, ['tools/Fixture.sh']);
        assert.notEqual(internalLeak.status, 0);
        assert.match(Output(internalLeak), /shell-local-name/u);
    });
});

test('native tooling style governance requires cleanup for allocations, not command inventory prose', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const inventory = `#!/usr/bin/env bash
set -euo pipefail

requiredCommands=(awk mktemp sort)
printf '%s\n' "${'${requiredCommands[@]}'}"
`;
        WriteFile(fixtureRoot, 'sample/ScriptStyle.sh', inventory);
        const accepted = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh']);
        assert.equal(accepted.status, 0, Output(accepted));

        WriteFile(
            fixtureRoot,
            'sample/ScriptStyle.sh',
            inventory.replace('requiredCommands=(awk mktemp sort)', 'temporaryFile="$(mktemp)"')
        );
        const rejected = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh']);
        assert.notEqual(rejected.status, 0);
        assert.match(Output(rejected), /shell-cleanup-trap/u);
    });
});

test('native tooling style governance does not confuse command substitution with an unquoted variable expansion', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const safe = `#!/usr/bin/env bash
set -euo pipefail

PrintValue()
{
    printf '%s\\n' "$(printf '%s' fixture)"
}
`;
        WriteFile(fixtureRoot, 'sample/ScriptStyle.sh', safe);
        const accepted = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh']);
        assert.equal(accepted.status, 0, Output(accepted));

        WriteFile(
            fixtureRoot,
            'sample/ScriptStyle.sh',
            safe.replace('"$(printf \'%s\' fixture)"', '"$(printf \'%s\' fixture)" $unsafeValue')
        );
        const rejected = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh']);
        assert.notEqual(rejected.status, 0);
        assert.match(Output(rejected), /shell-quote/u);
    });
});

test('native tooling style governance full mode invalidates an exact-content legacy baseline after an edit', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const legacy = '#!/usr/bin/env bash\n\nlegacy_name() {\n  local legacy_value=value\n}\n';
        WriteFile(fixtureRoot, 'legacy/Legacy.sh', legacy);
        const baselineValue = {
            schema: 'fsusblog.native-tooling-style-baseline.v1',
            sourceCommit: 'fixture',
            semantics: 'fixture',
            files: [
                {
                    path: 'legacy/Legacy.sh',
                    sha256: crypto.createHash('sha256').update(legacy).digest('hex')
                }
            ]
        };
        WriteFile(
            fixtureRoot,
            'config/development/native-tooling-style-baseline.json',
            `${JSON.stringify(baselineValue, null, 4)}\n`
        );

        const unchanged = RunChecker(fixtureRoot, ['legacy/Legacy.sh'], ['--mode', 'full']);
        assert.equal(unchanged.status, 0, Output(unchanged));
        assert.match(unchanged.stdout, /checked=0 baseline=1 violations=0/u);

        WriteFile(fixtureRoot, 'legacy/Legacy.sh', legacy.replace('value\n', 'changed\n'));
        const changed = RunChecker(fixtureRoot, ['legacy/Legacy.sh'], ['--mode', 'full']);
        assert.notEqual(changed.status, 0);
        assert.match(Output(changed), /shell-strict-mode/u);
        assert.match(Output(changed), /shell-function-name/u);
    });
});

test('native tooling style governance records the same reachable pure-format revisions in docs and blame metadata', () =>
{
    const blameIgnore = fs.readFileSync(path.join(root, '.git-blame-ignore-revs'), 'utf8');
    const issueBlock = blameIgnore
        .split('# Native/tooling pure mechanical format migrations for #1160.')[1]
        ?.split(/\n# /u)[0] ?? '';
    const blameRevisions = [...issueBlock.matchAll(/\b[0-9a-f]{40}\b/gu)]
        .map((match) => match[0]);

    const guide = fs.readFileSync(
        path.join(root, 'docs/development/native-tooling-style-enforcement.md'),
        'utf8'
    );
    const migrationSection = guide.match(
        /## Migration discipline([\s\S]*?)The same exact SHA set is registered/u
    )?.[1] ?? '';
    const documentedRevisions = [...migrationSection.matchAll(/\b[0-9a-f]{40}\b/gu)]
        .map((match) => match[0]);

    assert.ok(blameRevisions.length > 0, 'missing native tooling style governance blame-ignore revisions');
    assert.equal(new Set(blameRevisions).size, blameRevisions.length);
    assert.equal(new Set(documentedRevisions).size, documentedRevisions.length);
    assert.deepEqual([...documentedRevisions].sort(), [...blameRevisions].sort());

    for (const revision of blameRevisions)
    {
        const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(ancestor.status, 0, `unreachable native tooling style governance revision: ${revision}`);

        const subject = spawnSync('git', ['show', '-s', '--format=%s', revision], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(subject.status, 0, Output(subject));
        assert.match(subject.stdout.trim(), /^style\([^)]+\):/u);
    }
});

test('native tooling style governance unified wrappers preserve the checker result for each domain', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid');
        const environment = {
            ...process.env,
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '1'
        };
        const format = spawnSync(path.join(root, 'tools/format.sh'), [
            '--check',
            '--root', fixtureRoot,
            '--policy', 'config/development/native-tooling-style-policy.json',
            '--file', 'sample/contract.json'
        ], { cwd: fixtureRoot, encoding: 'utf8', env: environment });
        assert.equal(format.status, 0, Output(format));

        for (const [domain, file] of [
            ['native', 'sample/NativeStyle.cpp'],
            ['scripts', 'sample/ScriptStyle.sh'],
            ['docs', 'sample/Guide.md']
        ])
        {
            const lint = spawnSync(path.join(root, 'tools/lint.sh'), [
                domain,
                '--root', fixtureRoot,
                '--policy', 'config/development/native-tooling-style-policy.json',
                '--file', file
            ], { cwd: fixtureRoot, encoding: 'utf8', env: environment });
            assert.equal(lint.status, 0, Output(lint));
        }
    });
});

function FragmentDocument()
{
    const record = sourcePolicy.markdownCompatibilityAnchors[0];
    return `# API fragment fixture\n\n${record.anchors.map((entry) => `<a id="${entry.id}"></a>\n\n${entry.heading}\n\nMaintained section.\n`).join('\n')}`;
}

function ActualMarkdownlintEnvironment()
{
    const binary = (process.env.PATH ?? '').split(path.delimiter)
        .map((directory) => path.join(directory, 'markdownlint-cli2'))
        .find((file) =>
        {
            try { fs.accessSync(file, fs.constants.X_OK); return true; }
            catch { return false; }
        });
    assert.ok(binary, 'required actual Markdownlint CLI is unavailable; no parser qualification from mocks');
    return { FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0' };
}

test('native fragment compatibility retains nine raw actual CLI findings while binding complete parser spans', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const file = sourcePolicy.markdownCompatibilityAnchors[0].documentPath;
        const content = FragmentDocument();
        WriteFile(fixtureRoot, file, content);
        const environment = ActualMarkdownlintEnvironment();
        const raw = spawnSync('markdownlint-cli2', ['--config', '.markdownlint-cli2.jsonc', '--no-globs', `:${file}`], {
            cwd: fixtureRoot, env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 60_000
        });
        assert.equal(raw.status, 1, Output(raw));
        assert.equal([...raw.stderr.matchAll(/ error MD033\//gu)].length, 9, Output(raw));
        const result = RunChecker(fixtureRoot, [file], ['--require-tools'], environment);
        assert.equal(result.status, 0, Output(result));
        assert.match(result.stdout, /compatibility-aliases=9 raw-markdownlint-exit=1/u);
        assert.equal(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'), content);
        assert.equal(fs.readFileSync(path.join(fixtureRoot, '.markdownlint-cli2.jsonc'), 'utf8'), fs.readFileSync(path.join(root, '.markdownlint-cli2.jsonc'), 'utf8'));
    });
});

test('native fragment compatibility allows real line shifts without identity or numeric-line aliases', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const file = sourcePolicy.markdownCompatibilityAnchors[0].documentPath;
        WriteFile(fixtureRoot, file, FragmentDocument().replace('# API fragment fixture\n\n', '# API fragment fixture\n\nNew introductory prose.\n\n'));
        const result = RunChecker(fixtureRoot, [file], ['--require-tools'], ActualMarkdownlintEnvironment());
        assert.equal(result.status, 0, Output(result));
        assert.match(result.stdout, /compatibility-aliases=9 raw-markdownlint-exit=1/u);
    });
});

const firstFragment = sourcePolicy.markdownCompatibilityAnchors[0].anchors[0];
const firstAlias = `<a id="${firstFragment.id}"></a>`;
const firstBlock = `${firstAlias}\n\n${firstFragment.heading}`;
for (const [name, mutate] of [
    ['missing', (source) => source.replace(firstAlias, '')],
    ['duplicate', (source) => `${source}\n${firstAlias}\n`],
    ['unknown-id', (source) => source.replace(firstAlias, '<a id="unknown-fragment"></a>')],
    ['ASCII-case', (source) => source.replace('<a id="notification-stream-握手失败码"></a>', '<a id="Notification-stream-握手失败码"></a>')],
    ['Unicode-identity', (source) => source.replace(firstAlias, '<a id="生产就绪详情\u200b"></a>')],
    ['href-attribute', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}" href="https://example.invalid"></a>`)],
    ['event-attribute', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}" onclick="alert(1)"></a>`)],
    ['style-attribute', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}" style="display:none"></a>`)],
    ['extra-id-attribute', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}" id="other"></a>`)],
    ['visible-body', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}">text</a>`)],
    ['nested-body', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}"><b>text</b></a>`)],
    ['closing-name', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}"></b>`)],
    ['missing-close', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}">`)],
    ['self-close', (source) => source.replace(firstAlias, `<a id="${firstFragment.id}"/>`)],
    ['wrong-heading', (source) => source.replace(firstFragment.heading, '## Wrong associated section')],
    ['wrong-location', (source) => source.replace(firstBlock, `${firstAlias}\n\nIntervening body.\n\n${firstFragment.heading}`)],
    ['generated-location', (source) => source.replace(firstBlock, `<!-- FSUSBLOG-GENERATED:BEGIN fixture -->\n\n${firstBlock}`)],
    ['comment-hidden', (source) => source.replace(firstAlias, `<!--\n${firstAlias}\n-->`)],
    ['fence-hidden', (source) => source.replace(firstAlias, `\`\`\`html\n${firstAlias}\n\`\`\``)],
    ['inline-code', (source) => source.replace(firstAlias, `\`${firstAlias}\``)],
    ['quoted-location', (source) => source.replace(firstAlias, `> ${firstAlias}`)],
    ['same-line-extra', (source) => source.replace(firstAlias, `${firstAlias}<a id="other"></a>`)],
    ['extra-a', (source) => `${source}\n<a id="other"></a>\n`],
    ['mixed-HTML', (source) => `${source}\n<script>alert(1)</script>\n`]
])
{
    test(`native fragment actual source/parser refuses ${name}`, () =>
    {
        WithFixture((fixtureRoot) =>
        {
            const file = sourcePolicy.markdownCompatibilityAnchors[0].documentPath;
            WriteFile(fixtureRoot, file, mutate(FragmentDocument()));
            const result = RunChecker(fixtureRoot, [file], ['--require-tools'], ActualMarkdownlintEnvironment());
            assert.notEqual(result.status, 0, Output(result));
            assert.match(Output(result), /markdown-anchor-(?:source|span)|markdownlint-md033/u);
        });
    });
}

test('native fragment compatibility never carries to another actual document', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const file = 'docs/api/other-schema.md';
        WriteFile(fixtureRoot, file, FragmentDocument());
        const result = RunChecker(fixtureRoot, [file], ['--require-tools'], ActualMarkdownlintEnvironment());
        assert.notEqual(result.status, 0, Output(result));
        assert.equal([...Output(result).matchAll(/markdownlint-md033:/gu)].length, 9, Output(result));
        assert.doesNotMatch(result.stdout, /compatibility-aliases=/u);
    });
});

test('native fragment portable checks refuse parser admission while preserving structural findings', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const file = sourcePolicy.markdownCompatibilityAnchors[0].documentPath;
        WriteFile(fixtureRoot, file, FragmentDocument());
        const portable = RunChecker(fixtureRoot, [file]);
        assert.notEqual(portable.status, 0, Output(portable));
        assert.match(Output(portable), /actual Markdownlint parser spans are unavailable/u);
        WriteFile(fixtureRoot, file, FragmentDocument().replace(firstAlias, ''));
        const malformed = RunChecker(fixtureRoot, [file]);
        assert.notEqual(malformed.status, 0, Output(malformed));
        assert.match(Output(malformed), /markdown-anchor-source/u);
        assert.match(Output(malformed), /markdown-anchor-span/u);
    });
});

test('native fragment registry refuses unknown fields, wildcard paths and duplicate identities', () =>
{
    for (const mutate of [
        (record) => { record.allowAnyAnchor = true; },
        (record) => { record.documentPath = 'docs/api/*.md'; },
        (record) => { record.anchors[1].id = record.anchors[0].id; },
        (record) => { record.sourceRevision = 'caller-approved'; }
    ])
    {
        WithFixture((fixtureRoot) =>
        {
            const policy = structuredClone(sourcePolicy);
            mutate(policy.markdownCompatibilityAnchors[0]);
            WriteFile(fixtureRoot, 'config/development/native-tooling-style-policy.json', `${JSON.stringify(policy, null, 4)}\n`);
            const result = RunChecker(fixtureRoot, ['sample/Guide.md']);
            assert.notEqual(result.status, 0, Output(result));
            assert.match(Output(result), /markdown-anchor-policy/u);
        });
    }
});

test('native fragment rejects a text-only mock executable instead of granting span authority', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const file = sourcePolicy.markdownCompatibilityAnchors[0].documentPath;
        WriteFile(fixtureRoot, file, FragmentDocument());
        WriteFile(fixtureRoot, 'bin/markdownlint-cli2', '#!/usr/bin/env bash\nexit 0\n');
        fs.chmodSync(path.join(fixtureRoot, 'bin/markdownlint-cli2'), 0o755);
        const result = RunChecker(fixtureRoot, [file], ['--require-tools'], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            PATH: `${path.join(fixtureRoot, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
        });
        assert.notEqual(result.status, 0, Output(result));
        assert.match(Output(result), /markdown-anchor-span/u);
        assert.match(Output(result), /markdownlint:/u);
    });
});

test('native fragment actual CLI configuration errors cannot become compatibility admission', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const file = sourcePolicy.markdownCompatibilityAnchors[0].documentPath;
        WriteFile(fixtureRoot, file, FragmentDocument());
        WriteFile(fixtureRoot, '.markdownlint-cli2.jsonc', '{ "config": ');
        const result = RunChecker(fixtureRoot, [file], ['--require-tools'], ActualMarkdownlintEnvironment());
        assert.notEqual(result.status, 0, Output(result));
        assert.match(Output(result), /markdown-anchor-span/u);
        assert.match(Output(result), /markdownlint:/u);
    });
});

// These mock transport controls exercise refusal only, not Markdown parsing or CLI qualification.
for (const [name, mutate] of [
    ['column-only', (value) =>
    {
        value.findings[0].errorRange = [1];
    }],
    ['wrong-length', (value) =>
    {
        value.findings[0].errorRange[1] += 1;
    }],
    ['wrong-line', (value) =>
    {
        value.findings[0].lineNumber += 1;
    }],
    ['missing-finding', (value) =>
    {
        value.findings.shift();
    }],
    ['duplicate-finding', (value) =>
    {
        value.findings.push(structuredClone(value.findings[0]));
    }],
    ['foreign-file', (value) =>
    {
        value.findings[0].fileName = 'docs/api/other-schema.md';
    }],
    ['duplicate-report', (value) =>
    {
        value.reports = 2;
    }],
    ['raw-mismatch', (value) =>
    {
        value.extraRaw = 'unclassified original tool error';
    }],
    ['abnormal-terminal', (value) =>
    {
        value.status = 2;
    }]
])
{
    test(`native fragment mock span transport refuses ${name} without parser qualification`, () =>
    {
        WithFixture((fixtureRoot) =>
        {
            const file = sourcePolicy.markdownCompatibilityAnchors[0].documentPath;
            const content = FragmentDocument();
            WriteFile(fixtureRoot, file, content);
            const value = { findings: [], reports: 1, extraRaw: '', status: 1 };
            for (const [index, line] of content.split('\n').entries())
            {
                if (line.startsWith('<a id="'))
                {
                    value.findings.push({ fileName: file, lineNumber: index + 1, ruleNames: ['MD033', 'no-inline-html'],
                        ruleDescription: 'Inline HTML', errorDetail: 'Element: a', errorRange: [1, line.length - '</a>'.length], severity: 'error' });
                }
            }
            mutate(value);
            WriteFile(fixtureRoot, 'bin/package.json', JSON.stringify({ name: 'markdownlint-cli2', version: '0.23.1', type: 'module',
                exports: { '.': './markdownlint-cli2.mjs' }, bin: { 'markdownlint-cli2': './markdownlint-cli2' } }));
            WriteFile(fixtureRoot, 'bin/markdownlint-cli2', '#!/usr/bin/env node\n');
            fs.chmodSync(path.join(fixtureRoot, 'bin/markdownlint-cli2'), 0o755);
            WriteFile(fixtureRoot, 'bin/node_modules/markdownlint-cli2-formatter-default/index.js', 'module.exports = {};\n');
            WriteFile(fixtureRoot, 'bin/markdownlint-cli2.mjs', `
const value = ${JSON.stringify(value)};
export async function main(options) {
    for (const entry of value.findings) {
        options.logError(entry.fileName + ':' + entry.lineNumber + ':' + entry.errorRange[0]
            + ' error ' + entry.ruleNames.join('/') + ' ' + entry.ruleDescription + ' [' + entry.errorDetail + ']');
    }
    if (value.extraRaw) options.logError(value.extraRaw);
    for (let index = 0; index < value.reports; index += 1)
        options.logMessage('FSUSBLOG-MARKDOWNLINT-SPANS ' + JSON.stringify(value.findings));
    return value.status;
}
`);
            const result = RunChecker(fixtureRoot, [file], ['--require-tools'], {
                FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
                PATH: `${path.join(fixtureRoot, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
            });
            assert.notEqual(result.status, 0, Output(result));
            assert.match(Output(result), /markdown-anchor-span/u);
        });
    });
}


test('original Markdown adapter package boundary accepts equivalent bins and refuses foreign package authority', () =>
{
    for (const [name, change, success] of [
        ['bare', value => value, true],
        ['relative', value =>
        {
            value.bin['markdownlint-cli2'] = './markdownlint-cli2-bin.mjs';
        }, true],
        ['absolute', value =>
        {
            value.bin['markdownlint-cli2'] = '/markdownlint-cli2-bin.mjs';
        }, false],
        ['parent', value =>
        {
            value.bin['markdownlint-cli2'] = '../markdownlint-cli2-bin.mjs';
        }, false],
        ['version', value =>
        {
            value.version = '0.23.0';
        }, false],
        ['name', value =>
        {
            value.name = 'foreign';
        }, false],
        ['exports', value =>
        {
            value.exports['.'] = '../markdownlint-cli2.mjs';
        }, false],
        ['package-symlink', value => value, false],
        ['module-symlink', value => value, false]
    ])
    {
        WithFixture(fixtureRoot =>
        {
            const manifest = { name: 'markdownlint-cli2', version: '0.23.1', type: 'module',
                exports: { '.': './markdownlint-cli2.mjs' }, bin: { 'markdownlint-cli2': 'markdownlint-cli2-bin.mjs' } };
            change(manifest);
            WriteFile(fixtureRoot, 'bin/package.json', JSON.stringify(manifest));
            WriteFile(fixtureRoot, 'bin/markdownlint-cli2-bin.mjs', '#!/usr/bin/env node\n');
            WriteFile(fixtureRoot, 'bin/node_modules/markdownlint-cli2-formatter-default/index.js', 'module.exports = {};\n');
            WriteFile(fixtureRoot, 'bin/markdownlint-cli2.mjs', 'export async function main(options) { options.logMessage("mock adapter entered"); return 0; }\n');
            if (name === 'package-symlink' || name === 'module-symlink')
            {
                const file = name === 'package-symlink' ? 'package.json' : 'markdownlint-cli2.mjs';
                const original = path.join(fixtureRoot, 'bin', file);
                const outside = path.join(fixtureRoot, 'outside', file);
                WriteFile(fixtureRoot, `outside/${file}`, fs.readFileSync(original));
                fs.unlinkSync(original);
                fs.symlinkSync(outside, original);
            }
            const result = spawnSync(process.execPath, [checker, '--markdownlint-spans',
                path.join(fixtureRoot, 'bin/markdownlint-cli2-bin.mjs')], { cwd: fixtureRoot, encoding: 'utf8' });
            if (success)
            {
                assert.equal(result.status, 0, `${name}: ${Output(result)}`);
                assert.match(result.stdout, /mock adapter entered/u);
            }
            else
            {
                assert.notEqual(result.status, 0, name);
                assert.match(result.stderr, /structured formatter API is unavailable|module escaped/u);
                assert.doesNotMatch(result.stdout, /mock adapter entered/u);
            }
        });
    }
});
