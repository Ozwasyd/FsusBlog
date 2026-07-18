import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    checkCodeIntent,
    evaluatePerformanceClaim,
    validateCommentPolicy,
    validateMarkerRegistration,
    validatePublicPerformanceText,
    validatePublicContract,
    validateRegistry,
    validateTrackedTodoIssues
} from '../../tools/governance/check-code-intent.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = path.join(root, 'tests/fixtures/governance/code-intent')
const registry = JSON.parse(fs.readFileSync(path.join(root, 'tests/governance/code-intent-registry.json'), 'utf8'))

function fixture(group, name) {
    return fs.readFileSync(path.join(fixtureRoot, group, name), 'utf8')
}

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

test('repository comments and registered intent references pass as one aggregate check', () => {
    const result = checkCodeIntent({ root })
    assert.deepEqual(result.errors, [])
    assert.ok(result.checkedFiles > 100)
    assert.ok(result.scopedFiles >= 7)
})

test('ownership intent is useful while an ordinary internal helper needs no comment', () => {
    assert.deepEqual(validateCommentPolicy({
        path: 'sample/ownership.cs',
        source: fixture('valid', 'ownership.cs'),
        registry,
        scoped: true
    }), [])
    assert.deepEqual(validateCommentPolicy({
        path: 'sample/internal-helper.cs',
        source: fixture('valid', 'internal-helper.cs'),
        registry,
        scoped: true
    }), [])
})

test('clang-format namespace closing comments are the only governed trailing-comment exception', () => {
    assert.deepEqual(validateCommentPolicy({
        path: 'sample/decoder.hpp',
        source: 'namespace FsusBlog::Aeds {\n} // namespace FsusBlog::Aeds\n',
        registry,
        scoped: true
    }), [])
    assert.match(validateCommentPolicy({
        path: 'sample/decoder.hpp',
        source: 'const int Value = 1; // namespace FsusBlog::Aeds\n',
        registry,
        scoped: true
    }).join('\n'), /trailing comments are prohibited/u)
})

test('standard intent markers cannot exist outside their registered source path', () => {
    const source = fixture('valid', 'ownership.cs')
    assert.match(validateMarkerRegistration({
        path: 'sample/ownership.cs',
        source,
        registeredMarkers: new Set()
    }).join('\n'), /intent marker OWNERSHIP: is not registered/u)
    assert.deepEqual(validateMarkerRegistration({
        path: 'sample/ownership.cs',
        source,
        registeredMarkers: new Set(['OWNERSHIP:'])
    }), [])
})

test('public entry documents reject unregistered absolute performance copy', () => {
    assert.deepEqual(validatePublicPerformanceText('README.md', 'A deployable content system.', registry), [])
    assert.match(
        validatePublicPerformanceText('README.md', 'The fastest possible high-performance system.', registry).join('\n'),
        /public performance claim/u
    )
})

test('URLs, dates, TODO text, and comment delimiters inside language strings are not comments', () => {
    const samples = [
        ['sample/string.cs', 'const string Text = "https://example.test/2026-07-18/TODO";'],
        ['sample/string.ts', "const text = `https://example.test/${flag ? `//nested` : ''}\n// 修改日期 2026-07-18`"],
        ['sample/regex.ts', "const pattern = /[`]|\\/\\/ 修改日期 2026-07-18/u"],
        ['sample/string.cpp', 'const char* text = R"tag(// 修改日期 2026-07-18)tag";'],
        ['sample/string.sh', 'value="${input#prefix}"\nprintf "%s" "$#"'],
        ['sample/string.sql', "SELECT '-- 2026-07-18' AS value;"]
    ]
    for (const [file, source] of samples) {
        assert.deepEqual(validateCommentPolicy({ path: file, source, registry, scoped: true }), [], file)
    }
})

test('comments inside a template expression remain governed', () => {
    const source = 'const text = `${value /* 修改日期 2026-07-18 */}`'
    assert.match(validateCommentPolicy({
        path: 'sample/template-expression.ts',
        source,
        registry,
        scoped: true
    }).join('\n'), /historical\/date narrative/u)
})

test('a tracked TODO requires the exact open issue and removal condition record', () => {
    const todoRegistry = clone(registry)
    todoRegistry.trackedTodos = [{
        id: 'fixture-removal',
        path: 'tests/fixtures/governance/code-intent/valid/tracked-todo.cs',
        issue: 1234,
        issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/1234',
        state: 'open',
        verifiedAtUtc: '2026-07-18T00:00:00Z',
        removalCondition: 'removal condition: delete after migration completes.'
    }]
    const source = fixture('valid', 'tracked-todo.cs')
    assert.deepEqual(validateCommentPolicy({
        path: todoRegistry.trackedTodos[0].path,
        source,
        registry: todoRegistry,
        scoped: true
    }), [])

    assert.deepEqual(validateRegistry(todoRegistry, {
        root,
        now: new Date('2026-07-19T00:00:00Z')
    }), [])
    assert.match(validateRegistry(todoRegistry, {
        root,
        now: new Date('2026-07-26T00:00:01Z')
    }).join('\n'), /live issue verification is expired/u)

    assert.deepEqual(validateTrackedTodoIssues(todoRegistry, {
        resolveIssue: (_repository, issue) => ({
            number: issue,
            state: 'OPEN',
            url: `https://github.com/Ozwasyd/FsusBlog/issues/${issue}`
        })
    }), [])
    assert.match(validateTrackedTodoIssues(todoRegistry, {
        resolveIssue: (_repository, issue) => ({
            number: issue,
            state: 'CLOSED',
            url: `https://github.com/Ozwasyd/FsusBlog/issues/${issue}`
        })
    }).join('\n'), /is not open/u)
    assert.match(validateTrackedTodoIssues(todoRegistry, {
        resolveIssue: () => { throw new Error('offline') }
    }).join('\n'), /failed closed/u)

    const staleRecord = clone(todoRegistry)
    staleRecord.trackedTodos[0].removalCondition = 'removal condition: deleted text.'
    assert.match(validateRegistry(staleRecord, {
        root,
        now: new Date('2026-07-19T00:00:00Z')
    }).join('\n'), /record is stale or missing/u)
})

test('historical, trailing, untracked TODO, redundant, absolute, and block debt fails independently', () => {
    const cases = [
        ['historical-comment.cs', /historical\/date narrative/u],
        ['trailing-comment.cs', /trailing comments are prohibited/u],
        ['todo-without-exit.cs', /TODO\/FIXME must use/u],
        ['redundant-comment.cs', /restates the following code/u],
        ['absolute-performance.cs', /unbounded performance claim/u],
        ['quantitative-performance.ts', /quantitative performance claim/u],
        ['long-block-comment.cs', /long design block comment/u]
    ]
    for (const [name, pattern] of cases) {
        const errors = validateCommentPolicy({
            path: `sample/${name}`,
            source: fixture('invalid', name),
            registry,
            scoped: true
        })
        assert.match(errors.join('\n'), pattern, name)
    }
})

test('all repository languages have structured public-documentation positive and negative fixtures', () => {
    const contracts = [
        {
            id: 'fixture-csharp',
            language: 'csharp',
            symbol: 'WireCursor',
            documentationStyle: 'xml-doc',
            file: 'public-contract.cs'
        },
        {
            id: 'fixture-typescript',
            language: 'typescript',
            symbol: 'resolveWireCursor',
            documentationStyle: 'tsdoc',
            file: 'public-contract.ts'
        },
        {
            id: 'fixture-javascript',
            language: 'javascript',
            symbol: 'resolveWireCursor',
            documentationStyle: 'jsdoc',
            file: 'public-contract.js'
        },
        {
            id: 'fixture-vue',
            language: 'vue',
            symbol: 'needsMfa',
            documentationStyle: 'vue-tsdoc',
            file: 'public-contract.vue'
        },
        {
            id: 'fixture-cpp',
            language: 'cpp',
            symbol: 'decode_frame',
            documentationStyle: 'doxygen',
            file: 'public-contract.hpp'
        },
        {
            id: 'fixture-shell',
            language: 'shell',
            symbol: 'case "$task" in',
            documentationStyle: 'shell-doc',
            file: 'public-contract.sh'
        },
        {
            id: 'fixture-cmake',
            language: 'cmake',
            symbol: 'add_fixture',
            documentationStyle: 'cmake-doc',
            file: 'public-contract.cmake'
        }
    ]
    for (const contract of contracts) {
        assert.deepEqual(validatePublicContract(contract, fixture('valid', contract.file)), [], contract.id)
        assert.match(
            validatePublicContract(contract, fixture('invalid', contract.file)).join('\n'),
            /requires adjacent|requires an adjacent/u,
            contract.id
        )
    }
    assert.match(validatePublicContract({
        id: 'fixture-empty-jsdoc',
        language: 'javascript',
        symbol: 'resolveWireCursor',
        documentationStyle: 'jsdoc'
    }, '/** value */\nexport function resolveWireCursor(value) { return value }').join('\n'), /meaningful boundary/u)
})

test('registry rejects a missing sensitive marker and stale source or evidence references', () => {
    const markerDrift = clone(registry)
    markerDrift.intents.find((entry) => entry.id === 'owned-aeds-frame-read-leases').anchors[1].marker = 'SECURITY-INVARIANT: deleted'
    assert.match(validateRegistry(markerDrift, { root }).join('\n'), /marker is stale or missing/u)

    const proximityDrift = clone(registry)
    proximityDrift.intents.find((entry) => entry.id === 'pod-binary-codec-batch').anchors[0].symbol = 'EncodeFeaturedArticles'
    assert.match(validateRegistry(proximityDrift, { root }).join('\n'), /beyond maxLineDistance/u)

    const sourceDrift = clone(registry)
    sourceDrift.intents[0].sourcePaths[0] = 'src/core/Algorithms/DeletedFrameWriter.cs'
    sourceDrift.intents[0].anchors[0].path = sourceDrift.intents[0].sourcePaths[0]
    sourceDrift.intents[0].anchors[1].path = sourceDrift.intents[0].sourcePaths[0]
    assert.match(validateRegistry(sourceDrift, { root }).join('\n'), /does not exist/u)

    const evidenceDrift = clone(registry)
    evidenceDrift.intents.find((entry) => entry.id === 'aeds-frame-cost').evidence.policy.anchor = 'deletedPolicy:'
    assert.match(validateRegistry(evidenceDrift, { root }).join('\n'), /policy anchor is stale/u)
})

test('Level S stays structural-only even when a receipt contains measured fields', () => {
    const structural = registry.intents.find((entry) => entry.id === 'owned-aeds-frame-read-leases')
    const result = evaluatePerformanceClaim(structural, {
        commitSha: 'a'.repeat(40),
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        machineIdentity: { cpu: 'cpu', os: 'os', runtime: 'runtime' },
        rawRounds: [[1]],
        statistics: { mean: 1, p50: 1, p95: 1, allocation: 0, iterations: 1, noise: 0 }
    }, 'a'.repeat(40))
    assert.deepEqual(result, {
        status: 'structural-only',
        measured: false,
        reasons: ['level-s-cannot-upgrade-to-measured']
    })
})

test('measured evidence cannot upgrade with a stale or wrong SHA', () => {
    const measured = registry.intents.find((entry) => entry.id === 'aeds-frame-cost')
    const receipt = {
        commitSha: 'a'.repeat(40),
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        machineIdentity: { cpu: 'cpu', os: 'os', runtime: 'runtime' },
        rawRounds: [[1, 2, 3]],
        statistics: { mean: 1, p50: 1, p95: 2, allocation: 0, iterations: 3, noise: 0.1 }
    }
    const stale = evaluatePerformanceClaim(measured, receipt, 'c'.repeat(40))
    assert.equal(stale.status, 'blocked')
    assert.ok(stale.reasons.includes('stale-or-wrong-commit'))

    const current = evaluatePerformanceClaim(measured, receipt, 'a'.repeat(40))
    assert.deepEqual(current, { status: 'measured', measured: true, reasons: [] })
})

test('route and capacity levels require their additional runtime dimensions', () => {
    const measured = registry.intents.find((entry) => entry.id === 'aeds-frame-cost')
    const expectedCommit = 'a'.repeat(40)
    const receipt = {
        commitSha: expectedCommit,
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        machineIdentity: { cpu: 'cpu', os: 'os', runtime: 'runtime' },
        rawRounds: [[1, 2, 3]],
        statistics: { mean: 1, p50: 1, p95: 2, allocation: 0, iterations: 3, noise: 0.1 }
    }
    const routeIntent = { ...measured, claimLevel: 'R' }
    assert.match(evaluatePerformanceClaim(routeIntent, receipt, expectedCommit).reasons.join('\n'), /route-dimension-unavailable/u)
    receipt.routeDimensions = {
        route: '/api/binary/article',
        protocol: 'aeds-v2',
        status: 200,
        cacheState: 'miss',
        errorFrame: false
    }
    assert.equal(evaluatePerformanceClaim(routeIntent, receipt, expectedCommit).status, 'measured')

    const capacityIntent = { ...measured, claimLevel: 'C' }
    assert.match(evaluatePerformanceClaim(capacityIntent, receipt, expectedCommit).reasons.join('\n'), /saturation-unavailable/u)
    receipt.capacity = {
        saturationObserved: true,
        targetIdentity: 'target-host',
        loadGeneratorIdentity: 'load-host',
        hardwareCounterAuthority: 'perf-stat'
    }
    assert.equal(evaluatePerformanceClaim(capacityIntent, receipt, expectedCommit).status, 'measured')
})
