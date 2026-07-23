#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createChangedCriticalStrykerConfig,
  readChangedPaths,
  repoRelative,
  selectChangedCriticalMutation,
  sha256
} from './changed-critical-mutation.mjs'
import {
  createChangedCriticalMutationAuthority
} from './changed-critical-mutation-evidence.mjs'

export function executeChangedCriticalSelection({ selection, spawnStryker }) {
  if (selection.status === 'empty') {
    return {
      schema: 'fsusblog.changed-critical-mutation-run.v1',
      status: 'empty',
      closureDigest: selection.closureDigest,
      strykerStarted: false
    }
  }
  const result = spawnStryker()
  if (result.status !== 0) throw new Error(`Stryker failed with exit code ${result.status}`)
  return {
    schema: 'fsusblog.changed-critical-mutation-run.v1',
    status: 'completed',
    closureDigest: selection.closureDigest,
    strykerStarted: true
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const next = `${path}.next-${process.pid}`
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(next, path)
}

function parseArguments(args) {
  const options = {
    catalog: null,
    changedPaths: null,
    sourceCommit: null,
    worktreeFingerprint: null,
    outputRoot: null,
    runId: null
  }
  const names = new Map([
    ['--catalog', 'catalog'],
    ['--changed-paths', 'changedPaths'],
    ['--source-commit', 'sourceCommit'],
    ['--worktree-fingerprint', 'worktreeFingerprint'],
    ['--output-root', 'outputRoot'],
    ['--run-id', 'runId']
  ])
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index])
    const value = args[index + 1]
    if (!key || !value || value.startsWith('--')) throw new Error(`unknown or incomplete option ${args[index]}`)
    options[key] = value
  }
  for (const [key, value] of Object.entries(options)) {
    if (!value) throw new Error(`missing required option ${key}`)
  }
  return options
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const options = parseArguments(process.argv.slice(2))
  const catalogPath = resolve(options.catalog)
  const rawCatalog = readFileSync(catalogPath)
  const catalog = JSON.parse(rawCatalog)
  const selection = selectChangedCriticalMutation({
    catalog,
    rawCatalog,
    changedPaths: readChangedPaths(resolve(options.changedPaths)),
    sourceState: {
      commit: options.sourceCommit,
      worktreeFingerprint: options.worktreeFingerprint
    }
  })
  const runDirectory = resolve(options.outputRoot, options.runId)
  const selectionPath = resolve(runDirectory, 'selection.json')
  writeJsonAtomic(selectionPath, selection)
  const rawSelection = readFileSync(selectionPath)

  const physicalRuns = []
  const run = executeChangedCriticalSelection({
    selection,
    spawnStryker: () => {
      const restore = spawnSync('dotnet', ['tool', 'restore'], { cwd: root, stdio: 'inherit' })
      if (restore.status !== 0) return restore
      for (const closure of selection.projectClosures) {
        const runName = closure.sourceProject.replaceAll('/', '-')
        const physicalOutput = resolve(runDirectory, 'physical', runName)
        const config = createChangedCriticalStrykerConfig(selection, catalog, closure.sourceProject)
        const configPath = resolve(runDirectory, 'configs', `${runName}.json`)
        writeJsonAtomic(configPath, config)
        const result = spawnSync(
          'dotnet',
          ['tool', 'run', 'dotnet-stryker', '--config-file', configPath, '--output', physicalOutput],
          {
            cwd: resolve(root, closure.sourceProject),
            stdio: 'inherit',
            env: { ...process.env, FSUSBLOG_MUTATION_BUILD: '1' }
          }
        )
        if (result.status !== 0) return result
        physicalRuns.push({
          sourceProject: closure.sourceProject,
          config,
          configPath,
          reportPath: resolve(physicalOutput, 'reports/changed-critical-mutation.json')
        })
      }
      return { status: 0 }
    }
  })
  writeJsonAtomic(resolve(runDirectory, 'run.json'), run)
  if (run.status === 'empty') {
    process.stdout.write(`[changed-critical-mutation] empty closure=${selection.closureDigest}; Stryker not started\n`)
    return
  }

  const authorityRuns = physicalRuns.map((physical) => {
    const rawConfig = readFileSync(physical.configPath)
    const rawReport = readFileSync(physical.reportPath)
    return {
      sourceProject: physical.sourceProject,
      config: physical.config,
      rawConfig,
      report: JSON.parse(rawReport),
      rawReport,
      paths: {
        config: repoRelative(root, physical.configPath),
        report: repoRelative(root, physical.reportPath)
      }
    }
  })
  const runManifestPath = resolve(runDirectory, 'run-manifest.json')
  writeJsonAtomic(runManifestPath, {
    schema: 'fsusblog.changed-critical-mutation-run-manifest.v1',
    runs: authorityRuns.map((physical) => ({
      sourceProject: physical.sourceProject,
      config: physical.paths.config,
      report: physical.paths.report
    }))
  })
  const authority = createChangedCriticalMutationAuthority({
    selection,
    rawSelection,
    catalog,
    rawCatalog,
    runs: authorityRuns,
    selectionPath: repoRelative(root, selectionPath),
    runId: options.runId,
    generatedAt: new Date().toISOString()
  })
  writeJsonAtomic(resolve(runDirectory, 'authority.json'), authority)
  process.stdout.write(
    `[changed-critical-mutation] ok closure=${selection.closureDigest} executed=${authority.mutants.executed} evidence=${repoRelative(root, resolve(runDirectory, 'authority.json'))}\n`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[changed-critical-mutation] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
