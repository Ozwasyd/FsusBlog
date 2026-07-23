import fs from 'node:fs'
import path from 'node:path'

import { listNativeFiles } from './native-test-files.mjs'

const semanticId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/u

function validateUniqueFields(errors, catalog) {
  const fields = [
    ['target id', catalog.targets.map((entry) => entry.id)],
    ['test id', catalog.targets.map((entry) => entry.testId)],
    ['source', catalog.targets.map((entry) => entry.source)],
    ['CMake target', catalog.targets.map((entry) => entry.cmakeTarget)],
    ['profile id', catalog.profiles.map((entry) => entry.id)],
    ['profile matrix tier', catalog.profiles.map((entry) => entry.matrixTier)],
    ['profile receipt', catalog.profiles.map((entry) => entry.receipt)],
    ['corpus id', catalog.corpora.map((entry) => entry.id)]
  ]
  for (const [label, values] of fields) {
    if (values.some((value) => !String(value ?? '').trim())) errors.push(`${label} contains an empty value`)
    if (new Set(values).size !== values.length) errors.push(`${label} must be unique`)
  }
}

function validateSemanticNames(errors, catalog) {
  const names = [
    ...catalog.targets.flatMap((entry) => [entry.id, entry.testId, entry.cmakeTarget]),
    ...catalog.profiles.flatMap((entry) => [entry.id, entry.matrixTier, entry.receipt]),
    ...catalog.corpora.flatMap((entry) => [entry.id, entry.path]),
    ...catalog.supportAssets.flatMap((entry) => [entry.id, entry.path])
  ]
  for (const value of names) {
    if (/(?:issue|pull-request|pr)[-_ ]?\d|#\d/iu.test(String(value))) {
      errors.push(`active native asset name is not semantic: ${value}`)
    }
  }
}

function validateTargets(errors, root, catalog) {
  for (const target of catalog.targets) {
    if (!semanticId.test(String(target.testId))) errors.push(`test ID is not semantic: ${target.testId}`)
    if (target.lifecycleStatus !== 'active') errors.push(`target ${target.id} must declare active lifecycle status`)
    if (target.replacementPolicy !== 'central-retention-ledger') errors.push(`target ${target.id} must use the central retention ledger`)
    if (target.sourceOwner !== catalog.owner) errors.push(`target ${target.id} has a duplicate or mismatched source owner`)
    if (!fs.existsSync(path.join(root, target.source))) errors.push(`target source is missing: ${target.source}`)
  }
}

function validateCmakeAssets(errors, root, catalog) {
  const cmakeAssets = catalog.supportAssets.filter((entry) => entry.kind === 'cmake-target-graph')
  if (cmakeAssets.length !== 1) errors.push('exactly one CMake target graph must be authoritative')
  const cmakeText = cmakeAssets.length === 1 && fs.existsSync(path.join(root, cmakeAssets[0].path))
    ? fs.readFileSync(path.join(root, cmakeAssets[0].path), 'utf8')
    : ''
  for (const target of catalog.targets) {
    if (!cmakeText.includes(`add_executable(${target.cmakeTarget} `)) errors.push(`CMake target is missing or renamed without catalog mapping: ${target.cmakeTarget}`)
    if (target.ctestName && !cmakeText.includes(`add_test(NAME ${target.ctestName} `)) errors.push(`CTest registration is missing: ${target.ctestName}`)
  }

  const discovered = listNativeFiles(root, 'tests/native')
    .filter((file) => /\.(?:cpp|cc|cxx)$/u.test(file) || path.basename(file) === 'CMakeLists.txt')
  const registered = new Set([
    ...catalog.targets.map((entry) => entry.source),
    ...catalog.supportAssets.map((entry) => entry.path)
  ])
  for (const asset of discovered) {
    if (!registered.has(asset)) errors.push(`native asset is not registered: ${asset}`)
  }
  for (const asset of registered) {
    if (!discovered.includes(asset)) errors.push(`registered native asset is missing: ${asset}`)
  }
}

function validateCorpora(errors, root, catalog) {
  const corpusById = new Map(catalog.corpora.map((entry) => [entry.id, entry]))
  for (const target of catalog.targets.filter((entry) => entry.kind === 'fuzz')) {
    const corpus = corpusById.get(target.corpusId)
    if (!corpus) {
      errors.push(`fuzz target ${target.id} has no registered corpus`)
      continue
    }
    if (corpus.required !== true || listNativeFiles(root, corpus.path).length === 0) {
      errors.push(`fuzz corpus ${corpus.id} is missing or empty`)
    }
    if (corpus.targetId !== target.id) errors.push(`fuzz corpus ${corpus.id} has the wrong target owner`)
  }
}

export function validateNativeCatalog({ root, catalog }) {
  const errors = []
  if (catalog?.schema !== 'fsusblog.native-test-assets.v1') errors.push('catalog schema is invalid')
  if (!String(catalog?.owner ?? '').trim()) errors.push('catalog owner is missing')
  if (!String(catalog?.lifecycle?.changePolicy ?? '').includes('tests/test-retention-replacements.json')) {
    errors.push('catalog lifecycle must bind changes to the central retention ledger')
  }
  const normalized = {
    ...catalog,
    targets: catalog?.targets ?? [],
    profiles: catalog?.profiles ?? [],
    corpora: catalog?.corpora ?? [],
    supportAssets: catalog?.supportAssets ?? []
  }
  validateUniqueFields(errors, normalized)
  validateSemanticNames(errors, normalized)
  validateTargets(errors, root, normalized)
  validateCmakeAssets(errors, root, normalized)
  validateCorpora(errors, root, normalized)
  return errors
}
