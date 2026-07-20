#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const adminWorkspacePath = path.join(repoRoot, 'src/frontend/src/assets/admin-workspace.css')
const adminWorkspace = fs.readFileSync(adminWorkspacePath, 'utf8')
const failures = []

function requireToken(source, token, message) {
  if (!source.includes(token)) failures.push(message)
}

function forbidToken(source, token, message) {
  if (source.includes(token)) failures.push(message)
}

const writeButtonSelector = '.admin-workspace-frame .article-list-toolbar-buttons .article-list-write-button:not(.is-plain)'
requireToken(adminWorkspace, writeButtonSelector, 'article write primary override must be scoped to the write button and exclude plain buttons')
forbidToken(adminWorkspace, '.admin-workspace-frame .el-button--primary {', 'admin primary override must not affect every primary button')
for (const token of [
  '--el-button-bg-color: #0F0F11;',
  '--el-button-border-color: #0F0F11;',
  '--el-button-text-color: #FFFFFF;',
  '--el-button-hover-bg-color: #2A599C;',
  '--el-button-active-bg-color: #244E89;',
  '--el-button-bg-color: #F0F0F4;',
  '--el-button-text-color: #09090B;',
  '--el-button-hover-bg-color: #4B79CC;',
  '--el-button-active-bg-color: #6F93D7;',
  'height: 44px;',
  'min-height: 44px;',
  'border-radius: var(--fsus-radius-control, 6px);'
]) {
  requireToken(adminWorkspace, token, `article write primary contract is missing ${token}`)
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-global-visual] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[admin-global-visual] ok')
