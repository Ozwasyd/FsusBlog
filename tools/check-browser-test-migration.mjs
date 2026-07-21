#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { browserContractScenarios } from '../tests/browser-contract/contract.mjs'
import { browserDiagnosticCatalog } from '../tests/browser-diagnostics/catalog.mjs'
import { extractTestRecords, vitestTestId } from './test-retention/audit.mjs'

const schema = 'fsusblog.browser-test-migration.v1'
const allowedReplacementLayers = new Set(['correctness', 'browser-contract', 'diagnostic', 'none'])
const allowedStatuses = new Set(['migrated', 'migrated-in-place', 'retained-diagnostic'])
const browserRiskRoutes = new Set(['browser-contract', 'diagnostic'])

function strings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : []
}

function unique(values) {
  return [...new Set(values)]
}

function normalizeRecord(record, defaults = {}) {
  const merged = {
    ...defaults,
    ...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)),
    browserOnlyRisk: {
      ...(defaults.browserOnlyRisk ?? {}),
      ...(record.browserOnlyRisk ?? {})
    }
  }
  return {
    sourceFile: String(merged.sourceFile ?? '').trim(),
    sourceTestId: String(merged.sourceTestId ?? '').trim(),
    assertionCategory: strings(merged.assertionCategory),
    replacementLayer: String(merged.replacementLayer ?? '').trim(),
    replacementTestIds: strings(merged.replacementTestIds),
    browserOnlyRisk: {
      present: merged.browserOnlyRisk?.present,
      route: String(merged.browserOnlyRisk?.route ?? '').trim(),
      testIds: strings(merged.browserOnlyRisk?.testIds)
    },
    status: String(merged.status ?? '').trim(),
    removalReason: String(merged.removalReason ?? '').trim(),
    approval: merged.approval ?? null
  }
}

function selectArray(document, selector) {
  const value = String(selector ?? '').split('.').filter(Boolean)
    .reduce((current, key) => current?.[key], document)
  if (!Array.isArray(value)) throw new Error(`manifest import selector ${selector} is not an array`)
  return value
}

export function expandBrowserTestMigrationManifest(manifest, loadJson) {
  if (manifest?.schema !== schema) {
    throw new Error(`browser migration manifest requires ${schema}, got ${manifest?.schema ?? 'missing'}`)
  }

  const records = []
  for (const declaration of manifest.imports ?? []) {
    if (declaration?.kind !== 'retention-replacements') {
      throw new Error(`unsupported browser migration import kind: ${declaration?.kind ?? 'missing'}`)
    }
    const imported = loadJson(declaration.path)
    const fieldMap = declaration.fieldMap ?? {}
    const allowedIds = declaration.idBaseline
      ? new Set(selectArray(loadJson(declaration.idBaseline), 'records')
        .filter((record) => !declaration.disposition || record?.disposition === declaration.disposition)
        .map((record) => record?.id))
      : null
    for (const source of selectArray(imported, declaration.selector)
      .filter((record) => !allowedIds || allowedIds.has(record?.id))) {
      records.push(normalizeRecord({
        sourceFile: source?.[fieldMap.sourceFile],
        sourceTestId: source?.[fieldMap.sourceTestId],
        assertionCategory: source?.[fieldMap.assertionCategory],
        replacementTestIds: source?.[fieldMap.replacementTestIds]
      }, declaration.defaults))
    }
  }

  for (const group of manifest.recordGroups ?? []) {
    for (const source of group.sourceTests ?? []) {
      for (const sourceTestId of strings(source.testIds)) {
        records.push(normalizeRecord({
          sourceFile: source.file,
          sourceTestId
        }, group.defaults))
      }
    }
  }
  return records
}

function recordKey(record) {
  return `${record.sourceFile}\n${record.sourceTestId}`
}

function retiredRecordKey(record) {
  return `${record.sourceFileSha256}\n${record.sourceTestIdSha256}`
}

function retiredHistoryKey(record) {
  const sourceFileSha256 = createHash('sha256').update(record.sourceFile).digest('hex')
  const sourceTestIdSha256 = createHash('sha256').update(record.sourceTestId).digest('hex')
  return retiredRecordKey({ sourceFileSha256, sourceTestIdSha256 })
}

const retiredHistoryAuthorityCount = 2
const retiredHistoryFallbackCount = 67
const retiredHistoryFallbackRecordSetSha256 = '0311b66e4149b75fd7cb2a18eba8b91a7b4bf3daf9df35b41a0d56bc6f7656d7'
const retiredHistoryAuthority = Object.freeze([
  Object.freeze({
    sourceFileSha256: 'fc34e1382099e056c8bcf1b1f45ac34677aa5bfa9d140b4a7b1fca31120f4a63',
    sourceTestIdSha256: '28f621c7f4233977ada0d4c41262afe36821e15a9ef5acf41ea1327e8553878b'
  }),
  Object.freeze({
    sourceFileSha256: 'fc34e1382099e056c8bcf1b1f45ac34677aa5bfa9d140b4a7b1fca31120f4a63',
    sourceTestIdSha256: '75393e91adcd31723e10b3ccca29785cb020f49ca7bb2b7c9bae4dd8513b6596'
  })
])

export function validateReplacementTargets(root, records) {
  const errors = []
  const browserContractIds = new Set(browserContractScenarios.map((scenario) => `browser-contract:${scenario.id}`))
  const diagnosticIds = new Set(browserDiagnosticCatalog.map((category) => `diagnostic:${category.id}`))
  const targets = unique(records.flatMap((record) => [
    ...record.replacementTestIds,
    ...record.browserOnlyRisk.testIds
  ]))

  for (const target of targets) {
    if (target.startsWith('browser-contract:')) {
      if (!browserContractIds.has(target)) errors.push(`replacement target does not resolve: ${target}`)
      continue
    }
    if (target.startsWith('diagnostic:')) {
      if (!diagnosticIds.has(target)) errors.push(`replacement target does not resolve: ${target}`)
      continue
    }

    const match = target.match(/^(node-script|node-test|test-support|vitest|xunit):([^#]+)(?:#(.+))?$/u)
    if (!match) {
      errors.push(`replacement target uses an unsupported identity: ${target}`)
      continue
    }
    const [, framework, sourceFile, testName = ''] = match
    const absolute = path.join(root, sourceFile)
    if (!existsSync(absolute)) {
      errors.push(`replacement target file does not exist: ${target}`)
      continue
    }
    if (framework === 'test-support') continue

    const source = readFileSync(absolute, 'utf8')
    const extractedIds = new Set(extractTestRecords(sourceFile, source).map((record) => record.id))
    const rawVitestAlias = framework === 'vitest' && testName
      ? vitestTestId(sourceFile, testName)
      : null
    if (!extractedIds.has(target) && (!rawVitestAlias || !extractedIds.has(rawVitestAlias))) {
      errors.push(`replacement test identity does not exist: ${target}`)
    }
  }
  return unique(errors)
}

function hasHappyDomEquivalence(record) {
  return [
    record.replacementLayer,
    ...record.replacementTestIds,
    ...record.browserOnlyRisk.testIds
  ].some((value) => /happy-dom/iu.test(value))
}

export function validateBrowserTestMigration({
  manifest,
  records,
  acceptanceBaseline,
  acceptanceReplacements,
  diagnosticsMigration,
  historicalDeletedRecords,
  currentRecords
}) {
  const errors = []
  const expectedCount = Number(manifest.expectedEffectiveRecordCount)
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || records.length !== expectedCount) {
    errors.push(`effective record count mismatch: expected ${manifest.expectedEffectiveRecordCount}, got ${records.length}`)
  }

  const byKey = new Map()
  const byId = new Map()
  for (const record of records) {
    const key = recordKey(record)
    if (!record.sourceFile || !/^(?:tests|tools)\//u.test(record.sourceFile)) {
      errors.push(`${record.sourceTestId || '<missing-id>'} has invalid sourceFile`)
    }
    if (!record.sourceTestId) errors.push(`${record.sourceFile || '<missing-file>'} has no sourceTestId`)
    if (byKey.has(key)) errors.push(`duplicate browser migration record: ${record.sourceTestId}`)
    byKey.set(key, record)
    if (byId.has(record.sourceTestId) && byId.get(record.sourceTestId).sourceFile !== record.sourceFile) {
      errors.push(`source test ID is reused by multiple files: ${record.sourceTestId}`)
    }
    byId.set(record.sourceTestId, record)

    if (record.assertionCategory.length === 0 || unique(record.assertionCategory).length !== record.assertionCategory.length) {
      errors.push(`${record.sourceTestId} requires unique assertionCategory values`)
    }
    if (!allowedReplacementLayers.has(record.replacementLayer)) {
      errors.push(`${record.sourceTestId} has invalid replacementLayer ${record.replacementLayer || '<missing>'}`)
    }
    if (!allowedStatuses.has(record.status)) {
      errors.push(`${record.sourceTestId} has invalid migration status ${record.status || '<missing>'}`)
    }
    if (record.replacementLayer === 'none') {
      const approvedBy = String(record.approval?.approvedBy ?? '').trim()
      const approvedAt = String(record.approval?.approvedAt ?? '').trim()
      const issue = String(record.approval?.issue ?? '').trim()
      if (record.replacementTestIds.length !== 0) {
        errors.push(`${record.sourceTestId} replacementLayer=none must not declare replacementTestIds`)
      }
      if (record.removalReason.length < 20 || !approvedBy || !/^\d{4}-\d{2}-\d{2}$/u.test(approvedAt) || !/^#\d+$/u.test(issue)) {
        errors.push(`${record.sourceTestId} replacementLayer=none requires an explicit reason and issue-bound approval`)
      }
    } else if (record.replacementTestIds.length === 0
      || unique(record.replacementTestIds).length !== record.replacementTestIds.length) {
      errors.push(`${record.sourceTestId} requires unique replacementTestIds`)
    }

    if (typeof record.browserOnlyRisk.present !== 'boolean') {
      errors.push(`${record.sourceTestId} must declare whether browser-only risk remains`)
    } else if (record.browserOnlyRisk.present) {
      if (!browserRiskRoutes.has(record.browserOnlyRisk.route) || record.browserOnlyRisk.testIds.length === 0) {
        errors.push(`${record.sourceTestId} browser-only risk requires an explicit Browser Contract or diagnostics route`)
      }
      if (hasHappyDomEquivalence(record)) {
        errors.push(`${record.sourceTestId} browser-only risk cannot claim happy-dom equivalence`)
      }
    } else if (record.browserOnlyRisk.route !== 'none' || record.browserOnlyRisk.testIds.length !== 0) {
      errors.push(`${record.sourceTestId} browserOnlyRisk=false must use route=none with no browser test IDs`)
    }
  }

  const currentKeys = new Set(currentRecords.map(recordKey))
  for (const record of records) {
    const isCurrent = currentKeys.has(recordKey(record))
    if (record.status === 'migrated' && isCurrent) {
      errors.push(`${record.sourceTestId} is marked migrated but still exists in the active source inventory`)
    }
    if ((record.status === 'migrated-in-place' || record.status === 'retained-diagnostic') && !isCurrent) {
      errors.push(`${record.sourceTestId} was deleted without changing its migration mapping`)
    }
  }

  const acceptanceReplacementById = new Map(
    (acceptanceReplacements?.deletedTests ?? []).map((record) => [record.id, record])
  )
  for (const baseline of acceptanceBaseline?.records ?? []) {
    const mapped = byKey.get(recordKey({ sourceFile: baseline.path, sourceTestId: baseline.id }))
    if (!mapped) {
      errors.push(`unmapped Acceptance baseline test: ${baseline.id}`)
      continue
    }
    if (baseline.disposition === 'migrated') {
      const replacement = acceptanceReplacementById.get(baseline.id)
      if (!replacement) {
        errors.push(`Acceptance replacement manifest is missing ${baseline.id}`)
      } else if (JSON.stringify([...mapped.replacementTestIds].sort()) !== JSON.stringify([...replacement.replacementTestIds].sort())) {
        errors.push(`${baseline.id} replacement IDs drifted from the #1146 retention authority`)
      }
      if (mapped.status !== 'migrated' || mapped.replacementLayer !== 'correctness') {
        errors.push(`${baseline.id} must remain a browserless correctness migration`)
      }
    } else if (baseline.disposition === 'browser-contract') {
      if (mapped.replacementLayer !== 'browser-contract'
        || !mapped.browserOnlyRisk.present
        || mapped.browserOnlyRisk.route !== 'browser-contract') {
        errors.push(`${baseline.id} must route its browser-only risk to Browser Contract`)
      }
    } else {
      errors.push(`${baseline.id} has unsupported Acceptance disposition ${baseline.disposition}`)
    }
  }

  for (const deleted of historicalDeletedRecords) {
    const mapped = byKey.get(recordKey(deleted))
    if (!mapped) errors.push(`browser test deleted since the frozen baseline without a mapping: ${deleted.sourceTestId}`)
    else if (mapped.status !== 'migrated') errors.push(`${deleted.sourceTestId} is deleted but status is ${mapped.status}`)
  }

  const diagnosticsByPath = new Map()
  for (const current of currentRecords) {
    const entries = diagnosticsByPath.get(current.sourceFile) ?? []
    entries.push(current)
    diagnosticsByPath.set(current.sourceFile, entries)
  }
  for (const category of diagnosticsMigration?.records ?? []) {
    for (const sourcePath of category.sourcePaths ?? []) {
      const sourceRecords = diagnosticsByPath.get(sourcePath) ?? []
      if (sourceRecords.length === 0) {
        errors.push(`diagnostics migration source has no active test identity: ${sourcePath}`)
        continue
      }
      for (const source of sourceRecords) {
        const mapped = byKey.get(recordKey(source))
        if (!mapped) {
          errors.push(`diagnostics source test is not mapped: ${source.sourceTestId}`)
          continue
        }
        if (mapped.status !== 'retained-diagnostic'
          || !mapped.assertionCategory.includes(category.category)
          || !mapped.browserOnlyRisk.present
          || mapped.browserOnlyRisk.route !== 'diagnostic') {
          errors.push(`${source.sourceTestId} must remain an explicit ${category.category} diagnostic mapping`)
        }
      }
    }
  }

  for (const sourcePath of manifest.browserlessInPlaceSources ?? []) {
    const sourceRecords = diagnosticsByPath.get(sourcePath) ?? []
    if (sourceRecords.length === 0) errors.push(`browserless in-place source has no test identity: ${sourcePath}`)
    for (const source of sourceRecords) {
      const mapped = byKey.get(recordKey(source))
      if (!mapped || mapped.status !== 'migrated-in-place' || mapped.replacementLayer !== 'correctness') {
        errors.push(`browserless in-place source is not mapped to correctness: ${source.sourceTestId}`)
      }
    }
  }

  return unique(errors)
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'))
}

function sourceRecords(root, sourcePaths) {
  const records = []
  for (const sourceFile of unique(sourcePaths).sort()) {
    const absolute = path.join(root, sourceFile)
    if (!existsSync(absolute)) continue
    for (const record of extractTestRecords(sourceFile, readFileSync(absolute, 'utf8'))) {
      records.push({ sourceFile, sourceTestId: record.id })
    }
  }
  return records
}

function baselineRecordsFromGit(root, baseline, scopes) {
  const paths = execFileSync('git', [
    'ls-tree', '-r', '--name-only', baseline, '--', ...scopes
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(value))
  const records = []
  for (const sourceFile of paths) {
    const source = execFileSync('git', ['show', `${baseline}:${sourceFile}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    for (const record of extractTestRecords(sourceFile, source)) {
      records.push({ sourceFile, sourceTestId: record.id })
    }
  }
  return records
}

function baselineRecordsFromFallback(root, manifest, baseline, scopes) {
  const fallbackPath = String(manifest?.historyBaseline?.fallback ?? '')
  if (!fallbackPath) throw new Error('browser migration historyBaseline requires a tracked fallback snapshot')
  const fallback = readJson(root, fallbackPath)
  if (fallback?.schema !== 'fsusblog.browser-test-baseline.v1'
    || fallback.sourceCommit !== baseline
    || JSON.stringify(fallback.scopes) !== JSON.stringify(scopes)
    || !Number.isInteger(fallback.recordCount)
    || fallback.recordCount < 1
    || fallback.recordCount !== fallback.records?.length) {
    throw new Error('browser migration fallback snapshot identity or count is invalid')
  }
  const records = fallback.records.map((record) => ({
    sourceFile: String(record.sourceFile ?? '').trim(),
    sourceTestId: String(record.sourceTestId ?? '').trim()
  }))
  const keys = records.map(recordKey)
  if (records.some((record) => !record.sourceFile || !record.sourceTestId)
    || new Set(keys).size !== keys.length) {
    throw new Error('browser migration fallback snapshot contains an empty or duplicate test identity')
  }
  return records
}

export function historicalDeletedRecords(root, manifest) {
  const baseline = String(manifest?.historyBaseline?.commit ?? '')
  const scopes = strings(manifest?.historyBaseline?.scopes)
  const validScopes = scopes.length >= 1
    && scopes[0] === 'tests/frontend/e2e'
    && unique(scopes).length === scopes.length
    && scopes.slice(1).every((scope) => /^tests\/tools\/[A-Za-z0-9._/-]+\.test\.mjs$/u.test(scope))
  if (!/^[0-9a-f]{40}$/u.test(baseline) || !validScopes) {
    throw new Error('browser migration historyBaseline requires a full commit, the e2e scope, and explicit browser-orchestration test scopes')
  }
  const fallbackRecords = baselineRecordsFromFallback(root, manifest, baseline, scopes)
  const retiredRecordCount = Number(manifest?.historyBaseline?.retiredRecordCount ?? 0)
  const retiredRecords = Array.isArray(manifest?.historyBaseline?.retiredRecords)
    ? manifest.historyBaseline.retiredRecords.map((record) => ({
        sourceFileSha256: String(record?.sourceFileSha256 ?? '').trim(),
        sourceTestIdSha256: String(record?.sourceTestIdSha256 ?? '').trim(),
        issue: String(record?.issue ?? '').trim(),
        reason: String(record?.reason ?? '').trim()
      }))
    : []
  const retiredKeys = retiredRecords.map(retiredRecordKey)
  const authorityKeys = retiredHistoryAuthority.map(retiredRecordKey)
  const fallbackKeys = fallbackRecords.map(recordKey).sort()
  const fallbackRecordSetSha256 = createHash('sha256')
    .update(JSON.stringify(fallbackKeys))
    .digest('hex')
  if (!Number.isInteger(retiredRecordCount)
    || retiredRecordCount !== retiredHistoryAuthorityCount
    || retiredHistoryAuthority.length !== retiredHistoryAuthorityCount
    || retiredRecords.length !== retiredRecordCount
    || retiredRecords.some((record) => !/^[0-9a-f]{64}$/u.test(record.sourceFileSha256)
      || !/^[0-9a-f]{64}$/u.test(record.sourceTestIdSha256)
      || !/^#\d+$/u.test(record.issue)
      || record.reason.length < 20)
    || new Set(retiredKeys).size !== retiredKeys.length
    || JSON.stringify(retiredKeys) !== JSON.stringify(authorityKeys)
    || fallbackRecords.length !== retiredHistoryFallbackCount
    || fallbackRecordSetSha256 !== retiredHistoryFallbackRecordSetSha256) {
    throw new Error('frozen Browser test baseline drifted from the available git baseline')
  }
  const baselineAvailable = spawnSync(
    'git',
    ['cat-file', '-e', `${baseline}^{commit}`],
    { cwd: root, encoding: 'utf8' }
  ).status === 0
  let baselineRecords = fallbackRecords
  if (baselineAvailable) {
    baselineRecords = baselineRecordsFromGit(root, baseline, scopes)
    const historyKeys = baselineRecords.map(recordKey).sort()
    const historyKeySet = new Set(historyKeys)
    const fallbackKeySet = new Set(fallbackKeys)
    const sortedAuthorityKeys = [...authorityKeys].sort()
    const omittedHistoryKeys = baselineRecords
      .filter((record) => !fallbackKeySet.has(recordKey(record)))
      .map(retiredHistoryKey)
      .sort()
    if (historyKeys.length !== fallbackKeys.length + retiredRecordCount
      || fallbackKeys.some((key) => !historyKeySet.has(key))
      || JSON.stringify(omittedHistoryKeys) !== JSON.stringify(sortedAuthorityKeys)) {
      throw new Error('frozen Browser test baseline drifted from the available git baseline')
    }
    baselineRecords = fallbackRecords
  }

  const current = sourceRecords(root, baselineRecords.map((record) => record.sourceFile))
  const currentKeys = new Set(current.map(recordKey))
  return baselineRecords.filter((record) => !currentKeys.has(recordKey(record)))
}

export function checkBrowserTestMigration(root) {
  const manifestPath = 'tests/governance/browser-test-migration.json'
  const manifest = readJson(root, manifestPath)
  const loadJson = (relativePath) => readJson(root, relativePath)
  const records = expandBrowserTestMigrationManifest(manifest, loadJson)
  const acceptanceBaseline = loadJson(manifest.authorities.acceptanceBaseline)
  const acceptanceReplacements = loadJson(manifest.authorities.acceptanceReplacements)
  const diagnosticsMigration = loadJson(manifest.authorities.diagnosticsMigration)
  const allSourcePaths = records.map((record) => record.sourceFile)
  const currentRecords = sourceRecords(root, allSourcePaths)
  const deleted = historicalDeletedRecords(root, manifest)
  const errors = validateBrowserTestMigration({
    manifest,
    records,
    acceptanceBaseline,
    acceptanceReplacements,
    diagnosticsMigration,
    historicalDeletedRecords: deleted,
    currentRecords
  })
  errors.push(...validateReplacementTargets(root, records))
  if (errors.length > 0) {
    throw new Error(`browser test migration governance failed:\n- ${errors.join('\n- ')}`)
  }
  return {
    records: records.length,
    historicalDeleted: deleted.length,
    diagnostics: diagnosticsMigration.records.reduce((count, record) => count + record.sourcePaths.length, 0)
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  try {
    const root = path.resolve(argumentValue('--root') ?? process.cwd())
    const result = checkBrowserTestMigration(root)
    console.log(`[browser-test-migration] ok records=${result.records} historicalDeleted=${result.historicalDeleted} diagnosticSources=${result.diagnostics}`)
  } catch (error) {
    console.error(`[browser-test-migration] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
