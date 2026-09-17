import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireProductionFreshExclusiveLease
} from '../../tools/test-matrix/production-fresh-exclusive-lease.mjs'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function seal(owner) {
  const { contentDigest: _contentDigest, ...payload } = owner
  owner.contentDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex')}`
  return owner
}

function stale(owner) {
  owner.createdAt = '2000-01-01T00:00:00.000Z'
  owner.heartbeatAt = owner.createdAt
  return seal(owner)
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fresh-recovery-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  fs.writeFileSync(path.join(root, 'tracked'), 'preserved\n')
  execFileSync('git', ['add', 'tracked'], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: root }
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function options(root, overrides = {}) {
  return {
    root,
    runId: 'production-fresh-recovery',
    targetTierId: 'production',
    sourceState: {
      commit: 'a'.repeat(40),
      worktreeFingerprint: `sha256:${'b'.repeat(64)}`
    },
    heartbeatEveryMs: 60_000,
    verifyDescendants: () => ({ status: 'verified', identities: [] }),
    ...overrides
  }
}

test('SIGKILL stale owner recovery archives a stale-owner receipt before reacquisition', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(options(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const dead = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  dead.pid = 99_999_999
  dead.processStartIdentity = 'linux:dead-owner'
  fs.writeFileSync(ownerFile, `${JSON.stringify(stale(dead))}\n`)
  const recovered = acquireProductionFreshExclusiveLease(options(root))
  const receipt = path.join(
    path.dirname(recovered.leasePath),
    'terminal-receipts',
    `${dead.leaseId}.json`
  )
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).terminalReason, 'stale-owner-reclaimed')
  recovered.release()
})

test('PID reuse is inactive only when full start identity differs', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(options(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const reused = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  reused.processStartIdentity = `${reused.processStartIdentity}:replacement`
  fs.writeFileSync(ownerFile, `${JSON.stringify(stale(reused))}\n`)
  const recovered = acquireProductionFreshExclusiveLease(options(root))
  assert.notEqual(recovered.owner.ownerToken, reused.ownerToken)
  recovered.release()
})

test('heartbeat stale alone cannot reclaim a still-active process authority', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(options(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const active = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  fs.writeFileSync(ownerFile, `${JSON.stringify(stale(active))}\n`)
  assert.throws(
    () => acquireProductionFreshExclusiveLease(options(root)),
    /already active/u
  )
  assert.equal(fs.existsSync(first.leasePath), true)
})

test('a live process with mismatched group authority remains fail closed', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(options(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const active = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  fs.writeFileSync(ownerFile, `${JSON.stringify(stale(active))}\n`)
  assert.throws(
    () => acquireProductionFreshExclusiveLease(options(root, {
      verifyAuthority: () => ({
        status: 'inactive',
        reason: 'owner-group-or-job-mismatch'
      })
    })),
    /owner-unverifiable: owner-group-or-job-mismatch/u
  )
  assert.equal(fs.existsSync(first.leasePath), true)
})

test('replacement token wins reclaim CAS and remains the authoritative owner', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(options(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const dead = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  dead.pid = 99_999_999
  stale(dead)
  fs.writeFileSync(ownerFile, `${JSON.stringify(dead)}\n`)
  assert.throws(
    () => acquireProductionFreshExclusiveLease(options(root, {
      beforeReclaimCompare: () => fs.writeFileSync(
        ownerFile,
        `${JSON.stringify(seal({ ...dead, ownerToken: 'replacement-token' }))}\n`
      )
    })),
    /compare-and-swap failed/u
  )
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).ownerToken, 'replacement-token')
  assert.equal(fs.readFileSync(path.join(root, 'tracked'), 'utf8'), 'preserved\n')
})
