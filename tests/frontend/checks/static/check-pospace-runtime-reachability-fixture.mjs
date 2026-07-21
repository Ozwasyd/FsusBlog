#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const checkerPath = path.join(repoRoot, 'tests/frontend/checks/static/check-pospace-runtime-reachability.mjs')
const sourcePaths = [
  'src/frontend/src/security/challenge-capability-registry.ts',
  'src/frontend/src/services/securityPoSpaceChallengeExecutor.ts',
  'src/frontend/src/services/securityPoSpaceClient.ts',
  'src/frontend/src/services/securityPoSpaceRuntime.ts',
  'src/frontend/src/workers/security/pospace.worker.ts',
  'src/frontend/src/components/security/FsusSecurityChallenge.vue',
  'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
  'src/frontend/src/composables/useNotification.ts'
]

const cases = [
  {
    name: 'missing component runtime edge',
    file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
    mutate: source => source.replace(
      "import('@/services/securityPoSpaceChallengeExecutor')",
      "import('@/services/unreachablePoSpaceChallengeExecutor')"
    ),
    expected: 'must keep the dynamic-import edge'
  },
  {
    name: 'type-only notification edge',
    file: 'src/frontend/src/composables/useNotification.ts',
    mutate: source => source.replace(
      /const \{ createPoSpaceChallengeExecutor \} = await import\(\s*'@\/services\/securityPoSpaceChallengeExecutor'\s*\)/u,
      'const createPoSpaceChallengeExecutor = injectedExecutorFactory'
    ),
    expected: 'must keep the dynamic-import edge'
  },
  {
    name: 'eager component executor regression',
    file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
    mutate: source => `${source}\nimport { createPoSpaceChallengeExecutor } from '@/services/securityPoSpaceChallengeExecutor'\n`,
    expected: 'must keep the PoSpace executor lazy'
  }
]

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_POSPACE_REACHABILITY_ROOT: root }
  })
}

function createFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pospace-reachability-'))
  for (const relative of sourcePaths) {
    const destination = path.join(root, relative)
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(path.join(repoRoot, relative), 'utf8'))
  }
  return root
}

for (const testCase of cases) {
  const root = createFixtureRoot()
  try {
    const target = path.join(root, testCase.file)
    const original = readFileSync(target, 'utf8')
    const mutated = testCase.mutate(original)
    assert.notEqual(mutated, original, `${testCase.name} fixture must alter its source`)
    writeFileSync(target, mutated)

    const result = runChecker(root)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.notEqual(result.status, 0, `${testCase.name} fixture must fail the reachability checker`)
    assert.match(output, new RegExp(testCase.expected, 'u'), `${testCase.name} must fail for the expected reason`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`[pospace-runtime-reachability-fixture] ok cases=${cases.length}`)
