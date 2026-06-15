#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const adapterPath = path.join(repoRoot, 'src/frontend/src/components/ui/MarkdownEditorAdapter.vue')
const markdownTextEditorPath = path.join(repoRoot, 'src/frontend/src/components/ui/MarkdownTextEditor.vue')
const providerPath = path.join(repoRoot, 'src/frontend/src/components/ui/markdownEditorProvider.ts')
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

const adapter = read(adapterPath)
const adapterLines = adapter.split(/\r?\n/)
const markdownTextEditor = read(markdownTextEditorPath)
const provider = read(providerPath)

const forbiddenTokens = [
  'Saving...',
  'Loading...',
  '<el-empty',
  '当前没有可预览内容'
]

adapterLines.forEach((line, index) => {
  for (const token of forbiddenTokens) {
    if (line.includes(token)) {
      fail(adapterPath, index + 1, `Markdown editor preview/status must not include ${token}`)
    }
  }
})

const requiredTokens = [
  '保存中',
  '加载中',
  'preview-panel__state',
  'preview-panel__empty',
  '暂无预览内容',
  '开始编写后将在这里显示预览。',
  'preview-panel__state-actions',
  '刷新预览',
  'role="status"'
]

for (const token of requiredTokens) {
  if (!adapter.includes(token)) {
    fail(adapterPath, 1, `Markdown editor local-state contract is missing ${token}`)
  }
}

for (const token of [
  "import { ElMarkdownEditor",
  "'@ozwasyd/element-plus'",
  '<ElMarkdownEditor',
  ':commands="fsusUiCommands"',
  '@upload-image="requestImageUpload"',
  'insertMarkdownAtCursor',
]) {
  if (!markdownTextEditor.includes(token)) {
    fail(markdownTextEditorPath, 1, `MarkdownTextEditor must be a thin FsusUI MarkdownEditor wrapper with ${token}`)
  }
}

for (const pattern of [
  /<textarea\b/,
  /markdown-text-editor__textarea/,
  /box-shadow:\s*inset 0 0 0 1px var\(--fsusblog-color-focus-ring\)/,
  /\.markdown-text-editor__textarea:focus-visible/,
]) {
  if (pattern.test(markdownTextEditor)) {
    fail(markdownTextEditorPath, 1, `MarkdownTextEditor must not reintroduce Blog-local textarea/focus ownership matching ${pattern}`)
  }
}

if (!provider.includes("id: 'fsusui-markdown-editor'")) {
  fail(providerPath, 1, 'Markdown editor provider must identify the FsusUI MarkdownEditor provider')
}
if (!provider.includes("label: 'FsusUI MarkdownEditor'")) {
  fail(providerPath, 1, 'Markdown editor provider label must surface FsusUI ownership')
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-markdown-editor-state-governance.mjs'
if (scripts['check:markdown-editor-state-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:markdown-editor-state-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:markdown-editor-state-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:markdown-editor-state-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[markdown-editor-state-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[markdown-editor-state-governance] ok')
