#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function expectIncludes(source, token, label) {
  if (!source.includes(token)) {
    errors.push(`${label} missing ${token}`)
  }
}

function expectNotMatches(source, pattern, message) {
  if (pattern.test(source)) {
    errors.push(message)
  }
}

const motionCss = read('src/frontend/src/assets/motion.css')
const markdownCss = read('src/frontend/src/assets/markdown.css')
const progress = read('src/frontend/src/components/article/ArticleReadingProgress.vue')
const toc = read('src/frontend/src/components/article/ArticleTocPanel.vue')
const mobileBar = read('src/frontend/src/components/article/ArticleMobileActionBar.vue')
const lightbox = read('src/frontend/src/components/article/ArticleImageLightbox.vue')
const shareActions = read('src/frontend/src/components/article/ArticleShareActions.vue')
const targetHelper = read('src/frontend/src/composables/article/useArticleReadingTarget.ts')
const tocComposable = read('src/frontend/src/composables/article/useArticleToc.ts')
const codeCopy = read('src/frontend/src/composables/article/useCodeBlockCopy.ts')
const articleDetail = read('src/frontend/src/views/ArticleDetail.vue')

for (const token of [
  '.blog-motion-reading-control',
  '.blog-motion-mobile-bar',
  '.blog-motion-reading-target'
]) {
  expectIncludes(motionCss, token, 'motion.css')
}

expectIncludes(progress, 'data-reading-progress="true"', 'ArticleReadingProgress.vue')
expectIncludes(progress, 'transform: scaleX(var(--article-reading-progress, 0))', 'ArticleReadingProgress.vue')
expectIncludes(progress, 'transition: transform var(--blog-motion-fast) var(--blog-motion-ease)', 'ArticleReadingProgress.vue')
expectNotMatches(progress, /transition\s*:[^;]*width/s, 'ArticleReadingProgress.vue must not animate width')

expectIncludes(toc, 'aria-current', 'ArticleTocPanel.vue')
expectIncludes(toc, 'blog-motion-reading-control', 'ArticleTocPanel.vue')
expectNotMatches(toc, /\b(?:translate|scale|stagger)\b/i, 'ArticleTocPanel.vue must not use translate/scale/stagger')

expectIncludes(mobileBar, 'data-mobile-reading-actions="true"', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'blog-motion-mobile-bar', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'env(safe-area-inset-bottom, 0px)', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'translateY(4px)', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, '@media (prefers-reduced-motion: reduce)', 'ArticleMobileActionBar.vue')
expectNotMatches(mobileBar, /translateY\(([5-9]|\d{2,})px\)/, 'ArticleMobileActionBar.vue translateY must stay <= 4px')

expectIncludes(lightbox, 'data-article-lightbox="true"', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, '--blog-motion-overlay', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, '--blog-motion-panel', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, '@media (prefers-reduced-motion: reduce)', 'ArticleImageLightbox.vue')
expectNotMatches(lightbox, /scale\(/, 'ArticleImageLightbox.vue must not use zoom/scale')

expectIncludes(shareActions, 'blog-motion-reading-control', 'ArticleShareActions.vue')

expectIncludes(targetHelper, 'resolveMotionScrollBehavior()', 'useArticleReadingTarget.ts')
expectIncludes(targetHelper, 'ARTICLE_READING_TARGET_CLASS', 'useArticleReadingTarget.ts')
expectIncludes(targetHelper, "target.focus({ preventScroll: true })", 'useArticleReadingTarget.ts')
expectIncludes(targetHelper, 'highlightArticleReadingTarget', 'useArticleReadingTarget.ts')
expectIncludes(tocComposable, 'scrollToArticleTarget(target)', 'useArticleToc.ts')
expectIncludes(articleDetail, "document.getElementById('fsus-comments-island')", 'ArticleDetail.vue')
expectIncludes(articleDetail, 'scrollToArticleTarget(target)', 'ArticleDetail.vue')

expectIncludes(codeCopy, 'fsus-code-copy-button--copied', 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, "button.setAttribute('aria-live', 'polite')", 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, 'globalThis.setTimeout', 'useCodeBlockCopy.ts')
expectIncludes(markdownCss, '.fsus-code-copy-button--copied', 'markdown.css')
expectIncludes(markdownCss, 'var(--blog-motion-fast) var(--blog-motion-ease)', 'markdown.css')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-reading-motion] ${error}`)
  }
  process.exit(1)
}

console.log('[public-reading-motion] ok')
