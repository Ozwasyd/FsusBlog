import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8')
const readJson = (relativePath) => JSON.parse(read(relativePath))

function filesBelow(relativeDirectory) {
  const output = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else output.push(absolute)
    }
  }
  visit(path.join(root, relativeDirectory))
  return output
}

test('issue 1146 maps every removed Acceptance assertion target to lightweight test IDs', () => {
  const baseline = readJson('tests/issue-1146-acceptance-baseline.json')
  const migration = readJson('tests/issue-1146-retention-replacements.json')
  const central = readJson('tests/test-retention-replacements.json')

  assert.equal(baseline.records.length, baseline.expectedRecords)
  assert.equal(baseline.records.filter((record) => record.disposition === 'migrated').length, 31)
  assert.equal(baseline.records.filter((record) => record.disposition === 'browser-contract').length, 4)
  assert.equal(migration.deletedTests.length, migration.expectedDeletedTestIds)

  const baselineById = new Map(baseline.records.map((record) => [record.id, record]))
  const centralById = new Map(central.deletedTests.map((entry) => [entry.id, entry]))
  const allowedLayers = new Set([
    'api',
    'backend-integration',
    'component',
    'component-contract',
    'http-renderer',
    'router',
    'security-contract'
  ])

  for (const entry of migration.deletedTests) {
    const before = baselineById.get(entry.id)
    assert.ok(before, `missing frozen Acceptance record for ${entry.id}`)
    assert.equal(before.disposition, 'migrated', `${entry.id} must be marked migrated`)
    assert.deepEqual(entry.removedAssertionTargets, before.assertionTargets)
    assert.ok(entry.targetLayers.length > 0, `${entry.id} has no target layer`)
    assert.ok(entry.targetLayers.every((layer) => allowedLayers.has(layer)), `${entry.id} has an unknown target layer`)
    assert.ok(entry.replacementTestIds.length > 0, `${entry.id} has no replacement test ID`)

    const centralEntry = centralById.get(entry.id)
    assert.ok(centralEntry, `${entry.id} is absent from the central retention manifest`)
    assert.equal(centralEntry.path, entry.path)
    assert.deepEqual([...centralEntry.replacementTestIds].sort(), [...entry.replacementTestIds].sort())
  }

  const mappedIds = new Set(migration.deletedTests.map((entry) => entry.id))
  assert.deepEqual(
    baseline.records.filter((record) => record.disposition === 'migrated' && !mappedIds.has(record.id)),
    []
  )
})

test('Acceptance retains only four browser-unique public hydration and navigation scenarios', () => {
  const baseline = readJson('tests/issue-1146-acceptance-baseline.json')
  const removedFiles = [
    'tests/frontend/e2e/acceptance/admin-console.spec.ts',
    'tests/frontend/e2e/acceptance/auth-flows.spec.ts',
    'tests/frontend/e2e/acceptance/debug-passkey.spec.ts',
    'tests/frontend/e2e/acceptance/user-console.spec.ts'
  ]
  for (const relativePath of removedFiles) {
    assert.equal(existsSync(path.join(root, relativePath)), false, `${relativePath} must stay deleted`)
  }

  const retainedSources = new Map([
    ['tests/frontend/e2e/acceptance/public-routes.spec.ts', read('tests/frontend/e2e/acceptance/public-routes.spec.ts')],
    ['tests/frontend/e2e/acceptance/spa-routes.spec.ts', read('tests/frontend/e2e/acceptance/spa-routes.spec.ts')]
  ])
  const testCount = [...retainedSources.values()]
    .reduce((count, source) => count + (source.match(/\btest\('/gu)?.length ?? 0), 0)
  assert.equal(testCount, 4)

  for (const source of retainedSources.values()) {
    assert.match(source, /test\.describe\.configure\(\{ mode: 'serial'/u)
    assert.doesNotMatch(source, /for \(const viewport|DESKTOP_VIEWPORT|MOBILE_VIEWPORT/u)
  }

  for (const record of baseline.records.filter((item) => item.disposition === 'browser-contract')) {
    const title = record.assertionTargets[0].slice('behavior:'.length)
    assert.ok(retainedSources.get(record.path)?.includes(`test('${title}'`), `retained browser title missing: ${title}`)
  }
})

test('browser tests contain no direct SQL, Redis, Docker or child-process fixture control', () => {
  const forbidden = /node:child_process|\bdocker\b|\bpsql\b|\bredis-cli\b|FSUSBLOG_(?:PG|REDIS)_CONTAINER/u
  const violations = filesBelow('tests/frontend/e2e')
    .filter((file) => /\.(?:[cm]?[jt]s|tsx?)$/u.test(file))
    .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file))
  assert.deepEqual(violations, [])

  const scripts = readJson('src/frontend/package.json').scripts
  for (const name of ['check:acceptance:auth', 'check:acceptance:console']) {
    assert.match(scripts[name], /\bvitest run\b/u)
    assert.doesNotMatch(scripts[name], /playwright|ensure:wasm/u)
  }
})
