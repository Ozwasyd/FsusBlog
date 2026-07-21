import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..', '..')
const script = path.join(root, 'tools/security/bootstrap-anonymous-credential-root.mjs')
const dotnetProject = path.join(root, 'tools/security/AnonymousCredentialRootBootstrap/FsusBlog.AnonymousCredentialRootBootstrap.csproj')
const runbook = path.join(root, 'docs/zk/anonymous-credential-root-bootstrap.md')

test('anonymous credential root bootstrap rejects verifying key hash drift from trusted setup', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a')))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput({
      verifyingKeyHash: hex('b')
    }))
    const evidence = path.join(dir, 'evidence.json')

    const result = runBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence)

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /verifying_key_hash.*trusted setup/i)
    assert.equal(existsSync(evidence), false)
  })
})

test('anonymous credential root bootstrap writes sanitized offline evidence for valid root material', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a')))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput({
      revocationRootHash: emptyAccumulatorRoot()
    }))
    const evidence = path.join(dir, 'evidence.json')

    const result = runBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence)

    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(readFileSync(evidence, 'utf8'))
    assert.equal(parsed.status, 'validated_offline')
    assert.equal(parsed.stagingDbRotateSatisfied, false)
    assert.equal(parsed.rootSnapshot.circuitId, 'fsus.anonymous.comment.v5')
    assert.equal(parsed.rootSnapshot.publicInputLayoutVersion, 6)
    assert.equal(parsed.rootSnapshot.verifyingKeyHash, hex('a'))
    assert.equal(parsed.rotateContract.dotnetService, 'AnonymousCredentialRootLifecycleService.RotateAsync')
    assertNoSensitiveEvidence(result.stdout + result.stderr + JSON.stringify(parsed))
  })
})

test('dotnet anonymous credential root bootstrap rotates staging database through lifecycle service', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a')))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput({
      revocationRootHash: emptyAccumulatorRoot()
    }))
    const evidence = path.join(dir, 'rotated-evidence.json')
    const dbPath = path.join(dir, 'root-lifecycle.db')

    const result = runDotnetBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence,
      '--db-type', 'sqlite',
      '--connection-string', `Data Source=${dbPath}`,
      '--ensure-schema')

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const parsed = JSON.parse(readFileSync(evidence, 'utf8'))
    assert.equal(parsed.status, 'rotated')
    assert.equal(parsed.mode, 'dotnet-root-lifecycle-rotate')
    assert.equal(parsed.stagingDbRotateSatisfied, true)
    assert.equal(parsed.rootSnapshot.epoch, 2026062001)
    assert.equal(parsed.rootSnapshot.revocationRootHash, emptyAccumulatorRoot())
    assert.equal(parsed.runtimeSnapshot.credentialRootReady, true)
    assert.equal(parsed.runtimeSnapshot.acceptedRootCount, 1)
    assert.equal(parsed.highValueAudit.action, 'security.anonymous_credential.root_rotated')
    assert.equal(parsed.highValueAudit.isHighValue, true)
    assertNoSensitiveEvidence(result.stdout + result.stderr + JSON.stringify(parsed))
  })
})

test('dotnet anonymous credential root bootstrap rejects mismatched empty revocation root', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a')))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput())
    const evidence = path.join(dir, 'rotated-evidence.json')
    const dbPath = path.join(dir, 'root-lifecycle.db')

    const result = runDotnetBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence,
      '--db-type', 'sqlite',
      '--connection-string', `Data Source=${dbPath}`,
      '--ensure-schema')

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /empty circuit-friendly accumulator root/)
    assert.equal(existsSync(evidence), false)
  })
})

test('dotnet anonymous credential root bootstrap rejects v2 manifest authority drift before database access', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a'), {
      trusted_setup_manifest: 'security/zk/provenance/not-current.json'
    }))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput({
      revocationRootHash: emptyAccumulatorRoot()
    }))
    const evidence = path.join(dir, 'rotated-evidence.json')

    const result = runDotnetBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence,
      '--db-type', 'sqlite',
      '--connection-string', `Data Source=${path.join(dir, 'must-not-open.db')}`)

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /trusted_setup_manifest must be security\/zk\/provenance\/comment-v5-trusted-setup\.manifest\.json/)
    assert.equal(existsSync(evidence), false)
  })
})

test('anonymous credential root bootstrap rejects invalid circuit identity and layout', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a')))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput({
      circuitId: 'fsus.anonymous.comment.v1',
      publicInputLayoutVersion: 2
    }))
    const evidence = path.join(dir, 'evidence.json')

    const result = runBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence)

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /circuit_id must be fsus\.anonymous\.comment\.v5/)
    assert.match(`${result.stdout}\n${result.stderr}`, /public_input_layout_version must be 6/)
    assert.equal(existsSync(evidence), false)
  })
})

test('anonymous credential root bootstrap rejects private credential material without leaking values', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a')))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput({
      credentialSecret: 'do-not-print-credential-secret'
    }))
    const evidence = path.join(dir, 'evidence.json')

    const result = runBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence)

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /sensitive bootstrap input field is forbidden/)
    assert.equal((result.stdout + result.stderr).includes('do-not-print-credential-secret'), false)
    assert.equal(existsSync(evidence), false)
  })
})

test('anonymous credential root bootstrap rejects unknown input fields without leaking values', () => {
  withTempDir((dir) => {
    const trustedSetup = writeJson(dir, 'trusted-setup.json', trustedSetupManifest(hex('a')))
    const verifyingKey = writeJson(dir, 'verifying-key.json', verifyingKeyManifest(hex('a')))
    const input = writeJson(dir, 'bootstrap-input.json', bootstrapInput({
      opsNote: 'private-root-material-location'
    }))
    const evidence = path.join(dir, 'evidence.json')

    const result = runBootstrap(
      '--input', input,
      '--trusted-setup-manifest', trustedSetup,
      '--verifying-key-manifest', verifyingKey,
      '--evidence', evidence)

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /unknown bootstrap input field: opsNote/)
    assert.equal((result.stdout + result.stderr).includes('private-root-material-location'), false)
    assert.equal(existsSync(evidence), false)
  })
})

test('anonymous credential root bootstrap runbook documents rotate, gate and rollback', () => {
  const doc = readFileSync(runbook, 'utf8')

  assert.match(doc, /bootstrap-anonymous-credential-root\.mjs/)
  assert.match(doc, /AnonymousCredentialRootLifecycleService\.RotateAsync/)
  assert.match(doc, /--root-bootstrap-evidence/)
  assert.match(doc, /staging DB rotate is not satisfied by the offline evidence/)
  assert.match(doc, /AnonymousIdentity:ZkProd:Enabled=false/)
  assert.match(doc, /不删除已写入的匿名评论/)
})

test('dotnet root bootstrap emits the current revocation metadata profile', () => {
  const source = readFileSync(path.join(root, 'tools/security/AnonymousCredentialRootBootstrap/Program.cs'), 'utf8')

  assert.match(source, /"layout":3/)
  assert.match(source, /"algorithm":"circuit-friendly-non-membership\.v1"/)
  assert.doesNotMatch(source, /"layout":2/)
})

function bootstrapInput(overrides = {}) {
  return {
    schema: 'fsusblog.anonymous-credential-root-bootstrap-request.v1',
    epoch: 2026062001,
    credentialRootHash: hex('1'),
    revocationRootHash: hex('2'),
    issuerPublicKeyHash: hex('3'),
    circuitId: 'fsus.anonymous.comment.v5',
    circuitNumericId: 1,
    publicInputLayoutVersion: 6,
    verifyingKeyHash: hex('a'),
    expiresAt: '2026-07-20T00:00:00Z',
    graceExpiresAt: '2026-07-27T00:00:00Z',
    operatorId: 'admin:root-ops',
    reason: 'initial staging root bootstrap',
    ...overrides
  }
}

function trustedSetupManifest(verifyingKeyHash, overrides = {}) {
  return {
    schema: 'fsusblog.zk.trusted-setup-manifest.v2',
    circuit_id: 'fsus.anonymous.comment.v5',
    public_input_layout_version: 6,
    production_usable: true,
    ceremony_status: 'verified',
    circuit_manifest_path: 'security/zk/contracts/comment-v5-circuit.manifest.json',
    artifacts: {
      verifying_key: {
        path: 'artifacts/zk/comment-v5/comment_v5_verifying_key.bin'
      }
    },
    verifying_key_hash: verifyingKeyHash,
    ...overrides
  }
}

function verifyingKeyManifest(verifyingKeyHash, overrides = {}) {
  return {
    schema: 'fsusblog.zk.verifying-key-config.v2',
    circuit_id: 'fsus.anonymous.comment.v5',
    public_input_layout_version: 6,
    production_usable: true,
    trusted_setup_manifest: 'security/zk/provenance/comment-v5-trusted-setup.manifest.json',
    circuit_manifest: 'security/zk/contracts/comment-v5-circuit.manifest.json',
    verifying_key_path: 'artifacts/zk/comment-v5/comment_v5_verifying_key.bin',
    verifying_key_hash: verifyingKeyHash,
    ...overrides
  }
}

function runBootstrap(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8'
  })
}

function runDotnetBootstrap(...args) {
  return spawnSync('dotnet', ['run', '--project', dotnetProject, '--', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      AnonymousCredentialRoot__AttestationKey: 'root-bootstrap-test-attestation-key-32-bytes-minimum',
      AnonymousCredentialRoot__AttestationKeyId: 'root-bootstrap-test'
    },
    timeout: 120_000
  })
}

function withTempDir(action) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsus-root-bootstrap-'))
  try {
    action(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

function hex(ch) {
  return ch.repeat(64)
}

function emptyAccumulatorRoot() {
  return '0534b236fbe54ef350616e8f27d21223b688fcdb08dba8968942421a9d02e20f'
}

function assertNoSensitiveEvidence(text) {
  for (const token of [
    'issuerPrivateKey',
    'issuer_private_key',
    'credentialSecret',
    'credential_secret',
    'proofWitness',
    'proof_witness',
    'do-not-print-credential-secret'
  ]) {
    assert.equal(text.includes(token), false, `sensitive evidence leaked: ${token}`)
  }
}
