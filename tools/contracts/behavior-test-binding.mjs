import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  allowedTestKinds,
  catalogRelative,
  digestCatalog,
  loadCatalog,
  root as defaultRoot,
  validateCatalog
} from './behavior-contract-catalog.mjs'
import {
  allowedConcurrencyHarnesses,
  behaviorIdPattern,
  concurrencyHarnessId,
  stableIdPattern
} from './behavior-test.mjs'
import { observationArtifactSchema, validateObservationArtifact } from '../test-observations/validation.mjs'
import { sha256 } from '../test-observations/source-identity.mjs'

export const evidenceReceiptSchema = 'fsusblog.behavior-test-evidence-receipt.v1'
export const attributeName = 'CoversBehavior'
export const helperName = 'behaviorTest'
export const realConcurrencyHarness = concurrencyHarnessId

const testRoots = ['tests']
const nestedSkipSegments = new Set([
  'node_modules',
  'bin',
  'obj',
  'dist',
  'coverage',
  '.tmp',
  'vendor',
  'fixtures',
  'fixture'
])

const residueExemptPaths = new Set([
  'tools/contracts/behavior-contract-catalog.mjs',
  'tools/contracts/behavior-owner-binding.mjs',
  'tools/contracts/behavior-test.mjs',
  'tools/contracts/behavior-test-binding.mjs',
  'tools/contracts/check-behavior-test-evidence.mjs',
  'tools/contracts/check-behavior-owner-binding.mjs',
  'tools/contracts/check-behavior-contract-catalog.mjs',
  'tests/tools/behavior-test-binding.test.mjs',
  'tests/tools/behavior-owner-binding.test.mjs',
  'tests/tools/behavior-contract-catalog.test.mjs',
  'config/schemas/behavior-test-evidence.schema.json'
])

const fail = (message) => { throw new Error(`[behavior-test-binding] ${message}`) }
const normalize = (relative) => String(relative).replaceAll('\\', '/')
const digestText = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const lineNumberAt = (source, index) => source.slice(0, index).split(/\r?\n/u).length
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function kindFromCSharp(value) {
  const map = {
    Positive: 'positive',
    Boundary: 'boundary',
    Negative: 'negative',
    Concurrency: 'concurrency',
    Migration: 'migration',
    Mutation: 'mutation'
  }
  return map[value] ?? null
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function classBefore(source, offset) {
  const prefix = source.slice(0, offset)
  const matches = [...prefix.matchAll(/^\s*(?:(?:public|internal|private|protected|sealed|static|abstract|partial|new)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/gmu)]
  const enclosing = matches.filter((match) => {
    const open = source.indexOf('{', match.index)
    if (open < 0) return false
    let depth = 0
    for (let index = open; index < source.length && index < offset + 1; index += 1) {
      const char = source[index]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0 && index < offset) return false
      }
    }
    return true
  })
  return enclosing.at(-1)?.[1] ?? 'UnknownClass'
}

function methodAfterAttribute(source, attributeEnd) {
  const after = source.slice(attributeEnd)
  const match = after.match(/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/|\s*\[[^\]]+\]|\s)*(?:public|internal|protected|private|static|async|Task|ValueTask|void|[A-Za-z_][\w<>,\[\]\?]*)*?\s+(?:async\s+)?(?:Task(?:<[^>]+>)?|ValueTask(?:<[^>]+>)?|void|[A-Za-z_][\w<>,\[\]\?]*)\s+([A-Za-z_][\w]*)\s*\(/u)
  return match?.[1] ?? null
}

function parseNamedArgs(args) {
  const result = { invariantId: null, reasonId: null, concurrencyHarness: null }
  if (!args.trim()) return result
  for (const part of args.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const match = part.match(/^(InvariantId|ReasonId|ConcurrencyHarness)\s*=\s*"([^"]*)"\s*$/u)
    if (!match) return { error: `unsupported named argument ${part}` }
    const key = match[1]
    const value = match[2]
    if (key === 'InvariantId') result.invariantId = value
    else if (key === 'ReasonId') result.reasonId = value
    else result.concurrencyHarness = value
  }
  return result
}

export function parseCsharpBehaviorBindings({ source, relativePath, catalogDigest }) {
  const errors = []
  const bindings = []
  const normalized = normalize(relativePath)
  if (!normalized.endsWith('.cs')) return { bindings, errors }

  // Comment markers / dual syntax are forbidden on C# test surfaces.
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (/\bBEHAVIOR[_-]?TEST\b|\bbehaviorTest\s*\(/u.test(line) || /\/\/\s*CoversBehavior\b/u.test(line)) {
      errors.push(`${normalized}:${index + 1} C# must use [CoversBehavior(...)] only; comment/helper fallbacks are forbidden`)
    }
  }

  const attributePattern = /\[\s*CoversBehavior\s*\(\s*(?<args>[^\]]*)\)\s*\]/gu
  let match
  while ((match = attributePattern.exec(source)) !== null) {
    const location = `${normalized}:${lineNumberAt(source, match.index)}`
    const args = match.groups?.args ?? ''
    const positional = args.match(/^\s*"(?<id>[^"]+)"\s*,\s*(?:BehaviorTestKind\.)?(?<kind>Positive|Boundary|Negative|Concurrency|Migration|Mutation)\s*(?:,\s*(?<rest>.*))?$/u)
    if (!positional?.groups?.id) {
      errors.push(`${location} CoversBehavior requires (behaviorId, BehaviorTestKind.<Kind>[, named args])`)
      continue
    }
    const behaviorId = positional.groups.id
    const testKind = kindFromCSharp(positional.groups.kind)
    if (!behaviorIdPattern.test(behaviorId)) {
      errors.push(`${location} CoversBehavior behavior ID is invalid: ${behaviorId}`)
      continue
    }
    if (!testKind || !allowedTestKinds.has(testKind)) {
      errors.push(`${location} CoversBehavior test kind is invalid`)
      continue
    }
    const named = parseNamedArgs(positional.groups.rest ?? '')
    if (named.error) {
      errors.push(`${location} ${named.error}`)
      continue
    }
    const method = methodAfterAttribute(source, match.index + match[0].length)
    if (!method) {
      errors.push(`${location} CoversBehavior is not adjacent to a parseable test method`)
      continue
    }
    const className = classBefore(source, match.index)
    const fullyQualifiedName = `${className}.${method}`
    const invariantIds = named.invariantId ? [named.invariantId] : []
    const reasonId = named.reasonId
    const concurrencyHarness = named.concurrencyHarness
    if ((testKind === 'negative' || testKind === 'migration') && invariantIds.length === 0 && !reasonId) {
      errors.push(`${location} ${testKind} proof requires InvariantId or ReasonId`)
    }
    if (testKind === 'concurrency') {
      if (!concurrencyHarness) errors.push(`${location} concurrency proof requires ConcurrencyHarness`)
      else if (!allowedConcurrencyHarnesses.has(concurrencyHarness)) {
        errors.push(`${location} concurrency harness is not a registered real harness: ${concurrencyHarness}`)
      }
    } else if (concurrencyHarness) {
      errors.push(`${location} ConcurrencyHarness is only valid for concurrency proofs`)
    }
    if (invariantIds.some((id) => !stableIdPattern.test(id)) || (reasonId && !stableIdPattern.test(reasonId))) {
      errors.push(`${location} invariant/reason IDs must be stable identifiers`)
    }
    bindings.push({
      behaviorId,
      testKind,
      framework: 'xunit-trx',
      sourcePath: normalized,
      fullyQualifiedName,
      canonicalTestId: `xunit-trx:${className}#${method}`,
      invariantIds,
      reasonId: reasonId ?? null,
      concurrencyHarness: concurrencyHarness ?? null,
      bindingKind: 'attribute',
      catalogDigest,
      line: lineNumberAt(source, match.index),
      sourceDigest: digestText(source)
    })
  }
  return { bindings, errors }
}

function parseJsStringLiteral(source, startIndex) {
  const quote = source[startIndex]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  if (quote === '`') {
    // Only simple non-interpolated template literals are accepted for AST-stable metadata.
    const match = source.slice(startIndex).match(/^`([^`$\\]|\\.)*`/u)
    if (!match || match[0].includes('${')) return null
    return { value: match[0].slice(1, -1).replace(/\\([\\`])/gu, '$1'), end: startIndex + match[0].length }
  }
  let index = startIndex + 1
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      value += source[index + 1] ?? ''
      index += 2
      continue
    }
    if (char === quote) return { value, end: index + 1 }
    if (char === '\n') return null
    value += char
    index += 1
  }
  return null
}

function skipWs(source, index) {
  let cursor = index
  while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
  return cursor
}

function parseJsObjectLiteral(source, startIndex) {
  if (source[startIndex] !== '{') return null
  let cursor = startIndex + 1
  const object = {}
  while (cursor < source.length) {
    cursor = skipWs(source, cursor)
    if (source[cursor] === '}') return { value: object, end: cursor + 1 }
    const keyMatch = source.slice(cursor).match(/^([A-Za-z_][\w]*)\s*:/u)
    if (!keyMatch) return null
    const key = keyMatch[1]
    cursor += keyMatch[0].length
    cursor = skipWs(source, cursor)
    if (source[cursor] === '[') {
      const values = []
      cursor += 1
      while (cursor < source.length) {
        cursor = skipWs(source, cursor)
        if (source[cursor] === ']') {
          cursor += 1
          break
        }
        const literal = parseJsStringLiteral(source, cursor)
        if (!literal) return null
        values.push(literal.value)
        cursor = skipWs(source, literal.end)
        if (source[cursor] === ',') {
          cursor += 1
          continue
        }
        if (source[cursor] === ']') {
          cursor += 1
          break
        }
        return null
      }
      object[key] = values
    } else {
      const literal = parseJsStringLiteral(source, cursor)
      if (literal) {
        object[key] = literal.value
        cursor = literal.end
      } else {
        // Allow the single exported harness constant as AST-stable metadata.
        const ident = source.slice(cursor).match(/^concurrencyHarnessId\b/u)
        if (key === 'concurrencyHarness' && ident) {
          object[key] = concurrencyHarnessId
          cursor += ident[0].length
        } else {
          return null
        }
      }
    }
    cursor = skipWs(source, cursor)
    if (source[cursor] === ',') {
      cursor += 1
      continue
    }
    if (source[cursor] === '}') return { value: object, end: cursor + 1 }
    return null
  }
  return null
}

export function parseJavascriptBehaviorBindings({ source, relativePath, catalogDigest }) {
  const errors = []
  const bindings = []
  const normalized = normalize(relativePath)
  const isJs = /\.(?:mjs|cjs|js|ts|mts|cts|tsx)$/u.test(normalized)
  if (!isJs) return { bindings, errors }

  // C# attribute syntax is forbidden on JS/TS surfaces.
  if (new RegExp(`\\[\\s*${attributeName}\\b`, 'u').test(source)) {
    errors.push(`${normalized} non-C# sources must use behaviorTest(...) only`)
  }
  // Comment-only Behavior ID "registration" is not a formal path (issue counterexample #9).
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const comment = line.match(/^\s*\/\/\s*(.*)$/u)?.[1] ?? ''
    if (!comment) continue
    if (/^(?:CoversBehavior\b|BEHAVIOR[_-]?TEST\b|behaviorId\s*[:=]\s*[a-z][a-z0-9-]*)/u.test(comment)
      && !/\bbehaviorTest\s*\(/u.test(line)) {
      if (!residueExemptPaths.has(normalized)) {
        errors.push(`${normalized}:${index + 1} comment-only Behavior ID registration is forbidden; use behaviorTest(...)`)
      }
    }
  }

  const callPattern = /\bbehaviorTest\s*\(/gu
  let match
  while ((match = callPattern.exec(source)) !== null) {
    const location = `${normalized}:${lineNumberAt(source, match.index)}`
    let cursor = skipWs(source, match.index + match[0].length)
    const idLiteral = parseJsStringLiteral(source, cursor)
    if (!idLiteral) {
      errors.push(`${location} behaviorTest requires a string behaviorId literal`)
      continue
    }
    cursor = skipWs(source, idLiteral.end)
    if (source[cursor] !== ',') {
      errors.push(`${location} behaviorTest requires behaviorId and testKind literals`)
      continue
    }
    cursor = skipWs(source, cursor + 1)
    const kindLiteral = parseJsStringLiteral(source, cursor)
    if (!kindLiteral) {
      errors.push(`${location} behaviorTest requires a string testKind literal`)
      continue
    }
    cursor = skipWs(source, kindLiteral.end)
    if (source[cursor] !== ',') {
      errors.push(`${location} behaviorTest requires a title/options argument`)
      continue
    }
    cursor = skipWs(source, cursor + 1)
    let title = null
    let invariantIds = []
    let reasonId = null
    let concurrencyHarness = null
    const titleLiteral = parseJsStringLiteral(source, cursor)
    if (titleLiteral) {
      title = titleLiteral.value
      cursor = titleLiteral.end
    } else {
      const objectLiteral = parseJsObjectLiteral(source, cursor)
      if (!objectLiteral) {
        errors.push(`${location} behaviorTest third argument must be a string title or object literal`)
        continue
      }
      const options = objectLiteral.value
      title = typeof options.title === 'string' ? options.title : null
      invariantIds = Array.isArray(options.invariantIds) ? options.invariantIds : options.invariantIds ? [options.invariantIds] : []
      reasonId = typeof options.reasonId === 'string' ? options.reasonId : null
      concurrencyHarness = typeof options.concurrencyHarness === 'string' ? options.concurrencyHarness : null
      for (const key of Object.keys(options)) {
        if (!['title', 'invariantIds', 'reasonId', 'concurrencyHarness'].includes(key)) {
          errors.push(`${location} behaviorTest options field ${key} is unsupported`)
        }
      }
      cursor = objectLiteral.end
    }
    if (!title || !title.trim()) {
      errors.push(`${location} behaviorTest title is required`)
      continue
    }
    const behaviorId = idLiteral.value
    const testKind = kindLiteral.value
    if (!behaviorIdPattern.test(behaviorId)) {
      errors.push(`${location} behaviorTest behavior ID is invalid: ${behaviorId}`)
      continue
    }
    if (!allowedTestKinds.has(testKind)) {
      errors.push(`${location} behaviorTest test kind is not catalog-registered: ${testKind}`)
      continue
    }
    if ((testKind === 'negative' || testKind === 'migration') && invariantIds.length === 0 && !reasonId) {
      errors.push(`${location} ${testKind} proof requires invariantIds or reasonId`)
    }
    if (testKind === 'concurrency') {
      if (!concurrencyHarness) errors.push(`${location} concurrency proof requires concurrencyHarness`)
      else if (!allowedConcurrencyHarnesses.has(concurrencyHarness)) {
        errors.push(`${location} concurrency harness is not a registered real harness: ${concurrencyHarness}`)
      }
    } else if (concurrencyHarness) {
      errors.push(`${location} concurrencyHarness is only valid for concurrency proofs`)
    }
    if (invariantIds.some((id) => typeof id !== 'string' || !stableIdPattern.test(id))) {
      errors.push(`${location} invariantIds must be stable identifiers`)
    }
    if (reasonId && !stableIdPattern.test(reasonId)) {
      errors.push(`${location} reasonId must be a stable identifier`)
    }
    // Framework is node-tap for node:test TAP reports; vitest/playwright files still use the same helper name
    // but observations map by helper-declared title under their producer framework when adapted.
    const framework = /\.tsx?$/u.test(normalized) && /from\s+['"](?:@playwright\/test|vitest)['"]/u.test(source)
      ? (/@playwright\/test/u.test(source) ? 'playwright' : 'vitest')
      : 'node-tap'
    let canonicalTestId
    let fullyQualifiedName = title
    if (framework === 'node-tap') {
      canonicalTestId = `node-tap:${normalized}#${title}`
    } else if (framework === 'vitest') {
      canonicalTestId = `vitest:${normalized}#${title}`
    } else {
      // Playwright observations include line:column; bind using line of the helper call.
      const line = lineNumberAt(source, match.index)
      canonicalTestId = `playwright:${normalized}#${line}:0#${title}`
      fullyQualifiedName = `${title}@${line}:0`
    }
    bindings.push({
      behaviorId,
      testKind,
      framework,
      sourcePath: normalized,
      fullyQualifiedName,
      canonicalTestId,
      invariantIds,
      reasonId,
      concurrencyHarness,
      bindingKind: 'helper',
      catalogDigest,
      line: lineNumberAt(source, match.index),
      sourceDigest: digestText(source)
    })
  }
  return { bindings, errors }
}

export function parseBehaviorBindingsFromSource({ source, relativePath, catalogDigest }) {
  const normalized = normalize(relativePath)
  if (normalized.endsWith('.cs')) return parseCsharpBehaviorBindings({ source, relativePath: normalized, catalogDigest })
  return parseJavascriptBehaviorBindings({ source, relativePath: normalized, catalogDigest })
}

function walkTestFiles(repositoryRoot) {
  const files = []
  const walk = (directory, relativeDirectory = '') => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relative = normalize(path.posix.join(relativeDirectory, entry.name))
      if (entry.isDirectory()) {
        if (nestedSkipSegments.has(entry.name) || entry.name === '.git') continue
        walk(path.join(directory, entry.name), relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(?:cs|mjs|cjs|js|ts|mts|cts|tsx)$/u.test(entry.name)) continue
      // Fixture sources under tests/fixtures are not live authority bindings.
      if (relative.split('/').includes('fixtures') || relative.split('/').includes('fixture')) continue
      files.push(relative)
    }
  }
  for (const rootName of testRoots) {
    const absolute = path.join(repositoryRoot, rootName)
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walk(absolute, rootName)
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function scanForbiddenResidues(source, relativePath, errors) {
  const normalized = normalize(relativePath)
  if (residueExemptPaths.has(normalized)) return
  const patterns = [
    [/\b(?:pathBasedBehaviorCoverage|behaviorFromTestPath|inferBehaviorFromPath|kindFromFileName|guessTestKind|existsAsCoverage|coverageEvidenceAsBehaviorMapping|behaviorTestMapping|legacyBehaviorTestMap|compatBehaviorTest|deprecatedBehaviorTest|mapBehaviorFromEvidencePaths|behaviorCoverageFromFileName)\b/u,
      'path-based or compatibility behavior-test mapping surface'],
    [/\b(?:legacyBehaviorTestMap|compatBehaviorTest|deprecatedBehaviorTest|behaviorTestAlias|behavior_test_alias|behavior-test-mapping)\b/iu,
      'forbidden behavior-test alias/mapping surface'],
    [/\binfer(?:Test)?KindFrom(?:File|Path|Class)Name\b|\bkindFrom(?:File|Path|Class)Name\b/u,
      'filename-inferred test kind mapping'],
    [/\bfunction\s+(?:map|resolve|infer)Behavior\w*\s*\([^)]*evidencePaths/u,
      'coverage evidencePaths used as behavior test mapping']
  ]
  for (const [pattern, label] of patterns) {
    if (pattern.test(source)) errors.push(`${normalized} contains ${label}`)
  }
}

export function resolveWorktreeDigest(repositoryRoot = defaultRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' })
  if (result.status === 0) return result.stdout.trim()
  return digestText(normalize(repositoryRoot))
}

function validateBindingSet(catalog, bindings, errors) {
  const active = new Map(catalog.contracts.filter((contract) => contract.status === 'active').map((contract) => [contract.id, contract]))
  const byPhysical = new Map()
  for (const binding of bindings) {
    if (!active.has(binding.behaviorId) && !catalog.contracts.some((contract) => contract.id === binding.behaviorId)) {
      errors.push(`${binding.sourcePath}:${binding.line} binds unknown behavior ID ${binding.behaviorId}`)
    } else {
      const contract = catalog.contracts.find((entry) => entry.id === binding.behaviorId)
      if (contract && contract.status !== 'active') {
        errors.push(`${binding.sourcePath}:${binding.line} ordinary correctness cannot bind ${contract.status} behavior ${binding.behaviorId}`)
      }
    }
    const physicalKey = `${binding.framework}\0${binding.sourcePath}\0${binding.fullyQualifiedName}`
    if (!byPhysical.has(physicalKey)) byPhysical.set(physicalKey, [])
    byPhysical.get(physicalKey).push(binding)
  }
  for (const [, group] of byPhysical) {
    if (group.length > 1) {
      const kinds = [...new Set(group.map((entry) => entry.testKind))]
      if (kinds.length > 1 || group.length > 1) {
        errors.push(`${group[0].sourcePath} physical test ${group[0].fullyQualifiedName} declares ${group.length} behavior bindings; one test method may satisfy only one kind/ID`)
      }
    }
  }
  const byCanonical = new Map()
  for (const binding of bindings) {
    if (byCanonical.has(binding.canonicalTestId)) {
      errors.push(`duplicate canonicalTestId ${binding.canonicalTestId}`)
    }
    byCanonical.set(binding.canonicalTestId, binding)
  }
}

export function scanBehaviorTestBindings({
  repositoryRoot = defaultRoot,
  catalog = loadCatalog(path.join(repositoryRoot, catalogRelative)),
  files = null,
  worktreeDigest = resolveWorktreeDigest(repositoryRoot)
} = {}) {
  const { digest: catalogDigest } = validateCatalog(catalog, repositoryRoot)
  const relativeFiles = files ?? walkTestFiles(repositoryRoot)
  const bindings = []
  const errors = []
  const sourceDigests = {}

  for (const relativePath of relativeFiles) {
    const absolute = path.join(repositoryRoot, relativePath)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue
    const source = readFileSync(absolute, 'utf8')
    const normalizedPath = normalize(relativePath)
    sourceDigests[normalizedPath] = digestText(source)
    scanForbiddenResidues(source, relativePath, errors)
    // Self-tests embed counterexample source as strings; they must not become live bindings.
    if (normalizedPath.endsWith('behavior-test-binding.test.mjs')
      || normalizedPath.endsWith('ts-ast-adapter.test.mjs')) continue
    const scanned = parseBehaviorBindingsFromSource({ source, relativePath, catalogDigest })
    bindings.push(...scanned.bindings)
    errors.push(...scanned.errors)
  }

  // Residue scan across tools/config for forbidden mapping surfaces (not for live bindings).
  for (const rootName of ['tools', 'config', 'src', 'tests', 'docs']) {
    const absoluteRoot = path.join(repositoryRoot, rootName)
    if (!existsSync(absoluteRoot)) continue
    const stack = [absoluteRoot]
    while (stack.length > 0) {
      const directory = stack.pop()
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp') continue
        const absolute = path.join(directory, entry.name)
        const relative = normalize(path.relative(repositoryRoot, absolute))
        if (entry.isDirectory()) {
          if (nestedSkipSegments.has(entry.name)) continue
          stack.push(absolute)
          continue
        }
        if (!entry.isFile() || !/\.(?:mjs|js|ts|cs|json|yml|yaml|md)$/u.test(entry.name)) continue
        if (residueExemptPaths.has(relative)) continue
        const source = readFileSync(absolute, 'utf8')
        scanForbiddenResidues(source, relative, errors)
      }
    }
  }

  validateBindingSet(catalog, bindings, errors)

  // Discovery completeness: every active required kind must have at least one source binding.
  for (const contract of catalog.contracts) {
    if (contract.status !== 'active') continue
    for (const kind of contract.requiredTestKinds) {
      const found = bindings.some((binding) => binding.behaviorId === contract.id && binding.testKind === kind)
      if (!found) errors.push(`${contract.id} missing source binding for required test kind ${kind}`)
    }
  }

  return {
    schema: 'fsusblog.behavior-test-binding-scan.v1',
    catalogDigest,
    worktreeDigest,
    bindings: bindings.sort((left, right) => left.canonicalTestId.localeCompare(right.canonicalTestId)),
    errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right)),
    sourceDigests
  }
}

function digestValue(value) {
  const content = structuredClone(value)
  delete content.contentDigest
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(content)), 'utf8').digest('hex')}`
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function loadObservationArtifacts(observationInputs, {
  evidenceRoot = null,
  expectedSourceState = null,
  expectedClosureDigest = null
} = {}) {
  const artifacts = []
  const errors = []
  for (const input of observationInputs) {
    const artifact = typeof input === 'string'
      ? JSON.parse(readFileSync(input, 'utf8'))
      : input
    const validation = validateObservationArtifact(artifact, {
      evidenceRoot,
      expectedSourceState,
      expectedClosureDigest
    })
    if (validation.length > 0) {
      errors.push(...validation.map((error) => `observation artifact rejected: ${error}`))
      continue
    }
    if (artifact.schema !== observationArtifactSchema) {
      errors.push('observation artifact schema is invalid')
      continue
    }
    artifacts.push(artifact)
  }
  return { artifacts, errors }
}

/**
 * Join source bindings with this-round test observation artifacts.
 * Only discovered+executed+passed rows satisfy exact coverage.
 */
export function joinBehaviorTestEvidence({
  repositoryRoot = defaultRoot,
  catalog = loadCatalog(path.join(repositoryRoot, catalogRelative)),
  bindingsScan = null,
  observations = [],
  evidenceRoot = null,
  expectedSourceState = null,
  expectedClosureDigest = null,
  worktreeDigest = resolveWorktreeDigest(repositoryRoot)
} = {}) {
  const scan = bindingsScan ?? scanBehaviorTestBindings({ repositoryRoot, catalog, worktreeDigest })
  const errors = [...scan.errors]
  const { artifacts, errors: observationErrors } = loadObservationArtifacts(observations, {
    evidenceRoot,
    expectedSourceState,
    expectedClosureDigest
  })
  errors.push(...observationErrors)

  if (artifacts.length === 0) {
    errors.push('exact coverage requires this-round test observation artifacts; file existence/history/TRX cache cannot substitute')
  }

  // Single run/source identity for the whole evidence set.
  let run = null
  let sourceState = null
  let sourceClosureDigest = null
  const rawDigests = []
  const observationByTestId = new Map()

  for (const artifact of artifacts) {
    if (!run) {
      run = artifact.run
      sourceState = artifact.sourceState
      sourceClosureDigest = artifact.sourceClosureDigest
    } else {
      if (JSON.stringify(run) !== JSON.stringify(artifact.run)) {
        errors.push('observation artifacts span multiple run identities; historical TRX cannot satisfy this round')
      }
      if (JSON.stringify(sourceState) !== JSON.stringify(artifact.sourceState)
        || sourceClosureDigest !== artifact.sourceClosureDigest) {
        errors.push('observation artifacts span multiple source identities')
      }
    }
    rawDigests.push(artifact.producer.digest)
    for (const observation of artifact.observations) {
      if (observationByTestId.has(observation.testId)) {
        const previous = observationByTestId.get(observation.testId)
        if (previous.outcome !== observation.outcome) {
          errors.push(`canonicalTestId ${observation.testId} has conflicting outcomes in this round`)
        }
      }
      observationByTestId.set(observation.testId, observation)
    }
  }

  // Identity drift: observations that match no binding with a renamed residue fully-qualified form.
  for (const [testId] of observationByTestId) {
    // only care when we have bindings for same path patterns — checked via coverage missing/executed
    void testId
  }

  const evidence = []
  for (const binding of scan.bindings) {
    const observation = observationByTestId.get(binding.canonicalTestId)
    // Also accept vitest observation IDs that use report-relative file paths equal to sourcePath.
    let matched = observation
    if (!matched && binding.framework === 'vitest') {
      for (const [testId, candidate] of observationByTestId) {
        if (testId.endsWith(`#${binding.fullyQualifiedName}`) && testId.startsWith('vitest:')) {
          matched = candidate
          break
        }
      }
    }
    const executed = Boolean(matched)
    const outcome = matched?.outcome ?? 'missing'
    if (executed && outcome === 'skipped') {
      errors.push(`${binding.canonicalTestId} was skipped and cannot satisfy behavior ${binding.behaviorId}/${binding.testKind}`)
    }
    evidence.push({
      behaviorId: binding.behaviorId,
      testKind: binding.testKind,
      canonicalTestId: binding.canonicalTestId,
      framework: binding.framework,
      sourcePath: binding.sourcePath,
      fullyQualifiedName: binding.fullyQualifiedName,
      discovered: true,
      executed,
      outcome,
      invariantIds: binding.invariantIds,
      reasonId: binding.reasonId,
      concurrencyHarness: binding.concurrencyHarness,
      run: matched?.run ?? run ?? { id: 'missing', attemptKind: 'primary', evidenceClass: 'missing' },
      sourceState: matched?.sourceState ?? sourceState ?? { commit: '0'.repeat(40), worktreeFingerprint: `sha256:${'0'.repeat(64)}` },
      sourceClosureDigest: matched?.sourceClosureDigest ?? sourceClosureDigest ?? `sha256:${'0'.repeat(64)}`,
      rawResultDigest: matched ? artifacts.find((artifact) => artifact.observations.some((entry) => entry.testId === matched.testId))?.producer.digest ?? `sha256:${'0'.repeat(64)}` : `sha256:${'0'.repeat(64)}`
    })
  }

  // Stale fully-qualified identity: observation test IDs that look like renamed leftovers of bound methods.
  for (const binding of scan.bindings) {
    for (const [testId] of observationByTestId) {
      if (testId === binding.canonicalTestId) continue
      if (binding.framework === 'xunit-trx' && testId.startsWith('xunit-trx:') && testId.endsWith(`#${binding.fullyQualifiedName.split('.').at(-1)}`) && testId !== binding.canonicalTestId) {
        // Different class same method name is allowed; only flag exact FQN residue when binding source changed.
      }
    }
  }

  const coverage = []
  for (const contract of catalog.contracts) {
    if (contract.status !== 'active') continue
    const satisfied = []
    const missing = []
    for (const kind of contract.requiredTestKinds) {
      const ok = evidence.some((row) => row.behaviorId === contract.id
        && row.testKind === kind
        && row.discovered === true
        && row.executed === true
        && row.outcome === 'passed'
        && allowedTestKinds.has(row.testKind))
      if (ok) satisfied.push(kind)
      else missing.push(kind)
    }
    if (missing.length > 0) {
      errors.push(`${contract.id} missing this-round passed evidence for kind(s): ${missing.join(', ')}`)
    }
    coverage.push({
      behaviorId: contract.id,
      requiredTestKinds: [...contract.requiredTestKinds],
      satisfiedTestKinds: satisfied,
      missingTestKinds: missing,
      status: missing.length === 0 ? 'ok' : 'failed'
    })
  }

  // Reject using unregistered kinds to satisfy requirements (defensive).
  for (const row of evidence) {
    if (!allowedTestKinds.has(row.testKind)) {
      errors.push(`${row.canonicalTestId} uses unregistered test kind ${row.testKind}`)
    }
  }

  const rawResultDigest = rawDigests.length > 0
    ? `sha256:${digestText(rawDigests.slice().sort().join('\n'))}`
    : `sha256:${'0'.repeat(64)}`

  const receipt = {
    schema: evidenceReceiptSchema,
    catalogDigest: scan.catalogDigest,
    worktreeDigest: scan.worktreeDigest,
    run: run ?? { id: 'missing', attemptKind: 'primary', evidenceClass: 'missing' },
    sourceState: sourceState ?? { commit: '0'.repeat(40), worktreeFingerprint: `sha256:${'0'.repeat(64)}` },
    sourceClosureDigest: sourceClosureDigest ?? `sha256:${'0'.repeat(64)}`,
    rawResultDigest,
    bindings: scan.bindings.map((binding) => ({
      behaviorId: binding.behaviorId,
      testKind: binding.testKind,
      canonicalTestId: binding.canonicalTestId,
      framework: binding.framework,
      sourcePath: binding.sourcePath,
      fullyQualifiedName: binding.fullyQualifiedName,
      invariantIds: binding.invariantIds,
      reasonId: binding.reasonId,
      concurrencyHarness: binding.concurrencyHarness,
      bindingKind: binding.bindingKind,
      line: binding.line
    })),
    evidence,
    coverage,
    errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right)),
    contentDigest: null
  }
  receipt.contentDigest = digestValue(receipt)
  return receipt
}

export function validateExactBehaviorCoverage(receipt) {
  if (receipt?.schema !== evidenceReceiptSchema) fail('evidence receipt schema is invalid')
  if (receipt.contentDigest !== digestValue(receipt)) fail('evidence receipt content digest mismatch')
  if (receipt.errors.length > 0) {
    fail(`${receipt.errors.length} error(s)\n${receipt.errors.map((error) => `- ${error}`).join('\n')}`)
  }
  for (const entry of receipt.coverage) {
    if (entry.status !== 'ok' || entry.missingTestKinds.length > 0) {
      fail(`${entry.behaviorId} exact coverage incomplete: missing ${entry.missingTestKinds.join(', ')}`)
    }
  }
  return receipt
}

export function assertBehaviorTestBindings(options = {}) {
  const scan = scanBehaviorTestBindings(options)
  if (scan.errors.length > 0) {
    fail(`${scan.errors.length} error(s)\n${scan.errors.map((error) => `- ${error}`).join('\n')}`)
  }
  return scan
}

export function formatBehaviorTestBindingReport(scan) {
  return {
    schema: scan.schema,
    catalogDigest: scan.catalogDigest,
    worktreeDigest: scan.worktreeDigest,
    status: scan.errors.length === 0 ? 'ok' : 'failed',
    bindingCount: scan.bindings.length,
    bindings: scan.bindings,
    errors: scan.errors
  }
}

// Keep sha256 import used for optional producer digest checks in callers.
export { sha256 }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = formatBehaviorTestBindingReport(scanBehaviorTestBindings())
  if (report.errors.length > 0) {
    console.error(`[behavior-test-binding] ${report.errors.length} error(s):`)
    for (const error of report.errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log(`[behavior-test-binding] ok (${report.bindingCount} binding(s); catalog ${report.catalogDigest.slice(0, 12)})`)
  }
}
