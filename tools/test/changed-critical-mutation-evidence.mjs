#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStrykerAuthority } from './check-stryker-report.mjs'
import { canonicalJson, sha256 } from './changed-critical-mutation.mjs'

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`)
}

function scopeMutationReport(report, mutateFiles, sourceProject) {
  const normalizedMutateFiles = mutateFiles.map((path) => path.replaceAll('\\', '/'))
  const selectedFiles = {}
  const unexpected = []
  for (const [file, value] of Object.entries(report.files ?? {})) {
    const normalizedFile = file.replaceAll('\\', '/')
    const selected = normalizedMutateFiles.some((path) => normalizedFile.endsWith(`/${path}`))
    if (selected) {
      selectedFiles[file] = value
      continue
    }
    for (const mutant of value?.mutants ?? []) {
      if (['Killed', 'Survived', 'Timeout', 'NoCoverage'].includes(mutant.status)) {
        unexpected.push(`${file}#${mutant.id}:${mutant.status}`)
      }
    }
  }
  for (const mutateFile of normalizedMutateFiles) {
    if (!Object.keys(selectedFiles).some((file) => file.replaceAll('\\', '/').endsWith(`/${mutateFile}`))) {
      throw new Error(`raw report is missing selected mutate file ${sourceProject}/${mutateFile}`)
    }
  }
  if (unexpected.length > 0) {
    throw new Error(`raw report executed mutants outside selected closure: ${unexpected.join(', ')}`)
  }
  return { ...report, files: selectedFiles }
}

export function createChangedCriticalMutationAuthority({
  selection,
  rawSelection,
  catalog,
  rawCatalog,
  runs,
  selectionPath,
  runId,
  generatedAt
}) {
  if (selection?.status !== 'selected') throw new Error('authority requires a non-empty critical selection')
  assertEqual(sha256(rawSelection), sha256(Buffer.from(`${JSON.stringify(selection, null, 2)}\n`)), 'selection bytes')
  assertEqual(selection.catalog.sha256, sha256(rawCatalog), 'catalog digest')
  if (!Array.isArray(runs) || runs.length !== selection.projectClosures.length) {
    throw new Error('authority requires one physical mutation run per source-project closure')
  }
  const runAuthorities = runs.map((run) => {
    const closure = selection.projectClosures.find(({ sourceProject }) => sourceProject === run.sourceProject)
    if (!closure) throw new Error(`unexpected mutation source project ${run.sourceProject}`)
    assertEqual(canonicalJson(run.config['stryker-config'].mutate), canonicalJson(closure.mutateFiles), `${run.sourceProject} mutate scope`)
    assertEqual(run.config['stryker-config']['test-case-filter'], closure.testFilter, `${run.sourceProject} test filter`)
    const scopedReport = scopeMutationReport(run.report, closure.mutateFiles, run.sourceProject)
    const authority = createStrykerAuthority({
      report: scopedReport,
      rawReport: run.rawReport,
      reportPath: run.paths.report,
      config: run.config,
      rawConfig: run.rawConfig,
      configPath: run.paths.config,
      tierId: 'backend-mutation-changed-critical',
      runId: `${runId}:${run.sourceProject}`,
      sourceState: selection.sourceState,
      generatedAt
    })
    if (authority.executedMutants === 0) {
      throw new Error(`non-empty critical closure executed zero mutants for ${run.sourceProject}`)
    }
    return {
      sourceProject: run.sourceProject,
      config: { path: run.paths.config, sha256: sha256(run.rawConfig) },
      rawReport: { path: run.paths.report, sha256: sha256(run.rawReport) },
      mutateFiles: closure.mutateFiles,
      testFilter: closure.testFilter,
      executed: authority.executedMutants,
      statuses: authority.statuses,
      score: authority.score
    }
  }).sort((left, right) => left.sourceProject.localeCompare(right.sourceProject))
  const statuses = Object.fromEntries(
    ['CompileError', 'Ignored', 'Killed', 'NoCoverage', 'Survived', 'Timeout']
      .map((status) => [status, runAuthorities.reduce((total, run) => total + run.statuses[status], 0)])
  )
  const executed = runAuthorities.reduce((total, run) => total + run.executed, 0)

  return {
    schema: 'fsusblog.changed-critical-mutation-authority.v1',
    status: 'success',
    runId,
    generatedAt,
    sourceState: selection.sourceState,
    closureDigest: selection.closureDigest,
    selection: {
      path: selectionPath,
      sha256: sha256(rawSelection)
    },
    catalog: {
      path: selection.catalog.path,
      sha256: sha256(rawCatalog),
      version: catalog.version
    },
    generatedConfigDigest: sha256(canonicalJson(
      runAuthorities.map(({ sourceProject, config }) => ({ sourceProject, ...config }))
    )),
    mutateFiles: selection.mutateFiles,
    testFilter: selection.testFilter,
    domains: selection.domains.map(({ id, risk }) => ({ id, risk })),
    mutants: {
      executed,
      killed: statuses.Killed,
      survived: statuses.Survived,
      timeout: statuses.Timeout,
      noCoverage: statuses.NoCoverage,
      compileError: statuses.CompileError,
      ignored: statuses.Ignored
    },
    physicalRuns: runAuthorities,
    rawReportDigest: sha256(canonicalJson(
      runAuthorities.map(({ sourceProject, rawReport }) => ({ sourceProject, ...rawReport }))
    ))
  }
}

export function validateChangedCriticalMutationAuthority({
  authority,
  selection,
  rawSelection,
  catalog,
  rawCatalog,
  runs,
  expectedSourceState
}) {
  if (authority?.schema !== 'fsusblog.changed-critical-mutation-authority.v1' || authority.status !== 'success') {
    throw new Error('changed-critical authority schema/status is invalid')
  }
  assertEqual(authority.sourceState.commit, expectedSourceState.commit, 'source commit')
  assertEqual(authority.sourceState.worktreeFingerprint, expectedSourceState.worktreeFingerprint, 'worktree fingerprint')
  assertEqual(authority.closureDigest, selection.closureDigest, 'closure digest')
  assertEqual(authority.selection.sha256, sha256(rawSelection), 'selection digest')
  assertEqual(authority.catalog.sha256, sha256(rawCatalog), 'catalog digest')
  assertEqual(canonicalJson(authority.mutateFiles), canonicalJson(selection.mutateFiles), 'mutate file list')
  assertEqual(authority.testFilter, selection.testFilter, 'test filter')

  const recreated = createChangedCriticalMutationAuthority({
    selection,
    rawSelection,
    catalog,
    rawCatalog,
    runs,
    selectionPath: authority.selection.path,
    runId: authority.runId,
    generatedAt: authority.generatedAt
  })
  assertEqual(canonicalJson(authority), canonicalJson(recreated), 'authority content')
  return authority
}

function parseArguments(args) {
  const names = new Map([
    ['--authority', 'authority'],
    ['--selection', 'selection'],
    ['--catalog', 'catalog'],
    ['--run-manifest', 'runManifest'],
    ['--source-commit', 'sourceCommit'],
    ['--worktree-fingerprint', 'worktreeFingerprint']
  ])
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index])
    const value = args[index + 1]
    if (!key || !value || value.startsWith('--')) throw new Error(`unknown or incomplete option ${args[index]}`)
    options[key] = value
  }
  for (const key of names.values()) {
    if (!options[key]) throw new Error(`missing required option ${key}`)
  }
  return options
}

function readJsonWithBytes(path) {
  const raw = readFileSync(resolve(path))
  return { raw, value: JSON.parse(raw) }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const authority = readJsonWithBytes(options.authority)
  const selection = readJsonWithBytes(options.selection)
  const catalog = readJsonWithBytes(options.catalog)
  const runManifest = JSON.parse(readFileSync(resolve(options.runManifest)))
  const runs = runManifest.runs.map((entry) => {
    const config = readJsonWithBytes(entry.config)
    const report = readJsonWithBytes(entry.report)
    return {
      sourceProject: entry.sourceProject,
      config: config.value,
      rawConfig: config.raw,
      report: report.value,
      rawReport: report.raw,
      paths: { config: entry.config, report: entry.report }
    }
  })
  validateChangedCriticalMutationAuthority({
    authority: authority.value,
    selection: selection.value,
    rawSelection: selection.raw,
    catalog: catalog.value,
    rawCatalog: catalog.raw,
    runs,
    expectedSourceState: {
      commit: options.sourceCommit,
      worktreeFingerprint: options.worktreeFingerprint
    }
  })
  process.stdout.write(
    `[changed-critical-mutation-evidence] ok run=${authority.value.runId} closure=${authority.value.closureDigest} executed=${authority.value.mutants.executed}\n`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[changed-critical-mutation-evidence] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
