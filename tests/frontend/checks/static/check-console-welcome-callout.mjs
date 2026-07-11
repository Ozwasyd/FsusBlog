#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function expectIncludes(path, token, label) {
  if (!read(path).includes(token)) {
    errors.push(`${path}: missing ${label}`)
  }
}

function expectNotIncludes(path, token, label) {
  if (read(path).includes(token)) {
    errors.push(`${path}: forbidden ${label}`)
  }
}

for (const token of [
  'ConsoleWelcomeCallout.Enabled',
  'ConsoleWelcomeCallout.ShowOnFirstRun',
  'ConsoleWelcomeCallout.ContributeUrl',
  'ConsoleWelcomeCallout.IssueUrl',
  'ConsoleWelcomeCallout.CommunityUrl',
  'ConsoleWelcomeCallout.HideForPrivateDeployment',
  'VITE_FSUSBLOG_CONSOLE_WELCOME_ENABLED',
  'VITE_FSUSBLOG_EXTERNAL_LINKS_ENABLED',
  'VITE_FSUSBLOG_PRIVATE_DEPLOYMENT',
  'window.__FSUSBLOG_CONSOLE_WELCOME_CALLOUT__',
  'shouldShowConsoleWelcomeCallout',
  'buildConsoleWelcomeCalloutLinks',
  'buildConsoleSupportLinks',
  'https://github.com/Ozwasyd/FsusBlog/issues/new/choose',
]) {
  expectIncludes('src/frontend/src/config/consoleWelcomeCallout.ts', token, token)
}

for (const token of [
  'CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX',
  'window.localStorage.setItem',
  'storageKeyFor',
  'userKey',
  'shouldShowConsoleWelcomeCallout(config)',
]) {
  expectIncludes('src/frontend/src/composables/useConsoleWelcomeCallout.ts', token, token)
}

for (const token of [
  'data-console-welcome-callout="true"',
  'console-welcome-callout__header',
  'console-welcome-callout__actions',
  'data-console-welcome-dismiss="true"',
  'target="_blank"',
  'rel="noopener noreferrer"',
  '关闭控制台反馈提示',
  '控制台维护',
  '发现后台问题或需要记录改进项，可以从这里进入项目维护入口。',
  'link.label',
  'grid-template-columns: minmax(0, 1fr) auto',
  'justify-content: flex-end',
  'box-sizing: border-box',
  'width: 100%',
]) {
  expectIncludes('src/frontend/src/components/admin/ConsoleWelcomeCallout.vue', token, token)
}

expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', '<ConsoleWelcomeCallout', 'dashboard callout placement')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'consoleWelcomeUserKey', 'dashboard callout user key')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'GitHub', 'dashboard GitHub prompt')
expectNotIncludes('src/frontend/src/views/admin/Dashboard.vue', 'Issue', 'dashboard issue prompt')
expectIncludes(
  'src/frontend/src/views/admin/Dashboard.vue',
  'AdminDashboardTaskWorkbench',
  'dashboard task workbench'
)
for (const token of [
  '帮助与反馈',
  '帮助与反馈入口',
  'helpLinks',
  'target="_blank"',
  'rel="noopener noreferrer"',
]) {
  expectIncludes('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue', token, token)
}
for (const token of ['GitHub', 'Issue', '仓库维护', '<ConsoleWelcomeCallout']) {
  expectNotIncludes(
    'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue',
    token,
    `dashboard help menu ${token}`
  )
}
expectIncludes('src/frontend/src/vite-env.d.ts', '__FSUSBLOG_CONSOLE_WELCOME_CALLOUT__', 'runtime window override type')
expectIncludes('docs/frontend/console-welcome-callout.md', 'ConsoleWelcomeCallout.Enabled', 'configuration docs')
expectIncludes('src/frontend/package.json', 'check:console-welcome-callout', 'npm script')
expectIncludes('src/frontend/package.json', 'npm run check:console-welcome-callout', 'views constraints hook')
expectIncludes(
  'tests/frontend/unit/composables/useConsoleWelcomeCallout.test.ts',
  'single-link GitHub issue default',
  'single-link default unit coverage'
)
expectIncludes(
  'tests/frontend/unit/composables/useConsoleWelcomeCallout.test.ts',
  'configured three-link maintenance order',
  'three-link unit coverage'
)
expectIncludes(
  'tests/frontend/unit/composables/useConsoleWelcomeCallout.test.ts',
  'keeps feedback available in the help menu after the first-run banner is disabled',
  'help-menu migration coverage'
)

expectNotIncludes('src/frontend/src/config/consoleWelcomeCallout.ts', 'diagnostic', 'diagnostic issue URL attachment')
for (const token of [
  'GitLab',
  'Welcome to FsusBlog.',
  'improvement idea',
  'send a patch',
  'position: absolute',
  'padding-right: 2.75rem',
]) {
  expectNotIncludes('src/frontend/src/components/admin/ConsoleWelcomeCallout.vue', token, token)
}

for (const token of [
  'Contribution guide',
  'Create GitHub issue',
  'Project community',
]) {
  expectNotIncludes('src/frontend/src/config/consoleWelcomeCallout.ts', token, token)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[console-welcome-callout] ${error}`)
  }
  process.exit(1)
}

console.log('[console-welcome-callout] ok')
