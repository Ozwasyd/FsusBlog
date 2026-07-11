#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const adminAccountRoots = [
  'src/frontend/src/views/admin',
  'src/frontend/src/views/user',
  'src/frontend/src/components/account',
  'src/frontend/src/components/admin',
  'src/frontend/src/components/user'
].map((dir) => path.join(repoRoot, dir))

const publicEditorialRoots = [
  'src/frontend/src/components/public',
  'src/frontend/src/components/filter',
  'src/frontend/src/components/home',
  'src/frontend/src/components/article'
].map((dir) => path.join(repoRoot, dir))

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')
const accountShellPath = path.join(repoRoot, 'src/frontend/src/assets/account-shell.css')
const accountLayoutPath = path.join(repoRoot, 'src/frontend/src/layouts/AccountLayout.vue')
const accountNavigationPanelPath = path.join(repoRoot, 'src/frontend/src/components/account/AccountNavigationPanel.vue')
const accountHeaderMenuPath = path.join(repoRoot, 'src/frontend/src/components/account/AccountHeaderMenu.vue')
const registerPath = path.join(repoRoot, 'src/frontend/src/views/auth/Register.vue')
const adminDashboardPath = path.join(repoRoot, 'src/frontend/src/views/admin/Dashboard.vue')
const adminDashboardWorkbenchPath = path.join(repoRoot, 'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue')
const adminAnalyticsPath = path.join(repoRoot, 'src/frontend/src/views/admin/Analytics.vue')
const dashboardPopularArticlesPath = path.join(repoRoot, 'src/frontend/src/components/admin/DashboardPopularArticles.vue')
const homeTextFirstRecommendationsPath = path.join(repoRoot, 'src/frontend/src/components/home/HomeTextFirstRecommendations.vue')
const themeTokensPath = path.join(repoRoot, 'src/frontend/src/ui-tokens/themeTokens.ts')
const productionSourceRoot = path.join(repoRoot, 'src/frontend/src')
const articleDetailPath = path.join(repoRoot, 'src/frontend/src/views/ArticleDetail.vue')
const publicPageCssPath = path.join(repoRoot, 'src/frontend/src/assets/public-page.css')
const publicShellCriticalCssPath = path.join(repoRoot, 'src/frontend/src/assets/public-shell-foundation.css')
const publicShellEmergencyCssPath = path.join(repoRoot, 'src/frontend/public/public-shell-emergency.css')
const mainCssPath = path.join(repoRoot, 'src/frontend/src/assets/main.css')
const markdownCssPath = path.join(repoRoot, 'src/frontend/src/assets/markdown.css')
const publicLayoutRulesPath = path.join(repoRoot, 'docs/public-layout-rules.md')
const publicRenderersRoot = path.join(repoRoot, 'src/frontend/src/public-renderers')
const commentDetailViewContractPath = path.join(repoRoot, 'src/frontend/src/view-contracts/commentDetail.ts')

const dashboardPanelPattern = /src\/frontend\/src\/(?:views\/admin\/Dashboard|components\/admin\/Dashboard|views\/admin\/security\/Security|views\/admin\/moderation\/Moderation|components\/admin\/comment-moderation\/CommentModeration)/
const nonActionHoverPrimaryFiles = new Set([
  'src/frontend/src/views/admin/Dashboard.vue',
  'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue'
])
const governedMicroLabelFiles = new Set([
  'src/frontend/src/views/admin/Dashboard.vue',
  'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue',
  'src/frontend/src/views/admin/security/SecurityDashboard.vue',
  'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue',
  'src/frontend/src/components/admin/DashboardCommentModerationPanel.vue',
  'src/frontend/src/components/admin/DashboardQuickActionsPanel.vue',
  'src/frontend/src/components/admin/DashboardPopularArticles.vue',
  'src/frontend/src/components/admin/DashboardRecentComments.vue',
  'src/frontend/src/components/admin/users/UserManageTable.vue',
  'src/frontend/src/components/public/ArticleDetailCommentsPlaceholder.vue',
  'src/frontend/src/components/public/pages/PublicArchivePageContent.vue',
  'src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue',
  'src/frontend/src/components/public/pages/PublicHomePageContent.vue',
  'src/frontend/src/components/filter/FilterHeader.vue',
  'src/frontend/src/components/home/FeaturedArticlesSection.vue',
  'src/frontend/src/components/article/ArticleReadingNotice.vue'
])
const dashboardDensityFiles = [
  'src/frontend/src/views/admin/Dashboard.vue',
  'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue',
  'src/frontend/src/views/admin/Analytics.vue',
  'src/frontend/src/components/admin/DashboardAuthorAnalyticsList.vue',
  'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue',
  'src/frontend/src/components/admin/DashboardCommentModerationPanel.vue',
  'src/frontend/src/components/admin/DashboardQuickActionsPanel.vue',
  'src/frontend/src/components/admin/DashboardPopularArticles.vue',
  'src/frontend/src/components/admin/DashboardRecentComments.vue'
]
const roleAuditedTypographyFiles = new Set([
  'src/frontend/src/components/admin/article/ArticleAssetLibraryPanel.vue',
  'src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue',
  'src/frontend/src/components/admin/article/ArticleRevisionPanel.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationBulkActions.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationDetailDrawer.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue',
  'src/frontend/src/components/admin/comment-moderation/CommentModerationToolbar.vue'
])

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, files)
      continue
    }

    if (entry.isFile() && /\.(vue|ts)$/.test(entry.name)) {
      files.push(fullPath)
    }
  }

  return files
}

function hasAllowComment(lines, index) {
  return /fsus-allow-visual-density:/.test(lines[index] ?? '')
    || /fsus-allow-visual-density:/.test(lines[index - 1] ?? '')
}

function checkSourceFile(file, scope) {
  const relative = rel(file)
  const lines = read(file).split(/\r?\n/)

  lines.forEach((line, index) => {
    if (hasAllowComment(lines, index)) {
      return
    }

    if (/\bfont-black\b/.test(line)) {
      fail(file, index + 1, `${scope} ordinary labels and metadata must not use font-black`)
    }

    if (scope === 'admin/account' && /\btext-5xl\b/.test(line)) {
      fail(file, index + 1, 'admin/account KPI and panel surfaces must not use text-5xl by default')
    }

    if (dashboardPanelPattern.test(relative) && /\btext-3xl\b/.test(line)) {
      fail(file, index + 1, 'nested dashboard/security/moderation panels must not use text-3xl as routine titles or metrics')
    }

    if (dashboardPanelPattern.test(relative) && /\bgap-px\b/.test(line) && /bg-\[var\(--fsusblog-panel-bg-soft\)\]/.test(line)) {
      fail(file, index + 1, 'dashboard/security/moderation panels must not use gap-px soft-background lattice as default card grammar')
    }

    if (nonActionHoverPrimaryFiles.has(relative) && /group-hover:text-\[var\(--fsusblog-color-primary\)\]/.test(line)) {
      fail(file, index + 1, 'hover-primary styling must be limited to actual links/actions')
    }

    if (governedMicroLabelFiles.has(relative) && /\btext-\[(?:9|10|11)px\]\s+font-(?:bold|semibold)\b/.test(line)) {
      fail(file, index + 1, 'governed dashboard/public labels must use 12px+ readable metadata scale')
    }

    if (roleAuditedTypographyFiles.has(relative) && /\btext-\[11px\]\b/.test(line)) {
      fail(file, index + 1, 'audited article/comment moderation labels and metadata must use 12px+ role-specific scale')
    }
  })
}

function checkProductionFocusRing(file) {
  const lines = read(file).split(/\r?\n/)

  lines.forEach((line, index) => {
    if (hasAllowComment(lines, index)) {
      return
    }

    if (/\bfocus-visible:ring-1\b/.test(line)) {
      fail(file, index + 1, 'production focus-visible styles must use 2px inset focus rings, not ring-1')
    }
  })
}

function lineNumberFromSource(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

function assertContains(file, pattern, message) {
  if (!fs.existsSync(file)) {
    fail(file, 1, message)
    return
  }

  if (!pattern.test(read(file))) {
    fail(file, 1, message)
  }
}

function assertNotContains(file, pattern, message) {
  if (!fs.existsSync(file)) {
    return
  }

  const source = read(file)
  const match = pattern.exec(source)
  if (match?.index !== undefined) {
    fail(file, lineNumberFromSource(source, match.index), message)
  }
}

function contrastRatio(foreground, background) {
  const parseHex = (value) => {
    const normalized = value.replace('#', '')
    if (!/^[0-9a-f]{6}$/i.test(normalized)) {
      throw new Error(`expected six-digit hex color, got ${value}`)
    }

    return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255)
  }

  const relativeLuminance = (value) => parseHex(value)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0)

  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left)
  return (lighter + 0.05) / (darker + 0.05)
}

function checkPublicTypographyContract() {
  const readableSourceFiles = [
    ...publicEditorialRoots.flatMap((dir) => walk(dir)),
    ...walk(publicRenderersRoot),
    articleDetailPath,
    commentDetailViewContractPath,
    themeTokensPath
  ]
  const forbiddenReadableScale = /text-\[(?:9|10|11)px\]|font-size:\s*(?:0?\.625|0?\.6875|0?\.71875)rem\s*;/

  for (const file of readableSourceFiles) {
    const lines = read(file).split(/\r?\n/)
    lines.forEach((line, index) => {
      if (hasAllowComment(lines, index)) {
        return
      }

      if (forbiddenReadableScale.test(line)) {
        fail(file, index + 1, 'public readable copy must use 12px+ metadata and controls, never 9/10/11px or sub-12px rem scales')
      }
    })
  }

  for (const file of [publicPageCssPath, publicShellCriticalCssPath, publicShellEmergencyCssPath, markdownCssPath]) {
    assertNotContains(
      file,
      /font-size:\s*(?:0?\.(?:625|6875|71875|95|96)rem|(?:9|10|11)px)\s*;/,
      'public readable CSS must not use 9/10/11px or sub-12px rem typography'
    )
  }

  const markdownCss = read(markdownCssPath)
  const paragraphRuleCount = markdownCss.match(/^\.markdown-body p\s*\{/gm)?.length ?? 0
  if (paragraphRuleCount !== 1) {
    fail(markdownCssPath, 1, 'Markdown paragraph spacing must have one authoritative rule')
  }
  assertContains(
    markdownCssPath,
    /\.markdown-body\s*\{[\s\S]*?font-size:\s*1rem;[\s\S]*?line-height:\s*1\.8;/,
    'Markdown reading body must use the 16px/1.8 canonical reading scale'
  )

  assertContains(
    themeTokensPath,
    /const metadataText = `text-xs sm:text-sm leading-4 sm:leading-5/,
    'public metadata must use the 12px/14px readable role scale'
  )
  assertContains(
    themeTokensPath,
    /title: `ui-article-title text-xl sm:text-2xl lg:text-3xl[\s\S]*?leading-\[1\.1\] sm:leading-\[1\.05\]/,
    'public display titles must retain the 20/24/30px display role scale'
  )
  assertContains(
    themeTokensPath,
    /summary: `ui-article-summary mt-2 text-base sm:text-lg[\s\S]*?leading-\[1\.8\] sm:leading-\[1\.9\]/,
    'public summaries must retain the 16/18px reading role scale'
  )
  assertContains(
    themeTokensPath,
    /metaCategory: `ui-article-category inline-flex min-h-9 items-center -mx-1 px-1[\s\S]*?outline-none \$\{focusRing\}/,
    'public article category links must retain a 36px mobile touch target and visible focus treatment'
  )
  assertNotContains(
    themeTokensPath,
    /metaCategory: `[^`]*\bsm:min-h-[0-8]\b/,
    'public article category links must not shrink below the 36px touch target at larger breakpoints'
  )
  assertContains(
    themeTokensPath,
    /tagLink: `inline-flex min-h-9 items-center px-1 text-xs sm:text-sm leading-4 sm:leading-5[\s\S]*?outline-none \$\{focusRing\}/,
    'public article tags must retain a 36px mobile touch target and visible focus treatment'
  )

  const publicPageCss = read(publicPageCssPath)
  const publicShellCriticalCss = read(publicShellCriticalCssPath)
  const publicShellEmergencyCss = read(publicShellEmergencyCssPath)
  const mainCss = read(mainCssPath)
  const requiredTokenAssignments = [
    '--text-tertiary: #71717A;',
    '--text-muted: #62626A;',
    '--text-decorative: #A1A1AA;',
    '--text-tertiary: #A1A1AA;',
    '--text-muted: #B2B2BA;',
    '--text-decorative: #52525B;',
    '--fsus-dot-gray: var(--text-decorative);',
    '--fsusblog-reading-marker: var(--text-decorative);',
    '--fsusblog-text-subtle: var(--text-muted);'
  ]
  for (const token of requiredTokenAssignments) {
    assertContains(publicPageCssPath, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `public token contract is missing ${token}`)
  }
  for (const token of [
    '--text-tertiary: #71717A;',
    '--text-muted: #62626A;',
    '--text-decorative: #A1A1AA;',
    '--text-tertiary: #A1A1AA;',
    '--text-muted: #B2B2BA;',
    '--text-decorative: #52525B;',
    '--fsus-dot-gray: var(--text-decorative);',
    '--fsusblog-text-subtle: var(--text-muted);'
  ]) {
    assertContains(publicShellCriticalCssPath, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `critical public shell token contract is missing ${token}`)
  }
  assertContains(mainCssPath, /--fsus-dot-gray:\s*var\(--text-decorative\);/, 'hydrated public shell must keep dot gray decorative-only')
  assertContains(publicShellEmergencyCssPath, /--fsus-dot-gray:\s*var\(--text-decorative\);/, 'emergency public shell must keep dot gray decorative-only')

  for (const [foreground, background, role] of [
    ['#71717A', '#F7F7F8', 'light tertiary information'],
    ['#62626A', '#F7F7F8', 'light muted information'],
    ['#A1A1AA', '#09090B', 'dark tertiary information'],
    ['#B2B2BA', '#09090B', 'dark muted information']
  ]) {
    const ratio = contrastRatio(foreground, background)
    if (ratio < 4.5) {
      fail(publicPageCssPath, 1, `${role} contrast must meet WCAG AA 4.5:1; got ${ratio.toFixed(2)}:1`)
    }
  }

  for (const [file, source] of [
    [publicPageCssPath, publicPageCss],
    [publicShellEmergencyCssPath, publicShellEmergencyCss]
  ]) {
    assertContains(file, /#fsus-aot-shell \.ui-article-title\s*\{[\s\S]*?font-size:\s*1\.25rem;[\s\S]*?line-height:\s*1\.1;/, 'AOT title must match the 20px display typography baseline')
    assertContains(file, /#fsus-aot-shell \.ui-article-summary\s*\{[\s\S]*?font-size:\s*1rem;[\s\S]*?line-height:\s*1\.8;/, 'AOT summary must match the 16px reading typography baseline')
    assertContains(file, /#fsus-aot-shell \.ui-article-meta[\s\S]*?font-size:\s*0\.75rem;[\s\S]*?line-height:\s*1rem;/, 'AOT metadata must match the 12px readable metadata baseline')
    if (source.includes('font-size: 1.35rem;') || source.includes('font-size: .96rem;')) {
      fail(file, 1, 'AOT typography must not retain non-contract 1.35rem or .96rem scales')
    }
  }

  assertContains(
    publicLayoutRulesPath,
    /### 公开排版角色[\s\S]*?display[\s\S]*?reading[\s\S]*?metadata/,
    'public layout rules must document display, reading, and metadata typography roles'
  )
}

function checkIssueDensityContracts() {
  assertContains(accountLayoutPath, /\.account-skip-link:focus-visible\s*\{/, 'account skip-link must reveal only on :focus-visible')
  assertNotContains(accountLayoutPath, /\.account-skip-link:focus\s*\{/, 'account skip-link must not use mouse-triggered :focus')
  assertContains(accountLayoutPath, /\.account-skip-link:focus-visible\s*\{[\s\S]*?font-size:\s*0\.75rem;/, 'account skip-link must use the 12px readable text scale')
  assertNotContains(accountLayoutPath, /disabled:opacity-40/, 'account header/meta links must not use 40% disabled opacity')
  assertContains(accountLayoutPath, /disabled:opacity-60/, 'account header/meta links must keep disabled opacity at 60% or higher')
  assertContains(accountLayoutPath, /<el-drawer[\s\S]*?id="account-mobile-drawer"[\s\S]*?<\/el-drawer>/, 'AccountLayout mobile navigation must use a drawer that carries the account sidebar visual language')
  assertContains(accountLayoutPath, /account-mobile-drawer-trigger/, 'AccountLayout mobile navigation must expose a compact drawer trigger')
  assertContains(accountLayoutPath, /<AccountNavigationPanel[\s\S]*?variant="mobile"/, 'AccountLayout mobile drawer must reuse the module and local navigation panel')
  assertContains(accountLayoutPath, /:motion="fsusBlogMotionPresets\.mobileDrawer"/, 'AccountLayout mobile drawer must use the shared mobile drawer motion preset')
  assertNotContains(accountLayoutPath, /FsusUiSegmentedControl/, 'AccountLayout mobile group navigation must not use segmented-control as a separate visual language')
  assertNotContains(accountLayoutPath, /account-mobile-more-strip|mobileOverflowGroups|mobileMoreOpen/, 'AccountLayout mobile navigation must stay two-level and must not reintroduce an overflow group row')
  assertNotContains(accountLayoutPath, /account-mobile-link-strip/, 'AccountLayout mobile route navigation must not use a separate horizontal tab strip')
  assertContains(accountNavigationPanelPath, /\.account-module-link,[\s\S]*?\.account-local-navigation__link\s*\{[\s\S]*?min-height:\s*2\.75rem;/, 'AccountLayout mobile drawer module and local links must provide 44px hit targets')
  assertContains(accountNavigationPanelPath, /account-global-module-nav[\s\S]*account-local-navigation/, 'Account navigation must separate first-level modules from current-module local links')
  assertNotContains(accountLayoutPath, /account-sidebar-scroll|\.account-sidebar-frame\s*\{[^}]*overflow-y:\s*auto;/s, 'desktop account sidebar must not create an internal scrollbar from leaf navigation')
  assertContains(accountHeaderMenuPath, /打开账号菜单[\s\S]*使用规范[\s\S]*隐私政策[\s\S]*command="logout"/, 'account menu must own policy and logout actions')
  assertContains(path.join(repoRoot, 'docs/public-layout-rules.md'), /AccountLayout[\s\S]*Drawer[\s\S]*一级模块[\s\S]*局部导航[\s\S]*44px/, 'public layout rules must document the AccountLayout single-drawer module navigation pattern')

  assertNotContains(registerPath, /高级|极致|奢华|未来感|智能|大气|简约而不简单|沉浸式/, 'Register copy must avoid FsusUI marketing adjective blacklist')
  const registerCopyPath = path.join(repoRoot, 'src/frontend/src/copy/auth.ts')
  assertContains(registerCopyPath, /TOTP 可在账户设置中作为二次验证启用/, 'Register copy must describe TOTP as optional two-step verification (in @/copy auth registry)')
  assertNotContains(registerPath, /min-height:\s*36px;/, 'Register inline policy action must use at least 40px hit target')
  assertContains(registerPath, /min-height:\s*40px;/, 'Register inline policy action must use the compact 40px control height')

  assertNotContains(path.join(repoRoot, 'src/frontend/src/components/admin/AdminSegmentedControl.vue'), /\bmin-h-8\b/, 'Admin segmented controls must not use 32px hit targets')
  assertContains(path.join(repoRoot, 'src/frontend/src/components/admin/AdminSegmentedControl.vue'), /\bmin-h-10\b/, 'Admin segmented controls must use at least 40px hit targets')
  assertNotContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleImageLightbox.vue'), /min-height:\s*2\.5rem;/, 'Article lightbox controls must use the 44px default control height')
  assertContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleImageLightbox.vue'), /min-height:\s*2\.75rem;/, 'Article lightbox controls must use the 44px default control height')
  assertNotContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleTocPanel.vue'), /min-height:\s*2\.25rem;|font-size:\s*0\.71875rem;/, 'Article TOC controls must use 40px hit targets and the 12px small text scale')
  assertContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleTocPanel.vue'), /min-height:\s*2\.5rem;/, 'Article TOC controls must use the 40px compact height')

  assertNotContains(homeTextFirstRecommendationsPath, /\bmb-16\b|\bsm:mb-20\b|\bmin-h-24\b|\bgap-5\b/, 'Home text-first recommendations must stay within compact list density')
  assertContains(homeTextFirstRecommendationsPath, /home-text-first-recommendations mb-8 sm:mb-10/, 'Home text-first recommendations must keep section-to-feed spacing at 32/40px')
  assertContains(homeTextFirstRecommendationsPath, /\bmin-h-16\b/, 'Home text-first recommendation rows must use compact 64px list density')
  assertContains(homeTextFirstRecommendationsPath, /grid gap-3 sm:grid-cols-2 sm:gap-4/, 'Home text-first recommendation row gaps must use 12/16px list spacing')
  assertNotContains(themeTokensPath, /articleList:\s*\{[\s\S]*?container:\s*'[^']*\b(?:gap-20|sm:gap-28|lg:gap-32)\b[^']*'/, 'Public article list feed spacing must not use large editorial gaps')
  assertContains(themeTokensPath, /articleList:\s*\{[\s\S]*?container:\s*'flex flex-col gap-8'/, 'Public article list feed spacing must stay at the 32px density limit')

  assertNotContains(adminDashboardPath, /DashboardAuthorAnalyticsPanel|DashboardCommentModerationPanel|DashboardQuickActionsPanel|DashboardPopularArticles|DashboardRecentComments|访客来源|地域访问/, 'ManageDashboard must stay a lightweight overview and link out to dedicated workspaces')
  assertContains(adminDashboardPath, /AdminDashboardTaskWorkbench/, 'ManageDashboard must delegate rendering to the task-first workbench')
  assertContains(adminDashboardWorkbenchPath, /今日待处理[\s\S]*dashboard-task-list[\s\S]*站点摘要[\s\S]*dashboard-stat-ledger/, 'ManageDashboard workbench must keep tasks before its compact summary ledger')
  assertContains(adminDashboardWorkbenchPath, /<dl class="dashboard-stat-ledger" aria-label="站点统计摘要">/, 'ManageDashboard summary must use definition-list semantics')
  assertContains(adminDashboardWorkbenchPath, /帮助与反馈[\s\S]*帮助与反馈入口/, 'ManageDashboard feedback must live behind a help disclosure')
  assertNotContains(adminDashboardWorkbenchPath, /dashboard-stat-card|<el-icon|GitHub|Issue|仓库维护/, 'ManageDashboard must not restore icon KPI cards or repository maintenance copy')
  assertNotContains(adminDashboardWorkbenchPath, /DashboardAuthorAnalyticsPanel|DashboardCommentModerationPanel|DashboardQuickActionsPanel|DashboardPopularArticles|DashboardRecentComments|累计阅读|totalReads|RUM|AOT|访客来源|地域访问/, 'ManageDashboard workbench must not absorb reading, runtime, traffic analytics, or legacy panels')
  assertContains(adminAnalyticsPath, /DashboardAuthorAnalyticsPanel/, 'ManageAnalytics must own the author analytics panel')
  assertContains(adminAnalyticsPath, /访客来源[\s\S]*地域访问/, 'ManageAnalytics must own traffic source and region panels')
  assertContains(path.join(repoRoot, 'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'), /AdminStatusMatrix/, 'ManageAnalytics content and technical metrics must use FsusBlog AdminStatusMatrix compact density')
  assertNotContains(path.join(repoRoot, 'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'), /FsusUiMetricList|FsusUiMetricItem/, 'ManageAnalytics content and technical metrics must not use the generic FsusUI metric-list control')
  assertNotContains(path.join(repoRoot, 'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'), /text-2xl|class="[^"]*\bp-6\b[^"]*"[\s\S]{0,240}\{\{\s*metric\.value\s*\}\}/, 'ManageAnalytics metrics must not regress to large KPI cards')

  for (const relativePath of dashboardDensityFiles) {
    const file = path.join(repoRoot, relativePath)
    assertNotContains(file, /\b(?:mb-12|mb-16|p-8|min-h-60|min-h-72|min-h-\[(?:18\.75rem|320px)\])\b|min-height:\s*9rem/, 'admin dashboard task surfaces must stay within 32px spacing and compact panel density')
  }

  const densityScaleFiles = new Map([
    ['src/frontend/src/components/user/UserCommentsErrorState.vue', [/font-size:\s*0\.9375rem;/, /font-size:\s*0\.8125rem;/]],
    ['src/frontend/src/components/user/UserCommentsEmptyState.vue', [/font-size:\s*0\.9375rem;/, /font-size:\s*0\.8125rem;/]],
    ['src/frontend/src/components/user/messages/MessagesEmptyState.vue', [/font-size:\s*0\.9375rem;/, /font-size:\s*0\.8125rem;/]],
    ['src/frontend/src/components/user/messages/MessagesConversationList.vue', [/font-size:\s*0\.9375rem;/]],
    ['src/frontend/src/components/user/messages/MessagesThreadPanel.vue', [/font-size:\s*0\.95rem;/, /font-size:\s*0\.6875rem;/]],
    ['src/frontend/src/components/admin/DashboardCommentModerationPanel.vue', [/font-size:\s*0\.9375rem;/, /font-size:\s*0\.8125rem;/]],
    ['src/frontend/src/layouts/AccountLayout.vue', [/font-size:\s*0\.(?:625|6875|8125)rem;/]],
    ['src/frontend/src/components/article/ArticleImageLightbox.vue', [/font-size:\s*0\.8125rem;/]],
    ['src/frontend/src/components/article/ArticleTocPanel.vue', [/font-size:\s*0\.(?:6875|71875)rem;/]],
    ['src/frontend/src/components/admin/article/ArticleSeoPreviewPanel.vue', [/font-size:\s*0\.(?:62|68|72|82|92)rem;/]],
    ['src/frontend/src/components/admin/article/ArticleWriteSidebar.vue', [/font-size:\s*0\.(?:72|82|86)rem;/]],
    ['src/frontend/src/components/admin/article/ArticleRevisionPanel.vue', [/font-size:\s*0\.78rem;/]],
    ['src/frontend/src/views/admin/article/Write.vue', [/font-size:\s*0\.(?:6875|72|78|82)rem;/]]
  ])
  for (const [relativePath, patterns] of densityScaleFiles) {
    const file = path.join(repoRoot, relativePath)
    for (const pattern of patterns) {
      assertNotContains(file, pattern, 'issue #722 governed typography must use 12/14/16px scale values')
    }
  }
}

function checkDashboardPopularArticlesFocusContract() {
  const source = read(dashboardPopularArticlesPath)
  const focusRingBindings = source.match(/:class="focusRingClass"/g)?.length ?? 0

  if (!source.includes("import { themeTokens } from '@/ui-tokens/themeTokens'")) {
    fail(dashboardPopularArticlesPath, 1, 'DashboardPopularArticles links must consume the shared themeTokens.focusRing contract')
  }

  if (!source.includes('const focusRingClass = themeTokens.focusRing')) {
    fail(dashboardPopularArticlesPath, 1, 'DashboardPopularArticles must route focus styles through themeTokens.focusRing')
  }

  if (focusRingBindings < 2) {
    fail(dashboardPopularArticlesPath, 1, 'DashboardPopularArticles title and footer links must both bind focusRingClass')
  }

  if (/\bblog-focus-ring\b/.test(source)) {
    fail(dashboardPopularArticlesPath, 1, 'DashboardPopularArticles must not reintroduce local blog-focus-ring helpers')
  }

  if (/box-shadow:\s*inset 0 0 0 1px var\(--fsusblog-color-focus-ring\)/.test(source)) {
    fail(dashboardPopularArticlesPath, 1, 'DashboardPopularArticles focus-visible replacement must use the shared 2px inset contract, not local 1px box-shadow')
  }
}

function checkAdminColorGovernance() {
  const governedFiles = [
    'src/frontend/src/components/admin/AdminStatusMatrix.vue',
    'src/frontend/src/views/admin/moderation/ModerationLayout.vue',
    'src/frontend/src/views/admin/moderation/ModerationDashboard.vue',
    'src/frontend/src/views/admin/moderation/ModerationModel.vue',
    'src/frontend/src/views/admin/moderation/ModerationReplay.vue',
    'src/frontend/src/views/admin/moderation/ModerationDictionaries.vue',
    'src/frontend/src/views/admin/security/SecurityLayout.vue',
    'src/frontend/src/views/admin/Settings.vue',
    'src/frontend/src/components/admin/users/UserBanDialog.vue'
  ]

  assertContains(
    accountShellPath,
    /--fsusblog-admin-status-success:/,
    'account/admin shells must expose muted admin status tokens for task surfaces'
  )
  assertContains(
    accountShellPath,
    /\.admin-muted-alert\s*\{/,
    'account/admin shells must expose a muted alert primitive for non-critical task notices'
  )

  for (const relativePath of governedFiles) {
    const file = path.join(repoRoot, relativePath)
    assertNotContains(
      file,
      /border-l-4\s+border-\[var\(--fsusblog-color-(?:primary|success|warning|error|danger)\)\]/,
      'admin task notices must not use high-saturation 4px semantic rails'
    )
  }

  const statusMatrixPath = path.join(repoRoot, 'src/frontend/src/components/admin/AdminStatusMatrix.vue')
  assertNotContains(
    statusMatrixPath,
    /border-left-color:\s*var\(--fsusblog-color-(?:success|warning|error|primary)\)/,
    'AdminStatusMatrix must not use high-saturation semantic rails for repeated status cells'
  )
  assertNotContains(
    statusMatrixPath,
    /background:\s*var\(--fsusblog-color-(?:success|warning|error|primary)\)/,
    'AdminStatusMatrix bars and dots must use muted admin status tokens'
  )
  assertContains(
    statusMatrixPath,
    /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*14rem\),\s*1fr\)\);/,
    'AdminStatusMatrix compact cells must keep enough column width for label/value/helper text'
  )
  assertContains(
    statusMatrixPath,
    /min-height:\s*64px;/,
    'AdminStatusMatrix compact cells must not compress label, value, and helper copy into a 44px row'
  )
  assertContains(
    statusMatrixPath,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(3ch,\s*auto\);/,
    'AdminStatusMatrix compact cells must align labels and right-side numeric values'
  )
  assertContains(
    statusMatrixPath,
    /justify-self:\s*end;/,
    'AdminStatusMatrix compact values must not sit directly after the label text'
  )
  assertNotContains(
    statusMatrixPath,
    /admin-status-matrix--compact[\s\S]{0,260}min-height:\s*44px;/,
    'AdminStatusMatrix compact cells must not regress to the over-compressed 44px layout'
  )

  const motionPath = path.join(repoRoot, 'src/frontend/src/assets/motion.css')
  assertNotContains(
    motionPath,
    /--blog-motion-highlight-(?:bg|border):\s*color-mix\(in srgb, var\(--fsusblog-color-primary[^)]*\)\s+(?:[7-9]|[1-9]\d)%/,
    'blog motion highlight must keep primary tint below the large-area task-surface threshold'
  )
  assertNotContains(
    motionPath,
    /color-mix\(in srgb, var\(--fsusblog-color-error[^)]*\)\s+(?:[7-9]|[1-9]\d)%/,
    'blog motion error feedback must use muted danger tokens instead of bright large-area error tint'
  )
}

function checkAdminStatusDensityGovernance() {
  const governedRoots = [
    'src/frontend/src/views/admin/moderation',
    'src/frontend/src/views/admin/security'
  ].map((dir) => path.join(repoRoot, dir))

  for (const file of governedRoots.flatMap((dir) => walk(dir))) {
    const source = read(file)
    const largeMetricCardPattern = /class="[^"]*\bgrid\b[^"]*\b(?:md|lg):grid-cols-[^"]*"[\s\S]{0,700}<div\s+v-for="[^"]+"[^>]*class="[^"]*\bp-5\b[^"]*"[\s\S]{0,500}\btext-2xl\b/
    const match = largeMetricCardPattern.exec(source)
    if (match?.index !== undefined) {
      fail(
        file,
        lineNumberFromSource(source, match.index),
        'admin moderation/security status metrics must use AdminStatusMatrix compact density instead of p-5 text-2xl cards'
      )
    }
  }
}

for (const file of adminAccountRoots.flatMap((dir) => walk(dir))) {
  checkSourceFile(file, 'admin/account')
}

for (const file of publicEditorialRoots.flatMap((dir) => walk(dir))) {
  checkSourceFile(file, 'public editorial')
}

for (const file of walk(productionSourceRoot)) {
  checkProductionFocusRing(file)
}

checkDashboardPopularArticlesFocusContract()
checkIssueDensityContracts()
checkPublicTypographyContract()
checkAdminColorGovernance()
checkAdminStatusDensityGovernance()

const accountShell = read(accountShellPath)
if (/\.account-(?:page-eyebrow|section-title)[\s\S]*?text-transform:\s*uppercase/.test(accountShell)) {
  fail(accountShellPath, 1, 'account page eyebrow and section title must not use uppercase text transform')
}

const accountLayout = read(accountLayoutPath)
if (/\bfont-weight:\s*800\b/.test(accountLayout)) {
  fail(accountLayoutPath, 1, 'account navigation group labels must not use 800 font weight')
}
if (/\btext-\[11px\]\s+font-(?:bold|semibold)\s+uppercase\b/.test(accountLayout)) {
  fail(accountLayoutPath, 1, 'account navigation and eyebrow labels must not use 11px uppercase micro-labels')
}
if (/\baccount-nav-link-label\s*\{[\s\S]*?\btext-\[11px\]/.test(accountLayout)) {
  fail(accountLayoutPath, 1, 'account nav item labels must use 13px readable scale')
}
const accountHeader = /<header[\s\S]*?<\/header>/.exec(accountLayout)?.[0] ?? ''
if (/areaMeta\.(?:eyebrow|title)/.test(accountHeader)) {
  fail(accountLayoutPath, 1, 'account header must not duplicate the area eyebrow/title already shown in aside')
}

const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-visual-density-governance.mjs'
if (scripts['check:visual-density-governance'] !== checkScript) {
  fail(packageJsonPath, 1, 'check:visual-density-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:visual-density-governance')) {
  fail(packageJsonPath, 1, 'check:views-constraints must run check:visual-density-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[visual-density-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[visual-density-governance] ok')
