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
const registerPath = path.join(repoRoot, 'src/frontend/src/views/auth/Register.vue')
const adminDashboardPath = path.join(repoRoot, 'src/frontend/src/views/admin/Dashboard.vue')
const adminAnalyticsPath = path.join(repoRoot, 'src/frontend/src/views/admin/Analytics.vue')
const dashboardPopularArticlesPath = path.join(repoRoot, 'src/frontend/src/components/admin/DashboardPopularArticles.vue')
const homeTextFirstRecommendationsPath = path.join(repoRoot, 'src/frontend/src/components/home/HomeTextFirstRecommendations.vue')
const themeTokensPath = path.join(repoRoot, 'src/frontend/src/ui-tokens/themeTokens.ts')
const productionSourceRoot = path.join(repoRoot, 'src/frontend/src')

const dashboardPanelPattern = /src\/frontend\/src\/(?:views\/admin\/Dashboard|components\/admin\/Dashboard|views\/admin\/security\/Security|views\/admin\/moderation\/Moderation|components\/admin\/comment-moderation\/CommentModeration)/
const nonActionHoverPrimaryFiles = new Set([
  'src/frontend/src/views/admin/Dashboard.vue'
])
const governedMicroLabelFiles = new Set([
  'src/frontend/src/views/admin/Dashboard.vue',
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

function checkIssueDensityContracts() {
  assertContains(accountLayoutPath, /\.account-skip-link:focus-visible\s*\{/, 'account skip-link must reveal only on :focus-visible')
  assertNotContains(accountLayoutPath, /\.account-skip-link:focus\s*\{/, 'account skip-link must not use mouse-triggered :focus')
  assertContains(accountLayoutPath, /\.account-skip-link:focus-visible\s*\{[\s\S]*?font-size:\s*0\.75rem;/, 'account skip-link must use the 12px readable text scale')
  assertNotContains(accountLayoutPath, /disabled:opacity-40/, 'account header/meta links must not use 40% disabled opacity')
  assertContains(accountLayoutPath, /disabled:opacity-60/, 'account header/meta links must keep disabled opacity at 60% or higher')
  assertNotContains(accountLayoutPath, /<el-drawer[\s\S]*?id="account-mobile-drawer"[\s\S]*?<\/el-drawer>/, 'AccountLayout mobile navigation must not use drawer navigation')
  assertContains(accountLayoutPath, /FsusUiSegmentedControl/, 'AccountLayout mobile group navigation must use the FsusUI segmented-control adapter')
  assertNotContains(accountLayoutPath, /account-mobile-more-strip|mobileOverflowGroups|mobileMoreOpen/, 'AccountLayout mobile navigation must stay two-level and must not reintroduce an overflow group row')
  assertContains(accountLayoutPath, /account-mobile-link-strip/, 'AccountLayout mobile route navigation must use the documented scrollable tab strip')
  assertContains(accountLayoutPath, /\.account-mobile-nav-link\s*\{[\s\S]*?min-height:\s*44px;/, 'AccountLayout mobile route links must provide 44px hit targets')
  assertContains(path.join(repoRoot, 'docs/public-layout-rules.md'), /AccountLayout[\s\S]*segment control[\s\S]*horizontal scrollable tab strip[\s\S]*44px/, 'public layout rules must document the AccountLayout mobile navigation pattern')

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
  assertContains(adminAnalyticsPath, /DashboardAuthorAnalyticsPanel/, 'ManageAnalytics must own the author analytics panel')
  assertContains(adminAnalyticsPath, /访客来源[\s\S]*地域访问/, 'ManageAnalytics must own traffic source and region panels')

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
