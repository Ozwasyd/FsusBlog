import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { validateFrontendBuildStageReceiptIdentity } from './frontend-build-ready-marker.mjs'
import {
  atomicJson,
  contentDigest,
  outputTree,
  readJson,
  safeInside,
  safeRelative,
  sha256,
  walkAll
} from './content-addressed-build-cache-contract.mjs'

const lockWaitArray = new Int32Array(new SharedArrayBuffer(4))

function cowUnavailable(error) {
  return new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS']).has(error?.code)
}

function copyTree(sourceRoot, destinationRoot, outputPaths, mode) {
  for (const output of outputPaths) {
    const source = safeInside(sourceRoot, output, 'cache source')
    const destination = safeInside(destinationRoot, output, 'cache destination')
    fs.rmSync(destination, { recursive: true, force: true })
    const visit = (currentSource, currentDestination) => {
      const stat = fs.lstatSync(currentSource)
      if (stat.isSymbolicLink()) throw new Error(`cannot materialize symlink: ${currentSource}`)
      if (stat.isDirectory()) {
        fs.mkdirSync(currentDestination, { recursive: true, mode: stat.mode & 0o777 })
        for (const child of fs.readdirSync(currentSource).sort()) visit(path.join(currentSource, child), path.join(currentDestination, child))
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(currentDestination), { recursive: true })
        const copyMode = mode === 'reflink' ? fs.constants.COPYFILE_FICLONE_FORCE : 0
        fs.copyFileSync(currentSource, currentDestination, copyMode)
        fs.chmodSync(currentDestination, (stat.mode & 0o777) | 0o200)
      } else throw new Error(`unsupported cache entry: ${currentSource}`)
    }
    visit(source, destination)
  }
}

function runPostMaterializationCommand({ root, args, env, label }) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    const diagnostic = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${label} failed status=${result.status ?? '<null>'}${diagnostic ? `: ${diagnostic}` : ''}`)
  }
}

function rewriteFrontendBuildStageReceipt({ runRoot, action, runId, sourceState, receipt }) {
  const relative = safeRelative(action.path, 'frontend build stage receipt')
  const file = safeInside(runRoot, relative, 'frontend build stage receipt')
  const document = readJson(file, 'frontend build stage receipt')
  document.schedulerRunId = runId
  document.sourceState = {
    commit: sourceState.commit,
    worktreeFingerprint: sourceState.worktreeFingerprint
  }
  document.executionMode = 'content-addressed-cache-hit'
  document.grantSource = 'content-addressed-build-cache'
  document.cacheMaterialization = {
    schema: 'fsusblog.frontend-build-stage-cache-materialization.v1',
    producerReceiptContentDigest: receipt.contentDigest,
    producerRunId: receipt.producerRunId,
    consumerRunId: runId
  }
  atomicJson(file, document)
  validateFrontendBuildStageReceiptIdentity(document, { runId, sourceState })
  return [relative]
}

function resealWasmBuildReceipt({ root, runRoot, action, env }) {
  const relative = safeRelative(action.path, 'WASM build receipt')
  const artifactDirRelative = safeRelative(action.artifactDir ?? path.posix.dirname(relative), 'WASM artifact directory')
  const artifactDir = safeInside(runRoot, artifactDirRelative, 'WASM artifact directory')
  const checksumRelative = action.checksumPath ? safeRelative(action.checksumPath, 'WASM checksum path') : null
  const checksumExisted = checksumRelative ? fs.existsSync(safeInside(runRoot, checksumRelative, 'WASM checksum path')) : false
  const script = path.join(root, 'tools/frontend/wasm-build-receipt.mjs')
  const common = [
    script,
    '--root', root,
    '--client-root', path.join(root, 'src/frontend'),
    '--artifact-dir', artifactDir
  ]
  runPostMaterializationCommand({
    root,
    args: [common[0], 'create', ...common.slice(1), '--build-count', '0', '--trust-producer-validation', 'true'],
    env,
    label: 'WASM build receipt reseal'
  })
  const changed = [relative]
  if (checksumExisted) {
    runPostMaterializationCommand({
      root,
      args: [common[0], 'write-checksums', ...common.slice(1)],
      env,
      label: 'WASM build checksum reseal'
    })
    changed.push(checksumRelative)
  }
  runPostMaterializationCommand({
    root,
    args: [common[0], 'verify', ...common.slice(1)],
    env,
    label: 'WASM build receipt verification'
  })
  return changed
}

function applyPostMaterialization({ root, runRoot, domain, receipt, runId, sourceState, env }) {
  const changedPaths = new Set()
  const actions = []
  for (const action of domain.postMaterialization ?? []) {
    let changed
    if (action.kind === 'rewrite-frontend-build-stage-receipt') {
      changed = rewriteFrontendBuildStageReceipt({ runRoot, action, runId, sourceState, receipt })
    } else if (action.kind === 'reseal-wasm-build-receipt') {
      changed = resealWasmBuildReceipt({ root, runRoot, action, env })
    } else {
      throw new Error(`unsupported post-materialization action: ${action.kind}`)
    }
    for (const relative of changed) changedPaths.add(relative)
    actions.push({ kind: action.kind, paths: changed })
  }
  return { changedPaths, actions }
}

export function materializeObject({ root, objectRoot, runRoot, domain, receipt, runId, sourceState, env }) {
  const payloadRoot = path.join(objectRoot, 'payload')
  let mode = 'reflink'
  let fallbackReason = null
  try {
    copyTree(payloadRoot, runRoot, domain.outputPaths, 'reflink')
  } catch (error) {
    for (const output of domain.outputPaths) fs.rmSync(safeInside(runRoot, output, 'cache destination'), { recursive: true, force: true })
    if (!cowUnavailable(error)) throw error
    mode = 'copy-fallback'
    fallbackReason = `${error.code}: ${error.message}`
    copyTree(payloadRoot, runRoot, domain.outputPaths, 'copy')
  }
  const relocation = applyRunRootRelocation(runRoot, receipt)
  const postMaterialization = applyPostMaterialization({ root, runRoot, domain, receipt, runId, sourceState, env })
  const materialized = verifyMaterializedTree(payloadRoot, runRoot, receipt, postMaterialization.changedPaths)
  return {
    mode,
    fallbackReason,
    byteCount: materialized.byteCount,
    ...relocation,
    receiptsResealed: postMaterialization.actions.length,
    postMaterialization: postMaterialization.actions
  }
}

function embeddedReceiptRecords(runRoot, paths) {
  return paths.map(relative => {
    const file = safeInside(runRoot, relative, 'output receipt')
    if (!fs.existsSync(file)) throw new Error(`declared output receipt is missing: ${relative}`)
    const bytes = fs.readFileSync(file)
    const document = JSON.parse(bytes.toString('utf8'))
    return {
      path: safeRelative(relative, 'output receipt'),
      schema: document.schema ?? null,
      contentDigest: document.contentDigest ?? null,
      fileDigest: sha256(bytes)
    }
  })
}

function relocationTokens(runRoot) {
  const native = path.resolve(runRoot)
  const posix = native.replaceAll(path.sep, '/')
  const jsonEscaped = JSON.stringify(native).slice(1, -1)
  return [...new Set([native, posix, jsonEscaped])]
}

function replacementTokens(runRoot) {
  const native = path.resolve(runRoot)
  const posix = native.replaceAll(path.sep, '/')
  const jsonEscaped = JSON.stringify(native).slice(1, -1)
  return [native, posix, jsonEscaped]
}

function transformRelocatableBytes(bytes, sourceTokens, destinationTokens) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('run-root relocation requires UTF-8 text')
  let transformed = text
  for (let index = 0; index < sourceTokens.length; index += 1) {
    transformed = transformed.split(sourceTokens[index]).join(destinationTokens[index])
  }
  return Buffer.from(transformed, 'utf8')
}

function createRelocationRecord(payloadRoot, runRoot, domain, artifactTree) {
  if (domain.relocation?.kind !== 'run-root-text') return null
  const allowed = new Set((domain.relocation.extensions ?? []).map(value => String(value).toLowerCase()))
  const tokens = relocationTokens(runRoot)
  const files = []
  for (const record of artifactTree.files) {
    const file = safeInside(payloadRoot, record.path, 'relocatable artifact')
    const bytes = fs.readFileSync(file)
    const occurrences = tokens.map(token => bytes.toString('utf8').split(token).length - 1)
    if (occurrences.every(count => count === 0)) continue
    if (!allowed.has(path.extname(record.path).toLowerCase())) {
      throw new Error(`run-root path leaked into non-relocatable output: ${record.path}`)
    }
    transformRelocatableBytes(bytes, tokens, replacementTokens(runRoot))
    files.push({ path: record.path, occurrences })
  }
  return {
    kind: 'run-root-text',
    producerRunRoot: path.resolve(runRoot),
    tokens,
    files
  }
}

function applyRunRootRelocation(runRoot, receipt) {
  const relocation = receipt.relocation
  if (!relocation) return { relocatedFiles: 0, replacements: 0 }
  if (relocation.kind !== 'run-root-text' || !Array.isArray(relocation.tokens) || !Array.isArray(relocation.files)) {
    throw new Error('build cache relocation record is invalid')
  }
  const destinationTokens = replacementTokens(runRoot)
  let replacements = 0
  for (const record of relocation.files) {
    const file = safeInside(runRoot, record.path, 'relocated output')
    const bytes = fs.readFileSync(file)
    const transformed = transformRelocatableBytes(bytes, relocation.tokens, destinationTokens)
    fs.writeFileSync(file, transformed)
    replacements += (record.occurrences ?? []).reduce((sum, count) => sum + Number(count || 0), 0)
  }
  return { relocatedFiles: relocation.files.length, replacements }
}

function verifyMaterializedTree(payloadRoot, runRoot, receipt, postMaterializedPaths = new Set()) {
  const actual = outputTree(runRoot, receipt.identity.outputPaths)
  const expectedPaths = receipt.artifactTree.files.map(record => record.path)
  const actualPaths = actual.files.map(record => record.path)
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
      || JSON.stringify(actual.directories) !== JSON.stringify(receipt.artifactTree.directories)) {
    throw new Error('materialized build cache artifact roster mismatch')
  }
  const relocationByPath = new Set((receipt.relocation?.files ?? []).map(record => record.path))
  const actualByPath = new Map(actual.files.map(record => [record.path, record]))
  const expectedFiles = receipt.artifactTree.files.map(record => {
    if (postMaterializedPaths.has(record.path)) return actualByPath.get(record.path)
    if (!relocationByPath.has(record.path)) return record
    const source = fs.readFileSync(safeInside(payloadRoot, record.path, 'relocatable artifact'))
    const transformed = transformRelocatableBytes(source, receipt.relocation.tokens, replacementTokens(runRoot))
    return { path: record.path, size: transformed.byteLength, digest: sha256(transformed) }
  })
  if (JSON.stringify(actual.files) !== JSON.stringify(expectedFiles)) {
    throw new Error('materialized build cache artifact digest mismatch')
  }
  return actual
}

function sealReadOnly(root) {
  const directories = [path.resolve(root)]
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`cannot seal cache symlink: ${absolute}`)
      if (entry.isDirectory()) {
        directories.push(absolute)
        visit(absolute)
      } else if (entry.isFile()) {
        fs.chmodSync(absolute, fs.statSync(absolute).mode & ~0o222)
      } else {
        throw new Error(`cannot seal unsupported cache entry: ${absolute}`)
      }
    }
  }
  visit(path.resolve(root))
  directories.sort((left, right) => right.length - left.length)
  for (const directory of directories) {
    fs.chmodSync(directory, fs.statSync(directory).mode & ~0o222)
  }
}

export function publishObject({ root, runRoot, computed, paths, command, sourceState }) {
  fs.rmSync(paths.stagingRoot, { recursive: true, force: true })
  const payloadRoot = path.join(paths.stagingRoot, 'payload')
  fs.mkdirSync(payloadRoot, { recursive: true, mode: 0o700 })
  let publishMode = 'reflink'
  let publishFallbackReason = null
  try {
    copyTree(runRoot, payloadRoot, computed.domain.outputPaths, 'reflink')
  } catch (error) {
    fs.rmSync(payloadRoot, { recursive: true, force: true })
    fs.mkdirSync(payloadRoot, { recursive: true, mode: 0o700 })
    if (!cowUnavailable(error)) throw error
    publishMode = 'copy-fallback'
    publishFallbackReason = `${error.code}: ${error.message}`
    copyTree(runRoot, payloadRoot, computed.domain.outputPaths, 'copy')
  }
  const artifactTree = outputTree(payloadRoot, computed.domain.outputPaths)
  const receipt = {
    schema: buildCacheReceiptSchema,
    status: 'complete',
    domain: computed.identity.domain,
    phase: computed.identity.phase,
    key: computed.key,
    identityDigest: sha256(JSON.stringify(canonicalize(computed.identity))),
    identity: computed.identity,
    producerSourceState: sourceState,
    command,
    artifactTree,
    relocation: createRelocationRecord(payloadRoot, runRoot, computed.domain, artifactTree),
    embeddedReceipts: embeddedReceiptRecords(payloadRoot, computed.domain.outputReceipts ?? []),
    publication: {
      atomicRename: true,
      mode: publishMode,
      fallbackReason: publishFallbackReason
    },
    contentDigest: null
  }
  receipt.contentDigest = contentDigest(receipt)
  atomicJson(path.join(paths.stagingRoot, 'receipt.json'), receipt)
  sealReadOnly(paths.stagingRoot)
  fs.mkdirSync(path.dirname(paths.objectRoot), { recursive: true })
  if (fs.existsSync(paths.objectRoot)) throw new Error('build cache object appeared during publication')
  fs.renameSync(paths.stagingRoot, paths.objectRoot)
  return receipt
}

export function quarantineObject(paths, reason) {
  if (!fs.existsSync(paths.objectRoot)) return null
  fs.mkdirSync(paths.quarantineRoot, { recursive: true })
  const target = path.join(paths.quarantineRoot, `${path.basename(paths.objectRoot)}-${Date.now()}-${crypto.randomUUID()}`)
  fs.renameSync(paths.objectRoot, target)
  const targetMode = fs.statSync(target).mode & 0o777
  fs.chmodSync(target, targetMode | 0o200)
  atomicJson(path.join(target, 'quarantine.json'), { reason, quarantinedAt: new Date().toISOString() })
  fs.chmodSync(target, targetMode & ~0o222)
  return target
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

export async function acquireLock(paths, config, runId) {
  fs.mkdirSync(path.dirname(paths.lockRoot), { recursive: true })
  try {
    fs.mkdirSync(paths.lockRoot, { mode: 0o700 })
    atomicJson(path.join(paths.lockRoot, 'owner.json'), { pid: process.pid, runId, startedAt: new Date().toISOString() })
    return { owned: true }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const ownerFile = path.join(paths.lockRoot, 'owner.json')
  const owner = fs.existsSync(ownerFile) ? readJson(ownerFile, 'build cache lock owner') : null
  if (!owner || !processAlive(Number(owner.pid))) throw new Error(`stale or ambiguous build cache producer lock: ${paths.lockRoot}`)
  const deadline = Date.now() + Number(config.lockWaitMs ?? 120000)
  while (Date.now() < deadline) {
    if (fs.existsSync(paths.objectRoot)) return { owned: false, waited: true }
    if (!fs.existsSync(paths.lockRoot)) return { owned: false, waited: true }
    Atomics.wait(lockWaitArray, 0, 0, 50)
  }
  throw new Error(`timed out waiting for concurrent build cache producer: ${paths.lockRoot}`)
}

export function releaseLock(paths) {
  fs.rmSync(paths.lockRoot, { recursive: true, force: true })
}
