#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { isUtf8 } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(scriptPath), '../..')
const defaultManifest = 'config/development/authoritative-development-docs.json'
const expectedSchema = 'fsusblog.authoritative-development-docs.v1'
const expectedPrecedence = [
  'external-contract',
  'language-syntax',
  'fsusblog-csharp-mapping',
  'formatter-linter-default',
  'personal-ide-setting'
]
const expectedStyleOwnerIds = [
  'csharp-dotnet',
  'typescript-javascript-vue',
  'css-web',
  'cpp',
  'cmake',
  'shell',
  'yaml',
  'json',
  'markdown',
  'sql'
]
const expectedClassificationIds = ['generated', 'vendor', 'fixture', 'lock', 'minified']
const expectedExternalExceptionIds = [
  'json-api-field',
  'postgres-column-migration',
  'http-header',
  'redis-key',
  'c-abi-wasm-export',
  'environment-variable',
  'css-selector-custom-property',
  'shell-environment-variable',
  'cmake-built-in',
  'third-party-sdk-callback'
]

const errors = []
let root = defaultRoot
let overlay = null
let trackedCache = null

function fail(message) {
  errors.push(`[authoritative-development-docs] ${message}`)
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!['--root', '--manifest', '--overlay'].includes(argument)) {
      throw new Error(`unknown argument ${argument}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${argument} requires a path`)
    parsed[argument.slice(2)] = value
    index += 1
  }
  return parsed
}

function toPosix(value) {
  return value.replaceAll(path.sep, '/')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isSafeRepoPath(value) {
  if (!isNonEmptyString(value) || path.isAbsolute(value) || value.includes('\\')) return false
  const normalized = path.posix.normalize(value)
  return normalized === value && normalized !== '..' && !normalized.startsWith('../')
}

function overlayPath(relativePath) {
  return overlay ? path.join(overlay, relativePath) : null
}

function rootPath(relativePath) {
  return path.join(root, relativePath)
}

function existingPath(relativePath) {
  const candidate = overlayPath(relativePath)
  if (candidate && fs.existsSync(candidate)) return candidate
  const repositoryCandidate = rootPath(relativePath)
  return fs.existsSync(repositoryCandidate) ? repositoryCandidate : null
}

function readRepoBuffer(relativePath, { required = true } = {}) {
  const file = existingPath(relativePath)
  if (!file) {
    if (required) fail(`missing ${relativePath}`)
    return null
  }
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if (required) fail(`cannot read ${relativePath}: ${error.message}`)
    return null
  }
}

function readRepoText(relativePath, options) {
  const buffer = readRepoBuffer(relativePath, options)
  return buffer ? buffer.toString('utf8') : ''
}

function readJsonFile(file, label) {
  if (!fs.existsSync(file)) {
    fail(`missing ${label}`)
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`invalid JSON ${label}: ${error.message}`)
    return null
  }
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

function walkFiles(directory, base = directory, output = []) {
  if (!fs.existsSync(directory)) return output
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const relative = toPosix(path.relative(base, absolute))
    if (entry.isDirectory()) {
      if (['.git', '.tmp', 'node_modules', 'bin', 'obj', 'dist', 'coverage'].includes(entry.name)) continue
      walkFiles(absolute, base, output)
    } else if (entry.isFile()) {
      output.push(relative)
    }
  }
  return output
}

function trackedFiles() {
  if (trackedCache) return trackedCache
  const files = new Set()
  const result = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'buffer'
  })
  if (result.status === 0) {
    for (const value of result.stdout.toString('utf8').split('\0')) {
      if (value) files.add(toPosix(value))
    }
  } else {
    for (const value of walkFiles(root)) files.add(value)
  }
  if (overlay) {
    for (const value of walkFiles(overlay)) files.add(value)
  }
  trackedCache = [...files].sort()
  return trackedCache
}

function validateAuthorityDocuments(manifest) {
  const authority = manifest.authority
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    fail('manifest is missing authority')
    return
  }
  for (const field of ['codingConventions', 'agentOperations', 'codeowners']) {
    if (!isSafeRepoPath(authority[field])) {
      fail(`authority.${field} must be a repository-relative path`)
    } else if (!existingPath(authority[field])) {
      fail(`authority.${field} does not exist: ${authority[field]}`)
    }
  }
  for (const field of ['authorityDocuments', 'linkDocuments']) {
    if (!Array.isArray(authority[field]) || authority[field].length === 0) {
      fail(`authority.${field} must be a non-empty array`)
      continue
    }
    for (const document of authority[field]) {
      if (!isSafeRepoPath(document)) {
        fail(`authority.${field} contains unsafe path ${String(document)}`)
      } else if (!existingPath(document)) {
        fail(`authority.${field} references missing ${document}`)
      }
    }
  }

  for (const document of Array.isArray(authority.authorityDocuments) ? authority.authorityDocuments : []) {
    const buffer = readRepoBuffer(document)
    if (!buffer) continue
    if (!isUtf8(buffer)) fail(`${document} is not valid UTF-8`)
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      fail(`${document} must not contain a UTF-8 BOM`)
    }
    const text = buffer.toString('utf8')
    if (!text.endsWith('\n')) fail(`${document} is missing final newline`)
    if (/\t/u.test(text)) fail(`${document} contains a Tab character`)
    if (/[ \t]+$/mu.test(text)) fail(`${document} contains trailing whitespace`)
  }
}

function normalizeMarkdownTarget(document, rawTarget) {
  let target = rawTarget.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  target = target.split(/\s+["']/u, 1)[0]
  if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/iu.test(target)) return null
  target = target.split('#', 1)[0].split('?', 1)[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    fail(`${document} has invalid encoded link ${rawTarget}`)
    return null
  }
  const relative = target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(document), target))
  return relative
}

function validateDocumentLinks(manifest) {
  const documents = manifest.authority?.linkDocuments
  if (!Array.isArray(documents)) return
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/gu
  for (const document of documents) {
    const text = readRepoText(document)
    for (const match of text.matchAll(linkPattern)) {
      const target = normalizeMarkdownTarget(document, match[1])
      if (!target) continue
      if (!isSafeRepoPath(target) || !existingPath(target)) {
        fail(`${document} references missing document link ${match[1]}`)
      }
    }
  }
}

function pathClaimBase(claim) {
  let value = claim.trim().replace(/^\//u, '')
  const globIndex = value.search(/[?*[\]{}]/u)
  if (globIndex >= 0) value = value.slice(0, globIndex)
  value = value.replace(/\/+$/u, '')
  if (!value) return null
  if (path.posix.extname(value) && claim.includes('*')) value = path.posix.dirname(value)
  return value.replace(/\/+$/u, '')
}

function validateAgentPathClaims(manifest) {
  const document = manifest.authority?.agentOperations
  if (!isSafeRepoPath(document)) return
  const text = readRepoText(document)
  const rowPattern = /^\|\s*`([^`]+)`\s*\|/gmu
  for (const match of text.matchAll(rowPattern)) {
    const claim = match[1]
    if (!/^(?:src|docs|tools|tests|config|ops|security|artifacts|\.github)\//u.test(claim)) continue
    const base = pathClaimBase(claim)
    if (!base || !existingPath(base)) fail(`${document} declares missing repository path ${claim}`)
  }
}

function validateCodeowners(manifest) {
  const document = manifest.authority?.codeowners
  if (!isSafeRepoPath(document)) return
  const text = readRepoText(document)
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const pattern = trimmed.split(/\s+/u)[0]
    if (pattern === '*' || pattern.startsWith('!')) continue
    const base = pathClaimBase(pattern)
    if (!base || !existingPath(base)) {
      fail(`${document}:${index + 1} declares missing repository path ${pattern}`)
    }
  }
}

function validateSymbols(manifest) {
  if (!Array.isArray(manifest.symbols) || manifest.symbols.length === 0) {
    fail('manifest symbols must be a non-empty array')
    return
  }
  const ids = new Set()
  for (const [index, symbol] of manifest.symbols.entries()) {
    const location = `symbols[${index}]`
    for (const field of ['id', 'source', 'sourceToken', 'documentToken']) {
      if (!isNonEmptyString(symbol?.[field])) fail(`${location} is missing ${field}`)
    }
    if (ids.has(symbol?.id)) fail(`duplicate symbol id ${symbol.id}`)
    ids.add(symbol?.id)
    if (!isSafeRepoPath(symbol?.source) || !existingPath(symbol.source)) {
      fail(`${location} source does not exist: ${String(symbol?.source)}`)
    } else if (!readRepoText(symbol.source).includes(symbol.sourceToken)) {
      fail(`${symbol.source} does not contain source symbol ${symbol.sourceToken}`)
    }
    if (!Array.isArray(symbol?.documents) || symbol.documents.length === 0) {
      fail(`${location} documents must be non-empty`)
      continue
    }
    for (const document of symbol.documents) {
      if (!readRepoText(document).includes(symbol.documentToken)) {
        fail(`${document} does not contain current symbol ${symbol.documentToken}`)
      }
    }
  }
}

function validateRetiredTokens(manifest) {
  if (!Array.isArray(manifest.retiredTokens) || manifest.retiredTokens.length === 0) {
    fail('manifest retiredTokens must be a non-empty array')
    return
  }
  const documents = manifest.authority?.authorityDocuments ?? []
  for (const token of manifest.retiredTokens) {
    if (!isNonEmptyString(token)) {
      fail('retiredTokens contains an empty token')
      continue
    }
    for (const document of documents) {
      if (readRepoText(document).includes(token)) {
        fail(`${document} contains retired token ${token}`)
      }
    }
  }
}

function validateCommands(manifest) {
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    fail('manifest commands must be a non-empty array')
    return
  }
  const ids = new Set()
  for (const [index, command] of manifest.commands.entries()) {
    const location = `commands[${index}]`
    for (const field of ['id', 'kind', 'invocation']) {
      if (!isNonEmptyString(command?.[field])) fail(`${location} is missing ${field}`)
    }
    if (ids.has(command?.id)) fail(`duplicate command id ${command.id}`)
    ids.add(command?.id)
    if (command?.kind === 'node-script' || command?.kind === 'shell-script') {
      if (!isSafeRepoPath(command.path) || !existingPath(command.path)) {
        fail(`${location} references missing command path ${String(command?.path)}`)
      }
    } else if (command?.kind === 'npm-script') {
      if (!isSafeRepoPath(command.package) || !existingPath(command.package)) {
        fail(`${location} references missing package ${String(command?.package)}`)
      } else {
        const packageJson = readJsonFile(existingPath(command.package), command.package)
        if (!isNonEmptyString(packageJson?.scripts?.[command.script])) {
          fail(`${location} references missing npm script ${String(command.script)}`)
        }
      }
    } else if (isNonEmptyString(command?.kind)) {
      fail(`${location} has unsupported kind ${command.kind}`)
    }
    if (!Array.isArray(command?.documents) || command.documents.length === 0) {
      fail(`${location} documents must be non-empty`)
    } else {
      for (const document of command.documents) {
        if (!readRepoText(document).includes(command.invocation)) {
          fail(`${document} does not contain command ${command.invocation}`)
        }
      }
    }
  }
}

function globToRegExp(pattern) {
  let source = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  source = source.replaceAll('**', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '.*')
  return new RegExp(`^${source}$`, 'u')
}

function extensionOf(file) {
  const base = path.posix.basename(file)
  if (base.startsWith('.') && !base.slice(1).includes('.')) return base
  return path.posix.extname(base)
}

function validateStyleOwnership(manifest) {
  if (!sameStringArray(manifest.requiredStyleOwnerIds, expectedStyleOwnerIds)) {
    fail(`requiredStyleOwnerIds must be ${expectedStyleOwnerIds.join(', ')}`)
  }
  if (!Array.isArray(manifest.styleOwners) || manifest.styleOwners.length === 0) {
    fail('manifest styleOwners must be a non-empty array')
    return { ownedFiles: 0, totalFiles: 0 }
  }
  const conventions = readRepoText(manifest.authority?.codingConventions ?? '')
  const ids = new Set()
  const extensionOwners = new Map()
  const specialFileOwners = new Map()
  for (const [index, owner] of manifest.styleOwners.entries()) {
    const location = `styleOwners[${index}]`
    for (const field of ['id', 'owner', 'documentationHeading']) {
      if (!isNonEmptyString(owner?.[field])) fail(`${location} is missing ${field}`)
    }
    if (ids.has(owner?.id)) fail(`duplicate style owner id ${owner.id}`)
    ids.add(owner?.id)
    if (!conventions.includes(owner?.documentationHeading ?? '')) {
      fail(`${manifest.authority?.codingConventions} is missing style heading ${String(owner?.documentationHeading)}`)
    }
    if (!Array.isArray(owner?.extensions) || owner.extensions.length === 0) {
      fail(`${location} extensions must be non-empty`)
    } else {
      for (const extension of owner.extensions) {
        if (!/^\.[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(extension)) {
          fail(`${location} has invalid extension ${String(extension)}`)
        } else if (extensionOwners.has(extension)) {
          fail(`extension ${extension} has multiple style owners`)
        } else {
          extensionOwners.set(extension, owner.id)
        }
      }
    }
    for (const special of Array.isArray(owner?.specialFiles) ? owner.specialFiles : []) {
      if (specialFileOwners.has(special)) fail(`special file ${special} has multiple style owners`)
      specialFileOwners.set(special, owner.id)
    }
  }
  for (const required of expectedStyleOwnerIds) {
    if (!ids.has(required)) fail(`missing required style owner ${required}`)
  }

  if (!sameStringArray(manifest.requiredPathClassificationIds, expectedClassificationIds)) {
    fail(`requiredPathClassificationIds must be ${expectedClassificationIds.join(', ')}`)
  }
  const classificationIds = new Set()
  const classificationPatterns = []
  for (const [index, classification] of (manifest.pathClassifications ?? []).entries()) {
    const location = `pathClassifications[${index}]`
    for (const field of ['id', 'owner', 'reason']) {
      if (!isNonEmptyString(classification?.[field])) fail(`${location} is missing ${field}`)
    }
    if (classificationIds.has(classification?.id)) fail(`duplicate path classification ${classification.id}`)
    classificationIds.add(classification?.id)
    if (!Array.isArray(classification?.patterns) || classification.patterns.length === 0) {
      fail(`${location} patterns must be non-empty`)
      continue
    }
    for (const pattern of classification.patterns) {
      if (!isNonEmptyString(pattern)) {
        fail(`${location} contains an empty pattern`)
        continue
      }
      try {
        classificationPatterns.push({ id: classification.id, pattern: globToRegExp(pattern) })
      } catch (error) {
        fail(`${location} has invalid pattern ${pattern}: ${error.message}`)
      }
    }
  }
  for (const required of expectedClassificationIds) {
    if (!classificationIds.has(required)) fail(`missing required path classification ${required}`)
  }

  const nonSourceExtensions = new Set(manifest.nonSourceExtensions ?? [])
  const nonSourceSpecialFiles = new Set(manifest.nonSourceSpecialFiles ?? [])
  let ownedFiles = 0
  for (const file of trackedFiles()) {
    if (classificationPatterns.some((entry) => entry.pattern.test(file))) continue
    const base = path.posix.basename(file)
    if (specialFileOwners.has(base)) {
      ownedFiles += 1
      continue
    }
    if (nonSourceSpecialFiles.has(base)) continue
    const extension = extensionOf(file)
    if (extensionOwners.has(extension)) {
      ownedFiles += 1
      continue
    }
    if (nonSourceExtensions.has(extension)) continue
    fail(`${file} has no style owner or non-source classification`)
  }
  return { ownedFiles, totalFiles: trackedFiles().length }
}

function validateExternalExceptions(manifest) {
  if (!sameStringArray(manifest.requiredExternalContractExceptionIds, expectedExternalExceptionIds)) {
    fail(`requiredExternalContractExceptionIds must be ${expectedExternalExceptionIds.join(', ')}`)
  }
  const exceptions = Array.isArray(manifest.externalContractExceptions)
    ? manifest.externalContractExceptions
    : []
  const ids = new Set()
  const conventions = readRepoText(manifest.authority?.codingConventions ?? '')
  for (const [index, exception] of exceptions.entries()) {
    const location = `externalContractExceptions[${index}]`
    if (!isNonEmptyString(exception?.id)) fail(`${location} is missing id`)
    if (ids.has(exception?.id)) fail(`duplicate external contract exception ${exception.id}`)
    ids.add(exception?.id)
    if (exception?.adapterRequired !== true) fail(`${location} must require an internal adapter`)
    let externalPattern = null
    let internalPattern = null
    try {
      externalPattern = new RegExp(exception?.externalPattern, 'u')
    } catch (error) {
      fail(`${location} has invalid externalPattern: ${error.message}`)
    }
    try {
      internalPattern = new RegExp(exception?.internalPattern, 'u')
    } catch (error) {
      fail(`${location} has invalid internalPattern: ${error.message}`)
    }
    const positive = exception?.positive
    const negative = exception?.negative
    if (!externalPattern?.test(positive?.external ?? '')) fail(`${location} positive external example is invalid`)
    if (!internalPattern?.test(positive?.internal ?? '')) fail(`${location} positive internal adapter is invalid`)
    if (positive?.external === positive?.internal) fail(`${location} positive example does not adapt the external name`)
    if (!externalPattern?.test(negative?.external ?? '')) fail(`${location} negative external example is invalid`)
    if (internalPattern?.test(negative?.internal ?? '')) fail(`${location} negative internal example unexpectedly satisfies internal naming`)
    if (!conventions.includes(`\`${exception?.id}\``)) {
      fail(`${manifest.authority?.codingConventions} is missing exception ${String(exception?.id)}`)
    }
  }
  for (const required of expectedExternalExceptionIds) {
    if (!ids.has(required)) fail(`missing required external contract exception ${required}`)
  }
}

function parseEditorConfig(text) {
  let section = ''
  const globals = new Map()
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = line.match(/^\[([^\]]+)\]$/u)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    const property = line.match(/^([^=]+?)\s*=\s*(.*?)$/u)
    if (property && (section === '' || section === '*')) {
      globals.set(property[1].trim().toLowerCase(), property[2].trim().toLowerCase())
    }
  }
  return globals
}

function validateFormatterDefaults(manifest) {
  const baseline = manifest.formatterBaseline
  const expected = {
    indentStyle: 'space',
    indentSize: 4,
    endOfLine: 'lf',
    charset: 'utf-8',
    insertFinalNewline: true,
    trimTrailingWhitespace: true
  }
  for (const [key, value] of Object.entries(expected)) {
    if (baseline?.[key] !== value) fail(`formatterBaseline.${key} must be ${String(value)}`)
  }

  const editorKeyMap = {
    indent_style: String(expected.indentStyle),
    indent_size: String(expected.indentSize),
    end_of_line: expected.endOfLine,
    charset: expected.charset,
    insert_final_newline: String(expected.insertFinalNewline),
    trim_trailing_whitespace: String(expected.trimTrailingWhitespace)
  }
  for (const file of trackedFiles().filter((value) => path.posix.basename(value) === '.editorconfig')) {
    const properties = parseEditorConfig(readRepoText(file))
    for (const [key, required] of Object.entries(editorKeyMap)) {
      const actual = properties.get(key)
      if (actual !== undefined && actual !== required) {
        fail(`${file} global ${key}=${actual} conflicts with repository baseline ${required}`)
      }
    }
  }
}

function validateUniqueCodingAuthority(manifest) {
  const expectedDocument = manifest.authority?.codingConventions
  const claimPattern = /(?:唯一(?:的)?(?:跨语言)?编码规范|唯一权威.{0,16}(?:编码|代码风格)|single .{0,24}(?:coding|style) specification)/iu
  const claims = []
  for (const file of trackedFiles().filter((value) => value.endsWith('.md'))) {
    if (claimPattern.test(readRepoText(file, { required: false }))) claims.push(file)
  }
  if (claims.length !== 1 || claims[0] !== expectedDocument) {
    fail(`coding authority claim must exist only in ${expectedDocument}; found ${claims.join(', ') || 'none'}`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  root = path.resolve(args.root ?? defaultRoot)
  overlay = args.overlay ? path.resolve(args.overlay) : null
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`repository root does not exist: ${root}`)
    return null
  }
  if (overlay && (!fs.existsSync(overlay) || !fs.statSync(overlay).isDirectory())) {
    fail(`overlay does not exist: ${overlay}`)
    return null
  }
  const manifestFile = args.manifest
    ? path.resolve(args.manifest)
    : (overlay && fs.existsSync(path.join(overlay, defaultManifest))
        ? path.join(overlay, defaultManifest)
        : path.join(root, defaultManifest))
  const manifest = readJsonFile(manifestFile, args.manifest ?? defaultManifest)
  if (!manifest) return null
  if (manifest.schema !== expectedSchema) {
    fail(`manifest schema must be ${expectedSchema}, got ${String(manifest.schema)}`)
  }
  if (!sameStringArray(manifest.precedence, expectedPrecedence)) {
    fail(`precedence must be ${expectedPrecedence.join(' > ')}`)
  }

  validateAuthorityDocuments(manifest)
  validateDocumentLinks(manifest)
  validateAgentPathClaims(manifest)
  validateCodeowners(manifest)
  validateSymbols(manifest)
  validateRetiredTokens(manifest)
  validateCommands(manifest)
  const styleSummary = validateStyleOwnership(manifest)
  validateExternalExceptions(manifest)
  validateFormatterDefaults(manifest)
  validateUniqueCodingAuthority(manifest)
  return {
    documents: manifest.authority?.authorityDocuments?.length ?? 0,
    styleOwners: manifest.styleOwners?.length ?? 0,
    ...styleSummary
  }
}

let summary = null
try {
  summary = main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log(`[authoritative-development-docs] ok documents=${summary.documents} styleOwners=${summary.styleOwners} tracked=${summary.totalFiles} owned=${summary.ownedFiles}`)
}
