#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const sourceRoot = path.join(repoRoot, 'src/frontend/src')
const adminAccountRoots = [
  'src/frontend/src/views/admin',
  'src/frontend/src/views/user',
  'src/frontend/src/components/admin',
  'src/frontend/src/components/user'
].map((dir) => path.join(repoRoot, dir))

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')

const directElEmptyAllowlist = new Map([
  [
    'src/frontend/src/components/ui/MarkdownEditorAdapter.vue',
    'Authoring/editor preview state is tracked by FsusBlog #220.'
  ]
])

const dashPlaceholderAllowlist = [
  {
    file: 'src/frontend/src/views/user/Profile.vue',
    needle: '<span v-else>-</span>',
    reason: 'Row-level missing session timestamp placeholder, not a panel empty state.'
  },
  {
    file: 'src/frontend/src/views/admin/moderation/ModerationReplay.vue',
    needle: '<span v-if="row.addedBlockedRegions.length + row.removedBlockedRegions.length === 0">-</span>',
    reason: 'Row-level no-change marker inside a populated replay table.'
  },
  {
    file: 'src/frontend/src/views/admin/moderation/ModerationReplay.vue',
    needle: '<span v-if="row.addedRiskLabels.length + row.removedRiskLabels.length === 0">-</span>',
    reason: 'Row-level no-change marker inside a populated replay table.'
  }
]

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files
  }

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

function tableTokens(line) {
  const tokens = []
  const pattern = /<el-table(?=[\s>])|<\/el-table>|<template\s+#empty\b/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    tokens.push({ value: match[0], index: match.index })
  }
  return tokens.sort((left, right) => left.index - right.index)
}

function checkTables(file, content) {
  const stack = []
  const lines = content.split(/\r?\n/)

  lines.forEach((line, index) => {
    for (const token of tableTokens(line)) {
      if (token.value.startsWith('<el-table')) {
        stack.push({ line: index + 1, hasEmpty: false })
        continue
      }

      if (token.value.startsWith('<template')) {
        const current = stack.at(-1)
        if (current) {
          current.hasEmpty = true
        }
        continue
      }

      const current = stack.pop()
      if (current && !current.hasEmpty) {
        fail(file, current.line, 'admin/account el-table must provide a localized compact #empty slot')
      }
    }
  })

  for (const unclosed of stack) {
    fail(file, unclosed.line, 'admin/account el-table appears unclosed; empty-state governance cannot verify it')
  }
}

function isDashPlaceholderAllowed(file, line) {
  const relative = rel(file)
  return dashPlaceholderAllowlist.some((entry) =>
    entry.file === relative && line.includes(entry.needle)
  )
}

for (const file of walk(sourceRoot)) {
  const relative = rel(file)
  const content = read(file)
  const lines = content.split(/\r?\n/)

  lines.forEach((line, index) => {
    if (/<el-empty\b/.test(line) && !directElEmptyAllowlist.has(relative)) {
      fail(file, index + 1, 'direct el-empty is forbidden in FsusBlog admin/account scope; use a copy-owned inline state')
    }

    if (/\bNo Data\b/.test(line)) {
      fail(file, index + 1, 'literal No Data must not appear in frontend source')
    }
  })
}

for (const file of adminAccountRoots.flatMap((dir) => walk(dir))) {
  const content = read(file)
  const lines = content.split(/\r?\n/)

  checkTables(file, content)

  lines.forEach((line, index) => {
    if (/>-<\/\w+>/.test(line) && !isDashPlaceholderAllowed(file, line)) {
      fail(file, index + 1, 'standalone "-" must not be used as a panel empty state; use contextual copy')
    }
  })
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-admin-empty-state-governance.mjs'
if (scripts['check:admin-empty-state-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:admin-empty-state-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:admin-empty-state-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:admin-empty-state-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-empty-state-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[admin-empty-state-governance] ok')
