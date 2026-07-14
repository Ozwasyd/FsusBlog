#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultStateRoot = path.join(repoRoot, '.tmp', 'run-once')
const defaultLockTimeoutMs = 5 * 60 * 1000
const defaultStaleLockMs = 15 * 60 * 1000
const defaultHeartbeatMs = 5 * 1000
const runBoundSchema = 'fsusblog.physical-execution-receipt.v3'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function digestValue(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

async function writeJsonAtomic(file, document) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}

function sanitizeSegment(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return !normalized || normalized === '.' || normalized === '..' ? fallback : normalized
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function hashOutputPath(output) {
  const hash = createHash('sha256')

  async function visit(current, relativePath) {
    const metadata = await lstat(current)
    const type = metadata.isDirectory()
      ? 'directory'
      : metadata.isFile()
        ? 'file'
        : metadata.isSymbolicLink()
          ? 'symlink'
          : 'other'
    hash.update(`${relativePath || '.'}\0${type}\0${metadata.mode & 0o777}\0${metadata.size}\0`)
    if (metadata.isFile()) {
      hash.update(await readFile(current))
      hash.update('\0')
      return
    }
    if (metadata.isSymbolicLink()) {
      hash.update(await readlink(current))
      hash.update('\0')
      return
    }
    if (!metadata.isDirectory()) return

    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
      await visit(path.join(current, entry.name), childRelativePath)
    }
  }

  await visit(output, '')
  return {
    path: output,
    digest: hash.digest('hex')
  }
}

async function captureOutputStates(outputs) {
  try {
    return await Promise.all((outputs ?? []).map(hashOutputPath))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function outputsMatchState(outputs, expectedStates) {
  if (!Array.isArray(expectedStates) || expectedStates.length !== outputs.length) return false
  const actualStates = await captureOutputStates(outputs)
  return actualStates != null && JSON.stringify(actualStates) === JSON.stringify(expectedStates)
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function writeLockOwner(ownerFile, owner) {
  const temporaryOwnerFile = `${ownerFile}.${owner.token}.tmp`
  await writeFile(temporaryOwnerFile, `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(temporaryOwnerFile, ownerFile)
}

async function releaseOwnedLock(lockDirectory, token) {
  const owner = await readState(path.join(lockDirectory, 'owner.json'))
  if (owner?.token === token) {
    await rm(lockDirectory, { recursive: true, force: true })
  }
}

async function clearDeadStaleLock(lockDirectory, staleAfterMs) {
  const ownerFile = path.join(lockDirectory, 'owner.json')
  const owner = await readState(ownerFile)
  let lockMetadata
  try {
    lockMetadata = await stat(ownerFile)
  } catch {
    try {
      lockMetadata = await stat(lockDirectory)
    } catch {
      return true
    }
  }

  const heartbeatAt = Date.parse(owner?.heartbeatAt ?? owner?.createdAt ?? '')
  const lastHeartbeatMs = Number.isFinite(heartbeatAt)
    ? Math.max(heartbeatAt, lockMetadata.mtimeMs)
    : lockMetadata.mtimeMs
  if (Date.now() - lastHeartbeatMs <= staleAfterMs) return false
  if (owner?.pid && isProcessAlive(Number(owner.pid))) return false

  const token = owner?.token
  const confirmedOwner = await readState(ownerFile)
  if (token && confirmedOwner?.token !== token) return false
  await rm(lockDirectory, { recursive: true, force: true })
  return true
}

async function acquireLock(lockDirectory, timeoutMs, {
  staleAfterMs,
  heartbeatEveryMs
}) {
  const startedAt = Date.now()
  for (;;) {
    const token = randomUUID()
    try {
      await mkdir(lockDirectory, { mode: 0o700 })
      const ownerFile = path.join(lockDirectory, 'owner.json')
      const owner = {
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
      await writeLockOwner(ownerFile, owner)

      let stopped = false
      let heartbeatInFlight = Promise.resolve()
      const heartbeat = () => {
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          if (stopped) return
          const current = await readState(ownerFile)
          if (current?.token !== token) return
          await writeLockOwner(ownerFile, {
            ...current,
            heartbeatAt: new Date().toISOString()
          })
        }).catch(() => {})
      }
      const heartbeatTimer = setInterval(heartbeat, Math.max(1, heartbeatEveryMs))
      heartbeatTimer.unref()
      return {
        token,
        async release() {
          stopped = true
          clearInterval(heartbeatTimer)
          await heartbeatInFlight
          await releaseOwnedLock(lockDirectory, token)
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error

      if (await clearDeadStaleLock(lockDirectory, staleAfterMs)) continue

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for run-once lock: ${lockDirectory}`)
      }
      await sleep(100)
    }
  }
}

export async function runOnce({
  root = defaultStateRoot,
  namespace = process.env.FSUSBLOG_TEST_NAMESPACE || 'local',
  key,
  fingerprint,
  requiredOutputs = [],
  lockTimeoutMs = defaultLockTimeoutMs,
  staleLockMs = defaultStaleLockMs,
  heartbeatMs = defaultHeartbeatMs
}, operation) {
  if (!String(key ?? '').trim()) throw new Error('run-once key is required')
  if (!String(fingerprint ?? '').trim()) throw new Error('run-once fingerprint is required')
  if (typeof operation !== 'function') throw new Error('run-once operation must be a function')

  const namespaceDirectory = path.join(root, sanitizeSegment(namespace, 'local'))
  const normalizedKey = sanitizeSegment(key, 'operation')
  const stateFile = path.join(namespaceDirectory, `${normalizedKey}.json`)
  const lockDirectory = path.join(namespaceDirectory, `${normalizedKey}.lock`)
  const normalizedOutputs = requiredOutputs.map((output) => path.resolve(output)).sort()
  await mkdir(namespaceDirectory, { recursive: true })

  const current = await readState(stateFile)
  if (current?.status === 'success'
      && current.fingerprint === fingerprint
      && await outputsMatchState(normalizedOutputs, current.requiredOutputStates)) {
    return { status: 'shared-current-run', stateFile }
  }

  const lock = await acquireLock(lockDirectory, lockTimeoutMs, {
    staleAfterMs: Math.max(1, Number(staleLockMs) || defaultStaleLockMs),
    heartbeatEveryMs: Math.max(1, Number(heartbeatMs) || defaultHeartbeatMs)
  })
  try {
    const lockedCurrent = await readState(stateFile)
    if (lockedCurrent?.status === 'success'
        && lockedCurrent.fingerprint === fingerprint
        && await outputsMatchState(normalizedOutputs, lockedCurrent.requiredOutputStates)) {
      return { status: 'shared-current-run', stateFile }
    }

    await operation()
    const requiredOutputStates = await captureOutputStates(normalizedOutputs)
    if (requiredOutputStates == null) {
      throw new Error(`run-once command succeeded without required outputs: ${normalizedOutputs.join(', ')}`)
    }

    const nextState = {
      schema: 'fsusblog.test-run-once.v2',
      namespace: sanitizeSegment(namespace, 'local'),
      key: normalizedKey,
      fingerprint,
      status: 'success',
      requiredOutputs: normalizedOutputs,
      requiredOutputStates,
      completedAt: new Date().toISOString()
    }
    const temporaryState = `${stateFile}.${process.pid}.tmp`
    await writeFile(temporaryState, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8')
    await rename(temporaryState, stateFile)
    return { status: 'executed', stateFile }
  } finally {
    await lock.release()
  }
}

function receiptPayload(receipt) {
  const { receiptDigest: _receiptDigest, ...payload } = receipt
  return payload
}

function validateReceiptIntegrity(receipt, { contractDigest, runId }) {
  if (receipt?.schema !== runBoundSchema
      || receipt.schedulerRunId !== runId
      || receipt.contractDigest !== contractDigest
      || receipt.receiptDigest !== digestValue(receiptPayload(receipt))) {
    throw new Error('run-bound receipt integrity validation failed')
  }
}

function receiptFailure(receipt) {
  const error = new Error(receipt.failure?.message || `run-bound producer ${receipt.status}`)
  error.name = receipt.failure?.name || 'RunBoundProducerError'
  error.exitCode = receipt.failure?.exitCode ?? null
  error.signal = receipt.failure?.signal ?? null
  error.receiptStatus = receipt.status
  return error
}

async function summarizeRunBoundExecutions(root, runId) {
  const runDirectory = path.join(root, sanitizeSegment(runId, 'run'))
  const receiptRoot = path.join(runDirectory, 'receipts')
  const projectionRoot = path.join(runDirectory, 'projections')
  const readJsonFiles = async (directory) => {
    if (!await exists(directory)) return []
    const files = []
    const visit = async (current) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name)
        if (entry.isDirectory() && !entry.name.endsWith('.lock')) await visit(child)
        else if (entry.isFile() && entry.name.endsWith('.json')) files.push(child)
      }
    }
    await visit(directory)
    return await Promise.all(files.sort().map(async (file) => ({
      file,
      document: await readState(file),
      bytes: (await stat(file)).size
    })))
  }
  const [receipts, projections] = await Promise.all([
    readJsonFiles(receiptRoot),
    readJsonFiles(projectionRoot)
  ])
  const validProjections = projections.map((entry) => entry.document).filter(Boolean)
  const summary = {
    schema: 'fsusblog.physical-execution-summary.v1',
    schedulerRunId: runId,
    physicalExecutions: receipts.length,
    logicalConsumers: validProjections.length,
    dedupHits: validProjections.filter((entry) => entry.disposition === 'consumer').length,
    avoidedChildStartups: validProjections.reduce((total, entry) => total + Number(entry.avoidedChildStartups ?? 0), 0),
    totalConsumerWaitMs: validProjections.reduce((total, entry) => total + Number(entry.waitedMs ?? 0), 0),
    receiptBytes: receipts.reduce((total, entry) => total + entry.bytes, 0),
    producers: receipts.map((entry) => ({
      key: entry.document?.executionKey,
      status: entry.document?.status,
      receipt: path.relative(repoRoot, entry.file).replaceAll(path.sep, '/')
    })),
    consumers: validProjections.map((entry) => ({
      consumerId: entry.consumerId,
      key: entry.executionKey,
      disposition: entry.disposition,
      waitedMs: entry.waitedMs,
      physicalExecutionReceipt: entry.physicalExecutionReceipt
    })),
    generatedAt: new Date().toISOString()
  }
  await writeJsonAtomic(path.join(runDirectory, 'summary.json'), summary)
  return summary
}

async function writeRunBoundProjection({
  root,
  runId,
  receiptFile,
  receipt,
  consumerId,
  testIds,
  disposition,
  waitedMs
}) {
  validateReceiptIntegrity(receipt, { contractDigest: receipt.contractDigest, runId })
  if (receipt.status === 'success'
      && !await outputsMatchState(receipt.requiredOutputs, receipt.requiredOutputStates)) {
    throw new Error('run-bound receipt output projection failed closed')
  }
  const projection = {
    schema: 'fsusblog.physical-execution-projection.v1',
    schedulerRunId: runId,
    executionKey: receipt.executionKey,
    consumerId,
    disposition,
    avoidedChildStartups: disposition === 'consumer' ? 1 : 0,
    waitedMs,
    status: receipt.status,
    testIds: [...new Set(testIds ?? [])].sort(),
    artifactEvidence: receipt.requiredOutputStates,
    physicalExecutionReceipt: path.relative(repoRoot, receiptFile).replaceAll(path.sep, '/'),
    physicalExecutionReceiptDigest: receipt.receiptDigest,
    projectedAt: new Date().toISOString()
  }
  const projectionDirectory = path.join(root, sanitizeSegment(runId, 'run'), 'projections')
  const projectionFile = path.join(
    projectionDirectory,
    `${sanitizeSegment(consumerId, 'consumer')}-${sanitizeSegment(receipt.executionKey, 'execution')}-${randomUUID()}.json`
  )
  await writeJsonAtomic(projectionFile, projection)
  await summarizeRunBoundExecutions(root, runId)
  return projectionFile
}

export async function runBoundExecution({
  root = path.join(repoRoot, '.tmp', 'physical-executions'),
  runId,
  key,
  command,
  cwd,
  inputDigest,
  environmentDigest,
  outputContract = [],
  requiredOutputs = [],
  commit,
  worktreeFingerprint,
  testIds = [],
  consumerId = 'consumer',
  lockTimeoutMs = defaultLockTimeoutMs,
  staleLockMs = defaultStaleLockMs,
  heartbeatMs = defaultHeartbeatMs
}, operation) {
  for (const [name, value] of Object.entries({ runId, key, inputDigest, environmentDigest, commit, worktreeFingerprint })) {
    if (!String(value ?? '').trim()) throw new Error(`run-bound ${name} is required`)
  }
  if (!Array.isArray(command) || command.length === 0) throw new Error('run-bound normalized command is required')
  if (typeof operation !== 'function') throw new Error('run-bound operation must be a function')

  const normalizedRunId = sanitizeSegment(runId, 'run')
  const normalizedKey = sanitizeSegment(key, 'execution')
  const normalizedCwd = path.resolve(cwd ?? repoRoot)
  const normalizedOutputs = requiredOutputs.map((output) => path.resolve(normalizedCwd, output)).sort()
  const contract = {
    schedulerRunId: runId,
    executionKey: normalizedKey,
    command: command.map(String),
    cwd: normalizedCwd,
    inputDigest,
    environmentDigest,
    outputContract: [...outputContract].map(String).sort(),
    requiredOutputs: normalizedOutputs,
    commit,
    worktreeFingerprint
  }
  const contractDigest = digestValue(contract)
  const receiptDirectory = path.join(root, normalizedRunId, 'receipts', normalizedKey)
  const receiptFile = path.join(receiptDirectory, `${contractDigest}.json`)
  const lockDirectory = path.join(receiptDirectory, `${contractDigest}.lock`)
  await mkdir(receiptDirectory, { recursive: true })
  const requestedAt = Date.now()

  const consume = async (receipt, disposition, waitedMs = Date.now() - requestedAt) => {
    validateReceiptIntegrity(receipt, { contractDigest, runId })
    const projectionFile = await writeRunBoundProjection({
      root,
      runId,
      receiptFile,
      receipt,
      consumerId,
      testIds,
      disposition,
      waitedMs
    })
    if (receipt.status !== 'success') throw receiptFailure(receipt)
    return { status: disposition === 'consumer' ? 'shared-current-run' : 'executed', receiptFile, projectionFile }
  }

  const current = await readState(receiptFile)
  if (current) return await consume(current, 'consumer')

  const lock = await acquireLock(lockDirectory, lockTimeoutMs, {
    staleAfterMs: Math.max(1, Number(staleLockMs) || defaultStaleLockMs),
    heartbeatEveryMs: Math.max(1, Number(heartbeatMs) || defaultHeartbeatMs)
  })
  try {
    const lockedCurrent = await readState(receiptFile)
    if (lockedCurrent) return await consume(lockedCurrent, 'consumer')

    const producerWaitMs = Date.now() - requestedAt
    const startedAt = new Date().toISOString()
    const startedAtMs = Date.now()
    let status = 'success'
    let failure = null
    try {
      await operation()
    } catch (error) {
      status = error?.name === 'AbortError' || error?.signal ? 'cancelled' : 'failure'
      failure = {
        name: error?.name ?? 'Error',
        message: error instanceof Error ? error.message : String(error),
        exitCode: error?.exitCode ?? null,
        signal: error?.signal ?? null
      }
    }
    const requiredOutputStates = await captureOutputStates(normalizedOutputs)
    if (status === 'success' && requiredOutputStates == null) {
      status = 'failure'
      failure = {
        name: 'MissingRequiredOutputError',
        message: `run-bound command succeeded without required outputs: ${normalizedOutputs.join(', ')}`,
        exitCode: null,
        signal: null
      }
    }
    const payload = {
      schema: runBoundSchema,
      ...contract,
      contractDigest,
      status,
      producer: {
        consumerId,
        pid: process.pid
      },
      testIds: [...new Set(testIds)].sort(),
      requiredOutputStates: requiredOutputStates ?? [],
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      failure
    }
    const receipt = { ...payload, receiptDigest: digestValue(payload) }
    await writeJsonAtomic(receiptFile, receipt)
    return await consume(receipt, 'producer', producerWaitMs)
  } finally {
    await lock.release()
  }
}

async function collectFiles(input, files) {
  const metadata = await stat(input)
  if (metadata.isFile()) {
    files.push(input)
    return
  }
  if (!metadata.isDirectory()) return

  const entries = await readdir(input, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && new Set(['.git', '.tmp', 'bin', 'coverage', 'dist', 'node_modules', 'obj', 'test-results']).has(entry.name)) {
      continue
    }
    await collectFiles(path.join(input, entry.name), files)
  }
}

export async function fingerprintPaths(inputs, {
  root = repoRoot,
  values = [],
  secretEnvironmentNames = [],
  env = process.env
} = {}) {
  const files = []
  for (const input of inputs ?? []) {
    const absolutePath = path.resolve(root, input)
    if (!await exists(absolutePath)) {
      throw new Error(`fingerprint input does not exist: ${input}`)
    }
    await collectFiles(absolutePath, files)
  }

  const hash = createHash('sha256')
  for (const value of values) {
    hash.update('value\0')
    hash.update(String(value))
    hash.update('\0')
  }
  for (const name of [...new Set(secretEnvironmentNames)].sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`invalid secret environment name: ${name}`)
    }
    const secretDigest = createHash('sha256').update(String(env[name] ?? '')).digest('hex')
    hash.update('secret-env\0')
    hash.update(name)
    hash.update('\0')
    hash.update(secretDigest)
    hash.update('\0')
  }
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replaceAll(path.sep, '/'))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function parseOptions(argv) {
  const options = { paths: [], values: [], secretEnvs: [], requiredOutputs: [] }
  let commandIndex = -1
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      commandIndex = index + 1
      break
    }
    const name = argument.replace(/^--/u, '')
    const value = argv[index + 1]
    if (!argument.startsWith('--') || value == null) throw new Error(`invalid run-once option: ${argument}`)
    index += 1
    if (name === 'path') options.paths.push(value)
    else if (name === 'value') options.values.push(value)
    else if (name === 'secret-env') options.secretEnvs.push(value)
    else if (name === 'require-output') options.requiredOutputs.push(value)
    else options[name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value
  }
  return {
    options,
    command: commandIndex >= 0 ? argv.slice(commandIndex) : []
  }
}

async function spawnCommand(command, { cwd }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: process.env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`command failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${command.join(' ')}`))
    })
  })
}

async function main(argv) {
  const action = argv[0]
  const { options, command } = parseOptions(argv.slice(1))
  if (action === 'fingerprint') {
    console.log(await fingerprintPaths(options.paths, {
      root: options.root ? path.resolve(options.root) : repoRoot,
      values: options.values,
      secretEnvironmentNames: options.secretEnvs,
      env: process.env
    }))
    return
  }
  if (action !== 'run') throw new Error('usage: run-once.mjs <fingerprint|run> [options]')
  if (command.length === 0) throw new Error('run-once run requires a command after --')

  const cwd = options.cwd ? path.resolve(options.cwd) : repoRoot
  const result = await runOnce({
    root: options.root ? path.resolve(options.root) : defaultStateRoot,
    namespace: options.namespace,
    key: options.key,
    fingerprint: options.fingerprint,
    requiredOutputs: options.requiredOutputs.map((output) => path.resolve(cwd, output)),
    lockTimeoutMs: Number(options.lockTimeoutMs ?? defaultLockTimeoutMs),
    staleLockMs: Number(options.staleLockMs ?? defaultStaleLockMs),
    heartbeatMs: Number(options.heartbeatMs ?? defaultHeartbeatMs)
  }, async () => spawnCommand(command, { cwd }))
  console.log(`[run-once] ${result.status} key=${options.key} state=${result.stateFile}`)
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[run-once] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
