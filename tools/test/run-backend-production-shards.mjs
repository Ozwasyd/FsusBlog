#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const project = 'tests/backend/FsusBlog.Server.Tests.csproj'
const productionFilter = 'Category!=Integration&Category!=Performance'
const projectedCategories = [
  'ApiIntegration',
  'SecurityStateMachine',
  'Concurrency',
  'Property',
  'GoldenContract'
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function normalizeListedTestName(value) {
  const normalized = String(value ?? '').trim()
  const argumentIndex = normalized.indexOf('(')
  return (argumentIndex >= 0 ? normalized.slice(0, argumentIndex) : normalized).trim()
}

export function parseListedTests(stdout) {
  const marker = 'The following Tests are available:'
  const markerIndex = String(stdout).indexOf(marker)
  if (markerIndex < 0) throw new Error('dotnet test --list-tests did not emit its test-list marker')
  const testNames = String(stdout).slice(markerIndex + marker.length)
    .split(/\r?\n/u)
    .filter((line) => /^    \S/u.test(line))
    .map((line) => line.trim())
  if (testNames.length === 0) throw new Error('backend production test discovery returned no tests')
  return testNames
}

export function buildShardPlan(testNames, shardCount = 2) {
  if (!Number.isInteger(shardCount) || shardCount < 2) throw new Error('backend production requires at least two shards')
  const methodCounts = new Map()
  for (const testName of testNames) {
    const method = normalizeListedTestName(testName)
    if (!method) throw new Error('backend production discovery contained an empty test method')
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1)
  }
  const methodsByShard = Array.from({ length: shardCount }, () => [])
  for (const method of [...methodCounts.keys()].sort()) {
    const shardIndex = createHash('sha256').update(method).digest().readUInt32BE(0) % shardCount
    methodsByShard[shardIndex].push(method)
  }
  if (methodsByShard.some((methods) => methods.length === 0)) {
    throw new Error('backend production shard plan contains an empty shard')
  }
  return {
    testCaseCount: testNames.length,
    methodCounts,
    methodsByShard,
    partitionDigest: `sha256:${sha256(JSON.stringify(methodsByShard))}`
  }
}

export function validateCategoryMembership(plan, discoveries) {
  const discoveredMethods = new Set(plan.methodCounts.keys())
  const membership = {}
  for (const category of projectedCategories) {
    const categoryTests = discoveries[category]
    if (!Array.isArray(categoryTests) || categoryTests.length === 0) {
      throw new Error(`backend production category ${category} returned no tests`)
    }
    const methods = [...new Set(categoryTests.map(normalizeListedTestName))].sort()
    for (const method of methods) {
      if (!discoveredMethods.has(method)) {
        throw new Error(`backend production category ${category} contains a method outside the production union: ${method}`)
      }
    }
    membership[category] = methods
  }
  return membership
}

function decodeXml(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
}

function trxAttribute(raw, name) {
  const match = String(raw).match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))
  return match ? decodeXml(match[1]) : ''
}

export function parseTrxRecords(xml) {
  return [...String(xml).matchAll(/<UnitTestResult\b([^>]*)>/gu)].map((match) => ({
    testName: trxAttribute(match[1], 'testName'),
    outcome: trxAttribute(match[1], 'outcome')
  })).filter((record) => record.testName)
}

export function validateShardRecords(plan, recordsByShard) {
  if (recordsByShard.length !== plan.methodsByShard.length) {
    throw new Error('backend production shard result count does not match the plan')
  }
  const actualCounts = new Map()
  let executed = 0
  for (const [shardIndex, records] of recordsByShard.entries()) {
    const allowedMethods = new Set(plan.methodsByShard[shardIndex])
    for (const record of records) {
      if (record.outcome !== 'Passed') {
        throw new Error(`backend production shard ${shardIndex} contains ${record.outcome || 'unknown'} result: ${record.testName}`)
      }
      const method = normalizeListedTestName(record.testName)
      if (!allowedMethods.has(method)) {
        throw new Error(`backend production shard ${shardIndex} executed an out-of-partition method: ${method}`)
      }
      actualCounts.set(method, (actualCounts.get(method) ?? 0) + 1)
      executed += 1
    }
  }
  if (executed !== plan.testCaseCount) {
    throw new Error(`backend production shards executed ${executed} tests; discovery required ${plan.testCaseCount}`)
  }
  for (const [method, expected] of plan.methodCounts) {
    const actual = actualCounts.get(method) ?? 0
    if (actual !== expected) {
      throw new Error(`backend production method count mismatch for ${method}: expected ${expected}, received ${actual}`)
    }
  }
  if ([...actualCounts.keys()].some((method) => !plan.methodCounts.has(method))) {
    throw new Error('backend production shards executed a method absent from discovery')
  }
  return { executedTestCaseCount: executed, executedMethodCount: actualCounts.size }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function runDotnet(args, { capture = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(path.join(root, 'tools/build-with-data-env.sh'), ['dotnet', ...args], {
      cwd: root,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({
      code: code ?? 1,
      signal,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt
    }))
  })
}

function prepareShardFiles(plan, outputRoot) {
  const binSource = path.join(root, 'tests/backend/bin/Debug/net10.0')
  const testAssembly = path.join(binSource, 'FsusBlog.Server.Tests.dll')
  if (!fs.existsSync(testAssembly)) throw new Error(`backend production test assembly is missing: ${testAssembly}`)
  fs.rmSync(outputRoot, { recursive: true, force: true })
  fs.mkdirSync(outputRoot, { recursive: true })
  return plan.methodsByShard.map((methods, index) => {
    const shardRoot = path.join(outputRoot, `shard-${index}`)
    const binDirectory = path.join(shardRoot, 'bin')
    const settingsFile = path.join(shardRoot, 'test.runsettings')
    fs.cpSync(binSource, binDirectory, { recursive: true })
    const filter = methods.map((method) => `FullyQualifiedName=${method}`).join('|')
    fs.writeFileSync(settingsFile, `<RunSettings><RunConfiguration><TestCaseFilter>${escapeXml(filter)}</TestCaseFilter></RunConfiguration></RunSettings>\n`)
    return {
      index,
      methods,
      filterDigest: `sha256:${sha256(filter)}`,
      binDirectory,
      settingsFile
    }
  })
}

export async function runBackendProductionShards({ shardCount = 2 } = {}) {
  const outputRoot = path.join(root, '.tmp/backend-production-shards')
  const testResultsRoot = path.join(root, '.tmp/test-results/backend/production')
  const coverageRoot = path.join(root, '.tmp/coverage/backend/production')
  const summaryFile = path.join(testResultsRoot, 'summary.json')
  fs.rmSync(testResultsRoot, { recursive: true, force: true })
  fs.rmSync(coverageRoot, { recursive: true, force: true })
  fs.mkdirSync(testResultsRoot, { recursive: true })
  fs.mkdirSync(coverageRoot, { recursive: true })

  const discovery = await runDotnet([
    'test', project, '-c', 'Debug', '--no-build', '--no-restore', '--list-tests',
    '--filter', productionFilter, '-v', 'quiet'
  ], { capture: true })
  if (discovery.code !== 0 || discovery.signal) {
    throw new Error(`backend production discovery failed: ${discovery.stderr.trim() || `exit ${discovery.code}`}`)
  }
  const testNames = parseListedTests(discovery.stdout)
  const plan = buildShardPlan(testNames, shardCount)
  const categoryDiscoveryRuns = await Promise.all(projectedCategories.map(async (category) => ({
    category,
    result: await runDotnet([
      'test', project, '-c', 'Debug', '--no-build', '--no-restore', '--list-tests',
      '--filter', `${productionFilter}&Category=${category}`, '-v', 'quiet'
    ], { capture: true })
  })))
  const failedCategoryDiscovery = categoryDiscoveryRuns.find(({ result }) => result.code !== 0 || result.signal)
  if (failedCategoryDiscovery) {
    const { category, result } = failedCategoryDiscovery
    throw new Error(`backend production category discovery failed for ${category}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  const categoryMembership = validateCategoryMembership(plan, Object.fromEntries(categoryDiscoveryRuns.map(({ category, result }) => [
    category,
    parseListedTests(result.stdout)
  ])))
  const shards = prepareShardFiles(plan, outputRoot)
  const processorsPerShard = positiveInteger(process.env.FSUSBLOG_BACKEND_SHARD_PROCESSORS, 2)
  const runs = await Promise.all(shards.map(async (shard) => {
    const trxFile = path.join(testResultsRoot, `shard-${shard.index}.trx`)
    const shardCoverageRoot = path.join(coverageRoot, `shard-${shard.index}`)
    fs.mkdirSync(shardCoverageRoot, { recursive: true })
    const result = await runDotnet([
      'test', project, '-c', 'Debug', '--no-build', '--no-restore', '-v', 'minimal',
      `-p:OutputPath=${shard.binDirectory}${path.sep}`,
      '--settings', shard.settingsFile,
      '--logger', `trx;LogFileName=${trxFile}`,
      '--collect:XPlat Code Coverage',
      '--results-directory', shardCoverageRoot,
      '--', 'DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json,cobertura'
    ], { env: { ...process.env, DOTNET_PROCESSOR_COUNT: String(processorsPerShard) } })
    return { ...shard, ...result, trxFile, coverageRoot: shardCoverageRoot }
  }))
  const failed = runs.filter((run) => run.code !== 0 || run.signal)
  if (failed.length > 0) {
    throw new Error(`backend production shards failed: ${failed.map((run) => `${run.index}:${run.signal ?? run.code}`).join(', ')}`)
  }
  const recordsByShard = runs.map((run) => parseTrxRecords(fs.readFileSync(run.trxFile, 'utf8')))
  const validation = validateShardRecords(plan, recordsByShard)
  const summary = {
    schema: 'fsusblog.backend-production-shards.v1',
    status: 'success',
    filter: productionFilter,
    shardCount,
    processorsPerShard,
    discovery: {
      testCaseCount: plan.testCaseCount,
      testMethodCount: plan.methodCounts.size,
      durationMs: discovery.durationMs,
      partitionDigest: plan.partitionDigest
    },
    execution: validation,
    categoryMembership: Object.fromEntries(projectedCategories.map((category) => [category, {
      testMethodCount: categoryMembership[category].length,
      testMethods: categoryMembership[category],
      discoveryDurationMs: categoryDiscoveryRuns.find((entry) => entry.category === category).result.durationMs
    }])),
    shards: runs.map((run, index) => ({
      id: index,
      testCaseCount: recordsByShard[index].length,
      testMethodCount: run.methods.length,
      filterDigest: run.filterDigest,
      durationMs: run.durationMs,
      trx: path.relative(root, run.trxFile).replaceAll(path.sep, '/'),
      coverageRoot: path.relative(root, run.coverageRoot).replaceAll(path.sep, '/')
    })),
    producer: {
      runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
      sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
      sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
    },
    generatedAt: new Date().toISOString()
  }
  writeJsonAtomic(summaryFile, summary)
  fs.rmSync(outputRoot, { recursive: true, force: true })
  console.log(`[backend-production-shards] ok tests=${validation.executedTestCaseCount} methods=${validation.executedMethodCount} shards=${shardCount}`)
  return summary
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runBackendProductionShards({
    shardCount: positiveInteger(process.env.FSUSBLOG_BACKEND_PRODUCTION_SHARDS, 2)
  }).catch((error) => {
    console.error(`[backend-production-shards] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
