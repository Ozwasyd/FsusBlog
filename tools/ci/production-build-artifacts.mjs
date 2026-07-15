import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const productionBuildReceiptSchema = 'fsusblog.ci-production-build-receipt.v1'
export const productionBuildVerificationSchema = 'fsusblog.ci-production-build-verification.v1'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
}

function sha256Buffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function contentDigest(value) {
  const { contentDigest: _ignored, ...content } = value
  return sha256Buffer(JSON.stringify(canonicalize(content)))
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function normalizeRelative(value, label) {
  const normalized = String(value ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/')
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} path is unsafe: ${normalized || '<empty>'}`)
  }
  return normalized
}

function assertInside(root, relative, label) {
  const absolute = path.resolve(root, normalizeRelative(relative, label))
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} path escapes its root: ${relative}`)
  }
  return absolute
}

function assertNoSymlink(root, absolute, label) {
  let current = absolute
  while (current !== root) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} contains symlink: ${absolute}`)
    current = path.dirname(current)
  }
}

function walkFiles(root, relativeRoot, label) {
  const start = assertInside(root, relativeRoot, label)
  if (!fs.existsSync(start)) throw new Error(`${label} is missing: ${relativeRoot}`)
  assertNoSymlink(root, start, label)
  const files = []
  const visit = absolute => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(absolute, entry.name)
      const relative = path.relative(root, child).replaceAll(path.sep, '/')
      if (entry.isSymbolicLink()) throw new Error(`${label} contains symlink: ${relative}`)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`${label} contains unsupported entry: ${relative}`)
    }
  }
  const stat = fs.statSync(start)
  if (stat.isFile()) files.push(normalizeRelative(relativeRoot, label))
  else if (stat.isDirectory()) visit(start)
  else throw new Error(`${label} is not a file or directory: ${relativeRoot}`)
  if (files.length === 0) throw new Error(`${label} contains no files: ${relativeRoot}`)
  return files
}

function walkRootFiles(root, label) {
  const files = []
  const visit = absolute => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(absolute, entry.name)
      const relative = path.relative(root, child).replaceAll(path.sep, '/')
      if (entry.isSymbolicLink()) throw new Error(`${label} contains symlink: ${relative}`)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`${label} contains unsupported entry: ${relative}`)
    }
  }
  visit(root)
  return files
}

function fileRecord(root, relative) {
  const absolute = assertInside(root, relative, 'artifact')
  assertNoSymlink(root, absolute, 'artifact')
  const bytes = fs.readFileSync(absolute)
  const stat = fs.statSync(absolute)
  return { path: relative, size: stat.size, sha256: sha256Buffer(bytes) }
}

function digestInput(root, declaration) {
  const relativeRoot = normalizeRelative(declaration, 'input')
  const files = walkFiles(root, relativeRoot, 'input')
  const entries = files.map(relative => fileRecord(root, relative))
  return {
    path: relativeRoot,
    fileCount: entries.length,
    size: entries.reduce((sum, entry) => sum + entry.size, 0),
    sha256: sha256Buffer(JSON.stringify(entries))
  }
}

function validateSourceState(sourceState) {
  const commit = String(sourceState?.commit ?? '').trim()
  const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim()
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('production build receipt requires a full lowercase commit SHA')
  if (!/^sha256:[a-f0-9]{64}$/u.test(worktreeFingerprint) && !/^[a-f0-9]{64}$/u.test(worktreeFingerprint)) {
    throw new Error('production build receipt requires a SHA-256 worktree fingerprint')
  }
  return { commit, worktreeFingerprint }
}

function normalizeProducer(producer = {}) {
  const runId = String(producer.runId ?? '').trim()
  const runAttempt = Number(producer.runAttempt)
  const job = String(producer.job ?? '').trim()
  if (!runId || !Number.isInteger(runAttempt) || runAttempt < 1 || !job) {
    throw new Error('production build receipt requires producer runId, positive runAttempt, and job')
  }
  return {
    workflow: String(producer.workflow ?? '').trim() || null,
    runId,
    runAttempt,
    job
  }
}

function normalizeToolchain(toolchain) {
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) {
    throw new Error('production build receipt requires toolchain versions')
  }
  const normalized = Object.fromEntries(Object.entries(toolchain)
    .map(([key, value]) => [String(key).trim(), String(value ?? '').trim()])
    .filter(([key, value]) => key && value)
    .sort(([left], [right]) => left.localeCompare(right)))
  for (const required of ['node', 'npm', 'dotnet', 'vite', 'vitest', 'playwright', 'emsdk']) {
    if (!normalized[required]) throw new Error(`production build receipt toolchain is missing ${required}`)
  }
  return normalized
}

export function createProductionBuildReceipt({
  root = defaultRoot,
  artifactRoot,
  receiptFile = 'receipt.json',
  sourceState,
  producer,
  toolchain,
  inputPaths = [],
  domains = [],
  build = {},
  now = () => new Date()
}) {
  const repositoryRoot = path.resolve(root)
  const payloadRoot = path.resolve(artifactRoot)
  if (!fs.existsSync(payloadRoot) || !fs.statSync(payloadRoot).isDirectory()) {
    throw new Error(`production artifact root is missing: ${payloadRoot}`)
  }
  const normalizedDomains = domains.map(domain => {
    const name = String(domain?.name ?? '').trim()
    const artifactPath = normalizeRelative(domain?.path, `domain ${name || '<empty>'}`)
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error(`invalid production artifact domain: ${name || '<empty>'}`)
    return {
      name,
      path: artifactPath,
      consumerMode: domain.consumerMode === 'copy-before-write' ? 'copy-before-write' : 'read-only',
      files: walkFiles(payloadRoot, artifactPath, `domain ${name}`)
    }
  })
  if (normalizedDomains.length === 0 || new Set(normalizedDomains.map(domain => domain.name)).size !== normalizedDomains.length) {
    throw new Error('production build receipt requires unique artifact domains')
  }
  const claimedFiles = normalizedDomains.flatMap(domain => domain.files)
  if (new Set(claimedFiles).size !== claimedFiles.length) throw new Error('artifact files cannot be owned by multiple domains')
  const files = [...new Set(claimedFiles)].sort().map(relative => fileRecord(payloadRoot, relative))
  const normalizedReceiptFile = normalizeRelative(receiptFile, 'receipt')
  if (claimedFiles.includes(normalizedReceiptFile)) throw new Error('receipt cannot be part of its artifact payload')
  const createdAt = now().toISOString()
  const receipt = {
    schema: productionBuildReceiptSchema,
    status: 'complete',
    sourceState: validateSourceState(sourceState),
    producer: normalizeProducer(producer),
    toolchain: normalizeToolchain(toolchain),
    inputDigests: [...new Set(inputPaths.map(value => normalizeRelative(value, 'input')))].sort()
      .map(value => digestInput(repositoryRoot, value)),
    build: {
      profile: String(build.profile ?? '').trim() || 'production-release-fresh',
      command: String(build.command ?? '').trim() || null,
      startedAt: build.startedAt ?? null,
      finishedAt: build.finishedAt ?? createdAt,
      durationMs: Number.isFinite(Number(build.durationMs)) ? Number(build.durationMs) : null
    },
    domains: normalizedDomains.map(domain => ({
      name: domain.name,
      path: domain.path,
      consumerMode: domain.consumerMode,
      fileCount: domain.files.length
    })),
    artifacts: files,
    metrics: {
      artifactCount: files.length,
      artifactBytes: files.reduce((sum, file) => sum + file.size, 0)
    },
    createdAt,
    contentDigest: null
  }
  receipt.contentDigest = contentDigest(receipt)
  writeJsonAtomic(path.join(payloadRoot, normalizedReceiptFile), receipt)
  return receipt
}

function readReceipt(artifactRoot, receiptFile) {
  const root = path.resolve(artifactRoot)
  const relative = normalizeRelative(receiptFile, 'receipt')
  const absolute = assertInside(root, relative, 'receipt')
  if (!fs.existsSync(absolute)) throw new Error(`production build receipt is missing: ${relative}`)
  assertNoSymlink(root, absolute, 'receipt')
  return { root, relative, receipt: JSON.parse(fs.readFileSync(absolute, 'utf8')) }
}

export function verifyProductionBuildReceipt({
  artifactRoot,
  receiptFile = 'receipt.json',
  expectedSourceState,
  expectedProducer = {},
  expectedToolchain = null,
  expectedInputRoot = null,
  expectedReceiptDigest = null,
  transferStartedAtMs = null,
  now = () => new Date()
}) {
  const startedAtMs = Date.now()
  const { root, relative, receipt } = readReceipt(artifactRoot, receiptFile)
  const errors = []
  if (receipt.schema !== productionBuildReceiptSchema) errors.push(`receipt schema mismatch: ${receipt.schema}`)
  if (receipt.status !== 'complete') errors.push(`receipt is not complete: ${receipt.status}`)
  if (receipt.contentDigest !== contentDigest(receipt)) errors.push('receipt content digest mismatch')
  if (expectedReceiptDigest && receipt.contentDigest !== expectedReceiptDigest) errors.push('receipt digest does not match producer output')
  try { validateSourceState(receipt.sourceState) } catch (error) { errors.push(error.message) }
  try { normalizeProducer(receipt.producer) } catch (error) { errors.push(error.message) }
  try { normalizeToolchain(receipt.toolchain) } catch (error) { errors.push(error.message) }
  if (expectedSourceState) {
    if (receipt.sourceState?.commit !== expectedSourceState.commit) errors.push('receipt commit SHA mismatch')
    if (receipt.sourceState?.worktreeFingerprint !== expectedSourceState.worktreeFingerprint) errors.push('receipt worktree fingerprint mismatch')
  }
  for (const [key, value] of Object.entries(expectedProducer)) {
    if (value !== undefined && value !== null && String(receipt.producer?.[key]) !== String(value)) {
      errors.push(`receipt producer ${key} mismatch`)
    }
  }
  for (const [key, value] of Object.entries(expectedToolchain ?? {})) {
    if (String(receipt.toolchain?.[key]) !== String(value)) errors.push(`receipt toolchain ${key} mismatch`)
  }
  const inputDigests = Array.isArray(receipt.inputDigests) ? receipt.inputDigests : []
  if (inputDigests.length === 0) errors.push('receipt input digests are missing')
  const inputPaths = new Set()
  for (const record of inputDigests) {
    try {
      const inputPath = normalizeRelative(record?.path, 'input')
      if (inputPaths.has(inputPath)) errors.push(`duplicate input digest path: ${inputPath}`)
      inputPaths.add(inputPath)
      if (!Number.isInteger(Number(record.fileCount)) || Number(record.fileCount) < 1
        || !Number.isInteger(Number(record.size)) || Number(record.size) < 0
        || !/^sha256:[a-f0-9]{64}$/u.test(String(record.sha256 ?? ''))) {
        errors.push(`input digest record is invalid: ${inputPath}`)
        continue
      }
      if (expectedInputRoot) {
        const actual = digestInput(path.resolve(expectedInputRoot), inputPath)
        if (actual.fileCount !== Number(record.fileCount)
          || actual.size !== Number(record.size)
          || actual.sha256 !== record.sha256) {
          errors.push(`receipt input digest mismatch: ${inputPath}`)
        }
      }
    } catch (error) {
      errors.push(error.message)
    }
  }
  const domains = Array.isArray(receipt.domains) ? receipt.domains : []
  const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : []
  const artifactPaths = new Set()
  for (const record of artifacts) {
    let absolute
    try {
      const artifactPath = normalizeRelative(record?.path, 'artifact')
      if (artifactPaths.has(artifactPath)) errors.push(`duplicate artifact path: ${artifactPath}`)
      artifactPaths.add(artifactPath)
      absolute = assertInside(root, artifactPath, 'artifact')
      if (!fs.existsSync(absolute)) {
        errors.push(`artifact is missing: ${artifactPath}`)
        continue
      }
      assertNoSymlink(root, absolute, 'artifact')
      if (!fs.statSync(absolute).isFile()) {
        errors.push(`artifact is not a file: ${artifactPath}`)
        continue
      }
      const bytes = fs.readFileSync(absolute)
      if (bytes.byteLength !== Number(record.size)) errors.push(`artifact size mismatch: ${artifactPath}`)
      if (sha256Buffer(bytes) !== record.sha256) errors.push(`artifact digest mismatch: ${artifactPath}`)
    } catch (error) {
      errors.push(error.message)
    }
  }
  for (const domain of domains) {
    try {
      const domainPath = normalizeRelative(domain?.path, `domain ${domain?.name ?? '<empty>'}`)
      const actualFiles = walkFiles(root, domainPath, `domain ${domain?.name ?? '<empty>'}`)
      const expectedFiles = artifacts.filter(record => record.path === domainPath || record.path.startsWith(`${domainPath}/`)).map(record => record.path).sort()
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) errors.push(`artifact domain contains unreceipted files: ${domain?.name}`)
      if (actualFiles.length !== Number(domain.fileCount)) errors.push(`artifact domain file count mismatch: ${domain?.name}`)
    } catch (error) {
      errors.push(error.message)
    }
  }
  try {
    const actualPayloadFiles = walkRootFiles(root, 'artifact root').filter(value => value !== relative)
    const expectedPayloadFiles = [...artifactPaths].sort()
    if (JSON.stringify(actualPayloadFiles) !== JSON.stringify(expectedPayloadFiles)) {
      errors.push('artifact root contains files not covered by the receipt')
    }
  } catch (error) {
    errors.push(error.message)
  }
  const evidence = {
    schema: productionBuildVerificationSchema,
    status: errors.length === 0 ? 'success' : 'failure',
    receipt: relative,
    receiptContentDigest: receipt.contentDigest ?? null,
    sourceState: receipt.sourceState ?? null,
    producer: receipt.producer ?? null,
    toolchain: receipt.toolchain ?? null,
    expectedToolchain: expectedToolchain ?? null,
    inputCount: inputDigests.length,
    inputsVerifiedAgainstCheckout: Boolean(expectedInputRoot),
    artifactCount: artifacts.length,
    artifactBytes: artifacts.reduce((sum, record) => sum + Number(record.size || 0), 0),
    transferDurationMs: Number.isFinite(Number(transferStartedAtMs)) ? Math.max(0, Date.now() - Number(transferStartedAtMs)) : null,
    verifiedAt: now().toISOString(),
    durationMs: Date.now() - startedAtMs,
    errors
  }
  if (errors.length > 0) {
    const error = new Error(`production build artifact verification failed:\n- ${errors.join('\n- ')}`)
    error.evidence = evidence
    throw error
  }
  return { receipt, evidence }
}

function safeDestination(root, relative) {
  const absolute = assertInside(root, relative, 'materialization destination')
  const parent = path.dirname(absolute)
  fs.mkdirSync(parent, { recursive: true })
  const realParent = fs.realpathSync(parent)
  const allowedRoots = [fs.realpathSync(root)]
  const temporaryRoot = path.join(root, '.tmp')
  if (fs.existsSync(temporaryRoot)) allowedRoots.push(fs.realpathSync(temporaryRoot))
  if (!allowedRoots.some(allowed => realParent === allowed || realParent.startsWith(`${allowed}${path.sep}`))) {
    throw new Error(`materialization destination escapes approved roots: ${relative}`)
  }
  return absolute
}

export function materializeProductionBuildDomains({
  artifactRoot,
  receiptFile = 'receipt.json',
  destinationRoot,
  mappings,
  verification = {}
}) {
  const { receipt, evidence } = verifyProductionBuildReceipt({ artifactRoot, receiptFile, ...verification })
  const sourceRoot = path.resolve(artifactRoot)
  const targetRoot = path.resolve(destinationRoot)
  const byName = new Map(receipt.domains.map(domain => [domain.name, domain]))
  const copied = []
  for (const mapping of mappings) {
    const domain = byName.get(mapping.name)
    if (!domain) throw new Error(`unknown production artifact domain: ${mapping.name}`)
    const destination = normalizeRelative(mapping.destination, `domain ${mapping.name} destination`)
    for (const record of receipt.artifacts.filter(item => item.path === domain.path || item.path.startsWith(`${domain.path}/`))) {
      const suffix = record.path === domain.path ? path.basename(record.path) : record.path.slice(domain.path.length + 1)
      const target = safeDestination(targetRoot, path.posix.join(destination, suffix))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(assertInside(sourceRoot, record.path, 'artifact'), target)
      copied.push(path.relative(targetRoot, target).replaceAll(path.sep, '/'))
    }
  }
  return { receipt, evidence, copied: copied.sort() }
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) return 'unavailable'
  return String(result.stdout || result.stderr).trim().split(/\r?\n/u)[0]
}

export function collectProductionToolchain({ root = defaultRoot, env = process.env } = {}) {
  const packageFile = path.join(root, 'src/frontend/package.json')
  const frontendPackage = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')) : {}
  const versions = { ...frontendPackage.devDependencies, ...frontendPackage.dependencies }
  return {
    node: process.version,
    npm: commandVersion(process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    dotnet: commandVersion('dotnet'),
    vite: String(versions.vite ?? 'unavailable'),
    vitest: String(versions.vitest ?? 'unavailable'),
    playwright: String(versions['@playwright/test'] ?? versions.playwright ?? 'unavailable'),
    emsdk: String(env.EMSDK_VERSION ?? commandVersion('emcc'))
  }
}
