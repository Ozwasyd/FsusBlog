#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { findTrackedZkResidue } from './zk-retired-residue.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const manifestPath = 'security/zk/provenance/artifact-ownership.manifest.json'
const expectedCircuitId = 'fsus.anonymous.comment.v5'
const expectedLayout = 6

export function validateZkArtifactOwnership({
  root = repositoryRoot,
  manifest = readJson(path.join(root, manifestPath)),
  trackedFiles = listTrackedFiles(root),
  readTrackedFile = (file) => readFileSync(path.join(root, file))
} = {}) {
  const errors = []
  equal(errors, manifest.schema, 'fsusblog.zk.artifact-ownership.v2', 'schema')
  equal(errors, manifest.circuit_id, expectedCircuitId, 'circuit_id')
  equal(errors, Number(manifest.public_input_layout_version), expectedLayout, 'public_input_layout_version')
  equal(errors, manifest.controlled_root, 'artifacts/zk/comment-v5', 'controlled_root')
  equal(errors, manifest.storage_policy?.ordinary_git_for_cryptographic_artifacts, false,
    'ordinary_git_for_cryptographic_artifacts')
  equal(errors, manifest.storage_policy?.production_requires_matching_release_evidence, true,
    'production_requires_matching_release_evidence')

  const allowedTracked = new Set(array(manifest.ordinary_git_files).map(repoPath))
  const normalizedTracked = trackedFiles.map(repoPath)
  const controlledPrefix = `${repoPath(manifest.controlled_root)}/`
  for (const file of normalizedTracked.filter((value) => value.startsWith(controlledPrefix))) {
    if (!allowedTracked.has(file)) errors.push(`cryptographic artifact must not be tracked in ordinary Git: ${file}`)
  }
  for (const file of allowedTracked) {
    if (!normalizedTracked.includes(file) || !existsSync(path.join(root, file))) {
      errors.push(`declared ordinary Git file is missing: ${file}`)
    }
  }

  const authorityPaths = array(manifest.authority_manifests).map(repoPath)
  const [circuit, setup, config] = authorityPaths.map((relativePath) => {
    const absolutePath = path.join(root, relativePath)
    if (!existsSync(absolutePath)) {
      errors.push(`authority manifest is missing: ${relativePath}`)
      return {}
    }
    return readJson(absolutePath)
  })
  for (const [label, document] of [['circuit', circuit], ['setup', setup], ['config', config]]) {
    equal(errors, document.circuit_id, expectedCircuitId, `${label}.circuit_id`)
    equal(errors, Number(document.public_input_layout_version), expectedLayout, `${label}.public_input_layout_version`)
  }

  const declaredExternal = new Map(array(manifest.external_artifacts)
    .map((entry) => [entry.manifest_field, repoPath(entry.path)]))
  const expectedExternal = new Map([
    ['phase2.transcript_path', repoPath(setup.phase2?.transcript_path)],
    ['artifacts.r1cs.path', repoPath(setup.artifacts?.r1cs?.path)],
    ['artifacts.proving_key.path', repoPath(setup.artifacts?.proving_key?.path)],
    ['artifacts.verifying_key.path', repoPath(setup.artifacts?.verifying_key?.path)],
    ['artifacts.wasm_prover_bundle.path', repoPath(setup.artifacts?.wasm_prover_bundle?.path)]
  ])
  for (const [field, expectedPath] of expectedExternal) {
    if (!expectedPath || declaredExternal.get(field) !== expectedPath) {
      errors.push(`external artifact ownership must match trusted setup ${field}`)
    }
    if (normalizedTracked.includes(expectedPath)) {
      errors.push(`external ceremony or delivery artifact must not be Git-tracked: ${expectedPath}`)
    }
  }
  if (declaredExternal.size !== expectedExternal.size) {
    errors.push('external artifact ownership set must exactly match the current trusted setup manifest')
  }
  errors.push(...findTrackedZkResidue({ root, trackedFiles: normalizedTracked, readTrackedFile }))
  return errors
}

function listTrackedFiles(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0').filter(Boolean)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function repoPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '')
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function equal(errors, actual, expected, label) {
  if (actual !== expected) errors.push(`${label} must equal ${String(expected)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? repositoryRoot)
  const errors = validateZkArtifactOwnership({ root })
  const output = path.join(root, '.tmp/security/zk-artifact-ownership-check.json')
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify({
    schema: 'fsusblog.zk.artifact-ownership-check.v2',
    status: errors.length === 0 ? 'ok' : 'failed',
    errors
  }, null, 2)}\n`)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[zk-artifact-ownership] ${error}`)
    process.exitCode = 1
  } else {
    console.log('[zk-artifact-ownership] ok')
  }
}
