#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const toolFile = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(toolFile), '../..')
const defaultContract = 'config/application/backend-configuration-contract.json'
const canonicalAuthorities = {
  contract: defaultContract,
  generatedReference: 'docs/configuration/backend-configuration-reference.generated.md',
  driftReport: '.tmp/configuration/backend-configuration-drift.json'
}
const releaseIdentityVariables = new Set([
  'FSUSBLOG_COMMIT_SHA',
  'FSUSBLOG_DEPLOYMENT_GENERATION',
  'FSUSBLOG_IMAGE_DIGEST',
  'FSUSBLOG_IMAGE_REF',
  'FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE',
  'FSUSBLOG_RELEASE_ID',
  'FSUSBLOG_RELEASE_MANIFEST',
  'FSUSBLOG_RELEASE_MANIFEST_HOST_PATH',
  'FSUSBLOG_RELEASE_MANIFEST_PATH',
  'FSUSBLOG_RELEASE_SLOT'
])
const secretFileVariables = new Set([
  'FSUSBLOG_ASSET_BROWSER_BINDING_KEY_FILE',
  'FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE',
  'FSUSBLOG_ROLLOUT_ASSET_BROWSER_BINDING_KEY_FILE',
  'FSUSBLOG_ROLLOUT_NOTIFICATION_AUTH_STORAGE_STATE',
  'FSUSBLOG_ROLLOUT_TRAFFIC_BINDING_KEY_FILE',
  'FSUSBLOG_ZK_CONFIG_DIR',
  'FSUSBLOG_ZK_GROTH16_VERIFYING_KEY',
  'FSUSBLOG_ZK_ISSUER_PRIVATE_KEY',
  'FSUSBLOG_ZK_ISSUER_PUBLIC_KEY',
  'FSUSBLOG_ZK_SECRET_DIR',
  'FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST',
  'FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST'
])
const validValueTypes = new Set([
  'boolean',
  'integer',
  'nullable-datetime',
  'nullable-integer',
  'number',
  'object',
  'object-array',
  'path',
  'secret-array',
  'secret-object',
  'secret-string',
  'sha',
  'sha256',
  'string',
  'string-array',
  'uri'
])
const validEnvironmentCategories = new Set([
  'application-configuration',
  'deployment-control',
  'release-identity',
  'secret-file-path',
  'tooling-only'
])
const validValidationKinds = new Set(['consumer', 'external-gate', 'feature-gate', 'startup'])
const validRetiredAliasStatuses = new Set(['removed-application-identity', 'retired'])
const sourceWalkIgnores = new Set(['.git', '.tmp', 'artifacts', 'bin', 'build', 'dist', 'node_modules', 'obj', 'vendor'])

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
  const relative = normalize(value).trim()
  return Boolean(relative)
    && relative !== '.'
    && relative !== '..'
    && !relative.startsWith('../')
    && !path.posix.isAbsolute(relative)
}

function sameStrings(actual, expected) {
  return JSON.stringify(array(actual).slice().sort()) === JSON.stringify(expected.slice().sort())
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

function readJson(file, errors, label, { comments = false } = {}) {
  try {
    const source = fs.readFileSync(file, 'utf8')
    return JSON.parse(comments ? stripJsonComments(source) : source)
  } catch (error) {
    errors.push(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function flattenLeaves(value, prefix = '', output = new Map()) {
  if (Array.isArray(value)) {
    output.set(prefix, value)
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) output.set(prefix, value)
    else {
      for (const [key, child] of entries) {
        flattenLeaves(child, prefix ? `${prefix}:${key}` : key, output)
      }
    }
  } else {
    output.set(prefix, value)
  }
  return output
}

function listDeploymentScripts(absoluteRoot, roots, errors) {
  const files = []
  function visit(relative) {
    if (!safeRelative(relative)) {
      errors.push(`deployment source has unsafe path: ${relative}`)
      return
    }
    const absolute = path.join(absoluteRoot, relative)
    let stat
    try {
      stat = fs.statSync(absolute)
    } catch (error) {
      errors.push(`deployment source is missing: ${relative}`)
      return
    }
    if (stat.isFile()) {
      if (/\.(?:mjs|sh)$/u.test(relative)) files.push(normalize(relative))
      return
    }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = normalize(path.posix.join(relative, entry.name))
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile() && /\.(?:mjs|sh)$/u.test(entry.name)) files.push(child)
    }
  }
  for (const root of roots) visit(normalize(root))
  return files.sort()
}

function walkRepositoryFiles(absoluteRoot, relative = '', output = []) {
  const directory = path.join(absoluteRoot, relative)
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && sourceWalkIgnores.has(entry.name)) continue
    const child = normalize(path.posix.join(relative, entry.name))
    if (entry.isDirectory()) walkRepositoryFiles(absoluteRoot, child, output)
    else if (entry.isFile()) output.push(child)
  }
  return output
}

function discoverSourceInventory(absoluteRoot) {
  const files = walkRepositoryFiles(absoluteRoot).sort()
  const toolsRoot = path.join(absoluteRoot, 'tools')
  const deploymentScriptRoots = fs.readdirSync(toolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^deploy.*\.(?:mjs|sh)$/u.test(entry.name))
    .map((entry) => `tools/${entry.name}`)
  if (fs.existsSync(path.join(toolsRoot, 'deployment'))) deploymentScriptRoots.push('tools/deployment')
  return {
    appsettings: files.filter((file) => /^src\/backend\/(?:.*\/)?appsettings(?:\.[^/]+)?\.json$/u.test(file)),
    environmentExamples: files.filter((file) => /^\.env(?:\.[A-Za-z0-9_-]+)*\.example$/u.test(file)),
    compose: files.filter((file) => /^ops\/.*compose.*\.ya?ml$/iu.test(file)),
    deploymentScriptRoots: deploymentScriptRoots.sort()
  }
}

function addObserved(map, name, file) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return
  if (!map.has(name)) map.set(name, new Set())
  map.get(name).add(normalize(file))
}

function extractEnvironmentInventory(absoluteRoot, contract, errors) {
  const inventory = object(contract.sourceInventory)
  const environmentExamples = array(inventory.environmentExamples).map(normalize)
  const compose = array(inventory.compose).map(normalize)
  const deployment = listDeploymentScripts(
    absoluteRoot,
    array(inventory.deploymentScriptRoots).map(normalize),
    errors)
  const observed = new Map()
  for (const relative of [...environmentExamples, ...compose, ...deployment]) {
    let source
    try {
      source = fs.readFileSync(path.join(absoluteRoot, relative), 'utf8')
    } catch (error) {
      errors.push(`environment source is missing or unreadable: ${relative}`)
      continue
    }
    if (relative.endsWith('.mjs')) {
      for (const match of source.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/gu)) {
        addObserved(observed, match[1] ?? match[2], relative)
      }
    } else if (relative.endsWith('.sh')) {
      for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)) {
        addObserved(observed, match[1], relative)
      }
    } else if (environmentExamples.includes(relative)) {
      for (const line of source.split(/\r?\n/u)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line)
        if (match) addObserved(observed, match[1], relative)
      }
    } else {
      for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/gu)) {
        addObserved(observed, match[1], relative)
      }
      for (const line of source.split(/\r?\n/u)) {
        const match = /^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line)
        if (match) addObserved(observed, match[1], relative)
      }
    }
  }
  return observed
}

function parseEnvironmentExample(source, relative, errors) {
  const values = new Map()
  for (const [index, rawLine] of String(source).split(/\r?\n/u).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) {
      errors.push(`${relative}:${index + 1} must be KEY=VALUE`)
      continue
    }
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      errors.push(`${relative}:${index + 1} has invalid environment variable ${name}`)
      continue
    }
    if (values.has(name)) errors.push(`${relative} duplicates environment variable ${name}`)
    values.set(name, value)
  }
  return values
}

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function typeMatches(type, value) {
  if (value === null && ['nullable-datetime', 'nullable-integer'].includes(type)) return true
  if (['path', 'secret-string', 'sha', 'sha256', 'string', 'uri', 'nullable-datetime'].includes(type)) {
    return typeof value === 'string'
  }
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'nullable-integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string-array') return Array.isArray(value) && value.every(item => typeof item === 'string')
  if (type === 'object-array' || type === 'secret-array') return Array.isArray(value)
  if (type === 'object' || type === 'secret-object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  return false
}

function secretLikeKey(key) {
  return /(?:SecretKey|SigningKey|Pepper|NoiseKey|TicketSigningKey|:CurrentKey$|:PreviousKey$|:Password$|BearerToken$|TamperEvidenceKey$|:Keys:(?:dev|k1)$|:PreviousKeys$|AttestationKey$)/u.test(key)
    || key === 'ConnectionStrings:DefaultConnection'
    || key === 'ConnectionStrings:Redis'
}

function environmentSecretLike(name) {
  return /(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|SIGNING_KEY|PEPPER|AUTH_STORAGE_STATE|ADMIN_HEADER|BINDING_KEY)/iu.test(name)
}

function normalizeComposeApplicationKey(variable, settingKeys, frameworkEnvironment) {
  if (frameworkEnvironment.has(variable)) return null
  let key = variable.includes('__') ? variable.replaceAll('__', ':') : variable
  key = key.replace(/:\d+$/u, '')
  return settingKeys.has(key) ? key : variable.includes('__') || settingKeys.has(variable) ? key : null
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function exampleFormat(entry) {
  if (entry.secret) return '<external secret; never a usable tracked value>'
  if (entry.valueType === 'path') return '/mounted/operator/path'
  if (entry.valueType === 'uri') return 'https://example.invalid'
  if (entry.valueType === 'boolean') return 'true or false'
  if (entry.valueType === 'integer') return '<integer>'
  if (entry.valueType === 'number') return '<number>'
  if (entry.valueType.endsWith('-array')) return '[...]'
  if (entry.valueType === 'sha256') return '<64 lowercase hex characters>'
  if (entry.valueType === 'sha') return '<commit or artifact digest>'
  return '<value matching the declared type>'
}

export function renderBackendConfigurationReference(contract) {
  const settings = array(contract.applicationSettings).slice().sort((a, b) => a.key.localeCompare(b.key))
  const variables = array(contract.environmentVariables).slice().sort((a, b) => a.name.localeCompare(b.name))
  const lines = [
    '# Backend configuration reference (generated)',
    '',
    '> Generated from `config/application/backend-configuration-contract.json`.',
    '> This file documents inputs; it is not an input template and must never be copied as runtime configuration.',
    '',
    'ASP.NET Core precedence remains: base appsettings < Production overlay < environment/Compose < explicit command line.',
    '',
    `- Application settings: ${settings.length}`,
    `- Tracked environment variables: ${variables.length}`,
    `- Mounted file classes: ${array(contract.mountedFiles).length}`,
    '',
    '## Application settings',
    '',
    '| Key | Environment variable form | Purpose | Type | Scope | Required | Secret | Default/source policy | Validation | Example format |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const entry of settings) {
    lines.push(`| \`${escapeCell(entry.key)}\` | ${array(entry.environmentVariables).map(value => `\`${escapeCell(value)}\``).join(', ') || 'None'} | ${escapeCell(entry.purpose)} | \`${escapeCell(entry.valueType)}\` | ${array(entry.environments).join(', ')} | ${escapeCell(entry.requiredStatus)}: ${escapeCell(entry.requiredWhen)} | ${entry.secret ? 'yes' : 'no'} | ${array(entry.allowedSources).join(', ')}; ${escapeCell(entry.repositoryValuePolicy)} | ${escapeCell(entry.validation?.kind)}: ${escapeCell(entry.validation?.owner)} | \`${escapeCell(exampleFormat(entry))}\` |`)
  }
  lines.push(
    '',
    '## Tracked environment variables',
    '',
    '| Variable | Class | Owner | Projects to | Secret | Tracked sources |',
    '| --- | --- | --- | --- | --- | --- |')
  for (const entry of variables) {
    lines.push(`| \`${escapeCell(entry.name)}\` | ${escapeCell(entry.category)} | ${escapeCell(entry.owner)} | ${array(entry.mapsTo).map(value => `\`${escapeCell(value)}\``).join(', ') || 'None'} | ${entry.secret ? 'yes' : 'no'} | ${array(entry.sources).map(value => `\`${escapeCell(value)}\``).join(', ')} |`)
  }
  lines.push(
    '',
    '## Mounted files',
    '',
    '| Path setting | File class | Required when | Permissions | Identity validation | Location |',
    '| --- | --- | --- | --- | --- | --- |')
  for (const entry of array(contract.mountedFiles)) {
    lines.push(`| \`${escapeCell(entry.pathSettingKey)}\` | ${escapeCell(entry.expectedFileClass)} | ${escapeCell(entry.requiredWhen)} | ${escapeCell(entry.permissions)} | ${escapeCell(entry.identityValidation)} | ${escapeCell(entry.locationScope)} |`)
  }
  lines.push(
    '',
    '## Retired aliases',
    '',
    '| Retired name | Replacement | Status |',
    '| --- | --- | --- |')
  for (const entry of array(contract.retiredAliases).slice().sort((a, b) => a.key.localeCompare(b.key))) {
    lines.push(`| \`${escapeCell(entry.key)}\` | \`${escapeCell(entry.replacement)}\` | ${escapeCell(entry.status)} |`)
  }
  lines.push('', 'Regenerate this reference with the contract checker; do not edit it by hand.', '')
  return lines.join('\n')
}

export function checkBackendConfigurationContract({ root = defaultRoot, contractPath = defaultContract, checkGeneratedReference = true } = {}) {
  const absoluteRoot = path.resolve(root)
  const errors = []
  const normalizedContractPath = normalize(contractPath)
  if (normalizedContractPath !== defaultContract) errors.push(`contract authority must remain ${defaultContract}`)
  const contract = readJson(path.join(absoluteRoot, normalizedContractPath), errors, 'backend configuration contract')
  if (contract.schema !== 'fsusblog.backend-configuration-contract.v1' || contract.schemaVersion !== 1) {
    errors.push('backend configuration contract schema must remain v1')
  }
  if (JSON.stringify(object(contract.authorities)) !== JSON.stringify(canonicalAuthorities)) {
    errors.push('backend configuration authorities must remain canonical')
  }
  const sourceInventory = object(contract.sourceInventory)
  const discoveredSources = discoverSourceInventory(absoluteRoot)
  for (const [key, expected] of Object.entries(discoveredSources)) {
    if (!sameStrings(contract.sourceInventory?.[key], expected)) {
      errors.push(`sourceInventory.${key} must exactly match discovered tracked sources`)
    }
  }

  const owners = object(contract.owners)
  for (const [ownerName, owner] of Object.entries(owners)) {
    if (!ownerName || !owner?.displayName || !safeRelative(owner?.documentation) || !safeRelative(owner?.consumer)) {
      errors.push(`owner ${ownerName || '<empty>'} must declare displayName, documentation and consumer`)
      continue
    }
    for (const relative of [owner.documentation, owner.consumer]) {
      if (!fs.existsSync(path.join(absoluteRoot, relative))) errors.push(`owner ${ownerName} references missing path ${relative}`)
    }
  }

  const settings = array(contract.applicationSettings)
  const settingByKey = new Map()
  for (const entry of settings) {
    const key = typeof entry?.key === 'string' ? entry.key.trim() : ''
    if (!key || key.includes('__')) {
      errors.push(`application setting has invalid canonical key ${key || '<empty>'}`)
      continue
    }
    if (settingByKey.has(key)) errors.push(`duplicate configuration authority for ${key}`)
    settingByKey.set(key, entry)
    if (!owners[entry.owner]) errors.push(`application setting ${key} has unknown owner ${entry.owner}`)
    if (!validValueTypes.has(entry.valueType)) errors.push(`application setting ${key} has invalid valueType ${entry.valueType}`)
    if (!sameStrings(entry.environments, array(entry.environments).filter(value => ['Development', 'Production'].includes(value)))) {
      errors.push(`application setting ${key} has invalid environment scope`)
    }
    if (!['required', 'conditional', 'optional'].includes(entry.requiredStatus)) {
      errors.push(`application setting ${key} has invalid requiredStatus ${entry.requiredStatus}`)
    }
    if (!entry.requiredWhen || !validValidationKinds.has(entry.validation?.kind) || !entry.validation?.owner) {
      errors.push(`application setting ${key} must declare requiredness and validation ownership`)
    }
    if (['required', 'conditional'].includes(entry.requiredStatus) && entry.validation?.kind === 'consumer') {
      errors.push(`application setting ${key} has contradictory requiredness without a startup or feature gate`)
    }
    if (!safeRelative(entry.documentation) || !fs.existsSync(path.join(absoluteRoot, entry.documentation))) {
      errors.push(`application setting ${key} has missing documentation owner ${entry.documentation}`)
    }
    if (!safeRelative(entry.consumer) || !fs.existsSync(path.join(absoluteRoot, entry.consumer))) {
      errors.push(`application setting ${key} has missing runtime consumer ${entry.consumer}`)
    }
    if (secretLikeKey(key) && entry.secret !== true) errors.push(`secret-classified setting ${key} must remain secret`)
    if (entry.secret && !String(entry.valueType).startsWith('secret-') && key !== 'ConnectionStrings:DefaultConnection' && key !== 'ConnectionStrings:Redis') {
      errors.push(`secret-classified setting ${key} must use a secret value type`)
    }
    for (const variable of array(entry.environmentVariables)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) errors.push(`application setting ${key} has invalid environment alias ${variable}`)
    }
  }
  const retired = new Map()
  for (const entry of array(contract.retiredAliases)) {
    if (!entry?.key || !entry?.replacement || retired.has(entry.key)) {
      errors.push('retiredAliases must contain unique key/replacement pairs')
      continue
    }
    if (settingByKey.has(entry.key)) errors.push(`retired alias ${entry.key} is still a canonical application setting`)
    if (!settingByKey.has(entry.replacement)) errors.push(`retired alias ${entry.key} has unknown replacement ${entry.replacement}`)
    if (!validRetiredAliasStatuses.has(entry.status)) errors.push(`retired alias ${entry.key} has invalid status ${entry.status}`)
    retired.set(entry.key, entry.replacement)
  }

  const seenSettings = new Set()
  const appsettingsEnvironment = new Map([
    ['src/backend/appsettings.json', ['Development', 'Production']],
    ['src/backend/appsettings.Production.json', ['Production']],
    ['src/backend/appsettings.Development.example.json', ['Development']]
  ])
  for (const relative of array(sourceInventory.appsettings)) {
    const document = readJson(path.join(absoluteRoot, relative), errors, relative, { comments: true })
    for (const [key, value] of flattenLeaves(document)) {
      if (retired.has(key)) {
        errors.push(`retired configuration alias ${key} appears in ${relative}; use ${retired.get(key)}`)
        continue
      }
      const entry = settingByKey.get(key)
      if (!entry) {
        errors.push(`unowned appsettings key ${key} in ${relative}`)
        continue
      }
      seenSettings.add(key)
      for (const environment of appsettingsEnvironment.get(relative) ?? []) {
        if (!array(entry.environments).includes(environment)) errors.push(`setting ${key} has wrong environment scope in ${relative}`)
      }
      if (!typeMatches(entry.valueType, value)) errors.push(`setting ${key} has type drift in ${relative}; expected ${entry.valueType}`)
      if (entry.secret && !isEmpty(value)) {
        const allowedFixture = relative !== 'src/backend/appsettings.Production.json'
          && entry.repositoryValuePolicy === 'known-development-fixture-only; Production overlay must be empty'
        if (!allowedFixture) errors.push(`usable tracked secret value is forbidden for ${key} in ${relative}`)
      }
    }
  }

  const frameworkEnvironment = new Set(array(contract.frameworkEnvironmentAllowlist))
  const environmentByName = new Map(array(contract.environmentVariables).map(entry => [entry.name, entry]))
  for (const setting of settings) {
    for (const variable of array(setting.environmentVariables)) {
      const environment = environmentByName.get(variable)
      if (environment && !array(environment.mapsTo).includes(setting.key)) {
        errors.push(`application setting ${setting.key} and environment variable ${variable} have asymmetric mapping`)
      }
    }
  }
  for (const relative of array(sourceInventory.compose)) {
    let source = ''
    try {
      source = fs.readFileSync(path.join(absoluteRoot, relative), 'utf8')
    } catch (error) {
      errors.push(`compose source is missing: ${relative}`)
      continue
    }
    for (const line of source.split(/\r?\n/u)) {
      const match = /^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line)
      if (!match) continue
      const variable = match[1]
      let normalizedKey = variable.includes('__') ? variable.replaceAll('__', ':') : variable
      normalizedKey = normalizedKey.replace(/:\d+$/u, '')
      if (retired.has(normalizedKey)) {
        errors.push(`retired configuration alias ${normalizedKey} appears in ${relative}; use ${retired.get(normalizedKey)}`)
        continue
      }
      const key = normalizeComposeApplicationKey(variable, new Set(settingByKey.keys()), frameworkEnvironment)
      if (variable.includes('__') && !key) errors.push(`Compose application variable ${variable} maps to unknown key ${normalizedKey}`)
      if (key) seenSettings.add(key)
    }
  }
  for (const entry of settings) {
    if (!seenSettings.has(entry.key) && entry.runtimeOnly !== true) errors.push(`dead or unobserved configuration contract key ${entry.key}`)
  }

  const observedEnvironment = extractEnvironmentInventory(absoluteRoot, contract, errors)
  const seenEnvironment = new Set()
  for (const [name, sources] of observedEnvironment) {
    const entry = environmentByName.get(name)
    if (!entry) {
      errors.push(`unclassified tracked environment variable ${name}`)
      continue
    }
    seenEnvironment.add(name)
    if (!sameStrings(entry.sources, [...sources])) errors.push(`environment variable ${name} source ownership drifted`)
  }
  for (const entry of array(contract.environmentVariables)) {
    if (!entry?.name || environmentByName.get(entry.name) !== entry) errors.push(`environmentVariables must have unique non-empty names: ${entry?.name ?? '<empty>'}`)
    if (!validEnvironmentCategories.has(entry?.category)) errors.push(`environment variable ${entry?.name} has invalid category ${entry?.category}`)
    if (!owners[entry?.owner]) errors.push(`environment variable ${entry?.name} has unknown owner ${entry?.owner}`)
    if (!seenEnvironment.has(entry?.name)) errors.push(`dead environment variable contract entry ${entry?.name}`)
    if (environmentSecretLike(entry?.name)
      && entry?.category !== 'secret-file-path'
      && entry?.secret !== true) errors.push(`sensitive environment variable ${entry?.name} must remain secret-classified`)
    if (releaseIdentityVariables.has(entry?.name) && entry?.category !== 'release-identity') errors.push(`release identity variable ${entry?.name} is misclassified`)
    if (secretFileVariables.has(entry?.name) && entry?.category !== 'secret-file-path') errors.push(`secret-file input ${entry?.name} is misclassified`)
    if (String(entry?.name).includes('__')) {
      let mapped = String(entry.name).replaceAll('__', ':').replace(/:\d+$/u, '')
      if (settingByKey.has(mapped) && entry.category !== 'application-configuration') errors.push(`application environment variable ${entry.name} is misclassified`)
    }
    if (entry?.category === 'application-configuration') {
      const mappings = array(entry.mapsTo)
      if (mappings.length === 0 && !frameworkEnvironment.has(entry.name)) errors.push(`application environment variable ${entry.name} has no configuration mapping`)
      for (const key of mappings) {
        if (!settingByKey.has(key) && !frameworkEnvironment.has(key)) errors.push(`application environment variable ${entry.name} maps to unknown key ${key}`)
        else if (settingByKey.has(key) && !array(settingByKey.get(key).environmentVariables).includes(entry.name)) {
          errors.push(`environment variable ${entry.name} and application setting ${key} have asymmetric mapping`)
        }
      }
    }
  }

  for (const relative of array(sourceInventory.environmentExamples)) {
    let source = ''
    try {
      source = fs.readFileSync(path.join(absoluteRoot, relative), 'utf8')
    } catch (error) {
      errors.push(`environment example is missing: ${relative}`)
      continue
    }
    const values = parseEnvironmentExample(source, relative, errors)
    if (relative === '.env.production.example') {
      for (const [name, value] of values) {
        if (environmentByName.get(name)?.secret
          && environmentByName.get(name)?.category !== 'secret-file-path'
          && value
          && !/(?:CHANGE_ME|replace-)/iu.test(value)) {
          errors.push(`production environment example contains a usable secret for ${name}`)
        }
      }
    }
  }

  for (const mounted of array(contract.mountedFiles)) {
    const entry = settingByKey.get(mounted?.pathSettingKey)
    if (!entry || entry.valueType !== 'path') errors.push(`mounted file path setting is missing or not path-typed: ${mounted?.pathSettingKey}`)
    if (!owners[mounted?.owner] || entry?.owner !== mounted?.owner) errors.push(`mounted file ${mounted?.pathSettingKey} has inconsistent owner`)
    if (!mounted?.expectedFileClass || !mounted?.permissions || !mounted?.requiredWhen || !mounted?.identityValidation || !mounted?.locationScope) {
      errors.push(`mounted file ${mounted?.pathSettingKey} is missing lifecycle metadata`)
    }
    if (mounted?.integritySettingKey && !settingByKey.has(mounted.integritySettingKey)) {
      errors.push(`mounted file ${mounted.pathSettingKey} has unknown integrity setting ${mounted.integritySettingKey}`)
    }
  }

  const generatedReference = renderBackendConfigurationReference(contract)
  if (checkGeneratedReference) {
    const referencePath = path.join(absoluteRoot, canonicalAuthorities.generatedReference)
    let tracked = ''
    try {
      tracked = fs.readFileSync(referencePath, 'utf8')
    } catch (error) {
      errors.push(`generated configuration reference is missing: ${canonicalAuthorities.generatedReference}`)
    }
    if (tracked && tracked !== generatedReference) errors.push('generated configuration reference is stale; regenerate it from the contract')
  }

  return {
    contract,
    errors,
    report: {
      schema: 'fsusblog.backend-configuration-drift-report.v1',
      status: errors.length === 0 ? 'ok' : 'drift',
      contract: normalizedContractPath,
      counts: {
        applicationSettings: settings.length,
        environmentVariables: array(contract.environmentVariables).length,
        mountedFiles: array(contract.mountedFiles).length,
        observedApplicationSettings: seenSettings.size,
        observedEnvironmentVariables: observedEnvironment.size
      },
      errors
    },
    generatedReference
  }
}

function parseArgs(argv) {
  const options = {
    root: defaultRoot,
    contractPath: defaultContract,
    reportJson: null,
    writeDoc: false,
    printJson: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--root') options.root = path.resolve(argv[++index])
    else if (argument === '--contract') options.contractPath = argv[++index]
    else if (argument === '--report-json') options.reportJson = argv[++index]
    else if (argument === '--write-doc') options.writeDoc = true
    else if (argument === '--json') options.printJson = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function runCli() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[backend-configuration-contract] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }
  if (options.writeDoc) {
    const preliminary = checkBackendConfigurationContract({
      root: options.root,
      contractPath: options.contractPath,
      checkGeneratedReference: false
    })
    const destination = path.join(options.root, preliminary.contract.authorities?.generatedReference ?? canonicalAuthorities.generatedReference)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, preliminary.generatedReference)
  }
  const result = checkBackendConfigurationContract({ root: options.root, contractPath: options.contractPath })
  if (options.reportJson) {
    const destination = path.resolve(options.root, options.reportJson)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, `${JSON.stringify(result.report, null, 2)}\n`)
  }
  if (options.printJson) console.log(JSON.stringify(result.report, null, 2))
  else if (result.errors.length === 0) {
    const counts = result.report.counts
    console.log(`[backend-configuration-contract] ok settings=${counts.applicationSettings} env=${counts.environmentVariables} mounted=${counts.mountedFiles}`)
  } else {
    console.error(`[backend-configuration-contract] drift (${result.errors.length})`)
    for (const error of result.errors) console.error(`- ${error}`)
  }
  if (result.errors.length > 0) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile) runCli()
