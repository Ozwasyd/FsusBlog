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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
const XUNIT_TEST_PROJECT = 'tests/backend/FsusBlog.Server.Tests.csproj'
const XUNIT_ADAPTER_PROJECT = 'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj'

function runXunitRoslynAdapter(root, projectPath, sourceFiles) {
  const xunitFiles = sourceFiles.filter((file) => file.adapter === 'xunit')
  if (xunitFiles.length === 0) return { testCases: [], diagnostics: [] }
  const adapterProject = path.join(root, XUNIT_ADAPTER_PROJECT)
  if (!existsSync(adapterProject)) {
    return {
      testCases: [],
      diagnostics: [{
        severity: 'warning',
        code: 'xunit-roslyn-adapter-unavailable',
        file: null,
        message: `xunit adapter project is not present at ${XUNIT_ADAPTER_PROJECT}; xunit cases were not extracted`
      }]
    }
  }
  const build = spawnSync(
    'dotnet',
    ['build', adapterProject, '-v:q'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  if (build.status !== 0) {
    const detail = String(build.stderr ?? build.stdout ?? '').trim().split(/\r?\n/u).slice(-12).join('\n')
    throw new Error(`xunit roslyn adapter build failed (exit ${build.status}): ${detail}`)
  }
  const adapterDirectory = path.dirname(adapterProject)
  const adapterExecutable = path.join(adapterDirectory, 'bin/Debug/net10.0/FsusBlog.XunitRoslynAdapter')
  const result = spawnSync(
    adapterExecutable,
    [root, path.join(root, projectPath)],
    { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
  )
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim().split(/\r?\n/u).slice(-12).join('\n')
    throw new Error(`xunit roslyn adapter failed (exit ${result.status}): ${detail}`)
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`xunit roslyn adapter output is not valid JSON: ${error.message}`)
  }
  const ownedFiles = new Set(xunitFiles.map((file) => file.path))
  const testCases = (report.testCases ?? []).filter((testCase) => ownedFiles.has(testCase.ownerFile))
  const diagnostics = (report.diagnostics ?? []).map((diagnostic) => ({
    severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    code: diagnostic.code,
    file: diagnostic.file ?? null,
    message: diagnostic.message
  }))
  return { testCases, diagnostics }
}

const TS_ADAPTER_ENTRY = 'tools/test-inventory/ts-ast-adapter/index.mjs'

function runTsAstAdapter(root, sourceFiles) {
  const tsFiles = sourceFiles.filter((file) => (
    file.adapter === 'vitest' || file.adapter === 'node-test' || file.adapter === 'playwright'
  ))
  if (tsFiles.length === 0) return { testCases: [], suiteRecords: [], diagnostics: [] }
  const adapterEntry = path.join(root, TS_ADAPTER_ENTRY)
  if (!existsSync(adapterEntry)) {
    return {
      testCases: [],
      suiteRecords: [],
      diagnostics: [{
        severity: 'warning',
        code: 'ts-ast-adapter-unavailable',
        file: null,
        message: `ts adapter entry is not present at ${TS_ADAPTER_ENTRY}; JS/TS cases were not extracted`
      }]
    }
  }
  const requestDir = path.join(root, '.tmp')
  mkdirSync(requestDir, { recursive: true })
  const requestPath = path.join(requestDir, 'ts-ast-adapter-request.json')
  writeFileSync(requestPath, JSON.stringify({
    root,
    files: tsFiles.map((file) => ({ path: file.path, adapter: file.adapter }))
  }))
  const result = spawnSync(
    process.execPath,
    [adapterEntry, requestPath],
    { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
  )
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim().split(/\r?\n/u).slice(-12).join('\n')
    throw new Error(`ts ast adapter failed (exit ${result.status}): ${detail}`)
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`ts ast adapter output is not valid JSON: ${error.message}`)
  }
  const ownedFiles = new Set(tsFiles.map((file) => file.path))
  const testCases = (report.testCases ?? []).filter((testCase) => ownedFiles.has(testCase.ownerFile))
  const suiteRecords = (report.suiteRecords ?? []).filter((suite) => ownedFiles.has(suite.file))
  const diagnostics = (report.diagnostics ?? []).map((diagnostic) => ({
    severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    code: diagnostic.code,
    file: diagnostic.file ?? null,
    message: diagnostic.message
  }))
  return { testCases, suiteRecords, diagnostics }
}

const NATIVE_ENTRY_ADAPTER_ENTRY = 'tools/test-inventory/native-entry-adapter/index.mjs'
const NATIVE_ENTRY_ADAPTERS = new Set([
  'native-smoke',
  'native-fuzz',
  'native-cmake',
  'native-corpus',
  'node-script',
  'shell'
])

function runNativeEntryAdapter(root, sourceFiles, matrix) {
  const nativeFiles = sourceFiles.filter((file) => NATIVE_ENTRY_ADAPTERS.has(file.adapter))
  if (nativeFiles.length === 0) return { testCases: [], diagnostics: [] }
  const adapterEntry = path.join(root, NATIVE_ENTRY_ADAPTER_ENTRY)
  if (!existsSync(adapterEntry)) {
    return {
      testCases: [],
      diagnostics: [{
        severity: 'warning',
        code: 'native-entry-adapter-unavailable',
        file: null,
        message: `native entry adapter is not present at ${NATIVE_ENTRY_ADAPTER_ENTRY}; native/shell cases were not extracted`
      }]
    }
  }
  const requestDir = path.join(root, '.tmp')
  mkdirSync(requestDir, { recursive: true })
  const requestPath = path.join(requestDir, 'native-entry-adapter-request.json')
  writeFileSync(requestPath, JSON.stringify({
    root,
    files: nativeFiles.map((file) => ({
      path: file.path,
      adapter: file.adapter,
      declaredBy: file.declaredBy
    })),
    matrixTiers: (matrix.tiers ?? []).map((tier) => ({
      id: tier.id,
      command: tier.command,
      evidence: tier.evidence ?? [],
      artifacts: tier.artifacts ?? []
    }))
  }))
  const result = spawnSync(
    process.execPath,
    [adapterEntry, requestPath],
    { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
  )
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim().split(/\r?\n/u).slice(-12).join('\n')
    throw new Error(`native entry adapter failed (exit ${result.status}): ${detail}`)
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`native entry adapter output is not valid JSON: ${error.message}`)
  }
  const ownedFiles = new Set(nativeFiles.map((file) => file.path))
  const testCases = (report.testCases ?? []).filter((testCase) => ownedFiles.has(testCase.ownerFile))
  const diagnostics = (report.diagnostics ?? []).map((diagnostic) => ({
    severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    code: diagnostic.code,
    file: diagnostic.file ?? null,
    message: diagnostic.message
  }))
  return { testCases, diagnostics }
}

export function discoverTestInventory(root, { includeSourceState = true, runAdapters = true } = {}) {
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

  let adapterCases = []
  let adapterSuiteRecords = []
  let adapterDiagnostics = []
  if (runAdapters) {
    const xunitResult = runXunitRoslynAdapter(root, XUNIT_TEST_PROJECT, sourceFiles)
    adapterCases = xunitResult.testCases
    adapterDiagnostics = xunitResult.diagnostics
    const tsResult = runTsAstAdapter(root, sourceFiles)
    adapterCases = [...adapterCases, ...tsResult.testCases]
    adapterSuiteRecords = tsResult.suiteRecords
    adapterDiagnostics = [...adapterDiagnostics, ...tsResult.diagnostics]
    const nativeEntryResult = runNativeEntryAdapter(root, sourceFiles, matrix)
    adapterCases = [...adapterCases, ...nativeEntryResult.testCases]
    adapterDiagnostics = [...adapterDiagnostics, ...nativeEntryResult.diagnostics]
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
    testCases: adapterCases.sort((left, right) => left.id.localeCompare(right.id)),
    suiteRecords: adapterSuiteRecords.sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: [...diagnostics, ...adapterDiagnostics].sort((left, right) => (
      left.severity.localeCompare(right.severity)
      || left.code.localeCompare(right.code)
      || String(left.file ?? '').localeCompare(String(right.file ?? ''))
    ))
  }
  const inventoryDigest = sha256(canonicalStringify(content))
  const artifact = { ...content, inventoryDigest }
  return validateInventoryArtifact(artifact)
}
