#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const toolFile = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(toolFile), '../..')
const defaultPolicy = 'tests/governance/appsettings-authority.json'
const canonicalPrecedence = [
  'src/backend/appsettings.json',
  'src/backend/appsettings.Production.json',
  'environment variables loaded from .env.production / Compose',
  'explicit command-line overrides'
]
const canonicalAuthorities = {
  base: 'src/backend/appsettings.json',
  productionOverlay: 'src/backend/appsettings.Production.json',
  developmentExample: 'src/backend/appsettings.Development.example.json',
  productionEnvironmentExample: 'config/examples/.env.production.example'
}
const canonicalRetiredFiles = [
  'src/backend/appsettings.example.json',
  'src/backend/appsettings.Production.example.json',
  '.env.production-template'
]

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalize(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '')
}

function safeRelative(value) {
  const relative = normalize(text(value))
  return Boolean(relative)
    && relative !== '.'
    && relative !== '..'
    && !relative.startsWith('../')
    && !path.posix.isAbsolute(relative)
}

function uniqueStrings(values, label, errors, { paths = false } = {}) {
  const source = array(values)
  const normalized = source.map((value) => text(value)).filter(Boolean)
  if (normalized.length !== source.length || new Set(normalized).size !== normalized.length) {
    errors.push(`${label} must contain unique non-empty strings`)
  }
  if (paths) {
    for (const value of normalized) {
      if (!safeRelative(value)) errors.push(`${label} contains unsafe repository path: ${value}`)
    }
  }
  return paths ? normalized.map(normalize) : normalized
}

function stripJsonComments(source) {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n') {
        lineComment = false
        output += character
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      output += character
    } else if (character === '/' && next === '/') {
      lineComment = true
      index += 1
    } else if (character === '/' && next === '*') {
      blockComment = true
      index += 1
    } else {
      output += character
    }
  }
  return output
}

export function parseJsonWithComments(source) {
  return JSON.parse(stripJsonComments(source))
}

function readJson(file, label, errors, { comments = false } = {}) {
  try {
    const source = fs.readFileSync(file, 'utf8')
    return comments ? parseJsonWithComments(source) : JSON.parse(source)
  } catch (error) {
    errors.push(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function readText(file, label, errors) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    errors.push(`${label} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function flattenLeaves(value, prefix = '', output = new Map()) {
  if (Array.isArray(value)) {
    output.set(prefix, value)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flattenLeaves(child, prefix ? `${prefix}:${key}` : key, output)
    }
  } else {
    output.set(prefix, value)
  }
  return output
}

function valueAt(document, leafPath) {
  let current = document
  for (const segment of String(leafPath).split(':')) {
    if (!current || typeof current !== 'object' || !(segment in current)) return { exists: false, value: undefined }
    current = current[segment]
  }
  return { exists: true, value: current }
}

export function parseEnvironmentExample(source) {
  const errors = []
  const entries = new Map()
  for (const [lineIndex, rawLine] of String(source).replaceAll('\r\n', '\n').split('\n').entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) {
      errors.push(`production environment example line ${lineIndex + 1} must not use export`)
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) {
      errors.push(`production environment example line ${lineIndex + 1} must be KEY=VALUE`)
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      errors.push(`production environment example line ${lineIndex + 1} has invalid key ${key}`)
      continue
    }
    if (entries.has(key)) errors.push(`production environment example duplicates key ${key}`)
    entries.set(key, value)
  }
  return { entries, errors }
}

export function validateAppsettingsAuthorityPolicy(policy) {
  const errors = []
  if (policy?.schema !== 'fsusblog.appsettings-authority.v1') {
    errors.push('appsettings authority schema must be fsusblog.appsettings-authority.v1')
  }
  if (JSON.stringify(policy?.authorities) !== JSON.stringify(canonicalAuthorities)) {
    errors.push('appsettings authorities must declare the exact base, production overlay, development example, and production environment example')
  }
  if (JSON.stringify(policy?.retiredFiles) !== JSON.stringify(canonicalRetiredFiles)) {
    errors.push('retiredFiles must declare the two ambiguous JSON examples and legacy production env template')
  }
  if (JSON.stringify(policy?.precedence) !== JSON.stringify(canonicalPrecedence)) {
    errors.push('configuration precedence must be base < production overlay < environment/Compose < command-line')
  }
  uniqueStrings(policy?.developmentOverlay?.allowedLeafPaths, 'developmentOverlay.allowedLeafPaths', errors)
  uniqueStrings(policy?.productionOverlay?.allowedTopLevelSections, 'productionOverlay.allowedTopLevelSections', errors)
  uniqueStrings(policy?.productionOverlay?.requiredEmptyLeafPaths, 'productionOverlay.requiredEmptyLeafPaths', errors)
  const requiredKeys = uniqueStrings(policy?.productionEnvironmentExample?.requiredKeys, 'productionEnvironmentExample.requiredKeys', errors)
  const placeholderKeys = uniqueStrings(policy?.productionEnvironmentExample?.placeholderKeys, 'productionEnvironmentExample.placeholderKeys', errors)
  for (const key of placeholderKeys) {
    if (!requiredKeys.includes(key)) errors.push(`placeholder key must also be required: ${key}`)
  }
  uniqueStrings(policy?.canonicalTemplateConsumers, 'canonicalTemplateConsumers', errors, { paths: true })
  return errors
}

export function checkAppsettingsAuthority({ root = defaultRoot, policyFile = defaultPolicy } = {}) {
  const errors = []
  const absoluteRoot = path.resolve(root)
  const absolutePolicy = path.isAbsolute(policyFile) ? policyFile : path.join(absoluteRoot, policyFile)
  const policy = readJson(absolutePolicy, 'appsettings authority policy', errors)
  errors.push(...validateAppsettingsAuthorityPolicy(policy))
  const authorities = object(policy?.authorities)

  for (const retired of array(policy?.retiredFiles).map(normalize)) {
    if (retired && fs.existsSync(path.join(absoluteRoot, retired))) errors.push(`retired configuration authority exists: ${retired}`)
  }
  const backendRoot = path.join(absoluteRoot, 'src/backend')
  if (fs.existsSync(backendRoot)) {
    for (const entry of fs.readdirSync(backendRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^appsettings(?:\.[^.]+)*\.example\.json$/u.test(entry.name)) continue
      const relative = `src/backend/${entry.name}`
      if (relative !== authorities.developmentExample) errors.push(`ambiguous full appsettings example is forbidden: ${relative}`)
    }
  }

  const base = readJson(path.join(absoluteRoot, normalize(authorities.base)), authorities.base || 'base appsettings', errors, { comments: true })
  const development = readJson(
    path.join(absoluteRoot, normalize(authorities.developmentExample)),
    authorities.developmentExample || 'development example overlay',
    errors,
    { comments: true }
  )
  const production = readJson(
    path.join(absoluteRoot, normalize(authorities.productionOverlay)),
    authorities.productionOverlay || 'production overlay',
    errors,
    { comments: true }
  )

  const baseLeaves = flattenLeaves(base)
  const developmentLeaves = flattenLeaves(development)
  const allowedDevelopmentLeaves = new Set(array(policy?.developmentOverlay?.allowedLeafPaths).map(text).filter(Boolean))
  for (const leaf of developmentLeaves.keys()) {
    if (!allowedDevelopmentLeaves.has(leaf)) errors.push(`development example contains an undeclared overlay leaf: ${leaf}`)
    if (baseLeaves.has(leaf) && JSON.stringify(baseLeaves.get(leaf)) === JSON.stringify(developmentLeaves.get(leaf))) {
      errors.push(`development example redundantly copies the base value: ${leaf}`)
    }
  }
  for (const leaf of allowedDevelopmentLeaves) {
    if (!developmentLeaves.has(leaf)) errors.push(`development example is missing declared overlay leaf: ${leaf}`)
  }

  const actualProductionSections = Object.keys(object(production))
  const allowedProductionSections = array(policy?.productionOverlay?.allowedTopLevelSections).map(text).filter(Boolean)
  for (const section of actualProductionSections) {
    if (!allowedProductionSections.includes(section)) errors.push(`production overlay contains an undeclared top-level section: ${section}`)
  }
  for (const section of allowedProductionSections) {
    if (!(section in production)) errors.push(`production overlay is missing declared top-level section: ${section}`)
  }
  for (const leaf of array(policy?.productionOverlay?.requiredEmptyLeafPaths).map(text).filter(Boolean)) {
    const resolved = valueAt(production, leaf)
    if (!resolved.exists || resolved.value !== '') errors.push(`production fail-closed leaf must remain an empty placeholder: ${leaf}`)
  }

  const environmentPath = normalize(authorities.productionEnvironmentExample)
  const environmentSource = readText(path.join(absoluteRoot, environmentPath), environmentPath || 'production environment example', errors)
  const environment = parseEnvironmentExample(environmentSource)
  errors.push(...environment.errors)
  for (const key of array(policy?.productionEnvironmentExample?.requiredKeys).map(text).filter(Boolean)) {
    if (!environment.entries.has(key)) errors.push(`production environment example is missing required key ${key}`)
  }
  for (const key of array(policy?.productionEnvironmentExample?.placeholderKeys).map(text).filter(Boolean)) {
    const value = environment.entries.get(key)
    if (typeof value !== 'string' || !value.includes('CHANGE_ME')) {
      errors.push(`production environment example key must remain a CHANGE_ME placeholder: ${key}`)
    }
  }

  for (const consumer of array(policy?.canonicalTemplateConsumers).map(normalize).filter(Boolean)) {
    const source = readText(path.join(absoluteRoot, consumer), `production template consumer ${consumer}`, errors)
    if (!source.includes('.env.production.example')) errors.push(`production template consumer does not use the canonical example: ${consumer}`)
    if (source.includes('.env.production-template')) errors.push(`production template consumer retains the legacy template name: ${consumer}`)
  }

  return {
    ok: errors.length === 0,
    errors,
    developmentLeafCount: developmentLeaves.size,
    productionSectionCount: actualProductionSections.length,
    productionEnvironmentKeyCount: environment.entries.size,
    templateConsumerCount: array(policy?.canonicalTemplateConsumers).length
  }
}

function parseArgs(args) {
  const options = { root: defaultRoot, policyFile: defaultPolicy }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--root') options.root = args[++index]
    else if (argument.startsWith('--root=')) options.root = argument.slice('--root='.length)
    else if (argument === '--policy') options.policyFile = args[++index]
    else if (argument.startsWith('--policy=')) options.policyFile = argument.slice('--policy='.length)
    else throw new Error(`unknown option ${argument}`)
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile) {
  try {
    const result = checkAppsettingsAuthority(parseArgs(process.argv.slice(2)))
    if (!result.ok) {
      for (const error of result.errors) console.error(`[appsettings-authority] ${error}`)
      process.exit(1)
    }
    console.log(
      `[appsettings-authority] ok development-leaves=${result.developmentLeafCount} `
      + `production-sections=${result.productionSectionCount} env-keys=${result.productionEnvironmentKeyCount} `
      + `consumers=${result.templateConsumerCount}`
    )
  } catch (error) {
    console.error(`[appsettings-authority] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
