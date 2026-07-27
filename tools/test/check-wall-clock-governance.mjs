#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTemporalLedger, TemporalContractError } from './temporal-context.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const clockApiPatterns = Object.freeze([
  ['Date.now', /\bDate\.now\s*\(\s*\)/gu],
  ['new Date()', /\bnew\s+Date\s*\(\s*\)/gu],
  ['DateTime.UtcNow', /\bDateTime\.UtcNow\b/gu],
  ['DateTimeOffset.UtcNow', /\bDateTimeOffset\.UtcNow\b/gu],
  ['TimeProvider.System', /\bTimeProvider\.System\b/gu],
  ['clock_timestamp', /\bclock_timestamp\s*\(\s*\)/giu],
  ['postgres.now', /(?<![.\w])now\s*\(\s*\)/giu],
  ['CURRENT_TIMESTAMP', /\bCURRENT_TIMESTAMP\b/giu],
  ['mtime', /\.(?:mtime|mtimeMs|mtimeNs)\b/gu],
  ['performance.now', /\bperformance\.now\s*\(\s*\)/gu],
  ['process.hrtime.bigint', /\bprocess\.hrtime\.bigint\s*\(\s*\)/gu],
  ['Stopwatch', /\bStopwatch\.(?:StartNew|GetTimestamp)\s*\(/gu]
])

function fail(reasonCode, message, details = {}) {
  throw new TemporalContractError(reasonCode, message, details)
}

function occurrences(source) {
  const found = []
  for (const [api, pattern] of clockApiPatterns) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      found.push({ api, index: match.index, text: match[0] })
    }
  }
  return found.sort((left, right) => left.index - right.index || left.api.localeCompare(right.api))
}

export function validateWallClockGovernance({ ledger, sources }) {
  const unresolved = ledger.entries.filter((entry) =>
    entry.disposition === 'unknown' || entry.disposition === 'requires-explicit')
  if (unresolved.length > 0) {
    fail('temporal.ledger-unresolved', 'ledger contains unresolved dispositions', {
      callSiteIds: unresolved.map((entry) => entry.callSiteId)
    })
  }

  const governed = new Set(ledger.governedSources)
  const duplicateSources = ledger.governedSources.filter((source, index) =>
    ledger.governedSources.indexOf(source) !== index)
  if (duplicateSources.length > 0) {
    fail('temporal.ledger-source-mismatch', 'governedSources contains duplicates', { duplicateSources })
  }
  for (const entry of ledger.entries) {
    if (!governed.has(entry.path)) {
      fail('temporal.ledger-source-mismatch', `${entry.callSiteId} path is outside governedSources`)
    }
    if (entry.clockKind === 'business-wall'
        && (entry.authorityKind !== 'canonical-business-epoch' || entry.ingress !== 'canonical-injected')) {
      fail('temporal.context-invalid', `${entry.callSiteId} business clock lacks canonical injection`)
    }
    if (entry.clockKind === 'monotonic-measurement'
        && (entry.authorityKind !== 'runtime-monotonic' || entry.ingress !== 'runtime-monotonic')) {
      fail('temporal.mixed-clock', `${entry.callSiteId} measurement clock is not runtime monotonic`)
    }
    if (entry.api === 'mtime' && entry.ingress !== 'operability-only') {
      fail('temporal.context-invalid', `${entry.callSiteId} mtime may only support operability`)
    }
  }

  const entriesByPath = Map.groupBy(ledger.entries, (entry) => entry.path)
  for (const sourcePath of governed) {
    const source = sources.get(sourcePath)
    if (typeof source !== 'string') {
      fail('temporal.ledger-source-mismatch', `governed source is missing: ${sourcePath}`)
    }
    const discovered = occurrences(source)
    const entries = entriesByPath.get(sourcePath) ?? []
    const covered = new Set()
    for (const entry of entries) {
      const first = source.indexOf(entry.sourceAnchor)
      const second = first < 0 ? -1 : source.indexOf(entry.sourceAnchor, first + entry.sourceAnchor.length)
      if (first < 0 || second >= 0) {
        fail('temporal.ledger-source-mismatch', `${entry.callSiteId} sourceAnchor must resolve exactly once`)
      }
      const matching = discovered.filter((candidate) =>
        candidate.api === entry.api
        && candidate.index >= first
        && candidate.index < first + entry.sourceAnchor.length)
      if (matching.length !== 1) {
        fail('temporal.ledger-source-mismatch', `${entry.callSiteId} does not bind exactly one ${entry.api} call`)
      }
      const key = `${matching[0].api}:${matching[0].index}`
      if (covered.has(key)) fail('temporal.ledger-source-mismatch', `clock call has duplicate owners: ${sourcePath}:${key}`)
      covered.add(key)
    }
    const uncovered = discovered.filter((candidate) => !covered.has(`${candidate.api}:${candidate.index}`))
    if (uncovered.length > 0) {
      fail('temporal.ledger-unresolved', `governed source has unowned clock calls: ${sourcePath}`, { uncovered })
    }
  }

  const mixedSymbols = [...Map.groupBy(ledger.entries, (entry) => `${entry.path}#${entry.symbol}`)]
    .filter(([, entries]) => new Set(entries.map((entry) => entry.clockKind)).size > 1)
    .map(([symbol]) => symbol)
  if (mixedSymbols.length > 0) {
    fail('temporal.mixed-clock', 'symbols mix temporal clock kinds', { mixedSymbols })
  }

  return {
    callSiteCount: ledger.entries.length,
    mixedClockCount: 0,
    pendingCount: 0,
    unknownCount: 0,
    governedSourceCount: governed.size
  }
}

export function verifyRepositoryWallClockGovernance() {
  const { document } = readTemporalLedger()
  const sources = new Map(document.governedSources.map((sourcePath) => [
    sourcePath,
    readFileSync(path.join(repositoryRoot, sourcePath), 'utf8')
  ]))
  return validateWallClockGovernance({ ledger: document, sources })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyRepositoryWallClockGovernance()
    process.stdout.write(`[wall-clock-governance] ok callSites=${result.callSiteCount} sources=${result.governedSourceCount} pending=0 unknown=0 mixedClock=0\n`)
  } catch (error) {
    process.stderr.write(`[wall-clock-governance] ${error?.reasonCode ?? 'temporal.context-invalid'} ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
