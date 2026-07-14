import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  canonicalVitestId,
  resolveSingleHostWorkers,
  validateExactVitestExecution
} from '../../tools/test/run-frontend-vitest-rolling-shards.mjs'

test('single Vitest host consumes the complete admitted step grant', () => {
  assert.equal(resolveSingleHostWorkers({ FSUSBLOG_STEP_CPU_BUDGET: '3' }, 8), 3)
  assert.equal(resolveSingleHostWorkers({ FSUSBLOG_STEP_CPU_BUDGET: '12' }, 8), 8)
  assert.equal(resolveSingleHostWorkers({}, 6), 6)
})

test('exact execution validates file coverage, non-empty reports, unique test IDs, and pass status', () => {
  const file = '/repo/tests/frontend/unit/example.test.ts'
  const catalog = [{ file }]
  const report = {
    testResults: [{
      name: file,
      assertionResults: [
        { fullName: 'suite > first', status: 'passed' },
        { fullName: 'suite > second', status: 'passed' }
      ]
    }]
  }
  assert.deepEqual(validateExactVitestExecution(catalog, [report]), {
    catalogFileCount: 1, executedFileCount: 1, executedTestIdCount: 2, exactOnce: true
  })
  assert.match(canonicalVitestId(file, 'suite > first'), /#suite > first$/u)
  assert.throws(() => validateExactVitestExecution(catalog, [report, report]), /duplicateFiles=1[\s\S]*duplicateTests=2/u)
  assert.throws(() => validateExactVitestExecution(catalog, [{ testResults: [] }]), /missingFiles=1/u)
  assert.throws(() => validateExactVitestExecution(catalog, [{ testResults: [{ name: file, assertionResults: [] }] }]), /emptyFiles=1/u)
})

test('runner executes one complete host with JSON, JUnit, blob and authoritative coverage', () => {
  const source = fs.readFileSync('tools/test/run-frontend-vitest-rolling-shards.mjs', 'utf8')
  const bundle = fs.readFileSync('tools/test/bundles/run-bundle.mjs', 'utf8')
  assert.match(source, /'--filesOnly'/u)
  assert.match(source, /\.\.\.catalog\.map\(\(entry\) => entry\.file\)/u)
  assert.doesNotMatch(source, /--shard=/u)
  assert.match(source, /runSingleHost[\s\S]*?'--coverage\.all=false',[\s\S]*?'--coverage\.reporter=json'/u)
  assert.match(source, /--maxWorkers=\$\{workers\}/u)
  assert.doesNotMatch(source, /--no-isolate/u)
  assert.match(source, /seedFullCoverageUniverse[\s\S]*?'--coverage\.all=true'[\s\S]*?'--coverage\.reporter=json'/u)
  assert.match(source, /mergeAuthoritativeCoverageMaps[\s\S]*?authoritativeFiles\.has\(file\)/u)
  assert.doesNotMatch(source, /--mergeReports=\$\{blobRoot\}[^\n]*'--coverage'/u)
  assert.match(source, /--reporter=json'[^\n]*--reporter=junit'[^\n]*--reporter=blob'/u)
  assert.match(source, /--mergeReports=\$\{blobRoot\}/u)
  assert.match(source, /validateExactVitestExecution\(catalog, \[JSON\.parse/u)
  assert.match(source, /prepareTransformCache\(\)[\s\S]*?sealTransformCache\(cache\)/u)
  assert.match(source, /invalidateTransformCache\(cache, 'ordinary-failed'\)/u)
  assert.doesNotMatch(source, /runRollingShards|runShard|shardTotal/u)
  assert.match(bundle, /production-rolling\/summary\.json/u)
  assert.doesNotMatch(source, /retry|reuse|history/u)
})

test('single-host executed coverage stays local while the final merge retains production reporters', () => {
  const source = fs.readFileSync('tools/test/run-frontend-vitest-rolling-shards.mjs', 'utf8')
  const productionConfig = fs.readFileSync('src/frontend/vitest.config.ts', 'utf8')
  const rollingConfig = fs.readFileSync('src/frontend/vitest.production.config.ts', 'utf8')
  const shardStart = source.indexOf('async function runSingleHost')
  const shardEnd = source.indexOf('async function seedFullCoverageUniverse', shardStart)
  const shardSource = source.slice(shardStart, shardEnd)
  const mergeStart = source.indexOf('`--mergeReports=${blobRoot}`')
  const mergeEnd = source.indexOf('], { logFile:', mergeStart)
  const mergeSource = source.slice(mergeStart, mergeEnd)

  assert.match(shardSource, /--coverage\.all=false/u)
  assert.match(shardSource, /--coverage\.reporter=json/u)
  assert.doesNotMatch(shardSource, /coverage\.reporter=(?:text|html|lcov|cobertura)/u)
  assert.doesNotMatch(mergeSource, /coverage\.reporter=|--coverage/u)
  assert.match(source, /FSUSBLOG_VITEST_SINGLE_HOST: '1'/u)
  assert.match(rollingConfig, /FSUSBLOG_VITEST_SINGLE_HOST === '1'[\s\S]*?include: undefined/u)
  assert.match(productionConfig, /reporter: \['text', 'json-summary', 'html', 'lcov'\]/u)
  assert.match(productionConfig, /thresholds:[\s\S]*?lines:[\s\S]*?branches:[\s\S]*?functions:[\s\S]*?statements:/u)
})
