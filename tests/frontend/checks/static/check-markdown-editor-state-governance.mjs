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
const articleWriteEditorPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleWriteEditor.vue')
const writePath = path.join(repoRoot, 'src/frontend/src/views/admin/article/Write.vue')
const providerPath = path.join(repoRoot, 'src/frontend/src/components/ui/markdownEditorProvider.ts')
const contractPath = path.join(repoRoot, 'src/frontend/src/ui-contracts/markdownEditor.ts')
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

const adapter = read(adapterPath)
const markdownTextEditor = read(markdownTextEditorPath)
const articleWriteEditor = read(articleWriteEditorPath)
const write = read(writePath)
const provider = read(providerPath)
const contract = read(contractPath)

for (const [file, source, tokens] of [
  [adapterPath, adapter, [
    'editor-shell__header',
    'editor-shell__title',
    'editor-shell__status',
    'editor-shell__modes',
    '>编辑</el-radio-button>',
    '>分屏</el-radio-button>',
    '>预览</el-radio-button>',
    'value="write"',
    'height: 2.5rem;',
    'Saving...',
    'Loading...',
    '<el-empty',
    '当前没有可预览内容',
    '{{ provider.label }}',
    'FsusUI MarkdownEditor',
    'Element Plus',
    ':deep(',
    '::v-deep',
    '.el-markdown-editor',
  ]],
  [articleWriteEditorPath, articleWriteEditor, [
    'status-text',
    'statusText',
    'editor-shell__header',
    'el-radio-group',
    'value="write"',
    ':deep(',
    '.el-markdown-editor',
  ]],
  [writePath, write, [
    'write-title-panel',
    'write-grid',
    'overflow-hidden',
  ]],
  [markdownTextEditorPath, markdownTextEditor, [
    "mode: 'write'",
    "return 'write'",
    'markdown-text-editor__status',
    '阅读时间',
    ':deep(',
    '.el-markdown-editor__',
  ]],
]) {
  for (const token of tokens) {
    if (source.includes(token)) {
      fail(file, 1, `Markdown editor canvas must not reintroduce ${token}`)
    }
  }
}

for (const token of [
  'chrome?: MarkdownEditorChrome',
  "chrome: 'framed'",
  "statusDensity: 'minimal'",
  "mode: 'source'",
  ':chrome="chrome"',
  ':status-density="statusDensity"',
  ':show-mode-switcher="showModeSwitcher"',
]) {
  if (!markdownTextEditor.includes(token)) {
    fail(markdownTextEditorPath, 1, `MarkdownTextEditor must consume FsusUI chrome/status props including ${token}`)
  }
}

for (const token of [
  'chrome="embedded"',
  'status-density="minimal"',
  ':show-mode-switcher="false"',
  'data-authoring-surface="live"',
  'data-authoring-surface="source"',
  'data-authoring-tool="source-compare"',
  "aria-label=\"编辑表面与对照工具\"",
]) {
  if (!articleWriteEditor.includes(token)) {
    fail(articleWriteEditorPath, 1, `ArticleWriteEditor must consume the embedded canvas contract including ${token}`)
  }
}

for (const token of [
  'class="write-document-canvas"',
  'data-editor-document-column="stable"',
  'id="article-body-heading"',
  'labelled-by="article-body-heading"',
  'padding-bottom: 5rem;',
]) {
  if (!write.includes(token) && !articleWriteEditor.includes(token)) {
    fail(writePath, 1, `Article document canvas contract is missing ${token}`)
  }
}

if (!articleWriteEditor.includes('labelled-by="article-body-heading"') && !write.includes('id="article-body-heading"')) {
  fail(writePath, 1, 'Article body accessible name must remain via heading or labelled-by')
}

if (!write.includes('id="article-body-heading"')) {
  fail(writePath, 1, 'Article body accessible name heading is missing')
}

if (!write.includes('class="write-document-canvas"')) {
  fail(writePath, 1, 'Article editor must keep title and body on one document canvas')
}

if (!write.includes('padding-bottom: 5rem;')) {
  fail(writePath, 1, 'Article workspace must reserve mobile space so the last body line stays reachable')
}

for (const token of [
  "chrome?: MarkdownEditorChrome",
  "statusDensity?: MarkdownEditorStatusDensity",
  "mode?: MarkdownEditorMode",
  "data-markdown-chrome",
  "data-status-density",
  "accessibleName: '正文'",
]) {
  if (!adapter.includes(token) && !contract.includes(token)) {
    fail(adapterPath, 1, `MarkdownEditorAdapter canvas contract is missing ${token}`)
  }
}

for (const token of [
  "export type MarkdownEditorChrome = 'framed' | 'embedded' | 'minimal'",
  "export type MarkdownEditorStatusDensity = 'none' | 'minimal' | 'detailed'",
  "export type MarkdownEditorMode = 'source' | 'live' | 'split' | 'preview'",
]) {
  if (!contract.includes(token)) {
    fail(contractPath, 1, `Markdown editor public mode/chrome contract is missing ${token}`)
  }
}

if (contract.includes("'write' |")) {
  fail(contractPath, 1, 'Markdown editor Blog mode contract must not keep write as a public mode')
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
if (!provider.includes("defaultMode: 'source'")) {
  fail(providerPath, 1, 'Markdown editor provider must default to the source editing surface')
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
