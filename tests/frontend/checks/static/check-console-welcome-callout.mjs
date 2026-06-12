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
  'Contribution guide',
  'Create GitHub issue',
  'Project community'
]) {
  expectIncludes('src/frontend/src/config/consoleWelcomeCallout.ts', token, token)
}

for (const token of [
  'CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX',
  'window.localStorage.setItem',
  'storageKeyFor',
  'userKey',
  'shouldShowConsoleWelcomeCallout(config)'
]) {
  expectIncludes('src/frontend/src/composables/useConsoleWelcomeCallout.ts', token, token)
}

for (const token of [
  'data-console-welcome-callout="true"',
  'data-console-welcome-dismiss="true"',
  'target="_blank"',
  'rel="noopener noreferrer"',
  'Welcome to FsusBlog.',
  'link.label',
  'Dismiss welcome callout'
]) {
  expectIncludes('src/frontend/src/components/admin/ConsoleWelcomeCallout.vue', token, token)
}

expectIncludes('src/frontend/src/views/admin/Dashboard.vue', '<ConsoleWelcomeCallout', 'dashboard callout placement')
expectIncludes('src/frontend/src/views/admin/Dashboard.vue', 'consoleWelcomeUserKey', 'per-user dismissal key')
expectIncludes('src/frontend/src/vite-env.d.ts', '__FSUSBLOG_CONSOLE_WELCOME_CALLOUT__', 'runtime window override type')
expectIncludes('docs/frontend/console-welcome-callout.md', 'ConsoleWelcomeCallout.Enabled', 'configuration docs')
expectIncludes('src/frontend/package.json', 'check:console-welcome-callout', 'npm script')
expectIncludes('src/frontend/package.json', 'npm run check:console-welcome-callout', 'views constraints hook')

expectNotIncludes('src/frontend/src/config/consoleWelcomeCallout.ts', 'diagnostic', 'diagnostic issue URL attachment')
expectNotIncludes('src/frontend/src/components/admin/ConsoleWelcomeCallout.vue', 'GitLab', 'copied GitLab wording')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[console-welcome-callout] ${error}`)
  }
  process.exit(1)
}

console.log('[console-welcome-callout] ok')
