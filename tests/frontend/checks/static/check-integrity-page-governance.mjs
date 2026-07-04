#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const integrityPath = path.join(repoRoot, 'src/frontend/src/views/admin/Integrity.vue')
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function lineOf(source, token) {
  const index = source.indexOf(token)
  if (index < 0) {
    return 1
  }

  return source.slice(0, index).split(/\r?\n/).length
}

const source = read(integrityPath)
const forbiddenTokens = [
  'eyebrow=',
  '检查文章、评论、分类标签、session、上传文件、搜索与 sitemap 的一致性。',
  ':data="preview?.diffs ?? []"',
  'MFA proof',
  'MFA Proof',
  'MFA step-up',
  'changed fields',
  '展示 changed fields',
  '> - <',
  `{{ row.autoFixAvailable ? '可安全修复' : '-' }}`,
  'class="integrity-danger-zone',
  'class="integrity-risk-notice',
  'class="integrity-destructive-panel',
  'class="integrity-step-up-field',
  '.integrity-danger-zone',
  '.integrity-risk-notice',
  '.integrity-destructive-panel',
  '.integrity-step-up-field',
  'description="输入确认短语后才能应用安全修复。"',
  'description="如系统要求二次验证，请填写凭据。"',
  'blog-motion-task-region--pending',
  'blog-motion-task-region--settled',
  'isTaskHighlighted',
  'FsusUiFormSection',
  'FsusUiTypedConfirmField',
  'FsusUiDestructiveActionPanel',
  'FsusUiRiskNotice',
  '提交边界',
  '只提交安全字段；确认差异后输入短语。',
  '<code class="integrity-confirm-token">{{ CONFIRM_PHRASE }}</code>'
]

for (const token of forbiddenTokens) {
  if (source.includes(token)) {
    fail(integrityPath, lineOf(source, token), `Integrity page must not include ${token}`)
  }
}

const requiredTokens = [
  '检查内容关系、文件资产、账号状态与公开索引。',
  "type DiffPreviewState = 'not_loaded' | 'loading' | 'loaded_empty' | 'ready' | 'failed'",
  "diffPreviewState.value = 'loading'",
  "diffPreviewState.value = nextPreview.diffs.length > 0 ? 'ready' : 'loaded_empty'",
  "diffPreviewState.value = 'failed'",
  "diffPreviewStateView",
  '运行一键检查后显示可安全修复差异。',
  '没有可安全修复差异',
  '差异预览加载失败',
  '请重新运行内容一致性检查。',
  '写入前确认差异与短语。',
  "const USER_CONFIRM_PHRASE = '确认修复'",
  '二次验证凭据',
  '二次验证（如要求）',
  'class="integrity-apply-row"',
  'class="integrity-apply-controls"',
  'class="integrity-confirm-token"',
  'copyDiffValue',
  'formatDiffValue',
  'isTechnicalDiffValue',
  'CopyDocument',
  '复制字段',
  '未填写',
  '展示变更字段',
  'FsusUiDangerZone'
]

for (const token of requiredTokens) {
  if (!source.includes(token)) {
    fail(integrityPath, 1, `Integrity page contract is missing ${token}`)
  }
}

const scopedStyle = source.match(/<style scoped>(?<body>[\s\S]*?)<\/style>/u)?.groups?.body ?? ''
const selectorMatches = Array.from(scopedStyle.matchAll(/^\s*(\.[A-Za-z0-9_-]+)\s*\{/gmu))
const selectorCounts = new Map()
for (const [, selector] of selectorMatches) {
  selectorCounts.set(selector, (selectorCounts.get(selector) ?? 0) + 1)
}
for (const [selector, count] of selectorCounts) {
  if (count > 1) {
    fail(integrityPath, lineOf(source, selector), `Integrity page scoped selector is duplicated: ${selector}`)
  }
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-integrity-page-governance.mjs'
if (scripts['check:integrity-page-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:integrity-page-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:integrity-page-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:integrity-page-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[integrity-page-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[integrity-page-governance] ok')
