import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const adapterEntry = path.join(repositoryRoot, 'tools/test-inventory/ts-ast-adapter/index.mjs')
const temporaryRoots = []

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, contents)
}

function runAdapter(root, files) {
  const requestPath = path.join(root, '.adapter-request.json')
  writeFileSync(requestPath, JSON.stringify({ root, files }))
  const result = spawnSync(process.execPath, [adapterEntry, requestPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

test('vitest adapter extracts named, aliased and namespace registrations with suite hierarchy', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-vitest-'))
  temporaryRoots.push(root)
  write(root, 'tests/frontend/unit/vitest-mixed.test.ts', `
import { describe, it, test, expect } from 'vitest'
import { test as aliasedTest } from 'vitest'
import * as v from 'vitest'
import { login } from '../../../src/backend/auth'
import { createTestHelper } from '../../../support/test-helper'

describe('outer', () => {
  beforeEach(() => {})
  it('works', () => { expect(1).toBe(1) })
  test.skip('skipped case', () => {})
  test.only('only case', () => {})
  test.todo('todo case')
  test.fails('failing expectation', () => { throw new Error('x') })
  test.each([[1, 2], [3, 4]])('add %d + %d', (a, b) => { expect(a + b).toBe(a + b) })
  const rows = [[5, 6]]
  test.each(rows)('dynamic rows', () => {})
  test('duplicate title', () => {})
  test('duplicate title', () => {})
})
v.test('namespace case', () => {})
aliasedTest('alias case', () => {})
test('classifies symbols', () => { login('user'); createTestHelper(); expect(login).toBeDefined() })
`)
  const report = runAdapter(root, [{ path: 'tests/frontend/unit/vitest-mixed.test.ts', adapter: 'vitest' }])
  assert.equal(report.diagnostics.length, 0, JSON.stringify(report.diagnostics))
  const cases = report.testCases
  const byName = new Map(cases.map((entry) => [entry.displayName, entry]))
  assert.equal(cases.length, 13)
  assert.ok(byName.has('works'))
  assert.ok(byName.has('skipped case'))
  assert.equal(byName.get('skipped case').skipReason, 'skip')
  assert.ok(byName.get('only case').traits.some((trait) => trait.name === 'Only'))
  assert.ok(byName.get('todo case').traits.some((trait) => trait.name === 'Todo'))
  assert.ok(byName.get('failing expectation').traits.some((trait) => trait.name === 'Fails'))
  const rows = cases.filter((entry) => entry.displayName.startsWith('add '))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((entry) => entry.displayName), ['add 1 + 2', 'add 3 + 4'])
  assert.ok(rows.every((entry) => entry.kind === 'theory'))
  const dynamic = cases.find((entry) => entry.displayName === 'dynamic rows')
  assert.equal(dynamic.identity, 'dynamic')
  assert.equal(dynamic.dynamicCaseInfo.generationLocation.startsWith('tests/frontend/unit/vitest-mixed.test.ts:'), true)
  const duplicates = cases.filter((entry) => entry.displayName === 'duplicate title')
  assert.equal(duplicates.length, 2)
  assert.notEqual(duplicates[0].id, duplicates[1].id)
  assert.ok(byName.get('namespace case').adapter === 'vitest')
  assert.ok(byName.get('alias case').adapter === 'vitest')
  const works = byName.get('works')
  assert.equal(works.ownerSuite, 'outer')
  assert.ok(works.methodFacts.assertionCandidates.some((entry) => entry.methodName === 'toBe'))
  const symbols = byName.get('classifies symbols')
  assert.ok(symbols.methodFacts.invocations.some((entry) => entry.methodName === 'login' && entry.assemblyKind === 'production'))
  assert.ok(symbols.methodFacts.invocations.some((entry) => entry.methodName === 'createTestHelper' && entry.assemblyKind === 'test'))
  const suites = report.suiteRecords.filter((entry) => entry.suitePath === 'outer')
  assert.equal(suites.length, 1)
  assert.ok(suites[0].hooks.some((hook) => hook.name === 'beforeEach'))
})

test('node:test adapter supports default import, describe/it, options and skip/todo', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-nodetest-'))
  temporaryRoots.push(root)
  write(root, 'tests/tools/node-test-basic.test.mjs', `
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('suite', () => {
  it('case one', () => { assert.equal(1, 1) })
  it('case two', { skip: true }, () => {})
  it('case three', { timeout: 500 }, () => {})
})
test('top level', () => { assert.ok(true) })
`)
  const report = runAdapter(root, [{ path: 'tests/tools/node-test-basic.test.mjs', adapter: 'node-test' }])
  assert.equal(report.diagnostics.length, 0)
  const cases = report.testCases
  assert.equal(cases.length, 4)
  const byName = new Map(cases.map((entry) => [entry.displayName, entry]))
  assert.ok(byName.get('case one').ownerSuite === 'suite')
  assert.equal(byName.get('case two').skipReason, 'skip')
  assert.equal(byName.get('case three').timeoutMs, 500)
  assert.ok(byName.get('top level').ownerSuite === undefined)
  assert.ok(byName.get('case one').methodFacts.assertionCandidates.some((entry) => entry.methodName === 'equal'))
  assert.ok(report.suiteRecords.some((entry) => entry.suitePath === 'suite'))
})

test('playwright adapter extracts fixtures, describe, use annotations and skip', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-playwright-'))
  temporaryRoots.push(root)
  write(root, 'tests/frontend/e2e/playwright.spec.ts', `
import { test, expect } from '@playwright/test'
test.use({ baseURL: 'http://localhost' })
test.describe('browser suite', () => {
  test('has title', async ({ page }) => { await expect(page).toHaveTitle(/x/) })
  test.skip('skipped browser', async ({ page }) => {})
})
`)
  const report = runAdapter(root, [{ path: 'tests/frontend/e2e/playwright.spec.ts', adapter: 'playwright' }])
  assert.equal(report.diagnostics.length, 0)
  const cases = report.testCases
  assert.equal(cases.length, 2)
  const byName = new Map(cases.map((entry) => [entry.displayName, entry]))
  assert.equal(byName.get('has title').fixture, 'page')
  assert.ok(byName.get('has title').traits.some((trait) => trait.name === 'Async'))
  assert.equal(byName.get('skipped browser').skipReason, 'skip')
  assert.equal(byName.get('has title').ownerSuite, 'browser suite')
  assert.ok(report.suiteRecords.some((entry) => entry.suitePath === '<root>'))
  assert.ok(report.suiteRecords.find((entry) => entry.suitePath === '<root>').traits.some((trait) => trait.name === 'ProjectAnnotation'))
  assert.ok(report.suiteRecords.some((entry) => entry.suitePath === 'browser suite'))
})

test('behaviorTest registration is extracted with behavior identity traits', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-behavior-'))
  temporaryRoots.push(root)
  write(root, 'tests/tools/behavior-binding.test.mjs', `
import test from 'node:test'
import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'
behaviorTest('test-asset-audit-reconciliation', 'positive', 'behavior title', () => {})
`)
  const report = runAdapter(root, [{ path: 'tests/tools/behavior-binding.test.mjs', adapter: 'node-test' }])
  assert.equal(report.diagnostics.length, 0)
  assert.equal(report.testCases.length, 1)
  const entry = report.testCases[0]
  assert.equal(entry.kind, 'behavior-test')
  assert.equal(entry.displayName, 'behavior title')
  assert.ok(entry.traits.some((trait) => trait.name === 'BehaviorId' && trait.value === 'test-asset-audit-reconciliation'))
  assert.ok(entry.traits.some((trait) => trait.name === 'BehaviorKind' && trait.value === 'positive'))
})

test('local same-name non-test function is not misdetected as a test', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-shadow-'))
  temporaryRoots.push(root)
  write(root, 'tests/tools/local-test-fn.test.mjs', `
function test() { return 1 }
function it() { return 2 }
test()
it()
`)
  const report = runAdapter(root, [{ path: 'tests/tools/local-test-fn.test.mjs', adapter: 'vitest' }])
  assert.equal(report.testCases.length, 0)
  assert.equal(report.diagnostics.length, 0)
})

test('syntax errors fail closed with a precise file location', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-parse-'))
  temporaryRoots.push(root)
  write(root, 'tests/tools/broken.test.ts', "test('unclosed', () => {\n")
  const report = runAdapter(root, [{ path: 'tests/tools/broken.test.ts', adapter: 'vitest' }])
  assert.equal(report.testCases.length, 0)
  assert.ok(report.diagnostics.some((entry) => entry.severity === 'error' && entry.code === 'ts-parse-error' && entry.file === 'tests/tools/broken.test.ts'))
})

test('identical inputs produce byte-stable adapter reports', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-determinism-'))
  temporaryRoots.push(root)
  write(root, 'tests/frontend/unit/stable.test.ts', `
import { test, expect } from 'vitest'
test('stable case', () => { expect(1).toBe(1) })
`)
  const files = [{ path: 'tests/frontend/unit/stable.test.ts', adapter: 'vitest' }]
  const first = runAdapter(root, files)
  const second = runAdapter(root, files)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(first.testCases.length, 1)
  assert.ok(first.testCases[0].id.startsWith('vitest:tests/frontend/unit/stable.test.ts#'))
})

test('raw string and template titles never create false cases', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-ts-adapter-template-'))
  temporaryRoots.push(root)
  write(root, 'tests/tools/template.test.mjs', `
import test from 'node:test'
const prefix = 'dynamic'
test(\`literal \${prefix} title\`, () => {})
`)
  const report = runAdapter(root, [{ path: 'tests/tools/template.test.mjs', adapter: 'node-test' }])
  assert.equal(report.testCases.length, 1)
  const entry = report.testCases[0]
  assert.equal(entry.displayName, 'literal ${prefix} title')
  assert.equal(entry.identity, 'dynamic')
  assert.ok(entry.dynamicCaseInfo)
  assert.equal(entry.dynamicCaseInfo.generationLocation.startsWith('tests/tools/template.test.mjs:'), true)
})
