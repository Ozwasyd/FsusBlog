import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function namespaceSlug(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return !normalized || normalized === '.' || normalized === '..' ? 'local' : normalized
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const values = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function ownedContainerNames(namespace) {
  return new Set([
    `fsusblog-test-postgres-${namespace}`,
    `fsusblog-test-redis-${namespace}`
  ])
}

function defaultRemoveContainer(name) {
  spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' })
}

function defaultKillProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

function removeWithinRoot(root, relative) {
  const target = path.resolve(root, relative)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing to clean path outside repository root: ${relative}`)
  }
  fs.rmSync(target, { recursive: true, force: true })
}

export function cleanupLocalRuntime({
  root,
  namespace,
  removeContainer = defaultRemoveContainer,
  killProcess = defaultKillProcess
}) {
  const resolvedRoot = path.resolve(root)
  const slug = namespaceSlug(namespace)
  const envRelative = path.join('.tmp', 'env', `${slug}.env`)
  const envFile = path.join(resolvedRoot, envRelative)
  const environment = readEnvFile(envFile)
  const owned = ownedContainerNames(slug)
  const configuredContainers = [
    environment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
    environment.FSUSBLOG_REDIS_CONTAINER_NAME
  ].filter(Boolean)
  const removedContainers = []
  const skippedContainers = []
  for (const container of configuredContainers) {
    if (!owned.has(container)) {
      skippedContainers.push(container)
      continue
    }
    removeContainer(container)
    removedContainers.push(container)
  }

  const runtimeRelative = path.join('.tmp', 'acceptance', slug)
  const runtimeDirectory = path.join(resolvedRoot, runtimeRelative)
  const terminatedPids = []
  if (fs.existsSync(runtimeDirectory)) {
    for (const entry of fs.readdirSync(runtimeDirectory)) {
      if (!entry.endsWith('.pid')) continue
      const value = Number.parseInt(fs.readFileSync(path.join(runtimeDirectory, entry), 'utf8').trim(), 10)
      if (Number.isInteger(value) && value > 1 && killProcess(value)) terminatedPids.push(value)
    }
  }

  for (const relative of [
    runtimeRelative,
    path.join('.tmp', 'fixtures', slug),
    path.join('.tmp', 'data', slug),
    envRelative
  ]) {
    removeWithinRoot(resolvedRoot, relative)
  }

  return { namespace: slug, removedContainers, skippedContainers, terminatedPids }
}
