#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const files = {
  packageJson: path.join(repoRoot, 'src/frontend/package.json'),
  adminSystemTabs: path.join(repoRoot, 'src/frontend/src/components/admin/AdminSystemTabs.vue'),
  moderationLayout: path.join(repoRoot, 'src/frontend/src/views/admin/moderation/ModerationLayout.vue'),
  securityLayout: path.join(repoRoot, 'src/frontend/src/views/admin/security/SecurityLayout.vue'),
  moderationTabs: path.join(repoRoot, 'src/frontend/src/components/admin/moderation/ModerationSystemTabs.vue'),
  securityTabs: path.join(repoRoot, 'src/frontend/src/components/admin/security/SecuritySystemTabs.vue')
}

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function lineOf(source, token) {
  const index = source.indexOf(token)
  if (index < 0) return 1
  return source.slice(0, index).split(/\r?\n/u).length
}

for (const file of [files.moderationTabs, files.securityTabs]) {
  if (fs.existsSync(file)) {
    fail(file, 1, 'legacy system tabs component must be deleted; use AdminSystemTabs + FsusUiSectionNav')
  }
}

if (!fs.existsSync(files.adminSystemTabs)) {
  fail(files.adminSystemTabs, 1, 'AdminSystemTabs.vue is missing')
} else {
  const source = read(files.adminSystemTabs)
  for (const token of ['FsusUiSectionNav', 'router.resolve', 'ariaLabel', 'current: route.name === item.name', 'event.preventDefault()', 'router.push(nextLocation)']) {
    if (!source.includes(token)) {
      fail(files.adminSystemTabs, 1, `AdminSystemTabs contract is missing ${token}`)
    }
  }
  if (!/closest<HTMLAnchorElement>\('a\[href\]'\)/.test(source)) {
    fail(files.adminSystemTabs, 1, 'AdminSystemTabs must intercept SectionNav anchor clicks at the adapter boundary')
  }
  if (!source.includes("destination.origin !== window.location.origin")) {
    fail(files.adminSystemTabs, 1, 'AdminSystemTabs must keep external links on native anchor navigation')
  }
}

for (const file of [files.moderationLayout, files.securityLayout]) {
  const source = read(file)
  const forbiddenTokens = [
    'ModerationSystemTabs',
    'SecuritySystemTabs',
    'shadow-[inset_0_-2px_0_var(--el-color-primary)]',
    '--el-color-primary'
  ]
  for (const token of forbiddenTokens) {
    if (source.includes(token)) {
      fail(file, lineOf(source, token), `admin system layout must not include ${token}`)
    }
  }

  for (const token of ['AdminSystemTabs', ':items=', 'aria-label=']) {
    if (!source.includes(token)) {
      fail(file, 1, `admin system layout is missing ${token}`)
    }
  }
}

const packageJson = JSON.parse(read(files.packageJson))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-admin-system-tabs-governance.mjs'
if (scripts['check:admin-system-tabs-governance'] !== checkScript) {
  fail(files.packageJson, 1, 'check:admin-system-tabs-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:admin-system-tabs-governance')) {
  fail(files.packageJson, 1, 'check:views-constraints must run check:admin-system-tabs-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[admin-system-tabs-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[admin-system-tabs-governance] ok')
