#!/usr/bin/env node
/**
 * Canonical test-surface discovery for the repository test inventory.
 *
 * Membership is projected from four authorities:
 *   1. directory closure (tests/backend, tests/frontend, tests/tools,
 *      tests/native, tests/security);
 *   2. matrix tier commands, evidence and artifacts;
 *   3. the coverage registry evidence paths;
 *   4. the backend requirement catalog profile commands/evidence paths.
 * Adapter capability decides the final classification. A referenced
 * executable entrypoint that has no adapter record (or is classified as a
 * non-executable support/fixture surface) fails closed.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { parseMatrix } from '../test-matrix/parse-matrix.mjs'
import { ADAPTER_VERSION, SUPPORT_CLASSIFICATION, classifyFile } from './adapters.mjs'
import { INVENTORY_SCHEMA, validateInventoryArtifact } from './schema.mjs'

export const DIRECTORY_CLOSURE = [
  'tests/backend',
  'tests/frontend',
  'tests/tools',
  'tests/native',
  'tests/security'
]

// Canonical tooling test surface. These trees are declared by matrix/coverage
// requirement governance as executable test evidence; the membership rule
// mirrors the historical retention closure so the replacement ledger stays
// authoritative.
export const TOOLS_DIRECTORY_CLOSURE = [
  'tools/test',
  'tools/coverage',
  'tools/security'
]

const TOOLS_ROOT_CHECK_FILES = /^tools\/check-.*\.(?:mjs|sh)$/u
const TOOLS_EXACT_FILES = [
  'tools/docs/generate-testing-docs.mjs',
  'tools/check-workflow-matrix-sync.mjs',
  'tools/run-test-matrix.mjs'
]

const WALK_IGNORE_DIRS = new Set([
  'bin',
  'obj',
  'node_modules',
  'coverage',
  'test-results',
  'TestResults',
  'playwright-report',
  'dist',
  '.tmp',
  '.artifacts'
])

const EXECUTABLE_EXTENSIONS = new Set([
  '.sh',
  '.mjs',
  '.js',
  '.cjs',
  '.mts',
  '.ts',
  '.ps1'
])

const DECLARATION_DIRECTORY = 'directory'

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function fileDigest(absolutePath) {
  return sha256(readFileSync(absolutePath))
}

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return 'null'
}

function walkFiles(root, relativeDirectory, results = new Map()) {
  const absolute = path.join(root, relativeDirectory)
  if (!existsSync(absolute)) return results
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      if (WALK_IGNORE_DIRS.has(entry.name)) continue
      walkFiles(root, relative, results)
    } else if (entry.isFile()) {
      const bucket = results.get(relative) ?? { declaredBy: new Set(), executable: false }
      bucket.declaredBy.add(DECLARATION_DIRECTORY)
      results.set(relative, bucket)
    }
  }
  return results
}

function collectToolsClosure(root, results) {
  const addFile = (relative) => {
    const bucket = results.get(relative) ?? { declaredBy: new Set(), executable: false }
    bucket.declaredBy.add(DECLARATION_DIRECTORY)
    results.set(relative, bucket)
  }
  for (const directory of TOOLS_DIRECTORY_CLOSURE) {
    const absolute = path.join(root, directory)
    if (!existsSync(absolute)) continue
    const predicate = directory === 'tools/security'
      ? (file) => /\.mjs$/u.test(file) && /\/check-[^/]+$/u.test(file)
      : (file) => /\.(?:sh|mjs)$/u.test(file)
    const files = walkFiles(root, directory, new Map())
    for (const relative of files.keys()) {
      if (predicate(relative)) addFile(relative)
    }
  }
  if (existsSync(path.join(root, 'tools'))) {
    for (const entry of readdirSync(path.join(root, 'tools'), { withFileTypes: true })) {
      const relative = `tools/${entry.name}`
      if (entry.isFile() && TOOLS_ROOT_CHECK_FILES.test(relative)) addFile(relative)
    }
  }
  for (const relative of TOOLS_EXACT_FILES) {
    if (existsSync(path.join(root, relative))) addFile(relative)
  }
}

function commandReferencedFiles(command) {
  const refs = []
  for (const token of String(command ?? '').split(/\s+/)) {
    const normalized = token.replace(/^['"]|['"]$/g, '').replace(/\\$/, '').replace(/^\.\//, '')
    if (!/^(tools|tests)\//u.test(normalized)) continue
    refs.push(normalized)
  }
  return refs
}

function matrixProjections(matrix) {
  const refs = []
  const tierIds = []
  for (const tier of matrix.tiers ?? []) {
    tierIds.push(tier.id)
    for (const file of commandReferencedFiles(tier.command)) {
      refs.push({ path: file, declaration: `matrix:command:${tier.id}` })
    }
    for (const pathValue of [...(tier.evidence ?? []), ...(tier.artifacts ?? [])]) {
      if (typeof pathValue !== 'string' || pathValue.startsWith('.tmp/') || pathValue.includes('*')) continue
      if (!/^(tools|tests)\//u.test(pathValue)) continue
      const declaration = (tier.evidence ?? []).includes(pathValue)
        ? `matrix:evidence:${tier.id}`
        : `matrix:artifact:${tier.id}`
      refs.push({ path: pathValue, declaration })
    }
  }
  return { refs, tierIds }
}

function addProjectedPath(root, relative, declaration, candidates) {
  const absolute = path.join(root, relative)
  if (!existsSync(absolute)) return
  if (statSync(absolute).isDirectory()) {
    const files = walkFiles(root, relative, new Map())
    for (const file of files.keys()) {
      const bucket = candidates.get(file) ?? { declaredBy: new Set(), executable: false }
      bucket.declaredBy.add(declaration)
      candidates.set(file, bucket)
    }
    return
  }
  if (!statSync(absolute).isFile()) return
  const bucket = candidates.get(relative) ?? { declaredBy: new Set(), executable: false }
  bucket.declaredBy.add(declaration)
  candidates.set(relative, bucket)
}

function coverageProjections(coverageRegistry) {
  const refs = []
  const coverageIds = []
  for (const entry of coverageRegistry.entries ?? []) {
    coverageIds.push(entry.id)
    for (const pathValue of entry.evidencePaths ?? []) {
      if (typeof pathValue !== 'string' || pathValue.startsWith('.tmp/') || pathValue.includes('*')) continue
      if (!/^(tools|tests)\//u.test(pathValue)) continue
      refs.push({ path: pathValue, declaration: `coverage:${entry.id}` })
    }
  }
  return { refs, coverageIds }
}

function requirementProjections(requirementCatalog) {
  const refs = []
  const profileIds = []
  for (const profile of requirementCatalog.profiles ?? []) {
    profileIds.push(profile.id)
    for (const file of commandReferencedFiles(profile.command)) {
      refs.push({ path: file, declaration: `requirement:command:${profile.id}` })
    }
    for (const pathValue of profile.evidencePaths ?? []) {
      if (typeof pathValue !== 'string' || pathValue.startsWith('.tmp/') || pathValue.includes('*')) continue
      if (!/^(tools|tests)\//u.test(pathValue)) continue
      refs.push({ path: pathValue, declaration: `requirement:evidence:${profile.id}` })
    }
  }
  return { refs, profileIds }
}

function gitCommit(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) return null
  const commit = String(result.stdout ?? '').trim()
  return /^[0-9a-f]{40}$/u.test(commit) ? commit : null
}

export function collectClosureCandidates(root, matrix, coverageRegistry, requirementCatalog) {
  const candidates = new Map()
  for (const directory of DIRECTORY_CLOSURE) {
    if (existsSync(path.join(root, directory))) walkFiles(root, directory, candidates)
  }
  collectToolsClosure(root, candidates)

  const matrixProjection = matrixProjections(matrix)
  for (const ref of matrixProjection.refs) {
    addProjectedPath(root, ref.path, ref.declaration, candidates)
  }

  const coverageProjection = coverageProjections(coverageRegistry)
  for (const ref of coverageProjection.refs) {
    addProjectedPath(root, ref.path, ref.declaration, candidates)
  }

  const requirementProjection = requirementProjections(requirementCatalog)
  for (const ref of requirementProjection.refs) {
    addProjectedPath(root, ref.path, ref.declaration, candidates)
  }

  return {
    candidates,
    matrixTierIds: matrixProjection.tierIds,
    coverageIds: coverageProjection.coverageIds,
    requirementProfileIds: requirementProjection.profileIds
  }
}

/**
 * Compute the canonical inventory artifact for a repository root.
 * Deterministic for identical source, matrix and catalog inputs.
 */
export function discoverTestInventory(root, { includeSourceState = true } = {}) {
  const matrixText = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')
  const matrix = parseMatrix(matrixText)
  const coverageRegistry = JSON.parse(readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'))
  const requirementCatalog = JSON.parse(
    readFileSync(path.join(root, 'tests/backend/Fixtures/backend-test-requirements.json'), 'utf8')
  )

  const { candidates, matrixTierIds, coverageIds, requirementProfileIds } = collectClosureCandidates(
    root,
    matrix,
    coverageRegistry,
    requirementCatalog
  )

  const sourceFiles = []
  const diagnostics = []
  for (const [relative, bucket] of [...candidates.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const absolute = path.join(root, relative)
    const source = readFileSync(absolute, 'utf8')
    const extension = path.extname(relative).toLowerCase()
    const executable = EXECUTABLE_EXTENSIONS.has(extension)
    let classification
    try {
      classification = classifyFile(relative, source)
    } catch (error) {
      throw new Error(`${error.message} (declared by ${[...bucket.declaredBy].sort().join(', ')})`)
    }
    if (classification === null) {
      const commandDeclared = [...bucket.declaredBy].some((declaration) => (
        declaration.startsWith('matrix:command:') || declaration.startsWith('requirement:command:')
      ))
      if (executable && commandDeclared) {
        throw new Error(
          `test inventory fail closed: executable test surface ${relative} has no adapter record `
          + `(declared by ${[...bucket.declaredBy].sort().join(', ')})`
        )
      }
      classification = SUPPORT_CLASSIFICATION
    }
    const commandDeclared = [...bucket.declaredBy].some((declaration) => (
      declaration.startsWith('matrix:command:') || declaration.startsWith('requirement:command:')
    ))
    if (executable && commandDeclared && classification.kind !== 'discoverable-test') {
      throw new Error(
        `test inventory fail closed: executable test surface ${relative} was classified as `
        + `${classification.kind} (${classification.adapter}) instead of a discoverable test `
        + `(declared by ${[...bucket.declaredBy].sort().join(', ')})`
      )
    }
    sourceFiles.push({
      path: relative,
      adapter: classification.adapter,
      adapterVersion: classification.adapterVersion,
      kind: classification.kind,
      sourceDigest: fileDigest(absolute),
      declaredBy: [...bucket.declaredBy].sort(),
      caseIdentity: classification.caseIdentity
    })
    if (classification.kind === 'discoverable-test' && classification.caseIdentity.extractionStatus === 'deferred') {
      diagnostics.push({
        severity: 'info',
        code: 'case-extraction-deferred',
        file: relative,
        message: `${classification.adapter} adapter case extraction is deferred to ${classification.caseIdentity.deferredTo}`
      })
    }
    if (classification.caseIdentity.mode === 'dynamic') {
      diagnostics.push({
        severity: 'info',
        code: 'dynamic-case-obligation',
        file: relative,
        message: `runtime inventory must record executed case ids after ${classification.caseIdentity.generationLocation} execution`
      })
    }
  }

  const sourceState = includeSourceState ? { commit: gitCommit(root) } : null
  const discoverySources = {
    directories: [...DIRECTORY_CLOSURE].sort(),
    toolsDirectories: [...TOOLS_DIRECTORY_CLOSURE].sort(),
    matrixTiers: [...matrixTierIds].sort(),
    coverageEntries: [...coverageIds].sort(),
    requirementProfiles: [...requirementProfileIds].sort()
  }
  const content = {
    schema: INVENTORY_SCHEMA,
    adapterVersion: ADAPTER_VERSION,
    sourceState,
    discoverySources,
    sourceFiles,
    testCases: [],
    diagnostics: diagnostics.sort((left, right) => (
      left.severity.localeCompare(right.severity)
      || left.code.localeCompare(right.code)
      || left.file.localeCompare(right.file)
    ))
  }
  const inventoryDigest = sha256(canonicalStringify(content))
  const artifact = { ...content, inventoryDigest }
  return validateInventoryArtifact(artifact)
}
