import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const fixtureManifestPath = path.join(repoRoot, 'tests/fixtures/zk/comment-v2/mcl-pairing/fixture.manifest.json')
const fixtureProject = path.join(repoRoot, 'tools/security/ZkCommentV2MclFixture/FsusBlog.ZkCommentV2MclFixture.csproj')
const publicWasmRoot = path.resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT
  || path.join(repoRoot, 'src/frontend/public/wasm'))
const mclRunBuildArgs = process.env.FSUSBLOG_ZK_MCL_NO_BUILD === '1'
  ? ['--no-build']
  : []

test('comment v2 MCL pairing fixture materializes verifier, proof, public inputs and tamper artifacts', () => {
  assert.ok(existsSync(fixtureManifestPath), 'comment.v2 MCL pairing fixture manifest must exist')
  const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf8'))

  assert.equal(manifest.schema, 'fsusblog.zk.comment-v2-cross-stack-fixture.v1')
  assert.equal(manifest.circuit_id, 'fsus.anonymous.comment.v3')
  assert.equal(manifest.public_input_layout_version, 4)
  assert.equal(manifest.evidence_kind, 'mcl-groth16-pairing-equation')
  assert.equal(manifest.backend_verifier, 'managed:mcl')
  assert.equal(manifest.hashing_fixture_used, false)
  assert.equal(manifest.production_usable, false)
  assert.equal(manifest.performance?.native_verifier_p99_ms_max, 50)

  for (const key of ['verifying_key', 'proof', 'public_inputs', 'tamper_cases']) {
    const artifact = manifest.artifacts?.[key]
    assert.ok(artifact?.path, `artifact ${key} path is required`)
    assert.match(artifact.sha256 ?? '', /^[a-f0-9]{64}$/u, `artifact ${key} sha256 is required`)
    const artifactPath = path.join(repoRoot, artifact.path)
    assert.ok(existsSync(artifactPath), `artifact ${key} must exist at ${artifact.path}`)
    assert.equal(sha256File(artifactPath), artifact.sha256, `artifact ${key} sha256 mismatch`)
  }

  const tamperCases = JSON.parse(readFileSync(path.join(repoRoot, manifest.artifacts.tamper_cases.path), 'utf8'))
  const ids = new Set(tamperCases.cases.map((entry) => entry.id))
  for (const id of [
    'tamper-proof-byte',
    'tamper-nullifier-hash',
    'tamper-scope',
    'tamper-credential-root',
    'tamper-revocation-root',
    'tamper-issuer-public-key-hash',
    'tamper-verifying-key-hash'
  ]) {
    assert.ok(ids.has(id), `tamper case ${id} is required`)
  }
})

test('comment v2 MCL tool writes self-written trusted setup artifacts and manifest bindings', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsus-zk-comment-v2-setup-'))
  try {
    const result = spawnSync('dotnet', [
      'run',
      ...mclRunBuildArgs,
      '--project',
      fixtureProject,
      '--',
      '--write-production-artifacts',
      '--out',
      dir
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120000
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const setup = JSON.parse(readFileSync(path.join(dir, 'comment-v2-trusted-setup.manifest.json'), 'utf8'))
    const config = JSON.parse(readFileSync(path.join(dir, 'anonymous-comment-v2-verifying-key.manifest.json'), 'utf8'))

    assert.equal(setup.ceremony_status, 'verified')
    assert.equal(setup.production_usable, true)
    assert.match(setup.verifying_key_hash, /^[a-f0-9]{64}$/u)
    assert.equal(config.production_usable, true)
    assert.equal(config.verifying_key_hash, setup.verifying_key_hash)
    assert.equal(setup.artifacts.verifying_key.sha256, setup.verifying_key_hash)

    for (const key of [
      'r1cs',
      'groth16_r1cs',
      'proving_key',
      'verifying_key',
      'verifying_key_json',
      'wasm_prover_bundle'
    ]) {
      const artifact = setup.artifacts[key]
      assert.ok(artifact.path, `setup artifact ${key} path is required`)
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/u, `setup artifact ${key} sha256 is required`)
      const artifactPath = path.isAbsolute(artifact.path)
        ? artifact.path
        : path.join(repoRoot, artifact.path)
      assert.ok(existsSync(artifactPath), `setup artifact ${key} must exist`)
      assert.equal(sha256File(artifactPath), artifact.sha256, `setup artifact ${key} sha mismatch`)
    }

    const verify = spawnSync('dotnet', [
      'run',
      '--no-build',
      '--project',
      fixtureProject,
      '--',
      '--verify-setup',
      setup.phase1.transcript_path,
      setup.phase2.transcript_path,
      setup.artifacts.proving_key.path,
      setup.artifacts.verifying_key.path
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120000
    })
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('comment v3 browser wasm prover bundle requires a fresh setup before cross-stack verification', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsus-zk-comment-v2-wasm-proof-'))
  const previousFetch = globalThis.fetch
  try {
    const vkConfig = JSON.parse(readFileSync(path.join(repoRoot, 'config/zk/anonymous-comment-v2-verifying-key.manifest.json'), 'utf8'))
    assert.equal(vkConfig.circuit_id, 'fsus.anonymous.comment.v3')
    assert.equal(vkConfig.public_input_layout_version, 4)
    if (vkConfig.production_usable !== true) {
      assert.equal(vkConfig.artifact_status, 'setup-required')
      assert.equal(vkConfig.verifying_key_hash, '')
      assert.equal(existsSync(path.join(repoRoot, vkConfig.verifying_key_path)), false)
      return
    }

    const manifestPath = path.join(publicWasmRoot, 'comment-privacy-prover.manifest.json')
    const modulePath = path.join(publicWasmRoot, 'comment-privacy-prover.js')
    const wasmPath = path.join(publicWasmRoot, 'comment_privacy_runtime.wasm')
    const provingKeyPath = path.join(publicWasmRoot, 'comment-privacy-prover.zkey')
    for (const file of [manifestPath, modulePath, wasmPath, provingKeyPath]) {
      assert.ok(existsSync(file), `${path.relative(repoRoot, file)} must exist`)
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    globalThis.fetch = async (url) => {
      const normalized = String(url)
      if (normalized === '/wasm/comment-privacy-prover.zkey') {
        return new Response(readFileSync(provingKeyPath), { status: 200 })
      }
      if (normalized === '/wasm/comment_privacy_runtime.wasm') {
        return new Response(readFileSync(wasmPath), { status: 200 })
      }
      return new Response(null, { status: 404 })
    }

    const module = await import(pathToFileURL(modulePath).href)
    const prover = module.createCommentPrivacyProver()
    const encoder = new TextEncoder()
    const request = {
      manifest: {
        ...manifest,
        wasmUrl: wasmPath
      },
      scope: 'article:42',
      rootVersion: `20260620:${vkConfig.verifying_key_hash}`,
      metadataBytes: new Uint8Array([1, 2, 3]),
      credentialEpoch: 7,
      circuitNumericId: 7,
      publicInputLayoutVersion: 4,
      circuitId: 'fsus.anonymous.comment.v3',
      verifyingKeyHash: vkConfig.verifying_key_hash,
      issuerPublicKeyHash: 'f'.repeat(64),
      policyHash: '9'.repeat(64),
      credentialRoot: encoder.encode('credential-root-active'),
      revocationRoot: encoder.encode('revocation-root-active'),
      circuitMetadata: encoder.encode('comment-v2-cross-stack'),
      credentialLevel: 'trusted',
      reputationBucket: 'trusted',
      credentialSecret: new Uint8Array(32).fill(0x42),
      issuerSignature: new Uint8Array(32).fill(0x24),
      revocationWitness: new Uint8Array([1])
    }

    await prover.prewarm({ manifest: request.manifest })
    const proof = await prover.prepareProof(request)
    assert.equal(proof.proofBytes.byteLength, 138)
    assert.ok(proof.publicInputs.byteLength > 0)
    assert.equal(proof.nullifierHash.byteLength, 32)

    const proofPath = path.join(dir, 'proof.bin')
    const publicInputsPath = path.join(dir, 'public-inputs.bin')
    writeFileSync(proofPath, proof.proofBytes)
    writeFileSync(publicInputsPath, proof.publicInputs)

    const verify = spawnSync('dotnet', [
      'run',
      ...mclRunBuildArgs,
      '--project',
      fixtureProject,
      '--',
      '--verify-proof',
      'tests/fixtures/zk/comment-v2/mcl-pairing/comment_v2_mcl_pairing.vk',
      publicInputsPath,
      proofPath
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120000
    })
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`)
  } finally {
    globalThis.fetch = previousFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}
