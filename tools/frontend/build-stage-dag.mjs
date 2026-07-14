import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { runWeightedCommandManifest } from '../test/run-command-manifest.mjs'

function positiveNumber(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return parsed
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function normalizedStrings(value, name, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`${name} must be ${required ? 'a non-empty' : 'an'} array`)
  }
  if (value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${name} must contain only non-empty strings`)
  }
  if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicates`)
  return [...value]
}

function normalizedStage(stage) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) throw new Error('frontend build stage must be an object')
  if (typeof stage.id !== 'string' || !stage.id.trim()) throw new Error('frontend build stage id must be non-empty')
  const command = normalizedStrings(stage.command, `${stage.id}.command`, { required: true })
  const dependsOn = normalizedStrings(stage.dependsOn ?? [], `${stage.id}.dependsOn`)
  const consumedInputs = normalizedStrings(stage.consumedInputs ?? [], `${stage.id}.consumedInputs`)
  const ownedOutputs = normalizedStrings(stage.ownedOutputs ?? [], `${stage.id}.ownedOutputs`)
  const exclusiveResources = normalizedStrings(
    stage.resources?.exclusiveResources ?? [],
    `${stage.id}.resources.exclusiveResources`
  )
  const resources = {
    cpuWeight: positiveNumber(stage.resources?.cpuWeight, `${stage.id}.resources.cpuWeight`),
    memoryWeight: positiveNumber(stage.resources?.memoryWeight, `${stage.id}.resources.memoryWeight`),
    minCpuUnits: positiveInteger(stage.resources?.minCpuUnits, `${stage.id}.resources.minCpuUnits`),
    minMemoryGiB: positiveNumber(stage.resources?.minMemoryGiB, `${stage.id}.resources.minMemoryGiB`),
    exclusiveResources
  }
  return {
    ...stage,
    id: stage.id.trim(),
    command,
    dependsOn,
    consumedInputs,
    ownedOutputs,
    resources,
    estimatedDurationMs: positiveNumber(stage.estimatedDurationMs ?? 1, `${stage.id}.estimatedDurationMs`)
  }
}

export function validateFrontendBuildStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) throw new Error('frontend build stages must be non-empty')
  const normalized = stages.map(normalizedStage)
  const ids = new Set()
  for (const stage of normalized) {
    if (ids.has(stage.id)) throw new Error(`duplicate frontend build stage id: ${stage.id}`)
    ids.add(stage.id)
  }
  for (const stage of normalized) {
    for (const dependency of stage.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`${stage.id}.dependsOn references unknown stage: ${dependency}`)
      if (dependency === stage.id) throw new Error(`${stage.id}.dependsOn must not reference itself`)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const byId = new Map(normalized.map((stage) => [stage.id, stage]))
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`frontend build stage DAG contains a cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id).dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const stage of normalized) visit(stage.id)
  return normalized
}

export function resolveStageEnvironment(resource, env = process.env) {
  const cpuUnits = positiveNumber(resource?.cpuUnits, 'stage CPU grant')
  const memoryGiB = positiveNumber(resource?.memoryGiB, 'stage memory grant')
  const maxParallel = Math.max(1, Math.floor(cpuUnits))
  const formattedCpu = String(Number(cpuUnits.toFixed(6)))
  const formattedMemory = String(Number(memoryGiB.toFixed(6)))
  return {
    ...env,
    FSUSBLOG_STEP_CPU_BUDGET: formattedCpu,
    FSUSBLOG_STEP_MEMORY_GIB: formattedMemory,
    FSUSBLOG_BUNDLE_CPU_UNITS: formattedCpu,
    FSUSBLOG_BUNDLE_CPU_BUDGET: String(maxParallel),
    FSUSBLOG_BUNDLE_MEMORY_GIB: formattedMemory,
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: String(maxParallel),
    FSUSBLOG_NODE_TEST_CONCURRENCY: String(maxParallel),
    UV_THREADPOOL_SIZE: String(maxParallel)
  }
}

async function sha256File(file) {
  const digest = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => digest.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return `sha256:${digest.digest('hex')}`
}

async function snapshotOutput(absolute, root) {
  let stats
  try {
    stats = await fs.promises.lstat(absolute)
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  if (stats.isSymbolicLink()) throw new Error(`frontend build output must not be a symlink: ${absolute}`)
  if (stats.isFile()) {
    return {
      status: 'file',
      size: stats.size,
      sha256: await sha256File(absolute)
    }
  }
  if (!stats.isDirectory()) throw new Error(`frontend build output has unsupported type: ${absolute}`)
  const entries = []
  const visit = async (directory) => {
    const children = await fs.promises.readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const childPath = path.join(directory, child.name)
      const relative = path.relative(absolute, childPath).replaceAll(path.sep, '/')
      const childStats = await fs.promises.lstat(childPath)
      if (childStats.isSymbolicLink()) throw new Error(`frontend build output must not contain symlinks: ${childPath}`)
      if (childStats.isDirectory()) {
        entries.push({ path: `${relative}/`, type: 'directory' })
        await visit(childPath)
      } else if (childStats.isFile()) {
        entries.push({
          path: relative,
          type: 'file',
          size: childStats.size,
          sha256: await sha256File(childPath)
        })
      } else {
        throw new Error(`frontend build output has unsupported child type: ${childPath}`)
      }
    }
  }
  await visit(absolute)
  const serialized = JSON.stringify(entries)
  return {
    status: 'directory',
    entries: entries.length,
    size: entries.reduce((total, entry) => total + Number(entry.size ?? 0), 0),
    sha256: `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`,
    root: path.relative(root, absolute).replaceAll(path.sep, '/') || '.'
  }
}

export async function snapshotFrontendBuildOutputs(cwd, outputs) {
  const root = path.resolve(cwd)
  return Object.fromEntries(await Promise.all(outputs.map(async (declared) => {
    const absolute = path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(root, declared)
    return [declared, await snapshotOutput(absolute, root)]
  })))
}

async function writeJsonAtomic(file, value) {
  const absolute = path.resolve(file)
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.next-${process.pid}-${crypto.randomUUID()}`
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await fs.promises.rename(temporary, absolute)
}

function manifestForStages(stages) {
  return {
    schema: 'fsusblog.test-command-manifest.v1',
    lane: 'frontend-release-build-stages',
    commands: stages.map((stage) => ({
      id: stage.id,
      command: stage.command,
      access: stage.ownedOutputs.length > 0 ? 'write' : 'read',
      consumedInputs: stage.consumedInputs,
      ownedOutputs: stage.ownedOutputs,
      dependsOn: stage.dependsOn,
      settledDependsOn: [],
      exclusiveResources: stage.resources.exclusiveResources,
      estimatedDurationMs: stage.estimatedDurationMs,
      memoryCostGiB: stage.resources.minMemoryGiB,
      resources: {
        cpuWeight: stage.resources.cpuWeight,
        memoryWeight: stage.resources.memoryWeight,
        minCpuUnits: stage.resources.minCpuUnits,
        exclusiveResources: stage.resources.exclusiveResources
      }
    }))
  }
}

export async function runFrontendBuildStageDag(stages, {
  cwd = process.cwd(),
  env = process.env,
  receiptFile,
  execute,
  readGrantFile,
  signal,
  toolchain = {},
  cleanupPartialOutputs
} = {}) {
  if (typeof execute !== 'function') throw new Error('frontend build stage execute callback is required')
  if (!receiptFile) throw new Error('frontend build stage receipt file is required')
  const normalized = validateFrontendBuildStages(stages)
  const absoluteReceiptFile = path.resolve(receiptFile)
  // A process crash must not leave an earlier successful receipt looking current.
  await fs.promises.rm(absoluteReceiptFile, { force: true })
  const stageRecords = new Map()
  let liveGrantEvidence = null
  let failure = null
  let cleanup = null
  const startedAtMs = Date.now()
  try {
    liveGrantEvidence = await runWeightedCommandManifest(manifestForStages(normalized), {
      cwd,
      env,
      workload: 'scheduler-admitted',
      orchestrationMemoryGiBPerWorker: 0.25,
      readGrantFile,
      signal,
      evidenceFile: null,
      execute: async (entry, context) => {
        const stage = normalized.find((candidate) => candidate.id === entry.id)
        const admittedAtMs = Date.now()
        const stageEnvironment = resolveStageEnvironment({
          cpuUnits: Number(context.env.FSUSBLOG_STEP_CPU_BUDGET),
          memoryGiB: Number(context.env.FSUSBLOG_STEP_MEMORY_GIB)
        }, context.env)
        const record = {
          id: stage.id,
          status: 'running',
          command: stage.command,
          dependsOn: stage.dependsOn,
          consumedInputs: stage.consumedInputs,
          ownedOutputs: stage.ownedOutputs,
          exclusiveResources: stage.resources.exclusiveResources,
          admittedAtMs,
          grant: {
            cpuUnits: Number(stageEnvironment.FSUSBLOG_STEP_CPU_BUDGET),
            memoryGiB: Number(stageEnvironment.FSUSBLOG_STEP_MEMORY_GIB),
            nestedWorkers: Number(stageEnvironment.FSUSBLOG_NODE_TEST_CONCURRENCY),
            uvThreadpoolSize: Number(stageEnvironment.UV_THREADPOOL_SIZE)
          },
          toolchain: { ...toolchain, ...(stage.toolchain ?? {}) }
        }
        stageRecords.set(stage.id, record)
        try {
          const result = await execute(stage, {
            cwd,
            env: stageEnvironment,
            signal: context.signal
          })
          record.status = result?.skipped ? 'skipped' : 'success'
          record.detail = result?.detail ?? null
          record.outputs = result?.skipped
            ? Object.fromEntries(stage.ownedOutputs.map((output) => [output, { status: 'skipped' }]))
            : await snapshotFrontendBuildOutputs(cwd, stage.ownedOutputs)
          const missing = Object.entries(record.outputs)
            .filter(([, value]) => value.status === 'missing')
            .map(([output]) => output)
          if (missing.length > 0) throw new Error(`${stage.id} did not produce declared output(s): ${missing.join(', ')}`)
        } catch (error) {
          record.status = context.signal?.aborted ? 'cancelled' : 'failure'
          record.error = error instanceof Error ? error.message : String(error)
          try {
            record.outputs = await snapshotFrontendBuildOutputs(cwd, stage.ownedOutputs)
          } catch (snapshotError) {
            record.outputSnapshotError = snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
          }
          throw error
        } finally {
          record.finishedAtMs = Date.now()
          record.durationMs = record.finishedAtMs - admittedAtMs
        }
      }
    })
  } catch (error) {
    failure = error
    liveGrantEvidence = error?.liveGrantEvidence ?? liveGrantEvidence
    if (typeof cleanupPartialOutputs === 'function') {
      try {
        cleanup = await cleanupPartialOutputs(error)
      } catch (cleanupError) {
        cleanup = {
          status: 'failure',
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }
      }
    }
  }

  const childById = new Map((liveGrantEvidence?.children ?? []).map((child) => [child.id, child]))
  const stageEvidence = normalized.map((stage) => stageRecords.get(stage.id) ?? {
    id: stage.id,
    status: childById.get(stage.id)?.status ?? 'blocked-or-not-admitted',
    command: stage.command,
    dependsOn: stage.dependsOn,
    consumedInputs: stage.consumedInputs,
    ownedOutputs: stage.ownedOutputs,
    exclusiveResources: stage.resources.exclusiveResources,
    toolchain: { ...toolchain, ...(stage.toolchain ?? {}) }
  })
  const finishedAtMs = Date.now()
  const receipt = {
    schema: 'fsusblog.frontend-build-stage-receipt.v1',
    status: failure ? 'partial' : 'success',
    executionMode: liveGrantEvidence?.grantHistory?.[0]?.source === 'direct-invocation-fallback'
      ? 'direct-fallback'
      : liveGrantEvidence?.executionMode ?? 'live-grant',
    schedulerRunId: env.FSUSBLOG_TEST_RUN_ID ?? null,
    sourceState: {
      commit: env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
      worktreeFingerprint: env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
    },
    grantSource: liveGrantEvidence?.grantHistory?.[0]?.source ?? null,
    grantHistory: liveGrantEvidence?.grantHistory ?? [],
    blocked: liveGrantEvidence?.blocked ?? [],
    stages: stageEvidence,
    cleanup,
    error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
    startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - startedAtMs,
    generatedAt: new Date(finishedAtMs).toISOString()
  }
  await writeJsonAtomic(absoluteReceiptFile, receipt)
  if (failure) {
    if (failure && typeof failure === 'object') failure.frontendBuildStageReceipt = receipt
    throw failure
  }
  return receipt
}
