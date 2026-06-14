#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const messagesPath = path.join(repoRoot, 'src/frontend/src/views/user/Messages.vue')
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')
const localComponentDir = path.join(repoRoot, 'src/frontend/src/components/user/messages')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

function fail(file, message) {
  failures.push(`${rel(file)}: ${message}`)
}

function assertIncludes(file, content, needle, message) {
  if (!content.includes(needle)) {
    fail(file, message)
  }
}

function assertNotIncludes(file, content, needle, message) {
  if (content.includes(needle)) {
    fail(file, message)
  }
}

const messages = read(messagesPath)

for (const token of [
  'account-page-eyebrow',
  'mail-header-eyebrow',
  '<el-empty',
  'mail-layout',
  'mail-pane',
  'mail-list-pane',
  'mail-detail-pane',
  'mail-flat-pane',
  'mail-item-stack',
  'mail-item',
  'mail-bubble',
  'mail-context-bar',
  'mail-reply-form',
  'mail-compose-panel',
  'mail-scroll-region',
  'mail-scroll-frame',
  'mail-scrollbar-native'
]) {
  assertNotIncludes(messagesPath, messages, token, `messages inbox must not use legacy ${token}`)
}

for (const componentName of [
  'MessagesConversationList',
  'MessagesThreadPanel',
  'MessagesComposePanel'
]) {
  assertIncludes(messagesPath, messages, componentName, `messages inbox must compose ${componentName}`)
}

for (const fileName of [
  'MessagesConversationList.vue',
  'MessagesThreadPanel.vue',
  'MessagesComposePanel.vue',
  'MessagesEmptyState.vue'
]) {
  const file = path.join(localComponentDir, fileName)
  if (!fs.existsSync(file)) {
    fail(file, 'local transition component is missing')
    continue
  }
  const content = read(file)
  assertNotIncludes(file, content, '<el-empty', 'compact inbox empty states must not use full el-empty')
  assertNotIncludes(file, content, 'mail-', 'local inbox transition components must not keep legacy mail-* primitives')
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-messages-inbox-governance.mjs'
if (scripts['check:messages-inbox-governance'] !== checkScript) {
  fail(packageJsonPath, 'check:messages-inbox-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:messages-inbox-governance')) {
  fail(packageJsonPath, 'check:views-constraints must run check:messages-inbox-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[messages-inbox-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[messages-inbox-governance] ok')
