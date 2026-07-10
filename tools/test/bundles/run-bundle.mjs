#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../test-matrix/parse-matrix.mjs'
import { executeStepDag } from './step-dag.mjs'
import { executeLimitedWave } from './wave-runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const profileId = process.env.FSUSBLOG_LOCAL_PROFILE || 'production'
const bundleId = process.argv[2]
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
const profile = matrix.localProfiles?.[profileId]
const bundle = profile?.bundles?.find((entry) => entry.id === bundleId)
const outDir = path.join(root, `.tmp/local-${profileId}`, bundleId || 'unknown')
const summaryFile = path.join(outDir, 'summary.json')
const logDir = path.join(outDir, 'steps')
const startedAt = Date.now()

if (!bundleId || !bundle) throw new Error(`unknown ${profileId} bundle: ${String(bundleId)}`)
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(logDir, { recursive: true })

const memberEvidence = new Map(bundle.members.map((tierId) => [tierId, {
  status: 'success',
  durationMs: 0,
  testIds: [],
  artifactDigests: {}
}]))

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function digestFile(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function register(step, result, testIds = null, artifactFiles = []) {
  const ids = testIds ?? [`command:${step.id}`]
  const digestFiles = [result.logFile, ...artifactFiles].filter((file) => fs.existsSync(file))
  for (const tierId of step.members ?? []) {
    const evidence = memberEvidence.get(tierId)
    if (!evidence) throw new Error(`${step.id} references undeclared member ${tierId}`)
    evidence.durationMs += result.durationMs
    evidence.testIds.push(...ids)
    for (const file of digestFiles) evidence.artifactDigests[relative(file)] = digestFile(file)
  }
}

async function executeStep(step) {
  const logFile = path.join(logDir, `${step.id}.log`)
  fs.writeFileSync(logFile, '')
  const started = Date.now()
  console.log(`[local-production:${bundleId}] start ${step.id}`)
  const child = spawn('/bin/bash', ['-lc', step.command], {
    cwd: root,
    env: { ...process.env, ...(step.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  for (const [stream, writer] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', (chunk) => {
      fs.appendFileSync(logFile, chunk)
      writer.write(chunk)
    })
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }))
  })
  const result = { ...exit, durationMs: Date.now() - started, logFile }
  if (result.code !== 0 || result.signal) {
    throw new Error(`${step.id} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code}`})`)
  }
  console.log(`[local-production:${bundleId}] done ${step.id} durationMs=${result.durationMs}`)
  register(step, result, step.testIds, step.artifacts ?? [])
  return result
}

async function executeWave(steps) {
  await executeLimitedWave(steps, Math.min(profile.maxParallel, bundle.cpuUnits ?? profile.maxParallel), executeStep)
}

function bundleParallelism() {
  return Math.min(profile.maxParallel, bundle.cpuUnits ?? profile.maxParallel)
}

function commandStep(id, command, members, options = {}) {
  return { id, command, members, ...options }
}

function buildStaticSteps() {
  const frontendSummary = path.join(root, '.tmp/frontend/frontend-build.json')
  return [
    commandStep('services', 'tools/bootstrap-acceptance-env.sh --services-only', []),
    commandStep('frontend-build', 'cd src/frontend && FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1 npm run build:release', ['frontend-build'], {
      artifacts: [path.join(root, 'src/frontend/dist/index.html')]
    }),
    commandStep('backend-build', 'FSUSBLOG_DOTNET_BUILD_PARALLELISM=auto tools/build-with-data-env.sh dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Debug -warnaserror -v minimal /m /p:UseSharedCompilation=true /p:NuGetAudit=false', ['backend-build-governance'], {
      artifacts: [path.join(root, 'tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.dll')]
    }),
    commandStep('benchmark-build', 'FSUSBLOG_DOTNET_BUILD_PARALLELISM=auto tools/build-with-data-env.sh dotnet build benchmarks/core/FsusBlog.Core.Benchmarks.csproj -c Release -v minimal /m /p:UseSharedCompilation=true /p:NuGetAudit=false', []),
    commandStep('validate-matrix', 'node tools/run-test-matrix.mjs preflight', ['validate-matrix']),
    commandStep('public-hydration-fast', 'tools/test/lanes/public-hydration-fast.sh', ['public-hydration-fast']),
    commandStep('contract-fuzz', 'tools/test/lanes/contract-fuzz.sh', ['contract-fuzz']),
    commandStep('perception-redteam', 'tools/test/lanes/perception-v2-redteam.sh pr', ['perception-v2-redteam-pr']),
    commandStep('risk-control', 'tools/test/lanes/risk-control-test-matrix.sh', ['risk-control-test-matrix']),
    commandStep('perception-matrix', 'tools/test/lanes/perception-v2-test-matrix.sh', ['perception-v2-test-matrix'], { dependsOn: ['backend-build'] }),
    commandStep('sync-static-assets', [
      'rm -rf src/backend/wwwroot',
      'mkdir -p src/backend/wwwroot',
      'cp -R src/frontend/dist/. src/backend/wwwroot/',
      `mkdir -p ${shellQuote(path.dirname(frontendSummary))}`,
      `node -e ${shellQuote("const fs=require('node:fs');const f=process.argv[1];fs.writeFileSync(f,JSON.stringify({status:'success',schedulerRunId:process.env.FSUSBLOG_TEST_RUN_ID,generatedAt:new Date().toISOString()},null,2)+'\\n')")} ${shellQuote(frontendSummary)}`
    ].join(' && '), ['frontend-build'], { dependsOn: ['frontend-build'] }),
    commandStep('integrity-proof', 'tools/test/lanes/integrity-proof-verification.sh', ['integrity-proof-verification'], { dependsOn: ['backend-build'] }),
    commandStep('frontend-runtime-contracts', 'cd src/frontend && FSUSBLOG_COMMAND_MANIFEST_WORKERS=2 node ../../tools/test/run-command-manifest.mjs ../../tests/frontend/checks/runtime/manifest.json', ['frontend-runtime-contracts'], { dependsOn: ['sync-static-assets'] }),
    commandStep('frontend-static-governance', 'FSUSBLOG_COMMAND_MANIFEST_WORKERS=4 node tools/test/local-static-governance.mjs', ['frontend-static-governance'], { dependsOn: ['sync-static-assets'] }),
    commandStep('wasm-fuzz', 'tools/test/lanes/wasm-fuzz-regression.sh', ['wasm-fuzz-regression'], { dependsOn: ['frontend-build'] })
  ]
}

function trxAttribute(text, name) {
  const match = text.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))
  return match?.[1] ?? ''
}

function parseTrx(file) {
  const xml = fs.readFileSync(file, 'utf8')
  const definitions = new Map()
  for (const match of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu)) {
    const id = trxAttribute(match[1], 'id')
    const method = match[2].match(/<TestMethod\b([^>]*)\/>/u)?.[1] ?? ''
    const categories = [...match[2].matchAll(/TestCategory="([^"]+)"/gu)].map((entry) => entry[1])
    definitions.set(id, {
      id: `${trxAttribute(method, 'className')}.${trxAttribute(method, 'name')}`,
      categories
    })
  }
  return [...xml.matchAll(/<UnitTestResult\b([^>]*)\/?>(?:<\/UnitTestResult>)?/gu)].map((match) => {
    const definition = definitions.get(trxAttribute(match[1], 'testId')) ?? {}
    return {
      id: definition.id || trxAttribute(match[1], 'testName'),
      outcome: trxAttribute(match[1], 'outcome'),
      categories: definition.categories ?? []
    }
  }).filter((entry) => entry.id)
}

async function runBackendTests() {
  const trx = path.join(root, '.tmp/test-results/backend/production.trx')
  const coverageDir = path.join(root, '.tmp/coverage/backend/production')
  fs.mkdirSync(path.dirname(trx), { recursive: true })
  fs.mkdirSync(coverageDir, { recursive: true })
  const testStep = commandStep('dotnet-production-union', [
    'tools/build-with-data-env.sh dotnet test tests/backend/FsusBlog.Server.Tests.csproj',
    '-c Debug --no-build --no-restore -v minimal',
    '--filter "Category!=Performance"',
    `--logger "trx;LogFileName=${trx}"`,
    '"--collect:XPlat Code Coverage"',
    `--results-directory ${coverageDir}`,
    '-- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json,cobertura'
  ].join(' '), [])
  const result = await executeStep(testStep)
  await executeStep(commandStep('backend-coverage-summary',
    'node tools/coverage/summarize-cobertura.mjs .tmp/coverage/backend .tmp/coverage/backend-merged/Summary.json backend-cobertura', []))
  const tests = parseTrx(trx)
  const categoryMembers = new Map([
    ['backend-api-integration', 'ApiIntegration'],
    ['backend-auth-state-machine', 'SecurityStateMachine'],
    ['backend-concurrency', 'Concurrency'],
    ['backend-property', 'Property'],
    ['backend-golden', 'GoldenContract']
  ])
  const specialCategories = new Set([...categoryMembers.values(), 'Integration'])
  for (const tierId of bundle.members) {
    let selected = tests
    if (tierId === 'backend-unit') selected = tests.filter((entry) => entry.categories.every((category) => !specialCategories.has(category)))
    else if (categoryMembers.has(tierId)) selected = tests.filter((entry) => entry.categories.includes(categoryMembers.get(tierId)))
    if (selected.length === 0) throw new Error(`${tierId} received no executed backend test IDs`)
    register({ id: 'dotnet-production-union', members: [tierId] }, result, selected.map((entry) => `xunit:${entry.id}`), [
      trx,
      path.join(root, '.tmp/coverage/backend-merged/Summary.json')
    ])
  }
}

function listFiles(directory, predicate = () => true) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(child, predicate) : (predicate(child) ? [child] : [])
  })
}

function parseVitestReports(files) {
  const records = []
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const testFile of report.testResults ?? []) {
      for (const assertion of testFile.assertionResults ?? []) {
        records.push({
          id: `vitest:${assertion.fullName || assertion.title}`,
          status: assertion.status,
          file: testFile.name || file
        })
      }
    }
  }
  return records
}

async function runFrontendTests() {
  const step = commandStep('vitest-production-projects', [
    'cd src/frontend',
    'export FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD=0',
    'export FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD=0',
    'export FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD=0',
    'export FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD=0',
    'npx vitest run --config vitest.production.config.ts --coverage'
  ].join(' && '), [])
  const result = await executeStep(step)
  await executeStep(commandStep('frontend-coverage-summary',
    'FSUSBLOG_COVERAGE_SKIP_TESTS=1 tools/coverage/collect-frontend-coverage.sh', []))
  const reports = listFiles(path.join(root, '.tmp/test-results/vitest'), (file) => file.endsWith('.json'))
  const tests = parseVitestReports(reports)
  if (tests.length === 0 || tests.some((entry) => entry.status !== 'passed')) throw new Error('Vitest report is empty or contains non-passing tests')
  const summary = path.join(root, '.tmp/coverage/frontend/Summary.json')
  const byMember = {
    'frontend-unit-shard': tests.filter((entry) => entry.file.includes('/unit/')),
    'frontend-property-model-perf': tests.filter((entry) => /\/(?:property|model|benchmarks)\//u.test(entry.file)),
    'frontend-fast-summary': tests,
    'coverage-frontend': tests
  }
  for (const tierId of bundle.members) {
    const selected = byMember[tierId] ?? []
    if (selected.length === 0) throw new Error(`${tierId} received no executed Vitest IDs`)
    register({ id: 'vitest-production-projects', members: [tierId] }, result, selected.map((entry) => entry.id), [summary, ...reports])
  }
}

function runtimeWaves() {
  const riskMembers = ['acceptance', 'visual-public', 'visual-console', 'visual', 'ux-viewport-smoke']
  return [
    [
      commandStep('bootstrap', 'FSUSBLOG_RUNTIME_NO_BUILD=1 tools/bootstrap-acceptance-env.sh', ['bootstrap']),
      commandStep('static-governance', 'tools/test/lanes/static-governance.sh', ['static-governance'])
    ],
    [
      commandStep('runtime-integration', 'FSUSBLOG_SKIP_BACKEND_INTEGRATION_TESTS=1 tools/test/lanes/runtime-integration.sh', ['integration']),
      commandStep('release-public', 'tools/test/lanes/release-public.sh', ['release']),
      commandStep('endpoint-depth', 'tools/test/lanes/endpoint-depth.sh', ['endpoint-depth']),
      commandStep('security-runtime', 'FSUSBLOG_SKIP_ZAP=1 tools/test/lanes/security-runtime.sh', ['security']),
      commandStep('zap-baseline', 'tools/security/run-zap-baseline.sh', ['security']),
      commandStep('ux-risk-matrix', 'node tools/ux/run-local-production-risk.mjs', riskMembers),
      commandStep('cross-stack', 'tools/test/legacy-test.sh cross-stack-contract', ['cross-stack-contract']),
      commandStep('privacy-zk', 'tools/test/lanes/privacy-zk-comment-matrix.sh', ['privacy-zk-comment-matrix'])
    ],
    [
      commandStep('canary-parity', 'node tools/ux/run-viewport-canary-parity.mjs', ['ux-viewport-canary-parity']),
      commandStep('cross-browser', 'tools/test/lanes/cross-browser-smoke.sh', ['cross-browser-smoke']),
      commandStep('render-pressure', 'tools/test/lanes/frontend-render-pressure.sh', ['frontend-render-pressure']),
      commandStep('rights-matrix', 'tools/test/lanes/rights-v3-test-matrix.sh', ['rights-v3-test-matrix']),
      commandStep('csrf-matrix', 'cd src/frontend && npm run check:security:csrf-browser-matrix', ['csrf-browser-matrix']),
      commandStep('resilience', 'tools/test/lanes/resilience-runtime.sh', ['resilience'])
    ],
    [commandStep('data-scale-xs', 'tools/test/lanes/data-scale.sh scale-xs', ['data-scale-xs'])],
    [commandStep('data-scale-s', 'tools/test/lanes/data-scale.sh scale-s', ['data-scale-s'])],
    [commandStep('data-scale-summary', 'node tools/test/aggregate-data-scale-evidence.mjs', ['data-scale-evidence-summary'])],
    [commandStep('fault-injection', 'tools/test/lanes/fault-injection.sh', ['fault-injection'])]
  ]
}

function performanceWaves() {
  const windowMembers = [
    'load', 'backend-qps-view-count-flush', 'backend-qps-visitlog-invalidation', 'backend-qps-cache-hit',
    'backend-qps-comment-cursor', 'backend-qps-hotread', 'backend-qps-cache-miss-singleflight',
    'backend-qps-risk-filter', 'backend-qps-related-reading', 'backend-qps-list-pagination',
    'backend-qps-article-detail-miss', 'backend-qps-cache-registry', 'backend-cache-invalidation-batch',
    'backend-qps-index-plan', 'backend-qps', 'load-baseline', 'load-peak'
  ]
  return [
    [commandStep('coverage-merge', 'tools/coverage/merge-coverage.sh', ['coverage-merge'])],
    [commandStep('coverage-threshold', 'tools/test/lanes/coverage-threshold.sh', ['coverage-threshold', 'coverage-gate', 'fast'])],
    [
      commandStep('mixed-performance-window', 'node tools/test/run-mixed-performance-window.mjs', windowMembers),
      commandStep('backend-benchmark', 'tools/test/lanes/backend-benchmark-regression.sh', ['backend-benchmark-regression']),
      commandStep('browser-performance', 'tools/test/lanes/browser-performance-regression.sh', ['browser-performance-regression']),
      commandStep('backend-perf', 'tools/test/lanes/perf-regression.sh', ['backend-perf']),
      commandStep('aeds-frame-cost', 'tools/test/lanes/aeds-frame-cost.sh', ['aeds-frame-cost']),
      commandStep('aeds-compression', 'tools/test/lanes/aeds-compression-profile.sh', ['aeds-compression-profile'])
    ],
    [commandStep('performance-summary', 'node tools/test/aggregate-performance-evidence.mjs', ['performance-evidence-summary'])],
    [commandStep('release-evidence', 'tools/test/lanes/release-evidence.sh', ['release-evidence'])],
    [commandStep('production-summary', 'tools/test/lanes/noop.sh production', ['production'])]
  ]
}

async function run() {
  if (bundleId === 'backend-tests') await runBackendTests()
  else if (bundleId === 'frontend-tests') await runFrontendTests()
  else if (bundleId === 'build-static') {
    await executeStepDag(buildStaticSteps(), bundleParallelism(), executeStep)
  } else {
    const waves = bundleId === 'runtime-browser' ? runtimeWaves() : performanceWaves()
    for (const wave of waves) await executeWave(wave)
  }

  const members = Object.fromEntries([...memberEvidence.entries()].map(([tierId, evidence]) => [tierId, {
    ...evidence,
    testIds: [...new Set(evidence.testIds)].sort(),
    artifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort())
  }]))
  for (const [tierId, evidence] of Object.entries(members)) {
    if (evidence.testIds.length === 0 || Object.keys(evidence.artifactDigests).length === 0) {
      throw new Error(`${tierId} has no executed test IDs or artifact digests`)
    }
  }
  const summary = {
    schema: 'fsusblog.local-production.bundle.v1',
    physicalBundleId: bundleId,
    executionSource: 'fresh',
    status: 'success',
    schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    runToken: randomUUID(),
    durationMs: Date.now() - startedAt,
    members,
    generatedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  const temporary = `${summaryFile}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`)
  fs.renameSync(temporary, summaryFile)
  console.log(`[local-production:${bundleId}] summary=${relative(summaryFile)} members=${Object.keys(members).length}`)
}

run().catch((error) => {
  console.error(`[local-production:${bundleId}] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
