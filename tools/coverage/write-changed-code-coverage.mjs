#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const coverageRoot = process.env.FSUSBLOG_COVERAGE_ROOT || path.join(root, '.tmp/coverage')
const mergedSummary = path.join(coverageRoot, 'merged/Summary.json')
const outFile = path.join(coverageRoot, 'changed-code/Summary.json')

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function changedFiles() {
  if (process.env.FSUSBLOG_CHANGED_FILES) {
    return process.env.FSUSBLOG_CHANGED_FILES.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
  }
  const base = process.env.FSUSBLOG_CHANGED_BASE || 'origin/master'
  const diff = git(['diff', '--name-only', `${base}...HEAD`])
  const changed = diff ?? git(['diff', '--name-only', 'HEAD~1..HEAD']) ?? ''
  return changed.split(/\r?\n/).map((item) => item.trim()).filter((item) =>
    item.startsWith('src/backend/') || item.startsWith('src/frontend/src/') || item.startsWith('src/shared/') || item.startsWith('src/core/')
  )
}

function fileCoverage(summary, file) {
  const files = summary.files ?? summary.summary?.files ?? []
  if (!Array.isArray(files)) return null
  const normalized = file.replaceAll(path.sep, '/')
  const match = files.find((item) => String(item.path ?? item.file ?? '').replaceAll(path.sep, '/').endsWith(normalized))
  if (!match) return null
  return {
    linecoverage: Number(match.linecoverage ?? match.lineCoverage ?? match.summary?.linecoverage),
    branchcoverage: Number(match.branchcoverage ?? match.branchCoverage ?? match.summary?.branchcoverage)
  }
}

if (!fs.existsSync(mergedSummary)) {
  console.error(`[changed-code-coverage] missing ${path.relative(root, mergedSummary)}`)
  process.exit(1)
}

const summary = JSON.parse(fs.readFileSync(mergedSummary, 'utf8'))
const files = changedFiles()
const sourceFiles = files.filter((file) => /\.(cs|ts|tsx|js|mjs)$/u.test(file))
let result
if (sourceFiles.length === 0) {
  result = {
    summary: { linecoverage: 100, branchcoverage: 100, methodcoverage: 100 },
    changedFiles: [],
    status: 'ok',
    reason: 'no changed source files'
  }
} else {
  const covered = sourceFiles.map((file) => ({ file, coverage: fileCoverage(summary, file) }))
  const missing = covered.filter((item) => item.coverage === null)
  if (missing.length > 0) {
    result = {
      summary: { linecoverage: 0, branchcoverage: 0, methodcoverage: 0 },
      changedFiles: sourceFiles,
      missingFileCoverage: missing.map((item) => item.file),
      status: 'blocked'
    }
  } else {
    const lines = covered.map((item) => item.coverage.linecoverage).filter(Number.isFinite)
    const branches = covered.map((item) => item.coverage.branchcoverage).filter(Number.isFinite)
    result = {
      summary: {
        linecoverage: Math.min(...lines),
        branchcoverage: branches.length > 0 ? Math.min(...branches) : 100,
        methodcoverage: 100
      },
      changedFiles: sourceFiles,
      status: 'ok'
    }
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`)
console.log(`[changed-code-coverage] wrote ${path.relative(root, outFile)} status=${result.status}`)
if (result.status !== 'ok') process.exit(1)
