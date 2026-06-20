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
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash
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
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const smoke = writeJson(dir, 'smoke.json', completeSmokeEvidence({ credentialRootActive: false }))
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash,
      smoke
    }))
    const rootBootstrap = writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(verifyingKeyHash))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--root-bootstrap-evidence', rootBootstrap,
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /credentialRootActive/)
  })
})

test('privacy ZK production release gate fails when root bootstrap evidence is missing', () => {
  withTempDir((dir) => {
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const smoke = writeJson(dir, 'smoke.json', completeSmokeEvidence())
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash,
      smoke
    }))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--root-bootstrap-evidence', path.join(dir, 'missing-root-bootstrap.json'),
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /root-bootstrap-evidence/)
  })
})

test('privacy ZK production release gate rejects sensitive smoke evidence fields', () => {
  withTempDir((dir) => {
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const smoke = writeJson(dir, 'smoke.json', {
      ...completeSmokeEvidence(),
      debug: {
        credentialSecret: 'must-not-ship'
      }
    })
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash,
      smoke
    }))
    const rootBootstrap = writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(verifyingKeyHash))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--root-bootstrap-evidence', rootBootstrap,
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /credentialSecret/)
  })
})

test('privacy ZK production release gate rejects hashing-only smoke evidence', () => {
  withTempDir((dir) => {
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const smoke = writeJson(dir, 'smoke.json', {
      status: 'ok',
      nativeVerifier: true,
      wasmProver: true,
      credential: true,
      credentialRootActive: true,
      ticketIssued: true,
      anonymousSubmitPending: true,
      identityHeadersOmitted: true,
      sensitivePayloadRedacted: true,
      evidenceKind: 'hashing-fixture',
      hashingFixtureUsed: true
    })
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash,
      smoke
    }))
    const rootBootstrap = writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(verifyingKeyHash))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--root-bootstrap-evidence', rootBootstrap,
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /real-groth16-cross-stack/)
    assert.match(result.stderr, /hashingFixtureUsed/)
  })
})

test('privacy ZK production release gate rejects smoke evidence without prover performance budget', () => {
  withTempDir((dir) => {
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const smoke = writeJson(dir, 'slow-smoke.json', completeSmokeEvidence({
      performance: {
        wasmProverP95Ms: 3500,
        nativeVerifierP99Ms: 75
      }
    }))
    const rootBootstrap = writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(verifyingKeyHash))
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash,
      smoke
    }))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--root-bootstrap-evidence', rootBootstrap,
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /wasmProverP95Ms/)
    assert.match(result.stderr, /nativeVerifierP99Ms/)
  })
})

test('privacy ZK production release gate rejects offline-only root bootstrap evidence when enabled', () => {
  withTempDir((dir) => {
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const smoke = writeJson(dir, 'smoke.json', completeSmokeEvidence())
    const rootBootstrap = writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(verifyingKeyHash, {
      status: 'validated_offline',
      mode: 'offline-validated-evidence',
      stagingDbRotateSatisfied: false
    }))
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash,
      smoke
    }))

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--root-bootstrap-evidence', rootBootstrap,
      '--summary', path.join(dir, 'summary.json'))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /root-bootstrap-evidence status must be rotated/)
    assert.match(result.stderr, /stagingDbRotateSatisfied=true/)
  })
})

test('privacy ZK production release gate accepts complete enabled fixture', () => {
  withTempDir((dir) => {
    const verifyingKeyHash = hex('a')
    const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native')
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer')
    const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash))
    const smoke = writeJson(dir, 'smoke.json', completeSmokeEvidence())
    const rootBootstrap = writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(verifyingKeyHash))
    const config = writeJson(dir, 'enabled.json', enabledConfig({
      nativeLibrary,
      issuerPublicKey,
      verifyingKeyHash,
      smoke
    }))
    const summary = path.join(dir, 'summary.json')

    const result = runGate(
      '--config', config,
      '--trusted-setup-manifest', setup,
      '--smoke-evidence', smoke,
      '--root-bootstrap-evidence', rootBootstrap,
      '--summary', summary)

    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(readFileSync(summary, 'utf8'))
    assert.equal(parsed.status, 'ok')
    assert.equal(parsed.enabled, true)
  })
})

function completeSmokeEvidence(overrides = {}) {
  const artifactHashes = {
    r1csSha256: hex('1'),
    provingKeySha256: hex('2'),
    verifyingKeySha256: overrides.verifyingKeyHash ?? hex('a'),
    nativeVerifierSha256: hex('3'),
    wasmProverSha256: hex('4'),
    ...(overrides.artifactHashes ?? {})
  }

  return {
    evidenceKind: 'real-groth16-cross-stack',
    circuitId: 'fsus.anonymous.comment.v2',
    publicInputLayoutVersion: 3,
    proofSystem: 'Groth16',
    verifyingKeyHash: artifactHashes.verifyingKeySha256,
    status: 'ok',
    nativeVerifier: true,
    wasmProver: true,
    credential: true,
    credentialRootActive: true,
    ticketIssued: true,
    anonymousSubmitPending: true,
    identityHeadersOmitted: true,
    sensitivePayloadRedacted: true,
    ...overrides,
    performance: {
      wasmProverP95Ms: 2400,
      nativeVerifierP99Ms: 35,
      ...(overrides.performance ?? {})
    },
    artifactHashes,
    crossStack: {
      frontendProofGenerated: true,
      backendProofVerified: true,
      publicInputsMatch: true,
      tamperCasesRejected: true,
      hashingFixtureUsed: false,
      ...(overrides.crossStack ?? {})
    }
  }
}

function enabledConfig({ nativeLibrary, issuerPublicKey, verifyingKeyHash, smoke }) {
  return {
    AnonymousIdentity: {
      ZkProd: {
        Enabled: true,
        RequireNativeVerifier: true,
        RequireCredential: true,
        RequireTrustedSetupVerified: true,
        AllowDevVerifier: false,
        FallbackToLegacyAnonymous: false,
        VerifierBackend: 'native_groth16',
        TrustedSetupVerified: true,
        CredentialReady: true,
        VerifyingKeyHash: verifyingKeyHash,
        SmokeEvidencePath: smoke
      },
      ZkVerifier: {
        Backend: 'native_groth16',
        VerifyingKeyHash: verifyingKeyHash,
        NativeLibraryPath: nativeLibrary
      }
    },
    AnonymousCredentialIssuer: {
      CircuitNative: {
        IssuerPublicKeyPath: issuerPublicKey
      }
    }
  }
}

function setupManifest(verifyingKeyHash) {
  return {
    schema: 'fsusblog.zk.trusted-setup-manifest.v1',
    circuit_id: 'fsus.anonymous.comment.v2',
    public_input_layout_version: 3,
    production_usable: true,
    ceremony_status: 'verified',
    verifying_key_hash: verifyingKeyHash
  }
}

function rootBootstrapEvidence(verifyingKeyHash, overrides = {}) {
  return {
    schema: 'fsusblog.anonymous-credential-root-bootstrap-evidence.v1',
    status: 'rotated',
    mode: 'dotnet-root-lifecycle-rotate',
    stagingDbRotateSatisfied: true,
    rootSnapshot: {
      epoch: 2026062001,
      credentialRootHash: hex('1'),
      revocationRootHash: hex('2'),
      issuerPublicKeyHash: hex('3'),
      circuitId: 'fsus.anonymous.comment.v2',
      circuitNumericId: 7,
      publicInputLayoutVersion: 3,
      verifyingKeyHash,
      expiresAtUtc: '2099-07-20T00:00:00Z',
      graceExpiresAtUtc: '2099-07-27T00:00:00Z'
    },
    checks: [
      'hash-format-valid',
      'verifying-key-hash-bound-to-trusted-setup'
    ],
    highValueAudit: {
      action: 'security.anonymous_credential.root_rotated',
      isHighValue: true
    },
    ...overrides
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

function hex(ch) {
  return ch.repeat(64)
}
