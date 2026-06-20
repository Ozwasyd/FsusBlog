import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..', '..')
const script = path.join(root, 'tools/security/check-privacy-zk-prod-release.mjs')

test('privacy ZK production release gate accepts disabled safe baseline', () => {
  withTempDir((dir) => {
    const config = writeJson(dir, 'off.json', {
      AnonymousIdentity: {
        ZkProd: {
          Enabled: false,
          AllowDevVerifier: false,
          FallbackToLegacyAnonymous: false
        }
      }
    })
    const summary = path.join(dir, 'summary.json')

    const result = runGate('--config', config, '--summary', summary)

    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(readFileSync(summary, 'utf8'))
    assert.equal(parsed.status, 'ok')
    assert.equal(parsed.enabled, false)
  })
})

test('privacy ZK production release gate rejects bypass flags even when disabled', () => {
  withTempDir((dir) => {
    const config = writeJson(dir, 'unsafe.json', {
      AnonymousIdentity: {
        ZkProd: {
          Enabled: false,
          AllowDevVerifier: true,
          FallbackToLegacyAnonymous: false
        }
      }
    })

    const result = runGate('--config', config, '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /AllowDevVerifier/)
  })
})

test('privacy ZK production release gate fails closed when enabled smoke evidence is missing', () => {
  withTempDir((dir) => {
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const bbsPublicKey = writeText(dir, 'bbs-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest('abc123'))
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      bbsPublicKey,
      verifyingKeyHash: 'abc123'
    }))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', path.join(dir, 'missing-smoke.json'),
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /zk-prod-smoke-evidence/)
  })
})

test('privacy ZK production release gate fails when credential root is not active', () => {
  withTempDir((dir) => {
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const bbsPublicKey = writeText(dir, 'bbs-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest('abc123'))
    const smoke = writeJson(dir, 'smoke.json', completeSmokeEvidence({ credentialRootActive: false }))
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      bbsPublicKey,
      verifyingKeyHash: 'abc123',
      smoke
    }))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /credentialRootActive/)
  })
})

test('privacy ZK production release gate rejects sensitive smoke evidence fields', () => {
  withTempDir((dir) => {
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const bbsPublicKey = writeText(dir, 'bbs-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest('abc123'))
    const smoke = writeJson(dir, 'smoke.json', {
      ...completeSmokeEvidence(),
      debug: {
        credentialSecret: 'must-not-ship'
      }
    })
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      bbsPublicKey,
      verifyingKeyHash: 'abc123',
      smoke
    }))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /credentialSecret/)
  })
})

test('privacy ZK production release gate accepts complete enabled fixture', () => {
  withTempDir((dir) => {
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const bbsPublicKey = writeText(dir, 'bbs-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest('abc123'))
    const smoke = writeJson(dir, 'smoke.json', completeSmokeEvidence())
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      bbsPublicKey,
      verifyingKeyHash: 'abc123',
      smoke
    }))
    const summary = path.join(dir, 'summary.json')

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--summary', summary)

    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(readFileSync(summary, 'utf8'))
    assert.equal(parsed.status, 'ok')
    assert.equal(parsed.enabled, true)
  })
})

function completeSmokeEvidence(overrides = {}) {
  return {
    status: 'ok',
    nativeVerifier: true,
    wasmProver: true,
    bbsCredential: true,
    credentialRootActive: true,
    ticketIssued: true,
    anonymousSubmitPending: true,
    identityHeadersOmitted: true,
    sensitivePayloadRedacted: true,
    ...overrides
  }
}

function enabledConfig({ nativeLibrary, bbsPublicKey, verifyingKeyHash, smoke }) {
  return {
    AnonymousIdentity: {
      ZkProd: {
        Enabled: true,
        RequireNativeVerifier: true,
        RequireBbsCredential: true,
        RequireTrustedSetupVerified: true,
        AllowDevVerifier: false,
        FallbackToLegacyAnonymous: false,
        VerifierBackend: 'native_groth16',
        TrustedSetupVerified: true,
        BbsCredentialReady: true,
        VerifyingKeyHash: verifyingKeyHash,
        SmokeEvidencePath: smoke
      },
      ZkVerifier: {
        Backend: 'native_groth16',
        VerifyingKeyHash: verifyingKeyHash,
        NativeLibraryPath: nativeLibrary
      },
      BbsIssuer: {
        PublicKeyPath: bbsPublicKey
      }
    }
  }
}

function setupManifest(verifyingKeyHash) {
  return {
    schema: 'fsusblog.zk.trusted-setup-manifest.v1',
    circuit_id: 'fsus.anonymous.comment.v1',
    public_input_layout_version: 2,
    production_usable: true,
    ceremony_status: 'verified',
    verifying_key_hash: verifyingKeyHash
  }
}

function runGate(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8'
  })
}

function withTempDir(action) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsus-zk-prod-'))
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

function writeText(dir, name, value) {
  const file = path.join(dir, name)
  writeFileSync(file, value)
  return file
}
