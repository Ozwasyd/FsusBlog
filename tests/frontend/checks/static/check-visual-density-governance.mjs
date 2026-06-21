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
const dashboardPopularArticlesPath = path.join(repoRoot, 'src/frontend/src/components/admin/DashboardPopularArticles.vue')
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
