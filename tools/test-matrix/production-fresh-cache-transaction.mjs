import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const productionFreshCacheTransactionSchema =
  'fsusblog.production-fresh-cache-transaction.v1'
export const productionFreshCacheTransactionStates = Object.freeze([
  'prepared',
  'evacuating',
  'evacuated',
  'fresh-root-cleared',
  'restoring',
  'restored',
  'committed',
  'aborted',
  'recovery-required'
])
export const productionFreshCacheEntries = Object.freeze([
  Object.freeze({ logicalCacheId: 'emscripten', relativePath: 'emscripten-cache' }),
  Object.freeze({ logicalCacheId: 'dependencies', relativePath: 'dependency-cache' }),
  Object.freeze({ logicalCacheId: 'dotnet', relativePath: 'data-root/cache' }),
  Object.freeze({ logicalCacheId: 'builds', relativePath: 'build' })
])
export const productionFreshCacheCrashBoundaries = Object.freeze([
  'after-prepared',
  'after-first-entry-evacuated',
  'after-all-evacuated',
  'after-fresh-root-cleared',
  'after-first-entry-restored',
  'after-all-restored-before-commit',
  'after-commit-before-holding-cleanup'
])

const terminalStates = new Set(['committed', 'aborted'])
const entryStates = new Set(['registered', 'evacuated', 'restored'])
const requiredOwnerFields = Object.freeze([
  'leaseId',
  'ownerToken',
  'canonicalRepositoryRoot',
  'profile',
  'candidateIdentityDigest',
  'pid',
  'processStartIdentity',
  'executableDigest',
  'commandDigest',
  'processGroupOrJobIdentity'
])

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function digestValue(value) {
  return digestBytes(JSON.stringify(canonicalize(value)))
}

function digestFile(file) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const descriptor = fs.openSync(file, 'r')
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return `sha256:${hash.digest('hex')}`
}

function validDigest(value) {
  return /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ''))
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value))
}

function journalPayload(journal) {
  const { contentDigest: _contentDigest, ...payload } = journal ?? {}
  return payload
}

function sealJournal(journal) {
  const payload = journalPayload(journal)
  return {
    ...payload,
    contentDigest: digestValue(payload)
  }
}

function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch (error) {
    throw new Error(
      `production fresh cache transaction requires directory fsync support for ${directory}: ${error.message}`,
      { cause: error }
    )
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function durableMkdir(directory) {
  if (fs.existsSync(directory)) {
    const metadata = fs.lstatSync(directory)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`production fresh cache durable directory is unsafe: ${directory}`)
    }
    return
  }
  const missing = []
  let current = directory
  while (!fs.existsSync(current)) {
    missing.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const existingMetadata = fs.lstatSync(current)
  if (existingMetadata.isSymbolicLink() || !existingMetadata.isDirectory()) {
    throw new Error(`production fresh cache durable parent is unsafe: ${current}`)
  }
  for (const candidate of missing.reverse()) {
    fs.mkdirSync(candidate, { mode: 0o700 })
    fsyncDirectory(path.dirname(candidate))
  }
}

function durableWriteJson(file, value) {
  durableMkdir(path.dirname(file))
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, file)
  fsyncDirectory(path.dirname(file))
}

function durableRename(source, target) {
  const sourceParent = path.dirname(source)
  const targetParent = path.dirname(target)
  if (fs.statSync(sourceParent).dev !== fs.statSync(targetParent).dev) {
    throw new Error(
      `production fresh cache transaction requires same-filesystem atomic rename: ${source} -> ${target}`
    )
  }
  fs.renameSync(source, target)
  fsyncDirectory(sourceParent)
  if (targetParent !== sourceParent) fsyncDirectory(targetParent)
}

function durableRemoveDirectory(directory) {
  if (!fs.existsSync(directory)) return
  fs.rmSync(directory, { recursive: true, force: false })
  fsyncDirectory(path.dirname(directory))
}

function fsyncTree(root) {
  const directories = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    const metadata = fs.lstatSync(current)
    if (metadata.isSymbolicLink()) {
      throw new Error(`production fresh cache contains a symlink: ${current}`)
    }
    if (metadata.isDirectory()) {
      directories.push(current)
      for (const child of fs.readdirSync(current)) pending.push(path.join(current, child))
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`production fresh cache contains an unsupported filesystem entry: ${current}`)
    }
    const descriptor = fs.openSync(current, 'r')
    try {
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }
  for (const directory of directories.reverse()) fsyncDirectory(directory)
}

function commonGitDirectory(root) {
  const dotGit = path.join(root, '.git')
  if (!fs.existsSync(dotGit)) return path.join(root, '.fsusblog-production-fresh-cache-journals')
  if (fs.lstatSync(dotGit).isDirectory()) return fs.realpathSync(dotGit)
  const match = /^gitdir:\s*(.+)\s*$/u.exec(fs.readFileSync(dotGit, 'utf8'))
  if (!match) throw new Error(`production fresh cache transaction cannot resolve Git directory: ${dotGit}`)
  const gitDirectory = fs.realpathSync(path.resolve(root, match[1]))
  const commonDirectoryFile = path.join(gitDirectory, 'commondir')
  return fs.existsSync(commonDirectoryFile)
    ? fs.realpathSync(path.resolve(gitDirectory, fs.readFileSync(commonDirectoryFile, 'utf8').trim()))
    : gitDirectory
}

function canonicalizeMissingPath(candidate) {
  const missing = []
  let current = path.resolve(candidate)
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current))
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`cannot canonicalize missing path: ${candidate}`)
    current = parent
  }
  return path.join(fs.realpathSync(current), ...missing)
}

function resolveSourceRoot(canonicalRepositoryRoot) {
  const logicalRoot = path.join(canonicalRepositoryRoot, '.tmp')
  let metadata
  try {
    metadata = fs.lstatSync(logicalRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return logicalRoot
    throw error
  }
  if (metadata.isSymbolicLink()) {
    const linkTarget = path.resolve(path.dirname(logicalRoot), fs.readlinkSync(logicalRoot))
    const physicalRoot = canonicalizeMissingPath(linkTarget)
    if (physicalRoot === path.parse(physicalRoot).root || physicalRoot === canonicalRepositoryRoot) {
      throw new Error(`refusing unsafe production fresh cache source root: ${physicalRoot}`)
    }
    return physicalRoot
  }
  if (!metadata.isDirectory()) {
    throw new Error(`production fresh cache source root must be a directory: ${logicalRoot}`)
  }
  return fs.realpathSync(logicalRoot)
}

function transactionLayout(root, options = {}) {
  const canonicalRepositoryRoot = fs.realpathSync(root)
  const sourceRoot = resolveSourceRoot(canonicalRepositoryRoot)
  const repositoryDigest = digestValue({ canonicalRepositoryRoot }).slice('sha256:'.length)
  const journalBase = path.resolve(
    options.journalRoot ?? path.join(commonGitDirectory(canonicalRepositoryRoot), 'production-fresh-cache-transactions')
  )
  if (journalBase === sourceRoot || journalBase.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error('production fresh cache journal must be outside the cleaned source root')
  }
  const journalRoot = path.join(journalBase, repositoryDigest)
  const holdingRoot = path.join(
    path.dirname(sourceRoot),
    '.fsusblog-production-fresh-cache-holding',
    repositoryDigest
  )
  if (holdingRoot === sourceRoot || holdingRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error('production fresh cache holding root must be outside the cleaned source root')
  }
  return { canonicalRepositoryRoot, sourceRoot, journalRoot, holdingRoot }
}

function normalizeOwnerIdentity(ownerIdentity, canonicalRepositoryRoot) {
  if (
    !ownerIdentity ||
    requiredOwnerFields.some((field) => !Object.hasOwn(ownerIdentity, field)) ||
    ['leaseId', 'ownerToken', 'processStartIdentity'].some(
      (field) => typeof ownerIdentity[field] !== 'string' || ownerIdentity[field].length === 0
    ) ||
    ownerIdentity.canonicalRepositoryRoot !== canonicalRepositoryRoot ||
    ownerIdentity.profile !== 'production-fresh' ||
    !validDigest(ownerIdentity.candidateIdentityDigest) ||
    !validDigest(ownerIdentity.executableDigest) ||
    !validDigest(ownerIdentity.commandDigest) ||
    !Number.isInteger(ownerIdentity.pid) ||
    ownerIdentity.pid <= 0 ||
    !ownerIdentity.processGroupOrJobIdentity ||
    typeof ownerIdentity.processGroupOrJobIdentity !== 'object'
  ) {
    throw new Error('production fresh cache transaction owner identity is incomplete or mismatched')
  }
  return Object.fromEntries(requiredOwnerFields.map((field) => [field, ownerIdentity[field]]))
}

function pathWithin(parent, candidate) {
  return candidate.startsWith(`${parent}${path.sep}`)
}

function assertExactEntryPaths(entry, journal, layout) {
  const declaration = productionFreshCacheEntries.find(
    (candidate) => candidate.logicalCacheId === entry.logicalCacheId
  )
  if (!declaration) throw new Error(`unknown production fresh cache ID: ${entry.logicalCacheId}`)
  const expectedOriginal = path.join(journal.sourceRoot, declaration.relativePath)
  const expectedHolding = path.join(layout.holdingRoot, journal.transactionId, declaration.logicalCacheId)
  if (
    entry.originalPath !== expectedOriginal ||
    entry.holdingPath !== expectedHolding ||
    !pathWithin(journal.sourceRoot, entry.originalPath) ||
    !pathWithin(path.join(layout.holdingRoot, journal.transactionId), entry.holdingPath)
  ) {
    throw new Error(`production fresh cache entry path mismatch: ${entry.logicalCacheId}`)
  }
}

function snapshotTree(root) {
  const records = []
  const inodeOccurrences = new Map()
  const pending = [{ absolutePath: root, relativePath: '.' }]
  while (pending.length > 0) {
    const { absolutePath, relativePath } = pending.pop()
    const metadata = fs.lstatSync(absolutePath, { bigint: true })
    if (metadata.isSymbolicLink()) {
      throw new Error(`production fresh cache contains a symlink: ${absolutePath}`)
    }
    const common = {
      path: relativePath.replaceAll(path.sep, '/'),
      mode: Number(metadata.mode & 0o7777n),
      uid: Number(metadata.uid),
      gid: Number(metadata.gid)
    }
    if (metadata.isDirectory()) {
      records.push({ ...common, type: 'directory' })
      const children = fs.readdirSync(absolutePath).sort().reverse()
      for (const child of children) {
        pending.push({
          absolutePath: path.join(absolutePath, child),
          relativePath: relativePath === '.' ? child : path.join(relativePath, child)
        })
      }
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`production fresh cache contains an unsupported filesystem entry: ${absolutePath}`)
    }
    const inodeKey = `${metadata.dev}:${metadata.ino}`
    const occurrences = inodeOccurrences.get(inodeKey) ?? { count: 0, linkCount: Number(metadata.nlink) }
    occurrences.count += 1
    inodeOccurrences.set(inodeKey, occurrences)
    records.push({
      ...common,
      type: 'file',
      size: Number(metadata.size),
      digest: digestFile(absolutePath)
    })
  }
  for (const [inodeKey, occurrence] of inodeOccurrences) {
    if (occurrence.count !== occurrence.linkCount) {
      throw new Error(`production fresh cache hardlink escapes the registered root: ${inodeKey}`)
    }
  }
  const rootMetadata = fs.lstatSync(root, { bigint: true })
  return {
    digest: digestValue(records.map(({ mode: _mode, uid: _uid, gid: _gid, ...record }) => record)),
    mode: Number(rootMetadata.mode & 0o7777n),
    owner: { uid: Number(rootMetadata.uid), gid: Number(rootMetadata.gid) },
    metadataDigest: digestValue(records.map(({ digest: _digest, size: _size, ...record }) => record))
  }
}

function verifyEntryAt(entry, location, label) {
  if (!fs.existsSync(location)) {
    throw new Error(`${label} is missing for ${entry.logicalCacheId}: ${location}`)
  }
  const actual = snapshotTree(location)
  if (actual.digest !== entry.preDigest) {
    throw new Error(`${label} digest changed for ${entry.logicalCacheId}`)
  }
  if (actual.mode !== entry.mode || actual.metadataDigest !== entry.metadataDigest) {
    throw new Error(`${label} mode changed for ${entry.logicalCacheId}`)
  }
  if (actual.owner.uid !== entry.owner.uid || actual.owner.gid !== entry.owner.gid) {
    throw new Error(`${label} owner changed for ${entry.logicalCacheId}`)
  }
  return actual
}

function journalIsComplete(journal, layout) {
  if (
    !journal ||
    journal.schema !== productionFreshCacheTransactionSchema ||
    typeof journal.transactionId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      journal.transactionId
    ) ||
    typeof journal.runId !== 'string' ||
    journal.runId.length === 0 ||
    !validDigest(journal.candidateIdentityDigest) ||
    !journal.ownerIdentity ||
    journal.sourceRoot !== layout.sourceRoot ||
    !Array.isArray(journal.entries) ||
    journal.entries.length > productionFreshCacheEntries.length ||
    !productionFreshCacheTransactionStates.includes(journal.state) ||
    !Array.isArray(journal.actions) ||
    !validTimestamp(journal.createdAt) ||
    !validTimestamp(journal.updatedAt) ||
    Date.parse(journal.createdAt) > Date.parse(journal.updatedAt) ||
    ![null, ...productionFreshCacheCrashBoundaries].includes(journal.crashInjectionPoint) ||
    ![null, 'committed', 'aborted'].includes(journal.finalState) ||
    !validDigest(journal.contentDigest) ||
    sealJournal(journal).contentDigest !== journal.contentDigest
  ) {
    return false
  }
  if (
    journal.ownerIdentity.candidateIdentityDigest !== journal.candidateIdentityDigest ||
    (terminalStates.has(journal.state) && journal.finalState !== journal.state) ||
    (!terminalStates.has(journal.state) && journal.finalState !== null)
  ) {
    return false
  }
  const ids = new Set()
  try {
    normalizeOwnerIdentity(journal.ownerIdentity, layout.canonicalRepositoryRoot)
    for (const entry of journal.entries) {
      if (
        ids.has(entry.logicalCacheId) ||
        !entryStates.has(entry.state) ||
        !validDigest(entry.preDigest) ||
        !validDigest(entry.metadataDigest) ||
        !Number.isInteger(entry.mode) ||
        !Number.isInteger(entry.owner?.uid) ||
        !Number.isInteger(entry.owner?.gid)
      ) {
        return false
      }
      ids.add(entry.logicalCacheId)
      assertExactEntryPaths(entry, journal, layout)
    }
  } catch {
    return false
  }
  return ids.size === journal.entries.length
}

function readJournal(journalFile, layout) {
  let journal
  try {
    journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  } catch {
    throw new Error(`production fresh cache journal is corrupt: ${journalFile}`)
  }
  if (!journalIsComplete(journal, layout)) {
    throw new Error(`production fresh cache journal is incomplete, unknown, or corrupt: ${journalFile}`)
  }
  if (path.basename(journalFile) !== `${journal.transactionId}.json`) {
    throw new Error(`production fresh cache journal filename identity mismatch: ${journalFile}`)
  }
  return journal
}

function updateJournal(context, changes, action = null) {
  const timestamp = new Date(context.now()).toISOString()
  const actions = action
    ? [...context.journal.actions, { ...action, at: timestamp }]
    : context.journal.actions
  context.journal = sealJournal({
    ...context.journal,
    ...changes,
    actions,
    updatedAt: timestamp
  })
  durableWriteJson(context.journalFile, context.journal)
}

function failRecoveryRequired(context, error, phase) {
  try {
    updateJournal(context, {
      state: 'recovery-required',
      failure: { phase, message: error.message }
    }, { type: 'recovery-required', phase })
  } catch (journalError) {
    throw new AggregateError(
      [error, journalError],
      `production fresh cache recovery-required and journal update failed during ${phase}`
    )
  }
  throw new Error(
    `production fresh cache recovery-required during ${phase}: ${error.message}`,
    { cause: error }
  )
}

function invokeCrashBoundary(context, boundary) {
  if (!productionFreshCacheCrashBoundaries.includes(boundary)) {
    throw new Error(`unknown production fresh cache crash boundary: ${boundary}`)
  }
  if (context.crashAt !== boundary && !context.onCrashBoundary) return
  updateJournal(context, {
    crashInjectionPoint: boundary
  }, { type: 'crash-boundary', boundary })
  context.onCrashBoundary?.(boundary, context.journal)
  if (context.crashAt === boundary) {
    const error = new Error(`simulated production fresh cache crash at ${boundary}`)
    error.code = 'FSUSBLOG_SIMULATED_CRASH'
    throw error
  }
}

function reconcileEntry(entry) {
  const originalExists = fs.existsSync(entry.originalPath)
  const holdingExists = fs.existsSync(entry.holdingPath)
  if (originalExists && holdingExists) {
    throw new Error(`both original and holding paths exist for ${entry.logicalCacheId}`)
  }
  if (holdingExists) {
    verifyEntryAt(entry, entry.holdingPath, 'holding entry')
    return 'evacuated'
  }
  if (originalExists) {
    verifyEntryAt(entry, entry.originalPath, 'original entry')
    return 'restored'
  }
  throw new Error(`both original and holding paths are missing for ${entry.logicalCacheId}`)
}

function restoreEntries(context, terminalState) {
  updateJournal(context, { state: 'restoring' }, { type: 'state', state: 'restoring' })
  let restoredCount = 0
  for (let index = 0; index < context.journal.entries.length; index += 1) {
    const entry = context.journal.entries[index]
    const actualState = reconcileEntry(entry)
    if (actualState === 'evacuated') {
      durableMkdir(path.dirname(entry.originalPath))
      durableRename(entry.holdingPath, entry.originalPath)
      fsyncTree(entry.originalPath)
      verifyEntryAt(entry, entry.originalPath, 'restored entry')
    }
    const entries = context.journal.entries.map((candidate, candidateIndex) => (
      candidateIndex === index ? { ...candidate, state: 'restored' } : candidate
    ))
    updateJournal(context, { entries }, {
      type: 'restore',
      logicalCacheId: entry.logicalCacheId,
      preDigest: entry.preDigest,
      postDigest: snapshotTree(entry.originalPath).digest
    })
    restoredCount += 1
    if (restoredCount === 1) invokeCrashBoundary(context, 'after-first-entry-restored')
  }
  updateJournal(context, { state: 'restored' }, { type: 'state', state: 'restored' })
  invokeCrashBoundary(context, 'after-all-restored-before-commit')
  updateJournal(context, {
    state: terminalState,
    finalState: terminalState
  }, { type: 'state', state: terminalState })
  if (terminalState === 'committed') {
    invokeCrashBoundary(context, 'after-commit-before-holding-cleanup')
  }
  const transactionHoldingRoot = path.join(context.layout.holdingRoot, context.journal.transactionId)
  durableRemoveDirectory(transactionHoldingRoot)
}

function recoverJournal(context) {
  if (context.journal.state === 'recovery-required') {
    throw new Error(`production fresh cache transaction requires operator recovery: ${context.journalFile}`)
  }
  try {
    if (terminalStates.has(context.journal.state)) {
      const transactionHoldingRoot = path.join(
        context.layout.holdingRoot,
        context.journal.transactionId
      )
      if (!fs.existsSync(transactionHoldingRoot)) return
      const residual = fs.readdirSync(transactionHoldingRoot)
      if (residual.length > 0) {
        throw new Error(
          `terminal transaction contains unexpected holding residue: ${context.journal.transactionId}`
        )
      }
      durableRemoveDirectory(transactionHoldingRoot)
      return
    }
    const states = context.journal.entries.map(reconcileEntry)
    const hasEvacuated = states.includes('evacuated')
    if (!hasEvacuated) {
      const recoveredTerminalState = ['restoring', 'restored'].includes(context.journal.state)
        ? 'committed'
        : 'aborted'
      updateJournal(context, {
        entries: context.journal.entries.map((entry) => ({ ...entry, state: 'restored' })),
        state: recoveredTerminalState,
        finalState: recoveredTerminalState
      }, {
        type: recoveredTerminalState === 'committed' ? 'recovery-commit' : 'recovery-abort',
        fromState: context.journal.state
      })
      durableRemoveDirectory(path.join(context.layout.holdingRoot, context.journal.transactionId))
      return
    }
    if (
      states.some((state) => state === 'restored') &&
      states.some((state) => state === 'evacuated') &&
      ['evacuated', 'fresh-root-cleared'].includes(context.journal.state)
    ) {
      throw new Error(`transaction paths conflict with state ${context.journal.state}`)
    }
    restoreEntries(context, context.journal.state === 'prepared' || context.journal.state === 'evacuating'
      ? 'aborted'
      : 'committed')
  } catch (error) {
    if (error?.code === 'FSUSBLOG_SIMULATED_CRASH') throw error
    failRecoveryRequired(context, error, 'startup-recovery')
  }
}

function scanTransactions(layout, options) {
  if (!fs.existsSync(layout.journalRoot)) return []
  const entries = fs.readdirSync(layout.journalRoot, { withFileTypes: true })
  const unexpected = entries.filter((entry) => !entry.isFile() || !entry.name.endsWith('.json'))
  if (unexpected.length > 0) {
    throw new Error(
      `production fresh cache journal root contains unknown entries: ${unexpected.map((entry) => entry.name).join(', ')}`
    )
  }
  return entries
    .map((entry) => path.join(layout.journalRoot, entry.name))
    .sort()
    .map((journalFile) => ({
      layout,
      journalFile,
      journal: readJournal(journalFile, layout),
      now: options.now ?? Date.now,
      crashAt: null,
      onCrashBoundary: null
    }))
}

function validateHoldingInventory(layout, contexts) {
  let metadata
  try {
    metadata = fs.lstatSync(layout.holdingRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`production fresh cache holding root is unsafe: ${layout.holdingRoot}`)
  }
  const journalTransactionIds = new Set(contexts.map((context) => context.journal.transactionId))
  const unknown = fs.readdirSync(layout.holdingRoot, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() || !journalTransactionIds.has(entry.name))
    .map((entry) => entry.name)
  if (unknown.length > 0) {
    throw new Error(
      `production fresh cache holding root contains unknown transaction residue: ${unknown.join(', ')}`
    )
  }
}

export function recoverProductionFreshCacheTransactions(root, options = {}) {
  const layout = transactionLayout(root, options)
  const contexts = scanTransactions(layout, options)
  validateHoldingInventory(layout, contexts)
  for (const context of contexts) recoverJournal(context)
  return contexts.map((context) => ({
    transactionId: context.journal.transactionId,
    candidateIdentityDigest: context.journal.candidateIdentityDigest,
    finalState: context.journal.state
  }))
}

function registeredEntry(layout, transactionId, declaration) {
  const originalPath = path.join(layout.sourceRoot, declaration.relativePath)
  if (!fs.existsSync(originalPath)) return null
  let current = layout.sourceRoot
  for (const segment of declaration.relativePath.split('/')) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) break
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`production fresh cache path contains a symlink: ${current}`)
    }
  }
  const snapshot = snapshotTree(originalPath)
  return {
    logicalCacheId: declaration.logicalCacheId,
    originalPath,
    holdingPath: path.join(layout.holdingRoot, transactionId, declaration.logicalCacheId),
    preDigest: snapshot.digest,
    mode: snapshot.mode,
    owner: snapshot.owner,
    metadataDigest: snapshot.metadataDigest,
    state: 'registered'
  }
}

export function runProductionFreshCacheTransaction(root, {
  runId,
  ownerIdentity,
  removeFreshRoot,
  journalRoot,
  crashAt = null,
  onCrashBoundary = null,
  now = Date.now
} = {}) {
  if (typeof removeFreshRoot !== 'function') {
    throw new Error('production fresh cache transaction requires an explicit Fresh root remover')
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('production fresh cache transaction requires a non-empty run ID')
  }
  if (crashAt !== null && !productionFreshCacheCrashBoundaries.includes(crashAt)) {
    throw new Error(`unknown production fresh cache crash boundary: ${crashAt}`)
  }
  const layout = transactionLayout(root, { journalRoot })
  const normalizedOwner = normalizeOwnerIdentity(ownerIdentity, layout.canonicalRepositoryRoot)
  recoverProductionFreshCacheTransactions(root, { journalRoot, now })
  const transactionId = randomUUID()
  const entries = productionFreshCacheEntries
    .map((declaration) => registeredEntry(layout, transactionId, declaration))
    .filter(Boolean)
  const timestamp = new Date(now()).toISOString()
  const journalFile = path.join(layout.journalRoot, `${transactionId}.json`)
  const context = {
    layout,
    journalFile,
    now,
    crashAt,
    onCrashBoundary,
    journal: sealJournal({
      schema: productionFreshCacheTransactionSchema,
      transactionId,
      runId,
      candidateIdentityDigest: normalizedOwner.candidateIdentityDigest,
      ownerIdentity: normalizedOwner,
      sourceRoot: layout.sourceRoot,
      entries,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: 'prepared',
      actions: [],
      crashInjectionPoint: null,
      finalState: null
    })
  }
  durableWriteJson(journalFile, context.journal)
  invokeCrashBoundary(context, 'after-prepared')
  try {
    updateJournal(context, { state: 'evacuating' }, { type: 'state', state: 'evacuating' })
    durableMkdir(path.join(layout.holdingRoot, transactionId))
    for (let index = 0; index < context.journal.entries.length; index += 1) {
      const entry = context.journal.entries[index]
      if (fs.existsSync(entry.holdingPath)) {
        throw new Error(`holding path already exists for ${entry.logicalCacheId}`)
      }
      verifyEntryAt(entry, entry.originalPath, 'original entry')
      fsyncTree(entry.originalPath)
      durableRename(entry.originalPath, entry.holdingPath)
      verifyEntryAt(entry, entry.holdingPath, 'holding entry')
      const updatedEntries = context.journal.entries.map((candidate, candidateIndex) => (
        candidateIndex === index ? { ...candidate, state: 'evacuated' } : candidate
      ))
      updateJournal(context, { entries: updatedEntries }, {
        type: 'evacuate',
        logicalCacheId: entry.logicalCacheId,
        preDigest: entry.preDigest
      })
      if (index === 0) invokeCrashBoundary(context, 'after-first-entry-evacuated')
    }
    updateJournal(context, { state: 'evacuated' }, { type: 'state', state: 'evacuated' })
    invokeCrashBoundary(context, 'after-all-evacuated')
    for (const entry of context.journal.entries) verifyEntryAt(entry, entry.holdingPath, 'holding entry')
    removeFreshRoot(layout.sourceRoot)
    if (fs.existsSync(layout.sourceRoot)) {
      throw new Error(`Fresh root remover left the source root present: ${layout.sourceRoot}`)
    }
    fsyncDirectory(path.dirname(layout.sourceRoot))
    updateJournal(context, {
      state: 'fresh-root-cleared'
    }, { type: 'state', state: 'fresh-root-cleared' })
    invokeCrashBoundary(context, 'after-fresh-root-cleared')
    restoreEntries(context, 'committed')
  } catch (error) {
    if (error?.code === 'FSUSBLOG_SIMULATED_CRASH') throw error
    if (context.journal.state === 'recovery-required') throw error
    failRecoveryRequired(context, error, 'transaction')
  }
  return {
    transactionId,
    journalFile,
    state: context.journal.state,
    candidateIdentityDigest: context.journal.candidateIdentityDigest,
    preservedRoots: context.journal.entries.map((entry) => {
      const declaration = productionFreshCacheEntries.find(
        (candidate) => candidate.logicalCacheId === entry.logicalCacheId
      )
      return `.tmp/${declaration.relativePath}`
    }),
    receipt: context.journal
  }
}
