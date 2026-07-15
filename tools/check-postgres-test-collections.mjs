#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendTestRoot = path.join(repoRoot, 'tests/backend')
const manifestPath = path.join(backendTestRoot, 'Fixtures/postgres-test-collections.json')
const collectionDefinitionsPath = path.join(
  backendTestRoot,
  'Fixtures/SchemaMigrationPostgresCollection.cs'
)
const fixtureType = 'PostgresSchemaMigrationFixture'
const collectionPattern = /\[\s*Collection\s*\(\s*nameof\s*\(\s*(SchemaMigrationPostgresCollection[AB])\s*\)\s*\)\s*\]/gu
const legacyCollectionPattern = /\[\s*Collection\s*\(\s*nameof\s*\(\s*SchemaMigrationPostgresCollection\s*\)\s*\)\s*\]/gu
const errors = []

function read(relativeOrAbsolutePath) {
  const absolutePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(repoRoot, relativeOrAbsolutePath)
  if (!existsSync(absolutePath)) {
    errors.push(`missing file: ${path.relative(repoRoot, absolutePath)}`)
    return ''
  }
  return readFileSync(absolutePath, 'utf8')
}

function findCsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory() && ['bin', 'obj'].includes(entry.name)) return []
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) return findCsFiles(target)
      return entry.isFile() && entry.name.endsWith('.cs') ? [target] : []
    })
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' '
  }
}

// Keep source offsets stable while preventing braces and attributes in comments or
// SQL/string fixtures from being mistaken for C# declarations.
function maskCSharpTrivia(source) {
  const characters = [...source]
  let index = 0
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      const stop = end < 0 ? source.length : end
      maskRange(characters, index, stop)
      index = stop
      continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 2
      maskRange(characters, index, stop)
      index = stop
      continue
    }

    const quote = source[index]
    if (quote === '"') {
      let quoteCount = 1
      while (source[index + quoteCount] === '"') quoteCount += 1
      if (quoteCount >= 3) {
        const delimiter = '"'.repeat(quoteCount)
        const end = source.indexOf(delimiter, index + quoteCount)
        const stop = end < 0 ? source.length : end + quoteCount
        maskRange(characters, index, stop)
        index = stop
        continue
      }

      const verbatim = index > 0 && source[index - 1] === '@'
      let cursor = index + 1
      while (cursor < source.length) {
        if (verbatim && source[cursor] === '"' && source[cursor + 1] === '"') {
          cursor += 2
          continue
        }
        if (source[cursor] === '"') {
          cursor += 1
          break
        }
        if (!verbatim && source[cursor] === '\\') cursor += 2
        else cursor += 1
      }
      maskRange(characters, index, cursor)
      index = cursor
      continue
    }

    if (quote === "'") {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === "'") {
          cursor += 1
          break
        }
        if (source[cursor] === '\\') cursor += 2
        else cursor += 1
      }
      maskRange(characters, index, cursor)
      index = cursor
      continue
    }

    index += 1
  }
  return characters.join('')
}

function findMatchingBrace(source, openingBrace) {
  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return source.length
}

function countXunitCases(maskedClassSource) {
  const factPattern = /\[\s*(?:Xunit\.)?Fact(?:Attribute)?\b[^\]]*\]/gu
  const theoryPattern = /\[\s*(?:Xunit\.)?Theory(?:Attribute)?\b[^\]]*\]/gu
  const inlineDataPattern = /\[\s*(?:Xunit\.)?InlineData\b/gu
  const facts = [...maskedClassSource.matchAll(factPattern)]
  const theories = [...maskedClassSource.matchAll(theoryPattern)]
  const testAttributes = [...facts, ...theories].sort((left, right) => left.index - right.index)
  let cases = facts.length

  for (const theory of theories) {
    const nextTest = testAttributes.find((attribute) => attribute.index > theory.index)
    const attributes = maskedClassSource.slice(theory.index, nextTest?.index ?? maskedClassSource.length)
    const inlineDataCount = [...attributes.matchAll(inlineDataPattern)].length
    cases += Math.max(1, inlineDataCount)
  }

  return { facts: facts.length, theories: theories.length, cases }
}

function extractClasses(file, source) {
  const masked = maskCSharpTrivia(source)
  const classes = []
  const classPattern = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/gu

  for (const match of masked.matchAll(classPattern)) {
    const name = match[1]
    const declarationEnd = masked.slice(match.index).search(/[\{;]/u)
    if (declarationEnd < 0) continue
    const delimiterIndex = match.index + declarationEnd
    const bodyEnd = masked[delimiterIndex] === '{'
      ? findMatchingBrace(masked, delimiterIndex)
      : delimiterIndex + 1
    const previousBrace = masked.lastIndexOf('}', match.index)
    const previousSemicolon = masked.lastIndexOf(';', match.index)
    const declarationStart = Math.max(0, previousBrace + 1, previousSemicolon + 1)
    const declarationPrefix = masked.slice(declarationStart, match.index)
    const collectionIds = [...declarationPrefix.matchAll(collectionPattern)].map((entry) => entry[1])
    const classSource = masked.slice(match.index, bodyEnd)
    const counts = countXunitCases(classSource)

    classes.push({
      file,
      name,
      collectionIds,
      usesFixture: new RegExp(`\\b${fixtureType}\\b`, 'u').test(classSource),
      ...counts
    })
  }

  return classes
}

function manifestKey(absolutePath, className) {
  return `${path.normalize(absolutePath)}#${className}`
}

let manifest
try {
  manifest = JSON.parse(read(manifestPath))
} catch (error) {
  errors.push(`invalid manifest JSON: ${error.message}`)
  manifest = { collections: [] }
}

if (manifest.schema !== 'fsusblog.postgres-test-collections.v1') {
  errors.push(`unexpected schema: ${String(manifest.schema)}`)
}

if (!Array.isArray(manifest.collections) || manifest.collections.length !== 2) {
  errors.push('manifest must define exactly two PostgreSQL collections')
}

const definitions = read(collectionDefinitionsPath)
const sourceByFile = new Map()
const classesByFile = new Map()
const discoveredClasses = new Map()

for (const file of findCsFiles(backendTestRoot)) {
  const source = readFileSync(file, 'utf8')
  sourceByFile.set(file, source)
  if (legacyCollectionPattern.test(maskCSharpTrivia(source))) {
    errors.push(`${path.relative(repoRoot, file)} still uses the legacy collection`)
  }
  legacyCollectionPattern.lastIndex = 0

  const classes = extractClasses(file, source)
  classesByFile.set(file, classes)
  for (const currentClass of classes) {
    if (!currentClass.usesFixture && currentClass.collectionIds.length === 0) continue
    if (currentClass.cases === 0) continue
    discoveredClasses.set(manifestKey(file, currentClass.name), currentClass)
  }
}

const manifestEntries = new Map()
const manifestClassNames = new Set()
let manifestCaseCount = 0
const collectionCaseCounts = new Map()

for (const collection of manifest.collections ?? []) {
  const collectionId = String(collection.id ?? '')
  if (!/^SchemaMigrationPostgresCollection[AB]$/u.test(collectionId)) {
    errors.push(`invalid collection id: ${collectionId}`)
  }
  if (!definitions.includes(`[CollectionDefinition(nameof(${collectionId}))]`)) {
    errors.push(`missing collection definition: ${collectionId}`)
  }

  const tests = Array.isArray(collection.tests) ? collection.tests : []
  if (tests.length === 0) errors.push(`collection has no tests: ${collectionId}`)
  let sourceCaseCount = 0

  for (const entry of tests) {
    const relativePath = String(entry.path ?? '').replaceAll('\\', '/')
    const className = String(entry.class ?? '')
    const absolutePath = path.resolve(backendTestRoot, relativePath)
    const relativeToBackend = path.relative(path.resolve(backendTestRoot), absolutePath)
    if (relativeToBackend.startsWith('..') || path.isAbsolute(relativeToBackend)) {
      errors.push(`test path escapes backend test root: ${relativePath}`)
      continue
    }

    const key = manifestKey(absolutePath, className)
    if (manifestEntries.has(key)) errors.push(`duplicate test class entry: ${relativePath}#${className}`)
    if (manifestClassNames.has(className)) errors.push(`duplicate test class: ${className}`)
    manifestEntries.set(key, collectionId)
    manifestClassNames.add(className)

    if (!sourceByFile.has(absolutePath)) {
      read(absolutePath)
      continue
    }
    const currentClass = (classesByFile.get(absolutePath) ?? []).find((candidate) => candidate.name === className)
    if (!currentClass) {
      errors.push(`${relativePath} does not declare class ${className}`)
      continue
    }
    if (!currentClass.usesFixture) {
      errors.push(`${relativePath}#${className} does not reference ${fixtureType}`)
    }
    if (currentClass.collectionIds.length !== 1) {
      errors.push(`${relativePath}#${className} must declare exactly one PostgreSQL collection annotation`)
    } else if (currentClass.collectionIds[0] !== collectionId) {
      errors.push(`${relativePath}#${className} is assigned to ${currentClass.collectionIds[0]}, expected ${collectionId}`)
    }
    sourceCaseCount += currentClass.cases
  }

  const estimatedFacts = Number(collection.estimatedFacts)
  if (!Number.isInteger(estimatedFacts) || estimatedFacts !== sourceCaseCount) {
    errors.push(
      `${collectionId} estimatedFacts mismatch: manifest=${String(collection.estimatedFacts)} source=${sourceCaseCount}`
    )
  }
  collectionCaseCounts.set(collectionId, sourceCaseCount)
  manifestCaseCount += sourceCaseCount
}

for (const [key, currentClass] of discoveredClasses) {
  const relativePath = path.relative(repoRoot, currentClass.file).replaceAll(path.sep, '/')
  if (currentClass.collectionIds.length === 0) {
    errors.push(`${relativePath}#${currentClass.name} has no PostgreSQL collection annotation`)
  } else if (currentClass.collectionIds.length > 1) {
    errors.push(`${relativePath}#${currentClass.name} has multiple PostgreSQL collection annotations`)
  }
  if (!manifestEntries.has(key)) {
    errors.push(`${relativePath}#${currentClass.name} is missing from the PostgreSQL manifest`)
    continue
  }
  const expectedCollection = manifestEntries.get(key)
  if (currentClass.collectionIds.length === 1 && currentClass.collectionIds[0] !== expectedCollection) {
    errors.push(`${relativePath}#${currentClass.name} annotation does not match manifest ${expectedCollection}`)
  }
}

for (const [key, collectionId] of manifestEntries) {
  if (!discoveredClasses.has(key)) {
    errors.push(`manifest entry ${key.split('#').at(-1)} in ${collectionId} is not a fixture-backed test class`)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[postgres-test-collections] ${error}`)
  process.exit(1)
}

console.log(
  `[postgres-test-collections] ok collections=${manifest.collections.length} classes=${manifestEntries.size}`
  + ` estimatedCases=${manifestCaseCount}`
  + ` collectionCases=${[...collectionCaseCounts].map(([id, count]) => `${id}:${count}`).join(',')}`
)
