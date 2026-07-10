#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../test-matrix/parse-matrix.mjs'
import {
  artifactSubstitutionBindingDigest,
  digestDeclaredOutputs,
  matrixGeneratedRuntimePaths,
  resolveArtifactSubstitutions
} from '../../test-matrix/local-profile.mjs'
import { executeStepDag } from './step-dag.mjs'
import { executeLimitedWave } from './wave-runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const profileId = process.env.FSUSBLOG_LOCAL_PROFILE || 'production'
const bundleId = process.argv[2]
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
const profile = matrix.localProfiles?.[profileId]
const bundle = profile?.bundles?.find((entry) => entry.id === bundleId)
const matrixTiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]))
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

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function register(step, result, testIds = null, artifactFiles = []) {
  const ids = testIds ?? [`command:${step.id}`]
  const declaredArtifacts = [result.logFile, ...artifactFiles].map((file) => {
    const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
    return relative(absolute)
  })
  const artifactDigests = digestDeclaredOutputs(root, declaredArtifacts)
  for (const tierId of step.members ?? []) {
    const evidence = memberEvidence.get(tierId)
    if (!evidence) throw new Error(`${step.id} references undeclared member ${tierId}`)
    evidence.durationMs += result.durationMs
    evidence.testIds.push(...ids)
    Object.assign(evidence.artifactDigests, artifactDigests)
  }
}

function bindMatrixRuntimeArtifacts() {
  const substitutionsByTier = resolveArtifactSubstitutions(bundle, matrix.tiers)
  const runtimePathsByTier = new Map()
  const directRuntimePaths = []
  const actualProofPaths = []
  for (const [tierId, evidence] of memberEvidence) {
    const tier = matrixTiers.get(tierId)
    if (!tier) throw new Error(`bundle member is missing from matrix tiers: ${tierId}`)
    const runtimePaths = matrixGeneratedRuntimePaths(tier)
    const substitutions = substitutionsByTier[tierId] ?? {}
    runtimePathsByTier.set(tierId, runtimePaths)
    for (const runtimePath of runtimePaths) {
      const actualPaths = substitutions[runtimePath]
      if (actualPaths) actualProofPaths.push(...actualPaths)
      else directRuntimePaths.push(runtimePath)
    }
    evidence.artifactProofMode = runtimePaths.length === 0
      ? 'command-log-and-test-ids'
      : (Object.keys(substitutions).length > 0
          ? 'matrix-runtime-artifacts-with-substitutions'
          : 'matrix-runtime-artifacts')
    evidence.matrixRuntimePaths = runtimePaths
    evidence.artifactSubstitutionProofs = {}
  }
  const allRuntimeDigests = digestDeclaredOutputs(root, [
    ...new Set([...directRuntimePaths, ...actualProofPaths])
  ])
  for (const [tierId, runtimePaths] of runtimePathsByTier) {
    const evidence = memberEvidence.get(tierId)
    const substitutions = substitutionsByTier[tierId] ?? {}
    for (const canonicalPath of runtimePaths) {
      const actualPaths = substitutions[canonicalPath]
      if (!actualPaths) {
        evidence.artifactDigests[canonicalPath] = allRuntimeDigests[canonicalPath]
        continue
      }
      const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
        actualPath,
        allRuntimeDigests[actualPath]
      ]))
      const canonicalDigest = artifactSubstitutionBindingDigest(canonicalPath, actualDigests)
      evidence.artifactDigests[canonicalPath] = canonicalDigest
      Object.assign(evidence.artifactDigests, actualDigests)
      evidence.artifactSubstitutionProofs[canonicalPath] = {
        canonicalPath,
        canonicalDigest,
        actualPaths,
        actualDigests
      }
    }
  }
}

function memberReceiptPath(tierId) {
  return path.join(outDir, 'member-summaries', tierId, 'summary.json')
}

function writeMemberExecutionReceipts() {
  for (const [tierId, evidence] of memberEvidence) {
    const receiptFile = memberReceiptPath(tierId)
    const receipt = {
      schema: 'fsusblog.local-production.member-execution.v1',
      status: 'success',
      tierId,
      physicalBundleId: bundleId,
      schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
      sourceState: {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
      },
      durationMs: evidence.durationMs,
      testIds: [...new Set(evidence.testIds)].sort(),
      directArtifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort()),
      generatedAt: new Date().toISOString()
    }
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true })
    const temporary = `${receiptFile}.next-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
    fs.renameSync(temporary, receiptFile)
    Object.assign(evidence.artifactDigests, digestDeclaredOutputs(root, [relative(receiptFile)]))
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
  await executeLimitedWave(steps, {
    maxParallel: bundleParallelism(),
    cpuUnits: bundle.cpuUnits,
    memoryGiB: bundle.memoryGiB,
    exclusiveResources: bundle.exclusiveResources ?? []
  }, executeStep)
}

function bundleParallelism() {
  return Math.min(
    profile.maxParallel,
    bundle.stepMaxParallel ?? bundle.cpuUnits ?? profile.maxParallel
  )
}

function commandStep(id, command, members, options = {}) {
  return {
    id,
    command,
    members,
    ...options,
    resources: options.resources ?? { cpuUnits: 0.5, memoryGiB: 0.5 }
  }
}

function buildStaticSteps() {
  const frontendSummary = path.join(root, '.tmp/frontend/frontend-build.json')
  return [
    commandStep('frontend-build', 'cd src/frontend && FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1 npm run build:release', ['frontend-build'], {
      artifacts: [path.join(root, 'src/frontend/dist/index.html')],
      resources: { cpuUnits: 2, memoryGiB: 2 }
    }),
    commandStep('validate-matrix', 'node tools/run-test-matrix.mjs preflight', ['validate-matrix']),
    commandStep('public-hydration-fast', 'tools/test/lanes/public-hydration-fast.sh', ['public-hydration-fast']),
    commandStep('contract-fuzz', 'tools/test/lanes/contract-fuzz.sh', ['contract-fuzz']),
    commandStep('perception-redteam', 'tools/test/lanes/perception-v2-redteam.sh pr', ['perception-v2-redteam-pr']),
    commandStep('risk-control', 'tools/test/lanes/risk-control-test-matrix.sh', ['risk-control-test-matrix']),
    commandStep('viewport-plan-progress', 'node tools/ux/run-viewport-plan-progress.mjs', ['ux-viewport-plan-progress'], {
      artifacts: [path.join(root, '.tmp/ux/viewport-plan-progress.json')]
    }),
    commandStep('sync-static-assets', [
      'rm -rf src/backend/wwwroot',
      'mkdir -p src/backend/wwwroot',
      'cp -R src/frontend/dist/. src/backend/wwwroot/',
      `mkdir -p ${shellQuote(path.dirname(frontendSummary))}`,
      `node -e ${shellQuote("const fs=require('node:fs');const f=process.argv[1];fs.writeFileSync(f,JSON.stringify({status:'success',schedulerRunId:process.env.FSUSBLOG_TEST_RUN_ID,generatedAt:new Date().toISOString()},null,2)+'\\n')")} ${shellQuote(frontendSummary)}`
    ].join(' && '), ['frontend-build'], { dependsOn: ['frontend-build'] }),
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
  const trxRoot = path.join(root, '.tmp/test-results/backend/production')
  const shardSummary = path.join(trxRoot, 'summary.json')
  const coverageDir = path.join(root, '.tmp/coverage/backend/production')
  const dotnetBuildParallelism = `/m:${bundleParallelism()}`
  fs.mkdirSync(trxRoot, { recursive: true })
  fs.mkdirSync(coverageDir, { recursive: true })
  await executeWave([
    commandStep('services', 'tools/bootstrap-acceptance-env.sh --services-only', [], {
      resources: { cpuUnits: 0.5, memoryGiB: 0.5 }
    }),
    commandStep('dotnet-restore',
      'FSUSBLOG_DOTNET_BUILD_PARALLELISM=auto tools/build-with-data-env.sh dotnet restore tests/backend/FsusBlog.Server.Tests.csproj -v minimal /p:NuGetAudit=false', [], {
        resources: { cpuUnits: 2, memoryGiB: 1.5 }
      })
  ])
  await executeStep(commandStep('backend-build',
    `tools/build-with-data-env.sh dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Debug --no-restore -warnaserror -v minimal ${dotnetBuildParallelism} /p:UseSharedCompilation=true /p:NuGetAudit=false`,
    ['backend-build-governance'], {
      artifacts: [path.join(root, 'tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.dll')]
    }))
  const testStep = commandStep('dotnet-production-union',
    'FSUSBLOG_BACKEND_PRODUCTION_SHARDS=2 FSUSBLOG_BACKEND_SHARD_PROCESSORS=2 node tools/test/run-backend-production-shards.mjs', [])
  await executeStep(commandStep('perception-matrix', 'tools/test/lanes/perception-v2-test-matrix.sh', ['perception-v2-test-matrix']))
  const [result] = await Promise.all([
    executeStep(testStep),
    executeStep(commandStep('perception-evidence-finalize',
      'node tools/security/check-perception-v2-e2e-evidence.mjs', ['perception-v2-test-matrix'], {
        artifacts: [
          path.join(root, '.tmp/security/perception-v2-e2e-runtime.json'),
          path.join(root, '.tmp/release-evidence/perception-v2-release-evidence.json'),
          path.join(root, '.tmp/security/perception-v2-test-matrix.json')
        ]
      })),
    executeStep(commandStep('integrity-proof',
      'tools/test/lanes/integrity-proof-verification.sh', ['integrity-proof-verification'], {
        artifacts: [path.join(root, '.tmp/release-evidence/integrity-proof-verification.json')]
      }))
  ])
  await executeStep(commandStep('backend-coverage-summary',
    'node tools/coverage/summarize-cobertura.mjs .tmp/coverage/backend .tmp/coverage/backend-merged/Summary.json backend-cobertura', []))
  const trxFiles = listFiles(trxRoot, (file) => file.endsWith('.trx')).sort()
  if (trxFiles.length !== 2) throw new Error(`backend production expected 2 shard TRX files, received ${trxFiles.length}`)
  const tests = trxFiles.flatMap(parseTrx)
  const shardReport = JSON.parse(fs.readFileSync(shardSummary, 'utf8'))
  const categoryMembers = new Map([
    ['backend-api-integration', 'ApiIntegration'],
    ['backend-auth-state-machine', 'SecurityStateMachine'],
    ['backend-concurrency', 'Concurrency'],
    ['backend-property', 'Property'],
    ['backend-golden', 'GoldenContract']
  ])
  const categoryMethods = new Map([...categoryMembers].map(([tierId, category]) => {
    const methods = shardReport.categoryMembership?.[category]?.testMethods
    if (!Array.isArray(methods) || methods.length === 0) {
      throw new Error(`${tierId} is missing bound category discovery evidence for ${category}`)
    }
    return [tierId, new Set(methods)]
  }))
  const specialMethods = new Set([...categoryMethods.values()].flatMap((methods) => [...methods]))
  const backendTestMembers = new Set([
    'backend-unit', 'backend-api-integration', 'backend-auth-state-machine', 'backend-concurrency',
    'backend-property', 'backend-golden', 'backend-fast', 'coverage-backend'
  ])
  for (const tierId of bundle.members.filter((id) => backendTestMembers.has(id))) {
    let selected = tests
    if (tierId === 'backend-unit') selected = tests.filter((entry) => !specialMethods.has(entry.id))
    else if (categoryMethods.has(tierId)) selected = tests.filter((entry) => categoryMethods.get(tierId).has(entry.id))
    if (selected.length === 0) throw new Error(`${tierId} received no executed backend test IDs`)
    register({ id: 'dotnet-production-union', members: [tierId] }, result, selected.map((entry) => `xunit:${entry.id}`), [
      shardSummary,
      ...trxFiles,
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

async function waitForSiblingBundleSummaries(bundleIds, timeoutMs = 120_000) {
  const expectedRunId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = bundleIds.every((siblingBundleId) => {
      const file = path.join(root, `.tmp/local-${profileId}`, siblingBundleId, 'summary.json')
      if (!fs.existsSync(file)) return false
      try {
        const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
        return summary.status === 'success' && summary.schedulerRunId === expectedRunId
      } catch {
        return false
      }
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for sibling bundle summaries: ${bundleIds.join(', ')}`)
}

async function runFrontendTests() {
  const step = commandStep('vitest-production-projects', [
    'cd src/frontend',
    'export FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD=0',
    'export FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD=0',
    'export FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD=0',
    'export FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD=0',
    `FSUSBLOG_VITEST_MAX_WORKERS=${bundleParallelism()} npx vitest run --config vitest.production.config.ts --project=unit --project=property --project=model --coverage`
  ].join(' && '), [])
  const result = await executeStep(step)
  await executeStep(commandStep('frontend-coverage-summary',
    'FSUSBLOG_COVERAGE_SKIP_TESTS=1 tools/coverage/collect-frontend-coverage.sh', []))
  await waitForSiblingBundleSummaries(['build-static', 'backend-tests'])
  const perfResult = await executeStep(commandStep('vitest-production-perf-isolated', [
    'cd src/frontend',
    'FSUSBLOG_VITEST_MAX_WORKERS=1 npx vitest run --config vitest.production.config.ts --project=perf'
  ].join(' && '), []))
  const reports = listFiles(path.join(root, '.tmp/test-results/vitest'), (file) => file.endsWith('.json'))
  const tests = parseVitestReports(reports)
  if (tests.length === 0 || tests.some((entry) => entry.status !== 'passed')) throw new Error('Vitest report is empty or contains non-passing tests')
  const summary = path.join(root, '.tmp/coverage/frontend/Summary.json')
  const perfTests = tests.filter((entry) => entry.file.includes('/benchmarks/'))
  const nonPerfTests = tests.filter((entry) => !entry.file.includes('/benchmarks/'))
  if (perfTests.length === 0) throw new Error('isolated frontend perf report is empty')
  const byMember = {
    'frontend-unit-shard': nonPerfTests.filter((entry) => entry.file.includes('/unit/')),
    'frontend-property-model-perf': nonPerfTests.filter((entry) => /\/(?:property|model)\//u.test(entry.file)),
    'frontend-fast-summary': nonPerfTests,
    'coverage-frontend': nonPerfTests
  }
  for (const tierId of bundle.members) {
    const selected = byMember[tierId] ?? []
    if (selected.length === 0) throw new Error(`${tierId} received no executed Vitest IDs`)
    register({ id: 'vitest-production-projects', members: [tierId] }, result, selected.map((entry) => entry.id), [summary, ...reports])
    if (['frontend-property-model-perf', 'frontend-fast-summary', 'coverage-frontend'].includes(tierId)) {
      register({ id: 'vitest-production-perf-isolated', members: [tierId] }, perfResult,
        perfTests.map((entry) => entry.id), [summary, ...reports])
    }
  }
}

function runtimeWaves() {
  const riskMembers = ['acceptance', 'visual-public', 'visual-console', 'visual', 'ux-viewport-smoke']
  return [
    [
      commandStep('bootstrap', 'FSUSBLOG_RUNTIME_NO_BUILD=1 tools/bootstrap-acceptance-env.sh', ['bootstrap'], {
        resources: { cpuUnits: 2, memoryGiB: 2 }
      }),
      commandStep('static-governance', 'tools/test/lanes/static-governance.sh', ['static-governance'], {
        resources: { cpuUnits: 1, memoryGiB: 1 }
      })
    ],
    [
      commandStep('runtime-integration', 'FSUSBLOG_SKIP_BACKEND_INTEGRATION_TESTS=1 tools/test/lanes/runtime-integration.sh', ['integration'], {
        resources: { cpuUnits: 1.5, memoryGiB: 1.5 }
      })
    ],
    [
      commandStep('release-public', 'tools/test/lanes/release-public.sh', ['release'], {
        resources: { cpuUnits: 1, memoryGiB: 1 }
      })
    ],
    [
      commandStep('endpoint-depth', 'tools/test/lanes/endpoint-depth.sh', ['endpoint-depth'], {
        resources: { cpuUnits: 1.5, memoryGiB: 1.5 }
      }),
      commandStep('security-runtime', 'FSUSBLOG_SKIP_ZAP=1 tools/test/lanes/security-runtime.sh', ['security'], {
        resources: { cpuUnits: 2, memoryGiB: 2 }
      }),
      commandStep('zap-baseline', 'tools/security/run-zap-baseline.sh', ['security']),
      commandStep('ux-risk-matrix', 'node tools/ux/run-local-production-risk.mjs', riskMembers, {
        resources: { cpuUnits: 6, memoryGiB: 5 }
      }),
      commandStep('cross-stack', 'FSUSBLOG_OPENAPI_BUILD=0 tools/test/legacy-test.sh cross-stack-contract', ['cross-stack-contract']),
      commandStep('privacy-zk', 'tools/test/lanes/privacy-zk-comment-matrix.sh', ['privacy-zk-comment-matrix'], {
        resources: { cpuUnits: 8, memoryGiB: 8, exclusiveResources: ['benchmark-window'] }
      })
    ],
    [
      commandStep('cross-browser', 'tools/test/lanes/cross-browser-smoke.sh', ['cross-browser-smoke'], {
        resources: { cpuUnits: 2, memoryGiB: 2 }
      }),
      commandStep('render-pressure', 'tools/test/lanes/frontend-render-pressure.sh', ['frontend-render-pressure'], {
        resources: { cpuUnits: 2, memoryGiB: 2 }
      }),
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
    [
      commandStep('coverage-threshold', 'tools/test/lanes/coverage-threshold.sh', ['coverage-threshold', 'coverage-gate', 'fast']),
      commandStep('backend-perf', 'tools/test/lanes/perf-regression.sh', ['backend-perf'], {
        resources: { cpuUnits: 8, memoryGiB: 8, exclusiveResources: ['benchmark-window'] }
      })
    ],
    [
      commandStep('mixed-performance-window', 'node tools/test/run-mixed-performance-window.mjs', windowMembers, {
        resources: { cpuUnits: 8, memoryGiB: 8, exclusiveResources: ['benchmark-window'] }
      }),
      commandStep('backend-benchmark', 'tools/test/lanes/backend-benchmark-regression.sh', ['backend-benchmark-regression'], {
        resources: { cpuUnits: 8, memoryGiB: 8, exclusiveResources: ['benchmark-window'] }
      }),
      commandStep('browser-performance', 'tools/test/lanes/browser-performance-regression.sh', ['browser-performance-regression'], {
        resources: { cpuUnits: 8, memoryGiB: 8, exclusiveResources: ['benchmark-window'] }
      }),
      commandStep('aeds-frame-cost', 'tools/test/lanes/aeds-frame-cost.sh', ['aeds-frame-cost'], {
        resources: { cpuUnits: 8, memoryGiB: 8, exclusiveResources: ['benchmark-window'] }
      }),
      commandStep('aeds-compression', 'tools/test/lanes/aeds-compression-profile.sh', ['aeds-compression-profile'], {
        resources: { cpuUnits: 8, memoryGiB: 8, exclusiveResources: ['benchmark-window'] }
      })
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

  writeMemberExecutionReceipts()
  bindMatrixRuntimeArtifacts()
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
