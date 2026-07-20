#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const commentPrivacyBuildContract = Object.freeze({
  circuitId: 'fsus.anonymous.comment.v5',
  publicInputLayoutVersion: 6,
  trustedSetupManifest: 'security/zk/provenance/comment-v5-trusted-setup.manifest.json',
  verifyingKeyConfig: 'config/zk/anonymous-comment-v5-verifying-key.manifest.json',
  circuitManifest: 'security/zk/contracts/comment-v5-circuit.manifest.json',
  productionOutputs: Object.freeze([
    'comment-privacy-prover.zkey',
    'comment-privacy-prover.manifest.json'
  ])
})

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sha256Pattern = /^[a-f0-9]{64}$/u

export function productionZkRequested(env = process.env) {
  const value = String(env.FSUSBLOG_ZK_PRODUCTION_ENABLED ?? '0').trim()
  if (value !== '0' && value !== '1') {
    throw new Error('FSUSBLOG_ZK_PRODUCTION_ENABLED must be 0 or 1')
  }
  return value === '1'
}

export function validateCommentPrivacyBuild({
  root = process.env.FSUSBLOG_REPOSITORY_ROOT || defaultRoot,
  env = process.env
} = {}) {
  const repositoryRoot = path.resolve(root)
  const requested = productionZkRequested(env)
  const setup = readJson(repositoryRoot, commentPrivacyBuildContract.trustedSetupManifest)
  const config = readJson(repositoryRoot, commentPrivacyBuildContract.verifyingKeyConfig)
  const circuit = readJson(repositoryRoot, commentPrivacyBuildContract.circuitManifest)

  for (const [label, document] of [['trusted setup', setup], ['verifying-key config', config], ['circuit', circuit]]) {
    requireEqual(document.circuit_id, commentPrivacyBuildContract.circuitId, `${label} circuit_id`)
    requireEqual(Number(document.public_input_layout_version), commentPrivacyBuildContract.publicInputLayoutVersion,
      `${label} public_input_layout_version`)
  }

  if (!requested) {
    return {
      mode: 'disabled',
      circuitId: commentPrivacyBuildContract.circuitId,
      publicInputLayoutVersion: commentPrivacyBuildContract.publicInputLayoutVersion,
      productionUsable: setup.production_usable === true
    }
  }

  requireEqual(setup.ceremony_status, 'verified', 'trusted setup ceremony_status')
  requireEqual(setup.production_usable, true, 'trusted setup production_usable')
  requireEqual(config.production_usable, true, 'verifying-key config production_usable')
  requireEqual(circuit.production_usable, true, 'circuit production_usable')
  requireEqual(config.trusted_setup_manifest, commentPrivacyBuildContract.trustedSetupManifest,
    'verifying-key config trusted_setup_manifest')
  requireEqual(config.circuit_manifest, commentPrivacyBuildContract.circuitManifest,
    'verifying-key config circuit_manifest')

  const phase2 = setup.phase2 ?? {}
  requireEqual(phase2.status, 'verified', 'trusted setup phase2.status')
  if (!Number.isInteger(phase2.minimum_contributions) || phase2.minimum_contributions < 3) {
    throw new Error('trusted setup phase2.minimum_contributions must be at least 3')
  }
  verifyBoundFile(repositoryRoot, phase2.transcript_path, phase2.transcript_sha256, 'phase2 transcript')

  for (const name of ['r1cs', 'proving_key', 'verifying_key', 'wasm_prover_bundle']) {
    const artifact = setup.artifacts?.[name]
    if (!artifact || !['required', 'verified'].includes(artifact.status)) {
      throw new Error(`trusted setup artifact ${name} must be required or verified`)
    }
    verifyBoundFile(repositoryRoot, artifact.path, artifact.sha256, `trusted setup artifact ${name}`)
  }

  const verifyingKeyHash = requireSha256(setup.verifying_key_hash, 'trusted setup verifying_key_hash')
  requireEqual(setup.artifacts.verifying_key.sha256, verifyingKeyHash,
    'trusted setup verifying-key artifact hash')
  requireEqual(config.verifying_key_hash, verifyingKeyHash, 'verifying-key config hash')
  requireEqual(config.verifying_key_path, setup.artifacts.verifying_key.path, 'verifying-key config path')
  requireEqual(circuit.verifying_key_hash, verifyingKeyHash, 'circuit verifying_key_hash')

  return {
    mode: 'enabled',
    circuitId: commentPrivacyBuildContract.circuitId,
    publicInputLayoutVersion: commentPrivacyBuildContract.publicInputLayoutVersion,
    productionUsable: true,
    provingKeyPath: resolveRepoFile(repositoryRoot, setup.artifacts.proving_key.path, 'proving key')
  }
}

function readJson(root, relativePath) {
  const absolutePath = resolveRepoFile(root, relativePath, relativePath)
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'))
  } catch (error) {
    throw new Error(`${relativePath} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolveRepoFile(root, value, label) {
  const raw = String(value ?? '').trim()
  if (!raw || path.isAbsolute(raw)) throw new Error(`${label} path must be repository-relative`)
  const absolutePath = path.resolve(root, raw)
  const relative = path.relative(root, absolutePath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes the repository root`)
  }
  if (!existsSync(absolutePath)) throw new Error(`${label} is missing: ${raw}`)
  return absolutePath
}

function verifyBoundFile(root, artifactPath, expectedHash, label) {
  const hash = requireSha256(expectedHash, `${label} sha256`)
  const absolutePath = resolveRepoFile(root, artifactPath, label)
  const actualHash = createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
  if (actualHash !== hash) throw new Error(`${label} SHA-256 mismatch`)
}

function requireSha256(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!sha256Pattern.test(normalized)) throw new Error(`${label} must be a complete SHA-256 digest`)
  return normalized
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must equal ${JSON.stringify(expected)}`)
}

async function main() {
  const result = validateCommentPrivacyBuild()
  const command = process.argv[2] ?? '--check'
  if (command === '--print-mode') {
    process.stdout.write(`${result.mode}\n`)
    return
  }
  if (command === '--print-proving-key') {
    if (result.mode !== 'enabled') throw new Error('production ZK is disabled')
    process.stdout.write(`${result.provingKeyPath}\n`)
    return
  }
  if (command !== '--check') throw new Error(`unknown command: ${command}`)
  console.log(`[comment-privacy-build] mode=${result.mode} circuit=${result.circuitId} layout=${result.publicInputLayoutVersion}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[comment-privacy-build] failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
