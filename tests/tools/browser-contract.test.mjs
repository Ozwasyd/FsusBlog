import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BrowserContractFailure,
  browserContractReceiptSchema,
  browserContractScenarios,
  classifyBrowserContractFailure,
  createBrowserContractReceipt,
  selectBrowserContractScenarios
} from '../browser-contract/contract.mjs'
import {
  browserContractFixtureAdapterSchema,
  fixtureReceiptView,
  loadBrowserContractFixture
} from '../browser-contract/fixture.mjs'

const root = path.resolve(import.meta.dirname, '../..')

test('release browser contract exposes a six-scenario catalog with fixed serial metadata', () => {
  assert.equal(browserContractScenarios.length, 6)
  assert.equal(new Set(browserContractScenarios.map((scenario) => scenario.id)).size, 6)
  assert.deepEqual(browserContractScenarios.map((scenario) => scenario.capability), [
    'public-hydration',
    'account-session',
    'admin-session',
    'critical-write',
    'webauthn',
    'service-worker'
  ])
  assert.equal(browserContractScenarios.filter((scenario) => scenario.role === 'user').length, 2)
  assert.equal(browserContractScenarios.filter((scenario) => scenario.role === 'admin').length, 2)
})

test('immutable fixture capability selects five baseline scenarios or the sixth WebAuthn success path', () => {
  const baseline = selectBrowserContractScenarios({ webAuthnRegistration: false })
  const webAuthnReady = selectBrowserContractScenarios({ webAuthnRegistration: true })
  assert.equal(baseline.length, 5)
  assert.equal(baseline.some((scenario) => scenario.capability === 'webauthn'), false)
  assert.equal(webAuthnReady.length, 6)
  assert.equal(webAuthnReady.some((scenario) => scenario.capability === 'webauthn'), true)
})

test('receipt exposes one managed Chromium, zero retries, and exact scenario IDs', () => {
  const runIdentity = {
    runId: 'release-run-42',
    namespace: 'bc-aaaaaaaa-0123456789-abcdef',
    commit: 'a'.repeat(40),
    laneId: 'browser-contract'
  }
  const receipt = createBrowserContractReceipt({
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    build: { receiptContentDigest: `sha256:${'c'.repeat(64)}` },
    fixture: {
      namespace: runIdentity.namespace,
      lifecycle: {
        identity: runIdentity
      }
    },
    playwright: { chromiumRevision: '1234' }
  })
  receipt.topology.browserLaunchCount = 1
  receipt.topology.maxConcurrentBrowserRoots = 1
  receipt.topology.contextCount = browserContractScenarios.length

  assert.equal(receipt.schema, browserContractReceiptSchema)
  assert.equal(receipt.topology.runner, 'playwright-library')
  assert.equal(receipt.topology.managedBrowser, true)
  assert.equal(receipt.topology.workerPool, false)
  assert.equal(receipt.topology.shard, null)
  assert.equal(receipt.topology.retries, 0)
  assert.equal(receipt.topology.browserLaunchCount, 1)
  assert.equal(receipt.topology.maxConcurrentBrowserRoots, 1)
  assert.equal(receipt.topology.contextCount, 6)
  assert.deepEqual(receipt.runIdentity, runIdentity)
  assert.deepEqual(receipt.scenarios.map((scenario) => scenario.id), browserContractScenarios.map((scenario) => scenario.id))
})

test('failure classification keeps browser crashes separate from product and contract failures', () => {
  assert.equal(classifyBrowserContractFailure(new BrowserContractFailure('fixture missing', 'contract')), 'contract')
  assert.equal(classifyBrowserContractFailure(new BrowserContractFailure('publish request failed', 'product')), 'product')
  assert.equal(classifyBrowserContractFailure(new Error('Target page, context or browser has been closed')), 'infra')
  assert.equal(classifyBrowserContractFailure(new Error('ordinary assertion mismatch')), 'product')
})

test('fixture adapter consumes one immutable namespace without exposing infrastructure commands', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-'))
  context.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const authDirectory = path.join(directory, 'auth')
  await mkdir(authDirectory, { recursive: true })
  const encode = (value) => Buffer.from(String(value), 'utf8').toString('base64url')
  await writeFile(path.join(directory, 'public.aeds'), [
    `generatedAt\t${encode('2026-07-16T00:00:00.000Z')}`,
    `articleId\t${encode('17')}`,
    `articleTitle\t${encode('Contract article')}`,
    `categoryId\t${encode('3')}`
  ].join('\n'))
  await writeFile(path.join(authDirectory, 'auth-fixtures.json'), JSON.stringify({
    generatedAt: '2026-07-16T00:00:00.000Z',
    user: { id: 21, storageStateFile: 'user.storage-state.json' },
    admin: { id: 22, storageStateFile: 'admin.storage-state.json' }
  }))
  const storageState = JSON.stringify({
    cookies: [
      {
        name: '__Host-AccessToken',
        value: 'secure-token',
        url: 'https://127.0.0.1:27231',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Strict'
      },
      {
        name: 'AccessToken',
        value: 'portable-token',
        url: 'http://127.0.0.1:27231',
        path: '/',
        secure: false,
        httpOnly: true,
        sameSite: 'Lax'
      }
    ],
    origins: []
  })
  await writeFile(path.join(authDirectory, 'user.storage-state.json'), storageState)
  await writeFile(path.join(authDirectory, 'admin.storage-state.json'), storageState)

  const fixture = await loadBrowserContractFixture({
    repoRoot: root,
    env: {
      FSUSBLOG_FIXTURE_ROOT: directory,
      FSUSBLOG_TEST_NAMESPACE: 'contract-one',
      PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3000',
      FSUSBLOG_BASE_URL: 'http://127.0.0.1:7568'
    }
  })
  const view = fixtureReceiptView(fixture, root)
  assert.equal(fixture.schema, browserContractFixtureAdapterSchema)
  assert.equal(fixture.namespace, 'contract-one')
  assert.equal(fixture.publicArticle.id, '17')
  assert.equal(view.userId, 21)
  assert.equal(view.adminId, 22)
  assert.deepEqual(view.capabilities, { webAuthnRegistration: false })
  assert.equal('cookies' in view, false)
  assert.deepEqual(fixture.user.storageState.cookies, [{
    name: 'AccessToken',
    value: 'portable-token',
    url: 'http://127.0.0.1:3000',
    secure: false,
    httpOnly: true,
    sameSite: 'Lax'
  }])
})

test('runner source enforces one managed launch, one context factory, and process-group timeout', async () => {
  const [runner, scenarios, fixture, lifecycle, prepareFacade, defaultProvider, lane] = await Promise.all([
    readFile(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8'),
    readFile(path.join(root, 'tests/browser-contract/scenarios.mjs'), 'utf8'),
    readFile(path.join(root, 'tests/browser-contract/fixture.mjs'), 'utf8'),
    readFile(path.join(root, 'tests/browser-contract/fixture-lifecycle.mjs'), 'utf8'),
    readFile(path.join(root, 'tests/browser-contract/prepare-fixture.mjs'), 'utf8'),
    readFile(path.join(root, 'tests/browser-contract/default-fixture-provider.mjs'), 'utf8'),
    readFile(path.join(root, 'tools/test/lanes/browser-contract.sh'), 'utf8')
  ])

  assert.equal((runner.match(/managed\.chromium\.launch\(/gu) ?? []).length, 1)
  assert.equal((runner.match(/browser\.newContext\(/gu) ?? []).length, 1)
  assert.match(runner, /browser\.on\('disconnected'/u)
  assert.match(runner, /verifyProductionBuildReceipt/u)
  assert.match(runner, /productFailures\.push/u)
  assert.match(runner, /scenarioReceipt\.classification === 'product'/u)
  assert.doesNotMatch(runner, /max(?:imum)?[-_ ]?(?:errors|failures)|failFast/iu)
  assert.doesNotMatch(runner, /executablePath\s*:|system-chromium|resolveSystemChromium/u)
  assert.doesNotMatch(runner, /os\.(?:loadavg|freemem)|resolve-playwright-workers|FSUSBLOG_PLAYWRIGHT_WORKERS|TEST_PARALLEL_INDEX/u)
  assert.doesNotMatch(`${scenarios}\n${fixture}`, /node:child_process|\bdocker\b|\bpsql\b|\bredis-cli\b/u)
  assert.match(lane, /timeout --signal=TERM --kill-after=15s/u)
  assert.match(lane, /CONTRACT_TIMEOUT="\$\{FSUSBLOG_BROWSER_CONTRACT_TIMEOUT:-9m\}"/u)
  assert.match(lane, /FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER[^\n]+default-fixture-provider\.mjs/u)
  assert.doesNotMatch(lane, /npx\s+playwright\s+test|--workers|--shard/u)
  assert.match(lifecycle, /detached:\s*process\.platform !== 'win32'/u)
  assert.match(lifecycle, /process\.kill\(-child\.pid, signalName\)/u)
  assert.match(lifecycle, /FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID/u)
  assert.match(lifecycle, /providerProcessGroupIsOwned/u)
  assert.match(lifecycle, /terminate\('SIGKILL'\)[\s\S]{0,80}\}, 750/u)
  assert.match(lifecycle, /FSUSBLOG_BROWSER_CONTRACT_PROVIDER_TIMEOUT_MS/u)
  assert.match(lifecycle, /FSUSBLOG_BROWSER_CONTRACT_CLEANUP_TIMEOUT_MS/u)
  assert.match(lifecycle, /\? 10_000 : 30_000/u)
  assert.match(prepareFacade, /export async function prepareSingleBrowserContractFixture/u)
  assert.match(prepareFacade, /export async function cleanupSingleBrowserContractFixture/u)
  assert.doesNotMatch(prepareFacade, /isMain|process\.argv|pathToFileURL|#!\/usr\/bin\/env/u)
  assert.match(defaultProvider, /testSessionHeader:\s*false/u)
  assert.match(defaultProvider, /databaseSchema !== 'public'/u)
  assert.match(defaultProvider, /databaseInstance !== `fsusblog-test-postgres-\$\{namespace\}`/u)
  assert.match(defaultProvider, /redisInstance !== `fsusblog-test-redis-\$\{namespace\}`/u)
  assert.match(defaultProvider, /FSUSBLOG_PLAYWRIGHT_WORKERS:\s*'1'/u)
  assert.match(defaultProvider, /FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY:\s*'1'/u)
  assert.match(defaultProvider, /FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:\s*'1'/u)
  assert.match(defaultProvider, /FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:\s*request\.preparation\.id/u)
  assert.match(defaultProvider, /io\.fsusblog\.test\.preparation-id/u)
  assert.match(defaultProvider, /phase:\s*'preparing'/u)
  assert.match(defaultProvider, /phase:\s*'prepared'/u)
  assert.match(defaultProvider, /now\(\),\s*(?:NULL,\s*)?'zk_anonymous'/u)
  assert.match(defaultProvider, /retainedRuntimeState/u)
  assert.doesNotMatch(defaultProvider, /os\.(?:loadavg|freemem)|FSUSBLOG_POSTGRES_PID_HEADROOM/u)
  assert.match(runner, /extraHTTPHeaders:\s*fixture\.testSession\s*\?\s*\{ 'X-Fsus-Test-Session': fixture\.testSession \}\s*:\s*(?:undefined|\{\})/u)
  assert.match(runner, /writeBrowserContractReceipt\(receiptFile, receipt\)/u)
  assert.match(runner, /async function resetRunOutput\(\)[\s\S]+await rm\(ownedReceiptFile, \{ force: true \}\)/u)
  assert.doesNotMatch(runner, /rm\(ownedOutputRoot, \{ recursive: true, force: true \}\)/u)
  assert.match(runner, /path\.join\(outputRoot, 'runs', preparedFixture\.identity\.namespace\)/u)
  assert.ok(
    runner.indexOf('const sourceState = expectedSourceState()') < runner.indexOf('await resetRunOutput()'),
    'complete current source identity must be admitted before the fixed receipt can be touched'
  )
  assert.ok(
    runner.indexOf('await resetRunOutput()') < runner.indexOf('const build = await verifyImmutableBuild(sourceState)'),
    'the fixed receipt must be removed before current-run build and fixture admission'
  )
  assert.match(runner, /expectedSourceState:\s*sourceState/u)
  assert.doesNotMatch(runner, /process\.env\.GITHUB_SHA|return null/u)
  assert.match(lane, /FSUSBLOG_TEST_SOURCE_COMMIT/u)
  assert.match(lane, /FSUSBLOG_TEST_SOURCE_FINGERPRINT/u)
  assert.ok(
    runner.indexOf('await writeBrowserContractReceipt(receiptFile, runningReceipt)')
      < runner.indexOf('preparedFixture = await prepareSingleBrowserContractFixture({'),
    'the current run-scoped running receipt must replace stale evidence before fixture preparation'
  )
  assert.match(runner, /const fallbackFixture = \{[\s\S]+createBrowserContractReceipt\(\{[\s\S]+fixture: fallbackFixture/u)
  assert.doesNotMatch(runner, /fallback\.fixture\s*=/u)
  assert.match(lifecycle, /preparedFixture:\s*prepared/u)
  assert.match(lifecycle, /cleanup\.resources\s*=\s*freshCleanupResources\(prepared\)/u)
  assert.match(runner, /startupPreparedFixture\s*=\s*preparedFixture\s*\?\?\s*error\?\.preparedFixture/u)
  assert.match(runner, /cleanup\?\.status === 'failure'[\s\S]+startup-failure-retry/u)
  assert.match(runner, /cleanupAttempts\.push\(snapshotReceiptEvidence\(cleanup\)\)/u)
  assert.ok(
    runner.indexOf('const primaryError = serializeBrowserContractError(error)')
      < runner.indexOf("reason: receivedSignal ? `signal:${receivedSignal}:retry` : 'startup-failure-retry'"),
    'the primary startup failure must be captured before cleanup retry evidence'
  )
})
