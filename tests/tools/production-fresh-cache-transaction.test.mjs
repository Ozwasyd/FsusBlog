import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cleanLocalProductionOutputs } from '../../tools/test-matrix/fresh-production.mjs'
import {
  createProductionFreshOutputRoot,
  outputPath,
  sealTerminalProductionFreshOutputs,
  verifyTerminalProductionFreshOutputs
} from '../../tools/test-matrix/production-fresh-run-bound-outputs.mjs'
import {
  productionFreshCacheEntries,
  productionFreshCacheTransactionSchema,
  runProductionFreshCacheTransaction
} from '../../tools/test-matrix/production-fresh-cache-transaction.mjs'

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cache-transaction-'))
  fs.mkdirSync(path.join(root, '.git'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function ownerIdentity(root, suffix = 'owner') {
  return {
    leaseId: `lease-${suffix}`,
    ownerToken: `token-${suffix}`,
    canonicalRepositoryRoot: fs.realpathSync(root),
    profile: 'production-fresh',
    candidateIdentityDigest: sha256(`candidate-${suffix}`),
    pid: process.pid,
    processStartIdentity: `start-${suffix}`,
    executableDigest: sha256('node'),
    commandDigest: sha256(`command-${suffix}`),
    processGroupOrJobIdentity: { kind: 'unix-process-group', processGroupId: process.pid }
  }
}

function writeCache(root, relativePath, content = relativePath) {
  const file = path.join(root, '.tmp', relativePath, 'nested', 'cache.bin')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function removeFreshRoot(sourceRoot, { protectedPaths = [] } = {}) {
  const protectedSet = new Set(protectedPaths.map((candidate) => path.resolve(candidate)))
  if (protectedSet.size === 0) {
    fs.rmSync(sourceRoot, { recursive: true, force: true })
    return
  }
  for (const name of fs.readdirSync(sourceRoot)) {
    const candidate = path.join(sourceRoot, name)
    if (protectedSet.has(path.resolve(candidate))) continue
    fs.rmSync(candidate, { recursive: true, force: true })
  }
}

test('cache transaction journals outside .tmp and durably restores only the fixed cache allowlist', (t) => {
  const root = fixtureRoot(t)
  const cacheFiles = productionFreshCacheEntries.map((entry) => (
    writeCache(root, entry.relativePath, entry.logicalCacheId)
  ))
  const correctnessOutputs = [
    path.join(root, '.tmp/coverage/backend/production/coverage.json'),
    path.join(root, '.tmp/local-production/summary.json'),
    path.join(root, '.tmp/test-results/result.trx')
  ]
  for (const file of correctnessOutputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'must-not-survive')
  }
  fs.chmodSync(path.dirname(cacheFiles[0]), 0o750)
  fs.chmodSync(cacheFiles[0], 0o640)

  const result = runProductionFreshCacheTransaction(root, {
    runId: 'fresh-cache-transaction',
    ownerIdentity: ownerIdentity(root),
    removeFreshRoot
  })

  assert.equal(result.state, 'committed')
  assert.equal(result.receipt.schema, productionFreshCacheTransactionSchema)
  assert.equal(result.receipt.entries.length, productionFreshCacheEntries.length)
  assert.deepEqual(
    result.receipt.entries.map((entry) => entry.logicalCacheId),
    productionFreshCacheEntries.map((entry) => entry.logicalCacheId)
  )
  assert.equal(result.journalFile.startsWith(`${path.join(root, '.git')}${path.sep}`), true)
  assert.equal(result.journalFile.startsWith(`${path.join(root, '.tmp')}${path.sep}`), false)
  assert.equal(result.receipt.actions.some((action) => action.type === 'evacuate'), true)
  assert.equal(result.receipt.actions.some((action) => action.type === 'restore'), true)
  for (const file of cacheFiles) assert.equal(fs.readFileSync(file, 'utf8').length > 0, true)
  for (const file of correctnessOutputs) assert.equal(fs.existsSync(file), false)
  assert.equal(fs.statSync(path.dirname(cacheFiles[0])).mode & 0o7777, 0o750)
  assert.equal(fs.statSync(cacheFiles[0]).mode & 0o7777, 0o640)
  const holdingBase = path.join(root, '.fsusblog-production-fresh-cache-holding')
  assert.equal(
    fs.existsSync(holdingBase) &&
      fs.readdirSync(holdingBase, { recursive: true }).some((entry) => entry === result.transactionId),
    false
  )
})

test('local cleanup never registers correctness outputs as preserved cache entries', (t) => {
  const root = fixtureRoot(t)
  writeCache(root, 'dependency-cache/dotnet', 'dependency')
  const correctnessFiles = [
    '.tmp/coverage/backend/production/coverage.json',
    '.tmp/local-production/summary.json',
    'src/frontend/coverage/unit/result.json',
    'src/frontend/test-results/result.json'
  ]
  for (const relativePath of correctnessFiles) {
    const file = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'correctness')
  }

  const cleanup = cleanLocalProductionOutputs(root, {
    runId: 'fresh-cleanup',
    ownerIdentity: ownerIdentity(root, 'cleanup')
  })
  const journal = JSON.parse(fs.readFileSync(cleanup.cacheTransaction.journalFile, 'utf8'))

  assert.deepEqual(journal.entries.map((entry) => entry.logicalCacheId), ['dependencies'])
  assert.deepEqual(cleanup.preservedRoots, ['.tmp/dependency-cache'])
  for (const relativePath of correctnessFiles) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath)
  }
})

test('a later Fresh cleanup preserves and verifies earlier terminal run outputs', (t) => {
  const root = fixtureRoot(t)
  const earlier = createProductionFreshOutputRoot({ root, runId: 'run-a' })
  const resultFile = outputPath(earlier, 'summary/result.json')
  fs.writeFileSync(resultFile, 'run-a')
  sealTerminalProductionFreshOutputs(earlier)
  const terminalIdentityBefore = fs.lstatSync(earlier.runOutputRoot, { bigint: true })

  const cleanup = cleanLocalProductionOutputs(root, {
    runId: 'run-b',
    ownerIdentity: ownerIdentity(root, 'run-b')
  })

  assert.equal(fs.readFileSync(resultFile, 'utf8'), 'run-a')
  assert.equal(verifyTerminalProductionFreshOutputs(earlier).attempts.length, 1)
  const terminalIdentityAfter = fs.lstatSync(earlier.runOutputRoot, { bigint: true })
  assert.deepEqual(
    {
      dev: terminalIdentityAfter.dev,
      ino: terminalIdentityAfter.ino,
      mode: terminalIdentityAfter.mode,
      mtimeNs: terminalIdentityAfter.mtimeNs,
      ctimeNs: terminalIdentityAfter.ctimeNs
    },
    {
      dev: terminalIdentityBefore.dev,
      ino: terminalIdentityBefore.ino,
      mode: terminalIdentityBefore.mode,
      mtimeNs: terminalIdentityBefore.mtimeNs,
      ctimeNs: terminalIdentityBefore.ctimeNs
    })
  assert.ok(cleanup.preservedRoots.includes('.tmp/test-runs'))
  for (const directory of [
    ...productionFreshCacheEntries.map(({ relativePath }) => path.join(root, '.tmp', relativePath)),
    earlier.outputRoot
  ]) {
    if (!fs.existsSync(directory)) continue
    for (const entry of fs.readdirSync(directory, { recursive: true }).reverse()) {
      const candidate = path.join(directory, entry)
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isDirectory()) fs.chmodSync(candidate, 0o755)
      else if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o644)
    }
    fs.chmodSync(directory, 0o755)
  }
})

test('cache transaction rejects symlinks and hardlinks that escape a registered cache root', (t) => {
  const symlinkRoot = fixtureRoot(t)
  const outside = path.join(symlinkRoot, 'outside.txt')
  fs.writeFileSync(outside, 'outside')
  const symlinkCache = path.join(symlinkRoot, '.tmp/dependency-cache')
  fs.mkdirSync(symlinkCache, { recursive: true })
  fs.symlinkSync(outside, path.join(symlinkCache, 'escape'))
  assert.throws(() => runProductionFreshCacheTransaction(symlinkRoot, {
    runId: 'symlink-rejected',
    ownerIdentity: ownerIdentity(symlinkRoot, 'symlink'),
    removeFreshRoot
  }), /contains a symlink/u)

  const hardlinkRoot = fixtureRoot(t)
  const hardlinkCache = path.join(hardlinkRoot, '.tmp/dependency-cache')
  fs.mkdirSync(hardlinkCache, { recursive: true })
  const cachedFile = path.join(hardlinkCache, 'cache.bin')
  fs.writeFileSync(cachedFile, 'hardlink')
  fs.linkSync(cachedFile, path.join(hardlinkRoot, 'outside-hardlink.bin'))
  assert.throws(() => runProductionFreshCacheTransaction(hardlinkRoot, {
    runId: 'hardlink-rejected',
    ownerIdentity: ownerIdentity(hardlinkRoot, 'hardlink'),
    removeFreshRoot
  }), /hardlink escapes/u)
})

test('cache transaction requires the exact active lease owner identity', (t) => {
  const root = fixtureRoot(t)
  writeCache(root, 'dependency-cache/dotnet')
  const incompleteOwner = {
    ...ownerIdentity(root),
    candidateIdentityDigest: 'not-a-digest'
  }
  assert.throws(() => runProductionFreshCacheTransaction(root, {
    runId: 'invalid-owner',
    ownerIdentity: incompleteOwner,
    removeFreshRoot
  }), /owner identity is incomplete or mismatched/u)
})

test('terminal journals remain auditable without freezing later cache contents', (t) => {
  const root = fixtureRoot(t)
  const file = writeCache(root, 'dependency-cache/dotnet', 'first-generation')
  runProductionFreshCacheTransaction(root, {
    runId: 'first-generation',
    ownerIdentity: ownerIdentity(root, 'first-generation'),
    removeFreshRoot
  })
  fs.writeFileSync(file, 'second-generation')

  const second = runProductionFreshCacheTransaction(root, {
    runId: 'second-generation',
    ownerIdentity: ownerIdentity(root, 'second-generation'),
    removeFreshRoot
  })

  assert.equal(second.state, 'committed')
  assert.equal(fs.readFileSync(file, 'utf8'), 'second-generation')
})

for (const code of ['ENOSPC', 'EACCES']) {
  test(`${code} enters recovery-required and blocks every later Fresh`, (t) => {
    const root = fixtureRoot(t)
    writeCache(root, 'dependency-cache/dotnet')
    const failure = new Error(`injected ${code}`)
    failure.code = code

    assert.throws(() => runProductionFreshCacheTransaction(root, {
      runId: `failure-${code}`,
      ownerIdentity: ownerIdentity(root, code),
      removeFreshRoot() {
        throw failure
      }
    }), new RegExp(`recovery-required.*${code}`, 'u'))
    assert.throws(() => runProductionFreshCacheTransaction(root, {
      runId: `blocked-${code}`,
      ownerIdentity: ownerIdentity(root, `blocked-${code}`),
      removeFreshRoot
    }), /requires operator recovery/u)
  })
}
