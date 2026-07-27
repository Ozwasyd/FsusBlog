import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMatrix } from '../test-matrix/parse-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const config = (name) => path.join(root, 'config/testing', name)
const stableId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const sortedUnique = (values) => Array.isArray(values) && values.every((value, index) => typeof value === 'string' && stableId.test(value) && (!index || values[index - 1] < value))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const profileSources = new Set(['dev-cli', 'matrix'])
const sha256Json = (value) => `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

const requiredFixtureSourceFiles = Object.freeze([
  'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs',
  'src/backend/Modules/Endpoints/LocalAuthFixtureRefreshRunner.cs',
  'tests/backend/Integration/MessageCenterPersistenceIntegrationTests.cs',
  'tests/browser-contract/default-fixture-provider.mjs',
  'tests/browser-contract/fixture.mjs',
  'tests/browser-contract/prepare-fixture.mjs',
  'tests/browser-contract/run.mjs',
  'tests/frontend/fixtures/discover-playwright-fixtures.mjs',
  'tests/frontend/fixtures/prepare-auth-smoke-users.mjs',
  'tests/frontend/fixtures/prepare-playwright-sessions.mjs',
  'tests/frontend/support/playwright/global-setup.ts',
  'tests/frontend/support/session-fixtures.mjs',
  'tools/bootstrap-acceptance-env.sh',
  'tools/data-scale/cleanup.sh',
  'tools/data-scale/probe.sh',
  'tools/data-scale/seed.sh',
  'tools/dev/demo-seed.sql',
  'tools/dev/seed-demo-data.sh',
  'tools/test/lanes/data-scale.sh'
])

const fixtureDeclarationScanRoots = Object.freeze(['src', 'tests', 'tools'])
const fixtureDeclarationScanExtensions = /\.(?:cs|mjs|sh|sql|ts)$/u
const fixtureDeclarationScanExclusions = new Set([
  'tests/tools/fixture-catalog.test.mjs',
  'tools/testing/fixture-catalog.mjs',
  'tools/testing/generate-fixture-catalog-artifacts.mjs'
])

const forbiddenInventoryPhrases = Object.freeze([
  /默认由环境提供/u,
  /已有数据即可/u,
  /\bprovided by (?:the )?environment by default\b/iu,
  /\bexisting data is enough\b/iu,
  /\benvironment provides data by default\b/iu
])

export const fixtureCatalogFiles = Object.freeze({
  capability: config('fixture-capability-catalog.json'),
  profile: config('fixture-profile-catalog.json'),
  producer: config('fixture-producer-registry.json'),
  inventory: config('fixture-consumer-inventory.generated.json')
})

export function readFixtureCatalogs(files = fixtureCatalogFiles) {
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readJson(file)]))
}

function duplicate(values) {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

function validateReferences(values, known, label, errors) {
  for (const value of values ?? []) if (!known.has(value)) errors.push(`${label} references unknown id ${value}`)
}

/**
 * Observe truthful current source / fallback semantics from consumer source text.
 * Must not hardcode "no fallback" when Playwright or bootstrap reuses env data.
 */
export function observeFixtureConsumerSource(sourcePath, content) {
  const observations = new Set()
  const text = String(content ?? '')
  const pathHint = String(sourcePath ?? '')

  if (/seedPublicFixturesViaApi/u.test(text) && /\bseedPublicFixtures\s*\(/u.test(text)) {
    observations.add('admin API public seed falls back to direct-DB seed when API unavailable')
  } else if (/seedPublicFixturesViaApi/u.test(text)) {
    observations.add('public fixtures seeded via admin API when discovery finds no usable article/taxonomy')
  }

  if (/\bseedPublicFixtures\s*\(/u.test(text) && /existing_article/u.test(text)) {
    observations.add('direct-DB public seed reuses existing article rows by title when present')
  }

  if (/waitForPublicFixtureSnapshot|fetchPublicArticlePage/u.test(text) && /page\?\.items/u.test(text)) {
    observations.add('reuses public content already present in the running env when list/home discovery succeeds')
  }

  if (/acceptance environment is reused|while the acceptance environment is reused/u.test(text)) {
    observations.add('tolerates stale list cache entries while a reused acceptance environment refreshes')
  }

  if (/buildSeededArticleFallback|using direct DB fixture seed while public hot-read/u.test(text)) {
    observations.add('uses direct-DB seeded article IDs while public hot-read snapshot refreshes')
  }

  if (/FSUSBLOG_PERSIST_AUTH_FIXTURES/u.test(text) && /persistAuthFixtureManifest|auth-fixtures\.json/u.test(text)) {
    observations.add('persists auth fixture files when FSUSBLOG_PERSIST_AUTH_FIXTURES is not 0 for later worker reuse')
  }

  if (/WITH existing AS|WHERE NOT EXISTS \(SELECT 1 FROM existing\)/u.test(text) && /auth|user|admin|session/iu.test(text + pathHint)) {
    observations.add('upserts auth identities; reuses existing user/admin rows when handles already exist')
  }

  if (/PrepareAuthFixturesOnce|PreparePublicFixturesOnce|PrepareRuntimeFixturesOnce|PrepareSessionFixturesOnce/u.test(text)) {
    observations.add('bootstrap prepares auth/public fixtures once per namespace via run-once keys')
  }

  if (/public fallback is forbidden|sealed browser contract fixture is missing/u.test(text)) {
    observations.add('requires sealed browser-contract fixture root; public fallback is forbidden')
  }

  if (/browser-contract must use its formal single-namespace fixture lifecycle/u.test(text)) {
    observations.add('rejects legacy multi-worker session prep in browser-contract mode')
  }

  if (/data-scale|scale\.article-comment/u.test(pathHint + text) && /seed|cleanup|probe/u.test(pathHint + text)) {
    observations.add('scale data is produced by the scale-data generator for the selected scale profile only')
  }

  if (/demo-seed\.sql|seed-demo-data/u.test(pathHint) || /development\.demo\.dataset/u.test(text)) {
    observations.add('development demo dataset is applied via tools/dev demo seed; not a runtime acceptance producer')
  }

  if (/ResetSecurityRuntimeState/u.test(text)) {
    observations.add('lane may reset security runtime state around execution (not a business-data fallback)')
  }

  if (observations.size === 0) {
    if (/tests\/matrix\.yml/u.test(pathHint)) {
      return 'matrix-bound profile only; no undeclared free-string capability selection'
    }
    return 'no local data fallback path; depends on producers declared by the bound fixture profile'
  }

  return [...observations].sort().join('; ')
}

export function observeFixtureImplicitSource(sourcePath, content, { kind = 'source', tierId = null } = {}) {
  const text = String(content ?? '')
  const pathHint = String(sourcePath ?? '')
  if (kind === 'matrix') {
    return `tests/matrix.yml tier ${tierId}; command ${pathHint}`
  }
  if (/fixture-catalog:\s+consumer/u.test(text)) {
    return `fixture-catalog consumer declaration in ${pathHint}`
  }
  if (/discover-playwright-fixtures/u.test(pathHint)) {
    return `${pathHint} discovers live public article/taxonomy facts and writes the public fixture file`
  }
  if (/session-fixtures/u.test(pathHint)) {
    return `${pathHint} prepares auth/session identities via local fixture endpoints and SQL upserts`
  }
  if (/bootstrap-acceptance-env/u.test(pathHint)) {
    return `${pathHint} prepares namespace auth and public fixtures for acceptance/runtime consumers`
  }
  if (/default-fixture-provider|browser-contract/u.test(pathHint)) {
    return `${pathHint} prepares or loads sealed browser-contract fixture state`
  }
  return pathHint
}

function readOptionalSource(repositoryRoot, relative) {
  const absolute = path.join(repositoryRoot, relative)
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : ''
}

/**
 * Shared observation corpus for matrix consumers so inventory generation and validation stay exact.
 */
export function matrixConsumerObservationContent(tier, { repositoryRoot = root } = {}) {
  const commandPath = String(tier.command ?? '').match(/\b(tools\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))\b/u)?.[1]
  const chunks = []
  if (commandPath) chunks.push(readOptionalSource(repositoryRoot, commandPath))
  if (tier.requiresBootstrap === 'full' || /bootstrap/u.test(String(tier.command ?? ''))) {
    chunks.push(readOptionalSource(repositoryRoot, 'tools/bootstrap-acceptance-env.sh'))
  }
  if (/discover-playwright|playwright|browser-contract|acceptance|visual|ux-viewport|csrf-browser/u.test(`${tier.id} ${tier.command ?? ''}`)) {
    chunks.push(readOptionalSource(repositoryRoot, 'tests/frontend/fixtures/discover-playwright-fixtures.mjs'))
    chunks.push(readOptionalSource(repositoryRoot, 'tests/frontend/support/session-fixtures.mjs'))
  }
  if (/browser-contract/u.test(`${tier.id} ${tier.command ?? ''}`)) {
    chunks.push(readOptionalSource(repositoryRoot, 'tests/browser-contract/fixture.mjs'))
    chunks.push(readOptionalSource(repositoryRoot, 'tests/browser-contract/default-fixture-provider.mjs'))
  }
  if (/data-scale|load-smoke|load-profile|backend-qps/u.test(`${tier.id} ${tier.command ?? ''}`)) {
    chunks.push(readOptionalSource(repositoryRoot, 'tools/data-scale/seed.sh'))
    chunks.push(readOptionalSource(repositoryRoot, 'tools/test/lanes/data-scale.sh'))
  }
  return chunks.join('\n')
}

export function scanFixtureSourceDeclarations({ repositoryRoot = root, sourceOverrides = new Map() } = {}) {
  const consumers = []
  const producers = []
  const sources = new Set(requiredFixtureSourceFiles)
  const visit = (relative) => {
    const absolute = path.join(repositoryRoot, relative)
    if (!fs.existsSync(absolute)) return
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '.tmp', 'bin', 'obj', 'dist'].includes(entry.name)) visit(child)
      } else if (fixtureDeclarationScanExtensions.test(entry.name) && !fixtureDeclarationScanExclusions.has(child)) {
        sources.add(child)
      }
    }
  }
  for (const directory of fixtureDeclarationScanRoots) visit(directory)
  for (const [source] of sourceOverrides) sources.add(source)
  for (const source of [...sources].sort()) {
    const file = path.join(repositoryRoot, source)
    if (!sourceOverrides.has(source) && !fs.existsSync(file)) throw new Error(`audited fixture source is missing: ${source}`)
    const content = sourceOverrides.get(source) ?? fs.readFileSync(file, 'utf8')
    const declarations = [...content.matchAll(/fixture-catalog:[ \t]+(consumer|producer)[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*|matrix))?/gu)]
    if (declarations.length === 0) {
      if (requiredFixtureSourceFiles.includes(source)) throw new Error(`audited fixture source has no declaration: ${source}`)
      continue
    }
    for (const declaration of declarations) {
      if (declaration[1] === 'consumer') {
        if (!declaration[3]) throw new Error(`fixture consumer declaration has no profile: ${source}`)
        consumers.push({ id: declaration[2], profileId: declaration[3], source })
      } else {
        if (declaration[3]) throw new Error(`fixture producer declaration has unexpected profile: ${source}`)
        producers.push({ producerId: declaration[2], source })
      }
    }
  }
  const consumerIds = consumers.map((item) => item.id)
  if (duplicate(consumerIds).length) throw new Error(`duplicate fixture source consumer id ${duplicate(consumerIds).sort().join(', ')}`)
  return {
    consumers: consumers.sort((left, right) => left.id.localeCompare(right.id)),
    producers: producers.sort((left, right) => left.producerId.localeCompare(right.producerId) || left.source.localeCompare(right.source))
  }
}

export function isFixtureMatrixConsumer(tier) {
  if (['projection', 'summary'].includes(tier.executionMode)) return false
  return tier.requiresBootstrap !== 'none'
    || (/tools\/test\/lanes\/(?:backend-qps|data-scale|load-profile|load-smoke)\.sh/u.test(String(tier.command ?? ''))
      && !/\saggregate$/u.test(String(tier.command ?? '')))
}

export function validateNoneFixtureTier(tier, {
  repositoryRoot = root,
  sourceOverrides = new Map()
} = {}) {
  if (tier.fixtureProfile !== 'none') return []
  const commandPath = String(tier.command ?? '').match(/\b(tools\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))\b/u)?.[1]
  if (!commandPath) return []
  const source = sourceOverrides.get(commandPath)
    ?? (fs.existsSync(path.join(repositoryRoot, commandPath))
      ? fs.readFileSync(path.join(repositoryRoot, commandPath), 'utf8')
      : '')
  if (!source) return []
  const forbiddenOperations = [
    [/ResetSecurityRuntimeState/u, 'security state reset'],
    [/\b(?:PrepareAuthFixturesOnce|PreparePublicFixturesOnce|PrepareRuntimeFixturesOnce|PrepareSessionFixturesOnce)\b/u, 'business fixture preparation']
  ]
  return forbiddenOperations
    .filter(([pattern]) => pattern.test(source))
    .map(([, operation]) => `matrix tier ${tier.id} none profile cannot execute ${operation}`)
}

export function validateFixtureAuthoritySources({ repositoryRoot = root, sourceOverrides = new Map() } = {}) {
  const errors = []
  const forbidden = [
    [/fixtureProfileAlias(?:es)?|legacyFixtureProfiles?/u, 'fixture profile alias is forbidden'],
    [/\bfixtureProfiles?\s*[:=]\s*\[/u, 'second fixture profile list is forbidden'],
    [/\b[A-Za-z0-9_]*fixture[A-Za-z0-9_]*capabilit(?:y|ies)\s*[:=]\s*\[/iu, 'free-string fixture capability list is forbidden']
  ]
  const allowedAuthorityFiles = new Set([
    'config/testing/fixture-capability-catalog.json',
    'config/testing/fixture-consumer-inventory.generated.json',
    'config/testing/fixture-producer-registry.json',
    'config/testing/fixture-profile-catalog.json',
    'docs/testing/fixture-capability-catalog.md',
    'tests/matrix.yml',
    'tests/tools/fixture-catalog.test.mjs',
    'tools/testing/fixture-catalog.mjs',
    'tools/testing/generate-fixture-catalog-artifacts.mjs'
  ])
  const candidates = []
  const visit = (relative) => {
    const absolute = path.join(repositoryRoot, relative)
    if (!fs.existsSync(absolute)) return
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '.tmp', 'bin', 'obj', 'dist'].includes(entry.name)) visit(child)
      } else if (/\.(?:cs|json|md|mjs|sh|sql|ts|tsx|vue|ya?ml)$/u.test(entry.name)) {
        candidates.push(child)
      }
    }
  }
  for (const directory of ['config', 'docs', 'src', 'tests', 'tools']) visit(directory)
  for (const [source] of sourceOverrides) if (!candidates.includes(source)) candidates.push(source)
  for (const source of candidates) {
    if (allowedAuthorityFiles.has(source)) continue
    const content = sourceOverrides.get(source) ?? fs.readFileSync(path.join(repositoryRoot, source), 'utf8')
    const code = content.replace(/^.*fixture-catalog:.*$/gmu, '')
    for (const [pattern, message] of forbidden) if (pattern.test(code)) errors.push(`${source}: ${message}`)
    if (/\bfixtureProfile\s*[:=]\s*['"`]/u.test(code)) errors.push(`${source}: free-string fixture profile selection is forbidden`)
  }
  return errors
}

export function expandFixtureProfile(profileId, catalogs = readFixtureCatalogs()) {
  const profile = catalogs.profile.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error(`unknown fixture profile ${profileId}`)
  const byCapability = new Map(catalogs.capability.capabilities.map((capability) => [capability.id, capability]))
  const resolved = new Set()
  const visiting = new Set()
  const add = (id) => {
    if (visiting.has(id)) throw new Error(`fixture capability dependency cycle at ${id}`)
    if (resolved.has(id)) return
    const capability = byCapability.get(id)
    if (!capability) throw new Error(`fixture profile ${profileId} references unknown capability ${id}`)
    visiting.add(id)
    capability.dependsOn.forEach(add)
    visiting.delete(id)
    resolved.add(id)
  }
  profile.capabilities.forEach(add)
  const capabilities = [...resolved].sort()
  const conflicts = capabilities.flatMap((id) => byCapability.get(id).conflictsWith.filter((conflict) => resolved.has(conflict)).map((conflict) => [id, conflict]))
  if (conflicts.length) throw new Error(`fixture profile ${profileId} contains conflicting capabilities ${conflicts.map((pair) => pair.join('/')).join(', ')}`)
  return Object.freeze({ id: profileId, capabilities: Object.freeze(capabilities) })
}

/**
 * Authority digest over capability/profile/producer catalogs (inventory excluded).
 * Used to fail closed when sealed matrix identity drifts from live catalogs.
 */
export function fixtureCatalogDigest(catalogs = readFixtureCatalogs()) {
  return sha256Json({
    capability: catalogs.capability,
    profile: catalogs.profile,
    producer: catalogs.producer
  })
}

export function expandedCapabilityDigest(capabilities) {
  return sha256Json([...(capabilities ?? [])].map(String).sort())
}

export function producersForCapabilities(capabilities, catalogs = readFixtureCatalogs()) {
  const selected = new Set(capabilities ?? [])
  return (catalogs.producer.producers ?? [])
    .filter((producer) => producer.provides.some((id) => selected.has(id)))
    .map((producer) => producer.id)
    .sort()
}

/**
 * Derive mutation policy and orchestrator flags from an expanded profile.
 * Security runtime reset is never a default bootstrap side effect; only future
 * explicit catalog-owned reset capabilities can enable it (none today).
 */
export function planFixtureMutation(profileId, catalogs = readFixtureCatalogs()) {
  const profile = catalogs.profile.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error(`unknown fixture profile ${profileId}`)
  const expanded = expandFixtureProfile(profileId, catalogs)
  const producers = producersForCapabilities(expanded.capabilities, catalogs)
  const byCapability = new Map(catalogs.capability.capabilities.map((capability) => [capability.id, capability]))
  const requiresAuthFixtures = expanded.capabilities.some((id) => byCapability.get(id)?.ownerProducerId === 'auth-session')
  const requiresPublicFixtures = expanded.capabilities.some((id) => byCapability.get(id)?.ownerProducerId === 'public-content')
  const requiresDemoSeed = expanded.capabilities.includes('development.demo.dataset')
  const requiresSecurityState = expanded.capabilities.some((id) => byCapability.get(id)?.ownerProducerId === 'security-state')
  // Catalog has no dedicated security-runtime-reset capability yet; fail closed to zero.
  const requiresSecurityReset = expanded.capabilities.some((id) => id === 'security.runtime-reset')
  const mutationPolicy = profileId === 'none' || expanded.capabilities.length === 0
    ? 'zero-mutation'
    : profile.isDestructive
      ? 'destructive-namespace'
      : 'namespace-fixture'
  return Object.freeze({
    profileId,
    capabilities: expanded.capabilities,
    producers: Object.freeze(producers),
    mutationPolicy,
    isDestructive: profile.isDestructive === true,
    requiresFreshNamespace: profile.requiresFreshNamespace === true,
    requiresLocalAuthBypass: requiresAuthFixtures,
    requiresAuthFixtures,
    requiresPublicFixtures,
    requiresDemoSeed,
    requiresSecurityState,
    requiresSecurityReset,
    allowedExecutionClasses: Object.freeze([...(profile.allowedExecutionClasses ?? [])])
  })
}

/**
 * Shared resolver for dev-cli and matrix-sealed bootstrap inputs.
 * Correctness callers cannot substitute profile identity via free env override.
 */
export function resolveFixtureProfile({
  profileId,
  profileSource,
  executionClass = null,
  sealed = null,
  catalogs = readFixtureCatalogs(),
  allowFreeProfileEnv = false,
  freeProfileEnv = process.env.FSUSBLOG_FIXTURE_PROFILE
} = {}) {
  if (!profileSources.has(profileSource)) {
    throw new Error(`fixture profile source must be dev-cli or matrix, got ${profileSource ?? '<missing>'}`)
  }
  if (profileSource === 'matrix' && allowFreeProfileEnv !== true) {
    const override = String(freeProfileEnv ?? '').trim()
    if (override) {
      throw new Error('correctness fixture profile cannot be overridden by FSUSBLOG_FIXTURE_PROFILE')
    }
  }
  const requestedId = String(profileId ?? '').trim()
  if (!requestedId) throw new Error('fixture profile id is required; use catalog id none for zero-data startup')
  if (requestedId !== profileId || !stableId.test(requestedId)) {
    throw new Error(`fixture profile id is invalid: ${profileId}`)
  }
  const profile = catalogs.profile.profiles.find((candidate) => candidate.id === requestedId)
  if (!profile) throw new Error(`unknown fixture profile ${requestedId}`)
  const plan = planFixtureMutation(requestedId, catalogs)
  if (executionClass != null && executionClass !== '') {
    if (!plan.allowedExecutionClasses.includes(executionClass)) {
      throw new Error(`fixture profile ${requestedId} rejects execution class ${executionClass}`)
    }
  }
  const catalogDigest = fixtureCatalogDigest(catalogs)
  const capabilityDigest = expandedCapabilityDigest(plan.capabilities)
  if (profileSource === 'matrix') {
    if (!sealed || typeof sealed !== 'object') {
      throw new Error('matrix fixture profile requires sealed identity before mutation')
    }
    const sealedId = String(sealed.fixtureProfileId ?? '').trim()
    const sealedCatalogDigest = String(sealed.fixtureCatalogDigest ?? '').trim()
    const sealedCapabilityDigest = String(sealed.expandedCapabilityDigest ?? '').trim()
    const sealedExecutionClass = sealed.executionClass == null || sealed.executionClass === ''
      ? null
      : String(sealed.executionClass)
    if (!sealedId) throw new Error('sealed fixtureProfileId is missing')
    if (sealedId !== requestedId) {
      throw new Error(`sealed fixture profile ${sealedId} does not match requested ${requestedId}`)
    }
    if (!sealedCatalogDigest) throw new Error('sealed fixtureCatalogDigest is missing')
    if (!sealedCapabilityDigest) throw new Error('sealed expandedCapabilityDigest is missing')
    if (sealedCatalogDigest !== catalogDigest) {
      throw new Error('fixture catalog digest drifted after matrix seal; refusing mutation')
    }
    if (sealedCapabilityDigest !== capabilityDigest) {
      throw new Error('expanded capability digest drifted after matrix seal; refusing mutation')
    }
    if (sealedExecutionClass != null) {
      if (!plan.allowedExecutionClasses.includes(sealedExecutionClass)) {
        throw new Error(`sealed execution class ${sealedExecutionClass} is not allowed for profile ${requestedId}`)
      }
      if (executionClass != null && executionClass !== '' && sealedExecutionClass !== executionClass) {
        throw new Error(`sealed execution class ${sealedExecutionClass} does not match ${executionClass}`)
      }
    }
  } else if (sealed != null) {
    throw new Error('dev-cli fixture profile must not carry matrix sealed identity')
  }
  const resolvedExecutionClass = executionClass
    || (profileSource === 'dev-cli'
      ? (plan.allowedExecutionClasses.includes('diagnostic')
        ? 'diagnostic'
        : plan.allowedExecutionClasses[0] ?? null)
      : null)
  return Object.freeze({
    schema: 'fsusblog.fixture-profile-plan.v1',
    profileId: requestedId,
    profileSource,
    executionClass: resolvedExecutionClass,
    catalogDigest,
    expandedCapabilityDigest: capabilityDigest,
    capabilities: plan.capabilities,
    producers: plan.producers,
    mutationPolicy: plan.mutationPolicy,
    isDestructive: plan.isDestructive,
    requiresFreshNamespace: plan.requiresFreshNamespace,
    requiresLocalAuthBypass: plan.requiresLocalAuthBypass,
    requiresAuthFixtures: plan.requiresAuthFixtures,
    requiresPublicFixtures: plan.requiresPublicFixtures,
    requiresDemoSeed: plan.requiresDemoSeed,
    requiresSecurityState: plan.requiresSecurityState,
    requiresSecurityReset: plan.requiresSecurityReset,
    sealed: profileSource === 'matrix'
      ? Object.freeze({
        fixtureProfileId: requestedId,
        fixtureCatalogDigest: catalogDigest,
        expandedCapabilityDigest: capabilityDigest,
        executionClass: resolvedExecutionClass
      })
      : null
  })
}

export function inferFixtureExecutionClass(tier, catalogs = readFixtureCatalogs()) {
  const profile = catalogs.profile.profiles.find((item) => item.id === tier?.fixtureProfile)
  const candidates = []
  if (tier?.resourceClass === 'browser') candidates.push('browser')
  if (/^(?:backend-qps|data-scale|load|soak)/u.test(String(tier?.id ?? ''))) candidates.push('load')
  if (/^(?:csrf|security)/u.test(String(tier?.id ?? ''))) candidates.push('security')
  if (tier?.requiresBootstrap === 'full' || tier?.selfBootstraps === true) candidates.push('acceptance')
  candidates.push('runtime', 'diagnostic')
  for (const candidate of candidates) {
    if (profile?.allowedExecutionClasses?.includes(candidate)) return candidate
  }
  return profile?.allowedExecutionClasses?.[0] ?? null
}

export function sealMatrixFixtureProfile(tier, catalogs = readFixtureCatalogs()) {
  if (!tier || !Object.hasOwn(tier, 'fixtureProfile')) {
    throw new Error('matrix tier is missing fixtureProfile')
  }
  const executionClass = inferFixtureExecutionClass(tier, catalogs)
  const plan = planFixtureMutation(tier.fixtureProfile, catalogs)
  if (executionClass != null && !plan.allowedExecutionClasses.includes(executionClass)) {
    throw new Error(`fixture profile ${tier.fixtureProfile} rejects execution class ${executionClass}`)
  }
  const catalogDigest = fixtureCatalogDigest(catalogs)
  const capabilityDigest = expandedCapabilityDigest(plan.capabilities)
  return resolveFixtureProfile({
    profileId: tier.fixtureProfile,
    profileSource: 'matrix',
    executionClass,
    sealed: {
      fixtureProfileId: tier.fixtureProfile,
      fixtureCatalogDigest: catalogDigest,
      expandedCapabilityDigest: capabilityDigest,
      executionClass
    },
    catalogs,
    // Sealing happens inside the matrix runner before child env is built.
    allowFreeProfileEnv: true,
    freeProfileEnv: ''
  })
}

export function writeFixtureProfileReceipt(file, plan, {
  kind = 'planned-profile',
  fixtureReceiptPath = null,
  fixtureReceiptDigest = null,
  extra = null
} = {}) {
  if (!file) throw new Error('fixture profile receipt path is required')
  const capabilityIds = plan.capabilityIds ?? plan.capabilities ?? []
  const producerIds = plan.producerIds ?? plan.producers ?? []
  const receipt = {
    schema: kind === 'environment-ready'
      ? 'fsusblog.fixture-environment-ready.v1'
      : kind === 'fixture-receipt'
        ? 'fsusblog.fixture-receipt.v1'
        : 'fsusblog.fixture-planned-profile.v1',
    kind,
    generatedAt: new Date().toISOString(),
    profileId: plan.profileId,
    profileSource: plan.profileSource,
    catalogDigest: plan.catalogDigest,
    expandedCapabilityDigest: plan.expandedCapabilityDigest,
    capabilityIds,
    producerIds,
    // Preserve plan-shaped aliases so later receipt writers can rehydrate.
    capabilities: capabilityIds,
    producers: producerIds,
    mutationPolicy: plan.mutationPolicy,
    executionClass: plan.executionClass,
    requiresLocalAuthBypass: plan.requiresLocalAuthBypass,
    requiresAuthFixtures: plan.requiresAuthFixtures,
    requiresPublicFixtures: plan.requiresPublicFixtures,
    requiresDemoSeed: plan.requiresDemoSeed,
    requiresSecurityReset: plan.requiresSecurityReset,
    fixtureReceiptPath,
    fixtureReceiptDigest,
    ...(extra && typeof extra === 'object' ? extra : {})
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best-effort on platforms without chmod */ }
  return receipt
}

export function fixtureReceiptDigestFromFile(file) {
  const bytes = fs.readFileSync(file)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function applySealedFixtureProfileEnvironment(env, plan) {
  const next = { ...env }
  next.FSUSBLOG_SEALED_FIXTURE_PROFILE_ID = plan.profileId
  next.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST = plan.catalogDigest
  next.FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST = plan.expandedCapabilityDigest
  next.FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS = plan.executionClass ?? ''
  next.FSUSBLOG_FIXTURE_PROFILE_SOURCE = plan.profileSource
  // Overwrite ambient free-profile env so process.env inheritance cannot smuggle overrides.
  next.FSUSBLOG_FIXTURE_PROFILE = ''
  return next
}

function validateInventoryTruthfulness(consumer, content, errors) {
  const fallback = String(consumer.currentFallback ?? '')
  const implicit = String(consumer.implicitSource ?? '')
  if (!fallback || !implicit) {
    errors.push(`consumer ${consumer.consumerId} must record source and fallback`)
    return
  }
  for (const phrase of forbiddenInventoryPhrases) {
    if (phrase.test(fallback) || phrase.test(implicit)) {
      errors.push(`consumer ${consumer.consumerId} inventory uses incomplete environment-default phrasing`)
    }
  }
  const expectedFallback = observeFixtureConsumerSource(consumer.source, content)
  if (fallback !== expectedFallback) {
    errors.push(`consumer ${consumer.consumerId} currentFallback is stale or untruthful`)
  }
  // Reject the prior fail pattern: universal hardcoded "no fallback" while source reuses env data.
  if (/no catalog alias or undeclared capability fallback/u.test(fallback)
    && /seedPublicFixtures|FSUSBLOG_PERSIST_AUTH_FIXTURES|PrepareAuthFixturesOnce|reuses public content|existing_article/u.test(content)) {
    errors.push(`consumer ${consumer.consumerId} hardcodes no-fallback while source reuses env data`)
  }
}

export function validateFixtureCatalogs({
  files = fixtureCatalogFiles,
  matrixFile = path.join(root, 'tests/matrix.yml'),
  validateRepositoryAuthority = true,
  repositoryRoot = root
} = {}) {
  const errors = []
  let catalogs
  try { catalogs = readFixtureCatalogs(files) } catch (error) { return [`fixture catalog is unreadable: ${error.message}`] }
  const { capability, profile, producer, inventory } = catalogs
  if (capability.schema !== 'fsusblog.fixture-capability-catalog.v1') errors.push('capability catalog schema is invalid')
  if (profile.schema !== 'fsusblog.fixture-profile-catalog.v1') errors.push('profile catalog schema is invalid')
  if (producer.schema !== 'fsusblog.fixture-producer-registry.v1') errors.push('producer registry schema is invalid')
  if (inventory.schema !== 'fsusblog.fixture-consumer-inventory.v1') errors.push('consumer inventory schema is invalid')
  const domains = new Set(readJson(path.join(repositoryRoot, capability.stateDomainRegistry)).domains ?? [])
  const capabilities = capability.capabilities ?? []
  const producers = producer.producers ?? []
  const profiles = profile.profiles ?? []
  const capabilityIds = new Set(capabilities.map((item) => item.id))
  const producerIds = new Set(producers.map((item) => item.id))
  const profileIds = new Set(profiles.map((item) => item.id))
  for (const [label, values] of [['capability', capabilities.map((item) => item.id)], ['producer', producers.map((item) => item.id)], ['profile', profiles.map((item) => item.id)]]) {
    if (duplicate(values).length) errors.push(`duplicate ${label} id ${duplicate(values).sort().join(', ')}`)
  }
  for (const item of capabilities) {
    if (!stableId.test(item.id ?? '')) errors.push(`capability has unstable id ${item.id}`)
    for (const field of ['stateDomains', 'dependsOn', 'conflictsWith', 'postconditionIds']) if (!sortedUnique(item[field])) errors.push(`capability ${item.id} ${field} must be sorted and unique stable IDs`)
    if (item.stateDomains?.length === 0) errors.push(`capability ${item.id} must declare state domains`)
    if (item.postconditionIds?.length === 0) errors.push(`capability ${item.id} must declare postconditions`)
    if (!stableId.test(item.resetContractId ?? '')) errors.push(`capability ${item.id} must declare a stable reset contract`)
    if (!producerIds.has(item.ownerProducerId)) errors.push(`capability ${item.id} has unknown owner ${item.ownerProducerId}`)
    validateReferences(item.stateDomains, domains, `capability ${item.id}.stateDomains`, errors)
    validateReferences(item.dependsOn, capabilityIds, `capability ${item.id}.dependsOn`, errors)
    validateReferences(item.conflictsWith, capabilityIds, `capability ${item.id}.conflictsWith`, errors)
    if (!['namespace', 'run', 'scenario'].includes(item.scope)) errors.push(`capability ${item.id} has invalid scope`)
    if (!['immutable', 'scenario-owned'].includes(item.mutability)) errors.push(`capability ${item.id} has invalid mutability`)
  }
  for (const item of producers) {
    if (!stableId.test(item.id ?? '')) errors.push(`producer has unstable id ${item.id}`)
    for (const field of ['provides', 'consumes', 'stateDomains', 'receiptPostconditions']) if (!sortedUnique(item[field])) errors.push(`producer ${item.id} ${field} must be sorted and unique stable IDs`)
    if (!item.provides?.length) errors.push(`producer ${item.id} must provide capabilities`)
    if (!Array.isArray(item.implementationPaths) || item.implementationPaths.length === 0 || item.implementationPaths.some((value, index) => typeof value !== 'string' || (!index ? false : item.implementationPaths[index - 1] >= value))) {
      errors.push(`producer ${item.id} implementationPaths must be non-empty, sorted and unique`)
    }
    if (!['transaction-fixture', 'public-api-scenario', 'deterministic-generator'].includes(item.strategy)) errors.push(`producer ${item.id} has invalid strategy`)
    validateReferences(item.provides, capabilityIds, `producer ${item.id}.provides`, errors)
    validateReferences(item.consumes, capabilityIds, `producer ${item.id}.consumes`, errors)
    validateReferences(item.stateDomains, domains, `producer ${item.id}.stateDomains`, errors)
    const expectedDomains = [...new Set([...item.provides, ...item.consumes].flatMap((id) => capability.capabilities.find((candidate) => candidate.id === id)?.stateDomains ?? []))].sort()
    if (JSON.stringify(item.stateDomains) !== JSON.stringify(expectedDomains)) errors.push(`producer ${item.id} stateDomains must exactly match capability domains`)
    const expectedPostconditions = [...new Set(item.provides.flatMap((id) => capability.capabilities.find((candidate) => candidate.id === id)?.postconditionIds ?? []))].sort()
    if (JSON.stringify(item.receiptPostconditions) !== JSON.stringify(expectedPostconditions)) errors.push(`producer ${item.id} receiptPostconditions must exactly match provided capability postconditions`)
  }
  // One owner per capability; API + direct-DB cannot both claim the same capability as producers.
  for (const item of capabilities) {
    const owners = producers.filter((candidate) => candidate.provides.includes(item.id))
    if (owners.length !== 1 || owners[0]?.id !== item.ownerProducerId) errors.push(`capability ${item.id} must have exactly owner ${item.ownerProducerId}`)
  }
  const strategyByCapability = new Map()
  for (const item of producers) {
    for (const capabilityId of item.provides) {
      const prior = strategyByCapability.get(capabilityId)
      if (prior && prior !== item.strategy) {
        errors.push(`capability ${capabilityId} has mixed producer strategies ${prior} and ${item.strategy}; API and direct-DB cannot be runtime fallbacks`)
      }
      strategyByCapability.set(capabilityId, item.strategy)
    }
  }
  const securityIds = capabilities.filter((item) => /^(?:security\.|auth\.user\.banned)/u.test(item.id)).map((item) => item.id)
  for (const id of securityIds) if (capability.capabilities.find((item) => item.id === id).ownerProducerId !== 'security-state') errors.push(`security capability ${id} must be owned by security-state`)
  for (const item of producers.find((candidate) => candidate.id === 'auth-session')?.provides ?? []) {
    if (/^(?:security\.|auth\.user\.banned)/u.test(item)) errors.push('auth-session must not provide security capability')
  }
  for (const item of profiles) {
    if (!stableId.test(item.id ?? '') || !sortedUnique(item.capabilities)) errors.push(`profile ${item.id} capabilities must be sorted and unique stable IDs`)
    if (!sortedUnique(item.allowedExecutionClasses) || item.allowedExecutionClasses.length === 0 || item.allowedExecutionClasses.some((value) => !['acceptance', 'browser', 'diagnostic', 'load', 'runtime', 'security'].includes(value))) {
      errors.push(`profile ${item.id} allowedExecutionClasses must be non-empty, sorted, unique and known`)
    }
    if (typeof item.isDestructive !== 'boolean' || typeof item.requiresFreshNamespace !== 'boolean') errors.push(`profile ${item.id} mutation and namespace flags must be boolean`)
    validateReferences(item.capabilities, capabilityIds, `profile ${item.id}.capabilities`, errors)
    try { expandFixtureProfile(item.id, catalogs) } catch (error) { errors.push(error.message) }
  }
  const none = profiles.find((item) => item.id === 'none')
  if (!none || none.capabilities.length !== 0 || none.isDestructive || none.requiresFreshNamespace) {
    errors.push('none profile must declare zero producers, zero business mutation and zero reset')
  }
  if ([...capabilityIds].some((id) => /(?:^|[.-])all(?:[.-]|$)/u.test(id))) errors.push('broad fixture capability is forbidden')
  const inventoryConsumerIds = (inventory.consumers ?? []).map((item) => item.consumerId)
  if (duplicate(inventoryConsumerIds).length) errors.push(`duplicate fixture inventory consumer id ${duplicate(inventoryConsumerIds).sort().join(', ')}`)
  for (const consumer of inventory.consumers ?? []) {
    if (!consumer.consumerId || !Array.isArray(consumer.requiredCapabilities)) errors.push('consumer inventory entry is incomplete')
    validateReferences(consumer.requiredCapabilities, capabilityIds, `consumer ${consumer.consumerId}`, errors)
    if (consumer.requiredCapabilities.length && consumer.profileId === 'none') errors.push(`data consumer ${consumer.consumerId} cannot use none profile`)
    if (!consumer.implicitSource || !consumer.currentFallback) errors.push(`consumer ${consumer.consumerId} must record source and fallback`)
    const selectedProfiles = consumer.profileIds ?? [consumer.profileId]
    if (!sortedUnique(selectedProfiles) || selectedProfiles.length === 0) errors.push(`consumer ${consumer.consumerId} profile bindings must be non-empty, sorted and unique`)
    for (const profileId of selectedProfiles) {
      const selectedProfile = profiles.find((item) => item.id === profileId)
      if (!selectedProfile) errors.push(`consumer ${consumer.consumerId} references unknown profile ${profileId}`)
      else if (!selectedProfile.allowedExecutionClasses.includes(consumer.executionClass) && !consumer.consumerId.startsWith('source:')) {
        errors.push(`consumer ${consumer.consumerId} profile ${profileId} rejects execution class ${consumer.executionClass}`)
      }
    }
    if (selectedProfiles.every((profileId) => profileIds.has(profileId))) {
      try {
        const expanded = new Set(selectedProfiles.flatMap((profileId) => expandFixtureProfile(profileId, catalogs).capabilities))
        for (const required of consumer.requiredCapabilities) if (!expanded.has(required)) errors.push(`consumer ${consumer.consumerId} profile binding omits required capability ${required}`)
      } catch (error) {
        errors.push(`consumer ${consumer.consumerId} profile expansion failed: ${error.message}`)
      }
    }
  }
  try {
    const matrix = parseMatrix(fs.readFileSync(matrixFile, 'utf8'))
    const expectedMatrixConsumers = matrix.tiers.filter(isFixtureMatrixConsumer)
    for (const tier of matrix.tiers) {
      const isConsumer = isFixtureMatrixConsumer(tier)
      if (isConsumer && (!Object.hasOwn(tier, 'fixtureProfile') || !Object.hasOwn(tier, 'fixtureCapabilities'))) {
        errors.push(`matrix data consumer ${tier.id} must bind fixtureProfile and fixtureCapabilities`)
        continue
      }
      if (!isConsumer && (Object.hasOwn(tier, 'fixtureProfile') || Object.hasOwn(tier, 'fixtureCapabilities'))) {
        errors.push(`matrix non-consumer ${tier.id} must not declare fixture data`)
      }
      if (!Object.hasOwn(tier, 'fixtureProfile')) continue
      errors.push(...validateNoneFixtureTier(tier, { repositoryRoot }))
      if (!profileIds.has(tier.fixtureProfile)) errors.push(`matrix tier ${tier.id} references unknown fixture profile ${tier.fixtureProfile}`)
      if (!sortedUnique(tier.fixtureCapabilities)) errors.push(`matrix tier ${tier.id} fixtureCapabilities must be sorted and unique`)
      validateReferences(tier.fixtureCapabilities, capabilityIds, `matrix tier ${tier.id}.fixtureCapabilities`, errors)
      try {
        const expanded = new Set(expandFixtureProfile(tier.fixtureProfile, catalogs).capabilities)
        for (const required of tier.fixtureCapabilities) if (!expanded.has(required)) errors.push(`matrix tier ${tier.id} profile ${tier.fixtureProfile} omits ${required}`)
        if (tier.fixtureProfile === 'none' && tier.fixtureCapabilities.length !== 0) errors.push(`matrix tier ${tier.id} none profile must have zero capabilities`)
        if (tier.fixtureProfile !== 'none' && tier.fixtureCapabilities.length === 0) errors.push(`matrix data consumer ${tier.id} cannot hide its facts behind an empty capability list`)
      } catch (error) { errors.push(`matrix tier ${tier.id} profile expansion failed: ${error.message}`) }
    }
    const inventoryMatrixIds = (inventory.consumers ?? []).filter((item) => item.consumerId.startsWith('matrix:')).map((item) => item.consumerId.slice('matrix:'.length)).sort()
    if (JSON.stringify(inventoryMatrixIds) !== JSON.stringify(expectedMatrixConsumers.map((tier) => tier.id).sort())) {
      errors.push('matrix data consumers and generated inventory must bidirectionally exact match')
    }
    const inventoryById = new Map((inventory.consumers ?? []).map((item) => [item.consumerId, item]))
    for (const tier of expectedMatrixConsumers) {
      const entry = inventoryById.get(`matrix:${tier.id}`)
      if (entry && (entry.profileId !== tier.fixtureProfile || JSON.stringify(entry.requiredCapabilities) !== JSON.stringify(tier.fixtureCapabilities))) {
        errors.push(`matrix tier ${tier.id} and generated inventory declaration differ`)
      }
      if (entry) {
        validateInventoryTruthfulness(entry, matrixConsumerObservationContent(tier, { repositoryRoot }), errors)
      }
    }
  } catch (error) { errors.push(`matrix is unreadable for fixture validation: ${error.message}`) }
  try {
    const declarations = scanFixtureSourceDeclarations({ repositoryRoot })
    const declaredImplementations = declarations.producers
    const registryImplementations = producers.flatMap((item) => item.implementationPaths.map((source) => ({ producerId: item.id, source }))).sort((left, right) => left.producerId.localeCompare(right.producerId) || left.source.localeCompare(right.source))
    if (JSON.stringify(declaredImplementations) !== JSON.stringify(registryImplementations)) {
      errors.push('producer registry and source implementations must bidirectionally exact match')
    }
    const inventorySourceIds = (inventory.consumers ?? []).filter((item) => item.consumerId.startsWith('source:')).map((item) => item.consumerId.slice('source:'.length)).sort()
    if (JSON.stringify(inventorySourceIds) !== JSON.stringify(declarations.consumers.map((item) => item.id).sort())) {
      errors.push('fixture source declarations and generated inventory must bidirectionally exact match')
    }
    const inventoryById = new Map((inventory.consumers ?? []).map((item) => [item.consumerId, item]))
    for (const declaration of declarations.consumers) {
      if (declaration.profileId !== 'matrix' && !profileIds.has(declaration.profileId)) {
        errors.push(`fixture source ${declaration.source} references unknown profile ${declaration.profileId}`)
      }
      const entry = inventoryById.get(`source:${declaration.id}`)
      if (!entry) continue
      const expectedProfiles = declaration.profileId === 'matrix'
        ? entry.profileIds
        : [declaration.profileId]
      if (JSON.stringify(entry.profileIds) !== JSON.stringify(expectedProfiles)
        || entry.profileId !== (expectedProfiles.length === 1 ? expectedProfiles[0] : null)) {
        errors.push(`fixture source ${declaration.id} and generated inventory profile binding differ`)
      }
      if (expectedProfiles.every((profileId) => profileIds.has(profileId))) {
        const expectedCapabilities = [...new Set(expectedProfiles.flatMap((profileId) => expandFixtureProfile(profileId, catalogs).capabilities))].sort()
        if (JSON.stringify(entry.requiredCapabilities) !== JSON.stringify(expectedCapabilities)) {
          errors.push(`fixture source ${declaration.id} and generated inventory capabilities differ`)
        }
      }
      const content = fs.readFileSync(path.join(repositoryRoot, declaration.source), 'utf8')
      validateInventoryTruthfulness(entry, content, errors)
    }
    if (JSON.stringify(inventory.producerImplementations ?? []) !== JSON.stringify(declaredImplementations)) {
      errors.push('producer implementation inventory is stale')
    }
  } catch (error) { errors.push(error.message) }
  if (validateRepositoryAuthority) errors.push(...validateFixtureAuthoritySources({ repositoryRoot }))
  return errors
}

function parseCliArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      options._.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq >= 0) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const key = arg.slice(2)
        const next = argv[index + 1]
        if (next != null && !next.startsWith('--')) {
          options[key] = next
          index += 1
        } else {
          options[key] = true
        }
      }
    } else {
      options._.push(arg)
    }
  }
  return options
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv)
  const command = options._[0] ?? 'validate'
  if (command === 'validate') {
    const errors = validateFixtureCatalogs()
    if (errors.length) {
      process.stderr.write(`${errors.join('\n')}\n`)
      process.exit(1)
    }
    process.stdout.write('fixture capability catalog valid\n')
    return
  }
  if (command === 'resolve') {
    const profileId = options.profile ?? options['profile-id']
    const profileSource = options.source ?? options['profile-source']
    const executionClass = options['execution-class'] ?? null
    const out = options.out ?? options.output ?? null
    const kind = options.kind ?? 'planned-profile'
    const sealed = profileSource === 'matrix'
      ? {
        fixtureProfileId: options['sealed-profile-id'] ?? profileId,
        fixtureCatalogDigest: options['sealed-catalog-digest'],
        expandedCapabilityDigest: options['sealed-capability-digest'],
        executionClass: options['sealed-execution-class'] ?? executionClass
      }
      : null
    const plan = resolveFixtureProfile({
      profileId,
      profileSource,
      executionClass,
      sealed,
      allowFreeProfileEnv: profileSource === 'dev-cli',
      freeProfileEnv: profileSource === 'dev-cli' ? '' : process.env.FSUSBLOG_FIXTURE_PROFILE
    })
    if (out) writeFixtureProfileReceipt(out, plan, { kind })
    process.stdout.write(`${JSON.stringify(plan)}\n`)
    return
  }
  if (command === 'digest') {
    const catalogs = readFixtureCatalogs()
    const profileId = options.profile ?? options['profile-id'] ?? 'none'
    const plan = planFixtureMutation(profileId, catalogs)
    process.stdout.write(`${JSON.stringify({
      catalogDigest: fixtureCatalogDigest(catalogs),
      expandedCapabilityDigest: expandedCapabilityDigest(plan.capabilities),
      profileId,
      capabilities: plan.capabilities,
      producers: plan.producers,
      mutationPolicy: plan.mutationPolicy
    })}\n`)
    return
  }
  if (command === 'receipt-digest') {
    const file = options.file ?? options._[1]
    if (!file) throw new Error('receipt-digest requires --file')
    process.stdout.write(`${fixtureReceiptDigestFromFile(file)}\n`)
    return
  }
  if (command === 'write-receipt') {
    const planFile = options.plan ?? options['plan-file']
    const out = options.out ?? options.output
    if (!planFile || !out) throw new Error('write-receipt requires --plan and --out')
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    const fixtureReceiptPath = options['fixture-receipt'] ?? null
    const fixtureReceiptDigest = fixtureReceiptPath
      ? fixtureReceiptDigestFromFile(fixtureReceiptPath)
      : (options['fixture-receipt-digest'] ?? null)
    const receipt = writeFixtureProfileReceipt(out, plan, {
      kind: options.kind ?? 'environment-ready',
      fixtureReceiptPath,
      fixtureReceiptDigest
    })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    return
  }
  throw new Error(`unknown fixture-catalog command: ${command}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exit(1)
  }
}
