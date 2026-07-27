import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applySealedFixtureProfileEnvironment,
  expandFixtureProfile,
  fixtureCatalogDigest,
  fixtureCatalogFiles,
  observeFixtureConsumerSource,
  planFixtureMutation,
  resolveFixtureProfile,
  scanFixtureSourceDeclarations,
  sealMatrixFixtureProfile,
  validateFixtureAuthoritySources,
  validateFixtureCatalogs,
  validateNoneFixtureTier,
  writeFixtureProfileReceipt
} from '../../tools/testing/fixture-catalog.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const names = ['capability', 'profile', 'producer', 'inventory']

function fixture(change) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fixture-catalog-'))
  const files = Object.fromEntries(names.map((name) => [name, path.join(directory, `${name}.json`)]))
  const data = Object.fromEntries(names.map((name) => [name, JSON.parse(readFileSync(fixtureCatalogFiles[name], 'utf8'))]))
  change(data)
  for (const name of names) writeFileSync(files[name], JSON.stringify(data[name]))
  return { directory, files }
}

function rejects(change, pattern) {
  const sample = fixture(change)
  try { assert.match(validateFixtureCatalogs({ files: sample.files, validateRepositoryAuthority: false }).join('\n'), pattern) } finally { rmSync(sample.directory, { recursive: true, force: true }) }
}

test('fixture catalogs are valid and profiles expand deterministically', () => {
  assert.deepEqual(validateFixtureCatalogs(), [])
  assert.deepEqual(expandFixtureProfile('scale-xs').capabilities, ['public.article.published', 'scale.article-comment.xs'])
  assert.deepEqual(expandFixtureProfile('none').capabilities, [])
})

test('fixture catalog rejects duplicate API and DB ownership', () => rejects((data) => {
  const producer = data.producer.producers.find((item) => item.id === 'scale-data')
  producer.provides.push('public.article.published')
  producer.provides.sort()
}, /public\.article\.published must have exactly owner public-content|mixed producer strategies/))

test('fixture catalog rejects auth ownership of a ban capability', () => rejects((data) => {
  const capability = data.capability.capabilities.find((item) => item.id === 'security.subject.banned')
  capability.ownerProducerId = 'auth-session'
  const producer = data.producer.producers.find((item) => item.id === 'auth-session')
  producer.provides.push('security.subject.banned')
  producer.provides.sort()
}, /security capability security\.subject\.banned must be owned by security-state/))

test('fixture catalog rejects unknown profile capability and state domain', () => {
  rejects((data) => data.profile.profiles.find((item) => item.id === 'auth-basic').capabilities.push('unknown.capability'), /unknown capability/)
  rejects((data) => {
    const item = data.capability.capabilities.find((candidate) => candidate.id === 'auth.user.active')
    item.stateDomains.push('postgres.everything')
    item.stateDomains.sort()
  }, /unknown id postgres\.everything/)
})

test('fixture catalog rejects unregistered producer output and inventory none lie', () => {
  rejects((data) => data.producer.producers.find((item) => item.id === 'auth-session').provides.push('unknown.capability'), /unknown id unknown\.capability/)
  rejects((data) => {
    const entry = data.inventory.consumers.find((item) => item.requiredCapabilities.length)
    entry.profileId = 'none'
    entry.profileIds = ['none']
  }, /cannot use none profile/)
})

test('fixture catalog rejects dependency cycles, destructive none, and broad acceptance data', () => {
  rejects((data) => {
    const item = data.capability.capabilities.find((candidate) => candidate.id === 'auth.user.active')
    item.dependsOn.push('auth.user.mfa-enabled')
  }, /dependency cycle/)
  rejects((data) => data.profile.profiles.find((item) => item.id === 'none').isDestructive = true, /none profile must declare/)
  rejects((data) => {
    const item = data.capability.capabilities.find((candidate) => candidate.id === 'public.article.published')
    item.id = 'acceptance.all-data'
  }, /broad fixture capability is forbidden/)
})

test('generated inventory and profile documentation have no drift', () => {
  const result = spawnSync(process.execPath, ['tools/testing/generate-fixture-catalog-artifacts.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('matrix consumers cannot omit fixture profile bindings', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fixture-matrix-'))
  try {
    const source = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')
    const missing = source.replace(
      '      fixtureProfile: acceptance-representative\n      fixtureCapabilities: [auth.admin.full-permission, auth.user.active, public.article.published, session.single-device]\n',
      ''
    )
    const file = path.join(directory, 'matrix.yml')
    writeFileSync(file, missing)
    assert.match(validateFixtureCatalogs({ matrixFile: file, validateRepositoryAuthority: false }).join('\n'), /matrix data consumer bootstrap must bind fixtureProfile and fixtureCapabilities/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('producer registry and implementation declarations are bidirectionally exact', () => {
  rejects((data) => data.producer.producers.find((item) => item.id === 'scale-data').implementationPaths.pop(), /producer registry and source implementations must bidirectionally exact match/)
  const source = 'tools/data-scale/cleanup.sh'
  const original = readFileSync(path.join(root, source), 'utf8')
  assert.throws(
    () => scanFixtureSourceDeclarations({ sourceOverrides: new Map([[source, original.replace(/^# fixture-catalog: producer scale-data\n/mu, '')]]) }),
    /has no declaration/
  )
  const hiddenSource = 'tests/frontend/fixtures/hidden-fixture-owner.mjs'
  assert.equal(
    scanFixtureSourceDeclarations({
      sourceOverrides: new Map([[hiddenSource, '// fixture-catalog: producer auth-session\n']])
    }).producers.some((item) => item.source === hiddenSource),
    true
  )
})

test('repository authority gate rejects aliases, second profile lists, and free-string capabilities', () => {
  const source = 'tools/bootstrap-acceptance-env.sh'
  const original = readFileSync(path.join(root, source), 'utf8')
  const violations = validateFixtureAuthoritySources({
    sourceOverrides: new Map([[source, `${original}\nfixtureProfileAlias=legacy\nfixtureProfiles=['auth-basic']\nfixtureCapabilities=['auth.user.active']\n`]])
  }).join('\n')
  assert.match(violations, /fixture profile alias is forbidden/)
  assert.match(violations, /second fixture profile list is forbidden/)
  assert.match(violations, /free-string fixture capability list is forbidden/)
})

test('catalog field shape and source inventory bindings fail closed', () => {
  rejects((data) => delete data.capability.capabilities[0].resetContractId, /must declare a stable reset contract/)
  rejects((data) => {
    data.profile.profiles.find((item) => item.id === 'auth-basic').isDestructive = 'no'
  }, /mutation and namespace flags must be boolean/)
  rejects((data) => {
    data.producer.producers.find((item) => item.id === 'auth-session').receiptPostconditions.pop()
  }, /receiptPostconditions must exactly match/)
  rejects((data) => {
    const consumer = data.inventory.consumers.find((item) => item.consumerId === 'source:auth-smoke-fixture')
    consumer.profileId = 'acceptance-representative'
    consumer.profileIds = ['acceptance-representative']
  }, /source auth-smoke-fixture and generated inventory profile binding differ/)
})

test('none profile rejects hidden fixture preparation and security reset', () => {
  const tier = {
    id: 'none-negative',
    command: 'tools/test/lanes/none-negative.sh',
    fixtureProfile: 'none'
  }
  const sourceOverrides = new Map([[
    'tools/test/lanes/none-negative.sh',
    'ResetSecurityRuntimeState "hidden reset"\nPreparePublicFixturesOnce\n'
  ]])
  assert.deepEqual(validateNoneFixtureTier(tier, { sourceOverrides }), [
    'matrix tier none-negative none profile cannot execute security state reset',
    'matrix tier none-negative none profile cannot execute business fixture preparation'
  ])
})

test('inventory records truthful Playwright env reuse and dual seed fallback', () => {
  const discover = readFileSync(path.join(root, 'tests/frontend/fixtures/discover-playwright-fixtures.mjs'), 'utf8')
  const observed = observeFixtureConsumerSource('tests/frontend/fixtures/discover-playwright-fixtures.mjs', discover)
  assert.match(observed, /reuses public content already present in the running env/u)
  assert.match(observed, /admin API public seed falls back to direct-DB seed/u)
  assert.doesNotMatch(observed, /no catalog alias or undeclared capability fallback/u)

  const inventory = JSON.parse(readFileSync(fixtureCatalogFiles.inventory, 'utf8'))
  const playwright = inventory.consumers.find((item) => item.consumerId === 'source:playwright-fixture-discovery')
  assert.ok(playwright)
  assert.equal(playwright.currentFallback, observed)
  assert.doesNotMatch(playwright.currentFallback, /provided by (?:the )?environment by default|existing data is enough|默认由环境提供|已有数据即可/iu)

  const sessions = inventory.consumers.find((item) => item.consumerId === 'source:auth-session-runtime')
  assert.ok(sessions)
  assert.match(sessions.currentFallback, /persists auth fixture files when FSUSBLOG_PERSIST_AUTH_FIXTURES/u)
})

test('inventory rejects hardcoded no-fallback while source reuses env data', () => rejects((data) => {
  const consumer = data.inventory.consumers.find((item) => item.consumerId === 'source:playwright-fixture-discovery')
  consumer.currentFallback = 'no catalog alias or undeclared capability fallback'
}, /hardcodes no-fallback while source reuses env data|currentFallback is stale or untruthful/))

test('dev-cli and matrix resolve share digests and none is zero-mutation', () => {
  const none = resolveFixtureProfile({ profileId: 'none', profileSource: 'dev-cli', freeProfileEnv: '' })
  assert.equal(none.profileId, 'none')
  assert.equal(none.mutationPolicy, 'zero-mutation')
  assert.deepEqual(none.capabilities, [])
  assert.deepEqual(none.producers, [])
  assert.equal(none.requiresAuthFixtures, false)
  assert.equal(none.requiresLocalAuthBypass, false)
  assert.equal(none.requiresSecurityReset, false)
  assert.equal(none.catalogDigest, fixtureCatalogDigest())

  const demo = resolveFixtureProfile({ profileId: 'demo-public', profileSource: 'dev-cli', freeProfileEnv: '' })
  assert.equal(demo.requiresDemoSeed, true)
  assert.equal(demo.requiresLocalAuthBypass, false)

  const acceptance = planFixtureMutation('acceptance-representative')
  assert.equal(acceptance.requiresAuthFixtures, true)
  assert.equal(acceptance.requiresPublicFixtures, true)
  assert.equal(acceptance.requiresSecurityReset, false)

  const sealed = sealMatrixFixtureProfile({
    id: 'bootstrap',
    fixtureProfile: 'acceptance-representative',
    resourceClass: 'database',
    requiresBootstrap: 'full',
    selfBootstraps: true
  })
  assert.equal(sealed.profileSource, 'matrix')
  assert.equal(sealed.profileId, 'acceptance-representative')
  const env = applySealedFixtureProfileEnvironment({}, sealed)
  assert.equal(env.FSUSBLOG_SEALED_FIXTURE_PROFILE_ID, 'acceptance-representative')
  assert.equal(env.FSUSBLOG_FIXTURE_PROFILE, '')
  assert.equal(env.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST, sealed.catalogDigest)
})

test('matrix resolve fail-closes free profile override and digest drift', () => {
  assert.throws(
    () => resolveFixtureProfile({
      profileId: 'none',
      profileSource: 'matrix',
      freeProfileEnv: 'demo-public',
      sealed: {
        fixtureProfileId: 'none',
        fixtureCatalogDigest: fixtureCatalogDigest(),
        expandedCapabilityDigest: resolveFixtureProfile({ profileId: 'none', profileSource: 'dev-cli', freeProfileEnv: '' }).expandedCapabilityDigest,
        executionClass: 'runtime'
      }
    }),
    /cannot be overridden by FSUSBLOG_FIXTURE_PROFILE/
  )
  assert.throws(
    () => resolveFixtureProfile({
      profileId: 'unknown-profile',
      profileSource: 'dev-cli',
      freeProfileEnv: ''
    }),
    /unknown fixture profile/
  )
  const live = resolveFixtureProfile({ profileId: 'public-minimal', profileSource: 'dev-cli', freeProfileEnv: '' })
  assert.throws(
    () => resolveFixtureProfile({
      profileId: 'public-minimal',
      profileSource: 'matrix',
      freeProfileEnv: '',
      sealed: {
        fixtureProfileId: 'public-minimal',
        fixtureCatalogDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        expandedCapabilityDigest: live.expandedCapabilityDigest,
        executionClass: live.executionClass
      }
    }),
    /catalog digest drifted/
  )
  assert.throws(
    () => resolveFixtureProfile({
      profileId: 'public-minimal',
      profileSource: 'matrix',
      freeProfileEnv: '',
      sealed: {
        fixtureProfileId: 'public-minimal',
        fixtureCatalogDigest: live.catalogDigest,
        expandedCapabilityDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        executionClass: live.executionClass
      }
    }),
    /capability digest drifted/
  )
})

test('planned and environment-ready receipts record profile identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fixture-receipt-'))
  try {
    const plan = resolveFixtureProfile({ profileId: 'none', profileSource: 'dev-cli', freeProfileEnv: '' })
    const planned = path.join(directory, 'planned-profile.json')
    const fixtureReceipt = path.join(directory, 'fixture-receipt.json')
    const ready = path.join(directory, 'environment-ready.json')
    writeFixtureProfileReceipt(planned, plan, { kind: 'planned-profile' })
    writeFixtureProfileReceipt(fixtureReceipt, plan, { kind: 'fixture-receipt', extra: { zeroData: true, mutations: [] } })
    writeFixtureProfileReceipt(ready, JSON.parse(readFileSync(planned, 'utf8')), {
      kind: 'environment-ready',
      fixtureReceiptPath: fixtureReceipt,
      fixtureReceiptDigest: `sha256:${Buffer.from('x').toString('hex').padStart(64, '0')}`
    })
    const readyJson = JSON.parse(readFileSync(ready, 'utf8'))
    assert.equal(readyJson.profileId, 'none')
    assert.equal(readyJson.profileSource, 'dev-cli')
    assert.equal(readyJson.mutationPolicy, 'zero-mutation')
    assert.ok(readyJson.catalogDigest.startsWith('sha256:'))
    assert.deepEqual(readyJson.capabilityIds, [])
    assert.deepEqual(readyJson.producerIds, [])
    assert.equal(readyJson.fixtureReceiptPath, fixtureReceipt)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('bootstrap and start entrypoints no longer hide default fixture injection', () => {
  const start = readFileSync(path.join(root, 'tools/dev/start.sh'), 'utf8')
  const bootstrap = readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  assert.doesNotMatch(start, /--seed-demo|SEED_DEMO/u)
  assert.match(start, /FIXTURE_PROFILE="none"/u)
  assert.match(start, /--fixture-profile/u)
  assert.doesNotMatch(start, /preparing persistent local auth fixtures/u)
  assert.match(bootstrap, /ResolveFixtureProfilePlan/u)
  assert.match(bootstrap, /InvokeFixtureOrchestrator/u)
  assert.doesNotMatch(bootstrap, /RESET_SECURITY_TEST_STATE="\$\{FSUSBLOG_RESET_SECURITY_TEST_STATE:-1\}"/u)
  assert.doesNotMatch(bootstrap, /RESET_SECURITY_TEST_STATE=/u)
  assert.match(bootstrap, /FIXTURE_REQUIRES_SECURITY_RESET/u)
  // Unconditional PrepareFixtures() call must not remain in Main order after WaitForPowReady.
  const main = bootstrap.slice(bootstrap.indexOf('Main()'), bootstrap.indexOf('if [[ "${FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0}"'))
  assert.doesNotMatch(main, /^\s*PrepareFixtures\s*$/mu)
  assert.match(main, /InvokeFixtureOrchestrator/u)
})

test('generated profile document drift is rejected by the real check command', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fixture-doc-drift-'))
  try {
    const document = path.join(directory, 'fixture-capability-catalog.md')
    writeFileSync(document, `${readFileSync(path.join(root, 'docs/testing/fixture-capability-catalog.md'), 'utf8')}\nmanual profile row\n`)
    const result = spawnSync(process.execPath, ['tools/testing/generate-fixture-catalog-artifacts.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FSUSBLOG_FIXTURE_DOCUMENT_FILE: document }
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /fixture catalog generated artifacts drift/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('docs profile table matches catalog profile set exactly', () => {
  const catalogs = {
    profile: JSON.parse(readFileSync(fixtureCatalogFiles.profile, 'utf8'))
  }
  const document = readFileSync(path.join(root, 'docs/testing/fixture-capability-catalog.md'), 'utf8')
  const catalogIds = catalogs.profile.profiles.map((item) => item.id).sort()
  const docIds = [...document.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gmu)].map((match) => match[1]).sort()
  assert.deepEqual(docIds, catalogIds)
})
