import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..', '..')
const script = path.join(root, 'tools/security/run-privacy-zk-prod-smoke.mjs')
const sensitiveSamples = [
  'proof-raw-value',
  'ticket-secret-value',
  'credential-secret-value',
  'nullifier-secret-value'
]

test('privacy ZK production smoke records feature flag off as expected unavailable', () => {
  withTempDir((dir) => {
    const config = writeJson(dir, 'off.json', {
      AnonymousIdentity: {
        ZkProd: {
          Enabled: false
        }
      }
    })
    const summary = path.join(dir, 'summary.json')

    const result = runSmoke('--config', config, '--summary', summary)

    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(readFileSync(summary, 'utf8'))
    assert.equal(parsed.status, 'expected_unavailable')
    assert.equal(parsed.featureFlagOffExpectedUnavailable, true)
    assert.equal(parsed.identityHeadersOmitted, true)
    assert.equal(parsed.sensitivePayloadRedacted, true)
    assertNoSensitivePayload(result.stdout + result.stderr + JSON.stringify(parsed))
  })
})

test('privacy ZK production smoke fails require-real when real prover evidence is unavailable', () => {
  withTempDir((dir) => {
    const config = writeJson(dir, 'enabled.json', {
      AnonymousIdentity: {
        ZkProd: {
          Enabled: true,
          CredentialReady: true
        },
        ZkVerifier: {
          NativeLibraryPath: path.join(dir, 'missing-native.so')
        }
      }
    })

    const result = runSmoke(
      '--config', config,
      '--summary', path.join(dir, 'summary.json'),
      '--require-real')

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /real ZK-Prod smoke evidence is required/)
    assertNoSensitivePayload(result.stdout + result.stderr)
  })
})

test('privacy ZK production smoke accepts sanitized real full-chain evidence', () => {
  withTempDir((dir) => {
    const config = writeJson(dir, 'enabled.json', {
      AnonymousIdentity: {
        ZkProd: {
          Enabled: true
        }
      }
    })
    const realEvidence = writeJson(dir, 'real-evidence.json', {
      ...completeRealEvidence(),
      status: 'ok',
      proofRaw: sensitiveSamples[0],
      ticket: sensitiveSamples[1],
      credentialSecret: sensitiveSamples[2],
      nullifierSecret: sensitiveSamples[3]
    })
    const summary = path.join(dir, 'summary.json')

    const result = runSmoke(
      '--config', config,
      '--real-evidence', realEvidence,
      '--summary', summary,
      '--require-real')

    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(readFileSync(summary, 'utf8'))
    assert.equal(parsed.status, 'ok')
    assert.equal(parsed.nativeVerifier, true)
    assert.equal(parsed.wasmProver, true)
    assert.equal(parsed.credential, true)
    assert.equal(parsed.ticketIssued, true)
    assert.equal(parsed.anonymousSubmitPending, true)
    assert.equal(parsed.identityHeadersOmitted, true)
    assert.equal(parsed.sensitivePayloadRedacted, true)
    assert.equal(parsed.realEvidenceKind, 'real-groth16-cross-stack')
    assert.equal(parsed.circuitId, 'fsus.anonymous.comment.v2')
    assert.equal(parsed.publicInputLayoutVersion, 3)
    assert.equal(parsed.proofSystem, 'Groth16')
    assert.equal(parsed.artifactHashes.wasmProverSha256, hex('4'))
    assertNoSensitivePayload(result.stdout + result.stderr + JSON.stringify(parsed))
  })
})

test('privacy ZK production smoke rejects boolean-only or hashing-only real evidence', () => {
  withTempDir((dir) => {
    const config = writeJson(dir, 'enabled.json', {
      AnonymousIdentity: {
        ZkProd: {
          Enabled: true
        }
      }
    })
    const realEvidence = writeJson(dir, 'hashing-only.json', {
      status: 'ok',
      nativeVerifier: true,
      wasmProver: true,
      credential: true,
      ticketIssued: true,
      anonymousSubmitPending: true,
      identityHeadersOmitted: true,
      sensitivePayloadRedacted: true,
      evidenceKind: 'hashing-fixture',
      hashingFixtureUsed: true
    })

    const result = runSmoke(
      '--config', config,
      '--real-evidence', realEvidence,
      '--summary', path.join(dir, 'summary.json'),
      '--require-real')

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /real-groth16-cross-stack/)
    assert.match(result.stderr, /hashingFixtureUsed/)
    assertNoSensitivePayload(result.stdout + result.stderr)
  })
})

test('privacy ZK production smoke rejects real evidence without prover performance budget', () => {
  withTempDir((dir) => {
    const config = writeJson(dir, 'enabled.json', {
      AnonymousIdentity: {
        ZkProd: {
          Enabled: true
        }
      }
    })
    const realEvidence = writeJson(dir, 'slow-prover.json', {
      ...completeRealEvidence({
        performance: {
          wasmProverP95Ms: 3500,
          nativeVerifierP99Ms: 75
        }
      })
    })

    const result = runSmoke(
      '--config', config,
      '--real-evidence', realEvidence,
      '--summary', path.join(dir, 'summary.json'),
      '--require-real')

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /wasmProverP95Ms/)
    assert.match(result.stderr, /nativeVerifierP99Ms/)
  })
})

function runSmoke(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8'
  })
}

function assertNoSensitivePayload(text) {
  for (const sample of sensitiveSamples) {
    assert.equal(text.includes(sample), false, `sensitive payload leaked: ${sample}`)
  }
}

function withTempDir(action) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsus-zk-prod-smoke-'))
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

function completeRealEvidence(overrides = {}) {
  return {
    status: 'ok',
    evidenceKind: 'real-groth16-cross-stack',
    circuitId: 'fsus.anonymous.comment.v2',
    publicInputLayoutVersion: 3,
    proofSystem: 'Groth16',
    verifyingKeyHash: hex('a'),
    nativeVerifier: true,
    wasmProver: true,
    credential: true,
    credentialRootActive: true,
    ticketIssued: true,
    anonymousSubmitPending: true,
    identityHeadersOmitted: true,
    sensitivePayloadRedacted: true,
    artifactHashes: {
      r1csSha256: hex('1'),
      provingKeySha256: hex('2'),
      verifyingKeySha256: hex('a'),
      nativeVerifierSha256: hex('3'),
      wasmProverSha256: hex('4')
    },
    crossStack: {
      frontendProofGenerated: true,
      backendProofVerified: true,
      publicInputsMatch: true,
      tamperCasesRejected: true,
      hashingFixtureUsed: false
    },
    performance: {
      wasmProverP95Ms: 2400,
      nativeVerifierP99Ms: 35,
      ...(overrides.performance ?? {})
    },
    ...overrides
  }
}

function hex(ch) {
  return ch.repeat(64)
}
