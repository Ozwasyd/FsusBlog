import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../../../tools/test-matrix/parse-matrix.mjs'
import {
  fixedArticlePrivatePreviewSpec,
  fixedArticlePrivatePreviewWorkerProfile,
  fixedPlaywrightArguments,
  runArticlePrivatePreview
} from './run-article-private-preview.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))
const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/article-private-preview.sh'), 'utf8')
const runner = fs.readFileSync(
  path.join(root, 'tests/frontend/checks/acceptance/run-article-private-preview.mjs'),
  'utf8'
)
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))

test('private preview owns one fixed package and Playwright leaf', () => {
  assert.equal(
    packageJson.scripts['check:article-private-preview'],
    'node ../../tests/frontend/checks/acceptance/run-article-private-preview.mjs'
  )
  assert.doesNotMatch(
    packageJson.scripts['check:spa:routes'],
    /article-private-preview\.spec\.ts/u
  )
  assert.equal(fixedArticlePrivatePreviewSpec, 'acceptance/article-private-preview.spec.ts')
  assert.equal(fixedArticlePrivatePreviewWorkerProfile, 'article-private-preview')
  assert.deepEqual(fixedPlaywrightArguments().slice(1), [
    'test',
    '--config=playwright.config.ts',
    '--workers=1',
    '--retries=0',
    'acceptance/article-private-preview.spec.ts'
  ])
  assert.match(runner, /resolve-playwright-workers\.mjs/u)
  assert.match(runner, /fixedArticlePrivatePreviewWorkerProfile/u)
  assert.throws(
    () => runArticlePrivatePreview({ args: ['acceptance/other.spec.ts'] }),
    /does not accept CLI arguments/u
  )
})

test('private preview lane owns debug services, fixture orchestration, and one session worker', () => {
  for (const token of [
    ['# fixture', '-catalog: consumer article-private-preview-lane matrix'].join(''),
    'RequireDebugStack',
    'FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"',
    'PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"',
    'FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1',
    'FSUSBLOG_TEST_SESSION_ISOLATION=1',
    'FSUSBLOG_PLAYWRIGHT_WORKERS=1',
    'InvokeLaneFixtureOrchestrator',
    'FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1',
    'npm run check:article-private-preview'
  ]) {
    assert.ok(lane.includes(token), `lane is missing ${token}`)
  }
  assert.doesNotMatch(lane, /npx playwright|document\.cookie|storageState|decodeAeds/u)
})

test('private preview matrix leaf is non-sharded and fixture-bound', () => {
  const tier = matrix.tiers.find((entry) => entry.id === 'article-private-preview')
  assert.ok(tier)
  assert.equal(tier.command, 'tools/test/lanes/article-private-preview.sh')
  assert.equal(tier.fixtureProfile, 'acceptance-representative')
  assert.deepEqual(tier.services, ['postgres', 'redis', 'backend', 'frontend'])
  assert.equal(tier.parallelizable, false)
  assert.equal(tier.maxParallel, 1)
  assert.equal(tier.shardable, false)
  assert.equal(tier.requiresPlaywright, 'chromium')
  assert.deepEqual(tier.exclusiveResources, ['playwright-session'])
  assert.deepEqual(tier.artifacts, ['src/frontend/test-results/playwright/article-private-preview'])
})
