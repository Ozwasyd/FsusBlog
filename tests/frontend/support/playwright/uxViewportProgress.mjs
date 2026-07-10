import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import path from 'node:path'

const PROGRESS_VERSION = 'fsusblog-ux-viewport-progress-v1'
const POINTER_VERSION = 'fsusblog-ux-viewport-run-pointer-v1'

export async function openUxViewportProgress({
  root,
  plan,
  resume = false,
  runId,
  runToken,
  outputDir,
  now = () => new Date().toISOString()
}) {
  const resolvedRoot = path.resolve(root)
  const pointerFile = path.join(resolvedRoot, '.tmp/ux', `current-${plan.mode}-run.json`)

  if (resume) {
    const pointer = runId
      ? null
      : await readJson(pointerFile, `UX viewport ${plan.mode} resume pointer`)
    const resumedRunId = requireSafeRunId(runId ?? pointer?.runId)
    const progressFile = pointer?.progressFile
      ? resolveInsideRoot(resolvedRoot, pointer.progressFile)
      : progressFileFor(resolvedRoot, resumedRunId, plan.mode)
    const progress = await readUxViewportProgress(progressFile)
    assertProgressMatches(progress, plan, resumedRunId)
    return buildRun({ resolvedRoot, pointerFile, progressFile, progress, now })
  }

  const freshRunId = requireSafeRunId(runId)
  if (!runToken) {
    throw new Error('fresh UX viewport progress requires a run token')
  }
  const progressFile = progressFileFor(resolvedRoot, freshRunId, plan.mode)
  const artifactRoot = path.dirname(progressFile)
  const progress = await withProgressLock(progressFile, async () => {
    const current = await readJsonIfPresent(progressFile)
    if (
      current?.runId === freshRunId
      && current?.runToken === runToken
      && current?.planFingerprint === plan.fingerprint
    ) {
      return current
    }

    const startedAt = now()
    const initial = {
      version: PROGRESS_VERSION,
      runId: freshRunId,
      runToken,
      mode: plan.mode,
      planFingerprint: plan.fingerprint,
      matrixVersion: plan.matrixVersion,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      planned: { ...plan.counts },
      selection: plan.selection ? structuredClone(plan.selection) : null,
      actual: {
        completedRouteThemeGroups: 0,
        navigations: 0,
        cases: 0,
        failedRouteThemeGroups: 0
      },
      completedGroupIds: [],
      groupResults: [],
      artifacts: {
        root: relativeToRoot(resolvedRoot, artifactRoot),
        outputDir: outputDir ? relativeToRoot(resolvedRoot, path.resolve(outputDir)) : null
      }
    }
    await writeJsonAtomic(progressFile, initial)
    return initial
  })

  await writeJsonAtomic(pointerFile, {
    version: POINTER_VERSION,
    runId: freshRunId,
    runToken,
    mode: plan.mode,
    planFingerprint: plan.fingerprint,
    progressFile: relativeToRoot(resolvedRoot, progressFile),
    updatedAt: progress.updatedAt
  })

  return buildRun({ resolvedRoot, pointerFile, progressFile, progress, now })
}

export async function recordUxViewportGroupResult({
  run,
  plan,
  groupId,
  status,
  error,
  artifacts = [],
  now = run.now ?? (() => new Date().toISOString())
}) {
  if (status !== 'passed' && status !== 'failed') {
    throw new Error(`unknown UX viewport group result status: ${String(status)}`)
  }
  const group = plan.groups.find((candidate) => candidate.id === groupId)
  if (!group) {
    throw new Error(`unknown UX viewport route-theme group: ${groupId}`)
  }

  const updated = await withProgressLock(run.progressFile, async () => {
    const progress = await readUxViewportProgress(run.progressFile)
    assertProgressMatches(progress, plan, run.progress.runId)
    if (progress.runToken !== run.progress.runToken) {
      throw new Error(`UX viewport run token mismatch for ${progress.runId}`)
    }

    const completedAt = now()
    const result = {
      groupId,
      routeId: group.route.id,
      theme: group.theme,
      status,
      navigations: group.viewports.length,
      cases: group.viewports.reduce((total, viewport) => total + viewport.steps.length, 0),
      viewportIds: group.viewports.map((viewport) => viewport.viewport.name),
      media: [...new Set(group.viewports.flatMap((viewport) => (
        viewport.steps.map((step) => step.media)
      )))],
      completedAt,
      error: status === 'failed' ? formatError(error) : null,
      artifacts: [...artifacts]
    }
    const results = new Map(progress.groupResults.map((entry) => [entry.groupId, entry]))
    results.set(groupId, result)
    const groupOrder = new Map(plan.groups.map((entry, index) => [entry.id, index]))
    const groupResults = [...results.values()].sort((left, right) => (
      groupOrder.get(left.groupId) - groupOrder.get(right.groupId)
    ))
    const passedResults = groupResults.filter((entry) => entry.status === 'passed')
    const failedResults = groupResults.filter((entry) => entry.status === 'failed')
    const completedGroupIds = passedResults.map((entry) => entry.groupId)
    const isComplete = completedGroupIds.length === plan.counts.routeThemeGroups
    const nextStatus = failedResults.length > 0 ? 'failed' : isComplete ? 'passed' : 'running'
    const next = {
      ...progress,
      status: nextStatus,
      updatedAt: completedAt,
      finishedAt: nextStatus === 'running' ? null : completedAt,
      actual: {
        completedRouteThemeGroups: passedResults.length,
        navigations: passedResults.reduce((total, entry) => total + entry.navigations, 0),
        cases: passedResults.reduce((total, entry) => total + entry.cases, 0),
        failedRouteThemeGroups: failedResults.length
      },
      completedGroupIds,
      groupResults
    }
    await writeJsonAtomic(run.progressFile, next)
    return next
  })

  run.progress = updated
  run.completedGroupIds = new Set(updated.completedGroupIds)
  return updated
}

export async function readUxViewportProgress(file) {
  return await readJson(file, 'UX viewport progress')
}

function buildRun({ resolvedRoot, pointerFile, progressFile, progress, now }) {
  return {
    root: resolvedRoot,
    pointerFile,
    progressFile,
    progress,
    completedGroupIds: new Set(progress.completedGroupIds),
    now
  }
}

function assertProgressMatches(progress, plan, runId) {
  if (progress.version !== PROGRESS_VERSION) {
    throw new Error(`unsupported UX viewport progress version: ${String(progress.version)}`)
  }
  if (progress.runId !== runId || progress.mode !== plan.mode) {
    throw new Error(`UX viewport resume identity mismatch for ${runId}`)
  }
  if (progress.planFingerprint !== plan.fingerprint) {
    throw new Error(
      `UX viewport plan fingerprint mismatch: progress=${progress.planFingerprint} current=${plan.fingerprint}`
    )
  }
}

function progressFileFor(root, runId, mode) {
  return path.join(root, '.tmp/ux/runs', runId, mode, 'progress.json')
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function withProgressLock(progressFile, action) {
  await mkdir(path.dirname(progressFile), { recursive: true })
  const lockFile = `${progressFile}.lock`
  const deadline = Date.now() + 15_000
  let handle
  while (!handle) {
    try {
      handle = await open(lockFile, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }
      const lockStat = await stat(lockFile).catch(() => null)
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        await rm(lockFile, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for UX viewport progress lock: ${lockFile}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  try {
    return await action()
  } finally {
    await handle.close()
    await rm(lockFile, { force: true })
  }
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} is missing: ${file}`)
    }
    throw error
  }
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function requireSafeRunId(runId) {
  if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(runId)) {
    throw new Error(`invalid UX viewport run id: ${String(runId)}`)
  }
  return runId
}

function resolveInsideRoot(root, relativeFile) {
  const resolved = path.resolve(root, relativeFile)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`UX viewport progress path escapes repository root: ${relativeFile}`)
  }
  return resolved
}

function relativeToRoot(root, file) {
  const relative = path.relative(root, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`UX viewport artifact path escapes repository root: ${file}`)
  }
  return relative.replaceAll(path.sep, '/')
}

function formatError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error ?? 'unknown failure')
}
