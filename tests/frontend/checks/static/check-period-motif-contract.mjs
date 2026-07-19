#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function expectIncludes(source, token, label) {
  if (!source.includes(token)) {
    errors.push(`${label}: missing ${token}`)
  }
}

function expectNotIncludes(source, token, label) {
  if (source.includes(token)) {
    errors.push(`${label}: must not include ${token}`)
  }
}

function expectCount(source, token, count, label) {
  const actual = source.split(token).length - 1
  if (actual !== count) {
    errors.push(`${label}: expected ${count} occurrences of ${token}, found ${actual}`)
  }
}

const archive = read('src/frontend/src/components/public/pages/PublicArchivePageContent.vue')
const articleList = read('src/frontend/src/components/public/PublicArticleList.vue')
const articleDetail = read('src/frontend/src/components/article/ArticleDetailHeader.vue')
const commentsPlaceholder = read('src/frontend/src/components/public/ArticleDetailCommentsPlaceholder.vue')
const homeLoading = read('src/frontend/src/components/home/HomeArticleLoadingState.vue')
const contentState = read('src/frontend/src/components/public/PublicContentState.vue')
const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts')
const publicPageCss = read('src/frontend/src/assets/public-page.css')

expectIncludes(archive, 'text-[var(--fsusblog-text-decorative)] leading-none" aria-hidden="true">.</span>', 'archive year anchor')
expectNotIncludes(archive, 'aria-hidden="true">·</span>', 'archive year anchor')

expectCount(articleList, ':class="themeTokens.articleList.metaSeparator" aria-hidden="true">·</span>', 1, 'article list date/category separator')
expectCount(articleList, '>·</span>', 2, 'article list separators')
expectNotIncludes(articleList, '>/</span>', 'article list separators')
expectCount(articleDetail, ':class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">·</span>', 3, 'article detail separators')
expectNotIncludes(articleDetail, 'aria-hidden="true">/</span>', 'article detail separators')

expectIncludes(themeTokens, 'metaSeparator: `ui-article-meta-separator font-normal ${textDecorative}`', 'article list separator token')
expectIncludes(themeTokens, 'metaSeparator: `font-normal ${textDecorative}`', 'article detail separator token')
expectIncludes(themeTokens, "commentsPlaceholderDot: 'fsusblog-dot-loader'", 'comments placeholder dot token')
expectIncludes(commentsPlaceholder, ':class="themeTokens.articleDetail.commentsPlaceholderDot"', 'comments placeholder token binding')

expectCount(homeLoading, 'class="fsusblog-dot-loader"', 1, 'home loading dot')
expectCount(contentState, 'class="fsusblog-dot-loader"', 1, 'content state dot')
expectIncludes(contentState, 'v-if="tone === \'neutral\'"', 'neutral content state dot')

for (const token of [
  ':where(#app, #fsus-aot-shell) .fsusblog-dot-loader {',
  'width: 4px;',
  'height: 4px;',
  'border-radius: var(--fsus-radius-pill, 999px);',
  'background: var(--fsusblog-text-decorative);'
]) {
  expectIncludes(publicPageCss, token, 'shared dot class')
}

if (errors.length > 0) {
  console.error('[period-motif-contract] failed')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log('[period-motif-contract] ok')
}
