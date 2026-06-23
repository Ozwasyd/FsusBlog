#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function exists(path) {
  return existsSync(resolve(repoRoot, path))
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
const lightbox = read('src/frontend/src/components/article/ArticleImageLightbox.vue')
const publicArticleList = read('src/frontend/src/components/public/PublicArticleList.vue')
const publicArticleDetail = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue')
const publicFilter = read('src/frontend/src/components/public/pages/PublicFilterPageContent.vue')
const publicShell = read('src/frontend/src/components/public/PublicBlogLayoutShell.vue')
const articleDetailLoading = read('src/frontend/src/components/article/ArticleDetailLoadingState.vue')
const homeArticleLoading = read('src/frontend/src/components/home/HomeArticleLoadingState.vue')
const publicAbout = read('src/frontend/src/components/public/pages/PublicAboutPageContent.vue')
const publicArchive = read('src/frontend/src/components/public/pages/PublicArchivePageContent.vue')
const filterHeader = read('src/frontend/src/components/filter/FilterHeader.vue')
const filterArticleLoading = read('src/frontend/src/components/filter/FilterArticleLoadingState.vue')
const markdownRenderer = read('src/frontend/src/components/ui/MarkdownRenderer.vue')
const readingNotice = read('src/frontend/src/components/article/ArticleReadingNotice.vue')
const articleDetailHeader = read('src/frontend/src/components/article/ArticleDetailHeader.vue')
const commentsVirtualList = read('src/frontend/src/components/article/ArticleCommentsVirtualList.vue')
const commentComposer = read('src/frontend/src/components/article/ArticleCommentComposer.vue')
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
expectIncludes(publicPageCss, '--fsusblog-skeleton-bg: var(--el-fill-color-light, #f5f7fa);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-scrim: rgba(15, 15, 17, 0.72);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-button-bg: rgba(255, 255, 255, 0.12);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-button-fg: rgba(255, 255, 255, 0.92);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-button-border: rgba(255, 255, 255, 0.24);', 'public-page.css')
expectIncludes(publicPageCss, 'backdrop-filter: blur(12px) saturate(140%);', 'public-page.css bottom tab glass')
expectIncludes(publicPageCss, 'box-shadow: 0 -1px 0 var(--fsusblog-panel-border);', 'public-page.css bottom tab border-first shadow')
expectIncludes(publicPageCss, 'linear-gradient(180deg, color-mix(in srgb, var(--fsusblog-page-bg) 28%, transparent), transparent)', 'public-page.css bottom tab top highlight')
expectNotMatches(publicPageCss, /repeating-linear-gradient/, 'public-page.css bottom tab must not use noise gradients')
expectNotMatches(publicPageCss, /mix-blend-mode:\s*soft-light/, 'public-page.css bottom tab must not use blend-mode decoration')
expectNotMatches(publicPageCss, /\[class\*=["'](?:fade-in|slide-in|animate-)/, 'public-page.css reduced-motion selector must not use broad class* matching')
expectIncludes(publicPageCss, '.slide-in-from-right-1', 'public-page.css reduced-motion precise selector')
expectIncludes(publicPageCss, '--fsusblog-reading-shadow-floating: 0 8px 24px rgba(15, 23, 42, 0.32);', 'public-page.css dark reading shadow')
expectNotMatches(
  publicPageCss,
  /box-shadow:\s*inset 0 0 0 1px var\(--fsusblog-color-focus-ring\)/,
  'public-page.css public focus must use 2px ring'
)

for (const [source, label] of [
  [articleDetailLoading, 'ArticleDetailLoadingState.vue'],
  [homeArticleLoading, 'HomeArticleLoadingState.vue'],
  [featuredArticles, 'FeaturedArticlesSection.vue'],
  [publicAbout, 'PublicAboutPageContent.vue'],
  [publicArchive, 'PublicArchivePageContent.vue'],
  [filterHeader, 'FilterHeader.vue'],
  [filterArticleLoading, 'FilterArticleLoadingState.vue']
]) {
  expectNotMatches(source, /<el-skeleton[^>]*\sanimated\b/, `${label} public reading skeleton must not be animated`)
  expectIncludes(source, '--el-skeleton-color: var(--fsusblog-skeleton-bg)', `${label} neutral skeleton color`)
  expectIncludes(source, '--el-skeleton-to-color: var(--fsusblog-skeleton-bg)', `${label} neutral skeleton shimmer target`)
}

for (const [source, label] of [
  [publicArticleDetail, 'PublicArticleDetailPageContent.vue'],
  [toc, 'ArticleTocPanel.vue'],
  [markdownRenderer, 'MarkdownRenderer.vue'],
  [progress, 'ArticleReadingProgress.vue'],
  [readingNotice, 'ArticleReadingNotice.vue'],
  [articleDetailHeader, 'ArticleDetailHeader.vue'],
  [commentsVirtualList, 'ArticleCommentsVirtualList.vue'],
  [commentComposer, 'ArticleCommentComposer.vue'],
  [publicArticleList, 'PublicArticleList.vue'],
  [featuredArticles, 'FeaturedArticlesSection.vue']
]) {
  expectIncludes(source, 'data-fsus-surface="reading"', label)
}
expectIncludes(publicArticleDetail, 'id="fsus-comments-island"', 'PublicArticleDetailPageContent.vue comments island')
expectIncludes(toc, '<el-drawer', 'ArticleTocPanel.vue drawer')

expectIncludes(featuredArticles, '聚焦', 'FeaturedArticlesSection.vue')
const homeRecommendationsCopy = read('src/frontend/src/copy/layout.ts')
expectIncludes(homeRecommendationsCopy, '热门文章', 'HomeTextFirstRecommendations.vue eyebrow (via @/copy layout registry)')
expectIncludes(hotArticlesIsland, '热门文章', 'homeHotArticlesIsland.ts')
expectNotMatches(homeRecommendations, /顺着读/, 'HomeTextFirstRecommendations.vue hot fallback heading must not drift to 顺着读')

expectIncludes(progress, 'data-reading-progress="true"', 'ArticleReadingProgress.vue')
expectIncludes(progress, 'transform: scaleX(var(--article-reading-progress, 0))', 'ArticleReadingProgress.vue')
expectIncludes(progress, 'transition: transform var(--blog-motion-fast) var(--blog-motion-ease)', 'ArticleReadingProgress.vue')
expectIncludes(progress, 'transition-duration: 1ms;', 'ArticleReadingProgress.vue reduced motion')
expectNotMatches(progress, /transition\s*:[^;]*width/s, 'ArticleReadingProgress.vue must not animate width')
expectNotMatches(progress, /transition:\s*none/, 'ArticleReadingProgress.vue reduced motion must use 1ms instead of none')

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

expectNotMatches(articleDetail, /ArticleMobileActionBar/, 'ArticleDetail.vue must not render removed mobile action bar')

expectIncludes(lightbox, 'data-article-lightbox="true"', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, 'data-fsus-material="glass"', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, 'background: var(--fsusblog-overlay-scrim)', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, 'color: var(--fsusblog-overlay-button-fg)', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, 'border: 1px solid var(--fsusblog-overlay-button-border)', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, 'background: var(--fsusblog-overlay-button-bg)', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, '<FsuTransition', 'ArticleImageLightbox.vue')
expectIncludes(lightbox, 'fsusBlogMotionPresets.mediaOverlay', 'ArticleImageLightbox.vue')
expectNotMatches(lightbox, /article-lightbox-fade/, 'ArticleImageLightbox.vue must use FsusUI transition instead of local fade CSS')
expectNotMatches(lightbox, /scale\(/, 'ArticleImageLightbox.vue must not use zoom/scale')
expectNotMatches(lightbox, /rgb\(/, 'ArticleImageLightbox.vue must use overlay tokens instead of raw rgb()')

expectIncludes(publicShell, ':aria-current="item.key === activeNav ? \'page\' : undefined"', 'PublicBlogLayoutShell.vue desktop nav aria-current')
expectNotMatches(publicShell, /el-public-shell__header-action/, 'PublicBlogLayoutShell.vue desktop header must not use bordered header action affordance')

expectNotMatches(publicArticleList, /\bv-motion\b/, 'PublicArticleList.vue reading surface must not use v-motion')
expectNotMatches(publicArticleList, /fsusBlogMotionPresets\.articleCards/, 'PublicArticleList.vue reading surface must not use articleCards preset')
expectNotMatches(publicArticleList, /@ozwasyd\/element-plus\/motion/, 'PublicArticleList.vue must not import motion directives')
expectNotMatches(publicArticleDetail, /\bv-motion\b/, 'PublicArticleDetailPageContent.vue article title must render statically')
expectNotMatches(publicArticleDetail, /\bv-scroll-reveal\b/, 'PublicArticleDetailPageContent.vue article cover must render statically')
expectNotMatches(publicArticleDetail, /fsusBlog(?:MotionPresets|ScrollRevealMotion)/, 'PublicArticleDetailPageContent.vue reading surface must not import motion presets')
expectNotMatches(publicArticleDetail, /@ozwasyd\/element-plus\/motion/, 'PublicArticleDetailPageContent.vue must not import motion directives')
expectNotMatches(publicFilter, /\bv-motion\b/, 'PublicFilterPageContent.vue search panel must render statically')
expectNotMatches(publicFilter, /fsusBlogMotionPresets\.searchDialog/, 'PublicFilterPageContent.vue reading surface must not use searchDialog preset')
expectNotMatches(publicFilter, /@ozwasyd\/element-plus\/motion/, 'PublicFilterPageContent.vue must not import motion directives')

expectIncludes(targetHelper, 'resolveMotionScrollBehavior()', 'useArticleReadingTarget.ts')
expectIncludes(targetHelper, 'ARTICLE_READING_TARGET_CLASS', 'useArticleReadingTarget.ts')
expectIncludes(targetHelper, "target.focus({ preventScroll: true })", 'useArticleReadingTarget.ts')
expectIncludes(targetHelper, 'highlightArticleReadingTarget', 'useArticleReadingTarget.ts')
expectIncludes(tocComposable, 'scrollToArticleTarget(target)', 'useArticleToc.ts')
expectNotMatches(articleDetail, /navigateToComments/, 'ArticleDetail.vue must not keep removed mobile comments shortcut')

expectIncludes(codeCopy, 'fsus-code-copy-button--copied', 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, 'useScrollReveal', 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, "'article-code-block'", 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, "button.setAttribute('aria-live', 'polite')", 'useCodeBlockCopy.ts')
expectIncludes(codeCopy, 'globalThis.setTimeout', 'useCodeBlockCopy.ts')
expectIncludes(imageLightboxComposable, 'useScrollReveal', 'useArticleImageLightbox.ts')
expectIncludes(imageLightboxComposable, "'article-body-image'", 'useArticleImageLightbox.ts')
expectIncludes(markdownCss, '.fsus-code-copy-button--copied', 'markdown.css')
expectIncludes(markdownCss, 'var(--blog-motion-fast) var(--blog-motion-ease)', 'markdown.css')
expectIncludes(markdownCss, 'outline: 2px solid var(--fsusblog-color-focus-ring);', 'markdown.css image preview focus')
expectIncludes(markdownCss, 'outline-offset: 2px;', 'markdown.css image preview focus offset')
expectNotMatches(markdownCss, /\.fsus-article-preview-image:focus-visible\s*\{[\s\S]*?outline-offset:\s*4px/, 'markdown.css image preview focus offset must be <= 2px')

if (!exists('docs/public-layout-rules.md')) {
  errors.push('docs/public-layout-rules.md missing')
} else {
  const publicLayoutRules = read('docs/public-layout-rules.md')
  for (const heading of [
    '## 1. Token 命名空间策略',
    '## 2. Mobile navigation 模式',
    '## 3. Reading surface 契约',
    '## 4. Dialog 宽度变体白名单',
    '## 5. Glass material 启用 surface 白名单',
    '## 6. 暗色 Scholarly Blue 决策',
    '## 7. 字号标度规则',
    '## 8. 圆角标度规则',
    '## 9. 动效标度规则',
    '## 10. Commit 评审 checklist'
  ]) {
    expectIncludes(publicLayoutRules, heading, 'docs/public-layout-rules.md')
  }
}

if (!exists('docs/index.md')) {
  errors.push('docs/index.md missing')
} else {
  expectIncludes(read('docs/index.md'), 'public-layout-rules.md', 'docs/index.md')
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-reading-motion] ${error}`)
  }
  process.exit(1)
}

console.log('[public-reading-motion] ok')
