import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const checker = path.join(root, 'tools/style/check-native-tooling-style.mjs')
const sourcePolicy = JSON.parse(fs.readFileSync(path.join(root, 'config/development/native-tooling-style-policy.json'), 'utf8'))
const fixtureSource = path.join(root, 'tests/fixtures/issue-1160-native-tooling-style')

function WriteFile(fixtureRoot, relativePath, content)
{
    const target = path.join(fixtureRoot, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
}

function CreateFixtureRoot()
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-native-tooling-style-'))
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
        fs.copyFileSync(path.join(root, file), path.join(fixtureRoot, file))
    }
    WriteFile(
        fixtureRoot,
        'config/development/native-tooling-style-policy.json',
        `${JSON.stringify(sourcePolicy, null, 4)}\n`
    )
    fs.mkdirSync(path.join(fixtureRoot, 'config/development'), { recursive: true })
    fs.copyFileSync(
        path.join(root, 'config/development/native-tooling-style-exceptions.json'),
        path.join(fixtureRoot, 'config/development/native-tooling-style-exceptions.json')
    )
    fs.copyFileSync(
        path.join(root, 'config/development/authoritative-development-docs.json'),
        path.join(fixtureRoot, 'config/development/authoritative-development-docs.json')
    )
    return fixtureRoot
}

function CopyCase(fixtureRoot, caseName)
{
    fs.cpSync(path.join(fixtureSource, caseName), path.join(fixtureRoot, 'sample'), { recursive: true })
}

function RunChecker(fixtureRoot, files, extra = [], env = {})
{
    const fileArguments = files.flatMap((file) => ['--file', file])
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
    })
}

function Output(result)
{
    return `${result.stdout}\n${result.stderr}`
}

function WithFixture(callback)
{
    const fixtureRoot = CreateFixtureRoot()
    try
    {
        callback(fixtureRoot)
    }
    finally
    {
        fs.rmSync(fixtureRoot, { recursive: true, force: true })
    }
}

const allFiles = [
    'sample/NativeStyle.cpp',
    'sample/CMakeLists.txt',
    'sample/ScriptStyle.sh',
    'sample/Workflow.yml',
    'sample/contract.json',
    'sample/Guide.md'
]

test('issue 1160 publishes standard native and tooling configurations with CMake presets', () =>
{
    const clangFormat = fs.readFileSync(path.join(root, '.clang-format'), 'utf8')
    const clangTidy = fs.readFileSync(path.join(root, '.clang-tidy'), 'utf8')
    const warnings = fs.readFileSync(path.join(root, 'cmake/FsusWarnings.cmake'), 'utf8')
    const shellcheck = fs.readFileSync(path.join(root, '.shellcheckrc'), 'utf8')
    const markdownlint = JSON.parse(
        fs.readFileSync(path.join(root, '.markdownlint-cli2.jsonc'), 'utf8')
    )
    const formatEntry = fs.readFileSync(path.join(root, 'tools/format.sh'), 'utf8')
    const lintEntry = fs.readFileSync(path.join(root, 'tools/lint.sh'), 'utf8')
    const presets = JSON.parse(fs.readFileSync(path.join(root, 'CMakePresets.json'), 'utf8'))
    const exceptions = JSON.parse(
        fs.readFileSync(path.join(root, 'config/development/native-tooling-style-exceptions.json'), 'utf8')
    )

    assert.match(clangFormat, /IndentWidth: 4/u)
    assert.match(clangFormat, /BreakBeforeBraces: Allman/u)
    assert.match(clangFormat, /IncludeBlocks: Regroup/u)
    assert.match(clangTidy, /readability-identifier-naming/u)
    assert.match(clangTidy, /cppcoreguidelines-slicing/u)
    assert.match(clangTidy, /modernize-use-nullptr/u)
    assert.match(clangTidy, /performance-unnecessary-value-param/u)
    assert.doesNotMatch(clangTidy, /bugprone-\*/u)
    assert.match(clangTidy, /GlobalVariablePrefix: 's_'/u)
    assert.match(clangTidy, /GlobalVariableIgnoredRegexp: '\^t_/u)
    assert.match(warnings, /add_library\(FsusWarnings INTERFACE\)/u)
    assert.match(warnings, /FSUSBLOG_WARNINGS_AS_ERRORS/u)
    assert.match(shellcheck, /external-sources=true/u)
    assert.doesNotMatch(shellcheck, /enable=all/u)
    assert.match(markdownlint.$schema, /markdownlint-cli2\/v0\.23\.1/u)
    assert.equal(markdownlint.config.MD007.indent, 4)
    assert.equal(markdownlint.config.MD013, false)
    assert.equal(markdownlint.config.MD029.style, 'ordered')
    assert.equal(markdownlint.noInlineConfig, true)
    assert.ok(markdownlint.ignores.includes('docs/testing.generated.md'))
    assert.ok(markdownlint.ignores.includes('docs/reports/**'))
    assert.deepEqual(markdownlint.overrides, [
        {
            filter: ['.github/PULL_REQUEST_TEMPLATE.md'],
            config: { MD041: false },
            combine: 'merge'
        }
    ])
    assert.match(formatEntry, /--operation format/u)
    assert.match(lintEntry, /native\|scripts\|docs/u)

    const configureNames = new Set(presets.configurePresets.map((preset) => preset.name))
    const buildNames = new Set(presets.buildPresets.map((preset) => preset.name))
    for (const name of ['native-basic', 'native-speed', 'native-asan-ubsan', 'native-fuzz'])
    {
        assert.ok(configureNames.has(name), `missing configure preset ${name}`)
    }
    assert.ok(buildNames.has('format'))
    assert.ok(buildNames.has('lint'))
    assert.ok(exceptions.exceptions.every((item) =>
        item.authorityExceptionId || item.authorityClassificationId || item.precedenceClass === 'language-syntax'))
})

test('issue 1160 accepts positive C++, CMake, Shell, YAML, JSON and Markdown fixtures', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid')
        const result = RunChecker(fixtureRoot, allFiles)
        assert.equal(result.status, 0, Output(result))
        assert.match(result.stdout, /selected=6 checked=6 .*violations=0/u)
    })
})

test('issue 1160 aggregates all negative fixture categories before failing', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'invalid')
        const result = RunChecker(fixtureRoot, allFiles)
        const output = Output(result)
        assert.notEqual(result.status, 0)
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
            assert.match(output, new RegExp(` ${rule}:`, 'u'), `missing ${rule} in ${output}`)
        }
    })
})

test('issue 1160 preserves registered C ABI spelling but rejects leakage into internal C++', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const externalSource = `extern "C" int decode_io_buffer()\n{\n    return 0;\n}\n`
        WriteFile(fixtureRoot, 'src/frontend/wasm/aeds/src/exports.cpp', externalSource)
        const externalResult = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/exports.cpp'])
        assert.equal(externalResult.status, 0, Output(externalResult))

        WriteFile(
            fixtureRoot,
            'src/frontend/wasm/aeds/src/exports.cpp',
            `int internal_helper()\n{\n    return 0;\n}\n\n${externalSource}`
        )
        const leakedInternalResult = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/exports.cpp'])
        assert.notEqual(leakedInternalResult.status, 0)
        assert.match(Output(leakedInternalResult), /cpp-function-name: internal_helper/u)

        WriteFile(fixtureRoot, 'src/frontend/wasm/aeds/src/Internal.cpp', externalSource)
        const internalResult = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/Internal.cpp'])
        assert.notEqual(internalResult.status, 0)
        assert.match(Output(internalResult), /cpp-function-name: decode_io_buffer/u)
    })
})

test('issue 1160 does not classify direct-initialized C++ locals as functions', () =>
{
    WithFixture((fixtureRoot) =>
    {
        WriteFile(
            fixtureRoot,
            'src/frontend/wasm/aeds/src/Internal.cpp',
            'int BuildValues()\n{\n    std::vector<int> values(4);\n    return static_cast<int>(values.size());\n}\n'
        )
        const result = RunChecker(fixtureRoot, ['src/frontend/wasm/aeds/src/Internal.cpp'])
        assert.equal(result.status, 0, Output(result))
        assert.doesNotMatch(Output(result), /cpp-function-name: values/u)
    })
})

test('issue 1160 formatter normalizes CRLF JSON and remains idempotent', () =>
{
    WithFixture((fixtureRoot) =>
    {
        WriteFile(
            fixtureRoot,
            'sample/contract.json',
            '{\r\n  "enabled": true,  \r\n  "limit": 9007199254740993\r\n}\r\n'
        )
        const first = RunChecker(fixtureRoot, ['sample/contract.json'], ['--operation', 'format', '--write'])
        assert.equal(first.status, 0, Output(first))
        const formatted = fs.readFileSync(path.join(fixtureRoot, 'sample/contract.json'), 'utf8')
        assert.equal(formatted, '{\n    "enabled": true,\n    "limit": 9007199254740993\n}\n')

        const second = RunChecker(fixtureRoot, ['sample/contract.json'], ['--operation', 'format', '--write'])
        assert.equal(second.status, 0, Output(second))
        assert.equal(fs.readFileSync(path.join(fixtureRoot, 'sample/contract.json'), 'utf8'), formatted)
    })
})

test('issue 1160 Markdown formatter preserves natural-language wrapping and remains idempotent', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const paragraph = 'This intentionally long natural-language paragraph remains on one line because repository formatting must not introduce destructive prose wrapping.'
        WriteFile(
            fixtureRoot,
            'sample/Guide.md',
            `\uFEFF# Fixture guide\r\n\r\n${paragraph}  \r\n\r\n- Root\r\n    - Nested\r\n\r\n`
        )
        const first = RunChecker(fixtureRoot, ['sample/Guide.md'], ['--operation', 'format', '--write'])
        assert.equal(first.status, 0, Output(first))
        const formatted = fs.readFileSync(path.join(fixtureRoot, 'sample/Guide.md'), 'utf8')
        assert.equal(formatted, `# Fixture guide\n\n${paragraph}\n\n- Root\n    - Nested\n`)

        const second = RunChecker(fixtureRoot, ['sample/Guide.md'], ['--operation', 'format', '--write'])
        assert.equal(second.status, 0, Output(second))
        assert.equal(fs.readFileSync(path.join(fixtureRoot, 'sample/Guide.md'), 'utf8'), formatted)
    })
})

test('issue 1160 limits JSON-with-comments syntax to registered configuration contracts', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const jsonWithComments = `{
    // Host configuration comment.
    "enabled": true,
}
`
        const registered = 'src/backend/appsettings.json'
        WriteFile(fixtureRoot, registered, jsonWithComments)
        const accepted = RunChecker(fixtureRoot, [registered])
        assert.equal(accepted.status, 0, Output(accepted))

        WriteFile(fixtureRoot, registered, jsonWithComments.replaceAll('    ', '  '))
        const formatted = RunChecker(fixtureRoot, [registered], ['--operation', 'format', '--write'])
        assert.equal(formatted.status, 0, Output(formatted))
        const formattedSource = fs.readFileSync(path.join(fixtureRoot, registered), 'utf8')
        assert.match(formattedSource, /^    \/\/ Host configuration comment\.$/mu)
        const idempotent = RunChecker(fixtureRoot, [registered], ['--operation', 'format', '--write'])
        assert.equal(idempotent.status, 0, Output(idempotent))
        assert.equal(fs.readFileSync(path.join(fixtureRoot, registered), 'utf8'), formattedSource)

        const unregistered = 'sample/contract.json'
        WriteFile(fixtureRoot, unregistered, jsonWithComments)
        const rejected = RunChecker(fixtureRoot, [unregistered])
        assert.notEqual(rejected.status, 0)
        assert.match(Output(rejected), /json-syntax/u)
    })
})

test('issue 1160 invokes ShellCheck through its portable automatic rc lookup', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid')
        const bin = path.join(fixtureRoot, 'bin')
        const shellcheckCapture = path.join(fixtureRoot, 'shellcheck.args')
        const shfmtCapture = path.join(fixtureRoot, 'shfmt.args')
        WriteFile(
            fixtureRoot,
            'bin/shellcheck',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_SHELLCHECK_CAPTURE}"\n'
        )
        WriteFile(
            fixtureRoot,
            'bin/shfmt',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_SHFMT_CAPTURE}"\n'
        )
        fs.chmodSync(path.join(bin, 'shellcheck'), 0o755)
        fs.chmodSync(path.join(bin, 'shfmt'), 0o755)

        const result = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh'], [], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_SHELLCHECK_CAPTURE: shellcheckCapture,
            FSUSBLOG_SHFMT_CAPTURE: shfmtCapture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        })
        assert.equal(result.status, 0, Output(result))
        assert.equal(fs.readFileSync(shellcheckCapture, 'utf8'), 'sample/ScriptStyle.sh\n')
        assert.deepEqual(
            fs.readFileSync(shfmtCapture, 'utf8').trim().split('\n'),
            ['-d', '-i', '4', '-ci', 'sample/ScriptStyle.sh']
        )
    })
})

test('issue 1160 formats headers directly and reserves clang-tidy compile commands for translation units', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const bin = path.join(fixtureRoot, 'bin')
        const tidyCapture = path.join(fixtureRoot, 'clang-tidy.args')
        WriteFile(
            fixtureRoot,
            'sample/Header.hpp',
            '#pragma once\n\nnamespace Sample\n{\nstruct Header\n{\n    int value;\n};\n} // namespace Sample\n'
        )
        WriteFile(fixtureRoot, 'bin/clang-format', '#!/usr/bin/env bash\nset -euo pipefail\n')
        WriteFile(
            fixtureRoot,
            'bin/clang-tidy',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_CLANG_TIDY_CAPTURE}"\n'
        )
        fs.chmodSync(path.join(bin, 'clang-format'), 0o755)
        fs.chmodSync(path.join(bin, 'clang-tidy'), 0o755)

        const result = RunChecker(fixtureRoot, ['sample/Header.hpp'], [
            '--domain', 'native',
            '--require-tools'
        ], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_CLANG_TIDY_CAPTURE: tidyCapture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        })
        assert.equal(result.status, 0, Output(result))
        assert.equal(fs.existsSync(tidyCapture), false)
    })
})

test('issue 1160 derives clang-tidy target and sysroot from the active Emscripten compiler', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const bin = path.join(fixtureRoot, 'bin')
        const source = path.join(fixtureRoot, 'sample/Native.cpp')
        const tidyCapture = path.join(fixtureRoot, 'clang-tidy.args')
        WriteFile(fixtureRoot, 'sample/Native.cpp', 'int ResolveValue()\n{\n    return 1;\n}\n')
        WriteFile(fixtureRoot, 'bin/clang-format', '#!/usr/bin/env bash\nset -euo pipefail\n')
        WriteFile(
            fixtureRoot,
            'bin/em++',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' \'-target wasm32-unknown-emscripten --sysroot=/dynamic/emscripten/sysroot\'\n'
        )
        WriteFile(
            fixtureRoot,
            'bin/clang-tidy',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_CLANG_TIDY_CAPTURE}"\n'
        )
        for (const executable of ['clang-format', 'clang-tidy', 'em++'])
        {
            fs.chmodSync(path.join(bin, executable), 0o755)
        }
        WriteFile(
            fixtureRoot,
            '.tmp/cmake/native-basic/compile_commands.json',
            `${JSON.stringify([{
                directory: fixtureRoot,
                file: source,
                arguments: [path.join(bin, 'em++'), '-c', source]
            }], null, 4)}\n`
        )

        const result = RunChecker(fixtureRoot, ['sample/Native.cpp'], [
            '--domain', 'native',
            '--require-tools'
        ], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_CLANG_TIDY_CAPTURE: tidyCapture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        })
        assert.equal(result.status, 0, Output(result))
        const argumentsList = fs.readFileSync(tidyCapture, 'utf8').trim().split('\n')
        assert.ok(argumentsList.includes('--extra-arg-before=--target=wasm32-unknown-emscripten'))
        assert.ok(argumentsList.includes('--extra-arg-before=--sysroot=/dynamic/emscripten/sysroot'))
        assert.ok(argumentsList.includes('--extra-arg-before=-isystem/dynamic/emscripten/sysroot/include/fakesdl'))
        assert.ok(argumentsList.includes('--extra-arg-before=-isystem/dynamic/emscripten/sysroot/include/compat'))
    })
})

test('issue 1160 portable C++ fallback accepts formatter continuations but rejects block indentation debt', () =>
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
`
        WriteFile(fixtureRoot, 'sample/Continuation.cpp', valid)
        const environment = { FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '1' }
        const accepted = RunChecker(fixtureRoot, ['sample/Continuation.cpp'], ['--domain', 'native'], environment)
        assert.equal(accepted.status, 0, Output(accepted))

        WriteFile(fixtureRoot, 'sample/Continuation.cpp', valid.replace('    return Values[0];', '  return Values[0];'))
        const rejected = RunChecker(fixtureRoot, ['sample/Continuation.cpp'], ['--domain', 'native'], environment)
        assert.notEqual(rejected.status, 0)
        assert.match(Output(rejected), /C\+\+ base indentation must be a multiple of 4 spaces/u)
    })
})

test('issue 1160 invokes Markdownlint once for the complete explicit file batch', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid')
        WriteFile(fixtureRoot, 'sample/SecondGuide.md', '# Second guide\n')
        const bin = path.join(fixtureRoot, 'bin')
        const capture = path.join(fixtureRoot, 'markdownlint.args')
        WriteFile(
            fixtureRoot,
            'bin/markdownlint-cli2',
            '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "${FSUSBLOG_MARKDOWNLINT_CAPTURE}"\n'
        )
        fs.chmodSync(path.join(bin, 'markdownlint-cli2'), 0o755)

        const result = RunChecker(fixtureRoot, ['sample/Guide.md', 'sample/SecondGuide.md'], [], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            FSUSBLOG_MARKDOWNLINT_CAPTURE: capture,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        })
        assert.equal(result.status, 0, Output(result))
        assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), [
            '--config',
            '.markdownlint-cli2.jsonc',
            '--no-globs',
            ':sample/Guide.md',
            ':sample/SecondGuide.md'
        ])
    })
})

test('issue 1160 aggregates every Markdownlint diagnostic from one batch', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid')
        WriteFile(fixtureRoot, 'sample/SecondGuide.md', '# Second guide\n')
        const bin = path.join(fixtureRoot, 'bin')
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
        )
        fs.chmodSync(path.join(bin, 'markdownlint-cli2'), 0o755)

        const result = RunChecker(fixtureRoot, ['sample/Guide.md', 'sample/SecondGuide.md'], [], {
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '0',
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
        })
        const output = Output(result)
        assert.notEqual(result.status, 0)
        assert.match(output, /sample\/Guide\.md:2 markdownlint-md012:/u)
        assert.match(output, /sample\/SecondGuide\.md:1 markdownlint-md041:/u)
        assert.match(output, /violations=2/u)
    })
})

test('issue 1160 validates schema-bound front matter and malformed internal links without aborting', () =>
{
    WithFixture((fixtureRoot) =>
    {
        WriteFile(
            fixtureRoot,
            'sample/Guide.md',
            '---\nschema: fsusblog.markdown-document.v1\ntitle: Fixture guide\n---\n# Fixture guide\n'
        )
        const accepted = RunChecker(fixtureRoot, ['sample/Guide.md'])
        assert.equal(accepted.status, 0, Output(accepted))

        WriteFile(
            fixtureRoot,
            'sample/Guide.md',
            '---\ntitle: Missing schema\ntitle: Duplicate\n---\n# Fixture guide\n\n[bad encoding](%ZZ)\n[missing][contract]\n\n[contract]: missing.json\n'
        )
        const rejected = RunChecker(fixtureRoot, ['sample/Guide.md'])
        const output = Output(rejected)
        assert.notEqual(rejected.status, 0)
        assert.match(output, /markdown-front-matter: schema must be the first front matter field/u)
        assert.match(output, /markdown-front-matter: duplicate front matter key title/u)
        assert.match(output, /markdown-front-matter: front matter requires schema/u)
        assert.match(output, /markdown-link: relative link has invalid percent encoding/u)
        assert.match(output, /markdown-link: relative link does not exist: missing\.json/u)
    })
})

test('issue 1160 excludes only registered generated and historical Markdown evidence', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const invalid = '# Guide\n\n[missing](missing.md)\n'
        WriteFile(fixtureRoot, 'docs/testing.generated.md', invalid)
        WriteFile(fixtureRoot, 'docs/reports/history.md', invalid)
        WriteFile(fixtureRoot, 'docs/testing.generated-extra.md', invalid)
        WriteFile(fixtureRoot, 'docs/report/history.md', invalid)

        const result = RunChecker(fixtureRoot, [
            'docs/testing.generated.md',
            'docs/reports/history.md',
            'docs/testing.generated-extra.md',
            'docs/report/history.md'
        ])
        const output = Output(result)
        assert.notEqual(result.status, 0)
        assert.match(output, /selected=2 checked=2 baseline=0/u)
        assert.match(output, /docs\/testing\.generated-extra\.md/u)
        assert.match(output, /docs\/report\/history\.md/u)
        assert.doesNotMatch(output, /docs\/testing\.generated\.md:/u)
        assert.doesNotMatch(output, /docs\/reports\/history\.md:/u)
    })
})

test('issue 1160 preserves registered ASP.NET environment keys without accepting internal leakage', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const source = `#!/usr/bin/env bash
set -euo pipefail

export ConnectionStrings__DefaultConnection="fixture"
`
        WriteFile(fixtureRoot, 'tools/Fixture.sh', source)
        const registered = RunChecker(fixtureRoot, ['tools/Fixture.sh'])
        assert.equal(registered.status, 0, Output(registered))

        WriteFile(fixtureRoot, 'sample/ScriptStyle.sh', source)
        const unregistered = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh'])
        assert.notEqual(unregistered.status, 0)
        assert.match(Output(unregistered), /shell-export-name/u)

        WriteFile(
            fixtureRoot,
            'tools/Fixture.sh',
            `${source}\nUseValue()\n{\n    local ConnectionStrings__DefaultConnection="fixture"\n}\n`
        )
        const internalLeak = RunChecker(fixtureRoot, ['tools/Fixture.sh'])
        assert.notEqual(internalLeak.status, 0)
        assert.match(Output(internalLeak), /shell-local-name/u)
    })
})

test('issue 1160 does not confuse command substitution with an unquoted variable expansion', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const safe = `#!/usr/bin/env bash
set -euo pipefail

PrintValue()
{
    printf '%s\\n' "$(printf '%s' fixture)"
}
`
        WriteFile(fixtureRoot, 'sample/ScriptStyle.sh', safe)
        const accepted = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh'])
        assert.equal(accepted.status, 0, Output(accepted))

        WriteFile(
            fixtureRoot,
            'sample/ScriptStyle.sh',
            safe.replace('"$(printf \'%s\' fixture)"', '"$(printf \'%s\' fixture)" $unsafeValue')
        )
        const rejected = RunChecker(fixtureRoot, ['sample/ScriptStyle.sh'])
        assert.notEqual(rejected.status, 0)
        assert.match(Output(rejected), /shell-quote/u)
    })
})

test('issue 1160 full mode invalidates an exact-content legacy baseline after an edit', () =>
{
    WithFixture((fixtureRoot) =>
    {
        const legacy = '#!/usr/bin/env bash\n\nlegacy_name() {\n  local legacy_value=value\n}\n'
        WriteFile(fixtureRoot, 'legacy/Legacy.sh', legacy)
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
        }
        WriteFile(
            fixtureRoot,
            'config/development/native-tooling-style-baseline.json',
            `${JSON.stringify(baselineValue, null, 4)}\n`
        )

        const unchanged = RunChecker(fixtureRoot, ['legacy/Legacy.sh'], ['--mode', 'full'])
        assert.equal(unchanged.status, 0, Output(unchanged))
        assert.match(unchanged.stdout, /checked=0 baseline=1 violations=0/u)

        WriteFile(fixtureRoot, 'legacy/Legacy.sh', legacy.replace('value\n', 'changed\n'))
        const changed = RunChecker(fixtureRoot, ['legacy/Legacy.sh'], ['--mode', 'full'])
        assert.notEqual(changed.status, 0)
        assert.match(Output(changed), /shell-strict-mode/u)
        assert.match(Output(changed), /shell-function-name/u)
    })
})

test('issue 1160 records the same reachable pure-format revisions in docs and blame metadata', () =>
{
    const blameIgnore = fs.readFileSync(path.join(root, '.git-blame-ignore-revs'), 'utf8')
    const issueBlock = blameIgnore
        .split('# Native/tooling pure mechanical format migrations for #1160.')[1]
        ?.split(/\n# /u)[0] ?? ''
    const blameRevisions = [...issueBlock.matchAll(/\b[0-9a-f]{40}\b/gu)]
        .map((match) => match[0])

    const guide = fs.readFileSync(
        path.join(root, 'docs/development/native-tooling-style-enforcement.md'),
        'utf8'
    )
    const migrationSection = guide.match(
        /## Migration discipline([\s\S]*?)The same exact SHA set is registered/u
    )?.[1] ?? ''
    const documentedRevisions = [...migrationSection.matchAll(/\b[0-9a-f]{40}\b/gu)]
        .map((match) => match[0])

    assert.ok(blameRevisions.length > 0, 'missing issue 1160 blame-ignore revisions')
    assert.equal(new Set(blameRevisions).size, blameRevisions.length)
    assert.equal(new Set(documentedRevisions).size, documentedRevisions.length)
    assert.deepEqual([...documentedRevisions].sort(), [...blameRevisions].sort())

    for (const revision of blameRevisions)
    {
        const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], {
            cwd: root,
            encoding: 'utf8'
        })
        assert.equal(ancestor.status, 0, `unreachable issue 1160 revision: ${revision}`)

        const subject = spawnSync('git', ['show', '-s', '--format=%s', revision], {
            cwd: root,
            encoding: 'utf8'
        })
        assert.equal(subject.status, 0, Output(subject))
        assert.match(subject.stdout.trim(), /^style\([^)]+\):/u)
    }
})

test('issue 1160 unified wrappers preserve the checker result for each domain', () =>
{
    WithFixture((fixtureRoot) =>
    {
        CopyCase(fixtureRoot, 'valid')
        const environment = {
            ...process.env,
            FSUSBLOG_STYLE_DISABLE_EXTERNAL_TOOLS: '1'
        }
        const format = spawnSync(path.join(root, 'tools/format.sh'), [
            '--check',
            '--root', fixtureRoot,
            '--policy', 'config/development/native-tooling-style-policy.json',
            '--file', 'sample/contract.json'
        ], { cwd: fixtureRoot, encoding: 'utf8', env: environment })
        assert.equal(format.status, 0, Output(format))

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
            ], { cwd: fixtureRoot, encoding: 'utf8', env: environment })
            assert.equal(lint.status, 0, Output(lint))
        }
    })
})
