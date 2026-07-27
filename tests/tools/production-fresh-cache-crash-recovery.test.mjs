import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  productionFreshCacheCrashBoundaries,
  recoverProductionFreshCacheTransactions,
  runProductionFreshCacheTransaction
} from '../../tools/test-matrix/production-fresh-cache-transaction.mjs'

const transactionModuleUrl = pathToFileURL(
  path.resolve('tools/test-matrix/production-fresh-cache-transaction.mjs')
).href

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sealJournal(journal) {
  const { contentDigest: _contentDigest, ...payload } = journal
  return { ...payload, contentDigest: sha256(JSON.stringify(canonicalize(payload))) }
}

function fixtureRoot(t, prefix = 'fsusblog-cache-recovery-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(root, '.git'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function ownerIdentity(root, suffix = 'recovery') {
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

function writeFixture(root) {
  const caches = [
    ['dependency-cache/dotnet/nuget/packages/cache.bin', 'dependency'],
    ['emscripten-cache/sysroot/cache.bin', 'emscripten']
  ]
  for (const [relativePath, content] of caches) {
    const file = path.join(root, '.tmp', relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const stale = path.join(root, '.tmp/correctness/summary.json')
  fs.mkdirSync(path.dirname(stale), { recursive: true })
  fs.writeFileSync(stale, 'stale')
}

function crashChild(root, boundary, signal = 'SIGKILL') {
  const script = `
    import { createHash } from 'node:crypto'
    import fs from 'node:fs'
    const { runProductionFreshCacheTransaction } = await import(process.env.TRANSACTION_MODULE_URL)
    const root = process.env.TRANSACTION_ROOT
    const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex')
    const ownerIdentity = {
      leaseId: 'lease-crash',
      ownerToken: 'token-crash',
      canonicalRepositoryRoot: fs.realpathSync(root),
      profile: 'production-fresh',
      candidateIdentityDigest: digest('candidate-crash'),
      pid: process.pid,
      processStartIdentity: 'start-crash',
      executableDigest: digest('node'),
      commandDigest: digest('command-crash'),
      processGroupOrJobIdentity: { kind: 'unix-process-group', processGroupId: process.pid }
    }
    runProductionFreshCacheTransaction(root, {
      runId: 'crashing-run',
      ownerIdentity,
      removeFreshRoot(sourceRoot) {
        fs.rmSync(sourceRoot, { recursive: true, force: true })
      },
      onCrashBoundary(actual) {
        if (actual === process.env.CRASH_BOUNDARY) process.kill(process.pid, process.env.CRASH_SIGNAL)
      }
    })
  `
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      TRANSACTION_MODULE_URL: transactionModuleUrl,
      TRANSACTION_ROOT: root,
      CRASH_BOUNDARY: boundary,
      CRASH_SIGNAL: signal
    },
    encoding: 'utf8'
  })
}

function transactionJournals(root) {
  const journalRoot = path.join(root, '.git/production-fresh-cache-transactions')
  const repositoryDirectory = fs.readdirSync(journalRoot).at(0)
  const directory = path.join(journalRoot, repositoryDirectory)
  return fs.readdirSync(directory).sort().map((file) => ({
    file: path.join(directory, file),
    journal: JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
  }))
}

for (const boundary of productionFreshCacheCrashBoundaries) {
  test(`next Fresh deterministically recovers a process crash at ${boundary}`, (t) => {
    const root = fixtureRoot(t)
    writeFixture(root)

    const crashed = crashChild(root, boundary)
    assert.equal(crashed.signal, 'SIGKILL', `${crashed.stderr}\n${crashed.stdout}`)

    const recovered = runProductionFreshCacheTransaction(root, {
      runId: `recovery-${boundary}`,
      ownerIdentity: ownerIdentity(root, boundary),
      removeFreshRoot(sourceRoot) {
        fs.rmSync(sourceRoot, { recursive: true, force: true })
      }
    })

    assert.equal(recovered.state, 'committed')
    assert.equal(
      fs.readFileSync(path.join(root, '.tmp/dependency-cache/dotnet/nuget/packages/cache.bin'), 'utf8'),
      'dependency'
    )
    assert.equal(
      fs.readFileSync(path.join(root, '.tmp/emscripten-cache/sysroot/cache.bin'), 'utf8'),
      'emscripten'
    )
    assert.equal(fs.existsSync(path.join(root, '.tmp/correctness/summary.json')), false)
    const journals = transactionJournals(root)
    assert.equal(journals.length, 2)
    assert.equal(journals.every(({ journal }) => ['aborted', 'committed'].includes(journal.state)), true)
    assert.equal(
      journals.some(({ journal }) => journal.crashInjectionPoint === boundary),
      true
    )
  })
}

test('SIGTERM uses the same journal recovery path before a new cleanup', (t) => {
  const root = fixtureRoot(t)
  writeFixture(root)
  assert.equal(crashChild(root, 'after-all-evacuated', 'SIGTERM').signal, 'SIGTERM')

  const recovered = recoverProductionFreshCacheTransactions(root)

  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].finalState, 'committed')
  assert.equal(
    fs.readFileSync(path.join(root, '.tmp/dependency-cache/dotnet/nuget/packages/cache.bin'), 'utf8'),
    'dependency'
  )
})

test('tampered holding content fails closed before cleanup or producer work', (t) => {
  const root = fixtureRoot(t)
  writeFixture(root)
  assert.equal(crashChild(root, 'after-first-entry-evacuated').signal, 'SIGKILL')
  const [{ journal }] = transactionJournals(root)
  const evacuated = journal.entries.find((entry) => fs.existsSync(entry.holdingPath))
  fs.appendFileSync(evacuated.holdingPath.endsWith('cache.bin')
    ? evacuated.holdingPath
    : path.join(evacuated.holdingPath, 'sysroot/cache.bin'), 'tampered')
  let cleanupCalled = false

  assert.throws(() => runProductionFreshCacheTransaction(root, {
    runId: 'tampered-recovery',
    ownerIdentity: ownerIdentity(root, 'tampered'),
    removeFreshRoot() {
      cleanupCalled = true
    }
  }), /recovery-required.*digest changed/u)
  assert.equal(cleanupCalled, false)
  assert.equal(transactionJournals(root)[0].journal.state, 'recovery-required')
})

test('a new original path is never overwritten during recovery', (t) => {
  const root = fixtureRoot(t)
  writeFixture(root)
  assert.equal(crashChild(root, 'after-first-entry-evacuated').signal, 'SIGKILL')
  const [{ journal }] = transactionJournals(root)
  const evacuated = journal.entries.find((entry) => fs.existsSync(entry.holdingPath))
  fs.mkdirSync(evacuated.originalPath, { recursive: true })
  fs.writeFileSync(path.join(evacuated.originalPath, 'other-owner.txt'), 'other-owner')

  assert.throws(() => recoverProductionFreshCacheTransactions(root), /both original and holding paths exist/u)
  assert.equal(fs.readFileSync(path.join(evacuated.originalPath, 'other-owner.txt'), 'utf8'), 'other-owner')
  assert.equal(transactionJournals(root)[0].journal.state, 'recovery-required')
})

test('corrupt and unknown journals fail closed without guessing holding directories', (t) => {
  const root = fixtureRoot(t)
  writeFixture(root)
  assert.equal(crashChild(root, 'after-first-entry-evacuated').signal, 'SIGKILL')
  const [{ file, journal }] = transactionJournals(root)
  fs.writeFileSync(file, '{not-json')
  fs.mkdirSync(path.join(path.dirname(journal.entries[0].holdingPath), 'unknown-transaction'))
  let cleanupCalled = false

  assert.throws(() => runProductionFreshCacheTransaction(root, {
    runId: 'corrupt-recovery',
    ownerIdentity: ownerIdentity(root, 'corrupt'),
    removeFreshRoot() {
      cleanupCalled = true
    }
  }), /journal is corrupt/u)
  assert.equal(cleanupCalled, false)
})

test('holding residue without an exact journal fails closed and is never restored by name or mtime', (t) => {
  const root = fixtureRoot(t)
  const repositoryDigest = sha256(JSON.stringify({
    canonicalRepositoryRoot: fs.realpathSync(root)
  })).slice('sha256:'.length)
  const unknownHolding = path.join(
    root,
    '.fsusblog-production-fresh-cache-holding',
    repositoryDigest,
    'unknown-transaction'
  )
  fs.mkdirSync(unknownHolding, { recursive: true })
  fs.writeFileSync(path.join(unknownHolding, 'cache.bin'), 'must-not-restore')
  fs.utimesSync(unknownHolding, new Date(0), new Date(0))

  assert.throws(
    () => recoverProductionFreshCacheTransactions(root),
    /holding root contains unknown transaction residue/u
  )
  assert.equal(fs.existsSync(path.join(root, '.tmp/cache.bin')), false)
  assert.equal(fs.readFileSync(path.join(unknownHolding, 'cache.bin'), 'utf8'), 'must-not-restore')
})

test('two unfinished journals retain distinct candidate identities and recover independently', (t) => {
  const root = fixtureRoot(t)
  writeFixture(root)
  assert.equal(crashChild(root, 'after-prepared').signal, 'SIGKILL')
  const [{ file, journal }] = transactionJournals(root)
  const secondTransactionId = '11111111-2222-4333-8444-555555555555'
  const secondCandidateIdentity = sha256('second-candidate')
  const second = sealJournal({
    ...journal,
    transactionId: secondTransactionId,
    candidateIdentityDigest: secondCandidateIdentity,
    ownerIdentity: {
      ...journal.ownerIdentity,
      candidateIdentityDigest: secondCandidateIdentity,
      leaseId: 'lease-independent',
      ownerToken: 'token-independent'
    },
    entries: journal.entries.map((entry) => ({
      ...entry,
      holdingPath: entry.holdingPath.replace(journal.transactionId, secondTransactionId)
    }))
  })
  fs.writeFileSync(path.join(path.dirname(file), `${secondTransactionId}.json`), `${JSON.stringify(second, null, 2)}\n`)

  const recovered = recoverProductionFreshCacheTransactions(root)

  assert.equal(recovered.length, 2)
  assert.deepEqual(
    new Set(recovered.map((entry) => entry.candidateIdentityDigest)),
    new Set([journal.candidateIdentityDigest, secondCandidateIdentity])
  )
  assert.equal(recovered.every((entry) => entry.finalState === 'aborted'), true)
})

test('a dangling external .tmp symlink recovers from fresh-root-cleared without changing its target', (t) => {
  const root = fixtureRoot(t, 'fsusblog-cache-external-recovery-')
  const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-cache-external-root-'))
  const externalRoot = path.join(externalParent, 'cache-root')
  t.after(() => fs.rmSync(externalParent, { recursive: true, force: true }))
  fs.mkdirSync(externalRoot)
  fs.symlinkSync(externalRoot, path.join(root, '.tmp'), 'dir')
  writeFixture(root)

  assert.equal(crashChild(root, 'after-fresh-root-cleared').signal, 'SIGKILL')
  assert.equal(fs.lstatSync(path.join(root, '.tmp')).isSymbolicLink(), true)
  assert.equal(fs.existsSync(externalRoot), false)

  runProductionFreshCacheTransaction(root, {
    runId: 'external-root-recovery',
    ownerIdentity: ownerIdentity(root, 'external-root'),
    removeFreshRoot(sourceRoot) {
      fs.rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  assert.equal(fs.realpathSync(path.join(root, '.tmp')), fs.realpathSync(externalRoot))
  assert.equal(
    fs.readFileSync(path.join(externalRoot, 'dependency-cache/dotnet/nuget/packages/cache.bin'), 'utf8'),
    'dependency'
  )
})
