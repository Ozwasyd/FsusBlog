import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  catalogRelative,
  digestCatalog,
  loadCatalog,
  root as defaultRoot,
  validateCatalog
} from './behavior-contract-catalog.mjs'

export const ownerBindingSchema = 'fsusblog.behavior-owner-binding-receipt.v1'
export const markerToken = 'BEHAVIOR-OWNER:'
export const attributeName = 'BehaviorOwner'
export const supportedLanguages = Object.freeze({
  csharp: { extensions: ['.cs'], bindingKind: 'attribute' },
  javascript: { extensions: ['.js', '.mjs', '.cjs'], bindingKind: 'marker' },
  typescript: { extensions: ['.ts', '.mts', '.cts', '.tsx'], bindingKind: 'marker' },
  vue: { extensions: ['.vue'], bindingKind: 'marker' },
  cpp: { extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'], bindingKind: 'marker' },
  shell: { extensions: ['.sh', '.bash'], bindingKind: 'marker' },
  cmake: { extensions: ['.cmake'], bindingKind: 'marker', specialFiles: ['CMakeLists.txt'] }
})

const productionRoots = ['src', 'tools', 'ops', 'config']
const nonAuthorityRoots = new Set(['tests', 'docs'])
const nestedForbiddenSegments = new Set([
  'fixtures',
  'fixture',
  'generated',
  'node_modules',
  'bin',
  'obj',
  'dist',
  'coverage',
  '.tmp',
  'vendor'
])
const forbiddenFactKeys = new Set([
  'expected',
  'test',
  'testid',
  'test-id',
  'docs',
  'doc',
  'document',
  'path',
  'baseline',
  'coverage',
  'evidence',
  'fact',
  'value'
])
const behaviorIdPattern = /^[a-z][a-z0-9-]*$/u
const roleIdPattern = /^[a-z][a-z0-9-]*$/u
const maxAdjacencyLines = 2

const fail = (message) => { throw new Error(`[behavior-owner-binding] ${message}`) }
const normalize = (relative) => String(relative).replaceAll('\\', '/')
const digestText = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const lineNumberAt = (source, index) => source.slice(0, index).split(/\r?\n/u).length

export function languageForPath(relativePath) {
  const base = path.posix.basename(normalize(relativePath))
  for (const [language, config] of Object.entries(supportedLanguages)) {
    if ((config.specialFiles ?? []).includes(base)) return language
    if (config.extensions.some((extension) => base.endsWith(extension))) return language
  }
  return null
}

export function isForbiddenOwnerPath(relativePath) {
  const normalized = normalize(relativePath)
  const parts = normalized.split('/')
  if (parts.length > 0 && nonAuthorityRoots.has(parts[0])) return true
  if (parts.some((part) => nestedForbiddenSegments.has(part))) return true
  if (parts.some((part) => part.endsWith('.generated.md') || part.endsWith('.g.cs') || part.endsWith('.generated.ts'))) return true
  if (/\.(?:fixture|snap|snapshot)(?:\.|$)/u.test(parts.at(-1) ?? '')) return true
  return false
}

export function isProductionAuthorityPath(relativePath) {
  const normalized = normalize(relativePath)
  if (isForbiddenOwnerPath(normalized)) return false
  return productionRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

function walkAuthorityFiles(repositoryRoot) {
  const files = []
  const walk = (directory, relativeDirectory = '') => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relative = normalize(path.posix.join(relativeDirectory, entry.name))
      if (entry.isDirectory()) {
        // Top-level tests/docs are never authority roots; nested tools/docs and tools/test are valid.
        if (nestedForbiddenSegments.has(entry.name) || entry.name === '.git') continue
        walk(path.join(directory, entry.name), relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!languageForPath(relative)) continue
      files.push(relative)
    }
  }
  for (const rootName of productionRoots) {
    const absolute = path.join(repositoryRoot, rootName)
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walk(absolute, rootName)
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function parseMarkerBody(body, location, errors) {
  const trimmed = body.trim()
  if (!trimmed) {
    errors.push(`${location} BEHAVIOR-OWNER marker is empty`)
    return null
  }
  const tokens = trimmed.split(/\s+/u)
  const behaviorId = tokens[0]
  if (!behaviorIdPattern.test(behaviorId)) {
    errors.push(`${location} BEHAVIOR-OWNER behavior ID is invalid: ${behaviorId}`)
    return null
  }
  let role = null
  for (const token of tokens.slice(1)) {
    const match = token.match(/^([a-z][a-z0-9-]*)=(.+)$/u)
    if (!match) {
      errors.push(`${location} BEHAVIOR-OWNER has unsupported token ${token}`)
      return null
    }
    const [, key, value] = match
    if (forbiddenFactKeys.has(key) || key === 'baseline' || /path|doc|test|fact|expected|coverage/iu.test(key)) {
      errors.push(`${location} BEHAVIOR-OWNER must not declare fact/value field ${key}`)
      return null
    }
    if (key !== 'role') {
      errors.push(`${location} BEHAVIOR-OWNER only allows optional role=<id>; got ${key}`)
      return null
    }
    if (role !== null) {
      errors.push(`${location} BEHAVIOR-OWNER declares role more than once`)
      return null
    }
    if (!roleIdPattern.test(value)) {
      errors.push(`${location} BEHAVIOR-OWNER role is invalid: ${value}`)
      return null
    }
    role = value
  }
  return { behaviorId, role }
}

function stripLineComment(line, language) {
  if (language === 'shell' || language === 'cmake') {
    const match = line.match(/^\s*#\s*(.*)$/u)
    return match ? match[1] : null
  }
  const match = line.match(/^\s*\/\/\s*(.*)$/u)
  return match ? match[1] : null
}

function findAdjacentSymbol(source, markerLineIndex, language) {
  const lines = source.split(/\r?\n/u)
  let index = markerLineIndex + 1
  let inBlockDoc = false
  let nonDocSkips = 0
  while (index < lines.length && nonDocSkips <= maxAdjacencyLines) {
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed) {
      nonDocSkips += 1
      index += 1
      continue
    }
    if (language === 'csharp' && /^\s*\[/u.test(line)) {
      index += 1
      continue
    }
    if (!inBlockDoc && /\/\*\*?/u.test(trimmed) && !trimmed.includes('*/')) {
      inBlockDoc = true
      index += 1
      continue
    }
    if (inBlockDoc) {
      if (trimmed.includes('*/')) inBlockDoc = false
      index += 1
      continue
    }
    if (/^\s*\/\*\*?.*\*\/\s*$/u.test(line)) {
      index += 1
      continue
    }
    if (/^\s*\/\/\//u.test(line)) {
      index += 1
      continue
    }
    const lineComment = stripLineComment(line, language)
    if (lineComment !== null) {
      // Ordinary comments between marker and symbol are not the owned entrypoint.
      return null
    }
    const symbol = matchSymbol(line, language)
    if (symbol) return { symbol, line: index + 1 }
    return null
  }
  return null
}

export function matchSymbol(line, language) {
  if (language === 'csharp') {
    const match = line.match(/^\s*(?:public|internal|protected|private|static|sealed|abstract|partial|unsafe|new|readonly|required|\s)*\s*(?:class|struct|interface|record|enum|void|[A-Za-z_][\w<>,\[\]\?]*)\s+([A-Za-z_][\w]*)/u)
    return match?.[1] ?? null
  }
  if (language === 'javascript' || language === 'typescript') {
    const match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/u)
      || line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u)
      || line.match(/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/u)
      || line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\*?\b|\([^)]*\)\s*=>|async\s*\([^)]*\)\s*=>)/u)
      || line.match(/^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\*?\b|\()/u)
    return match?.[1] ?? null
  }
  if (language === 'vue') {
    const match = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u)
      || line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/u)
      || line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\*?\b|\([^)]*\)\s*=>)/u)
      || line.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/u)
    return match?.[1] ?? null
  }
  if (language === 'cpp') {
    const match = line.match(/^\s*(?:inline\s+|static\s+|constexpr\s+|virtual\s+|explicit\s+)*(?:[\w:<>\*&]+\s+)+([A-Za-z_][\w]*)\s*\(/u)
      || line.match(/^\s*(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_][\w]*)/u)
    return match?.[1] ?? null
  }
  if (language === 'shell') {
    const match = line.match(/^\s*([A-Za-z_][\w]*)\s*\(\s*\)\s*\{?/u)
      || line.match(/^\s*function\s+([A-Za-z_][\w]*)\b/u)
    return match?.[1] ?? null
  }
  if (language === 'cmake') {
    const match = line.match(/^\s*function\s*\(\s*([A-Za-z_][\w]*)/iu)
      || line.match(/^\s*macro\s*\(\s*([A-Za-z_][\w]*)/iu)
    return match?.[1] ?? null
  }
  return null
}

function scanMarkerBindings(source, relativePath, language, catalogDigest, sourceDigest) {
  const errors = []
  const bindings = []
  const lines = source.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const commentBody = stripLineComment(lines[index], language)
    if (commentBody === null) continue
    if (!commentBody.includes(markerToken) && !/\bBEHAVIOR-OWNER\b/u.test(commentBody)) continue
    const location = `${relativePath}:${index + 1}`
    if (language === 'csharp') {
      errors.push(`${location} C# must use [BehaviorOwner("id")] attribute syntax only; comment markers are forbidden`)
      continue
    }
    const markerIndex = commentBody.indexOf(markerToken)
    if (markerIndex < 0) {
      errors.push(`${location} malformed BEHAVIOR-OWNER marker`)
      continue
    }
    if (markerIndex > 0 && commentBody.slice(0, markerIndex).trim().length > 0) {
      errors.push(`${location} BEHAVIOR-OWNER must be the only structured marker on the line`)
      continue
    }
    const parsed = parseMarkerBody(commentBody.slice(markerIndex + markerToken.length), location, errors)
    if (!parsed) continue
    if (!isProductionAuthorityPath(relativePath)) {
      errors.push(`${location} implementation owner must live under production/tool authority paths`)
      continue
    }
    const adjacent = findAdjacentSymbol(source, index, language)
    if (!adjacent) {
      errors.push(`${location} BEHAVIOR-OWNER is not adjacent to a parseable symbol/entrypoint`)
      continue
    }
    bindings.push({
      behaviorId: parsed.behaviorId,
      role: parsed.role,
      language,
      sourcePath: normalize(relativePath),
      symbol: adjacent.symbol,
      bindingKind: 'marker',
      sourceDigest,
      catalogDigest,
      line: index + 1,
      status: 'ok'
    })
  }
  return { bindings, errors }
}

function scanCsharpAttributeBindings(source, relativePath, catalogDigest, sourceDigest) {
  const errors = []
  const bindings = []
  if (isForbiddenOwnerPath(relativePath) || !isProductionAuthorityPath(relativePath)) {
    if (new RegExp(`\\[\\s*${attributeName}\\b`, 'u').test(source)) {
      errors.push(`${relativePath} C# BehaviorOwner attribute is outside production/tool authority`)
    }
    return { bindings, errors }
  }
  const attributePattern = /\[\s*BehaviorOwner\s*\(\s*(?<args>[^\]]*)\)\s*\]/gu
  let match
  while ((match = attributePattern.exec(source)) !== null) {
    const location = `${relativePath}:${lineNumberAt(source, match.index)}`
    const args = match.groups?.args ?? ''
    if (/\bexpected\s*=|\btest(?:Id)?\s*=|\bdocs?\s*=|\bpath\s*=|\bbaseline\s*=/iu.test(args)) {
      errors.push(`${location} BehaviorOwner attribute must not declare fact values`)
      continue
    }
    const idMatch = args.match(/^\s*"(?<id>[^"]+)"\s*(?:,\s*(?<rest>.*))?$/u)
      || args.match(/^\s*BehaviorId\s*=\s*"(?<id>[^"]+)"\s*(?:,\s*(?<rest>.*))?$/u)
    if (!idMatch?.groups?.id) {
      errors.push(`${location} BehaviorOwner attribute requires a string behavior ID`)
      continue
    }
    const behaviorId = idMatch.groups.id
    if (!behaviorIdPattern.test(behaviorId)) {
      errors.push(`${location} BehaviorOwner behavior ID is invalid: ${behaviorId}`)
      continue
    }
    let role = null
    const rest = (idMatch.groups.rest ?? '').trim()
    if (rest) {
      const roleMatch = rest.match(/^Role\s*=\s*"(?<role>[^"]+)"\s*$/u)
      if (!roleMatch?.groups?.role) {
        errors.push(`${location} BehaviorOwner only allows optional Role = "id"`)
        continue
      }
      role = roleMatch.groups.role
      if (!roleIdPattern.test(role)) {
        errors.push(`${location} BehaviorOwner role is invalid: ${role}`)
        continue
      }
    }
    const after = source.slice(match.index + match[0].length)
    const following = after.match(/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/|\s*\[[^\]]+\]|\s)+/u)?.[0] ?? ''
    const declaration = after.slice(following.length)
    const declarationLine = declaration.split(/\r?\n/u)[0] ?? ''
    const symbol = matchSymbol(declarationLine, 'csharp')
    if (!symbol) {
      errors.push(`${location} BehaviorOwner attribute is not adjacent to a parseable type/member symbol`)
      continue
    }
    bindings.push({
      behaviorId,
      role,
      language: 'csharp',
      sourcePath: normalize(relativePath),
      symbol,
      bindingKind: 'attribute',
      sourceDigest,
      catalogDigest,
      line: lineNumberAt(source, match.index),
      status: 'ok'
    })
  }
  if (source.includes(markerToken) || /\bBEHAVIOR-OWNER\b/u.test(source)) {
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      if (line.includes(markerToken) || /\bBEHAVIOR-OWNER\b/u.test(line)) {
        errors.push(`${relativePath}:${index + 1} C# must use [BehaviorOwner("id")] only; comment markers are forbidden`)
      }
    }
  }
  return { bindings, errors }
}

const residueExemptPaths = new Set([
  'tools/contracts/behavior-contract-catalog.mjs',
  'tools/contracts/behavior-owner-binding.mjs',
  'tools/contracts/check-behavior-owner-binding.mjs',
  'tests/tools/behavior-owner-binding.test.mjs',
  'tests/tools/behavior-contract-catalog.test.mjs'
])

function scanForbiddenResidues(source, relativePath, errors) {
  const normalized = normalize(relativePath)
  if (residueExemptPaths.has(normalized)) return
  if (/\bimplementationOwners\b/u.test(source)) {
    errors.push(`${relativePath} still contains path-based implementationOwners residue`)
  }
  if (/\b(?:pathBasedOwner|ownerInference|guessOwnerFromPath|ownerFromCoverage|ownerFromEvidencePaths|compatBehaviorOwner|legacyBehaviorOwner|deprecatedBehaviorOwner)\b/u.test(source)) {
    errors.push(`${relativePath} contains forbidden path-based owner inference surface`)
  }
  if (/\bBEHAVIOR[_-]?OWNER[_-]?(?:ALIAS|COMPAT|LEGACY|DEPRECATED)\b/iu.test(source)) {
    errors.push(`${relativePath} contains forbidden owner marker alias`)
  }
}

export function parseOwnerBindingsFromSource({ source, relativePath, catalogDigest }) {
  const language = languageForPath(relativePath)
  const sourceDigest = digestText(source)
  const errors = []
  if (!language) return { bindings: [], errors, sourceDigest }
  scanForbiddenResidues(source, relativePath, errors)
  if (language === 'csharp') {
    const scanned = scanCsharpAttributeBindings(source, relativePath, catalogDigest, sourceDigest)
    return { bindings: scanned.bindings, errors: [...errors, ...scanned.errors], sourceDigest }
  }
  // Scanner/tooling sources may mention attribute syntax in code and docs without declaring ownership.
  if (!residueExemptPaths.has(normalize(relativePath)) && new RegExp(`\\[\\s*${attributeName}\\b`, 'u').test(source)) {
    errors.push(`${relativePath} non-C# sources must use BEHAVIOR-OWNER markers only`)
  }
  const scanned = scanMarkerBindings(source, relativePath, language, catalogDigest, sourceDigest)
  return { bindings: scanned.bindings, errors: [...errors, ...scanned.errors], sourceDigest }
}

export function resolveWorktreeDigest(repositoryRoot = defaultRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim()
  return digestText(normalize(repositoryRoot))
}

const adapterPathPattern = /(?:^|\/)(?:controllers?|adapters?|dto|dtos)(?:\/|$)/iu

function validateCardinality(catalog, bindings, errors) {
  const extractors = new Map((catalog.extractors ?? []).map((extractor) => [extractor.id, extractor]))
  const byBehavior = new Map()
  for (const binding of bindings) {
    if (!byBehavior.has(binding.behaviorId)) byBehavior.set(binding.behaviorId, [])
    byBehavior.get(binding.behaviorId).push(binding)
  }
  for (const contract of catalog.contracts) {
    if (contract.status !== 'active') {
      const stray = byBehavior.get(contract.id) ?? []
      if (stray.length > 0) {
        errors.push(`${contract.id} is ${contract.status} but still has implementation owner bindings`)
      }
      continue
    }
    const owners = byBehavior.get(contract.id) ?? []
    if (contract.implementationOwnerCardinality === 'one') {
      if (owners.length === 0) errors.push(`${contract.id} active one-owner behavior has no implementation owner`)
      if (owners.length > 1) {
        errors.push(`${contract.id} active one-owner behavior has ${owners.length} owners: ${owners.map((owner) => `${owner.sourcePath}#${owner.symbol}`).join(', ')}`)
      }
      for (const owner of owners) {
        if (owner.role) errors.push(`${contract.id} one-owner binding must not declare role (${owner.sourcePath}#${owner.symbol})`)
        if (adapterPathPattern.test(owner.sourcePath)) {
          errors.push(`${contract.id} implementation owner must not bind controller/adapter/DTO path ${owner.sourcePath}`)
        }
      }
      const extractor = extractors.get(contract.factExtractorId)
      if (owners.length === 1 && extractor?.path && owners[0].sourcePath !== extractor.path) {
        errors.push(`${contract.id} one-owner binding is on ${owners[0].sourcePath}#${owners[0].symbol}, but the real owner/entrypoint must be ${extractor.path} (controller-only or relocated wrapper is not allowed)`)
      }
      continue
    }
    const allowed = new Set(contract.allowedImplementationOwnerRoles)
    if (owners.length !== allowed.size) {
      errors.push(`${contract.id} many-owner behavior requires exactly ${allowed.size} owners (roles ${[...allowed].join(',')}), found ${owners.length}`)
    }
    const seenRoles = new Set()
    for (const owner of owners) {
      if (!owner.role) {
        errors.push(`${contract.id} many-owner binding ${owner.sourcePath}#${owner.symbol} is missing role`)
        continue
      }
      if (!allowed.has(owner.role)) {
        errors.push(`${contract.id} many-owner binding ${owner.sourcePath}#${owner.symbol} uses unknown role ${owner.role}`)
        continue
      }
      if (seenRoles.has(owner.role)) errors.push(`${contract.id} role ${owner.role} is bound more than once`)
      seenRoles.add(owner.role)
    }
    for (const role of allowed) {
      if (!seenRoles.has(role)) errors.push(`${contract.id} missing owner role ${role}`)
    }
  }
  for (const [behaviorId, owners] of byBehavior) {
    if (!catalog.contracts.some((contract) => contract.id === behaviorId)) {
      for (const owner of owners) {
        errors.push(`${owner.sourcePath}:${owner.line} binds unknown behavior ID ${behaviorId}`)
      }
    }
  }
}

export function scanBehaviorOwnerBindings({
  repositoryRoot = defaultRoot,
  catalog = loadCatalog(path.join(repositoryRoot, catalogRelative)),
  files = null,
  worktreeDigest = resolveWorktreeDigest(repositoryRoot)
} = {}) {
  const { digest: catalogDigest } = validateCatalog(catalog, repositoryRoot)
  const relativeFiles = files ?? walkAuthorityFiles(repositoryRoot)
  const bindings = []
  const errors = []
  const sourceDigests = {}

  for (const relativePath of relativeFiles) {
    const absolute = path.join(repositoryRoot, relativePath)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue
    const source = readFileSync(absolute, 'utf8')
    const scanned = parseOwnerBindingsFromSource({ source, relativePath, catalogDigest })
    sourceDigests[normalize(relativePath)] = scanned.sourceDigest
    bindings.push(...scanned.bindings)
    errors.push(...scanned.errors)
  }

  // Fail closed on owner markers under tests/docs/fixtures even though they are not authority scan roots.
  const residualRoots = ['tests', 'docs']
  for (const residualRoot of residualRoots) {
    const absoluteRoot = path.join(repositoryRoot, residualRoot)
    if (!existsSync(absoluteRoot)) continue
    const stack = [absoluteRoot]
    while (stack.length > 0) {
      const directory = stack.pop()
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      }
      catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp') continue
        const absolute = path.join(directory, entry.name)
        const relative = normalize(path.relative(repositoryRoot, absolute))
        if (entry.isDirectory()) {
          stack.push(absolute)
          continue
        }
        if (!entry.isFile() || !languageForPath(relative)) continue
        if (relative.endsWith('behavior-owner-binding.test.mjs') || relative.endsWith('behavior-contract-catalog.test.mjs')) continue
        const source = readFileSync(absolute, 'utf8')
        if (source.includes(markerToken) || new RegExp(`\\[\\s*${attributeName}\\b`, 'u').test(source)) {
          errors.push(`${relative} tests/docs/fixtures/generated cannot declare implementation owners`)
        }
        scanForbiddenResidues(source, relative, errors)
      }
    }
  }

  validateCardinality(catalog, bindings, errors)

  const receipts = bindings
    .map((binding) => ({
      behaviorId: binding.behaviorId,
      language: binding.language,
      sourcePath: binding.sourcePath,
      symbol: binding.symbol,
      bindingKind: binding.bindingKind,
      role: binding.role,
      sourceDigest: binding.sourceDigest,
      catalogDigest,
      worktreeDigest,
      line: binding.line,
      status: errors.some((error) => error.includes(binding.behaviorId) || error.startsWith(`${binding.sourcePath}:`)) ? 'error' : 'ok'
    }))
    .sort((left, right) => `${left.behaviorId}\0${left.sourcePath}\0${left.symbol}`.localeCompare(`${right.behaviorId}\0${right.sourcePath}\0${right.symbol}`))

  return {
    schema: ownerBindingSchema,
    catalogDigest,
    worktreeDigest,
    bindings: receipts,
    errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right)),
    sourceDigests
  }
}

export function assertBehaviorOwnerBindings(options = {}) {
  const report = scanBehaviorOwnerBindings(options)
  if (report.errors.length > 0) {
    const details = report.errors.map((error) => `- ${error}`).join('\n')
    fail(`${report.errors.length} error(s)\n${details}`)
  }
  return report
}

export function formatOwnerBindingReport(report) {
  return {
    schema: report.schema,
    catalogDigest: report.catalogDigest,
    worktreeDigest: report.worktreeDigest,
    status: report.errors.length === 0 ? 'ok' : 'failed',
    bindingCount: report.bindings.length,
    bindings: report.bindings.map((binding) => ({
      behaviorId: binding.behaviorId,
      language: binding.language,
      sourcePath: binding.sourcePath,
      symbol: binding.symbol,
      bindingKind: binding.bindingKind,
      sourceDigest: binding.sourceDigest,
      catalogDigest: binding.catalogDigest,
      worktreeDigest: binding.worktreeDigest,
      status: binding.status,
      ...(binding.role ? { role: binding.role } : {})
    })),
    errors: report.errors
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = formatOwnerBindingReport(scanBehaviorOwnerBindings())
  if (report.errors.length > 0) {
    console.error(`[behavior-owner-binding] ${report.errors.length} error(s):`)
    for (const error of report.errors) console.error(`- ${error}`)
    process.exitCode = 1
  }
  else {
    console.log(`[behavior-owner-binding] ok (${report.bindingCount} binding(s); catalog ${report.catalogDigest.slice(0, 12)}; worktree ${report.worktreeDigest.slice(0, 12)})`)
  }
}
