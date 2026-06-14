#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')
const targetRoots = [
  'src/frontend/src/views/admin',
  'src/frontend/src/views/user',
  'src/frontend/src/components/admin'
].map((dir) => path.join(repoRoot, dir))

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')
const accountPageHeaderPath = path.join(repoRoot, 'src/frontend/src/components/account/AccountPageHeader.vue')
const workbenchPanelPath = path.join(repoRoot, 'src/frontend/src/components/account/WorkbenchPanel.vue')

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, files)
      continue
    }

    if (entry.isFile() && /\.(vue|ts)$/.test(entry.name)) {
      files.push(fullPath)
    }
  }

  return files
}

function hasAllowComment(lines, index) {
  return /fsus-allow-eyebrow:/.test(lines[index] ?? '')
    || /fsus-allow-eyebrow:/.test(lines[index - 1] ?? '')
}

for (const file of targetRoots.flatMap((dir) => walk(dir))) {
  const lines = read(file).split(/\r?\n/)
  lines.forEach((line, index) => {
    if (hasAllowComment(lines, index)) {
      return
    }

    if (/\beyebrow\s*=/.test(line)) {
      fail(file, index + 1, 'admin/account screens must not pass eyebrow props without an explicit fsus-allow-eyebrow comment')
    }

    if (/\beyebrow\s*:/.test(line)) {
      fail(file, index + 1, 'admin/account screen data must not model decorative eyebrow fields')
    }

    if (/account-page-eyebrow/.test(line)) {
      fail(file, index + 1, 'page views must not render account-page-eyebrow directly')
    }
  })
}

const accountPageHeader = read(accountPageHeaderPath)
if (!accountPageHeader.includes('v-if="eyebrow"')) {
  fail(accountPageHeaderPath, 1, 'AccountPageHeader must render eyebrow only when explicitly provided')
}
if (!accountPageHeader.includes('rare opt-in context marker')) {
  fail(accountPageHeaderPath, 1, 'AccountPageHeader must document eyebrow as an opt-in exception')
}

const workbenchPanel = read(workbenchPanelPath)
if (!workbenchPanel.includes('eyebrow?: string')) {
  fail(workbenchPanelPath, 1, 'WorkbenchPanel may keep optional eyebrow support for justified exceptions')
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-admin-eyebrow-governance.mjs'
if (scripts['check:admin-eyebrow-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:admin-eyebrow-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:admin-eyebrow-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:admin-eyebrow-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-eyebrow-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[admin-eyebrow-governance] ok')
