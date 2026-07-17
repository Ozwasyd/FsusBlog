#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const allowedClassifications = new Set(['known-flaky', 'unknown-flaky', 'infra-transient', 'benchmark-noise', 'regression'])
const allowedFinalStatuses = new Set(['passed-after-retry', 'failed-after-retry', 'failed-no-retry', 'allow-failure-reported', 'skipped-with-evidence'])
const diagnosticSuites = new Set(['visual-playwright', 'ux-viewport-smoke', 'cross-browser-smoke'])

function findFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(file, predicate, results)
    else if (predicate(file)) results.push(file)
  }
  return results
}

function validate(item, file) {
  const errors = []
  if (item.schema !== 'fsusblog.ci.flaky.v1') errors.push(`${file}: schema must be fsusblog.ci.flaky.v1`)
  for (const field of ['suite', 'classification', 'issue', 'retryCount', 'finalStatus', 'generatedAt']) {
    if (item[field] === undefined || item[field] === null || item[field] === '') errors.push(`${file}: ${field} is required`)
  }
  if (!allowedClassifications.has(item.classification)) errors.push(`${file}: invalid classification ${item.classification}`)
  if (!allowedFinalStatuses.has(item.finalStatus)) errors.push(`${file}: invalid finalStatus ${item.finalStatus}`)
  if (!Number.isInteger(item.issue) || item.issue <= 0) errors.push(`${file}: issue must be a positive integer`)
  if (!Number.isInteger(item.retryCount) || item.retryCount < 0) errors.push(`${file}: retryCount must be zero or greater`)
  if (item.finalStatus === 'passed-after-retry' && item.retryCount < 1) errors.push(`${file}: passed-after-retry requires retryCount >= 1`)
  const hasEvidenceClass = item.evidenceClass !== undefined || item.affectsCorrectness !== undefined
  if (hasEvidenceClass) {
    const validPair = (item.evidenceClass === 'correctness' && item.affectsCorrectness === true)
      || (item.evidenceClass === 'diagnostic' && item.affectsCorrectness === false)
    if (!validPair) errors.push(`${file}: evidenceClass and affectsCorrectness must form a valid correctness/diagnostic pair`)
    if (item.evidenceClass === 'diagnostic' && !diagnosticSuites.has(item.suite)) {
      errors.push(`${file}: suite ${item.suite} is not registered as diagnostics-only`)
    }
  }
  return errors
}

function isNonBlockingDiagnosticEvidence(item) {
  return diagnosticSuites.has(item.suite)
    && item.evidenceClass === 'diagnostic'
    && item.affectsCorrectness === false
}

function checkEvidence({ releaseFinal, roots }) {
  const files = roots.flatMap((searchRoot) => findFiles(searchRoot, (file) => file.endsWith('.json') && file.includes(`${path.sep}flaky${path.sep}`)))
  const errors = []
  let count = 0
  for (const file of files) {
    let item
    try {
      item = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      errors.push(`${path.relative(root, file)}: ${error.message}`)
      continue
    }
    if (item.schema !== 'fsusblog.ci.flaky.v1') continue
    count += 1
    errors.push(...validate(item, path.relative(root, file)))
    if (releaseFinal && !isNonBlockingDiagnosticEvidence(item)) {
      errors.push(`${path.relative(root, file)}: release-final does not accept correctness flaky retry/skip evidence (${item.finalStatus})`)
    }
  }
  return { count, errors }
}

function defaultRoots() {
  return [
    path.join(root, '.tmp/release-evidence/flaky'),
    path.join(root, '.tmp/downloaded-artifacts')
  ]
}

function main() {
  const { count, errors } = checkEvidence({
    releaseFinal: process.argv.includes('--release-final'),
    roots: defaultRoots()
  })
  if (errors.length > 0) {
    for (const error of errors) console.error(`[flaky-evidence] ${error}`)
    process.exit(1)
  }
  console.log(`[flaky-evidence] ok evidence=${count}`)
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-flaky-diagnostic-'))
  const flakyDir = path.join(tmp, 'flaky')
  fs.mkdirSync(flakyDir, { recursive: true })
  const base = {
    schema: 'fsusblog.ci.flaky.v1',
    suite: 'visual-playwright',
    test: 'stale-diagnostic',
    classification: 'unknown-flaky',
    evidenceClass: 'diagnostic',
    affectsCorrectness: false,
    issue: 134,
    retryCount: 1,
    finalStatus: 'failed-after-retry',
    generatedAt: '2025-01-01T00:00:00.000Z'
  }
  fs.writeFileSync(path.join(flakyDir, 'diagnostic.json'), `${JSON.stringify(base)}\n`)
  const diagnostic = checkEvidence({ releaseFinal: true, roots: [tmp] })
  if (diagnostic.errors.length > 0) {
    throw new Error(`stale diagnostic evidence blocked correctness: ${diagnostic.errors.join('; ')}`)
  }
  fs.writeFileSync(path.join(flakyDir, 'correctness.json'), `${JSON.stringify({
    ...base,
    suite: 'acceptance-playwright',
    test: 'correctness',
    evidenceClass: 'correctness',
    affectsCorrectness: true
  })}\n`)
  const correctness = checkEvidence({ releaseFinal: true, roots: [tmp] })
  fs.rmSync(tmp, { recursive: true, force: true })
  if (!correctness.errors.some((error) => error.includes('correctness flaky retry/skip evidence'))) {
    throw new Error('correctness flaky evidence did not fail closed')
  }
  console.log('[flaky-evidence] self-test ok')
}

if (process.argv.includes('--self-test')) runSelfTest()
else main()
