#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../test-matrix/parse-matrix.mjs'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const semanticId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/u
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function listFiles(root, relativeDirectory) {
  const absolute = path.join(root, relativeDirectory)
  if (!fs.existsSync(absolute)) return []
  return fs.readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(relativeDirectory, entry.name)
      return entry.isDirectory() ? listFiles(root, relative) : [relative]
    })
    .sort()
}

function fail(errors, message) {
  errors.push(message)
}

export function validateNativeReceipt(receipt, profile, target, { expectedCommit = null } = {}) {
  const errors = []
  if (receipt?.schema !== 'fsusblog.native-test-receipt.v1') fail(errors, 'receipt schema is invalid')
  if (receipt?.profile !== profile?.id) fail(errors, `receipt profile must be ${profile?.id}`)
  if (receipt?.testId !== target?.testId) fail(errors, `receipt testId must be ${target?.testId}`)
  if (receipt?.target !== target?.cmakeTarget) fail(errors, `receipt target must be ${target?.cmakeTarget}`)
  if (!/^[0-9a-f]{40}$/u.test(String(receipt?.source?.commit ?? ''))) fail(errors, 'receipt source commit is invalid')
  if (expectedCommit && receipt?.source?.commit !== expectedCommit) fail(errors, 'receipt source commit does not match the requested commit')
  if (!sha256Pattern.test(String(receipt?.source?.inputDigest ?? ''))) fail(errors, 'receipt source input digest is invalid')
  if (!String(receipt?.toolchain?.compilerPath ?? '').trim()) fail(errors, 'receipt compiler path is missing')
  if (!String(receipt?.toolchain?.compilerVersion ?? '').trim()) fail(errors, 'receipt compiler version is missing')
  if (!String(receipt?.toolchain?.cmakeVersion ?? '').trim()) fail(errors, 'receipt CMake version is missing')
  if (!Array.isArray(receipt?.flags?.sanitizers)) fail(errors, 'receipt sanitizer flags are missing')
  if (!Array.isArray(receipt?.flags?.fuzzer)) fail(errors, 'receipt fuzzer flags are missing')
  if (!sha256Pattern.test(String(receipt?.corpus?.identity ?? ''))) fail(errors, 'receipt corpus identity is invalid')
  if (!sha256Pattern.test(String(receipt?.crashArtifacts?.digest ?? ''))) fail(errors, 'receipt crash artifact digest is invalid')
  if (!Number.isInteger(receipt?.crashArtifacts?.count) || receipt.crashArtifacts.count < 0) fail(errors, 'receipt crash artifact count is invalid')
  if (!['passed', 'failed', 'blocked'].includes(receipt?.outcome)) fail(errors, 'receipt outcome is invalid')
  if (receipt?.outcome === 'blocked' && !String(receipt?.preflight?.missingReason ?? '').trim()) {
    fail(errors, 'blocked receipt must include a structured missing reason')
  }
  return errors
}

export function validateNativeGovernance({ root, catalog, matrix }) {
  const errors = []
  if (catalog?.schema !== 'fsusblog.native-test-assets.v1') fail(errors, 'catalog schema is invalid')
  if (!String(catalog?.owner ?? '').trim()) fail(errors, 'catalog owner is missing')
  if (!String(catalog?.lifecycle?.changePolicy ?? '').includes('tests/test-retention-replacements.json')) {
    fail(errors, 'catalog lifecycle must bind changes to the central retention ledger')
  }

  const targets = catalog?.targets ?? []
  const profiles = catalog?.profiles ?? []
  const corpora = catalog?.corpora ?? []
  const supportAssets = catalog?.supportAssets ?? []
  const tiers = new Map((matrix?.tiers ?? []).map((tier) => [tier.id, tier]))
  const uniqueFields = [
    ['target id', targets.map((entry) => entry.id)],
    ['test id', targets.map((entry) => entry.testId)],
    ['source', targets.map((entry) => entry.source)],
    ['CMake target', targets.map((entry) => entry.cmakeTarget)],
    ['profile id', profiles.map((entry) => entry.id)],
    ['profile matrix tier', profiles.map((entry) => entry.matrixTier)],
    ['profile receipt', profiles.map((entry) => entry.receipt)],
    ['corpus id', corpora.map((entry) => entry.id)]
  ]
  for (const [label, values] of uniqueFields) {
    if (values.some((value) => !String(value ?? '').trim())) fail(errors, `${label} contains an empty value`)
    if (new Set(values).size !== values.length) fail(errors, `${label} must be unique`)
  }

  const catalogNames = [
    ...targets.flatMap((entry) => [entry.id, entry.testId, entry.cmakeTarget]),
    ...profiles.flatMap((entry) => [entry.id, entry.matrixTier, entry.receipt]),
    ...corpora.flatMap((entry) => [entry.id, entry.path]),
    ...supportAssets.flatMap((entry) => [entry.id, entry.path])
  ]
  for (const value of catalogNames) {
    if (/(?:issue|pull-request|pr)[-_ ]?\d|#\d/iu.test(String(value))) {
      fail(errors, `active native asset name is not semantic: ${value}`)
    }
  }
  for (const target of targets) {
    if (!semanticId.test(String(target.testId))) fail(errors, `test ID is not semantic: ${target.testId}`)
    if (target.lifecycleStatus !== 'active') fail(errors, `target ${target.id} must declare active lifecycle status`)
    if (target.replacementPolicy !== 'central-retention-ledger') {
      fail(errors, `target ${target.id} must use the central retention ledger`)
    }
    if (target.sourceOwner !== catalog.owner) fail(errors, `target ${target.id} has a duplicate or mismatched source owner`)
    if (!fs.existsSync(path.join(root, target.source))) fail(errors, `target source is missing: ${target.source}`)
  }

  const cmakeAssets = supportAssets.filter((entry) => entry.kind === 'cmake-target-graph')
  if (cmakeAssets.length !== 1) fail(errors, 'exactly one CMake target graph must be authoritative')
  const cmakeText = cmakeAssets.length === 1 && fs.existsSync(path.join(root, cmakeAssets[0].path))
    ? fs.readFileSync(path.join(root, cmakeAssets[0].path), 'utf8')
    : ''
  for (const target of targets) {
    if (!cmakeText.includes(`add_executable(${target.cmakeTarget} `)) {
      fail(errors, `CMake target is missing or renamed without catalog mapping: ${target.cmakeTarget}`)
    }
    if (target.ctestName && !cmakeText.includes(`add_test(NAME ${target.ctestName} `)) {
      fail(errors, `CTest registration is missing: ${target.ctestName}`)
    }
  }

  const discoveredNativeAssets = listFiles(root, 'tests/native')
    .filter((file) => /\.(?:cpp|cc|cxx)$/u.test(file) || path.basename(file) === 'CMakeLists.txt')
  const registeredNativeAssets = new Set([
    ...targets.map((entry) => entry.source),
    ...supportAssets.map((entry) => entry.path)
  ])
  for (const asset of discoveredNativeAssets) {
    if (!registeredNativeAssets.has(asset)) fail(errors, `native asset is not registered: ${asset}`)
  }
  for (const asset of registeredNativeAssets) {
    if (!discoveredNativeAssets.includes(asset)) fail(errors, `registered native asset is missing: ${asset}`)
  }

  const corpusById = new Map(corpora.map((entry) => [entry.id, entry]))
  for (const target of targets.filter((entry) => entry.kind === 'fuzz')) {
    const corpus = corpusById.get(target.corpusId)
    if (!corpus) {
      fail(errors, `fuzz target ${target.id} has no registered corpus`)
      continue
    }
    const corpusFiles = listFiles(root, corpus.path)
    if (corpus.required !== true || corpusFiles.length === 0) {
      fail(errors, `fuzz corpus ${corpus.id} is missing or empty`)
    }
    if (corpus.targetId !== target.id) fail(errors, `fuzz corpus ${corpus.id} has the wrong target owner`)
  }

  for (const profile of profiles) {
    const profileTargets = targets.filter((target) => target.profile === profile.id)
    if (profileTargets.length !== 1) fail(errors, `profile ${profile.id} must own exactly one native target`)
    const tier = tiers.get(profile.matrixTier)
    if (!tier) {
      fail(errors, `matrix tier is missing: ${profile.matrixTier}`)
      continue
    }
    if (tier.owner !== catalog.owner) fail(errors, `matrix tier ${tier.id} has the wrong owner`)
    if (!String(tier.command ?? '').includes(`--profile ${profile.id}`)) {
      fail(errors, `matrix tier ${tier.id} does not execute profile ${profile.id}`)
    }
    if (!(tier.evidence ?? []).includes(profile.receipt)) fail(errors, `matrix tier ${tier.id} does not own receipt ${profile.receipt}`)
  }

  const production = tiers.get('production-correctness')
  const releaseFinal = tiers.get('release-final')
  const smoke = profiles.find((profile) => profile.consumers?.includes('production-fresh'))
  const fuzz = profiles.find((profile) => profile.consumers?.includes('release-final'))
  if (!smoke || (production?.dependsOn ?? []).filter((tierId) => tierId === smoke.matrixTier).length !== 1) {
    fail(errors, 'production fresh must consume the native smoke tier exactly once')
  }
  if (!fuzz || (releaseFinal?.dependsOn ?? []).filter((tierId) => tierId === fuzz.matrixTier).length !== 1) {
    fail(errors, 'release-final must consume the native fuzz/sanitizer tier exactly once')
  }
  if (smoke && (tiers.get(smoke.matrixTier)?.dependsOn ?? []).includes(fuzz?.matrixTier)) {
    fail(errors, 'native smoke must not be blocked by the fuzz/sanitizer tier')
  }
  return errors
}

export function loadNativeGovernance(root = moduleRoot) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/native-test-assets.json'), 'utf8'))
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  return { catalog, matrix }
}

function main() {
  const { catalog, matrix } = loadNativeGovernance(moduleRoot)
  const errors = validateNativeGovernance({ root: moduleRoot, catalog, matrix })
  if (errors.length > 0) {
    console.error(`native test governance failed (${errors.length} errors):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`native test governance passed (${catalog.targets.length} targets, ${catalog.corpora.length} corpus, ${catalog.profiles.length} profiles)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
