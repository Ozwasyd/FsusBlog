import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createChangedCriticalStrykerConfig,
  selectChangedCriticalMutation
} from '../../tools/test/changed-critical-mutation.mjs'
import {
  createChangedCriticalMutationAuthority,
  validateChangedCriticalMutationAuthority
} from '../../tools/test/changed-critical-mutation-evidence.mjs'
import {
  executeChangedCriticalSelection
} from '../../tools/test/run-changed-critical-mutation.mjs'

const rawCatalog = readFileSync(new URL('../../config/testing/mutation/changed-critical-domains.v1.json', import.meta.url))
const catalog = JSON.parse(rawCatalog)
const fixtures = JSON.parse(readFileSync(
  new URL('./fixtures/changed-critical-mutation-selection.json', import.meta.url),
  'utf8'
))
const sourceState = {
  commit: 'a'.repeat(40),
  worktreeFingerprint: 'b'.repeat(64)
}

function select(changedPaths, selectedCatalog = catalog, selectedRawCatalog = rawCatalog) {
  return selectChangedCriticalMutation({
    catalog: selectedCatalog,
    rawCatalog: selectedRawCatalog,
    changedPaths,
    sourceState
  })
}

function report(statuses = ['Killed', 'Killed', 'Killed', 'Survived']) {
  return {
    schemaVersion: '2',
    thresholds: { high: 85, low: 70 },
    files: {
      '/repo/Integrity/ArticleRightsCanonicalHashV1.cs': {
        language: 'cs',
        source: 'public sealed class Subject {}',
        mutants: statuses.map((status, index) => ({ id: String(index + 1), status }))
      }
    }
  }
}

test('single-domain change selects only its exact mutate file and owned test filter', () => {
  const selection = select(fixtures.singleDomain)

  assert.equal(selection.status, 'selected')
  assert.deepEqual(selection.domains.map(({ id }) => id), ['article-rights-canonicalization'])
  assert.deepEqual(selection.mutateFiles, ['src/core/Integrity/ArticleRightsCanonicalHashV1.cs'])
  assert.match(selection.testFilter, /ArticleRightsCanonicalHashTests/u)
  assert.doesNotMatch(selection.testFilter, /PasskeyServiceTests/u)
})

test('cross-domain selection is deterministic, de-duplicated, and source-bound', () => {
  const forward = select(fixtures.crossDomain)
  const reverse = select([...fixtures.crossDomain].reverse())

  assert.equal(forward.closureDigest, reverse.closureDigest)
  assert.deepEqual(forward.mutateFiles, [
    'src/backend/Infrastructure/Auth/AccountSubjectHasher.cs',
    'src/core/Integrity/ArticleRightsCanonicalHashV1.cs'
  ])
  assert.deepEqual(forward.domains.map(({ id }) => id), [
    'article-rights-canonicalization',
    'authentication-session-passkey'
  ])
  assert.equal(new Set(forward.testOwners.map(({ id }) => id)).size, forward.testOwners.length)
})

test('critical source without a complete domain mapping fails closed with the path and missing fields', () => {
  const broken = structuredClone(catalog)
  broken.domains = broken.domains.map((domain) => ({
    ...domain,
    sourcePatterns: domain.sourcePatterns.filter((pattern) => !pattern.includes('Services/Security'))
  }))
  const rawBroken = Buffer.from(`${JSON.stringify(broken, null, 2)}\n`)

  assert.throws(
    () => select(fixtures.unmappedCritical, broken, rawBroken),
    /NewCriticalBoundary\.cs.*missing fields: domain, testOwners, mutationPolicy/u
  )
})

test('unrelated changes produce a structured empty selection and never start Stryker', () => {
  const selection = select(fixtures.unrelated)
  let starts = 0
  const run = executeChangedCriticalSelection({
    selection,
    spawnStryker: () => {
      starts += 1
      return { status: 0 }
    }
  })

  assert.equal(selection.status, 'empty')
  assert.deepEqual(selection.domains, [])
  assert.deepEqual(selection.mutateFiles, [])
  assert.equal(selection.testFilter, '')
  assert.equal(run.status, 'empty')
  assert.equal(run.strykerStarted, false)
  assert.equal(starts, 0)
})

test('generated config is run-bound and preserves reviewed mutation semantics', () => {
  const selection = select(fixtures.singleDomain)
  const config = createChangedCriticalStrykerConfig(selection, catalog)

  assert.deepEqual(config['stryker-config']['test-projects'], ['../../tests/backend/FsusBlog.Server.Tests.csproj'])
  assert.deepEqual(config['stryker-config'].mutate, ['Integrity/ArticleRightsCanonicalHashV1.cs'])
  assert.equal(
    config['stryker-config']['test-case-filter'],
    selection.projectClosures[0].testFilter
  )
  assert.deepEqual(config['stryker-config'].thresholds, { high: 85, low: 70, break: 70 })
  assert.equal(config['stryker-config']['break-on-initial-test-failure'], true)
})

test('authority binds source, catalog, config, selection, report, and mutant outcomes', () => {
  const selection = select(fixtures.singleDomain)
  const rawSelection = Buffer.from(`${JSON.stringify(selection, null, 2)}\n`)
  const config = createChangedCriticalStrykerConfig(selection, catalog)
  const rawConfig = Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
  const mutationReport = report()
  const rawReport = Buffer.from(`${JSON.stringify(mutationReport, null, 2)}\n`)
  const paths = {
    config: '.tmp/mutation/changed-critical/run/configs/src-core.json',
    report: '.tmp/mutation/changed-critical/run/physical/src-core/reports/changed-critical-mutation.json'
  }
  const runs = [{
    sourceProject: 'src/core',
    config,
    rawConfig,
    report: mutationReport,
    rawReport,
    paths
  }]
  const authority = createChangedCriticalMutationAuthority({
    selection,
    rawSelection,
    catalog,
    rawCatalog,
    runs,
    selectionPath: '.tmp/mutation/changed-critical/run/selection.json',
    runId: 'changed-critical-fixture',
    generatedAt: '2026-07-23T00:00:00.000Z'
  })

  assert.equal(authority.sourceState.commit, sourceState.commit)
  assert.equal(authority.catalog.sha256, createHash('sha256').update(rawCatalog).digest('hex'))
  assert.deepEqual(authority.mutateFiles, selection.mutateFiles)
  assert.equal(authority.testFilter, selection.testFilter)
  assert.deepEqual(authority.mutants, {
    executed: 4,
    killed: 3,
    survived: 1,
    timeout: 0,
    noCoverage: 0,
    compileError: 0,
    ignored: 0
  })
  assert.equal(authority.physicalRuns[0].score, 75)
})

test('authority validator rejects stale report and wrong source, config, catalog, or zero mutants', () => {
  const selection = select(fixtures.singleDomain)
  const rawSelection = Buffer.from(`${JSON.stringify(selection, null, 2)}\n`)
  const config = createChangedCriticalStrykerConfig(selection, catalog)
  const rawConfig = Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
  const mutationReport = report(['Killed', 'Killed', 'Killed'])
  const rawReport = Buffer.from(`${JSON.stringify(mutationReport, null, 2)}\n`)
  const paths = { config: 'config.json', report: 'report.json' }
  const runs = [{
    sourceProject: 'src/core',
    config,
    rawConfig,
    report: mutationReport,
    rawReport,
    paths
  }]
  const authority = createChangedCriticalMutationAuthority({
    selection,
    rawSelection,
    catalog,
    rawCatalog,
    runs,
    selectionPath: 'selection.json',
    runId: 'current',
    generatedAt: '2026-07-23T00:00:00.000Z'
  })
  const base = {
    authority,
    selection,
    rawSelection,
    catalog,
    rawCatalog,
    runs,
    expectedSourceState: sourceState
  }

  assert.throws(
    () => validateChangedCriticalMutationAuthority({
      ...base,
      runs: [{
        ...runs[0],
        rawReport: Buffer.from(`${JSON.stringify(report(['Killed', 'Survived']), null, 2)}\n`)
      }]
    }),
    /authority content mismatch/u
  )
  assert.throws(
    () => validateChangedCriticalMutationAuthority({
      ...base,
      expectedSourceState: { ...sourceState, commit: 'c'.repeat(40) }
    }),
    /source commit mismatch/u
  )
  assert.throws(
    () => validateChangedCriticalMutationAuthority({
      ...base,
      runs: [{ ...runs[0], rawConfig: Buffer.from('{}') }]
    }),
    /authority content mismatch/u
  )
  assert.throws(
    () => validateChangedCriticalMutationAuthority({ ...base, rawCatalog: Buffer.from('{}') }),
    /catalog digest mismatch/u
  )
  assert.throws(
    () => createChangedCriticalMutationAuthority({
      selection,
      rawSelection,
      catalog,
      rawCatalog,
      runs: [{
        ...runs[0],
        report: report(['Ignored', 'CompileError']),
        rawReport: Buffer.from(`${JSON.stringify(report(['Ignored', 'CompileError']), null, 2)}\n`)
      }],
      selectionPath: 'selection.json',
      runId: 'zero',
      generatedAt: '2026-07-23T00:00:00.000Z',
    }),
    /must execute at least one mutant/u
  )
})

test('checked-in nightly and fixed release mutation lanes remain present and unchanged in purpose', () => {
  const matrix = readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8')
  const defaults = JSON.parse(readFileSync(
    new URL('../../config/testing/mutation/default.json', import.meta.url),
    'utf8'
  ))
  const critical = JSON.parse(readFileSync(
    new URL('../../config/testing/mutation/critical.json', import.meta.url),
    'utf8'
  ))

  assert.match(matrix, /- id: backend-mutation\n/u)
  assert.match(matrix, /- id: release-mutation-critical-slice\n/u)
  assert.ok(defaults['stryker-config'].mutate.length > 1)
  assert.deepEqual(critical['stryker-config'].mutate, ['Algorithms/AedsEncoder.cs'])
})
