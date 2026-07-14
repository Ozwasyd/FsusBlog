#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  executeManifestEntry,
  runWeightedCommandManifest,
  validateCommandManifest
} from './run-command-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const staticStages = ['blocking-prebuild', 'concurrent', 'postbuild', 'isolated', 'final']

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
  const sourceErrors = validateCommandManifest(staticManifest)
  if (sourceErrors.length > 0) throw new Error(sourceErrors.join('; '))
  const viewsEntry = staticManifest.commands.find((entry) => entry.id === 'views-constraints')
  if (viewsEntry?.script !== 'check:views-constraints') throw new Error('static manifest must contain check:views-constraints')
  if (!Array.isArray(viewsEntry.localCommands) || viewsEntry.localCommands.length === 0) {
    throw new Error('views-constraints must declare explicit localCommands')
  }

  const source = scripts?.['check:views-constraints']
  const chainedScripts = extractChainedNpmScripts(source)
  if (chainedScripts.length === 0) throw new Error('check:views-constraints must contain npm run checks')
  const [core, ...declaredScripts] = viewsEntry.localCommands
  if (JSON.stringify(core.command) !== JSON.stringify(viewsCoreCommand(source))) {
    throw new Error('views-constraints core command differs from the explicit local manifest')
  }
  if (JSON.stringify(declaredScripts.map((entry) => entry.script)) !== JSON.stringify(chainedScripts)) {
    throw new Error('check:views-constraints chain differs from the explicit local manifest')
  }

  return {
    ...staticManifest,
    lane: `${staticManifest.lane}:local-production`,
    commands: staticManifest.commands.flatMap((entry) => entry.id === 'views-constraints' ? entry.localCommands : [entry])
  }
}

export function planLocalStaticCommands(manifest) {
  const errors = validateCommandManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const plan = Object.fromEntries(staticStages.map((stage) => [stage, []]))
  for (const entry of manifest.commands) {
    plan[entry.stage].push(entry)
  }
  if (plan['blocking-prebuild'].length === 0) throw new Error('local static manifest must declare blocking-prebuild checks')
  if (plan.concurrent.length === 0) throw new Error('local static manifest must declare concurrent checks')
  if (plan.postbuild.length === 0) throw new Error('local static manifest must declare postbuild checks')
  if (plan.final.length === 0) throw new Error('local static manifest must declare final checks')
  return plan
}

export function summarizeLocalStaticPlan(plan) {
  const counts = Object.fromEntries(staticStages.map((stage) => [stage, plan[stage].length]))
  return {
    ...counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0)
  }
}

function phaseEntries(plan, phase) {
  return phase === 'all'
    ? staticStages.flatMap((stage) => plan[stage])
    : plan[phase]
}

export async function executeStaticStage({
  stage,
  entries,
  frontendRoot,
  env,
  timings,
  execute = executeManifestEntry
}) {
  const queuedAtMs = Date.now()
  const stageIds = new Set(entries.map((entry) => entry.id))
  return runWeightedCommandManifest({
    schema: 'fsusblog.frontend-static-command-manifest.v2',
    lane: `frontend-static:${stage}`,
    commands: entries.map((entry) => ({
      ...entry,
      dependsOn: entry.dependsOn.filter((dependency) => stageIds.has(dependency)),
      memoryCostGiB: Number(entry.memoryCostGiB ?? 0.125 * entry.resources.memoryWeight)
    }))
  }, {
    cwd: frontendRoot,
    env,
    workload: 'scheduler-admitted',
    orchestrationMemoryGiBPerWorker: 0.125,
    execute: async (entry, options) => {
      const startedAtMs = Date.now()
      const timing = {
        id: entry.id,
        stage,
        reason: entry.reason,
        waitReason: entry.dependsOn.length > 0
          ? `waiting for dependencies: ${entry.dependsOn.join(', ')}`
          : `waiting for ${stage} resource admission`,
        dependsOn: entry.dependsOn,
        consumedInputs: entry.consumedInputs,
        ownedOutputs: entry.ownedOutputs,
        exclusiveResources: entry.resources.exclusiveResources,
        queuedAtMs,
        startedAtMs,
        waitDurationMs: startedAtMs - queuedAtMs
      }
      timings.push(timing)
      try {
        await execute(entry, options)
        timing.status = 'success'
      } catch (error) {
        timing.status = 'failure'
        timing.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        timing.finishedAtMs = Date.now()
        timing.durationMs = timing.finishedAtMs - startedAtMs
      }
    }
  })
}

export async function runLocalStaticGovernance({ repoRoot = root, env = process.env } = {}) {
  const frontendRoot = path.join(repoRoot, 'src/frontend')
  const staticManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/frontend/checks/static/manifest.json'), 'utf8'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'))
  const manifest = buildLocalStaticManifest(staticManifest, packageJson.scripts)
  const plan = planLocalStaticCommands(manifest)
  const phase = String(env.FSUSBLOG_LOCAL_STATIC_PHASE ?? 'all').trim()
  if (!['all', ...staticStages].includes(phase)) {
    throw new Error(`FSUSBLOG_LOCAL_STATIC_PHASE must be all or one of: ${staticStages.join(', ')}`)
  }
  const summary = summarizeLocalStaticPlan(plan)
  const stages = phase === 'all' ? staticStages : [phase]
  const timings = []
  const stageTimings = []
  const failures = []
  const liveGrantExecutions = []
  for (const stage of stages) {
    const stageStartedAtMs = Date.now()
    let status = 'success'
    try {
      const liveGrantExecution = await executeStaticStage({
        stage,
        entries: plan[stage],
        frontendRoot,
        env,
        timings
      })
      liveGrantExecutions.push(liveGrantExecution)
    } catch (error) {
      status = 'failure'
      failures.push(error instanceof Error ? error : new Error(String(error)))
      if (error?.liveGrantEvidence) liveGrantExecutions.push(error.liveGrantEvidence)
    } finally {
      const finishedAtMs = Date.now()
      stageTimings.push({
        stage,
        status,
        commandCount: plan[stage].length,
        startedAtMs: stageStartedAtMs,
        finishedAtMs,
        durationMs: finishedAtMs - stageStartedAtMs,
        waitReasons: [...new Set(timings
          .filter((entry) => entry.stage === stage)
          .map((entry) => entry.waitReason))]
      })
    }
  }
  const executedCommands = phaseEntries(plan, phase)
  const execution = {
    phase,
    stages,
    workers: Math.max(1, ...liveGrantExecutions.flatMap((entry) =>
      entry.grantHistory.map((grant) => grant.maxParallel))),
    grantHistory: liveGrantExecutions.flatMap((entry) => entry.grantHistory),
    admissions: liveGrantExecutions.flatMap((entry) => entry.children),
    blockedReasons: liveGrantExecutions.flatMap((entry) => entry.blocked),
    commandCount: executedCommands.length,
    commandIds: executedCommands.map((entry) => entry.id),
    stagePlan: staticStages.map((stage) => ({
      stage,
      commandIds: plan[stage].map((entry) => entry.id),
      dependencies: Object.fromEntries(plan[stage].map((entry) => [entry.id, entry.dependsOn])),
      exclusiveResources: [...new Set(plan[stage].flatMap((entry) => entry.resources.exclusiveResources))]
    })),
    stageTimings,
    timings,
    ...summary
  }
  if (failures.length > 0) {
    const error = failures.length === 1
      ? failures[0]
      : new AggregateError(failures, `${failures.length} frontend static stages failed`)
    error.staticExecution = execution
    throw error
  }
  return {
    ...manifest,
    execution
  }
}

function writePhaseEvidence(execution, status, error = null) {
  const evidenceFile = String(process.env.FSUSBLOG_LOCAL_STATIC_EVIDENCE_FILE ?? '').trim()
  if (!evidenceFile) return
  const absolute = path.resolve(root, evidenceFile)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify({
    schema: 'fsusblog.local-production.frontend-static-governance-phase.v2',
    status,
    schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    execution,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
  fs.renameSync(temporary, absolute)
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  runLocalStaticGovernance().then((manifest) => {
    writePhaseEvidence(manifest.execution, 'success')
    console.log(
      `[local-static-governance] ok phase=${manifest.execution.phase}`
      + ` commands=${manifest.execution.commandCount}`
      + ` split=${staticStages.map((stage) => manifest.execution[stage]).join('+')}`
      + ` total=${manifest.execution.total}`
    )
  }).catch((error) => {
    writePhaseEvidence(error.staticExecution ?? null, 'failure', error)
    console.error(`[local-static-governance] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
