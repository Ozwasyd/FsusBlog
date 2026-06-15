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
const indexHtml = read('src/frontend/index.html')
const packageJson = JSON.parse(read('src/frontend/package.json'))
const publicPageCss = read('src/frontend/src/assets/public-page.css')
const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts')
const accountLayout = read('src/frontend/src/layouts/AccountLayout.vue')
const progress = read('src/frontend/src/components/article/ArticleReadingProgress.vue')
const toc = read('src/frontend/src/components/article/ArticleTocPanel.vue')
const mobileBar = read('src/frontend/src/components/article/ArticleMobileActionBar.vue')
const lightbox = read('src/frontend/src/components/article/ArticleImageLightbox.vue')
const shareActions = read('src/frontend/src/components/article/ArticleShareActions.vue')
const targetHelper = read('src/frontend/src/composables/article/useArticleReadingTarget.ts')
const tocComposable = read('src/frontend/src/composables/article/useArticleToc.ts')
const codeCopy = read('src/frontend/src/composables/article/useCodeBlockCopy.ts')
const imageLightboxComposable = read('src/frontend/src/composables/article/useArticleImageLightbox.ts')
const articleDetail = read('src/frontend/src/views/ArticleDetail.vue')
const featuredArticles = read('src/frontend/src/components/home/FeaturedArticlesSection.vue')
const homeRecommendations = read('src/frontend/src/components/home/HomeTextFirstRecommendations.vue')
const hotArticlesIsland = read('src/frontend/src/public-renderers/homeHotArticlesIsland.ts')

for (const token of [
  '.blog-motion-reading-control',
  '.blog-motion-mobile-bar',
  '.blog-motion-reading-target'
]) {
  expectIncludes(motionCss, token, 'motion.css')
}

for (const token of [
  'loader-document-placeholder',
  'loader-placeholder-line',
  '--fsusblog-loader-muted: var(--fsusblog-text-muted)',
  '--fsusblog-loader-rule: var(--fsusblog-panel-border)'
]) {
  expectIncludes(indexHtml, token, 'index.html')
}

for (const pattern of [
  /\bpulse-dot\b/i,
  /\bslide-bar\b/i,
  /\bline-grow\b/i,
  /\bshimmer\b/i,
  /\bglow\b/i,
  /--fsusblog-loader-accent/i,
  /--fsusblog-color-primary[^;]*loader/i,
  /--fsus-scholarly-blue[^;]*loader/i
]) {
  expectNotMatches(indexHtml, pattern, `index.html boot loader must not match ${pattern}`)
}

const scripts = packageJson.scripts ?? {}
expectIncludes(
  String(scripts['check:public-reading-motion'] ?? ''),
  'check-public-reading-motion.mjs',
  'package.json check:public-reading-motion'
)
expectIncludes(
  String(scripts['check:views-constraints'] ?? ''),
  'check:public-reading-motion',
  'package.json check:views-constraints'
)

expectIncludes(
  themeTokens,
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]',
  'themeTokens.ts'
)
expectNotMatches(
  themeTokens,
  /const\s+focusRing\s*=\s*['"][^'"]*\bfocus-visible:ring-1\b/,
  'themeTokens.ts shared focusRing must not use ring-1'
)

expectIncludes(
  publicPageCss,
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);',
  'public-page.css'
)
expectIncludes(publicPageCss, 'border-bottom-color: var(--fsusblog-color-primary);', 'public-page.css')
expectIncludes(publicPageCss, 'box-shadow: inset 0 -2px 0 var(--fsusblog-color-primary);', 'public-page.css')
expectNotMatches(
  publicPageCss,
  /box-shadow:\s*inset 0 0 0 1px var\(--fsusblog-color-focus-ring\)/,
  'public-page.css public focus must use 2px ring'
)

expectIncludes(featuredArticles, '聚焦', 'FeaturedArticlesSection.vue')
expectIncludes(homeRecommendations, '热门文章', 'HomeTextFirstRecommendations.vue')
expectIncludes(hotArticlesIsland, '热门文章', 'homeHotArticlesIsland.ts')
expectNotMatches(homeRecommendations, /顺着读/, 'HomeTextFirstRecommendations.vue hot fallback heading must not drift to 顺着读')

expectIncludes(progress, 'data-reading-progress="true"', 'ArticleReadingProgress.vue')
expectIncludes(progress, 'transform: scaleX(var(--article-reading-progress, 0))', 'ArticleReadingProgress.vue')
expectIncludes(progress, 'transition: transform var(--blog-motion-fast) var(--blog-motion-ease)', 'ArticleReadingProgress.vue')
expectNotMatches(progress, /transition\s*:[^;]*width/s, 'ArticleReadingProgress.vue must not animate width')

expectIncludes(toc, 'aria-current', 'ArticleTocPanel.vue')
expectIncludes(toc, 'blog-motion-reading-control', 'ArticleTocPanel.vue')
expectIncludes(toc, 'border-left-color: var(--fsusblog-color-primary);', 'ArticleTocPanel.vue')
expectIncludes(toc, 'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);', 'ArticleTocPanel.vue')
expectNotMatches(toc, /\b(?:translate|scale|stagger)\b/i, 'ArticleTocPanel.vue must not use translate/scale/stagger')
expectNotMatches(
  toc,
  /border-left-color:\s*color-mix\(in srgb,\s*var\(--fsusblog-text-primary\)/,
  'ArticleTocPanel.vue active/focus must use Scholarly Blue'
)

expectIncludes(
  accountLayout,
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]',
  'AccountLayout.vue'
)
expectIncludes(
  accountLayout,
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);',
  'AccountLayout.vue'
)
expectNotMatches(accountLayout, /\bfocus-visible:ring-1\b/, 'AccountLayout.vue must not use ring-1 focus')
expectNotMatches(
  accountLayout,
  /box-shadow:\s*0 0 0 2px var\(--fsusblog-color-focus-ring\)/,
  'AccountLayout.vue focus must use inset ring'
)
expectNotMatches(accountLayout, /backdrop-filter:\s*blur\(/, 'AccountLayout.vue default shell must not use blur')

expectIncludes(mobileBar, 'data-mobile-reading-actions="true"', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'blog-motion-mobile-bar', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'env(safe-area-inset-bottom, 0px)', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, '<FsuTransition', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'fsusBlogMotionPresets.mobileBar', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'fsusBlogMotionPresets.backToTop', 'ArticleMobileActionBar.vue')
expectIncludes(mobileBar, 'backdrop-filter: none;', 'ArticleMobileActionBar.vue')
expectIncludes(
  mobileBar,
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);',
  'ArticleMobileActionBar.vue'
)
expectNotMatches(mobileBar, /translateY\(/, 'ArticleMobileActionBar.vue must not define local mobile bar translate motion')
expectNotMatches(mobileBar, /backdrop-filter:\s*blur\(/, 'ArticleMobileActionBar.vue must not use blur')
expectNotMatches(mobileBar, /outline:\s*1px/, 'ArticleMobileActionBar.vue focus must not use 1px outline')

expectIncludes(lightbox, 'data-article-lightbox="true"', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, '<FsuTransition', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, 'fsusBlogMotionPresets.mediaOverlay', 'ArticleImageLightbox.vue')
expectNotMatches(lightbox, /article-lightbox-fade/, 'ArticleImageLightbox.vue must use FsusUI transition instead of local fade CSS')
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
expectIncludes(codeCopy, 'useScrollReveal', 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, "'article-code-block'", 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, "button.setAttribute('aria-live', 'polite')", 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, 'globalThis.setTimeout', 'useCodeBlockCopy.ts')
expectIncludes(imageLightboxComposable, 'useScrollReveal', 'useArticleImageLightbox.ts')
expectIncludes(imageLightboxComposable, "'article-body-image'", 'useArticleImageLightbox.ts')
expectIncludes(markdownCss, '.fsus-code-copy-button--copied', 'markdown.css')
expectIncludes(markdownCss, 'var(--blog-motion-fast) var(--blog-motion-ease)', 'markdown.css')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-reading-motion] ${error}`)
  }
  process.exit(1)
}

console.log('[public-reading-motion] ok')
