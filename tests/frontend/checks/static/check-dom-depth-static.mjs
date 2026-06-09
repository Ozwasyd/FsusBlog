#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const srcDir = path.join(root, 'src/frontend/src')
const outFile = path.join(root, '.tmp/frontend/dom-depth-static.json')
const releaseSummaryFile = path.join(root, '.tmp/release-evidence/frontend-render-pressure-summary.json')

const routeFiles = new Set([
  'src/frontend/src/views/admin/article/Write.vue',
  'src/frontend/src/views/user/Messages.vue',
  'src/frontend/src/views/admin/UserManage.vue',
  'src/frontend/src/views/admin/article/List.vue',
  'src/frontend/src/views/ArticleDetail.vue'
])
const heavyWritePage = 'src/frontend/src/views/admin/article/Write.vue'
const highPressureFiles = new Set([
  heavyWritePage,
  'src/frontend/src/components/ui/MarkdownEditorAdapter.vue',
  'src/frontend/src/views/user/Messages.vue',
  'src/frontend/src/components/article/ArticleCommentsVirtualList.vue',
  'src/frontend/src/public-renderers/PublicArticleCommentsIsland.vue',
  'src/frontend/src/components/admin/users/UserManageTable.vue',
  'src/frontend/src/components/admin/article/ArticleAssetLibraryPanel.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue',
  'src/frontend/src/views/admin/article/List.vue'
])
const heavyVShowTargets = [
  'el-table',
  'el-tabs',
  'MarkdownRenderer',
  'MarkdownEditorAdapter',
  'el-scrollbar',
  'ArticleAssetLibraryPanel',
  'ArticleRevisionPanel',
  'ArticlePrivatePreviewPanel'
]

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function walk(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, output)
    } else if (entry.name.endsWith('.vue')) {
      output.push(full)
    }
  }
  return output
}

function templateOf(source) {
  return source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/u)?.[1] ?? ''
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}

function templateMaxDepth(template) {
  const tagRegex = /<\/?([A-Za-z][A-Za-z0-9_.:-]*)(?:\s[^>]*)?>/gu
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
  let depth = 0
  let maxDepth = 0
  let match
  while ((match = tagRegex.exec(template)) !== null) {
    const full = match[0]
    const tag = match[1].toLowerCase()
    if (full.startsWith('</')) {
      depth = Math.max(0, depth - 1)
      continue
    }
    depth += 1
    maxDepth = Math.max(maxDepth, depth)
    if (full.endsWith('/>') || voidTags.has(tag)) {
      depth = Math.max(0, depth - 1)
    }
  }
  return maxDepth
}

function countElementPlusTags(fragment) {
  return (fragment.match(/<el-[a-z0-9-]+/giu) ?? []).length
}

function collectVForSubtreeViolations(template, source, fileLabel, sourceOffset, hardViolations, softViolations) {
  const vForRegex = /<([A-Za-z][A-Za-z0-9_.:-]*)\b[^>]*\bv-for\s*=/gu
  let match
  while ((match = vForRegex.exec(template)) !== null) {
    const tag = match[1]
    const start = match.index
    const close = new RegExp(`</${tag}>`, 'giu')
    close.lastIndex = vForRegex.lastIndex
    const closeMatch = close.exec(template)
    const fragment = closeMatch ? template.slice(start, closeMatch.index + closeMatch[0].length) : template.slice(start, start + 2000)
    const elementPlusCount = countElementPlusTags(fragment)
    if (elementPlusCount > 8) {
      const message = `${fileLabel}:${lineNumber(source, sourceOffset + start)}: v-for subtree contains ${elementPlusCount} Element Plus components`
      if (highPressureFiles.has(fileLabel)) {
        hardViolations.push(message)
      } else {
        softViolations.push(message)
      }
    }
  }
}

function collectVShowHeavyViolations(source, fileLabel, violations) {
  const vShowRegex = /<([A-Za-z][A-Za-z0-9_.:-]*)\b[^>]*\bv-show\s*=[\s\S]*?>/gu
  let match
  while ((match = vShowRegex.exec(source)) !== null) {
    const start = match.index
    const sample = source.slice(start, start + 5000)
    if (heavyVShowTargets.some((token) => sample.includes(`<${token}`) || sample.includes(token))) {
      violations.push(`${fileLabel}:${lineNumber(source, start)}: v-show keeps a heavy subtree mounted`)
    }
  }
}

function collectLazyTabViolations(source, fileLabel, violations) {
  if (fileLabel !== heavyWritePage) {
    return
  }

  const tabRegex = /<el-tab-pane\b([^>]*)>/gu
  let match
  while ((match = tabRegex.exec(source)) !== null) {
    if (!/\blazy\b/u.test(match[1])) {
      violations.push(`${fileLabel}:${lineNumber(source, match.index)}: heavy write page tab pane must be lazy`)
    }
  }
}

function collectNestedScrollbarViolations(source, fileLabel, violations) {
  const scrollbarMatches = [...source.matchAll(/<el-scrollbar\b/gu)]
  if (highPressureFiles.has(fileLabel) && scrollbarMatches.length > 1) {
    violations.push(`${fileLabel}:${lineNumber(source, scrollbarMatches[1].index ?? 0)}: high pressure component should not stack multiple el-scrollbar wrappers`)
  }
}

function collectPageSizeViolations(source, fileLabel, hardViolations, softViolations) {
  const pageSize100 = /:page-sizes\s*=\s*["'][^"']*100|pageSizes?\s*[:=]\s*\[[^\]]*100/u
  if (!pageSize100.test(source)) {
    return
  }

  if (highPressureFiles.has(fileLabel)) {
    hardViolations.push(`${fileLabel}: heavy table/list page-size includes 100`)
  } else {
    softViolations.push(`${fileLabel}: page-size includes 100; verify this is not a high-DOM table`)
  }
}

function collectTemplateFunctionWarnings(source, fileLabel, softViolations) {
  const vForBlocks = [...source.matchAll(/<[^>]+\bv-for\s*=[\s\S]{0,2500}?<\/[^>]+>/gu)]
  for (const block of vForBlocks) {
    const fragment = block[0]
    if (/\bformatTime\s*\(/u.test(fragment)) {
      softViolations.push(`${fileLabel}:${lineNumber(source, block.index ?? 0)}: formatTime(...) inside v-for should be precomputed`)
    }
    if (/<SemanticTime\b/u.test(fragment) && /<el-table|class="[^"]*table|\.el-table/u.test(source.slice(Math.max(0, (block.index ?? 0) - 1000), (block.index ?? 0) + 1000))) {
      softViolations.push(`${fileLabel}:${lineNumber(source, block.index ?? 0)}: SemanticTime inside dense table/list rows should be budgeted`)
    }
  }
}

const hardViolations = []
const softViolations = []
const files = walk(srcDir)
const fileSummaries = []

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const fileLabel = relative(file)
  const template = templateOf(source)
  const maxDepth = templateMaxDepth(template)
  const isRoute = routeFiles.has(fileLabel) || fileLabel.includes('/views/')
  const isComponent = fileLabel.includes('/components/')
  const depthHardLimit = isRoute ? 36 : 28

  if ((routeFiles.has(fileLabel) || highPressureFiles.has(fileLabel)) && maxDepth > depthHardLimit) {
    hardViolations.push(`${fileLabel}: template maxDepth ${maxDepth} > ${depthHardLimit}`)
  } else if ((isRoute || isComponent) && maxDepth > depthHardLimit) {
    softViolations.push(`${fileLabel}: template maxDepth ${maxDepth} > ${depthHardLimit}`)
  }

  collectVForSubtreeViolations(template, source, fileLabel, source.indexOf(template), hardViolations, softViolations)
  collectVShowHeavyViolations(source, fileLabel, hardViolations)
  collectLazyTabViolations(source, fileLabel, hardViolations)
  collectNestedScrollbarViolations(source, fileLabel, hardViolations)
  collectPageSizeViolations(source, fileLabel, hardViolations, softViolations)
  collectTemplateFunctionWarnings(source, fileLabel, softViolations)

  fileSummaries.push({
    file: fileLabel,
    maxDepth,
    elementPlusTags: countElementPlusTags(template),
    vShowCount: (source.match(/\bv-show\s*=/gu) ?? []).length,
    vForCount: (source.match(/\bv-for\s*=/gu) ?? []).length
  })
}

const summary = {
  status: hardViolations.length > 0 ? 'failed' : 'ok',
  generatedAt: new Date().toISOString(),
  fileCount: files.length,
  hardViolations,
  softViolations,
  files: fileSummaries.sort((a, b) => b.maxDepth - a.maxDepth).slice(0, 40)
}
ensureDir(path.dirname(outFile))
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)

ensureDir(path.dirname(releaseSummaryFile))
const existing = fs.existsSync(releaseSummaryFile)
  ? JSON.parse(fs.readFileSync(releaseSummaryFile, 'utf8'))
  : { status: 'ok', generatedAt: new Date().toISOString(), artifacts: {} }
fs.writeFileSync(releaseSummaryFile, `${JSON.stringify({
  ...existing,
  status: existing.status === 'failed' || summary.status === 'failed' ? 'failed' : 'ok',
  generatedAt: new Date().toISOString(),
  domDepthStatic: {
    status: summary.status,
    hardViolationCount: hardViolations.length,
    softViolationCount: softViolations.length,
    artifact: relative(outFile)
  },
  artifacts: {
    ...(existing.artifacts ?? {}),
    domDepthStatic: relative(outFile)
  }
}, null, 2)}\n`)

for (const line of softViolations) {
  console.warn(`[dom-depth-static] soft: ${line}`)
}
for (const line of hardViolations) {
  console.error(`[dom-depth-static] hard: ${line}`)
}

if (hardViolations.length > 0) {
  process.exit(1)
}
console.log(`[dom-depth-static] ok files=${files.length} soft=${softViolations.length}`)
