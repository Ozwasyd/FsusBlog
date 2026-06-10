#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))

function readJson(relativePath, optional = false) {
  const file = findEvidenceFile(relativePath)
  if (!file) {
    if (optional) return null
    throw new Error(`missing ${relativePath}`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function findEvidenceFile(relativePath) {
  const direct = path.join(root, relativePath)
  if (fs.existsSync(direct)) return direct

  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  if (!fs.existsSync(downloadedRoot)) return null
  const suffix = relativePath.replace(/^\.\//, '')
  const stack = [downloadedRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(next)
      } else if (next.endsWith(suffix)) {
        return next
      }
    }
  }
  return null
}

function findEvidenceFilesBySuffix(suffix) {
  const files = []
  const roots = [path.join(root, '.tmp')]
  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  if (fs.existsSync(downloadedRoot)) roots.push(downloadedRoot)
  for (const start of roots) {
    if (!fs.existsSync(start)) continue
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const next = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(next)
        } else if (next.endsWith(suffix)) {
          files.push(next)
        }
      }
    }
  }
  return [...new Set(files)]
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function positiveNumber(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value) && value > 0, `${label} must be > 0`)
}

function validateRuntimeProbe(probe, label) {
  assert(probe && typeof probe === 'object', `${label}.runtime missing`)
  assert(probe.measurementSource === 'runtime-http-probe', `${label}.runtime.measurementSource must be runtime-http-probe`)
  positiveNumber(probe.sampleCount, `${label}.runtime.sampleCount`)
  positiveNumber(probe.rps, `${label}.runtime.rps`)
  positiveNumber(probe.bytes, `${label}.runtime.bytes`)
  positiveNumber(probe.latencyMs?.p50, `${label}.runtime.latencyMs.p50`)
  positiveNumber(probe.latencyMs?.p95, `${label}.runtime.latencyMs.p95`)
  assert(Object.keys(probe.statusCounts ?? {}).some((status) => status.startsWith('2') || status.startsWith('3')), `${label}.runtime.statusCounts must include 2xx/3xx`)
}

function validateBackendQps() {
  const summary = readJson('.tmp/release-evidence/backend-qps-summary.json')
  assert(summary.status === 'ok', 'backend-qps-summary.status must be ok')
  assert(Array.isArray(summary.results) && summary.results.length > 0, 'backend-qps-summary.results must be non-empty')
  for (const result of summary.results) {
    const label = `backend-qps:${result.scenario ?? 'unknown'}`
    assert(result.evidenceType === 'runtime-http-probe', `${label}.evidenceType must be runtime-http-probe`)
    positiveNumber(result.rps, `${label}.rps`)
    positiveNumber(result.p50Ms, `${label}.p50Ms`)
    positiveNumber(result.p95Ms, `${label}.p95Ms`)
    validateRuntimeProbe(result.runtime, label)
  }
}

function validateDataScale() {
  const summary = readJson('.tmp/release-evidence/data-scale-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'data-scale-summary.status must be ok')
  validateRuntimeProbe(summary.observed?.runtime, 'data-scale')
  positiveNumber(summary.observed?.latencyMs?.p95, 'data-scale.latencyMs.p95')
}

function validateLoadProfiles() {
  const summaries = findEvidenceFilesBySuffix('/summary.json')
    .filter((file) => file.includes(`${path.sep}.tmp${path.sep}perf${path.sep}load-`))
  for (const file of summaries) {
    const relative = path.relative(root, file)
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert(summary.status === 'ok', `${relative}.status must be ok`)
    positiveNumber(summary.metrics?.rps, `${relative}.metrics.rps`)
    positiveNumber(summary.metrics?.p95Ms, `${relative}.metrics.p95Ms`)
    validateRuntimeProbe(summary.runtime, relative)
  }
}

function validateFaultInjection() {
  const summary = readJson('.tmp/fault-injection/summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'fault-injection.summary.status must be ok')
  positiveNumber(summary.caseCount, 'fault-injection.caseCount')
  assert(Array.isArray(summary.cases) && summary.cases.length === summary.caseCount, 'fault-injection.cases must match caseCount')
  for (const item of summary.cases) {
    assert(item.status === 'ok', `fault-injection ${item.case} must be ok`)
    positiveNumber(item.recoveryTimeMs, `fault-injection ${item.case}.recoveryTimeMs`)
  }
}

function validateSoak() {
  const summaries = findEvidenceFilesBySuffix('/summary.json')
    .filter((file) => file.includes(`${path.sep}.tmp${path.sep}soak${path.sep}`))
  for (const file of summaries) {
    const mode = path.basename(path.dirname(file))
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (summary.status === 'scheduled') {
      assert(mode !== 'short', 'short soak must be a runtime probe, not scheduled')
      continue
    }
    assert(summary.status === 'ok', `soak ${mode}.status must be ok`)
    positiveNumber(summary.durationSeconds, `soak ${mode}.durationSeconds`)
    positiveNumber(summary.sampleCount, `soak ${mode}.sampleCount`)
    positiveNumber(summary.latencyMs?.p95, `soak ${mode}.latencyMs.p95`)
  }
}

function validateCoverage() {
  const merged = readJson('.tmp/coverage/merged/Summary.json')
  const backend = readJson('.tmp/coverage/backend-merged/Summary.json')
  const frontend = readJson('.tmp/coverage/frontend/Summary.json')

  validateCoverageSummary(merged, 'coverage:merged')
  validateCoverageSummary(backend, 'coverage:backend')
  validateCoverageSummary(frontend, 'coverage:frontend')
  assert(merged.sources?.mergeMethod === 'covered-over-total-weighted', 'coverage:merged must use weighted totals')
  assert(backend.source === 'backend-cobertura', 'coverage:backend.source must be backend-cobertura')
  assert(frontend.source === 'frontend-vitest', 'coverage:frontend.source must be frontend-vitest')
}

function validateCoverageSummary(summary, label) {
  positiveNumber(summary.summary?.linecoverage, `${label}.summary.linecoverage`)
  positiveNumber(summary.totals?.lines?.total, `${label}.totals.lines.total`)
  assert(Number(summary.totals?.lines?.covered ?? -1) >= 0, `${label}.totals.lines.covered must be >= 0`)
  for (const sourcePath of summary.reportPaths ?? []) {
    assert(Boolean(findEvidenceFile(sourcePath)), `${label}.reportPaths missing source artifact ${sourcePath}`)
  }
  if (Array.isArray(summary.reportPaths)) {
    assert(summary.reportPaths.length > 0 || label === 'coverage:merged', `${label}.reportPaths must be non-empty`)
  }
  const syntheticAllHundred = summary.summary?.linecoverage === 100
    && summary.summary?.branchcoverage === 100
    && summary.summary?.methodcoverage === 100
    && !summary.totals
  assert(!syntheticAllHundred, `${label} looks like synthetic 100% coverage`)
}

function validateEndpointDepth() {
  const summary = readJson('.tmp/release-evidence/endpoint-depth-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'endpoint-depth-summary.status must be ok')
  positiveNumber(summary.runtimeCaseCount, 'endpoint-depth.runtimeCaseCount')
  assert(Array.isArray(summary.results) && summary.results.length === summary.runtimeCaseCount, 'endpoint-depth.results must match runtimeCaseCount')
  const scenarios = new Set(summary.scenarios ?? [])
  for (const required of ['wrong-method', 'wrong-accept', 'wrong-content-type']) {
    assert(scenarios.has(required), `endpoint-depth.scenarios must include ${required}`)
  }
  assert([...scenarios].some((item) => ['malformed-header', 'wrong-frame', 'truncated', 'oversized'].includes(item)), 'endpoint-depth must execute malformed protocol cases')
  assert([...scenarios].some((item) => ['missing-pow', 'tampered-pow', 'replayed-pow', 'expired-pow'].includes(item)), 'endpoint-depth must execute PoW negative cases')
  for (const result of summary.results) {
    assert(result.ok === true, `endpoint-depth ${result.id} must be ok`)
    positiveNumber(result.elapsedMs, `endpoint-depth ${result.id}.elapsedMs`)
  }
}

function main() {
  validateBackendQps()
  validateDataScale()
  validateLoadProfiles()
  validateFaultInjection()
  validateSoak()
  validateCoverage()
  validateEndpointDepth()
  console.log('[evidence-metrics] ok')
}

try {
  main()
} catch (error) {
  console.error(`[evidence-metrics] ${error.message}`)
  process.exit(1)
}
