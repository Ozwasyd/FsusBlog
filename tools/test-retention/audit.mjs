import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { snapshotGitWorktree } from '../test-matrix/scheduler.mjs'

const safetyRiskPatterns = [
  ['security', /security|auth|permission|passkey|pow|csrf|credential|privacy|anonymous/iu],
  ['protocol', /aeds|binary|protocol|codec|contract|frame/iu],
  ['migration', /migration|schema|legacy|backup|restore/iu],
  ['concurrency', /concurr|race|atomic|idempoten|deadlock|lock/iu],
  ['release', /release|publish|artifact|evidence|supply.chain/iu],
  ['mutation', /mutation|stryker/iu],
  ['performance', /perf|benchmark|load|soak|latency|qps/iu],
  ['runtime', /runtime|integration|browser|playwright|resilience|fault/iu]
]

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 10)
}

function slug(value) {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 56) || 'unnamed'
}

export function vitestTestId(file, name, ordinal = 1) {
  return `vitest:${file}#${slug(name)}-${shortHash(`${name}\n${ordinal}`)}`
}

function namedJavascriptTestId(framework, file, name, ordinal = 1) {
  return framework === 'vitest'
    ? vitestTestId(file, name, ordinal)
    : `${framework}:${file}#${slug(name)}-${shortHash(`${name}\n${ordinal}`)}`
}

function classBefore(source, offset) {
  const prefix = source.slice(0, offset)
  const matches = [...prefix.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/gu)]
  return matches.at(-1)?.[1] ?? 'UnknownClass'
}

function balancedBlock(source, offset, limit = 12_000) {
  const start = source.indexOf('{', offset)
  if (start < 0) return source.slice(offset, Math.min(source.length, offset + 1_000))
  let depth = 0
  let quote = ''
  let escaped = false
  const endLimit = Math.min(source.length, start + limit)
  for (let index = start; index < endLimit; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(offset, index + 1)
    }
  }
  return source.slice(offset, endLimit)
}

function normalizeSemanticSource(source) {
  return source
    .replace(/\s+/gu, ' ')
    .trim()
}

function assertionTargets(source, fallback) {
  const targets = []
  const patterns = [
    /\bAssert\.[A-Za-z_][A-Za-z0-9_]*(?:<[^>]+>)?\([^;\n]*/gu,
    /\b(?:assert|expect)\([^;\n]*?\)(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\([^;\n]*\))?)+/gu,
    /\b(?:assert|expect)\.[A-Za-z_][A-Za-z0-9_]*\([^;\n]*/gu
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const normalized = match[0].replace(/\s+/gu, ' ').trim().slice(0, 240)
      if (normalized && !targets.includes(normalized)) targets.push(normalized)
    }
  }
  return targets.length > 0 ? targets : [`behavior:${String(fallback).trim()}`]
}

function riskTagsFor(file, name, source) {
  const haystack = `${file}\n${name}\n${source}`
  return safetyRiskPatterns
    .filter(([, pattern]) => pattern.test(haystack))
    .map(([tag]) => tag)
}

function record({ id, file, framework, name, source, tierCategory = undefined }) {
  const normalized = normalizeSemanticSource(source)
  return {
    id,
    path: file,
    framework,
    assertionTargets: assertionTargets(source, name),
    riskTags: riskTagsFor(file, name, source),
    _tierCategory: tierCategory,
    _semanticSignature: shortHash(`${framework}\n${normalized}`)
  }
}

function classTraitCategory(source, className, beforeIndex) {
  const declarationIndex = source.lastIndexOf(`class ${className}`, beforeIndex)
  if (declarationIndex < 0) return null
  const headerStart = Math.max(source.lastIndexOf('}', declarationIndex), source.lastIndexOf(';', declarationIndex)) + 1
  return source.slice(headerStart, declarationIndex).match(/\[Trait\(\s*"Category"\s*,\s*"([^"]+)"\s*\)\]/u)?.[1] ?? null
}

function extractXunit(file, source) {
  const records = []
  const pattern = /\[(?:Fact|Theory)(?:\([^\]]*\))?\][\s\S]{0,800}?\b(?:public|internal)\s+(?:static\s+)?(?:async\s+)?(?:Task(?:<[^>]+>)?|ValueTask(?:<[^>]+>)?|void|[A-Za-z_][A-Za-z0-9_<>,.?\[\]]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu
  for (const match of source.matchAll(pattern)) {
    const method = match[1]
    const className = classBefore(source, match.index)
    const block = balancedBlock(source, match.index)
    const tierCategory = match[0].match(/\[Trait\(\s*"Category"\s*,\s*"([^"]+)"\s*\)\]/u)?.[1]
      ?? classTraitCategory(source, className, match.index)
    records.push(record({
      id: `xunit:${file}#${className}.${method}`,
      file,
      framework: 'xunit',
      name: `${className}.${method}`,
      source: block,
      tierCategory
    }))
  }
  return records
}

function extractJavascriptTests(file, source) {
  const records = []
  const occurrenceByName = new Map()
  const framework = /from\s+['"]node:test['"]/u.test(source) ? 'node-test' : 'vitest'
  const pattern = /\b(?:it|test)(?:\.(?:skip|only|todo|fails|each))?\s*\(\s*(['"`])([^'"`\r\n]+)\1\s*,/gu
  for (const match of source.matchAll(pattern)) {
    const name = match[2].trim()
    const ordinal = (occurrenceByName.get(name) ?? 0) + 1
    occurrenceByName.set(name, ordinal)
    const block = balancedBlock(source, match.index)
    records.push(record({
      id: namedJavascriptTestId(framework, file, name, ordinal),
      file,
      framework,
      name,
      source: block
    }))
  }
  return records
}

export function vitestHistoryEntries(root, payload) {
  const entries = []
  for (const suite of payload?.testResults ?? []) {
    if (!suite?.name) continue
    const relative = path.relative(root, suite.name).split(path.sep).join('/')
    if (relative.startsWith('../') || path.isAbsolute(relative)) continue
    const occurrenceByName = new Map()
    for (const assertion of suite.assertionResults ?? []) {
      const name = String(assertion?.title ?? assertion?.fullName ?? '').trim()
      if (!name) continue
      const ordinal = (occurrenceByName.get(name) ?? 0) + 1
      occurrenceByName.set(name, ordinal)
      const durationMs = Number(assertion?.duration)
      entries.push({
        id: vitestTestId(relative, name, ordinal),
        path: relative,
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
        failed: assertion?.status === 'failed' || assertion?.status === 'failure'
      })
    }
  }
  return entries
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/giu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/gu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function xmlAttributes(source) {
  const attributes = {}
  for (const match of String(source ?? '').matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '')
  }
  return attributes
}

function trxDurationMs(value) {
  const match = String(value ?? '').trim().match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/u)
  if (!match) return null
  const [, rawDays = '0', rawHours, rawMinutes, rawSeconds, rawFraction = ''] = match
  const fractionMs = rawFraction === '' ? 0 : Number(`0.${rawFraction}`) * 1_000
  const durationMs = (
    Number(rawDays) * 86_400_000
    + Number(rawHours) * 3_600_000
    + Number(rawMinutes) * 60_000
    + Number(rawSeconds) * 1_000
    + fractionMs
  )
  return Number.isFinite(durationMs) ? durationMs : null
}

export function xunitMethodHistoryId(className, methodName) {
  const nestedClass = String(className ?? '').trim().split('+').at(-1) ?? ''
  const simpleClass = nestedClass.split('.').at(-1) ?? ''
  const method = String(methodName ?? '').trim()
  return simpleClass && method ? `xunit-method:${simpleClass}.${method}` : null
}

export function xunitTrxHistoryEntries(source) {
  const definitions = new Map()
  for (const match of String(source ?? '').matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu)) {
    const unit = xmlAttributes(match[1])
    const methodMatch = match[2].match(/<TestMethod\b([^>]*)\/?\s*>/u)
    if (!unit.id || !methodMatch) continue
    const method = xmlAttributes(methodMatch[1])
    const id = xunitMethodHistoryId(method.className, method.name)
    if (id) definitions.set(unit.id, id)
  }

  const entries = []
  for (const match of String(source ?? '').matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/gu)) {
    const result = xmlAttributes(match[1])
    const id = definitions.get(result.testId)
    const outcome = String(result.outcome ?? '').toLowerCase()
    if (!id || !['passed', 'failed', 'error', 'timeout', 'aborted'].includes(outcome)) continue
    entries.push({
      id,
      durationMs: trxDurationMs(result.duration),
      failed: outcome !== 'passed',
      at: result.endTime ?? result.startTime ?? null
    })
  }
  return entries
}

export async function retentionSourceState(root) {
  const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (commitResult.status !== 0) {
    throw new Error(`cannot resolve retention source commit: ${String(commitResult.stderr ?? '').trim() || `git exited ${commitResult.status}`}`)
  }
  const snapshot = await snapshotGitWorktree(root)
  return {
    commit: commitResult.stdout.trim(),
    worktreeFingerprint: snapshot.fingerprint
  }
}

export function extractTestRecords(file, source) {
  if (file.endsWith('.cs')) {
    const xunit = extractXunit(file, source)
    if (xunit.length > 0) return xunit
    return [record({
      id: `xunit-support:${file}`,
      file,
      framework: 'xunit-support',
      name: path.basename(file),
      source
    })]
  }
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) {
    const namedTests = extractJavascriptTests(file, source)
    if (namedTests.length > 0) return namedTests
    const framework = file.includes('/e2e/') ? 'playwright-dynamic' : 'test-support'
    return [record({
      id: `${framework}:${file}`,
      file,
      framework,
      name: path.basename(file),
      source
    })]
  }

  const framework = file.endsWith('.sh') ? 'shell' : file.endsWith('.mjs') || file.endsWith('.js') ? 'node-script' : 'support'
  const name = path.basename(file)
  return [record({
    id: `${framework}:${file}`,
    file,
    framework,
    name,
    source
  })]
}

export function isTestInventoryPath(file) {
  if (!String(file).startsWith('tests/') && !String(file).startsWith('tools/')) return false
  if (/^tests\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) return true
  if (file.startsWith('tests/backend/')) {
    return /(?:Tests?|Fixture|Collection)\.cs$/u.test(file)
      || /tests\/backend\/Fixtures\/.*\.(?:json|jsonc|sql|txt)$/u.test(file)
  }
  if (file.startsWith('tests/frontend/')) {
    return /tests\/frontend\/checks\/.*\.mjs$/u.test(file)
      || /tests\/frontend\/support\/.*\.(?:mjs|ts)$/u.test(file)
      || /tests\/frontend\/fixtures\/.*\.mjs$/u.test(file)
  }
  if (file.startsWith('tools/test/') || file.startsWith('tools/coverage/')) {
    return /\.(?:sh|mjs)$/u.test(file)
  }
  return /^tools\/check-.*\.(?:mjs|sh)$/u.test(file)
    || /^tools\/docs\/generate-testing-docs\.mjs$/u.test(file)
    || /^tools\/check-workflow-matrix-sync\.mjs$/u.test(file)
    || /^tools\/run-test-matrix\.mjs$/u.test(file)
}

export function inferTierIdsForFile(file, source = '', explicitCategory = undefined) {
  const tiers = new Set()
  if (/^tests\/frontend\/unit\/.*\.test\.[cm]?[jt]sx?$/u.test(file)) {
    tiers.add('frontend-unit-shard')
    tiers.add('coverage-frontend')
  }
  if (/^tests\/frontend\/(?:property|model|benchmarks)\/.*\.test\.[cm]?[jt]sx?$/u.test(file)) {
    tiers.add('frontend-property-model-perf')
  }
  if (file === 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts') {
    tiers.add('ux-viewport-smoke')
    tiers.add('ux-viewport-visual')
    tiers.add('ux-viewport-boundaries')
  }
  if (/^tests\/backend\/.*\.cs$/u.test(file)) {
    const category = explicitCategory === undefined
      ? String(source).match(/\[Trait\(\s*"Category"\s*,\s*"([^"]+)"\s*\)\]/u)?.[1] ?? null
      : explicitCategory
    if (category === 'Integration') {
      tiers.add('integration')
    } else if (category === 'Concurrency') {
      tiers.add('backend-concurrency')
      tiers.add('backend-nightly')
    } else if (category === 'Property') {
      tiers.add('backend-property')
      tiers.add('backend-nightly')
    } else if (category === 'SecurityStateMachine') {
      tiers.add('backend-auth-state-machine')
      tiers.add('backend-nightly')
    } else if (category === 'ApiIntegration') {
      tiers.add('backend-api-integration')
      tiers.add('backend-nightly')
    } else if (category === 'GoldenContract') {
      tiers.add('backend-golden')
      tiers.add('backend-nightly')
    } else if (category === 'Performance') {
      if (file.endsWith('/ZkCommentV2CrossStackFixtureTests.cs')) {
        tiers.add('privacy-zk-comment-matrix')
      } else {
        tiers.add('backend-perf')
        tiers.add('backend-nightly')
      }
    } else {
      tiers.add('backend-unit')
      tiers.add('coverage-backend')
    }
  }
  return [...tiers].sort()
}

export function normalizeReplacementManifest(manifest, currentRecords) {
  if (Object.keys(manifest ?? {}).length > 0 && manifest?.schema !== 'fsusblog.test-retention-replacements.v1') {
    throw new Error(`replacement manifest schema must be fsusblog.test-retention-replacements.v1, got ${manifest?.schema ?? 'missing'}`)
  }
  const currentTestIds = new Set((currentRecords ?? []).map((record) => record.id))
  const currentAssertionTargets = new Set((currentRecords ?? []).flatMap((record) => record.assertionTargets ?? []))
  const deletedTests = manifest?.deletedTests ?? []
  const assertionReplacements = manifest?.assertionReplacements ?? []
  const tierReplacements = manifest?.tierReplacements ?? []
  const seenDeletedIds = new Set()
  const seenAssertionTargets = new Set()

  for (const entry of deletedTests) {
    if (!String(entry?.id ?? '').trim()) throw new Error('deleted test entry lacks id')
    if (seenDeletedIds.has(entry.id)) throw new Error(`duplicate deleted test id: ${entry.id}`)
    seenDeletedIds.add(entry.id)
    if (!String(entry?.path ?? '').trim()) throw new Error(`deleted test ${entry.id} lacks path`)
    if (!String(entry?.reason ?? '').trim()) throw new Error(`deleted test ${entry.id} lacks reason`)
    if (!Array.isArray(entry?.replacementTestIds) || entry.replacementTestIds.length === 0) {
      throw new Error(`deleted test ${entry.id} lacks replacementTestIds`)
    }
    for (const replacementId of entry.replacementTestIds) {
      if (!currentTestIds.has(replacementId)) {
        throw new Error(`deleted test ${entry.id} references missing replacement test: ${replacementId}`)
      }
    }
  }

  for (const entry of assertionReplacements) {
    if (!String(entry?.before ?? '').trim()) throw new Error('assertion replacement lacks before target')
    if (seenAssertionTargets.has(entry.before)) throw new Error(`duplicate assertion replacement: ${entry.before}`)
    seenAssertionTargets.add(entry.before)
    if (!String(entry?.reason ?? '').trim()) throw new Error(`assertion replacement ${entry.before} lacks reason`)
    if (!Array.isArray(entry?.replacementTestIds) || entry.replacementTestIds.length === 0) {
      throw new Error(`assertion replacement ${entry.before} lacks replacementTestIds`)
    }
    for (const replacementId of entry.replacementTestIds) {
      if (!currentTestIds.has(replacementId)) {
        throw new Error(`assertion replacement ${entry.before} references missing replacement test: ${replacementId}`)
      }
    }
    if (!Array.isArray(entry?.after) || entry.after.length === 0) {
      throw new Error(`assertion replacement ${entry.before} lacks after targets`)
    }
    for (const target of entry.after) {
      if (!currentAssertionTargets.has(target)) {
        throw new Error(`assertion replacement ${entry.before} references missing replacement assertion target: ${target}`)
      }
    }
  }

  const currentTierIds = new Set((currentRecords ?? []).flatMap((record) => record.tierIds ?? []))
  const currentCoverageIds = new Set((currentRecords ?? []).flatMap((record) => record.coverageIds ?? []))
  const seenTierReplacements = new Set()
  for (const entry of tierReplacements) {
    if (!String(entry?.from ?? '').trim() || !String(entry?.to ?? '').trim()) {
      throw new Error('tier replacement requires from and to')
    }
    if (entry.from === entry.to) throw new Error(`tier replacement ${entry.from} must change tier id`)
    if (seenTierReplacements.has(entry.from)) throw new Error(`duplicate tier replacement: ${entry.from}`)
    seenTierReplacements.add(entry.from)
    if (!currentTierIds.has(entry.to)) throw new Error(`tier replacement ${entry.from} references missing replacement tier: ${entry.to}`)
    if (!String(entry?.reason ?? '').trim()) throw new Error(`tier replacement ${entry.from} lacks reason`)
    if (!Array.isArray(entry?.coverageIds) || entry.coverageIds.length === 0) {
      throw new Error(`tier replacement ${entry.from} lacks coverageIds`)
    }
    for (const coverageId of entry.coverageIds) {
      if (!currentCoverageIds.has(coverageId)) {
        throw new Error(`tier replacement ${entry.from} references missing coverage id: ${coverageId}`)
      }
    }
  }

  return { deletedTests, assertionReplacements, tierReplacements }
}

export function percentile(values, requestedPercentile) {
  const finite = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
  if (finite.length === 0) return null
  const index = Math.max(0, Math.min(finite.length - 1, Math.ceil((requestedPercentile / 100) * finite.length) - 1))
  return finite[index]
}

function historyFor(map, id, file) {
  const xunitMethodId = String(id).startsWith('xunit:') && String(id).includes('#')
    ? `xunit-method:${String(id).slice(String(id).indexOf('#') + 1)}`
    : null
  const direct = map.get(id) ?? (xunitMethodId ? map.get(xunitMethodId) : undefined) ?? map.get(file) ?? []
  return Array.isArray(direct) ? direct : []
}

function applyEquivalence(records) {
  const retentionRank = new Map([
    ['must-keep', 0],
    ['conditional', 1],
    ['review-candidate', 2],
    ['obsolete-candidate', 3]
  ])
  const groups = new Map()
  for (const item of records) {
    const key = `${item.framework}\n${item._semanticSignature}\n${item.coverageIds.join('|')}`
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    group.sort((left, right) => (
      (retentionRank.get(left._retentionClass) ?? Number.MAX_SAFE_INTEGER)
      - (retentionRank.get(right._retentionClass) ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id)
    ))
    const canonical = group[0]
    canonical.uniqueEvidence = true
    canonical.equivalentTo = null
    for (const duplicate of group.slice(1)) {
      duplicate.uniqueEvidence = false
      duplicate.equivalentTo = canonical.id
      duplicate.replacementTestIds = [canonical.id]
    }
  }
}

export async function auditTestRecords({ root, files, fileMetadata, timingHistory, failureHistory }) {
  const records = []
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8')
    const metadata = fileMetadata.get(file) ?? {}
    for (const extracted of extractTestRecords(file, source)) {
      const timings = historyFor(timingHistory, extracted.id, file)
      const failures = historyFor(failureHistory, extracted.id, file)
      const inferredRecordTiers = extracted.framework === 'xunit' && /^tests\/backend\/.*\.cs$/u.test(file)
        ? inferTierIdsForFile(file, '', extracted._tierCategory ?? null)
        : metadata.tierIds ?? []
      const tierIds = [...new Set(inferredRecordTiers)].sort()
      const coverageIds = [...new Set(metadata.coverageIds ?? [])].sort()
      records.push({
        ...extracted,
        coverageIds,
        tierIds,
        invocationCount: tierIds.length,
        tierInvocationCount: tierIds.length,
        timing: {
          samples: timings.length,
          p50Ms: percentile(timings.map((entry) => typeof entry === 'number' ? entry : entry.durationMs), 50),
          p95Ms: percentile(timings.map((entry) => typeof entry === 'number' ? entry : entry.durationMs), 95)
        },
        failureHistory: {
          runs: failures.length,
          failures: failures.filter((entry) => entry === true || entry?.failed === true).length,
          lastFailureAt: failures.filter((entry) => entry?.failed === true && entry?.at).map((entry) => entry.at).sort().at(-1) ?? null
        },
        replacementTestIds: [],
        _retentionClass: metadata.retentionClass
      })
    }
  }

  applyEquivalence(records)
  return records.map(({ _semanticSignature, _retentionClass, _tierCategory, ...item }) => item)
}

export function reviewCandidateFiles(candidateFiles, records) {
  return candidateFiles.map((file) => {
    const fileRecords = records.filter((item) => item.path === file)
    const riskTags = [...new Set(fileRecords.flatMap((item) => item.riskTags ?? []))].sort()
    const replacementTestIds = [...new Set(fileRecords.flatMap((item) => item.replacementTestIds ?? (item.equivalentTo ? [item.equivalentTo] : [])))].sort()
    const allReplaceable = fileRecords.length > 0
      && fileRecords.every((item) => item.uniqueEvidence === false && item.equivalentTo)
      && replacementTestIds.length > 0
      && riskTags.length === 0

    const tests = fileRecords.map((item) => ({
      id: item.id,
      framework: item.framework,
      tierIds: item.tierIds ?? [],
      tierInvocationCount: Number(item.tierInvocationCount ?? item.invocationCount ?? 0),
      timing: item.timing ?? { samples: 0, p50Ms: null, p95Ms: null },
      coverageIds: item.coverageIds ?? [],
      assertionTargets: item.assertionTargets ?? [],
      failureHistory: item.failureHistory ?? { runs: 0, failures: 0, lastFailureAt: null },
      uniqueEvidence: item.uniqueEvidence !== false,
      replacementTestIds: item.replacementTestIds ?? (item.equivalentTo ? [item.equivalentTo] : [])
    }))

    return {
      path: file,
      decision: allReplaceable ? 'replaceable' : 'retain',
      reason: allReplaceable
        ? 'all tests have exact semantic, coverage, and framework replacements'
        : fileRecords.length === 0
          ? 'no auditable test record was extracted; retain fail-closed'
        : riskTags.length > 0
          ? `protected risk evidence: ${riskTags.join(', ')}`
          : `contains unique assertion or coverage evidence: ${fileRecords.filter((item) => item.uniqueEvidence !== false).map((item) => item.id).join(', ') || 'replacement set is incomplete'}`,
      testIds: fileRecords.map((item) => item.id).sort(),
      tests,
      replacementTestIds,
      riskTags,
      reviewed: true
    }
  })
}
