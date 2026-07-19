#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../../..')
const sourceRoot = resolve(repoRoot, 'src/frontend/src')
const emergencyShellPath = resolve(repoRoot, 'src/frontend/public/public-shell-emergency.css')
const layoutRulesPath = resolve(repoRoot, 'docs/public-layout-rules.md')
const markdownPath = resolve(sourceRoot, 'assets/markdown.css')
const commentListPath = resolve(sourceRoot, 'components/article/ArticleCommentsVirtualList.vue')
const sourceExtensions = new Set(['.css', '.scss', '.vue', '.ts', '.tsx', '.js', '.jsx'])
const excludedDirectories = new Set(['generated'])
const forbiddenDeclarationPattern = /font-size\s*:\s*(0?\.[6-9][0-9]*(?:rem|em)|(?:11|13)px)(?:\s*!important)?\s*;/gu
const errors = []
let scannedFileCount = 0

function collectSourceFiles(directory) {
  const files = []

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      files.push(...collectSourceFiles(path))
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path)
    }
  }

  return files
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function relativePath(path) {
  return path.slice(repoRoot.length + 1)
}

for (const path of [...collectSourceFiles(sourceRoot), emergencyShellPath]) {
  const source = readFileSync(path, 'utf8')
  scannedFileCount += 1

  forbiddenDeclarationPattern.lastIndex = 0
  for (const match of source.matchAll(forbiddenDeclarationPattern)) {
    errors.push(
      `${relativePath(path)}:${lineNumberAt(source, match.index)} font-size ${match[1]} must use the canonical 12/14/16px small-text scale`
    )
  }
}

const markdown = readFileSync(markdownPath, 'utf8')
const blockquoteRule = /\.markdown-body blockquote\s*\{(?<body>[^}]*)\}/u.exec(markdown)?.groups?.body ?? ''
if (blockquoteRule.length === 0 || /font-size\s*:/u.test(blockquoteRule)) {
  errors.push('src/frontend/src/assets/markdown.css: blockquote must inherit the canonical 16px Markdown reading size')
}

const commentList = readFileSync(commentListPath, 'utf8')
if (!/\.fsus-comment__reply-target,\s*\n\.fsus-comment__time\s*\{[^}]*font-size:\s*14px;[^}]*line-height:\s*1\.4;/su.test(commentList)) {
  errors.push('src/frontend/src/components/article/ArticleCommentsVirtualList.vue: comment time metadata must keep the 14px/1.4 contract')
}

const layoutRules = readFileSync(layoutRulesPath, 'utf8')
for (const requiredText of [
  'CSS `font-size` 小字号只写 `12px`、`14px` 或 `16px`',
  '禁止 `11px`、`13px`',
  'Markdown blockquote 继承 16px'
]) {
  if (!layoutRules.includes(requiredText)) {
    errors.push(`docs/public-layout-rules.md: missing font-size contract text: ${requiredText}`)
  }
}

if (errors.length > 0) {
  console.error('[check-font-size-contract] failed')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`[check-font-size-contract] ok (${scannedFileCount} source files; small scale=12/14/16px)`)
}
