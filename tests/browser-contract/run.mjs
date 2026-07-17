#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'
import {
  BrowserContractFailure,
  browserContractScenarios,
  classifyBrowserContractFailure,
  createBrowserContractReceipt,
  selectBrowserContractScenarios,
  serializeBrowserContractError,
  writeBrowserContractReceipt
} from './contract.mjs'
import { fixtureReceiptView, loadBrowserContractFixture } from './fixture.mjs'
import {
  browserContractAppReadyTimeoutMs,
  browserContractScenarioRunners,
  createPageAudit
} from './scenarios.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const frontendRoot = path.join(root, 'src/frontend')
const outputRoot = path.resolve(process.env.FSUSBLOG_BROWSER_CONTRACT_OUTPUT || path.join(root, '.tmp/browser-contract'))
const receiptFile = path.resolve(process.env.FSUSBLOG_BROWSER_CONTRACT_RECEIPT || path.join(outputRoot, 'receipt.json'))
const traceRoot = path.join(outputRoot, 'traces')
const screenshotRoot = path.join(outputRoot, 'screenshots')
const buildReceiptFile = path.resolve(
  process.env.FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT || path.join(root, '.tmp/ci-production-build/receipt.json')
)
const startedAtMs = Date.now()
const require = createRequire(import.meta.url)

let browser = null
let browserDisconnected = false
let closingBrowser = false
let receivedSignal = null
let activeScenario = null

function relative(value) {
  return path.relative(root, value).replaceAll(path.sep, '/')
}

function expectedSourceState() {
  const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT || process.env.GITHUB_SHA || '').trim()
  const worktreeFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT || '').trim()
  if (!commit && !worktreeFingerprint) return null
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint)) {
    throw new BrowserContractFailure('browser contract source identity environment is incomplete', 'contract')
  }
  return { commit, worktreeFingerprint }
}

async function verifyImmutableBuild() {
  if (!existsSync(buildReceiptFile)) {
    throw new BrowserContractFailure(`immutable production build receipt is missing: ${relative(buildReceiptFile)}`, 'contract')
  }
  const result = verifyProductionBuildReceipt({
    artifactRoot: path.dirname(buildReceiptFile),
    receiptFile: path.basename(buildReceiptFile),
    expectedSourceState: expectedSourceState()
  })
  const requiredDomains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm']
  const domains = new Set(result.receipt.domains.map((domain) => domain.name))
  const missingDomains = requiredDomains.filter((domain) => !domains.has(domain))
  if (missingDomains.length > 0) {
    throw new BrowserContractFailure(
      `immutable production build is missing browser contract domains: ${missingDomains.join(', ')}`,
      'contract'
    )
  }
  return {
    receipt: relative(buildReceiptFile),
    receiptContentDigest: result.receipt.contentDigest,
    sourceState: result.receipt.sourceState,
    profile: result.receipt.build?.profile ?? null,
    domains: requiredDomains,
    artifactCount: result.evidence.artifactCount,
    artifactBytes: result.evidence.artifactBytes,
    verifiedAt: result.evidence.verifiedAt
  }
}

async function loadManagedPlaywright() {
  const packageFile = require.resolve('@playwright/test/package.json', { paths: [frontendRoot] })
  const moduleFile = require.resolve('@playwright/test', { paths: [frontendRoot] })
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'))
  const playwright = require(moduleFile)
  const executablePath = playwright.chromium.executablePath()
  const revisionMatch = executablePath.match(/(?:chromium|chromium_headless_shell)-(\d+)/u)
  return {
    chromium: playwright.chromium,
    metadata: {
      package: '@playwright/test',
      version: String(packageJson.version ?? 'unknown'),
      chromiumRevision: revisionMatch?.[1] ?? path.basename(path.dirname(executablePath)),
      executableName: path.basename(executablePath),
      managedExecutable: true
    }
  }
}

function contextOptions(scenario, fixture) {
  const storageState = scenario.role === 'user'
    ? fixture.user.storageState
    : scenario.role === 'admin' ? fixture.admin.storageState : undefined
  return {
    baseURL: fixture.baseUrl,
    ...(storageState ? { storageState } : {}),
    serviceWorkers: scenario.serviceWorkers,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    locale: 'zh-CN',
    userAgent: `FsusBlog-Release-Browser-Contract/${scenario.id}`,
    extraHTTPHeaders: fixture.testSession
      ? { 'X-Fsus-Test-Session': fixture.testSession }
      : {}
  }
}

async function captureFailureScreenshot(page, scenarioId) {
  const file = path.join(screenshotRoot, `${scenarioId}.png`)
  await mkdir(path.dirname(file), { recursive: true })
  await page.screenshot({ path: file, fullPage: false, timeout: 5_000 })
  return relative(file)
}

function requestTermination(signal) {
  if (receivedSignal) return
  receivedSignal = signal
  browserDisconnected = true
  browser?.close().catch(() => {})
}

process.once('SIGTERM', () => requestTermination('SIGTERM'))
process.once('SIGINT', () => requestTermination('SIGINT'))

async function main() {
  await mkdir(traceRoot, { recursive: true })
  await mkdir(screenshotRoot, { recursive: true })
  const build = await verifyImmutableBuild()
  const fixture = await loadBrowserContractFixture({ repoRoot: root })
  const selectedScenarios = selectBrowserContractScenarios(fixture.capabilities)
  const managed = await loadManagedPlaywright()
  const receipt = createBrowserContractReceipt({
    sourceState: build.sourceState,
    build,
    fixture: fixtureReceiptView(fixture, root),
    playwright: managed.metadata,
    scenarios: selectedScenarios
  })
  const productFailures = []

  try {
    receipt.topology.browserLaunchCount = 1
    browser = await managed.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    })
    receipt.topology.maxConcurrentBrowserRoots = 1
    receipt.playwright.chromiumVersion = browser.version()
    browser.on('disconnected', () => {
      if (!closingBrowser) browserDisconnected = true
    })

    for (const scenario of selectedScenarios) {
      if (receivedSignal) {
        throw new BrowserContractFailure(`browser contract terminated by ${receivedSignal}`, 'infra')
      }
      const runner = browserContractScenarioRunners[scenario.id]
      if (typeof runner !== 'function') {
        throw new BrowserContractFailure(`browser contract scenario runner is missing: ${scenario.id}`, 'contract')
      }

      const scenarioReceipt = receipt.scenarios.find((entry) => entry.id === scenario.id)
      const scenarioStartedAtMs = Date.now()
      scenarioReceipt.status = 'running'
      scenarioReceipt.startedAt = new Date(scenarioStartedAtMs).toISOString()
      activeScenario = scenarioReceipt
      let context = null
      let page = null
      let audit = null
      const traceFile = path.join(traceRoot, `${scenario.id}.zip`)
      try {
        context = await browser.newContext(contextOptions(scenario, fixture))
        receipt.topology.contextCount += 1
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false, title: scenario.id })
        page = await context.newPage()
        page.setDefaultTimeout(browserContractAppReadyTimeoutMs)
        page.setDefaultNavigationTimeout(browserContractAppReadyTimeoutMs)
        audit = createPageAudit(page)
        await runner({ browser, context, page, fixture, audit, scenario, outputRoot })
        if (browserDisconnected) {
          throw new BrowserContractFailure('Chromium disconnected during the release browser contract', 'infra')
        }
        scenarioReceipt.status = 'success'
        scenarioReceipt.classification = 'clean'
      } catch (error) {
        scenarioReceipt.status = 'failure'
        scenarioReceipt.classification = classifyBrowserContractFailure(error, { browserDisconnected })
        scenarioReceipt.error = {
          ...serializeBrowserContractError(error),
          failureClass: scenarioReceipt.classification
        }
        if (page && !page.isClosed()) {
          const screenshot = await captureFailureScreenshot(page, scenario.id).catch(() => null)
          if (screenshot) scenarioReceipt.artifacts.push(screenshot)
        }
        if (scenarioReceipt.classification === 'product') {
          productFailures.push({
            scenario: scenario.id,
            error: scenarioReceipt.error
          })
        } else {
          throw error
        }
      } finally {
        scenarioReceipt.issues = audit?.issues ?? []
        if (context) {
          const traced = await context.tracing.stop({ path: traceFile }).then(() => true).catch(() => false)
          if (traced) scenarioReceipt.artifacts.push(relative(traceFile))
          await context.close().catch(() => {})
        }
        scenarioReceipt.finishedAt = new Date().toISOString()
        scenarioReceipt.durationMs = Date.now() - scenarioStartedAtMs
        activeScenario = null
      }
    }

    if (productFailures.length > 0) {
      throw new BrowserContractFailure(
        `${productFailures.length} browser contract product scenario(s) failed`,
        'product',
        { failures: productFailures }
      )
    }

    closingBrowser = true
    await browser.close()
    browser = null
    if (browserDisconnected && !receivedSignal) {
      throw new BrowserContractFailure('Chromium disconnected before contract completion', 'infra')
    }
    receipt.status = 'success'
    receipt.classification = 'clean'
    return receipt
  } catch (error) {
    receipt.status = 'failure'
    receipt.classification = classifyBrowserContractFailure(error, { browserDisconnected })
    receipt.error = {
      ...serializeBrowserContractError(error),
      failureClass: receipt.classification,
      activeScenario: activeScenario?.id ?? null,
      signal: receivedSignal
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { receipt })
  } finally {
    if (browser) {
      closingBrowser = true
      await browser.close().catch(() => {})
      browser = null
    }
    receipt.finishedAt = new Date().toISOString()
    receipt.wallClockMs = Date.now() - startedAtMs
    await writeBrowserContractReceipt(receiptFile, receipt)
  }
}

main()
  .then((receipt) => {
    console.log(
      `[browser-contract] ok scenarios=${receipt.scenarios.length} browserLaunches=${receipt.topology.browserLaunchCount} contexts=${receipt.topology.contextCount} wallMs=${receipt.wallClockMs} receipt=${relative(receiptFile)}`
    )
  })
  .catch(async (error) => {
    const receipt = error?.receipt
    if (!receipt) {
      const fallback = createBrowserContractReceipt({ startedAt: new Date(startedAtMs).toISOString() })
      fallback.status = 'failure'
      fallback.classification = classifyBrowserContractFailure(error, { browserDisconnected })
      fallback.error = {
        ...serializeBrowserContractError(error),
        failureClass: fallback.classification,
        signal: receivedSignal
      }
      fallback.finishedAt = new Date().toISOString()
      fallback.wallClockMs = Date.now() - startedAtMs
      await writeBrowserContractReceipt(receiptFile, fallback).catch(() => {})
    }
    console.error(`[browser-contract] ${classifyBrowserContractFailure(error, { browserDisconnected })} failure: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
