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
          BbsCredentialReady: true
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
      status: 'ok',
      nativeVerifier: true,
      wasmProver: true,
      bbsCredential: true,
      ticketIssued: true,
      anonymousSubmitPending: true,
      identityHeadersOmitted: true,
      sensitivePayloadRedacted: true,
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
    assert.equal(parsed.bbsCredential, true)
    assert.equal(parsed.ticketIssued, true)
    assert.equal(parsed.anonymousSubmitPending, true)
    assert.equal(parsed.identityHeadersOmitted, true)
    assert.equal(parsed.sensitivePayloadRedacted, true)
    assertNoSensitivePayload(result.stdout + result.stderr + JSON.stringify(parsed))
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
