#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const defaultCoverageRoot = path.join(root, '.tmp/coverage')
const policyPath = path.join(root, 'tests/coverage-policy.yml')

function fail(errors) {
  for (const error of errors) console.error(`[release-final-coverage] ${error}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sectionBlock(text, name) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `${name}:`)
  if (start < 0) return ''
  const indent = lines[start].match(/^(\s*)/)?.[1].length ?? 0
  const collected = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) {
      collected.push(line)
      continue
    }
    const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0
    if (currentIndent <= indent) break
    collected.push(line)
  }
  return collected.join('\n')
}

function numberInBlock(block, key, fallback = null) {
  const match = block.match(new RegExp(`^\\s*${key}:\\s*(\\d+(?:\\.\\d+)?)\\s*$`, 'm'))
  return match ? Number(match[1]) : fallback
}

function temporaryExceptions(text) {
  const block = sectionBlock(text, 'temporaryExceptions')
  if (!block.trim() || /\[\s*\]/.test(block)) return []

  const entries = []
  const lines = block.split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const start = line.match(/^\s*-\s+metric:\s*(.+?)\s*$/)
    if (start) {
      if (current) entries.push(current)
      current = { metric: start[1].trim() }
      continue
    }
    if (!current) continue
    const field = line.match(/^\s+(approvedUntil|reason):\s*(.+?)\s*$/)
    if (field) current[field[1]] = field[2].trim()
  }
  if (current) entries.push(current)
  return entries
}

function isActiveException(exception, now = new Date()) {
  if (!exception?.metric || !exception?.approvedUntil || !exception?.reason) return false
  const until = new Date(`${exception.approvedUntil}T23:59:59Z`)
  return Number.isFinite(until.getTime()) && now <= until
}

function loadPolicy(text) {
  const release = sectionBlock(text, 'releaseFinal')
  if (!release) throw new Error('tests/coverage-policy.yml missing releaseFinal section')
  return {
    backend: {
      line: numberInBlock(sectionBlock(release, 'backend'), 'line'),
      branch: numberInBlock(sectionBlock(release, 'backend'), 'branch')
    },
    frontend: {
      line: numberInBlock(sectionBlock(release, 'frontend'), 'line'),
      branch: numberInBlock(sectionBlock(release, 'frontend'), 'branch')
    },
    changedCode: {
      line: numberInBlock(sectionBlock(release, 'changedCode'), 'line')
    },
    criticalBackendModules: {
      branch: numberInBlock(sectionBlock(release, 'criticalBackendModules'), 'branch'),
      exceptionRequired: /exceptionRequired:\s*true/.test(sectionBlock(release, 'criticalBackendModules'))
    },
    temporaryExceptions: temporaryExceptions(text)
  }
}

function metric(summary, key) {
  return Number(summary?.summary?.[key] ?? summary?.[key] ?? NaN)
}

function hasActiveException(policy, label) {
  return policy.temporaryExceptions.some((exception) => exception.metric === label && isActiveException(exception))
}

function checkMetric(errors, policy, label, actual, threshold) {
  if (!Number.isFinite(threshold)) {
    errors.push(`${label}: policy threshold is missing`)
    return
  }
  if (!Number.isFinite(actual)) {
    errors.push(`${label}: metric is missing`)
    return
  }
  if (actual < threshold && !hasActiveException(policy, label)) errors.push(`${label}: ${actual} < ${threshold}`)
}

function criticalBranchCoverage(summary) {
  const files = summary?.files ?? summary?.summary?.files ?? []
  if (!Array.isArray(files) || files.length === 0) return null
  const critical = files.filter((file) => /src\/backend\/(Infrastructure\/Auth|Infrastructure\/Middlewares|Modules\/Endpoints\/Binary|Infrastructure\/Operations)/.test(String(file.path ?? file.file ?? '')))
  if (critical.length === 0) return null
  const values = critical
    .map((file) => Number(file.branchcoverage ?? file.branchCoverage ?? file.summary?.branchcoverage))
    .filter(Number.isFinite)
  if (values.length === 0) return null
  return Math.min(...values)
}

function validate({ coverageRoot = defaultCoverageRoot, policyText = fs.readFileSync(policyPath, 'utf8') } = {}) {
  const policy = loadPolicy(policyText)
  const errors = []
  const backendFile = path.join(coverageRoot, 'backend-merged/Summary.json')
  const frontendFile = path.join(coverageRoot, 'frontend/Summary.json')
  const changedFile = path.join(coverageRoot, 'changed-code/Summary.json')

  for (const file of [backendFile, frontendFile, changedFile]) {
    if (!fs.existsSync(file)) errors.push(`missing coverage summary: ${path.relative(root, file)}`)
  }
  if (errors.length > 0) return errors

  const backend = readJson(backendFile)
  const frontend = readJson(frontendFile)
  const changed = readJson(changedFile)

  checkMetric(errors, policy, 'backend line coverage', metric(backend, 'linecoverage'), policy.backend.line)
  checkMetric(errors, policy, 'backend branch coverage', metric(backend, 'branchcoverage'), policy.backend.branch)
  checkMetric(errors, policy, 'frontend line coverage', metric(frontend, 'linecoverage') || metric(frontend, 'statementcoverage'), policy.frontend.line)
  checkMetric(errors, policy, 'frontend branch coverage', metric(frontend, 'branchcoverage'), policy.frontend.branch)
  checkMetric(errors, policy, 'changed-code line coverage', metric(changed, 'linecoverage'), policy.changedCode.line)

  const criticalBranch = criticalBranchCoverage(backend)
  if (criticalBranch === null && policy.criticalBackendModules.exceptionRequired && !hasActiveException(policy, 'critical backend module branch coverage')) {
    errors.push('critical backend module branch coverage is missing; add file-level coverage or an approved release exception')
  } else if (criticalBranch !== null) {
    checkMetric(errors, policy, 'critical backend module branch coverage', criticalBranch, policy.criticalBackendModules.branch)
  }

  return errors
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-coverage-'))
  fs.mkdirSync(path.join(tmp, 'backend-merged'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'changed-code'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'backend-merged/Summary.json'), JSON.stringify({ summary: { linecoverage: 90, branchcoverage: 91 }, files: [{ path: 'src/backend/Infrastructure/Auth/AuthCookieService.cs', branchcoverage: 93 }] }))
  fs.writeFileSync(path.join(tmp, 'frontend/Summary.json'), JSON.stringify({ summary: { linecoverage: 80, branchcoverage: 70 } }))
  fs.writeFileSync(path.join(tmp, 'changed-code/Summary.json'), JSON.stringify({ summary: { linecoverage: 94 } }))
  const policy = [
    'releaseFinal:',
    '  backend:',
    '    line: 85',
    '    branch: 75',
    '  frontend:',
    '    line: 75',
    '    branch: 65',
    '  changedCode:',
    '    line: 90',
    '  criticalBackendModules:',
    '    branch: 90',
    '    exceptionRequired: true'
  ].join('\n')
  const errors = validate({ coverageRoot: tmp, policyText: policy })
  fs.rmSync(tmp, { recursive: true, force: true })
  if (errors.length > 0) fail([`self-test expected pass: ${errors.join('; ')}`])

  const exceptionTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-coverage-exception-'))
  fs.mkdirSync(path.join(exceptionTmp, 'backend-merged'), { recursive: true })
  fs.mkdirSync(path.join(exceptionTmp, 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(exceptionTmp, 'changed-code'), { recursive: true })
  fs.writeFileSync(path.join(exceptionTmp, 'backend-merged/Summary.json'), JSON.stringify({ summary: { linecoverage: 80, branchcoverage: 60 }, files: [] }))
  fs.writeFileSync(path.join(exceptionTmp, 'frontend/Summary.json'), JSON.stringify({ summary: { linecoverage: 30, branchcoverage: 25 } }))
  fs.writeFileSync(path.join(exceptionTmp, 'changed-code/Summary.json'), JSON.stringify({ summary: { linecoverage: 100 } }))
  const exceptionPolicy = [
    'temporaryExceptions:',
    '  - metric: backend line coverage',
    '    approvedUntil: 2999-12-31',
    '    reason: self test active exception',
    '  - metric: backend branch coverage',
    '    approvedUntil: 2999-12-31',
    '    reason: self test active exception',
    '  - metric: frontend line coverage',
    '    approvedUntil: 2999-12-31',
    '    reason: self test active exception',
    '  - metric: frontend branch coverage',
    '    approvedUntil: 2999-12-31',
    '    reason: self test active exception',
    '  - metric: critical backend module branch coverage',
    '    approvedUntil: 2999-12-31',
    '    reason: self test active exception',
    policy
  ].join('\n')
  const exceptionErrors = validate({ coverageRoot: exceptionTmp, policyText: exceptionPolicy })
  fs.rmSync(exceptionTmp, { recursive: true, force: true })
  if (exceptionErrors.length > 0) fail([`self-test expected temporary exceptions to pass: ${exceptionErrors.join('; ')}`])

  const expiredTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-coverage-expired-exception-'))
  fs.mkdirSync(path.join(expiredTmp, 'backend-merged'), { recursive: true })
  fs.mkdirSync(path.join(expiredTmp, 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(expiredTmp, 'changed-code'), { recursive: true })
  fs.writeFileSync(path.join(expiredTmp, 'backend-merged/Summary.json'), JSON.stringify({ summary: { linecoverage: 80, branchcoverage: 60 }, files: [] }))
  fs.writeFileSync(path.join(expiredTmp, 'frontend/Summary.json'), JSON.stringify({ summary: { linecoverage: 30, branchcoverage: 25 } }))
  fs.writeFileSync(path.join(expiredTmp, 'changed-code/Summary.json'), JSON.stringify({ summary: { linecoverage: 100 } }))
  const expiredErrors = validate({ coverageRoot: expiredTmp, policyText: exceptionPolicy.replaceAll('2999-12-31', '2000-01-01') })
  fs.rmSync(expiredTmp, { recursive: true, force: true })
  if (!expiredErrors.some((error) => error.includes('backend line coverage'))) {
    fail(['self-test expected expired temporary exceptions to fail'])
  }

  console.log('[release-final-coverage] self-test ok')
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  const errors = validate()
  if (errors.length > 0) fail(errors)
  console.log('[release-final-coverage] ok')
}
