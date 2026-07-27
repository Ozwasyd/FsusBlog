import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
    loadRegistry,
    loadRegistrySchema,
    loadReceiptSchema,
    registrySchemaId,
    receiptSchemaId,
    root,
    validateOwnershipAgainstBehaviorCatalog,
    validateRegistry,
    validateRegistrySchemaContract
} from '../../tools/fact-extractors/registry.mjs'
import {
    buildReceipt,
    computeSemanticDigest,
    semanticDigestFromReceipt,
    validateObservations,
    validateReceipt,
    validateReceiptSchemaContract
} from '../../tools/fact-extractors/receipt.mjs'
import {
    computeExecutionCacheKey,
    runExtractor,
    assertDeterministicSemanticDigest
} from '../../tools/fact-extractors/runner.mjs'
import { readFactObservationReceipt, assertConsumerDoesNotImportExtractors } from '../../tools/fact-extractors/reader.mjs'
import {
    scanExtractorSources,
    scanRepositoryFactExtractorGovernance,
    assertExtractorDependencyAcyclic
} from '../../tools/fact-extractors/governance.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { loadCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'

const checker = path.join(root, 'tools/fact-extractors/check-behavior-fact-extractors.mjs')

function fixtureRoot()
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fact-extractors-'))
    for (const relative of [
        'config/contracts/behavior-contracts.json',
        'config/contracts/behavior-fact-extractors.json',
        'config/schemas/behavior-contract-catalog.schema.json',
        'config/schemas/behavior-fact-extractor-registry.schema.json',
        'config/schemas/fact-observation-receipt.schema.json',
        'tests/coverage-registry.json',
        'tests/governance/code-intent-registry.json',
        'config/development/document-lifecycle.json',
        'tests/matrix.yml'
    ])
    {
        const target = path.join(directory, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(path.join(root, relative), target)
    }
    // Copy framework + seeds so entrypoints resolve inside the fixture repo.
    for (const relative of [
        'tools/fact-extractors/lib/canonicalize.mjs',
        'tools/fact-extractors/lib/seed-catalog.mjs',
        'tools/fact-extractors/identity.mjs',
        'tools/fact-extractors/registry.mjs',
        'tools/fact-extractors/receipt.mjs',
        'tools/fact-extractors/runner.mjs',
        'tools/fact-extractors/reader.mjs',
        'tools/fact-extractors/governance.mjs',
        'tools/fact-extractors/check-behavior-fact-extractors.mjs',
        'tools/fact-extractors/seeds/test-asset-audit-seed.mjs',
        'tools/fact-extractors/seeds/code-intent-seed.mjs',
        'tools/fact-extractors/seeds/document-lifecycle-seed.mjs',
        'tools/fact-extractors/seeds/test-matrix-seed.mjs',
        'tools/contracts/behavior-contract-catalog.mjs'
    ])
    {
        const target = path.join(directory, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(path.join(root, relative), target)
    }
    // Git identity for source commit / worktree fingerprint.
    spawnSync('git', ['init'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['add', '-A'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: directory, encoding: 'utf8' })
    return directory
}

function write(repositoryRoot, relative, content)
{
    const target = path.join(repositoryRoot, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
    return relative
}

function loadFixtureRegistry(repositoryRoot)
{
    return JSON.parse(readFileSync(path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json'), 'utf8'))
}

function baseReceiptFields(overrides = {})
{
    return {
        extractorId: 'test-asset-audit-fact-extractor',
        behaviorIds: ['test-asset-audit-reconciliation'],
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64),
        buildIdentity: null,
        extractorDigest: 'c'.repeat(64),
        registryDigest: 'd'.repeat(64),
        consumedInputDigests: [{ path: 'tests/coverage-registry.json', digest: 'e'.repeat(64) }],
        observations: { coverageEntryCount: 1, coverageEntryIds: ['x'], catalogSchema: 'fsusblog.coverage-registry.v1' },
        status: 'ok',
        failureReasons: [],
        ...overrides
    }
}

test('schemas are fail-closed and forbid shell/warning/partial surfaces', () =>
{
    validateRegistrySchemaContract(loadRegistrySchema())
    validateReceiptSchemaContract(loadReceiptSchema())
    assert.equal(loadRegistrySchema().$id, registrySchemaId)
    assert.equal(loadReceiptSchema().$id, receiptSchemaId)
    const schema = structuredClone(loadRegistrySchema())
    schema.$defs.extractor.properties.kind.enum.push('shell-command')
    assert.throws(() => validateRegistrySchemaContract(schema), /kind enum drifted|forbidden kind/u)
})

test('repository registry owns each active behavior exactly once', () =>
{
    const registry = loadRegistry()
    const result = validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root)
    assert.match(result.digest, /^[a-f0-9]{64}$/u)
    assert.equal(result.behaviorOwners.size, 4)
    const check = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr || check.stdout)
    assert.match(check.stdout, /registry, ownership, receipt schema/u)
    const governance = scanRepositoryFactExtractorGovernance(root)
    assert.equal(governance.status, 'ok', governance.errors.join('\n'))
    assertExtractorDependencyAcyclic(registry)
})

test('seed extractors produce source-bound receipts with stable semantic digests', async () =>
{
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fact-cache-'))
    try
    {
        const first = await runExtractor({
            extractorId: 'document-lifecycle-fact-extractor',
            repositoryRoot: root,
            useCache: true,
            cacheRoot
        })
        const second = await runExtractor({
            extractorId: 'document-lifecycle-fact-extractor',
            repositoryRoot: root,
            useCache: true,
            cacheRoot
        })
        assert.equal(first.receipt.status, 'ok')
        assert.equal(second.cacheHit, true)
        assertDeterministicSemanticDigest(first.receipt, second.receipt)
        const view = readFactObservationReceipt(first.receipt)
        assert.equal(view.extractorId, 'document-lifecycle-fact-extractor')
        assert.ok(view.observations.documentCount > 0)
        assert.match(view.contentDigest, /^[a-f0-9]{64}$/u)
        assert.match(view.worktreeFingerprint, /^[a-f0-9]{64}$/u)
        assert.match(view.sourceCommit, /^[a-f0-9]{40}$/u)
    }
    finally
    {
        rmSync(cacheRoot, { recursive: true, force: true })
    }
})

test('1) rejects extractor that reads docs Markdown as observed values', () =>
{
    const directory = fixtureRoot()
    try
    {
        write(directory, 'docs/answers.md', '# Answers\n\nobservedCount: 42\n')
        write(directory, 'tools/fact-extractors/seeds/test-asset-audit-seed.mjs', `
import { readFileSync } from 'node:fs'
import path from 'node:path'
export function extract(context) {
  const text = readFileSync(path.join(context.repositoryRoot, 'docs/answers.md'), 'utf8')
  const match = text.match(/observedCount:\\s*(\\d+)/)
  return { status: 'ok', failureReasons: [], observations: { coverageEntryCount: Number(match[1]), coverageEntryIds: ['from-docs'], catalogSchema: 'docs' } }
}
`)
        const errors = scanExtractorSources(directory, loadFixtureRegistry(directory))
        assert.match(errors.join('\n'), /docs\/|Markdown/u)
        const registry = loadFixtureRegistry(directory)
        registry.extractors[0].consumedInputs = ['docs/answers.md']
        assert.throws(() => validateRegistry(registry, directory), /forbidden authority|docs\//u)
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('2) rejects extractor that reads test fixture expected sets', () =>
{
    const directory = fixtureRoot()
    try
    {
        write(directory, 'tests/fixtures/expected-coverage.json', '{"expected":["a","b"]}\n')
        write(directory, 'tools/fact-extractors/seeds/test-asset-audit-seed.mjs', `
export function extract() {
  return { status: 'ok', failureReasons: [], observations: { coverageEntryCount: 2, coverageEntryIds: ['a','b'], catalogSchema: 'fixture' } }
}
// forbidden token: tests/fixtures/expected-coverage.json baseline
`)
        const errors = scanExtractorSources(directory, loadFixtureRegistry(directory))
        assert.match(errors.join('\n'), /fixture|expected|baseline/iu)
        const registry = loadFixtureRegistry(directory)
        registry.extractors[0].consumedInputs = ['tests/fixtures/expected-coverage.json']
        assert.throws(() => validateRegistry(registry, directory), /forbidden authority|fixture/iu)
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('3) rejects reusing a HEAD receipt after worktree source changes', async () =>
{
    const directory = fixtureRoot()
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fact-cache-wt-'))
    try
    {
        const first = await runExtractor({
            extractorId: 'code-intent-fact-extractor',
            repositoryRoot: directory,
            useCache: true,
            cacheRoot
        })
        assert.equal(first.receipt.status, 'ok')
        // Mutate a tracked implementation/catalog path without amending commit identity alone.
        const intentPath = path.join(directory, 'tests/governance/code-intent-registry.json')
        const intent = JSON.parse(readFileSync(intentPath, 'utf8'))
        intent.intents = [...intent.intents, { id: 'worktree-only-intent', sourcePaths: ['tools/x.mjs'], intentKinds: ['ownership'], anchors: [] }]
        writeFileSync(intentPath, `${JSON.stringify(intent)}\n`)

        const second = await runExtractor({
            extractorId: 'code-intent-fact-extractor',
            repositoryRoot: directory,
            useCache: true,
            cacheRoot
        })
        assert.equal(second.cacheHit, false)
        assert.notEqual(second.receipt.worktreeFingerprint, first.receipt.worktreeFingerprint)
        assert.notEqual(second.receipt.contentDigest, first.receipt.contentDigest)
        assert.throws(
            () => validateReceipt(first.receipt, {
                expectedWorktreeFingerprint: second.receipt.worktreeFingerprint,
                expectedSourceCommit: second.receipt.sourceCommit
            }),
            /worktreeFingerprint/u
        )
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
        rmSync(cacheRoot, { recursive: true, force: true })
    }
})

test('4) compiled extractor rejects ambient bin directory and requires exact build receipt', async () =>
{
    const { validateBuildIdentity } = await import('../../tools/fact-extractors/identity.mjs')
    assert.throws(
        () => validateBuildIdentity({
            artifactId: 'bin/Debug/net9.0/FsusBlog.dll',
            receiptDigest: 'f'.repeat(64),
            artifactDigest: '0'.repeat(64)
        }, 'bin/Debug/net9.0/FsusBlog.dll'),
        /ambient bin\/Debug|must not bind ambient/u
    )
    assert.throws(() => validateBuildIdentity(null, 'backend-release'), /requires exact buildIdentity/u)
    const ok = validateBuildIdentity({
        artifactId: 'backend-release',
        receiptDigest: '1'.repeat(64),
        artifactDigest: '2'.repeat(64)
    }, 'backend-release')
    assert.equal(ok.artifactId, 'backend-release')

    const directory = fixtureRoot()
    try
    {
        write(directory, 'tools/fact-extractors/seeds/compiled-seed.mjs', `
export function extract() {
  return { status: 'ok', failureReasons: [], observations: { assemblyName: 'FsusBlog' } }
}
`)
        const isolated = {
            schema: registrySchemaId,
            digestAlgorithm: 'sha256',
            canonicalSerialization: 'json-utf8-v1',
            extractors: [{
                id: 'compiled-seed-extractor',
                kind: 'compiled-assembly',
                entrypoint: 'tools/fact-extractors/seeds/compiled-seed.mjs',
                consumedInputs: ['tests/coverage-registry.json'],
                outputSchema: receiptSchemaId,
                requiredBuildArtifact: 'backend-release',
                hermeticPolicy: 'exact-build-receipt',
                ownedBehaviorIds: ['compiled-only-behavior']
            }]
        }
        validateRegistry(isolated, directory)
        await assert.rejects(
            () => runExtractor({
                extractorId: 'compiled-seed-extractor',
                repositoryRoot: directory,
                registry: isolated,
                buildIdentity: null,
                useCache: false
            }),
            /exact buildIdentity|build receipt/u
        )
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('5) rejects two extractors claiming the same behavior', () =>
{
    const registry = structuredClone(loadRegistry())
    registry.extractors[1].ownedBehaviorIds = [registry.extractors[0].ownedBehaviorIds[0]]
    assert.throws(() => validateRegistry(registry), /dual extractor owners/u)
})

test('6) rejects warning/partial/empty observations with status=ok', () =>
{
    assert.throws(
        () => buildReceipt(baseReceiptFields({ status: 'ok', failureReasons: ['warning: soft'], observations: { coverageEntryCount: 1, coverageEntryIds: ['x'], catalogSchema: 's' } })),
        /status=ok cannot include failureReasons/u
    )
    assert.throws(
        () => buildReceipt(baseReceiptFields({ observations: {} })),
        /observations must be non-empty/u
    )
    assert.throws(
        () => validateObservations({ warning: true, value: 1 }),
        /reserved\/forbidden|forbidden field/u
    )
    assert.throws(
        () => buildReceipt(baseReceiptFields({
            observations: { value: 1, partial: true }
        })),
        /forbidden field partial|reserved/u
    )
})

test('7) rejects non-deterministic timestamps inside observations and semantic digest', () =>
{
    assert.throws(
        () => validateObservations({ generatedAt: '2026-07-28T12:00:00.000Z' }),
        /timestamp/u
    )
    const first = buildReceipt(baseReceiptFields({
        observations: { coverageEntryCount: 2, coverageEntryIds: ['a', 'b'], catalogSchema: 's' }
    }))
    const second = buildReceipt(baseReceiptFields({
        observations: { coverageEntryCount: 2, coverageEntryIds: ['a', 'b'], catalogSchema: 's' },
        worktreeFingerprint: '9'.repeat(64)
    }))
    assert.equal(semanticDigestFromReceipt(first), semanticDigestFromReceipt(second))
    assert.notEqual(first.contentDigest, second.contentDigest)
})

test('8) input digest change rejects old cache hit', async () =>
{
    const directory = fixtureRoot()
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fact-cache-input-'))
    try
    {
        const first = await runExtractor({
            extractorId: 'test-asset-audit-fact-extractor',
            repositoryRoot: directory,
            useCache: true,
            cacheRoot
        })
        assert.equal(first.cacheHit, false)
        const coveragePath = path.join(directory, 'tests/coverage-registry.json')
        const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'))
        coverage.entries = [...coverage.entries, { id: 'brand-new-coverage-entry', domain: 'testing', evidence: [] }]
        writeFileSync(coveragePath, `${JSON.stringify(coverage)}\n`)
        // Stage so git worktree fingerprint also moves, and input digest moves.
        spawnSync('git', ['add', 'tests/coverage-registry.json'], { cwd: directory, encoding: 'utf8' })

        const second = await runExtractor({
            extractorId: 'test-asset-audit-fact-extractor',
            repositoryRoot: directory,
            useCache: true,
            cacheRoot
        })
        assert.equal(second.cacheHit, false)
        assert.notEqual(
            digestValue(first.receipt.consumedInputDigests),
            digestValue(second.receipt.consumedInputDigests)
        )
        assert.throws(
            () => validateReceipt(first.receipt, {
                expectedInputDigests: second.receipt.consumedInputDigests,
                expectedSourceCommit: first.receipt.sourceCommit,
                expectedWorktreeFingerprint: first.receipt.worktreeFingerprint
            }),
            /consumedInputDigests|cache reuse rejected/u
        )
        // Direct cache key must differ.
        assert.notEqual(
            computeExecutionCacheKey({
                extractorId: first.receipt.extractorId,
                registryDigest: first.receipt.registryDigest,
                extractorDigest: first.receipt.extractorDigest,
                consumedInputDigests: first.receipt.consumedInputDigests,
                sourceCommit: first.receipt.sourceCommit,
                worktreeFingerprint: first.receipt.worktreeFingerprint,
                buildIdentity: null
            }),
            computeExecutionCacheKey({
                extractorId: second.receipt.extractorId,
                registryDigest: second.receipt.registryDigest,
                extractorDigest: second.receipt.extractorDigest,
                consumedInputDigests: second.receipt.consumedInputDigests,
                sourceCommit: second.receipt.sourceCommit,
                worktreeFingerprint: second.receipt.worktreeFingerprint,
                buildIdentity: null
            })
        )
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
        rmSync(cacheRoot, { recursive: true, force: true })
    }
})

test('9) rejects extractor A calling extractor B domain coupling', () =>
{
    const directory = fixtureRoot()
    try
    {
        write(directory, 'tools/fact-extractors/seeds/test-asset-audit-seed.mjs', `
import { extract as other } from './code-intent-seed.mjs'
export function extract(context) {
  return other(context)
}
`)
        const errors = scanExtractorSources(directory, loadFixtureRegistry(directory))
        assert.match(errors.join('\n'), /must not call\/import peer extractor/u)
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('consumer reader is the public surface and blocks seed imports', () =>
{
    const receipt = buildReceipt(baseReceiptFields())
    const view = readFactObservationReceipt(receipt)
    assert.equal(view.status, 'ok')
    assert.equal(view.semanticDigest, computeSemanticDigest({
        extractorId: receipt.extractorId,
        behaviorIds: receipt.behaviorIds,
        observations: receipt.observations,
        status: receipt.status
    }))
    assert.throws(
        () => assertConsumerDoesNotImportExtractors("import { extract } from '../fact-extractors/seeds/code-intent-seed.mjs'\n"),
        /must not import extractor seed/u
    )
})

test('no-owner active behavior fails ownership validation', () =>
{
    const registry = structuredClone(loadRegistry())
    registry.extractors[0].ownedBehaviorIds = ['unrelated-behavior-for-test']
    // Fix dual owner: remove original ownership by replacing first extractor ownership only - still need unique
    // Actually first behavior lost owner; unrelated not in catalog.
    assert.throws(
        () => validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root),
        /no extractor owner|unknown behavior/u
    )
})

test('unknown observation field markers and second schema surfaces fail', () =>
{
    assert.throws(() => validateObservations({ unknown: 1 }), /reserved\/forbidden|unknown/u)
    const receiptSchema = structuredClone(loadReceiptSchema())
    receiptSchema.properties.status.enum.push('warning')
    assert.throws(() => validateReceiptSchemaContract(receiptSchema), /warning/u)
})
