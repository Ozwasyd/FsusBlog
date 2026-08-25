#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { readVstestDiscoveryDiagnostic } from './vstest-discovery-diagnostic.mjs'

export const backendPlatformTrait = Object.freeze({
  name: 'Platform',
  unix: 'Unix'
})
export const backendPlatformEvidenceTrait = Object.freeze({
  name: 'PlatformEvidence',
  unixMode: 'UnixMode'
})

const runtimeEvidencePrefix = 'backend-platform-runtime-evidence '
const unixModeEvidenceSchema = 'fsusblog.backend-platform-unix-mode-evidence.v1'

function requiredText(value, label) {
  const result = String(value ?? '').trim()
  if (!result) throw new Error(`${label} is required`)
  return result
}

export function normalizeBackendRuntimePlatform(value) {
  const normalized = requiredText(value, 'backend runtime platform').toLowerCase()
  if (normalized === 'win32' || normalized === 'windows') return 'windows'
  if (normalized === 'linux') return 'linux'
  if (normalized === 'darwin' || normalized === 'macos') return 'macos'
  throw new Error(`unsupported backend runtime platform: ${value}`)
}

export function composeBackendPlatformFilter(baseFilter, runtimePlatform = process.platform) {
  const base = requiredText(baseFilter, 'backend base test filter')
  return normalizeBackendRuntimePlatform(runtimePlatform) === 'windows'
    ? `(${base})&${backendPlatformTrait.name}!=${backendPlatformTrait.unix}`
    : base
}

function platformValues(record) {
  const values = record?.traits?.[backendPlatformTrait.name] ?? []
  if (!Array.isArray(values)) {
    throw new Error(`backend platform traits must be an array for ${record?.fullyQualifiedName ?? '<missing>'}`)
  }
  if (values.length > 1) {
    throw new Error(`backend test has multiple Platform traits: ${record?.fullyQualifiedName ?? '<missing>'}`)
  }
  if (values.some((value) => value !== backendPlatformTrait.unix)) {
    throw new Error(
      `backend test has unsupported Platform trait ${values.join(',') || '<empty>'}: `
      + `${record?.fullyQualifiedName ?? '<missing>'}`
    )
  }
  return values
}

function platformEvidenceValues(record) {
  const values = record?.traits?.[backendPlatformEvidenceTrait.name] ?? []
  if (!Array.isArray(values)) {
    throw new Error(
      `backend platform evidence traits must be an array for ${record?.fullyQualifiedName ?? '<missing>'}`
    )
  }
  if (values.length > 1) {
    throw new Error(
      `backend test has multiple PlatformEvidence traits: ${record?.fullyQualifiedName ?? '<missing>'}`
    )
  }
  if (values.some((value) => value !== backendPlatformEvidenceTrait.unixMode)) {
    throw new Error(
      `backend test has unsupported PlatformEvidence trait ${values.join(',') || '<empty>'}: `
      + `${record?.fullyQualifiedName ?? '<missing>'}`
    )
  }
  if (values.length === 1 && !platformValues(record).includes(backendPlatformTrait.unix)) {
    throw new Error(
      `backend test declares PlatformEvidence without Platform=Unix: `
      + `${record?.fullyQualifiedName ?? '<missing>'}`
    )
  }
  return values
}

export function selectBackendPlatformRecords(records, runtimePlatform = process.platform) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('backend platform selection requires authoritative discovered records')
  }
  const platform = normalizeBackendRuntimePlatform(runtimePlatform)
  return records.filter((record) => {
    const values = platformValues(record)
    platformEvidenceValues(record)
    return values.length === 0 || platform !== 'windows'
  })
}

function platformEvidenceRecord(record, result, reason = null) {
  const id = requiredText(record?.id, 'backend platform test ID')
  const fullyQualifiedName = requiredText(record?.fullyQualifiedName, 'backend platform fully-qualified test name')
  const displayName = requiredText(record?.displayName, 'backend platform display name')
  const source = path.resolve(requiredText(record?.source, 'backend platform test source'))
  const evidenceValues = platformEvidenceValues(record)
  return {
    testId: id,
    fullyQualifiedName,
    displayName,
    source,
    assembly: path.basename(source),
    platform: backendPlatformTrait.unix,
    result,
    ...(evidenceValues.length === 1 ? { evidenceContract: 'unix-mode' } : {}),
    ...(reason ? { reason } : {})
  }
}

export function projectBackendPlatformPlan(
  records,
  runtimePlatform = process.platform,
  { baseFilter = 'Category!=Integration&Category!=Performance', lane = 'backend' } = {}
) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('backend platform plan requires authoritative discovered records')
  }
  const platform = normalizeBackendRuntimePlatform(runtimePlatform)
  const seenIds = new Set()
  const platformTests = []
  const selectedIds = new Set(selectBackendPlatformRecords(records, platform).map((record) => record.id))
  let plannedTestCaseCount = 0
  let notSelectedTestCaseCount = 0
  for (const record of records) {
    const id = requiredText(record?.id, 'backend discovered test ID')
    if (seenIds.has(id)) throw new Error(`backend platform discovery repeated test ID ${id}`)
    seenIds.add(id)
    const values = platformValues(record)
    platformEvidenceValues(record)
    const selected = selectedIds.has(id)
    if (selected) plannedTestCaseCount += 1
    else notSelectedTestCaseCount += 1
    if (values.length === 1) {
      platformTests.push(platformEvidenceRecord(
        record,
        selected ? 'planned' : 'not-selected',
        selected ? null : 'Platform=Unix is outside the Windows backend plan'
      ))
    }
  }
  return {
    schema: 'fsusblog.backend-platform-plan.v1',
    lane: requiredText(lane, 'backend platform lane'),
    runtimePlatform: platform,
    platformFamily: platform === 'windows' ? 'windows' : 'unix',
    trait: { ...backendPlatformTrait },
    baseFilter: requiredText(baseFilter, 'backend base test filter'),
    executionFilter: composeBackendPlatformFilter(baseFilter, platform),
    discoveredTestCaseCount: records.length,
    plannedTestCaseCount,
    notSelectedTestCaseCount,
    platformTests
  }
}

function decodeXml(value) {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function trxAttribute(raw, name) {
  const match = String(raw).match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))
  return match ? decodeXml(match[1]) : ''
}

function parseRuntimeEvidence(body) {
  const lines = [...String(body).matchAll(/<StdOut>([\s\S]*?)<\/StdOut>/gu)]
    .flatMap((match) => decodeXml(match[1]).split(/\r?\n/gu))
    .map((line) => line.trim())
    .filter((line) => line.startsWith(runtimeEvidencePrefix))
  if (lines.length > 1) {
    throw new Error('backend platform TRX contains multiple runtime evidence receipts for one test')
  }
  if (lines.length === 0) return null
  try {
    const value = JSON.parse(lines[0].slice(runtimeEvidencePrefix.length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('receipt must be an object')
    }
    return value
  } catch (error) {
    throw new Error(
      `backend platform TRX contains invalid runtime evidence JSON: `
      + `${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function parseBackendPlatformResultRows(xml) {
  return [...String(xml).matchAll(
    /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/gu
  )].map((match) => {
    const runtimeEvidence = parseRuntimeEvidence(match[2] ?? '')
    return {
      testId: trxAttribute(match[1], 'testId'),
      testName: trxAttribute(match[1], 'testName'),
      outcome: trxAttribute(match[1], 'outcome'),
      ...(runtimeEvidence ? { runtimeEvidence } : {})
    }
  })
}

export function parseBackendPlatformTrx(xml) {
  const text = String(xml)
  const results = parseBackendPlatformResultRows(text)
  const counters = [...text.matchAll(/<Counters\b([^>]*)>/gu)]
  if (counters.length !== 1) throw new Error('backend platform outcome requires one TRX counter set')
  const total = Number(trxAttribute(counters[0][1], 'total'))
  const executed = Number(trxAttribute(counters[0][1], 'executed'))
  if (!Number.isInteger(total) || !Number.isInteger(executed)
    || total !== results.length || executed !== results.length) {
    throw new Error('backend platform outcome rejects a raw result without one executed evidence row')
  }
  if (results.some((record) => !record.testId || !record.testName || !record.outcome)) {
    throw new Error('backend platform TRX contains an incomplete result record')
  }
  return results
}

function requireTrueRecord(record, keys, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || keys.some((key) => record[key] !== true)) {
    throw new Error(`backend Unix mode evidence requires true ${label}: ${keys.join(',')}`)
  }
}

function validateUnixModeEvidence(value, test) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== unixModeEvidenceSchema
    || value.evidenceContract !== 'unix-mode') {
    throw new Error(`backend Unix mode evidence schema is invalid for ${test.fullyQualifiedName}`)
  }
  if (value.fullyQualifiedName !== test.fullyQualifiedName) {
    throw new Error(`backend Unix mode evidence test identity is invalid for ${test.fullyQualifiedName}`)
  }
  if (value.freshModeOctal !== '0700'
    || value.widenedExistingModeOctal !== '0777'
    || value.effectiveModeOctal !== '0700') {
    throw new Error(`backend Unix mode evidence has invalid mode values for ${test.fullyQualifiedName}`)
  }
  requireTrueRecord(value.assertions, [
    'groupReadDenied',
    'groupWriteDenied',
    'groupExecuteDenied',
    'otherReadDenied',
    'otherWriteDenied',
    'otherExecuteDenied'
  ], 'group/other deny assertions')
  requireTrueRecord(value.ownerArtifact, ['created', 'read', 'deleted'], 'owner artifact assertions')
  requireTrueRecord(value.existingRoot, ['overbroadModeApplied', 'converged'], 'existing-root assertions')
  return value
}

export function reconcileBackendPlatformOutcome(plan, results) {
  if (plan?.schema !== 'fsusblog.backend-platform-plan.v1') {
    throw new Error('backend platform outcome requires a canonical platform plan')
  }
  if (!Array.isArray(results)) throw new Error('backend platform outcome requires TRX result records')
  const resultsById = new Map()
  for (const result of results) {
    const id = requiredText(result?.testId, 'backend platform result test ID')
    const matching = resultsById.get(id) ?? []
    matching.push(result)
    resultsById.set(id, matching)
  }
  const platformTests = plan.platformTests.map((test) => {
    const matching = resultsById.get(test.testId) ?? []
    if (test.result === 'not-selected') {
      if (matching.length > 0) {
        throw new Error(`Windows backend plan executed not-selected Unix test ${test.fullyQualifiedName}`)
      }
      return { ...test }
    }
    if (matching.length === 0) {
      throw new Error(`Unix backend plan did not execute planned test ${test.fullyQualifiedName}`)
    }
    if (matching.length !== 1) {
      throw new Error(`Unix backend plan executed platform test more than once: ${test.fullyQualifiedName}`)
    }
    const [result] = matching
    if (result.outcome !== 'Passed' && result.outcome !== 'Failed') {
      throw new Error(`Unix backend platform test has non-semantic outcome ${result.outcome}`)
    }
    let evidence = null
    if (test.evidenceContract === 'unix-mode') {
      if (result.outcome === 'Passed' && !result.runtimeEvidence) {
        throw new Error(
          `Unix backend platform test passed without required runtime evidence: ${test.fullyQualifiedName}`
        )
      }
      if (result.runtimeEvidence) {
        evidence = validateUnixModeEvidence(result.runtimeEvidence, test)
      }
    }
    return {
      ...test,
      result: result.outcome.toLowerCase(),
      rawOutcome: result.outcome,
      executionEvidenceCount: 1,
      ...(evidence ? { evidence } : {})
    }
  })
  return {
    schema: 'fsusblog.backend-platform-outcome.v1',
    lane: plan.lane,
    runtimePlatform: plan.runtimePlatform,
    platformFamily: plan.platformFamily,
    executionFilter: plan.executionFilter,
    platformTests
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) throw new Error(`${name} is required`)
  return args[index + 1]
}

function main(args) {
  const command = args[0]
  if (command === 'filter') {
    process.stdout.write(`${composeBackendPlatformFilter(option(args, '--base'), option(args, '--platform'))}\n`)
    return
  }
  if (command === 'plan') {
    const expectedSource = path.resolve(option(args, '--source'))
    const diagnostic = readVstestDiscoveryDiagnostic(path.resolve(option(args, '--diagnostic-root')), {
      expectedSource
    })
    const plan = projectBackendPlatformPlan(diagnostic.records, option(args, '--platform'), {
      baseFilter: option(args, '--base'),
      lane: option(args, '--lane')
    })
    writeJson(path.resolve(option(args, '--out')), {
      ...plan,
      discoveryDiagnostic: path.resolve(diagnostic.file)
    })
    process.stdout.write(`${plan.executionFilter}\n`)
    return
  }
  if (command === 'outcome') {
    const plan = JSON.parse(fs.readFileSync(path.resolve(option(args, '--plan')), 'utf8'))
    const results = parseBackendPlatformTrx(fs.readFileSync(path.resolve(option(args, '--trx')), 'utf8'))
    writeJson(path.resolve(option(args, '--out')), reconcileBackendPlatformOutcome(plan, results))
    return
  }
  throw new Error('usage: backend-platform-selection.mjs filter|plan|outcome [options]')
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[backend-platform-selection] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
