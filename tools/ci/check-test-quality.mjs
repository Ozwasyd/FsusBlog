#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const summaryPath = path.join(root, '.tmp/release-evidence/test-quality-summary.json')

const assertionPatterns = [
  /\bAssert\./,
  /\bAssert[A-Za-z]+\(/,
  /\bexpect\s*\(/,
  /\bassert\s*\(/,
  /\.Should\(/,
  /\bthrow new Error\(/,
  /\bprocess\.exit\s*\(\s*1\s*\)/
]

const testFilePattern = /\.(test|spec)\.(ts|tsx|js|mjs|cs)$/u
const criticalPathPattern = /(security|auth|permission|contract|binary|aeds|migration|production|release)/iu
const negativePattern = /(invalid|reject|den(y|ied)|forbid|unauthor|expired|fail|error|tamper|oversized|wrong|missing|blocked)/iu

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['bin', 'obj', 'node_modules', 'coverage', 'test-results', 'playwright-report'].includes(entry.name)) continue
      walk(file, files)
    } else if (testFilePattern.test(entry.name)) {
      files.push(file)
    }
  }
  return files
}

function countMatches(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].length
}

function hasAssertion(text) {
  return assertionPatterns.some((pattern) => pattern.test(text))
}

function onlyHttp200Assertion(text) {
  const assertionCount = assertionPatterns.reduce((sum, pattern) => sum + countMatches(text, pattern), 0)
  const status200Count = countMatches(text, /(?:StatusCode\.OK|HttpStatusCode\.OK|status\(\)\)\.toBe\(200\)|status\)\.toBe\(200\)|response\.ok)/u)
  return assertionCount > 0 && assertionCount === status200Count
}

function snapshotOnlyCritical(text, file) {
  if (!criticalPathPattern.test(file)) return false
  const snapshotCount = countMatches(text, /toMatch(?:Inline)?Snapshot/u)
  if (snapshotCount === 0) return false
  const nonSnapshotAssertions = assertionPatterns.reduce((sum, pattern) => sum + countMatches(text, pattern), 0) - snapshotCount
  return nonSnapshotAssertions <= 0
}

function validateFiles(files) {
  const errors = []
  const stats = {
    files: files.length,
    criticalFiles: 0,
    negativeNamedFiles: 0,
    noAssertionFiles: [],
    weakHttp200OnlyFiles: [],
    snapshotOnlyCriticalFiles: []
  }

  for (const file of files) {
    const rel = path.relative(root, file).replaceAll(path.sep, '/')
    const text = fs.readFileSync(file, 'utf8')
    if (criticalPathPattern.test(rel)) stats.criticalFiles += 1
    if (negativePattern.test(text) || negativePattern.test(rel)) stats.negativeNamedFiles += 1
    if (!hasAssertion(text)) stats.noAssertionFiles.push(rel)
    if (onlyHttp200Assertion(text)) stats.weakHttp200OnlyFiles.push(rel)
    if (snapshotOnlyCritical(text, rel)) stats.snapshotOnlyCriticalFiles.push(rel)
  }

  if (stats.noAssertionFiles.length > 0) errors.push(`no-assertion tests: ${stats.noAssertionFiles.join(', ')}`)
  if (stats.weakHttp200OnlyFiles.length > 0) errors.push(`weak HTTP 200-only assertion tests: ${stats.weakHttp200OnlyFiles.join(', ')}`)
  if (stats.snapshotOnlyCriticalFiles.length > 0) errors.push(`snapshot-only critical tests: ${stats.snapshotOnlyCriticalFiles.join(', ')}`)
  if (stats.criticalFiles > 0 && stats.negativeNamedFiles === 0) {
    errors.push('critical test corpus has no negative-path tests')
  }

  return { errors, stats }
}

function writeSummary(status, stats, errors) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    schema: 'fsusblog.test-quality.v1',
    status,
    generatedAt: new Date().toISOString(),
    ...stats,
    errors
  }, null, 2)}\n`)
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-test-quality-'))
  const good = path.join(tmp, 'auth.test.ts')
  const bad = path.join(tmp, 'empty.test.ts')
  fs.writeFileSync(good, "test('rejects invalid token', () => { expect(401).toBe(401) })\n")
  fs.writeFileSync(bad, "test('does nothing', () => { const value = 1 })\n")
  const result = validateFiles([good, bad])
  fs.rmSync(tmp, { recursive: true, force: true })
  if (!result.errors.some((error) => error.includes('no-assertion'))) {
    console.error('[test-quality] self-test expected no-assertion violation')
    process.exit(1)
  }
  console.log('[test-quality] self-test ok')
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  const files = [
    ...walk(path.join(root, 'tests/backend')),
    ...walk(path.join(root, 'tests/frontend'))
  ]
  const { errors, stats } = validateFiles(files)
  writeSummary(errors.length === 0 ? 'ok' : 'failed', stats, errors)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[test-quality] ${error}`)
    process.exit(1)
  }
  console.log(`[test-quality] ok files=${stats.files} critical=${stats.criticalFiles} negative=${stats.negativeNamedFiles}`)
}
