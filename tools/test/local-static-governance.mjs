#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  executeManifestEntry,
  resolveManifestChildEnvironment,
  resolveManifestWorkers,
  validateCommandManifest
} from './run-command-manifest.mjs'
import { executeLimitedWave } from './bundles/wave-runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const orderedWriteScripts = new Set([
  'check:dom-depth-static',
  'check:route-asset-budget',
  'check:public-performance-batch'
])
const finalCommandIds = new Set(['views-constraints:public-performance-batch'])
const postbuildReadCommandIds = new Set(['public-aot-contracts'])
const isolatedCommandIds = new Set([
  'asset-size-budget',
  'views-constraints:route-asset-budget'
])
const initialPriority = new Map([
  ['views-constraints:dom-depth-static', 0],
  ['historical-residue-fixture', 1],
  ['views-constraints:fsusui-typecheck-modes', 2],
  ['test-execution-optimization', 3]
])

export function extractChainedNpmScripts(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('views-constraints script is required')

  return [...value.matchAll(/(?:^|&&)\s*npm run ([A-Za-z0-9:_-]+)\s*/gu)].map((match) => match[1])
}

function viewsCoreCommand(value) {
  const [first] = value.split('&&', 1)
  const parts = first.trim().split(/\s+/u)
  if (parts.length !== 2 || parts[0] !== 'node' || !parts[1].endsWith('check-views-constraints.mjs')) {
    throw new Error('check:views-constraints must begin with its direct static checker')
  }
  return parts
}

export function buildLocalStaticManifest(staticManifest, scripts) {
  if (!Array.isArray(staticManifest?.commands)) throw new Error('static command manifest is required')
  const viewsEntry = staticManifest.commands.find((entry) => entry.id === 'views-constraints')
  if (viewsEntry?.script !== 'check:views-constraints') throw new Error('static manifest must contain check:views-constraints')

  const source = scripts?.['check:views-constraints']
  const chainedScripts = extractChainedNpmScripts(source)
  if (chainedScripts.length === 0) throw new Error('check:views-constraints must contain npm run checks')

  const expanded = [
    {
      id: 'views-constraints:core',
      command: viewsCoreCommand(source),
      access: 'read'
    },
    ...chainedScripts.map((script) => ({
      id: `views-constraints:${script.slice('check:'.length)}`,
      script,
      access: orderedWriteScripts.has(script) ? 'write' : 'read'
    }))
  ]

  return {
    ...staticManifest,
    lane: `${staticManifest.lane}:local-production`,
    commands: staticManifest.commands.flatMap((entry) => entry.id === 'views-constraints' ? expanded : [entry])
  }
}

export function planLocalStaticCommands(manifest) {
  const errors = validateCommandManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const initial = []
  const postbuild = []
  const isolated = []
  const final = []
  for (const entry of manifest.commands) {
    if (finalCommandIds.has(entry.id)) final.push(entry)
    else if (postbuildReadCommandIds.has(entry.id)) postbuild.push(entry)
    else if (isolatedCommandIds.has(entry.id)) isolated.push(entry)
    else initial.push(entry)
  }
  initial.sort((left, right) => {
    const leftPriority = initialPriority.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightPriority = initialPriority.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftPriority - rightPriority
  })
  if (final.length !== finalCommandIds.size) throw new Error('local static manifest is missing its dependent performance check')
  if (postbuild.length !== postbuildReadCommandIds.size) throw new Error('local static manifest is missing its build-output contract check')
  if (isolated.length !== isolatedCommandIds.size) throw new Error('local static manifest is missing its isolated asset check')

  return { initial, postbuild, isolated, final }
}

export function summarizeLocalStaticPlan(plan) {
  const prebuild = plan.initial.length
  const postbuild = plan.postbuild.length + plan.isolated.length + plan.final.length
  return { prebuild, postbuild, total: prebuild + postbuild }
}

export async function runLocalStaticGovernance({ repoRoot = root, env = process.env } = {}) {
  const frontendRoot = path.join(repoRoot, 'src/frontend')
  const staticManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/frontend/checks/static/manifest.json'), 'utf8'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'))
  const manifest = buildLocalStaticManifest(staticManifest, packageJson.scripts)
  const plan = planLocalStaticCommands(manifest)
  const workers = resolveManifestWorkers({ env })
  const concurrentEnv = resolveManifestChildEnvironment({ env, workers, concurrent: true })
  const sequentialEnv = resolveManifestChildEnvironment({ env, workers, concurrent: false })
  const phase = String(env.FSUSBLOG_LOCAL_STATIC_PHASE ?? 'all').trim()
  if (!['all', 'prebuild', 'postbuild'].includes(phase)) {
    throw new Error('FSUSBLOG_LOCAL_STATIC_PHASE must be all, prebuild, or postbuild')
  }

  if (phase !== 'postbuild') {
    await executeLimitedWave(
      plan.initial,
      workers,
      (entry) => executeManifestEntry(entry, { cwd: frontendRoot, env: concurrentEnv })
    )
  }
  if (phase !== 'prebuild') {
    await executeLimitedWave(
      [...plan.postbuild, ...plan.isolated],
      workers,
      (entry) => executeManifestEntry(entry, { cwd: frontendRoot, env: concurrentEnv })
    )
    await executeLimitedWave(
      plan.final,
      workers,
      (entry) => executeManifestEntry(entry, { cwd: frontendRoot, env: sequentialEnv })
    )
  }
  const summary = summarizeLocalStaticPlan(plan)
  const executedCommandCount = phase === 'prebuild'
    ? summary.prebuild
    : phase === 'postbuild'
      ? summary.postbuild
      : summary.total
  const executedCommands = phase === 'prebuild'
    ? plan.initial
    : phase === 'postbuild'
      ? [...plan.postbuild, ...plan.isolated, ...plan.final]
      : [...plan.initial, ...plan.postbuild, ...plan.isolated, ...plan.final]
  return {
    ...manifest,
    execution: {
      phase,
      commandCount: executedCommandCount,
      commandIds: executedCommands.map((entry) => entry.id),
      ...summary
    }
  }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  runLocalStaticGovernance().then((manifest) => {
    const evidenceFile = String(process.env.FSUSBLOG_LOCAL_STATIC_EVIDENCE_FILE ?? '').trim()
    if (evidenceFile) {
      const absolute = path.resolve(root, evidenceFile)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      const temporary = `${absolute}.next-${process.pid}`
      fs.writeFileSync(temporary, `${JSON.stringify({
        schema: 'fsusblog.local-production.frontend-static-governance-phase.v1',
        status: 'success',
        schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
        execution: manifest.execution,
        generatedAt: new Date().toISOString()
      }, null, 2)}\n`)
      fs.renameSync(temporary, absolute)
    }
    console.log(
      `[local-static-governance] ok phase=${manifest.execution.phase}`
      + ` commands=${manifest.execution.commandCount}`
      + ` split=${manifest.execution.prebuild}+${manifest.execution.postbuild}`
      + ` total=${manifest.execution.total}`
    )
  }).catch((error) => {
    console.error(`[local-static-governance] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
