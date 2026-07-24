#!/usr/bin/env node

// check-copy-centralization.mjs
//
// FsusBlog 前端文案集中化治理：@/copy 已原子的退役，所有 user-facing 文案
// 必须通过 `@/locales` 与 `useI18nText()` / `useI18n()` 动态获得。
//
// 调性校准依据：FsusUI design.md §1 (The Intellectual Minimalist) + §9 + §10 + §13.5。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')
const errors = []

const repoPath = (path) => resolve(repoRoot, path)
const relPath = (path) => relative(repoRoot, path).replaceAll('\\', '/')
const read = (path) => readFileSync(repoPath(path), 'utf8')

function addError(file, line, message) {
  errors.push(`${relPath(file)}:${line}: ${message}`)
}

// 1. Ensure retired @/copy directory does not exist
const retiredCopyDir = 'src/frontend/src/copy'
if (existsSync(repoPath(retiredCopyDir))) {
  addError(retiredCopyDir, 1, 'copy directory is retired and must not exist — use src/frontend/src/locales instead')
}

// 2. Ensure package.json governance scripts
const packageJson = JSON.parse(read('src/frontend/package.json'))
const scripts = packageJson.scripts ?? {}
if (scripts['check:copy-centralization'] !== 'node ../../tests/frontend/checks/static/check-copy-centralization.mjs') {
  addError('src/frontend/package.json', 1, 'missing check:copy-centralization script')
}
const viewsConstraints = String(scripts['check:views-constraints'] ?? '')
if (!viewsConstraints.includes('check:copy-centralization')) {
  addError('src/frontend/package.json', 1, 'check:views-constraints must run check:copy-centralization')
}

// 3. Ensure locales barrel and parity
const localesDir = 'src/frontend/src/locales'
if (!existsSync(repoPath(localesDir))) {
  addError(localesDir, 1, 'locales directory missing — expected src/frontend/src/locales')
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[copy-centralization] ${error}`)
  process.exit(1)
}

console.log('[copy-centralization] ok (locales governance enforced, @/copy retired)')
