import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BehaviorId,
  digestCatalog,
  digestDocumentOwnership,
  loadCatalog,
  loadSchema,
  validateBehaviorReferences,
  validateSchemaContract
} from '../../tools/contracts/behavior-contract-catalog.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const generator = path.join(root, 'tools/contracts/generate-behavior-contract-catalog.mjs')
const catalogPath = path.join(root, 'config/contracts/behavior-contracts.json')

const reject = (name, mutate) => test(name, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-behavior-contract-'))
  try {
    const candidate = JSON.parse(readFileSync(catalogPath, 'utf8')); mutate(candidate)
    const target = path.join(directory, 'behavior-contracts.json'); writeFileSync(target, `${JSON.stringify(candidate)}\n`)
    const result = spawnSync('node', [generator, '--check', '--catalog', target], { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('catalog generation and deterministic digest are in sync', () => {
  execFileSync('node', ['tools/contracts/check-behavior-contract-catalog.mjs'], { cwd: root, stdio: 'inherit' })
  const first = spawnSync('node', [generator, '--check'], { cwd: root, encoding: 'utf8' })
  const second = spawnSync('node', [generator, '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(first.stdout, second.stdout)
})

reject('rejects two active behaviors with the same ID', (catalog) => { catalog.contracts[1].id = catalog.contracts[0].id })
reject('rejects unknown catalog fields', (catalog) => { catalog.contracts[0].temporary = true })
reject('rejects an active behavior without an extractor', (catalog) => { catalog.contracts[0].factExtractorId = '' })
reject('rejects required documentation without test kinds', (catalog) => { catalog.contracts[0].requiredTestKinds = [] })
reject('rejects required documentation without a current document binding', (catalog) => { catalog.contracts[0].documents = [] })
reject('rejects a retired behavior referencing a current document', (catalog) => { catalog.contracts[0].status = 'retired' })
reject('rejects migration-only behavior without exactly one migration proof kind', (catalog) => {
  Object.assign(catalog.contracts[0], { status: 'migration-only', releaseQualification: false, requiredTestKinds: [], documentationPolicy: 'not-public', documents: [] })
})
reject('rejects issue-number behavior IDs', (catalog) => { catalog.contracts[0].id = 'issue-1234-coverage' })
reject('rejects unknown coverage IDs', (catalog) => { catalog.contracts[0].coverageIds = ['missing-coverage'] })
reject('rejects path-based implementationOwners residue in catalog', (catalog) => {
  catalog.contracts[0].implementationOwners = ['tools/test.sh']
  delete catalog.contracts[0].allowedImplementationOwnerRoles
})
reject('rejects roles on one-owner behaviors', (catalog) => {
  catalog.contracts[0].allowedImplementationOwnerRoles = ['primary']
})
reject('rejects many-owner behaviors without at least two roles', (catalog) => {
  catalog.contracts[0].implementationOwnerCardinality = 'many'
  catalog.contracts[0].allowedImplementationOwnerRoles = ['only']
})

reject('rejects a protocol document authority missing from lifecycle ownership', (catalog) => {
  const contract = catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract')
  contract.documentAuthorities[0].owner = 'release'
})
reject('rejects a manual protocol document inventory omission', (catalog) => {
  const contract = catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract')
  contract.documentAuthorities.pop()
})
reject('rejects duplicate protocol document owners', (catalog) => {
  const contract = catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract')
  contract.documentAuthorities.push(structuredClone(contract.documentAuthorities[0]))
})
reject('rejects error authority overlap with the protocol domain', (catalog) => {
  const contract = catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract')
  contract.documentAuthorities.find((entry) => entry.path === 'docs/api/schemas-and-errors.md')
    .sectionIds.push('api.domain-errors-active')
})
reject('rejects unknown cross-domain error owner references', (catalog) => {
  const contract = catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract')
  contract.crossDomainReferences[0].behaviorId = 'missing-error-owner'
})

test('protocol release and deployment domains have exact document and extractor ownership', () => {
  const catalog = loadCatalog()
  for (const domain of ['protocol', 'release', 'deployment']) assert.ok(catalog.domains.includes(domain))
  const expected = new Map([
    ['binary-api-aeds-contract', 'openapi-aeds-fact-extractor'],
    ['release-final-aggregate-contract', 'test-matrix-fact-extractor'],
    ['deployment-blue-green-runtime-role', 'test-matrix-fact-extractor']
  ])
  for (const [behaviorId, extractorId] of expected) {
    const contract = catalog.contracts.find((entry) => entry.id === behaviorId)
    assert.equal(contract.factExtractorId, extractorId)
    assert.deepEqual(contract.documentAuthorities.map((entry) => entry.path).sort(), [...contract.documents].sort())
    assert.ok(contract.documentAuthorities.every((entry) => entry.proofIds.length > 0))
  }
  const protocol = catalog.contracts.find((entry) => entry.id === 'binary-api-aeds-contract')
  assert.deepEqual(
    protocol.documentAuthorities.find((entry) => entry.path === 'docs/api/schemas-and-errors.md').sectionIds,
    ['api.error-authority-reference', 'api.operation-count']
  )
  assert.deepEqual(protocol.crossDomainReferences.map((entry) => entry.behaviorId), ['configuration-error-security-policy'])
  const lifecycle = JSON.parse(readFileSync(path.join(root, 'config/development/document-lifecycle.json'), 'utf8'))
  const digest = digestDocumentOwnership(catalog, lifecycle)
  assert.match(digest, /^[a-f0-9]{64}$/u)
  const moved = structuredClone(lifecycle)
  moved.pathMigrations[0].to = 'docs/api.md'
  assert.notEqual(digestDocumentOwnership(catalog, moved), digest)
  const ownershipDrift = structuredClone(catalog)
  ownershipDrift.contracts.find((entry) => entry.id === 'binary-api-aeds-contract').documentAuthorities[0].anchor = 'protocol.changed'
  assert.notEqual(digestDocumentOwnership(ownershipDrift, lifecycle), digest)
})

test('schema and loader enums cannot drift independently', () => {
  const schema = structuredClone(loadSchema())
  schema.$defs.contract.properties.status.enum.push('compat-active')
  assert.throws(() => validateSchemaContract(schema), /status enum drifted/u)
})

test('schema rejects path-based implementationOwners field', () => {
  const schema = structuredClone(loadSchema())
  schema.$defs.contract.properties.implementationOwners = { type: 'array' }
  assert.throws(() => validateSchemaContract(schema), /path-based implementationOwners/u)
})

test('rejects coverage registry behavior-field copies', () => {
  const registry = JSON.parse(readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'))
  registry.entries[0].requiredTestKinds = ['positive']
  const target = path.join(root, 'tests/coverage-registry.json'); const original = readFileSync(target, 'utf8')
  try { writeFileSync(target, `${JSON.stringify(registry)}\n`); const result = spawnSync('node', ['tools/contracts/check-behavior-contract-catalog.mjs'], { cwd: root, encoding: 'utf8' }); assert.notEqual(result.status, 0) } finally { writeFileSync(target, original) }
})

test('rejects a free-string behavior reference outside the catalog', () => {
  const target = path.join(root, 'tests/fixtures/behavior-free-string-reference.json')
  try {
    writeFileSync(target, '{"behaviorId":"unregistered-free-string"}\n')
    const result = spawnSync('node', ['tools/contracts/check-behavior-contract-catalog.mjs'], { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'free-string behavior reference unexpectedly passed')
  } finally { rmSync(target, { force: true }) }
})

test('rejects every unregistered ID in a behaviorIds array', () => {
  const target = path.join(root, 'tests/fixtures/behavior-free-string-reference.json')
  try {
    writeFileSync(target, '{"behaviorIds":["code-intent-governance","unregistered-second-id"]}\n')
    assert.throws(() => validateBehaviorReferences(loadCatalog()), /unregistered-second-id/u)
  } finally { rmSync(target, { force: true }) }
})

test('rejects a second behavior catalog authority', () => {
  const target = path.join(root, 'config/contracts/behavior-contract-registry.json')
  try {
    writeFileSync(target, '{"schema":"fsusblog.behavior-contract-catalog.v1","contracts":[]}\n')
    assert.throws(() => validateBehaviorReferences(loadCatalog()), /second behavior catalog/u)
  } finally { rmSync(target, { force: true }) }
})

test('rejects an untyped behavior reference and compatibility aliases', () => {
  const target = path.join(root, 'tests/fixtures/behavior-free-string-reference.mjs')
  try {
    writeFileSync(target, 'export const reference = { behaviorId: runtimeValue }\n')
    assert.throws(() => validateBehaviorReferences(loadCatalog()), /untyped or free-string/u)
    writeFileSync(target, 'export const reference = { behaviorId: BehaviorId(runtimeValue) }\n')
    assert.doesNotThrow(() => validateBehaviorReferences(loadCatalog()))
    writeFileSync(target, 'export const legacy_behavior_catalog = {}\n')
    assert.throws(() => validateBehaviorReferences(loadCatalog()), /compatibility surface/u)
  } finally { rmSync(target, { force: true }) }
})

test('canonical BehaviorId validates catalog membership', () => {
  assert.equal(BehaviorId('code-intent-governance'), 'code-intent-governance')
  assert.throws(() => BehaviorId('unregistered-free-string'), /unregistered behavior ID/u)
  assert.throws(() => BehaviorId(null), /unregistered behavior ID/u)
})

test('scanner requires typed dynamic behavior arrays and replay projections', () => {
  const target = path.join(root, 'tests/fixtures/behavior-free-string-reference.mjs')
  try {
    writeFileSync(target, 'const behaviorId = BehaviorId("code-intent-governance")\nconst node = (behaviorIds = [BehaviorId(behaviorId)]) => ({ behaviorIds })\nconst reorder = ({ behaviorIds }) => ({ behaviorIds: [...behaviorIds].reverse().map(BehaviorId) })\nexport { node, reorder }\n')
    assert.doesNotThrow(() => validateBehaviorReferences(loadCatalog()))

    writeFileSync(target, 'const behaviorId = "code-intent-governance"\nexport const node = (behaviorIds = [behaviorId]) => ({ behaviorIds })\n')
    assert.throws(() => validateBehaviorReferences(loadCatalog()), /untyped or free-string/u)

    writeFileSync(target, 'export const reorder = ({ behaviorIds }) => ({ behaviorIds: [...behaviorIds].reverse() })\n')
    assert.throws(() => validateBehaviorReferences(loadCatalog()), /untyped or free-string/u)
  } finally { rmSync(target, { force: true }) }
})

test('rejects retired behavior references from current documentation', () => {
  const target = path.join(root, 'docs/development/behavior-reference-fixture.md')
  const catalog = loadCatalog()
  Object.assign(catalog.contracts[0], {
    status: 'retired',
    releaseQualification: false,
    requiredTestKinds: [],
    documentationPolicy: 'not-public',
    documents: []
  })
  try {
    writeFileSync(target, '# Fixture\n\nbehaviorId: `test-asset-audit-reconciliation`\n')
    assert.throws(() => validateBehaviorReferences(catalog), /current documentation references retired behavior/u)
  } finally { rmSync(target, { force: true }) }
})

test('generated TypeScript and C# projections bind the canonical digest and reject drift', () => {
  const digest = digestCatalog(loadCatalog())
  const outputs = [
    path.join(root, 'src/frontend/src/contracts/behaviorContractCatalog.ts'),
    path.join(root, 'src/shared/Contracts/Governance/BehaviorContractCatalog.g.cs')
  ]
  for (const target of outputs) {
    const original = readFileSync(target, 'utf8')
    assert.match(original, new RegExp(digest, 'u'))
    try {
      writeFileSync(target, original.replace(digest, '0'.repeat(64)))
      const result = spawnSync('node', [generator, '--check'], { cwd: root, encoding: 'utf8' })
      assert.notEqual(result.status, 0, `${path.relative(root, target)} digest drift unexpectedly passed`)
    } finally { writeFileSync(target, original) }
  }
})
