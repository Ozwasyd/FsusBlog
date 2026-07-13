#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAdminPrincipalSnapshotFrame, encodeIdentityAccountSnapshotFrame } from '../../support/aeds-envelope.mjs'
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'
import { resolveRuntimeBrowserTimeoutPlan } from '../../support/runtime-browser-timeout.mjs'
import { resolveAdaptiveManifestWorkers } from '../../../../tools/test/run-command-manifest.mjs'

const baseUrl = (
  process.env.PLAYWRIGHT_BASE_URL
  || process.env.FSUSBLOG_DEBUG_FRONTEND_URL
  || process.env.FSUSBLOG_PUBLIC_BASE_URL
  || process.env.FSUSBLOG_BASE_URL
  || 'http://127.0.0.1:3000'
).replace(/\/+$/u, '')
const publicFixtureIds = readPublicFixtureIds()
const timeoutPlan = resolveRuntimeBrowserTimeoutPlan()

const AUTH_ME_PATTERN = /\/api\/binary\/auth\/me(?:[?#]|$)/u
const ADMIN_ME_PATTERN = /\/api\/binary\/auth\/admin\/me(?:[?#]|$)/u

const matrix = [
  { id: 'public-home', route: '/', auth: 'guest', expectedAuthMe: 0, expectedAdminMe: 0 },
  { id: 'public-archive', route: '/archive', auth: 'guest', expectedAuthMe: 0, expectedAdminMe: 0 },
  { id: 'public-about', route: '/about', auth: 'guest', expectedAuthMe: 0, expectedAdminMe: 0 },
  { id: 'public-article', route: `/article/${publicFixtureIds.articleId}`, auth: 'guest', expectedAuthMe: 0, expectedAdminMe: 0 },
  { id: 'guest-login', route: '/login', auth: 'guest', expectedAuthMe: 1, expectedAdminMe: 0 },
  { id: 'guest-account', route: '/user/identity', auth: 'guest', expectedAuthMe: 1, expectedAdminMe: 0 },
  { id: 'guest-manage', route: '/user/manage', auth: 'guest', expectedAuthMe: 1, expectedAdminMe: 1 },
  { id: 'admin-manage', route: '/user/manage', auth: 'admin', expectedAuthMe: 1, expectedAdminMe: 1 },
]

export function resolveZeroAuthProbeWorkers({ env = process.env, taskCount = matrix.length + 1, ...runtime } = {}) {
  if (!Number.isInteger(taskCount) || taskCount < 1) throw new Error('taskCount must be a positive integer')
  return Math.min(taskCount, resolveAdaptiveManifestWorkers({
    env: {
      ...env,
      FSUSBLOG_COMMAND_MANIFEST_WORKERS: String(taskCount),
    },
    workload: 'orchestration',
    ...runtime,
  }))
}

export async function runZeroAuthProbeQueue(tasks, workers, execute) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks must be a non-empty array')
  if (!Number.isInteger(workers) || workers < 1) throw new Error('workers must be a positive integer')
  if (typeof execute !== 'function') throw new Error('execute must be a function')
  const results = new Array(tasks.length)
  const failures = []
  let next = 0
  const workerCount = Math.min(tasks.length, workers)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= tasks.length) return
      try {
        results[index] = await execute(tasks[index], index)
      } catch (error) {
        failures.push({ index, id: tasks[index]?.id ?? String(index), error })
      }
    }
  }))

  failures.sort((left, right) => left.index - right.index)
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `zero-auth probe failed in ${failures.length} independent scenarios: ${failures.map((failure) => failure.id).join(', ')}`,
    )
  }
  return results
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function authSnapshotBody() {
  return Buffer.from(encodeIdentityAccountSnapshotFrame({
    accountId: 740001,
    publicHandle: 'zero-auth-probe',
    identityKind: 'anonymous_account',
    status: 0,
  }))
}

function adminSnapshotBody() {
  return Buffer.from(encodeAdminPrincipalSnapshotFrame({
    id: '740001',
    displayName: 'zero-auth-admin',
    permissions: ['admin.manage'],
    adminSessionStatus: 'active',
  }))
}

async function installAuthCounters(context, scenario, counters) {
  await context.route('**/*', async (route) => {
    const url = route.request().url()

    if (AUTH_ME_PATTERN.test(url)) {
      counters.authMe.push(url)
      if (scenario.auth === 'admin') {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: authSnapshotBody(),
        })
        return
      }

      await route.fulfill({
        status: 401,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(0),
      })
      return
    }

    if (ADMIN_ME_PATTERN.test(url)) {
      counters.adminMe.push(url)
      if (scenario.auth === 'admin') {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: adminSnapshotBody(),
        })
        return
      }

      await route.fulfill({
        status: 401,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(0),
      })
      return
    }

    await route.continue()
  })
}

async function runScenario(browser, scenario) {
  const counters = {
    authMe: [],
    adminMe: [],
  }
  const context = await browser.newContext()
  await installAuthCounters(context, scenario, counters)
  const page = await context.newPage()

  try {
    await page.goto(`${baseUrl}${scenario.route}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutPlan.navigationTimeoutMs,
    })
    await page.waitForTimeout(1800)
  } finally {
    await context.close()
  }

  const actualAuthMe = counters.authMe.length
  const actualAdminMe = counters.adminMe.length
  const requestDetails = [
    ...counters.authMe.map((url) => `auth/me ${url}`),
    ...counters.adminMe.map((url) => `auth/admin/me ${url}`),
  ].join('\n')

  assert(
    actualAuthMe <= scenario.expectedAuthMe,
    `[zero-auth-probe] ${scenario.id} ${scenario.route}: /auth/me expected <= ${scenario.expectedAuthMe}, got ${actualAuthMe}\n${requestDetails}`
  )
  assert(
    actualAdminMe <= scenario.expectedAdminMe,
    `[zero-auth-probe] ${scenario.id} ${scenario.route}: /auth/admin/me expected <= ${scenario.expectedAdminMe}, got ${actualAdminMe}\n${requestDetails}`
  )

  return {
    id: scenario.id,
    route: scenario.route,
    authMe: actualAuthMe,
    adminMe: actualAdminMe,
  }
}

async function runPublicNavigationScenario(browser) {
  const counters = {
    authMe: [],
    adminMe: [],
  }
  const context = await browser.newContext()
  await installAuthCounters(context, {
    id: 'public-spa-navigation',
    auth: 'guest',
  }, counters)
  const page = await context.newPage()

  try {
    await page.goto(`${baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutPlan.navigationTimeoutMs,
    })
    const aboutLink = page.locator('a[href="/about"]:visible').first()
    await aboutLink.waitFor({ state: 'visible', timeout: 0 })
    await aboutLink.click()
    await page.waitForURL(/\/about(?:[?#].*)?$/u, { timeout: timeoutPlan.navigationTimeoutMs })
    await page.waitForTimeout(1800)
  } finally {
    await context.close()
  }

  const requestDetails = [
    ...counters.authMe.map((url) => `auth/me ${url}`),
    ...counters.adminMe.map((url) => `auth/admin/me ${url}`),
  ].join('\n')

  assert(
    counters.authMe.length === 0,
    `[zero-auth-probe] public-spa-navigation / -> /about: /auth/me expected 0, got ${counters.authMe.length}\n${requestDetails}`
  )
  assert(
    counters.adminMe.length === 0,
    `[zero-auth-probe] public-spa-navigation / -> /about: /auth/admin/me expected 0, got ${counters.adminMe.length}\n${requestDetails}`
  )

  return {
    id: 'public-spa-navigation',
    route: '/ -> /about',
    authMe: counters.authMe.length,
    adminMe: counters.adminMe.length,
  }
}

async function main() {
  const require = createRequire(import.meta.url)
  const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))
  const executablePath = resolveSystemChromiumExecutablePath()
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  })

  try {
    const tasks = [
      ...matrix.map((scenario) => ({
        id: scenario.id,
        run: () => runScenario(browser, scenario),
      })),
      {
        id: 'public-spa-navigation',
        run: () => runPublicNavigationScenario(browser),
      },
    ]
    const workers = resolveZeroAuthProbeWorkers({ taskCount: tasks.length })
    console.log(`[zero-auth-probe] scenarios=${tasks.length} workers=${workers}`)
    const results = await runZeroAuthProbeQueue(tasks, workers, (task) => task.run())

    for (const result of results) {
      console.log(`[zero-auth-probe] ok ${result.id} route=${result.route} authMe=${result.authMe} adminMe=${result.adminMe}`)
    }
  } finally {
    await browser.close()
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main().catch((error) => {
    console.error('[zero-auth-probe] fatal:', error instanceof Error ? error.message : String(error))
    if (error instanceof AggregateError) {
      error.errors.forEach((cause, index) => {
        console.error(`[zero-auth-probe] cause ${index + 1}:`, cause instanceof Error ? cause.stack ?? cause.message : String(cause))
      })
    }
    process.exit(1)
  })
}
