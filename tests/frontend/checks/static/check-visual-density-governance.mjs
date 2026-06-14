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

const dashboardPanelPattern = /src\/frontend\/src\/(?:views\/admin\/Dashboard|components\/admin\/Dashboard|views\/admin\/security\/Security|views\/admin\/moderation\/Moderation|components\/admin\/comment-moderation\/CommentModeration)/
const nonActionHoverPrimaryFiles = new Set([
  'src/frontend/src/components/admin/DashboardStatCards.vue'
])
const governedMicroLabelFiles = new Set([
  'src/frontend/src/views/admin/Dashboard.vue',
  'src/frontend/src/views/admin/security/SecurityDashboard.vue',
  'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue',
  'src/frontend/src/components/admin/DashboardCommentModerationPanel.vue',
  'src/frontend/src/components/admin/DashboardOperationsPanel.vue',
  'src/frontend/src/components/admin/DashboardPopularArticles.vue',
  'src/frontend/src/components/admin/DashboardRecentComments.vue',
  'src/frontend/src/components/admin/DashboardStatCards.vue',
  'src/frontend/src/components/admin/users/UserManageTable.vue',
  'src/frontend/src/components/public/ArticleDetailCommentsPlaceholder.vue',
  'src/frontend/src/components/public/pages/PublicArchivePageContent.vue',
  'src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue',
  'src/frontend/src/components/public/pages/PublicHomePageContent.vue',
  'src/frontend/src/components/filter/FilterHeader.vue',
  'src/frontend/src/components/home/FeaturedArticlesSection.vue',
  'src/frontend/src/components/article/ArticleReadingNotice.vue'
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
  })
}

for (const file of adminAccountRoots.flatMap((dir) => walk(dir))) {
  checkSourceFile(file, 'admin/account')
}

for (const file of publicEditorialRoots.flatMap((dir) => walk(dir))) {
  checkSourceFile(file, 'public editorial')
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
