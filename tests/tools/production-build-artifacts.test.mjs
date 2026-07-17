import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createProductionBuildReceipt,
  materializeProductionBuildDomains,
  productionBuildReceiptSchema,
  verifyProductionBuildReceipt
} from '../../tools/ci/production-build-artifacts.mjs'

const sourceState = {
  commit: 'a'.repeat(40),
  worktreeFingerprint: 'b'.repeat(64)
}
const producer = { workflow: 'Quality Gate', runId: '42', runAttempt: 2, job: 'production-build-artifacts' }
const toolchain = {
  node: 'v24.1.0', npm: '11.0.0', dotnet: '10.0.1', vite: '7.0.0', vitest: '4.0.0', playwright: '1.58.0', emsdk: '4.0.0'
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ci-build-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const artifactRoot = path.join(root, 'artifact')
  fs.mkdirSync(path.join(artifactRoot, 'payload/backend'), { recursive: true })
  fs.mkdirSync(path.join(artifactRoot, 'payload/frontend'), { recursive: true })
  fs.writeFileSync(path.join(artifactRoot, 'payload/backend/FsusBlog.Server.dll'), 'server')
  fs.writeFileSync(path.join(artifactRoot, 'payload/frontend/index.html'), '<main>ok</main>')
  fs.writeFileSync(path.join(root, 'global.json'), '{"sdk":{"version":"10.0.100"}}\n')
  return { root, artifactRoot }
}

function create(value) {
  return createProductionBuildReceipt({
    ...value,
    sourceState,
    producer,
    toolchain,
    inputPaths: ['global.json'],
    domains: [
      { name: 'backend-runtime', path: 'payload/backend' },
      { name: 'frontend-dist', path: 'payload/frontend' }
    ],
    build: { profile: 'production-release-fresh', command: './tools/test.sh ci-tier production-build-artifacts' }
  })
}

test('receipt binds source, toolchain, producer, input and every immutable artifact digest', t => {
  const value = fixture(t)
  const receipt = create(value)
  assert.equal(receipt.schema, productionBuildReceiptSchema)
  assert.deepEqual(receipt.sourceState, sourceState)
  assert.deepEqual(receipt.producer, producer)
  assert.equal(receipt.inputDigests.length, 1)
  assert.equal(receipt.artifacts.length, 2)
  assert.ok(receipt.artifacts.every(entry => /^sha256:[a-f0-9]{64}$/u.test(entry.sha256)))
  assert.match(receipt.contentDigest, /^sha256:[a-f0-9]{64}$/u)

  const verified = verifyProductionBuildReceipt({
    artifactRoot: value.artifactRoot,
    expectedSourceState: sourceState,
    expectedProducer: { runId: '42', runAttempt: 2 },
    expectedToolchain: { node: 'v24.1.0' },
    expectedInputRoot: value.root
  })
  assert.equal(verified.evidence.status, 'success')
  assert.equal(verified.evidence.artifactBytes, Buffer.byteLength('server') + Buffer.byteLength('<main>ok</main>'))
})

test('receipt verification preserves the filesystem order for mixed-case artifact paths', t => {
  const value = fixture(t)
  fs.writeFileSync(path.join(value.artifactRoot, 'payload/backend/alpha.dll'), 'alpha')
  fs.writeFileSync(path.join(value.artifactRoot, 'payload/backend/Zeta.dll'), 'zeta')
  create(value)

  const verified = verifyProductionBuildReceipt({ artifactRoot: value.artifactRoot })
  assert.equal(verified.evidence.status, 'success')
  assert.equal(verified.evidence.artifactCount, 4)
})

test('consumer rejects checkout input drift even when the receipt and payload are unchanged', t => {
  const value = fixture(t)
  create(value)
  fs.writeFileSync(path.join(value.root, 'global.json'), '{"sdk":{"version":"99.0.0"}}\n')

  assert.throws(() => verifyProductionBuildReceipt({
    artifactRoot: value.artifactRoot,
    expectedSourceState: sourceState,
    expectedToolchain: toolchain,
    expectedInputRoot: value.root
  }), error => {
    assert.match(error.message, /input digest mismatch: global\.json/u)
    assert.equal(error.evidence.status, 'failure')
    return true
  })
})

test('wrong commit, wrong run and toolchain drift fail closed', t => {
  const value = fixture(t)
  create(value)
  assert.throws(() => verifyProductionBuildReceipt({
    artifactRoot: value.artifactRoot,
    expectedSourceState: { ...sourceState, commit: 'c'.repeat(40) },
    expectedProducer: { workflow: 'Other Workflow', runId: 'stale', runAttempt: 3 },
    expectedToolchain: { node: 'v99.0.0' }
  }), error => {
    assert.match(error.message, /commit SHA mismatch/u)
    assert.match(error.message, /producer workflow mismatch/u)
    assert.match(error.message, /producer runId mismatch/u)
    assert.match(error.message, /producer runAttempt mismatch/u)
    assert.match(error.message, /toolchain node mismatch/u)
    assert.equal(error.evidence.status, 'failure')
    return true
  })
})

test('missing, damaged and unreceipted artifacts are all rejected', t => {
  const value = fixture(t)
  create(value)
  fs.appendFileSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll'), '-tampered')
  fs.rmSync(path.join(value.artifactRoot, 'payload/frontend/index.html'))
  fs.writeFileSync(path.join(value.artifactRoot, 'payload/backend/unreceipted.dll'), 'extra')
  fs.writeFileSync(path.join(value.artifactRoot, 'root-extra.txt'), 'extra')
  assert.throws(() => verifyProductionBuildReceipt({ artifactRoot: value.artifactRoot }), error => {
    assert.match(error.message, /artifact size mismatch/u)
    assert.match(error.message, /artifact digest mismatch/u)
    assert.match(error.message, /artifact is missing/u)
    assert.match(error.message, /unreceipted files/u)
    assert.match(error.message, /artifact root contains files not covered/u)
    return true
  })
})

test('path escape and symlink payloads are rejected before a receipt is emitted', t => {
  const value = fixture(t)
  assert.throws(() => createProductionBuildReceipt({
    root: value.root,
    artifactRoot: value.artifactRoot,
    sourceState,
    producer,
    toolchain,
    inputPaths: ['global.json'],
    domains: [{ name: 'escape', path: '../outside' }]
  }), /unsafe|escapes/u)
  fs.symlinkSync(path.join(value.root, 'global.json'), path.join(value.artifactRoot, 'payload/backend/link'))
  assert.throws(() => create(value), /symlink/u)
})

test('two consumers materialize isolated copies without modifying the downloaded artifact', t => {
  const value = fixture(t)
  create(value)
  const original = fs.readFileSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll'))
  for (const shard of ['shard-a', 'shard-b']) {
    const destinationRoot = path.join(value.root, shard)
    const result = materializeProductionBuildDomains({
      artifactRoot: value.artifactRoot,
      destinationRoot,
      mappings: [
        { name: 'backend-runtime', destination: '.runtime/backend' },
        { name: 'frontend-dist', destination: '.runtime/frontend' }
      ],
      verification: { expectedSourceState: sourceState, expectedProducer: { runId: '42' } }
    })
    assert.equal(result.copied.length, 2)
    fs.appendFileSync(path.join(destinationRoot, '.runtime/backend/FsusBlog.Server.dll'), `-${shard}`)
  }
  assert.deepEqual(fs.readFileSync(path.join(value.artifactRoot, 'payload/backend/FsusBlog.Server.dll')), original)
  assert.notEqual(
    fs.readFileSync(path.join(value.root, 'shard-a/.runtime/backend/FsusBlog.Server.dll'), 'utf8'),
    fs.readFileSync(path.join(value.root, 'shard-b/.runtime/backend/FsusBlog.Server.dll'), 'utf8')
  )
})
