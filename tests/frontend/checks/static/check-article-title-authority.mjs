#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function expectMatch(source, pattern, label) {
  if (!pattern.test(source)) errors.push(`${label}: missing ${pattern}`)
}

function expectIncludes(source, token, label) {
  if (!source.includes(token)) errors.push(`${label}: missing ${token}`)
}

const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts')
const renderer = read('src/frontend/src/components/ui/MarkdownRenderer.vue')
const markdownCss = read('src/frontend/src/assets/markdown.css')
const punctuationGuard = read('tests/frontend/checks/static/check-period-motif-contract.mjs')

expectMatch(
  themeTokens,
  /articleDetail:\s*\{[\s\S]*?title: `text-xl sm:text-2xl lg:text-3xl font-bold[^`]*leading-\[1\.15\]/u,
  'page title authority'
)
expectMatch(
  renderer,
  /'markdown-body--article': props\.mode === 'article',[\s\S]*'markdown-body--document': props\.mode === 'about'/u,
  'Markdown mode ownership'
)
expectMatch(
  markdownCss,
  /\.markdown-body--article h1\s*\{[^}]*font-size:\s*1\.4em;[^}]*font-weight:\s*700;[^}]*margin-top:\s*3em;[^}]*margin-bottom:\s*1em;[^}]*text-align:\s*left;/u,
  'article chapter heading'
)
expectMatch(
  markdownCss,
  /\.markdown-body--document\s*\{[^}]*text-align:\s*left;[^}]*letter-spacing:\s*normal;[^}]*text-autospace:\s*normal;/u,
  '#1294 document typography'
)
expectIncludes(themeTokens, 'metaSeparator: `ui-article-meta-separator font-normal ${textDecorative}`', '#1290 punctuation token')
expectIncludes(themeTokens, "commentsPlaceholderDot: 'fsusblog-dot-loader'", '#1290 dot loader token')
expectIncludes(punctuationGuard, "console.log('[period-motif-contract] ok')", '#1290 punctuation guard')

if (errors.length > 0) {
  console.error('[article-title-authority] failed')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log('[article-title-authority] ok')
}
