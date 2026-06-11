#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const registryPath = path.join(root, 'tests/flaky.yml')
const summaryPath = path.join(root, '.tmp/release-evidence/flaky/registry.json')
const allowedModes = new Set(['retry-and-report', 'allow-failure-but-report', 'skip-with-evidence'])
const allowedClassifications = new Set(['known-flaky', 'unknown-flaky', 'infra-transient', 'benchmark-noise'])

function parseValue(raw) {
  const value = String(raw ?? '').trim()
  if (value === '[]') return []
  if (/^-?\d+$/u.test(value)) return Number(value)
  if (value === 'true') return true
  if (value === 'false') return false
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseRegistry(text) {
  const registry = { entries: [] }
  let inEntries = false
  let current = null

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, '')
    if (!line.trim()) continue

    const top = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (top && !rawLine.startsWith(' ')) {
      const [, key, value] = top
      if (key === 'entries') {
        inEntries = true
        registry.entries = Array.isArray(parseValue(value)) ? parseValue(value) : []
        current = null
      } else {
        registry[key] = parseValue(value)
        inEntries = false
      }
      continue
    }

    if (!inEntries) continue
    const item = line.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (item) {
      current = {}
      registry.entries.push(current)
      current[item[1]] = parseValue(item[2])
      continue
    }
    const field = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u)
    if (field && current) current[field[1]] = parseValue(field[2])
  }

  return registry
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10)
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))
}

function validateRegistry(registry) {
  const errors = []
  const releaseFinal = process.argv.includes('--release-final')
  if (registry.version !== 'fsusblog-flaky-v1') errors.push(`version must be fsusblog-flaky-v1, got ${registry.version ?? 'missing'}`)
  if (!Array.isArray(registry.entries)) errors.push('entries must be an array')

  const ids = new Set()
  const today = todayUtcDate()
  for (const entry of registry.entries ?? []) {
    const id = entry.id ?? '<missing-id>'
    if (!entry.id || typeof entry.id !== 'string') errors.push(`${id}: id is required`)
    if (ids.has(entry.id)) errors.push(`${id}: duplicate id`)
    ids.add(entry.id)
    for (const field of ['suite', 'test', 'issue', 'reason', 'expires', 'allowedRetries', 'owner', 'mode', 'classification']) {
      if (entry[field] === undefined || entry[field] === null || entry[field] === '') errors.push(`${id}: ${field} is required`)
    }
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) errors.push(`${id}: issue must be a positive integer`)
    if (!Number.isInteger(entry.allowedRetries) || entry.allowedRetries < 0 || entry.allowedRetries > 1) {
      errors.push(`${id}: allowedRetries must be 0 or 1`)
    }
    if (!isIsoDate(entry.expires)) errors.push(`${id}: expires must use YYYY-MM-DD`)
    else if (entry.expires < today) errors.push(`${id}: expires ${entry.expires} is before ${today}`)
    if (!allowedModes.has(entry.mode)) errors.push(`${id}: mode must be one of ${[...allowedModes].join(', ')}`)
    if (!allowedClassifications.has(entry.classification)) errors.push(`${id}: classification must be one of ${[...allowedClassifications].join(', ')}`)
    if (entry.mode === 'skip-with-evidence' && String(entry.reason).length < 12) {
      errors.push(`${id}: skip-with-evidence requires a specific reason`)
    }
    if (entry.linkedIssue !== undefined && (!Number.isInteger(entry.linkedIssue) || entry.linkedIssue <= 0)) {
      errors.push(`${id}: linkedIssue must be a positive integer when present`)
    }
    if (entry.expiresAt !== undefined && !isIsoDate(entry.expiresAt)) {
      errors.push(`${id}: expiresAt must use YYYY-MM-DD when present`)
    }
    if (entry.maxQuarantineDays !== undefined && (!Number.isInteger(entry.maxQuarantineDays) || entry.maxQuarantineDays < 1)) {
      errors.push(`${id}: maxQuarantineDays must be a positive integer when present`)
    }
    if (releaseFinal) {
      const criticalSuite = /security|static|contract|migration|coverage|release/i.test(String(entry.suite ?? ''))
      if (criticalSuite && Number(entry.allowedRetries) > 0) {
        errors.push(`${id}: release-final forbids retry quarantine for critical suite ${entry.suite}`)
      }
      if (entry.releaseBlocker === true || criticalSuite) {
        errors.push(`${id}: release-final blocks critical flaky quarantine`)
      }
      if (entry.mode === 'skip-with-evidence') {
        errors.push(`${id}: release-final does not allow skip-with-evidence quarantine`)
      }
    }
  }
  return errors
}

function writeSummary(status, registry, errors) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    schema: 'fsusblog.ci.flaky-registry.v1',
    status,
    generatedAt: new Date().toISOString(),
    registry: 'tests/flaky.yml',
    entryCount: registry.entries?.length ?? 0,
    classifications: Object.fromEntries((registry.entries ?? []).map((entry) => [entry.id, entry.classification])),
    errors
  }, null, 2)}\n`)
}

function main() {
  if (!fs.existsSync(registryPath)) throw new Error('missing tests/flaky.yml')
  const registry = parseRegistry(fs.readFileSync(registryPath, 'utf8'))
  const errors = validateRegistry(registry)
  writeSummary(errors.length === 0 ? 'ok' : 'failed', registry, errors)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[flaky-registry] ${error}`)
    process.exit(1)
  }
  console.log(`[flaky-registry] ok entries=${registry.entries.length}`)
}

try {
  main()
} catch (error) {
  writeSummary('failed', { entries: [] }, [error.message])
  console.error(`[flaky-registry] ${error.message}`)
  process.exit(1)
}
