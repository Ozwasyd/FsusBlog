#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { relative, root } from './lib/matrix.mjs'

const packageFile = path.join(root, 'src/frontend/package.json')
const readmeFile = path.join(root, 'README.md')
const outFile = path.join(path.resolve(process.env.FSUSBLOG_DOCS_EVIDENCE_DIR || path.join(root, '.tmp/docs')), 'version-table-check.json')

function dependencyVersion(pkg, name) {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null
}

function versionLine(raw, mode = 'minor') {
  const cleaned = String(raw ?? '').replace(/^[~^]/u, '')
  const [major, minor] = cleaned.split('.')
  if (!major || !/^\d+$/u.test(major)) return null
  if (mode === 'major') return `${major}.x`
  if (!minor || !/^\d+$/u.test(minor)) return `${major}.${minor}.x`
  return `${major}.${minor}.x`
}

function writeSummary(status, errors, expected) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    readme: relative(readmeFile),
    package: relative(packageFile),
    expected,
    errors
  }, null, 2)}\n`)
}

const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
const readme = fs.readFileSync(readmeFile, 'utf8')
const expected = [
  ['Vue', versionLine(dependencyVersion(pkg, 'vue'), 'minor')],
  ['Vite', versionLine(dependencyVersion(pkg, 'vite'), 'major')],
  ['TypeScript', versionLine(dependencyVersion(pkg, 'typescript'), 'major')],
  ['Tailwind CSS', versionLine(dependencyVersion(pkg, 'tailwindcss'), 'minor')],
  ['Pinia', versionLine(dependencyVersion(pkg, 'pinia'), 'minor')],
  ['Vue Router', versionLine(dependencyVersion(pkg, 'vue-router'), 'minor')],
  ['Playwright', versionLine(dependencyVersion(pkg, '@playwright/test'), 'minor')]
]

const errors = []
for (const [label, expectedVersion] of expected) {
  if (!expectedVersion) {
    errors.push(`${label} version is missing from package metadata`)
    continue
  }
  const pattern = new RegExp(`\\|\\s*${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\|\\s*${expectedVersion.replace('.', '\\.').replace('x', 'x')}\\s*\\|`, 'u')
  if (!pattern.test(readme)) {
    errors.push(`README version table must contain ${label} ${expectedVersion}`)
  }
}

writeSummary(errors.length === 0 ? 'ok' : 'failed', errors, Object.fromEntries(expected))
if (errors.length > 0) {
  for (const error of errors) console.error(`[version-table] ${error}`)
  process.exit(1)
}
console.log('[version-table] ok')
