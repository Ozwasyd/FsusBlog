#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { encodeAedsFrame } from '../../support/aeds-envelope.mjs'
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs'
import {
  remainingRuntimeTimeout,
  resolveRuntimeBrowserTimeoutPlan
} from '../../support/runtime-browser-timeout.mjs'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

const baseUrl = (
  process.env.PLAYWRIGHT_BASE_URL
  || process.env.FSUSBLOG_PUBLIC_BASE_URL
  || process.env.FSUSBLOG_BASE_URL
  || 'http://127.0.0.1:3000'
).replace(/\/+$/u, '')
const executablePath = resolveSystemChromiumExecutablePath()
const publicFixtureIds = readPublicFixtureIds()
const timeoutPlan = resolveRuntimeBrowserTimeoutPlan()
const runtimeDeadlineAtMs = Date.now() + timeoutPlan.stepDeadlineMs

function navigationTimeoutMs() {
  return remainingRuntimeTimeout(runtimeDeadlineAtMs, timeoutPlan.navigationTimeoutMs)
}

function requestTimeoutMs() {
  return remainingRuntimeTimeout(runtimeDeadlineAtMs, timeoutPlan.requestTimeoutMs)
}

async function gotoRuntime(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs() })
  await page.waitForSelector('#app', { state: 'attached', timeout: navigationTimeoutMs() })
  await page.waitForFunction(() => document.readyState === 'complete', undefined, {
    timeout: navigationTimeoutMs()
  })
  // Vite can replace the initial execution context immediately after
  // domcontentloaded while its client reconnects. Settle that bounded startup
  // edge before importing modules whose PoW side effects are counted exactly.
  await page.waitForTimeout(250)
}

const POW_CHALLENGE_PATTERN = /\/api\/binary\/auth\/pow-challenge(?:[?#]|$)/u
const AUTH_ME_PATTERN = /\/api\/binary\/auth\/me(?:[?#]|$)/u
const ADMIN_ME_PATTERN = /\/api\/binary\/auth\/admin\/me(?:[?#]|$)/u
const NOTIFICATION_STREAM_PATTERN = /\/api\/notifications\/stream(?:\/preflight)?(?:[?#]|$)/u
const PREEMPT_PATTERNS = [
  /触发物理抢占/u,
  /PREEMPTED_BY_NEW_TASK/u,
]
const WORKER_INIT_PATTERN = /WASM Module \(/u
const MAIN_WORKER_INIT_PATTERN = /WASM Module \(.* role=main/u
const FRAME_POW_CHALLENGE = 30

function writeFixedUtf8(target, offset, length, value) {
  const encoded = new TextEncoder().encode(value)
  target.fill(0, offset, offset + length)
  target.set(encoded.slice(0, length), offset)
}

function createDeterministicPowChallengeFrame() {
  const payload = new Uint8Array(204)
  const view = new DataView(payload.buffer)
  writeFixedUtf8(payload, 0, 64, `runtime-pow-${Date.now()}`)
  view.setInt32(64, 1, true)
  view.setBigInt64(68, BigInt(Math.floor(Date.now() / 1000)), true)
  writeFixedUtf8(payload, 76, 128, 'runtime-pow-signature')
  return Buffer.from(encodeAedsFrame(FRAME_POW_CHALLENGE, payload))
}

const scenarios = [
  {
    id: 'public-home-first-paint',
    route: '/',
    action: async (page) => {
      await gotoRuntime(page, `${baseUrl}/`)
      await page.waitForTimeout(1200)
    },
    maxPowChallenges: 0,
    maxWorkerInits: 0,
    maxPreemptLogs: 0,
  },
  {
    id: 'public-article-first-paint',
    route: `/article/${publicFixtureIds.articleId}`,
    action: async (page) => {
      await gotoRuntime(page, `${baseUrl}/article/${publicFixtureIds.articleId}`)
      await page.waitForTimeout(1200)
    },
    maxPowChallenges: 0,
    maxWorkerInits: 0,
    maxPreemptLogs: 0,
  },
  {
    id: 'public-read-wrappers',
    route: `/article/${publicFixtureIds.articleId}`,
    action: async (page) => {
      await gotoRuntime(page, `${baseUrl}/article/${publicFixtureIds.articleId}`)
      await page.evaluate(async ({ articleId }) => {
        const [{ getComments, getThreadReplies }, { getRelatedReading }] = await Promise.all([
          import('/src/api/comment.ts'),
          import('/src/api/article.ts'),
        ])
        await Promise.allSettled([
          getComments(articleId, null, 2),
          getThreadReplies(articleId, '1', null, 2),
          getRelatedReading(articleId),
        ])
      }, { articleId: publicFixtureIds.articleId })
      await page.waitForTimeout(400)
    },
    maxPowChallenges: 0,
    maxWorkerInits: 0,
    maxPreemptLogs: 0,
  },
  {
    id: 'public-guest-stream-first-preflight-pow',
    route: '/',
    action: async (page) => {
      const notificationStreamRequest = page.waitForRequest(
        (request) => NOTIFICATION_STREAM_PATTERN.test(request.url()),
        { timeout: requestTimeoutMs() }
      )
      await gotoRuntime(page, `${baseUrl}/`)
      await notificationStreamRequest
    },
    minNotificationStreamRequests: 1,
    minPowChallenges: 1,
    maxPowChallenges: 1,
    maxWorkerInits: 1,
    maxPreemptLogs: 0,
  },
  {
    id: 'single-pow-header-build',
    route: '/',
    action: async (page) => {
      await gotoRuntime(page, `${baseUrl}/`)
      await page.evaluate(async () => {
        const { buildBinaryPowHeaders } = await import('/src/api/binaryApiClient.ts')
        await buildBinaryPowHeaders(undefined, `pow-runtime-single-${Date.now()}`)
      })
    },
    minPowChallenges: 1,
    maxWorkerInits: 1,
    maxPreemptLogs: 0,
  },
  {
    id: 'concurrent-fresh-pow-header-builds',
    route: '/',
    action: async (page) => {
      await gotoRuntime(page, `${baseUrl}/`)
      await page.evaluate(async () => {
        const { buildBinaryPowHeaders } = await import('/src/api/binaryApiClient.ts')
        const scope = `pow-runtime-concurrent-${Date.now()}`
        await Promise.all([
          buildBinaryPowHeaders(undefined, scope),
          buildBinaryPowHeaders(undefined, scope),
        ])
      })
    },
    minPowChallenges: 2,
    maxPowChallenges: 2,
    maxWorkerInits: 1,
    maxPreemptLogs: 0,
  },
  {
    id: 'concurrent-worker-calculations',
    route: '/',
    action: async (page) => {
      await gotoRuntime(page, `${baseUrl}/`)
      await page.evaluate(async () => {
        const { usePow } = await import('/src/composables/usePow.ts')
        const pow = usePow()
        await Promise.all([
          pow.calculate(`runtime-a-${Date.now()}`, 'pow-runtime-browser', 1),
          pow.calculate(`runtime-b-${Date.now()}`, 'pow-runtime-browser', 1),
        ])
      })
    },
    maxWorkerInits: 1,
    maxPreemptLogs: 0,
  },
  {
    id: 'abort-pow-header-build',
    route: '/',
    action: async (page) => {
      await gotoRuntime(page, `${baseUrl}/`)
      await page.evaluate(async () => {
        const { buildBinaryPowHeaders } = await import('/src/api/binaryApiClient.ts')
        const controller = new AbortController()
        const promise = buildBinaryPowHeaders(controller.signal, `pow-runtime-abort-${Date.now()}`)
        controller.abort()
        await promise.catch((error) => {
          if (!['AbortError', 'PowAbortError'].includes(error?.name)) {
            throw error
          }
        })
      })
    },
    maxPowChallenges: 1,
    maxWorkerInits: 1,
    maxPreemptLogs: 0,
  },
]

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function runScenario(browser, scenario) {
  const counters = {
    powChallenges: [],
    authMeRequests: [],
    adminMeRequests: [],
    notificationStreamRequests: [],
    workerInitLogs: [],
    preemptLogs: [],
    consoleMessages: [],
  }
  const recordNotificationStreamRequest = (url) => {
    if (!NOTIFICATION_STREAM_PATTERN.test(url)) {
      return
    }

    if (!counters.notificationStreamRequests.includes(url)) {
      counters.notificationStreamRequests.push(url)
    }
  }
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      configurable: true,
      get: () => 1,
    })
  })
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (POW_CHALLENGE_PATTERN.test(url)) {
      counters.powChallenges.push(url)
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: createDeterministicPowChallengeFrame(),
      })
      return
    }
    if (AUTH_ME_PATTERN.test(url)) {
      counters.authMeRequests.push(url)
    }
    if (ADMIN_ME_PATTERN.test(url)) {
      counters.adminMeRequests.push(url)
    }
    recordNotificationStreamRequest(url)
    await route.continue()
  })

  const page = await context.newPage()
  page.on('request', (request) => {
    recordNotificationStreamRequest(request.url())
  })
  page.on('console', (message) => {
    const text = message.text()
    counters.consoleMessages.push(text)
    if (WORKER_INIT_PATTERN.test(text) && MAIN_WORKER_INIT_PATTERN.test(text)) {
      counters.workerInitLogs.push(text)
    }
    if (PREEMPT_PATTERNS.some((pattern) => pattern.test(text))) {
      counters.preemptLogs.push(text)
    }
  })

  try {
    try {
      await scenario.action(page)
    } catch (error) {
      const requestDetails = [
        ...counters.powChallenges.map((url) => `pow-challenge ${url}`),
        ...counters.authMeRequests.map((url) => `auth-me ${url}`),
        ...counters.adminMeRequests.map((url) => `admin-me ${url}`),
        ...counters.notificationStreamRequests.map((url) => `notification-stream ${url}`),
      ].join('\n')
      const consoleDetails = counters.consoleMessages.slice(-12).join('\n')
      throw new Error(
        `[pow-runtime] ${scenario.id} route=${scenario.route}: action failed: ${error instanceof Error ? error.message : String(error)}\n${requestDetails}\n${consoleDetails}`
      )
    }
  } finally {
    await context.close()
  }

  const requestDetails = [
    ...counters.powChallenges.map((url) => `pow-challenge ${url}`),
    ...counters.authMeRequests.map((url) => `auth-me ${url}`),
    ...counters.adminMeRequests.map((url) => `admin-me ${url}`),
    ...counters.notificationStreamRequests.map((url) => `notification-stream ${url}`),
  ].join('\n')
  const consoleDetails = counters.consoleMessages.slice(-12).join('\n')
  const prefix = `[pow-runtime] ${scenario.id} route=${scenario.route}`
  if (scenario.minPowChallenges !== undefined) {
    assert(
      counters.powChallenges.length >= scenario.minPowChallenges,
      `${prefix}: pow-challenge expected >= ${scenario.minPowChallenges}, got ${counters.powChallenges.length}\n${requestDetails}\n${consoleDetails}`
    )
  }
  if (scenario.maxPowChallenges !== undefined) {
    assert(
      counters.powChallenges.length <= scenario.maxPowChallenges,
      `${prefix}: pow-challenge expected <= ${scenario.maxPowChallenges}, got ${counters.powChallenges.length}\n${requestDetails}\n${consoleDetails}`
    )
  }
  if (scenario.minNotificationStreamRequests !== undefined) {
    assert(
      counters.notificationStreamRequests.length >= scenario.minNotificationStreamRequests,
      `${prefix}: notification stream requests expected >= ${scenario.minNotificationStreamRequests}, got ${counters.notificationStreamRequests.length}\n${requestDetails}\n${consoleDetails}`
    )
  }
  assert(
    counters.authMeRequests.length === 0,
    `${prefix}: public/runtime matrix must not call account auth probe, got ${counters.authMeRequests.length}\n${requestDetails}\n${consoleDetails}`
  )
  assert(
    counters.adminMeRequests.length === 0,
    `${prefix}: public/runtime matrix must not call admin auth probe, got ${counters.adminMeRequests.length}\n${requestDetails}\n${consoleDetails}`
  )
  assert(
    counters.workerInitLogs.length <= scenario.maxWorkerInits,
    `${prefix}: worker init expected <= ${scenario.maxWorkerInits}, got ${counters.workerInitLogs.length}\n${requestDetails}\n${consoleDetails}`
  )
  assert(
    counters.preemptLogs.length <= scenario.maxPreemptLogs,
    `${prefix}: preempt logs expected <= ${scenario.maxPreemptLogs}, got ${counters.preemptLogs.length}\n${requestDetails}\n${consoleDetails}`
  )

  return {
    id: scenario.id,
    route: scenario.route,
    powChallenges: counters.powChallenges.length,
    notificationStreamRequests: counters.notificationStreamRequests.length,
    workerInits: counters.workerInitLogs.length,
    preemptLogs: counters.preemptLogs.length,
  }
}

async function main() {
  console.log(`[pow-runtime] timeoutPlan=${JSON.stringify(timeoutPlan)}`)
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  })

  try {
    const results = []
    for (const scenario of scenarios) {
      results.push(await runScenario(browser, scenario))
    }
    for (const result of results) {
      console.log(`[pow-runtime] ok ${result.id} route=${result.route} powChallenges=${result.powChallenges} notificationStreamRequests=${result.notificationStreamRequests} workerInits=${result.workerInits} preemptLogs=${result.preemptLogs}`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[pow-runtime] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
