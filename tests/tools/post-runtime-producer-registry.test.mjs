import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import {
    BehaviorId,
    acceptedClaimsSchema,
    authorityDigest,
    canonicalRepositoryFile,
    identityAuthoritySchema,
    loadPostRuntimeProducerRegistry,
    postRuntimeRegistrySchema,
    requiredPostRuntimeBehaviors,
    root,
    validateAcceptedClaimsReceiptAgainstRegistry,
    validatePostRuntimeProducerRegistry,
    validatePostRuntimeReaderFirewall,
    validatePostRuntimeRepositoryAuthority,
    validatePostRuntimeReceiptSchemas,
    validateProducerReceiptAgainstRegistry as validateProducerReceiptAgainstRegistryRaw
} from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/behavior-contracts.json'), 'utf8'))
const migrationLedger = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
const registry = loadPostRuntimeProducerRegistry(root)
const digest = (character) => `sha256:${character.repeat(64)}`
const receiptRepositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-receipt-'))
process.on('exit', () => fs.rmSync(receiptRepositoryRoot, { recursive: true, force: true }))
fs.mkdirSync(path.join(receiptRepositoryRoot, 'config/schemas'), { recursive: true })
fs.mkdirSync(path.join(receiptRepositoryRoot, 'config/testing'), { recursive: true })
fs.mkdirSync(path.join(receiptRepositoryRoot, '.tmp/current-run'), { recursive: true })
fs.copyFileSync(path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'),
    path.join(receiptRepositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'))
fs.copyFileSync(path.join(root, 'config/testing/fixture-profile-catalog.json'),
    path.join(receiptRepositoryRoot, 'config/testing/fixture-profile-catalog.json'))

function validateProducerReceiptAgainstRegistry(options)
{
    return validateProducerReceiptAgainstRegistryRaw({
        ...options,
        repositoryRoot: options.repositoryRoot ?? receiptRepositoryRoot
    })
}

function seal(receipt)
{
    const value = structuredClone(receipt)
    delete value.contentDigest
    return { ...value, contentDigest: `sha256:${digestValue(value)}` }
}

function producerReceipt(classId = 'route-response-error')
{
    const producer = registry.producers[0]
    const definition = registry.observationClasses[classId]
    const requiredModes = Object.entries(producer.requiredObservations)
        .filter(([, classes]) => classes.includes(classId))
        .map(([mode]) => mode)
        .sort()
    const semanticFacts = Object.fromEntries(definition.requiredSemanticFactFields.map((field) =>
        [field, field === 'responseStatus' ? 200 : field.endsWith('Digest') ? digest('1') : `${field}-value`]))
    const sourceState = {
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: digest('b'),
        buildIdentity: digest('c'),
        artifactDigest: digest('2'),
        candidateId: 'candidate-1',
        runtimeIdentity: digest('3'),
        browserIdentity: digest('4'),
        releaseId: 'release-1',
        rolloutId: 'rollout-1',
        runId: 'run-1',
        attemptId: 'attempt-0001',
        fixtureId: 'fixture-1',
        profileId: 'acceptance-representative'
    }
    const refs = {}
    for (const [field, role, identityField] of [
        ['candidatePlanRef', 'plan', 'runId'],
        ['attemptAuthorityRef', 'attempt', 'attemptId'],
        ['fixtureAuthorityRef', 'fixture', 'fixtureId'],
        ['profileAuthorityRef', 'profile', 'profileId']
    ])
    {
        const authority = seal({
            schema: identityAuthoritySchema,
            role,
            authorityId: sourceState[identityField],
            sourceState: Object.fromEntries([
                'sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId', 'fixtureId', 'profileId'
            ].map((identity) => [identity, sourceState[identity]]))
        })
        const relative = `.tmp/current-run/${role}-authority.json`
        const absolute = path.join(receiptRepositoryRoot, relative)
        fs.writeFileSync(absolute, `${JSON.stringify(authority, null, 2)}\n`)
        refs[field] = {
            path: relative,
            fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`,
            contentDigest: authority.contentDigest,
            schema: identityAuthoritySchema,
            role
        }
    }
    return seal({
        schema: definition.schema,
        producerId: producer.producerId,
        toolVersion: producer.toolVersion,
        registryDigest: authorityDigest(registry),
        observationSchemaDigest: authorityDigest(JSON.parse(fs.readFileSync(
            path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))),
        sourceState,
        executionClass: 'correctness',
        evidenceClass: 'correctness',
        qualificationEligible: true,
        planned: true,
        executed: true,
        outcome: 'passed',
        recovered: false,
        modes: requiredModes,
        terminal: {
            timeout: false,
            cancelled: false,
            processTreeTerminated: false,
            priorAttemptDigest: null
        },
        semanticFacts,
        ...refs,
        sourceReceiptRef: {
            path: '.tmp/current-run/source-receipt.json',
            fileDigest: digest('f'),
            contentDigest: digest('0')
        },
        canonicalRerunCommand: 'node tools/test-evidence/runtime-observation-probes.mjs route',
        independentVerifyCommand: 'node tools/test-evidence/runtime-observation-raw.mjs verify'
    })
}

function tampered(modifier)
{
    const clone = structuredClone(registry)
    modifier(clone)
    return clone
}

test('registry derives required behaviors from the BehaviorCatalog and validates exact-one', () =>
{
    const behaviors = requiredPostRuntimeBehaviors(catalog)
    assert.ok(behaviors.includes('browserless-production-correctness'))
    const summary = validatePostRuntimeProducerRegistry(registry, { catalog, migrationLedger })
    assert.equal(summary.schema, postRuntimeRegistrySchema)
    assert.equal(summary.producerCount, behaviors.length)
    assert.equal(summary.warnings, 0)
})

test('missing producer/schema for a post-runtime behavior fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => clone.producers.pop()), { catalog }),
        /has no producer mapping/u)
})

test('two producers for the same behavior fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => clone.producers.push(structuredClone(clone.producers[0]))), { catalog }),
        /mapped by two producers/u)
})

test('artifact path or job name based mapping fields fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].artifactPath = '.tmp/receipt.json' }), { catalog }),
        /forbidden field artifactPath/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].jobName = 'ci-release-final' }), { catalog }),
        /forbidden field jobName/u)
})

test('existence shortcut observation classes fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.observationClasses['http-200-class'] = {
                schema: 'fsusblog.observation.http200.v1',
                requiredIdentityFields: ['contentDigest'],
                requiredSemanticFactFields: ['responseStatus'],
                allowedModes: ['positive', 'negative', 'boundary', 'failure'],
                existenceShortcutForbidden: false
            }
        }), { catalog }),
        /must forbid existence shortcuts/u)
})

test('diagnostic qualification fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].diagnosticEligible = true }), { catalog }),
        /never accept diagnostic evidence/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].executionClass = 'diagnostic' }), { catalog }),
        /cannot satisfy qualification/u)
})

test('missing required identity binding fails closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredIdentities = ['schedulerRunId']
        }), { catalog }),
        /must bind source identity/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            delete clone.observationClasses['route-response-error'].requiredIdentityFields
        }), { catalog }),
        /missing or unknown fields/u)
})

test('unknown observation type and non-exact claim mapping fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredObservations.positive.push('screenshot-present')
        }), { catalog }),
        /unknown observation class screenshot-present/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(registry, { catalog, migrationLedger: tamperedLedger() }),
        /accepted claim refs must exact-match/u)

    function tamperedLedger()
    {
        const clone = structuredClone(migrationLedger)
        for (const scope of clone.scopes)
        {
            for (const entry of scope.entries)
            {
                if (entry.behaviorId === 'browserless-production-correctness') entry.claimIds = ['browserless-production-correctness.tiers']
            }
        }
        return clone
    }
})

test('owner, behavior domain and per-producer evidenceClass are authority-bound', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].owner = 'docs/testing.md'
        }), { catalog, migrationLedger }),
        /canonical matrix producer authority/u)
    const documentationCatalog = structuredClone(catalog)
    documentationCatalog.contracts.find((contract) =>
        contract.id === 'browserless-production-correctness').domain = 'documentation'
    assert.throws(
        () => validatePostRuntimeProducerRegistry(registry, {
            catalog: documentationCatalog,
            migrationLedger
        }),
        /domain\/tier\/schema conflicts/u)
    const coordinatedDocumentationRegistry = structuredClone(registry)
    coordinatedDocumentationRegistry.producers[0].behaviorDomain = 'documentation'
    assert.throws(
        () => validatePostRuntimeProducerRegistry(coordinatedDocumentationRegistry, {
            catalog: documentationCatalog,
            migrationLedger
        }),
        /behavior domain is not runtime-eligible/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].evidenceClass = 'browser-contract'
        }), { catalog, migrationLedger }),
        /evidenceClass conflicts/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            delete clone.producers[0].evidenceClass
        }), { catalog, migrationLedger }),
        /missing or unknown fields/u)
})

test('registry claim refs reject missing, extra and duplicate entries', () =>
{
    for (const mutate of [
        (claims) => claims.pop(),
        (claims) => claims.push('browserless-production-correctness.unknown'),
        (claims) => claims.push(claims[0])
    ])
    {
        assert.throws(
            () => validatePostRuntimeProducerRegistry(tampered((clone) =>
            {
                mutate(clone.producers[0].acceptedClaimRefs)
            }), { catalog, migrationLedger }),
            /accepted claim refs must exact-match/u)
    }
})

test('manual owner/waiver fields and every pre-v2 registry fail closed', () =>
{
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.producers[0].waiver = true }), { catalog }),
        /forbidden field waiver/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) => { clone.schema = 'fsusblog.post-runtime-producer-registry.v1' }), { catalog }),
        /unexpected registry schema/u)
})

test('registry and receipt schemas are closed and exact', () =>
{
    assert.equal(validatePostRuntimeReceiptSchemas(registry), true)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].requiredObservations.positive.push('route-response-error')
        }), { catalog }),
        /duplicate observation classes/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            delete clone.producers[0].requiredObservations.failure
        }), { catalog }),
        /missing or unknown fields/u)
    assert.throws(
        () => validatePostRuntimeProducerRegistry(tampered((clone) =>
        {
            clone.producers[0].toolVersion = 'latest'
        }), { catalog }),
        /toolVersion is missing or invalid/u)
})

test('receipt binding recomputes digest and exact mode/tool/source identity', () =>
{
    const producer = registry.producers[0]
    const receipt = producerReceipt()
    assert.deepEqual(
        validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt }),
        {
            producerId: producer.producerId,
            behaviorId: 'browserless-production-correctness',
            classId: 'route-response-error',
            qualificationEligible: true,
            warnings: 0
        })

    const wrongSchema = seal({ ...receipt, schema: 'fsusblog.other-receipt.v1' })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: wrongSchema }),
        /does not resolve exact-one observation class/u)

    const missingIdentity = structuredClone(receipt)
    delete missingIdentity.sourceState.worktreeFingerprint
    const resealedMissingIdentity = seal(missingIdentity)
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({
            registry,
            producerId: producer.producerId,
            receipt: resealedMissingIdentity
        }),
        /missing route-response-error identity worktreeFingerprint/u)

    const staleTool = seal({ ...receipt, toolVersion: 'production-correctness-scheduler@2' })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: staleTool }),
        /producer\/tool version mismatch/u)

    const extraMode = seal({ ...receipt, modes: [...receipt.modes, 'boundary'] })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: extraMode }),
        /modes must exact-match/u)

    const digestTamper = structuredClone(receipt)
    digestTamper.semanticFacts.coherent = false
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: producer.producerId, receipt: digestTamper }),
        /contentDigest mismatch/u)

    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId: 'unknown-producer', receipt }),
        /unknown producer/u)
})

test('run, attempt, fixture and profile identities are typed and bind independent authorities', () =>
{
    const producerId = registry.producers[0].producerId
    const base = producerReceipt()
    for (const field of ['runId', 'attemptId', 'fixtureId', 'profileId'])
    {
        const empty = structuredClone(base)
        empty.sourceState[field] = ''
        assert.throws(
            () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(empty) }),
            /source identity is invalid/u)
    }

    const malformedAttempt = structuredClone(base)
    malformedAttempt.sourceState.attemptId = 'run-0001'
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(malformedAttempt) }),
        /source identity is invalid/u)

    const swappedIdentities = structuredClone(base)
    ;[swappedIdentities.sourceState.runId, swappedIdentities.sourceState.fixtureId] =
        [swappedIdentities.sourceState.fixtureId, swappedIdentities.sourceState.runId]
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(swappedIdentities) }),
        /plan authority identity\/content mismatch/u)

    const swappedAuthorities = structuredClone(base)
    ;[swappedAuthorities.candidatePlanRef, swappedAuthorities.attemptAuthorityRef] =
        [swappedAuthorities.attemptAuthorityRef, swappedAuthorities.candidatePlanRef]
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: seal(swappedAuthorities) }),
        /plan authority reference is invalid/u)
})

test('HTTP-only and stale registry/schema/evidenceClass receipts cannot qualify', () =>
{
    const producerId = registry.producers[0].producerId
    const receipt = producerReceipt()
    const httpOnly = seal({ ...receipt, semanticFacts: { httpStatus: 200 } })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: httpOnly }),
        /semantic facts has missing or unknown fields/u)

    const registryDrift = structuredClone(registry)
    registryDrift.canonicalSerialization = 'json-utf8-v2'
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry: registryDrift, producerId, receipt }),
        /registry\/schema digest mismatch/u)

    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-schema-'))
    fs.mkdirSync(path.join(repositoryRoot, 'config/schemas'), { recursive: true })
    const schema = JSON.parse(fs.readFileSync(
        path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
    schema.title = 'drifted contract'
    fs.writeFileSync(path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'),
        `${JSON.stringify(schema, null, 2)}\n`)
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt, repositoryRoot }),
        /registry\/schema digest mismatch/u)
    fs.rmSync(repositoryRoot, { recursive: true, force: true })

    const wrongEvidenceClass = seal({ ...receipt, evidenceClass: 'browser-contract' })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: wrongEvidenceClass }),
        /evidenceClass does not match producer contract/u)
})

test('production validator rejects a second registry and is wired into static governance', (context) =>
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-authority-'))
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(repositoryRoot, 'config/testing'), { recursive: true })
    fs.copyFileSync(path.join(root, 'config/configuration-ownership.json'),
        path.join(repositoryRoot, 'config/configuration-ownership.json'))
    fs.copyFileSync(path.join(root, 'config/testing/post-runtime-producer-registry.json'),
        path.join(repositoryRoot, 'config/testing/post-runtime-producer-registry.json'))
    execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
    execFileSync('git', ['add', 'config/configuration-ownership.json',
        'config/testing/post-runtime-producer-registry.json'], { cwd: repositoryRoot })
    assert.equal(validatePostRuntimeRepositoryAuthority(repositoryRoot, { validateReaderFirewall: false }), true)
    fs.mkdirSync(path.join(repositoryRoot, 'tools'), { recursive: true })
    fs.copyFileSync(path.join(root, 'config/testing/post-runtime-producer-registry.json'),
        path.join(repositoryRoot, 'tools/second-post-runtime-registry.json'))
    execFileSync('git', ['add', 'tools/second-post-runtime-registry.json'], { cwd: repositoryRoot })
    assert.throws(
        () => validatePostRuntimeRepositoryAuthority(repositoryRoot, { validateReaderFirewall: false }),
        /authority paths must exact-match/u)

    const staticLane = fs.readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8')
    assert.match(staticLane,
        /StaticPostRuntimeProducerRegistry\(\).*post-runtime-producer-registry\.mjs/su)
    assert.match(staticLane,
        /post-runtime-producer-registry StaticPostRuntimeProducerRegistry/u)
})

test('owner and command authorities reject symlinks and external realpaths', (context) =>
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-owner-'))
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-external-'))
    context.after(() =>
    {
        fs.rmSync(repositoryRoot, { recursive: true, force: true })
        fs.rmSync(externalRoot, { recursive: true, force: true })
    })
    fs.mkdirSync(path.join(repositoryRoot, 'tools'), { recursive: true })
    const external = path.join(externalRoot, 'owner.mjs')
    fs.writeFileSync(external, 'export const owner = true\n')
    fs.symlinkSync(external, path.join(repositoryRoot, 'tools/owner.mjs'))
    assert.throws(
        () => canonicalRepositoryFile(repositoryRoot, 'tools/owner.mjs', 'producer owner'),
        /regular non-symlink file/u)

    fs.symlinkSync(externalRoot, path.join(repositoryRoot, 'tools-link'))
    assert.throws(
        () => canonicalRepositoryFile(repositoryRoot, 'tools-link/owner.mjs', 'producer command'),
        /canonical path inside the repository root/u)
})

test('reader firewall traverses imports and rejects transitive Markdown/DocClaim readers', (context) =>
{
    const current = validatePostRuntimeReaderFirewall(root)
    assert.ok(current.modules.includes('tools/test-matrix/post-runtime-producer-registry.mjs'))

    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-reader-'))
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(repositoryRoot, 'tools/test-matrix'), { recursive: true })
    fs.mkdirSync(path.join(repositoryRoot, 'tools/docs'), { recursive: true })
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/entry.mjs'),
        "import './middle.mjs'\nexport const entry = true\n")
    fs.writeFileSync(path.join(repositoryRoot, 'tools/test-matrix/middle.mjs'),
        "export { claim } from '../docs/doc-claim.mjs'\n")
    fs.writeFileSync(path.join(repositoryRoot, 'tools/docs/doc-claim.mjs'),
        'export const claim = true\n')
    assert.throws(
        () => validatePostRuntimeReaderFirewall(repositoryRoot, 'tools/test-matrix/entry.mjs'),
        /import closure reaches forbidden Markdown\/DocClaim module/u)
})

test('re-sealed diagnostic, timeout, cancel and recovered mutations cannot qualify', () =>
{
    const producerId = registry.producers[0].producerId
    const base = producerReceipt()
    const diagnostic = seal({ ...base, executionClass: 'diagnostic', qualificationEligible: false })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: diagnostic }),
        /executionClass cannot satisfy qualification/u)

    const timedOut = seal({
        ...base,
        qualificationEligible: false,
        outcome: 'timed-out',
        terminal: {
            timeout: true,
            cancelled: false,
            processTreeTerminated: true,
            priorAttemptDigest: null
        }
    })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: timedOut }),
        /qualificationEligible cannot satisfy qualification/u)

    const contradictoryCancel = seal({
        ...base,
        outcome: 'cancelled',
        terminal: {
            timeout: false,
            cancelled: true,
            processTreeTerminated: false,
            priorAttemptDigest: null
        }
    })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: contradictoryCancel }),
        /terminal outcome is contradictory/u)

    const recovered = seal({
        ...base,
        qualificationEligible: false,
        recovered: true,
        terminal: { ...base.terminal, priorAttemptDigest: digest('9') }
    })
    assert.throws(
        () => validateProducerReceiptAgainstRegistry({ registry, producerId, receipt: recovered }),
        /qualificationEligible cannot satisfy qualification/u)
})

function acceptedClaimsFixture(context)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-claims-'))
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(repositoryRoot, 'config/schemas'), { recursive: true })
    fs.mkdirSync(path.join(repositoryRoot, '.tmp/current-run'), { recursive: true })
    fs.copyFileSync(
        path.join(root, 'config/schemas/post-runtime-accepted-claims.schema.json'),
        path.join(repositoryRoot, 'config/schemas/post-runtime-accepted-claims.schema.json'))
    const terminalPath = path.join(repositoryRoot, '.tmp/current-run/global-claims.json')
    const terminal = {
        schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1',
        scopeId: 'global-document-claim-exactness',
        source: {
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: 'b'.repeat(64),
            catalogDigest: 'c'.repeat(64),
            migrationLedgerDigest: digestValue(migrationLedger),
            sectionCatalogDigest: 'd'.repeat(64),
            observationDigests: { test: 'e'.repeat(64) }
        },
        authorityDigests: ['test'],
        counts: {
            requiredBehaviors: 1,
            scopes: 1,
            ledgerEntries: 1,
            generatedClaimCount: 1,
            proseClaimCount: 1,
            proseTotal: 1,
            proseVerified: 1,
            generatedSectionsVerified: 1,
            generatedSectionDrifts: 0,
            missing: 0,
            extra: 0,
            residue: 0,
            mutationKilled: 1,
            mutationTotal: 1,
            warnings: 0
        },
        mutationAggregate: { killed: 1, total: 1 },
        residue: [],
        proseVerification: { diagnostics: [] },
        status: 'ok',
        failureReasons: [],
        contentDigest: null
    }
    terminal.contentDigest = digestValue(terminal)
    const writeTerminal = (value) =>
    {
        fs.writeFileSync(terminalPath, `${JSON.stringify(value, null, 2)}\n`)
        return `sha256:${createHash('sha256').update(fs.readFileSync(terminalPath)).digest('hex')}`
    }
    const fileDigest = writeTerminal(terminal)
    const producer = registry.producers[0]
    const owners = new Map()
    for (const scope of migrationLedger.scopes)
    {
        for (const entry of scope.entries)
        {
            for (const claimId of entry.claimIds)
            {
                owners.set(claimId, {
                    claimId,
                    behaviorId: BehaviorId(entry.behaviorId),
                    scopeId: scope.scopeId
                })
            }
        }
    }
    const receipt = seal({
        schema: acceptedClaimsSchema,
        sourceState: {
            commit: terminal.source.sourceCommit,
            worktreeFingerprint: `sha256:${terminal.source.worktreeFingerprint}`
        },
        producerId: producer.producerId,
        toolVersion: registry.receiptSemantics.acceptedClaimsToolVersion,
        registryDigest: authorityDigest(registry),
        claimsSchemaDigest: authorityDigest(JSON.parse(fs.readFileSync(
            path.join(root, 'config/schemas/post-runtime-accepted-claims.schema.json'), 'utf8'))),
        terminalReceiptRef: {
            path: '.tmp/current-run/global-claims.json',
            fileDigest,
            contentDigest: `sha256:${terminal.contentDigest}`,
            schema: terminal.schema
        },
        migrationLedgerDigest: `sha256:${terminal.source.migrationLedgerDigest}`,
        claims: producer.acceptedClaimRefs.map((claimId) => owners.get(claimId))
            .sort((left, right) => left.claimId.localeCompare(right.claimId)),
        status: 'accepted'
    })
    return { repositoryRoot, terminalPath, terminal, receipt, writeTerminal }
}

test('accepted claims replay one exact #2205 terminal path, digest, identity and claim set', (context) =>
{
    const fixture = acceptedClaimsFixture(context)
    const producerId = registry.producers[0].producerId
    const result = validateAcceptedClaimsReceiptAgainstRegistry({
        registry,
        producerId,
        receipt: fixture.receipt,
        repositoryRoot: fixture.repositoryRoot,
        migrationLedger
    })
    assert.equal(result.producerId, producerId)
    assert.equal(result.acceptedClaims, registry.producers[0].acceptedClaimRefs.length)

    const oldV1Shape = structuredClone(fixture.receipt)
    oldV1Shape.terminalReceiptDigest = oldV1Shape.terminalReceiptRef.contentDigest
    delete oldV1Shape.terminalReceiptRef
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: seal(oldV1Shape),
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /missing or unknown fields/u)

    for (const field of ['registryDigest', 'claimsSchemaDigest'])
    {
        assert.throws(
            () => validateAcceptedClaimsReceiptAgainstRegistry({
                registry,
                producerId,
                receipt: seal({ ...fixture.receipt, [field]: digest('8') }),
                repositoryRoot: fixture.repositoryRoot,
                migrationLedger
            }),
            /registry\/schema digest mismatch/u)
    }
})

test('accepted claims reject terminal file/content/identity and re-sealed claim mutations', (context) =>
{
    const fixture = acceptedClaimsFixture(context)
    const producerId = registry.producers[0].producerId
    fs.appendFileSync(fixture.terminalPath, ' ')
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: fixture.receipt,
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /file digest mismatch/u)

    fixture.writeTerminal(fixture.terminal)
    const duplicateClaim = seal({
        ...fixture.receipt,
        claims: [...fixture.receipt.claims, fixture.receipt.claims[0]]
    })
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: duplicateClaim,
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /claim set does not exact-match/u)

    const driftedTerminal = structuredClone(fixture.terminal)
    driftedTerminal.source.sourceCommit = 'f'.repeat(40)
    driftedTerminal.contentDigest = null
    driftedTerminal.contentDigest = digestValue(driftedTerminal)
    const driftedFileDigest = fixture.writeTerminal(driftedTerminal)
    const identityDrift = seal({
        ...fixture.receipt,
        terminalReceiptRef: {
            ...fixture.receipt.terminalReceiptRef,
            fileDigest: driftedFileDigest,
            contentDigest: `sha256:${driftedTerminal.contentDigest}`
        }
    })
    assert.throws(
        () => validateAcceptedClaimsReceiptAgainstRegistry({
            registry,
            producerId,
            receipt: identityDrift,
            repositoryRoot: fixture.repositoryRoot,
            migrationLedger
        }),
        /source identity mismatch/u)
})
