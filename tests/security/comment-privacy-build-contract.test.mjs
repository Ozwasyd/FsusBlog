import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  commentPrivacyBuildContract,
  validateCommentPrivacyBuild,
  validateCommentPrivacyWasmBuildSource,
  validateRetiredCommentPrivacyBuildResidue
} from '../../tools/security/comment-privacy-build-contract.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')

test('current not-run setup keeps ordinary production artifacts buildable with ZK disabled', () => {
  const result = validateCommentPrivacyBuild({ root, env: { FSUSBLOG_ZK_PRODUCTION_ENABLED: '0' } })
  assert.equal(result.mode, 'disabled')
  assert.equal(result.circuitId, 'fsus.anonymous.comment.v5')
  assert.equal(result.publicInputLayoutVersion, 6)
  assert.equal(result.productionUsable, false)
})

test('explicit production ZK fails closed while the current ceremony is not ready', () => {
  assert.throws(
    () => validateCommentPrivacyBuild({ root, env: { FSUSBLOG_ZK_PRODUCTION_ENABLED: '1' } }),
    /ceremony_status must equal "verified"/u
  )
})

test('explicit production ZK accepts only a fully hash-bound v5 layout-6 setup', t => {
  const fixture = createReadyFixture(t)
  const result = validateCommentPrivacyBuild({
    root: fixture.root,
    env: { FSUSBLOG_ZK_PRODUCTION_ENABLED: '1' }
  })
  assert.equal(result.mode, 'enabled')
  assert.equal(result.provingKeyPath, path.join(fixture.root, fixture.setup.artifacts.proving_key.path))
})

test('enabled browser prover manifest is emitted with the v5 layout-6 identity', t => {
  const fixture = createReadyFixture(t)
  const outputRoot = path.join(fixture.root, 'public', 'wasm')
  mkdirSync(outputRoot, { recursive: true })
  writeFileSync(path.join(outputRoot, 'comment-privacy-prover.js'), 'fixture module\n')
  writeFileSync(path.join(outputRoot, 'comment_privacy_runtime.wasm'), 'fixture wasm\n')
  writeFileSync(path.join(outputRoot, 'comment-privacy-prover.zkey'), 'provingKey-fixture\n')
  const result = spawnSync(process.execPath, ['tools/frontend/write-comment-privacy-prover-manifest.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_REPOSITORY_ROOT: fixture.root,
      FSUSBLOG_FRONTEND_WASM_ROOT: outputRoot,
      FSUSBLOG_ZK_PRODUCTION_ENABLED: '1'
    }
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const manifest = JSON.parse(readFileSync(path.join(outputRoot, 'comment-privacy-prover.manifest.json'), 'utf8'))
  assert.equal(manifest.circuitId, 'fsus.anonymous.comment.v5')
  assert.equal(manifest.publicInputLayoutVersion, 6)
})

test('explicit production ZK rejects retired identity and artifact digest drift', t => {
  const retired = createReadyFixture(t)
  retired.setup.circuit_id = 'fsus.anonymous.comment.v3'
  writeJson(retired.root, commentPrivacyBuildContract.trustedSetupManifest, retired.setup)
  assert.throws(() => validateCommentPrivacyBuild({
    root: retired.root,
    env: { FSUSBLOG_ZK_PRODUCTION_ENABLED: '1' }
  }), /trusted setup circuit_id must equal "fsus\.anonymous\.comment\.v5"/u)

  const drifted = createReadyFixture(t)
  writeFileSync(path.join(drifted.root, drifted.setup.artifacts.proving_key.path), 'tampered')
  assert.throws(() => validateCommentPrivacyBuild({
    root: drifted.root,
    env: { FSUSBLOG_ZK_PRODUCTION_ENABLED: '1' }
  }), /proving_key SHA-256 mismatch/u)
})

test('build contracts contain no retired proving-key restore path', () => {
  for (const relativePath of [
    'ops/docker/FsusBlog.Server.Dockerfile',
    'src/frontend/wasm/build.sh',
    'tools/test/lanes/production-build-artifacts.sh',
    'tools/build-wasm-artifact.sh'
  ]) {
    const source = readFileSync(path.join(root, relativePath), 'utf8')
    assert.deepEqual(validateRetiredCommentPrivacyBuildResidue(source), [], relativePath)
    const retiredKeyPattern = new RegExp([
      `COMMENT_PRIVACY_${'PROVER_KEY_PATH'}`
    ].join('|'), 'u')
    assert.doesNotMatch(source, retiredKeyPattern,
      relativePath)
  }
})

test('Wasm build contract rejects an appended retired prover archive block and compatibility flags', () => {
  const source = readFileSync(path.join(root, 'src/frontend/wasm/build.sh'), 'utf8')
  assert.deepEqual(validateCommentPrivacyWasmBuildSource(source), [])

  const bundleVariable = ['PROVER', 'BUNDLE'].join('_')
  const bundleTarVariable = [bundleVariable, 'TAR'].join('_')
  const bundleEnvironment = ['FSUSBLOG', 'COMMENT', 'PROVER', 'BUNDLE'].join('_')
  const retiredVersion = ['v', '3'].join('')
  const retiredLayout = ['layout', '4'].join('')
  const retiredArchiveBlock = [
    `${bundleVariable}="\${${bundleEnvironment}:-\${ROOT_DIR}/../../artifacts/zk/comment-${retiredVersion}-${retiredLayout}/delivery/comment_${retiredVersion}_prover_wasm.tar.gz}"`,
    `${bundleTarVariable}="\${${bundleVariable}}.tmp.tar"`,
    `tar --sort=name -cf "\${${bundleTarVariable}}" comment-privacy-prover.js comment-privacy-prover.zkey`,
    `gzip -n -9 -f "\${${bundleTarVariable}}"`
  ].join('\n')
  const archiveErrors = validateCommentPrivacyWasmBuildSource(`${source}\n${retiredArchiveBlock}\n`)
  for (const token of [bundleEnvironment, bundleVariable, bundleTarVariable]) {
    assert.ok(archiveErrors.some((error) => error.endsWith(token)), `missing fail-closed error for ${token}`)
  }
  assert.match(archiveErrors.join('\n'), /prover archive under artifacts\/zk/u)
  assert.match(archiveErrors.join('\n'), /with tar/u)
  assert.match(archiveErrors.join('\n'), /with gzip/u)

  const retiredKeyEnvironment = ['FSUSBLOG', 'COMMENT', 'PROVER', 'KEY'].join('_')
  assert.match(
    validateCommentPrivacyWasmBuildSource(`${source}\n${retiredKeyEnvironment}=fixture\n`).join('\n'),
    /retired comment-prover compatibility token/u
  )

  const legitimateArchiveBlock = [
    'AEDS_RUNTIME_ARCHIVE="build/aeds-runtime.tar.gz"',
    'tar -cf "${AEDS_RUNTIME_ARCHIVE%.gz}" aeds-runtime-manifest.json wasm-manifest.aeds',
    'gzip -9 -f "${AEDS_RUNTIME_ARCHIVE%.gz}"',
    'VERIFIER_FIXTURE="artifacts/zk/comment-v5/verifier-fixture.tar.gz"'
  ].join('\n')
  assert.deepEqual(
    validateCommentPrivacyWasmBuildSource(`${source}\n${legitimateArchiveBlock}\n`),
    [],
    'non-prover AEDS and verifier-fixture archives remain valid'
  )
})

function createReadyFixture(t) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-build-contract-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  const artifactPaths = {
    transcript: 'artifacts/zk/comment-v5/phase2/transcript.json',
    r1cs: 'artifacts/zk/comment-v5/comment_v5.r1cs',
    provingKey: 'artifacts/zk/comment-v5/comment_v5_final.fsg16pk',
    verifyingKey: 'artifacts/zk/comment-v5/comment_v5_verifying_key.bin',
    bundle: 'artifacts/zk/comment-v5/comment_v5_prover_wasm.tar.gz'
  }
  const hashes = Object.fromEntries(Object.entries(artifactPaths).map(([name, relativePath]) => {
    const content = `${name}-fixture\n`
    const absolutePath = path.join(fixtureRoot, relativePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content)
    return [name, sha256(content)]
  }))
  const setup = {
    circuit_id: 'fsus.anonymous.comment.v5',
    public_input_layout_version: 6,
    ceremony_status: 'verified',
    production_usable: true,
    phase2: {
      status: 'verified',
      minimum_contributions: 3,
      transcript_path: artifactPaths.transcript,
      transcript_sha256: hashes.transcript
    },
    artifacts: {
      r1cs: artifact('r1cs'),
      proving_key: artifact('provingKey'),
      verifying_key: artifact('verifyingKey'),
      wasm_prover_bundle: artifact('bundle')
    },
    verifying_key_hash: hashes.verifyingKey
  }
  const config = {
    circuit_id: 'fsus.anonymous.comment.v5',
    public_input_layout_version: 6,
    trusted_setup_manifest: commentPrivacyBuildContract.trustedSetupManifest,
    circuit_manifest: commentPrivacyBuildContract.circuitManifest,
    production_usable: true,
    verifying_key_path: artifactPaths.verifyingKey,
    verifying_key_hash: hashes.verifyingKey
  }
  const circuit = {
    circuit_id: 'fsus.anonymous.comment.v5',
    public_input_layout_version: 6,
    production_usable: true,
    verifying_key_hash: hashes.verifyingKey
  }
  writeJson(fixtureRoot, commentPrivacyBuildContract.trustedSetupManifest, setup)
  writeJson(fixtureRoot, commentPrivacyBuildContract.verifyingKeyConfig, config)
  writeJson(fixtureRoot, commentPrivacyBuildContract.circuitManifest, circuit)
  return { root: fixtureRoot, setup }

  function artifact(name) {
    return { path: artifactPaths[name], sha256: hashes[name], status: 'verified' }
  }
}

function writeJson(fixtureRoot, relativePath, value) {
  const absolutePath = path.join(fixtureRoot, relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
