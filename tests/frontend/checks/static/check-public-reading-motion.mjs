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

function expectMatches(source, pattern, message) {
  if (!pattern.test(source)) {
    errors.push(`${message} missing ${pattern}`)
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
const commentDetailContract = read('src/frontend/src/view-contracts/commentDetail.ts')
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
expectIncludes(publicPageCss, '--fsusblog-skeleton-bg: var(--surface-subtle);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-scrim: rgba(15, 15, 17, 0.72);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-button-bg: rgba(255, 255, 255, 0.12);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-button-fg: rgba(255, 255, 255, 0.92);', 'public-page.css')
expectIncludes(publicPageCss, '--fsusblog-overlay-button-border: rgba(255, 255, 255, 0.24);', 'public-page.css')
expectIncludes(publicPageCss, '.fsu-bottom-tab-bar', 'public-page.css FsusUI bottom tab fallback')
expectIncludes(publicPageCss, '.fsu-bottom-tab-bar__item', 'public-page.css FsusUI bottom tab items')
expectIncludes(publicPageCss, '#fsus-aot-shell .fsusblog-public-bottom-tab', 'public-page.css Blog-owned bottom tab fixed fallback')
expectNotMatches(publicPageCss, /el-public-shell__bottom-tab/, 'public-page.css must not keep local PublicShell bottom tab selectors')
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
expectMatches(publicArticleDetail, /id="article-rights-notice-title"\s+class="text-sm font-semibold normal-case tracking-normal text-\[var\(--fsusblog-text-primary\)\]"/, 'PublicArticleDetailPageContent.vue rights heading section scale')
expectMatches(publicArticleDetail, /id="fsus-related-reading-heading"\s+class="text-sm font-semibold normal-case tracking-normal text-\[var\(--fsusblog-text-primary\)\]"/, 'PublicArticleDetailPageContent.vue related heading section scale')
expectNotMatches(publicArticleDetail, /id="article-rights-notice-title"\s+class="text-xs font-bold/, 'PublicArticleDetailPageContent.vue rights heading must not use a smaller section scale than related reading')
expectIncludes(publicArticleDetail, 'class="blog-link-underline text-sm font-bold leading-5 text-[var(--fsusblog-text-primary)]"', 'PublicArticleDetailPageContent.vue related title underline')
expectNotMatches(publicArticleDetail, /group-hover:underline/, 'PublicArticleDetailPageContent.vue related reading titles must use blog-link-underline instead of text-decoration underline')
expectIncludes(publicArticleDetail, 'data-article-tail-group', 'PublicArticleDetailPageContent.vue groups article tail sections')
expectIncludes(publicArticleDetail, 'class="article-tail-group mt-8 sm:mt-10 divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]"', 'PublicArticleDetailPageContent.vue article tail shared boundary')
expectIncludes(publicArticleDetail, 'class="article-rights-notice py-4 sm:py-4"', 'PublicArticleDetailPageContent.vue rights readable boundary')
expectIncludes(publicArticleDetail, 'data-public-related-reading="true"\n        class="article-related-reading pt-5 pb-4 sm:pt-6 sm:pb-5"', 'PublicArticleDetailPageContent.vue related readable boundary')
expectIncludes(publicArticleDetail, 'id="fsus-comments-island"\n      class="mt-6 sm:mt-8"', 'PublicArticleDetailPageContent.vue comments island follows article tail without duplicate rule')
expectIncludes(publicArticleDetail, 'id="fsus-comments-island-content"\n        class="min-h-0"', 'PublicArticleDetailPageContent.vue comments mount must not reserve a tall empty block')
expectNotMatches(publicArticleDetail, /class="mt-12 sm:mt-16 border-t border-\[var\(--fsusblog-panel-border\)\] pt-8 sm:pt-10"/, 'PublicArticleDetailPageContent.vue comments island must not add a duplicate top rule and large whitespace after related reading')
expectNotMatches(publicArticleDetail, /class="min-h-\[10rem\]"/, 'PublicArticleDetailPageContent.vue comments mount must not keep the old tall empty state')
expectIncludes(publicArticleDetail, 'aria-label="延伸阅读文章"', 'PublicArticleDetailPageContent.vue related reading row-list aria label')
expectIncludes(publicArticleDetail, 'class="mt-3 divide-y divide-[var(--fsusblog-panel-border)]"', 'PublicArticleDetailPageContent.vue related reading row dividers')
expectIncludes(publicArticleDetail, 'class="py-2.5 first:pt-0 last:pb-0"', 'PublicArticleDetailPageContent.vue related reading uniform rows')
expectIncludes(publicArticleDetail, 'class="mb-0.5 block text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]"', 'PublicArticleDetailPageContent.vue related reading label row')
expectNotMatches(publicArticleDetail, /grid-cols-\[4rem_minmax\(0,1fr\)\]/, 'PublicArticleDetailPageContent.vue related reading must not squeeze content with a narrow label column')
expectNotMatches(publicArticleDetail, /class="flex flex-col gap-8"/, 'PublicArticleDetailPageContent.vue extended reading must not keep large vertical gaps')
expectNotMatches(publicArticleDetail, /class="flex flex-col gap-4"/, 'PublicArticleDetailPageContent.vue extended reading must use compact rows instead of stacked blocks')
expectNotMatches(publicArticleDetail, /class="grid gap-3 sm:grid-cols-2"/, 'PublicArticleDetailPageContent.vue related reading must not split previous/next into a separate card grid')
expectNotMatches(publicArticleDetail, /v-if="item\.summary"/, 'PublicArticleDetailPageContent.vue compact related reading must not render summaries')
expectNotMatches(publicArticleDetail, /\{\{\s*item\.reason\s*\}\}\s*·\s*\{\{\s*item\.displayTime\s*\}\}/, 'PublicArticleDetailPageContent.vue related rows must not expose denser metadata than previous rows')
expectIncludes(commentDetailContract, "guestShell: 'mb-4 border-b border-[var(--fsusblog-panel-border)] py-3 flex items-center justify-center'", 'commentDetail.ts guest composer prompt must be a compact row')
expectNotMatches(commentDetailContract, /guestShell:\s*'mb-12 py-8 bg-\[var\(--fsusblog-panel-bg\)\]\/50 flex items-center justify-center border border-\[var\(--fsusblog-panel-border\)\]'/, 'commentDetail.ts guest composer prompt must not render as a tall card')
expectIncludes(commentComposer, '.comment-identity-panel {\n  margin-bottom: 0.75rem;\n  border: 0;', 'ArticleCommentComposer.vue identity row must not render as a heavy card')
expectIncludes(commentComposer, 'border-bottom: 1px solid var(--fsusblog-panel-border);', 'ArticleCommentComposer.vue identity row keeps only a light divider')
expectIncludes(commentComposer, 'background: transparent;', 'ArticleCommentComposer.vue identity row must inherit the reading surface')
expectNotMatches(commentComposer, /\.comment-identity-panel\s*\{[^}]*linear-gradient/s, 'ArticleCommentComposer.vue identity row must not use card gradients')
expectNotMatches(commentComposer, /\.comment-identity-panel\s*\{[^}]*border-radius:\s*0\.5rem/s, 'ArticleCommentComposer.vue identity row must not use card radius')
expectIncludes(publicPageCss, '#fsus-aot-shell .blog-link-underline {\n  display: inline-block;', 'public-page.css editorial link underline must fit title text width')
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
