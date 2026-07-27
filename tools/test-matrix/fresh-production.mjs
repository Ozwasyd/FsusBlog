import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { runProductionFreshCacheTransaction } from './production-fresh-cache-transaction.mjs'

const gibibyte = 1024 ** 3
const defaultMinimumFreeBytes = 4 * gibibyte

function forceRmSync(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      chmodRecursive(target)
      fs.rmSync(target, { recursive: true, force: true })
    } else {
      throw error
    }
  }
}

function chmodRecursive(target) {
  if (!fs.existsSync(target)) return
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory()) return
  try { fs.chmodSync(target, (stat.mode | fs.constants.S_IWUSR) & ~0o111) } catch {}
  try { fs.chmodSync(target, stat.mode | fs.constants.S_IWUSR | fs.constants.S_IXUSR) } catch {}
  for (const entry of fs.readdirSync(target)) {
    const childPath = path.join(target, entry)
    try {
      const childStat = fs.lstatSync(childPath)
      if (childStat.isDirectory()) {
        chmodRecursive(childPath)
      } else {
        try { fs.chmodSync(childPath, (childStat.mode | fs.constants.S_IWUSR) & ~0o111) } catch {}
        try { fs.chmodSync(childPath, childStat.mode | fs.constants.S_IWUSR) } catch {}
      }
    } catch {}
  }
}

const generatedDirectories = Object.freeze([
  '.tmp',
  'src/frontend/coverage',
  'src/frontend/test-results',
  'src/backend/Logs'
])

export function localProductionGeneratedDirectories() {
  return [...generatedDirectories]
}

function dockerRootDirectory() {
  const result = spawnSync('docker', ['info', '--format', '{{.DockerRootDir}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const directory = String(result.stdout ?? '').trim()
  if (result.status !== 0 || !directory) {
    throw new Error(`unable to resolve DockerRootDir: ${String(result.stderr ?? '').trim() || `exit ${result.status ?? 'unknown'}`}`)
  }
  return directory
}

function availableBytes(directory) {
  const stats = fs.statfsSync(directory)
  return Number(stats.bavail) * Number(stats.bsize)
}

export function assertLocalProductionCapacity({
  root,
  minimumFreeBytes = defaultMinimumFreeBytes,
  resolveDockerRootDirectory = dockerRootDirectory,
  measureAvailableBytes = availableBytes
}) {
  const resolvedRoot = path.resolve(root)
  const resolvedDockerRoot = path.resolve(resolveDockerRootDirectory())
  const localTempRoot = path.join(resolvedRoot, '.tmp')
  const resolvedLocalTempRoot = fs.existsSync(localTempRoot)
    ? fs.realpathSync(localTempRoot)
    : resolvedRoot
  const targets = [...new Set([resolvedRoot, resolvedLocalTempRoot, resolvedDockerRoot])]
  const measurements = targets.map((directory) => ({
    directory,
    availableBytes: measureAvailableBytes(directory)
  }))
  const shortages = measurements.filter((measurement) => measurement.availableBytes < minimumFreeBytes)
  if (shortages.length > 0) {
    const requiredGiB = (minimumFreeBytes / gibibyte).toFixed(1)
    const details = shortages
      .map(({ directory, availableBytes: bytes }) => `${directory} has ${(bytes / gibibyte).toFixed(1)} GiB`)
      .join('; ')
    throw new Error(`fresh production requires at least ${requiredGiB} GiB free on repository and Docker data filesystems: ${details}`)
  }
  return { minimumFreeBytes, measurements }
}

export function cleanLocalProductionOutputs(root, {
  runId,
  ownerIdentity,
  cacheTransaction = runProductionFreshCacheTransaction,
  journalRoot,
  crashAt,
  onCrashBoundary
} = {}) {
  const startedAtMs = Date.now()
  let traversedEntryCount = 0
  const resolvedRoot = path.resolve(root)
  const localTempRoot = path.join(resolvedRoot, '.tmp')
  if (fs.existsSync(localTempRoot)) traversedEntryCount += 1
  const transaction = cacheTransaction(resolvedRoot, {
    runId,
    ownerIdentity,
    journalRoot,
    crashAt,
    onCrashBoundary,
    removeFreshRoot(sourceRoot) {
      forceRmSync(sourceRoot)
    }
  })
  for (const relativeDirectory of generatedDirectories.filter((entry) => entry !== '.tmp')) {
    const target = path.resolve(resolvedRoot, relativeDirectory)
    if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`refusing to clean path outside repository root: ${relativeDirectory}`)
    }
    if (fs.existsSync(target)) traversedEntryCount += 1
    forceRmSync(target)
  }
  return {
    schema: 'fsusblog.fresh-production-cleanup.v1',
    durationMs: Date.now() - startedAtMs,
    traversedEntryCount,
    removedRoots: generatedDirectories.length,
    preservedRoots: transaction.preservedRoots,
    cacheTransaction: {
      transactionId: transaction.transactionId,
      journalFile: transaction.journalFile,
      state: transaction.state,
      candidateIdentityDigest: transaction.candidateIdentityDigest
    }
  }
}
