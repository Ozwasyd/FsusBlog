import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createStrykerAuthority,
  validateStrykerReport
} from '../../tools/test/check-stryker-report.mjs'

function report(statuses) {
  return {
    schemaVersion: '2',
    thresholds: { high: 85, low: 70 },
    files: {
      '/repo/Subject.cs': {
        language: 'cs',
        source: 'public sealed class Subject {}',
        mutants: statuses.map((status, index) => ({ id: String(index + 1), status }))
      }
    }
  }
}

test('mutation evidence rejects reports where no mutant was executed', () => {
  assert.throws(
    () => validateStrykerReport(report(['Ignored', 'CompileError'])),
    /must execute at least one mutant/u
  )
})

test('mutation evidence accepts an executed critical slice and reports status counts', () => {
  const summary = validateStrykerReport(report(['Killed', 'Killed', 'Survived', 'NoCoverage']))

  assert.deepEqual(summary, {
    schemaVersion: '2',
    executedMutants: 3,
    statuses: {
      CompileError: 0,
      Ignored: 0,
      Killed: 2,
      NoCoverage: 1,
      Survived: 1,
      Timeout: 0
    },
    thresholds: { high: 85, low: 70 }
  })
})

test('current-run authority binds raw report, config, scope, score, and producer identity', () => {
  const rawReport = Buffer.from(JSON.stringify(report([
    'Killed',
    'Killed',
    'Killed',
    'NoCoverage',
    'Ignored',
    'CompileError'
  ])))
  const config = {
    'stryker-config': {
      'test-case-filter': 'FullyQualifiedName~FsusBlog.Server.Tests.Unit.AedsEncoderTests',
      mutate: ['Algorithms/AedsEncoder.cs'],
      thresholds: { high: 85, low: 70, break: 70 }
    }
  }
  const rawConfig = Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
  const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
  }

  const authority = createStrykerAuthority({
    report: JSON.parse(rawReport),
    rawReport,
    reportPath: '.tmp/mutation/backend-critical/reports/backend-mutation-critical.json',
    config,
    rawConfig,
    configPath: 'config/testing/mutation/critical.json',
    tierId: 'release-mutation-critical-slice',
    runId: 'release-mutation-critical-slice-2026-07-11',
    sourceState,
    generatedAt: '2026-07-11T01:02:03.000Z'
  })

  assert.deepEqual(authority, {
    schema: 'fsusblog.stryker-authority.v1',
    status: 'success',
    tierId: 'release-mutation-critical-slice',
    sliceId: 'release-mutation-critical-slice',
    commandAlias: 'backend-mutation-critical',
    score: 75,
    mutantCount: 6,
    executedMutants: 3,
    statuses: {
      CompileError: 1,
      Ignored: 1,
      Killed: 3,
      NoCoverage: 1,
      Survived: 0,
      Timeout: 0
    },
    scope: ['Algorithms/AedsEncoder.cs'],
    testCaseFilter: 'FullyQualifiedName~FsusBlog.Server.Tests.Unit.AedsEncoderTests',
    thresholds: { high: 85, low: 70, break: 70 },
    rawReport: {
      path: '.tmp/mutation/backend-critical/reports/backend-mutation-critical.json',
      sha256: createHash('sha256').update(rawReport).digest('hex')
    },
    config: {
      path: 'config/testing/mutation/critical.json',
      sha256: createHash('sha256').update(rawConfig).digest('hex')
    },
    producer: {
      runId: 'release-mutation-critical-slice-2026-07-11',
      sourceState,
      generatedAt: '2026-07-11T01:02:03.000Z'
    }
  })
})

test('current-run authority rejects an unbound producer and config/report threshold drift', () => {
  const rawReport = Buffer.from(JSON.stringify(report(['Killed'])))
  const config = {
    'stryker-config': {
      'test-case-filter': 'FullyQualifiedName~AedsEncoderTests',
      mutate: ['Algorithms/AedsEncoder.cs'],
      thresholds: { high: 85, low: 70, break: 70 }
    }
  }
  const base = {
    report: JSON.parse(rawReport),
    rawReport,
    reportPath: 'report.json',
    config,
    rawConfig: Buffer.from(JSON.stringify(config)),
    configPath: 'config.json',
    tierId: 'release-mutation-critical-slice',
    generatedAt: '2026-07-11T01:02:03.000Z'
  }

  assert.throws(
    () => createStrykerAuthority({
      ...base,
      runId: '',
      sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
    }),
    /producer runId/u
  )
  assert.throws(
    () => createStrykerAuthority({
      ...base,
      config: {
        'stryker-config': {
          ...config['stryker-config'],
          thresholds: { high: 90, low: 70, break: 70 }
        }
      },
      runId: 'current-run',
      sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
    }),
    /high threshold does not match/u
  )
})

test('critical mutation lane publishes explicit raw and authority evidence', () => {
  const legacy = readFileSync(new URL('../../tools/test/legacy-test.sh', import.meta.url), 'utf8')
  const matrix = readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8')
  const tier = matrix.match(/  - id: release-mutation-critical-slice\n(?<body>[\s\S]*?)(?=\n  - id:)/u)?.groups?.body ?? ''

  assert.match(legacy, /--config "\$config_path"/u)
  assert.match(legacy, /--tier "\$authority_tier"/u)
  assert.match(legacy, /--out "\$authority_out"/u)
  assert.match(legacy, /release-mutation-critical-slice/u)
  assert.match(tier, /\.tmp\/mutation\/backend-critical\/reports\/backend-mutation-critical\.json/u)
  assert.match(tier, /\.tmp\/mutation\/backend-critical\/authority\.json/u)
})
