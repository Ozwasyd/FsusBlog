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
    assert.match(warnings, /add_library\(FsusWarnings INTERFACE\)/u)
    assert.match(warnings, /FSUSBLOG_WARNINGS_AS_ERRORS/u)
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
