#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const writePath = path.join(repoRoot, 'src/frontend/src/views/admin/article/Write.vue')
const sidebarPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleWriteSidebar.vue')
const seoPath = path.join(repoRoot, 'src/frontend/src/components/admin/article/ArticleSeoPreviewPanel.vue')
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

const write = read(writePath)
const sidebar = read(sidebarPath)
const seo = read(seoPath)

for (const [file, source, tokens] of [
  [writePath, write, [
    'account-page-eyebrow',
    '内容编辑',
    'write-side-tabs',
    'v-model="sidePanelTab"',
    'label="发布设置" name="publish"',
    'label="内容检查" name="check"',
    'label="预览" name="preview"',
    'label="历史版本" name="versions"',
    'label="资源" name="resources"',
    'layoutModeDescription',
    '生成摘要草稿',
    '检查草稿',
    '使用这版摘要',
    '根据当前标题与正文生成摘要草稿、标题备选、标签匹配和结构检查结果。'
  ]],
  [sidebarPath, sidebar, [
    'text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]',
    '发布状态',
    '文章头图',
    '所属分类',
    '标签索引',
    '内容摘要',
    'rounded-[var(--fsus-radius-popover)]',
    'border-dashed',
    'cover-action-overlay',
    'opacity-0',
    'group-hover:opacity-100'
  ]],
  [seoPath, seo, ['<dt>Slug</dt>', '<dt>Title</dt>', '<dt>Description</dt>']]
]) {
  for (const token of tokens) {
    if (source.includes(token)) {
      fail(file, lineOf(source, token), `Article editor workspace must not include ${token}`)
    }
  }
}

const requiredWriteTokens = [
  'class="write-inspector"',
  'class="write-inspector-section"',
  'openPreviewInspector',
  'openResourcesInspector',
  'openVersionsInspector',
  "editorLayoutModeLabel",
  '视图：{{ editorLayoutModeLabel }}',
  '内容检查',
  '生成摘要建议',
  '检查内容',
  '应用摘要',
  '应用标签',
  '应用标题',
  '应用翻译建议',
  '建议仅供参考，应用前可继续编辑。',
  '发布前 checklist'
]

for (const token of requiredWriteTokens) {
  if (!write.includes(token)) {
    fail(writePath, 1, `Article editor workspace contract is missing ${token}`)
  }
}

const requiredSidebarTokens = [
  'article-sidebar-section',
  'article-sidebar-summary',
  '<span>状态</span>',
  '<span>分类</span>',
  '<span>标签</span>',
  '<span>摘要</span>',
  '<span>头图</span>',
  '未设置',
  '建议比例 16:9。用于首页和文章页展示。',
  '移除',
  '留空时使用正文开头。'
]

for (const token of requiredSidebarTokens) {
  if (!sidebar.includes(token)) {
    fail(sidebarPath, 1, `Article editor sidebar contract is missing ${token}`)
  }
}

for (const token of ['地址片段', '标题长度', '摘要长度']) {
  if (!seo.includes(token)) {
    fail(seoPath, 1, `Article editor SEO panel contract is missing ${token}`)
  }
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-article-editor-workspace-governance.mjs'
if (scripts['check:article-editor-workspace-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:article-editor-workspace-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:article-editor-workspace-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:article-editor-workspace-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[article-editor-workspace-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[article-editor-workspace-governance] ok')
