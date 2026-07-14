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
const commentMarkdown = read('src/frontend/src/components/article/CommentMarkdownRenderer.vue')
const commentComposer = read('src/frontend/src/components/article/ArticleCommentComposer.vue')
const commentsEmpty = read('src/frontend/src/components/public/ArticleCommentsEmptyState.vue')
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
expectIncludes(publicPageCss, '.public-colophon__primary', 'public-page.css compact colophon primary row')
expectNotMatches(publicPageCss, /\.public-mobile-nav-menu/, 'public-page.css must not reimplement FsusUI PublicShell mobile navigation')
expectNotMatches(publicPageCss, /\.fsu-bottom-tab-bar/, 'public-page.css must not keep fixed bottom tab fallbacks')
expectNotMatches(publicPageCss, /\.fsusblog-public-bottom-tab/, 'public-page.css must not keep Blog fixed bottom tab selectors')
expectNotMatches(
  publicPageCss,
  /#fsus-aot-shell\s*\{\s*padding-bottom:[^}]*safe-area-inset-bottom/,
  'public-page.css must not reserve global bottom-dock safe area'
)
expectNotMatches(publicPageCss, /el-public-shell__bottom-tab/, 'public-page.css must not keep local PublicShell bottom tab selectors')
expectNotMatches(publicPageCss, /repeating-linear-gradient/, 'public-page.css chrome must not use noise gradients')
expectNotMatches(publicPageCss, /mix-blend-mode:\s*soft-light/, 'public-page.css chrome must not use blend-mode decoration')
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

const homeRecommendationsCopy = read('src/frontend/src/copy/layout.ts')
expectIncludes(featuredArticles, 'copy.leadEyebrow', 'FeaturedArticlesSection.vue lead eyebrow registry binding')
expectIncludes(homeRecommendationsCopy, "leadEyebrow: '本期推荐'", 'FeaturedArticlesSection.vue lead eyebrow (via @/copy layout registry)')
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

expectIncludes(publicShell, '<FsusUiPublicShell', 'PublicBlogLayoutShell.vue FsusUI public shell boundary')
expectIncludes(publicShell, ':active-nav="activeNav"', 'PublicBlogLayoutShell.vue delegated desktop nav aria-current state')
expectNotMatches(publicShell, /el-public-shell__header-action/, 'PublicBlogLayoutShell.vue desktop header must not use bordered header action affordance')

expectNotMatches(publicArticleList, /\bv-motion\b/, 'PublicArticleList.vue reading surface must not use v-motion')
expectNotMatches(publicArticleList, /fsusBlogMotionPresets\.articleCards/, 'PublicArticleList.vue reading surface must not use articleCards preset')
expectNotMatches(publicArticleList, /@ozwasyd\/element-plus\/motion/, 'PublicArticleList.vue must not import motion directives')
expectNotMatches(publicArticleDetail, /\bv-motion\b/, 'PublicArticleDetailPageContent.vue article title must render statically')
expectNotMatches(publicArticleDetail, /\bv-scroll-reveal\b/, 'PublicArticleDetailPageContent.vue article cover must render statically')
expectNotMatches(publicArticleDetail, /fsusBlog(?:MotionPresets|ScrollRevealMotion)/, 'PublicArticleDetailPageContent.vue reading surface must not import motion presets')
expectNotMatches(publicArticleDetail, /@ozwasyd\/element-plus\/motion/, 'PublicArticleDetailPageContent.vue must not import motion directives')
expectIncludes(publicArticleDetail, 'data-article-tail-group', 'PublicArticleDetailPageContent.vue groups article tail sections')
expectIncludes(publicArticleDetail, 'class="fsus-appendix"', 'PublicArticleDetailPageContent.vue restrained appendix boundary')
expectIncludes(publicArticleDetail, 'data-fsus-surface="reading"', 'PublicArticleDetailPageContent.vue appendix reading surface')
expectIncludes(publicArticleDetail, 'class="fsus-appendix__tags"', 'PublicArticleDetailPageContent.vue inline appendix tags')
expectIncludes(publicArticleDetail, 'class="fsus-appendix__copyright article-rights-notice"', 'PublicArticleDetailPageContent.vue compressed copyright prose')
expectIncludes(publicArticleDetail, 'class="fsus-appendix__nav"', 'PublicArticleDetailPageContent.vue appendix navigation')
expectIncludes(publicArticleDetail, 'class="fsus-appendix__nav-label"', 'PublicArticleDetailPageContent.vue demoted navigation label')
expectIncludes(publicArticleDetail, 'class="fsus-appendix__nav-list"', 'PublicArticleDetailPageContent.vue clean navigation list')
expectIncludes(publicArticleDetail, 'class="fsus-appendix__meta"', 'PublicArticleDetailPageContent.vue demoted related metadata')
expectIncludes(publicArticleDetail, 'class="fsus-appendix__link"', 'PublicArticleDetailPageContent.vue restrained related links')
expectIncludes(publicArticleDetail, 'border-top: 1px solid #E4E4E7;', 'PublicArticleDetailPageContent.vue appendix keeps only the article boundary')
expectMatches(publicArticleDetail, /\.fsus-appendix\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s, 'PublicArticleDetailPageContent.vue appendix remains transparent and flat')
expectIncludes(publicArticleDetail, 'letter-spacing: 1px;', 'PublicArticleDetailPageContent.vue appendix navigation label editorial tracking')
expectIncludes(publicArticleDetail, 'min-height: 44px;', 'PublicArticleDetailPageContent.vue appendix links preserve mobile touch targets')
expectIncludes(publicArticleDetail, 'transition: color var(--blog-motion-control) var(--blog-motion-ease);', 'PublicArticleDetailPageContent.vue related links use the reading motion token')
expectIncludes(publicArticleDetail, 'color: #2A599C;', 'PublicArticleDetailPageContent.vue related link scholarly blue hover')
expectNotMatches(publicArticleDetail, /fsus-colophon/, 'PublicArticleDetailPageContent.vue must not restore the large colophon')
expectNotMatches(publicArticleDetail, /article-tail-group mt-8 sm:mt-10 divide-y/, 'PublicArticleDetailPageContent.vue appendix must not restore internal row dividers')
expectNotMatches(publicArticleDetail, /blog-link-underline/, 'PublicArticleDetailPageContent.vue appendix links must not use underline decoration')
expectNotMatches(publicArticleDetail, /\.fsus-appendix__(?:tags|tag|copyright|nav|nav-label|nav-list|nav-item|meta|link)\s*\{[^}]*(?:border-top|border-bottom):/s, 'PublicArticleDetailPageContent.vue appendix descendants must not add dividers')
expectNotMatches(publicArticleDetail, /\.fsus-appendix(?:__[a-z-]+)?\s*\{[^}]*font-weight:\s*(?:600|700|bold)/s, 'PublicArticleDetailPageContent.vue appendix font weight must not exceed 500')
expectIncludes(publicArticleDetail, 'id="fsus-comments-island"\n      class="mt-6 sm:mt-8"', 'PublicArticleDetailPageContent.vue comments island follows article tail without duplicate rule')
expectIncludes(publicArticleDetail, 'id="fsus-comments-island-content"\n        class="min-h-0"', 'PublicArticleDetailPageContent.vue comments mount must not reserve a tall empty block')
expectNotMatches(publicArticleDetail, /class="mt-12 sm:mt-16 border-t border-\[var\(--fsusblog-panel-border\)\] pt-8 sm:pt-10"/, 'PublicArticleDetailPageContent.vue comments island must not add a duplicate top rule and large whitespace after related reading')
expectNotMatches(publicArticleDetail, /class="min-h-\[10rem\]"/, 'PublicArticleDetailPageContent.vue comments mount must not keep the old tall empty state')
expectIncludes(publicArticleDetail, 'aria-label="延伸阅读文章"', 'PublicArticleDetailPageContent.vue related reading row-list aria label')
expectNotMatches(publicArticleDetail, /grid-cols-\[4rem_minmax\(0,1fr\)\]/, 'PublicArticleDetailPageContent.vue related reading must not squeeze content with a narrow label column')
expectNotMatches(publicArticleDetail, /class="flex flex-col gap-8"/, 'PublicArticleDetailPageContent.vue extended reading must not keep large vertical gaps')
expectNotMatches(publicArticleDetail, /class="flex flex-col gap-4"/, 'PublicArticleDetailPageContent.vue extended reading must use compact rows instead of stacked blocks')
expectNotMatches(publicArticleDetail, /class="grid gap-3 sm:grid-cols-2"/, 'PublicArticleDetailPageContent.vue related reading must not split previous/next into a separate card grid')
expectNotMatches(publicArticleDetail, /v-if="item\.summary"/, 'PublicArticleDetailPageContent.vue compact related reading must not render summaries')
expectNotMatches(publicArticleDetail, /\{\{\s*item\.reason\s*\}\}\s*·\s*\{\{\s*item\.displayTime\s*\}\}/, 'PublicArticleDetailPageContent.vue related rows must not expose denser metadata than previous rows')
expectIncludes(commentDetailContract, "guestShell: 'fsus-comment-login'", 'commentDetail.ts guest composer prompt must use the compact comment login row')
expectIncludes(commentComposer, 'flex-wrap: wrap;', 'ArticleCommentComposer.vue comment login row remains responsive without vertical stacking')
expectIncludes(commentComposer, 'align-items: center;', 'ArticleCommentComposer.vue comment login row keeps a shared baseline')
expectIncludes(commentComposer, 'padding-block: 16px;', 'ArticleCommentComposer.vue comment login row stays compact')
expectIncludes(commentComposer, 'border-top: 1px solid #E4E4E7;', 'ArticleCommentComposer.vue comment login row uses the specified top divider')
expectIncludes(commentComposer, 'font-size: 14px;', 'ArticleCommentComposer.vue comment login prompt uses the demoted text size')
expectIncludes(commentComposer, 'height: 40px;', 'ArticleCommentComposer.vue comment login action keeps the compact height')
expectIncludes(commentComposer, 'padding-inline: 12px;', 'ArticleCommentComposer.vue comment login action keeps the compact horizontal padding')
expectIncludes(commentComposer, 'border-radius: 6px;', 'ArticleCommentComposer.vue reading gate action keeps the specified radius')
expectIncludes(commentComposer, 'color var(--blog-motion-control) var(--blog-motion-ease),\n    border-color var(--blog-motion-control) var(--blog-motion-ease);', 'ArticleCommentComposer.vue comment login action keeps the reading motion token')
expectNotMatches(commentComposer, /\.fsus-comment-login__btn:hover\s*\{[^}]*(?:translate|box-shadow|background-color)/s, 'ArticleCommentComposer.vue comment login hover must not move, glow, or fill')
expectNotMatches(commentComposer, /\.fsus-comment-login\s*\{[^}]*justify-content:\s*space-between/s, 'ArticleCommentComposer.vue comment login row must not restore the split layout')
expectNotMatches(commentComposer, /fsus-reading-gate|fsus-auth-gate|参与讨论/, 'ArticleCommentComposer.vue compact comment login row must not retain the demoted title gate')
expectNotMatches(commentDetailContract, /guestShell:\s*'mb-12 py-8 bg-\[var\(--fsusblog-panel-bg\)\]\/50 flex items-center justify-center border border-\[var\(--fsusblog-panel-border\)\]'/, 'commentDetail.ts guest composer prompt must not render as a tall card')
expectIncludes(commentsVirtualList, 'class="fsus-comments-list"', 'ArticleCommentsVirtualList.vue uses an open editorial comment list')
expectIncludes(commentsVirtualList, 'isAnonymousAuthor(thread.author)', 'ArticleCommentsVirtualList.vue distinguishes anonymous root authors')
expectIncludes(commentsVirtualList, 'class="fsus-comment__badge">匿名', 'ArticleCommentsVirtualList.vue labels anonymous identity plainly')
expectIncludes(commentsVirtualList, 'class="fsus-comment__footer"', 'ArticleCommentsVirtualList.vue places actions in a quiet footer')
expectIncludes(commentsVirtualList, 'formatCommentRelativeTime(iso)', 'ArticleCommentsVirtualList.vue renders comment times in Chinese')
expectIncludes(commentsVirtualList, 'padding-block: 20px;', 'ArticleCommentsVirtualList.vue comment item uses the editorial vertical rhythm')
expectIncludes(commentsVirtualList, 'border-bottom: 1px solid #E4E4E7;', 'ArticleCommentsVirtualList.vue comment item uses the restrained divider')
expectIncludes(commentsVirtualList, 'outline-offset: 4px;', 'ArticleCommentsVirtualList.vue actions keep the specified focus offset')
expectNotMatches(commentsVirtualList, /comment-thread-action/, 'ArticleCommentsVirtualList.vue must not retain the old Element Plus action styling')
expectIncludes(commentMarkdown, 'class="comment-markdown-renderer fsus-markdown-body"', 'CommentMarkdownRenderer.vue exposes the restrained markdown surface')
expectIncludes(commentMarkdown, 'margin: 0 0 12px 0 !important;', 'CommentMarkdownRenderer.vue separates markdown paragraphs')
expectIncludes(commentMarkdown, 'margin-bottom: 0 !important;', 'CommentMarkdownRenderer.vue removes the last paragraph margin')
expectIncludes(commentMarkdown, 'background-color: #F7F7F8 !important;', 'CommentMarkdownRenderer.vue keeps inline code on the paper-gray surface')
expectIncludes(commentMarkdown, 'font-size: 13px !important;', 'CommentMarkdownRenderer.vue demotes inline code sizing')
expectNotMatches(commentMarkdown, /linear-gradient/, 'CommentMarkdownRenderer.vue markdown collapse must not use a gradient veil')
expectIncludes(articleDetail, "import ArticleCommentsEmptyState from '@/components/public/ArticleCommentsEmptyState.vue'", 'ArticleDetail.vue unified comments empty state component')
expectIncludes(articleDetail, ':redirect-path="commentRedirectPath"', 'ArticleDetail.vue keeps the empty-state login redirect')
expectIncludes(articleDetail, 'v-if="!isGuestCommentEndState"', 'ArticleDetail.vue hides the legacy guest row after the comment stream reaches its end')
expectIncludes(articleDetail, 'v-if="threads.length > 0"', 'ArticleDetail.vue keeps existing comments visible alongside the unified end state')
expectIncludes(articleDetail, 'v-if="isCommentsAtEnd"', 'ArticleDetail.vue renders the unified end state after comment loading resolves')
expectIncludes(articleDetail, 'v-if="!isCommentsAtEnd"', 'ArticleDetail.vue removes the legacy cursor end placeholder when the unified end state is visible')
expectIncludes(commentsEmpty, 'class="fsus-comments-empty"', 'ArticleCommentsEmptyState.vue unified empty state root')
expectIncludes(commentsEmpty, 'class="fsus-comments-empty__text"', 'ArticleCommentsEmptyState.vue empty state copy')
expectIncludes(commentsEmpty, 'class="fsus-comments-empty__btn"', 'ArticleCommentsEmptyState.vue guest login action')
expectIncludes(articleDetail, ":message=\"isCommentsEmpty ? '暂无评论。' : pageDetailView.comments.endText\"", 'ArticleDetail.vue preserves the empty-state copy and end-of-list copy')
expectIncludes(commentsEmpty, '登录以参与讨论', 'ArticleCommentsEmptyState.vue empty state login text')
expectIncludes(commentsEmpty, 'flex-direction: column;', 'ArticleCommentsEmptyState.vue centered vertical grouping')
expectIncludes(commentsEmpty, 'align-items: center;', 'ArticleCommentsEmptyState.vue centered horizontal alignment')
expectIncludes(commentsEmpty, 'justify-content: center;', 'ArticleCommentsEmptyState.vue centered vertical alignment')
expectIncludes(commentsEmpty, 'padding-block: 32px;', 'ArticleCommentsEmptyState.vue compact breathing room')
expectIncludes(commentsEmpty, 'gap: 16px;', 'ArticleCommentsEmptyState.vue fixed vertical rhythm')
expectIncludes(commentsEmpty, 'min-height: 44px;', 'ArticleCommentsEmptyState.vue mobile-safe secondary action')
expectIncludes(commentsEmpty, 'padding-inline: 16px;', 'ArticleCommentsEmptyState.vue compact action padding')
expectIncludes(commentsEmpty, 'border: 1px solid #E4E4E7;', 'ArticleCommentsEmptyState.vue ghost action border')
expectIncludes(commentsEmpty, 'color var(--blog-motion-control) var(--blog-motion-ease),\n    border-color var(--blog-motion-control) var(--blog-motion-ease);', 'ArticleCommentsEmptyState.vue restrained interaction timing')
expectNotMatches(commentsEmpty, /\.fsus-comments-empty\s*\{[^}]*(?:border-top|border-bottom|border-radius):/s, 'ArticleCommentsEmptyState.vue root must remain open and unframed')
expectIncludes(commentsEmpty, '.fsus-comments-empty__btn:hover {\n  border-color: #2A599C;\n  background-color: transparent;\n  color: #2A599C;', 'ArticleCommentsEmptyState.vue hover must stay transparent and static')
expectNotMatches(commentsEmpty, /\.fsus-comments-empty__btn:hover\s*\{[^}]*transform:/s, 'ArticleCommentsEmptyState.vue hover must not add transform motion')
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
expectIncludes(markdownCss, 'font-size: 1rem;', 'markdown.css canonical 16px editorial reading size')
expectIncludes(markdownCss, 'line-height: 1.8;', 'markdown.css canonical editorial line height')
expectIncludes(markdownCss, 'letter-spacing: 0.015em;', 'markdown.css editorial letter spacing')
expectIncludes(markdownCss, 'text-align: justify;', 'markdown.css editorial paragraph alignment')
expectIncludes(markdownCss, '.markdown-body h1 {\n  font-size: 1.6em;', 'markdown.css article heading rule')
expectIncludes(markdownCss, '.markdown-body h2 {\n  font-size: 1.15em;', 'markdown.css section heading rule')
expectIncludes(markdownCss, 'margin-bottom: 2em;\n  border-bottom: none;', 'markdown.css section heading spacing')
expectMatches(markdownCss, /\.markdown-body p\s*\{[^}]*text-indent:\s*2em;/s, 'markdown.css editorial paragraph indent')
expectMatches(markdownCss, /\.markdown-body \.markdown-renderer__text\s*\{[^}]*letter-spacing:\s*0\.015em;[^}]*text-align:\s*justify;/s, 'markdown.css FsusUI paragraph override')
expectMatches(markdownCss, /\.markdown-body h1\s*\{[^}]*text-align:\s*center;/s, 'markdown.css centered article h1')
expectMatches(markdownCss, /\.markdown-body h2\s*\{[^}]*text-align:\s*center;/s, 'markdown.css centered article h2')
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
