import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    behaviorDocGlobalClaimExactnessComponent,
    runBehaviorDocStaticAdmission
} from '../../tools/docs/behavior-doc-static-admission.mjs'
import {
    behaviorDocAdmissionReceiptSchema,
    readBehaviorDocStaticAdmissionReceipt,
    validateBehaviorDocStaticAdmissionReceipt
} from '../../tools/docs/behavior-doc-static-admission-contract.mjs'
import {
    minimalContractBuildHostDeclarations
} from '../../tools/docs/behavior-doc-minimal-contract-build-contract.mjs'
import { digestValue } from '../../tools/fact-extractors/identity.mjs'
import { loadRegistry } from '../../tools/fact-extractors/registry.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function seal(value)
{
    const receipt = { ...structuredClone(value), contentDigest: null }
    receipt.contentDigest = digestValue(receipt)
    return receipt
}

function validAdmissionReceipt()
{
    const runId = 'pure-behavior-doc-contract'
    const source = {
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    }
    const buildKey = 'c'.repeat(64)
    const buildRoot = `.tmp/behavior-doc-contract-builds/${buildKey}`
    const registry = loadRegistry(path.join(root, 'config/contracts/behavior-fact-extractors.json'))
    return seal({
        schema: behaviorDocAdmissionReceiptSchema,
        run: { id: runId },
        source: {
            commit: source.sourceCommit,
            worktreeFingerprint: source.worktreeFingerprint
        },
        worktree: { root },
        toolchain: {
            node: 'v24.0.0',
            dotnet: '10.0.100',
            platform: 'linux',
            architecture: 'x64',
            directoryBuildPropsDigest: 'd'.repeat(64)
        },
        authorityDigests: Object.fromEntries([
            'catalog',
            'claim',
            'extractorRegistry',
            'generatedSectionCatalog',
            'generatedRenderer',
            'proseRenderer',
            'mutationCatalog'
        ].map((key, index) => [key, String(index + 1).repeat(64)])),
        implementationOwner: {
            status: 'ok',
            bindingCount: 1,
            contentDigest: 'e'.repeat(64)
        },
        factObservations: Object.fromEntries(registry.extractors.map((extractor) => [
            extractor.id,
            {
                status: 'ok',
                extractorDigest: 'f'.repeat(64),
                semanticDigest: 'a'.repeat(64),
                contentDigest: 'b'.repeat(64)
            }
        ])),
        minimalContractBuild: seal({
            schema: 'fsusblog.behavior-doc-minimal-contract-build-receipt.v1',
            runId,
            sourceCommit: source.sourceCommit,
            worktreeFingerprint: source.worktreeFingerprint,
            toolchain: {
                dotnet: '10.0.100',
                configuration: 'Release',
                targetFramework: 'net10.0'
            },
            buildKey,
            buildRoot,
            sourceClosureDigests: [{ path: 'Directory.Build.props', digest: 'c'.repeat(64) }],
            artifacts: Object.fromEntries(
                Object.entries(minimalContractBuildHostDeclarations).map(([artifactId, value]) => [
                    artifactId,
                    {
                        project: value.project,
                        projectDigest: 'd'.repeat(64),
                        path: path.posix.join(buildRoot, value.cacheFile),
                        artifactDigest: 'e'.repeat(64)
                    }
                ])
            ),
            status: 'ok',
            failureReasons: []
        }),
        generated: { status: 'ok', documentCount: 1, contentDigest: '1'.repeat(64) },
        prose: { status: 'ok', verifiedClaimCount: 1, contentDigest: '2'.repeat(64) },
        mutationFixtures: { status: 'ok', caseCount: 1, contentDigest: '3'.repeat(64) },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok',
        failureReasons: [],
        durationMs: 1
    })
}

test('pure BehaviorDoc contract reads exact receipt and fails closed on missing or tampered input', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-behavior-doc-contract-'))
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const receiptPath = path.join(directory, 'receipt.json')
    const receipt = validAdmissionReceipt()
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)

    assert.deepEqual(readBehaviorDocStaticAdmissionReceipt(receiptPath, {
        expectedRunId: receipt.run.id,
        expectedSourceIdentity: {
            sourceCommit: receipt.source.commit,
            worktreeFingerprint: receipt.source.worktreeFingerprint
        },
        expectedWorktree: root
    }), receipt)
    assert.throws(
        () => readBehaviorDocStaticAdmissionReceipt(path.join(directory, 'missing.json')),
        /receipt is missing/u
    )

    receipt.generated.documentCount += 1
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    assert.throws(
        () => readBehaviorDocStaticAdmissionReceipt(receiptPath),
        /content digest mismatch/u
    )
})

test('pure BehaviorDoc contract rejects unknown schema and stale caller identity', () =>
{
    const receipt = validAdmissionReceipt()
    assert.throws(
        () => validateBehaviorDocStaticAdmissionReceipt(seal({
            ...receipt,
            schema: 'fsusblog.behavior-doc-static-admission-receipt.v999'
        })),
        /schema must be/u
    )
    assert.throws(
        () => validateBehaviorDocStaticAdmissionReceipt(receipt, {
            expectedSourceIdentity: {
                sourceCommit: 'f'.repeat(40),
                worktreeFingerprint: receipt.source.worktreeFingerprint
            }
        }),
        /source\/worktree identity mismatch/u
    )
})

test('pure BehaviorDoc contract rejects self-resealed scalar type forgeries', () =>
{
    const mutations = [
        (receipt) => { receipt.implementationOwner.bindingCount = '2' },
        (receipt) => { receipt.generated.documentCount = '0' },
        (receipt) => { receipt.prose.verifiedClaimCount = '2' },
        (receipt) => { receipt.mutationFixtures.caseCount = '1' },
        (receipt) => { receipt.durationMs = '1' },
        (receipt) => { receipt.toolchain.node = 24 }
    ]
    for (const mutate of mutations)
    {
        const forged = structuredClone(validAdmissionReceipt())
        mutate(forged)
        forged.contentDigest = null
        forged.contentDigest = digestValue(forged)
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(forged))
    }
})

test('aggregate-only BehaviorDoc consumers import the pure contract authority', () =>
{
    for (const relative of [
        'tools/test-matrix/scheduler.mjs',
        'tools/docs/auth-security-doc-exactness.mjs',
        'tests/tools/test-matrix-scheduler.test.mjs',
        'tests/tools/support/behavior-doc-admission-fixture.mjs'
    ])
    {
        const source = fs.readFileSync(path.join(root, relative), 'utf8')
        assert.match(source, /behavior-doc-static-admission-contract\.mjs/u, relative)
        assert.doesNotMatch(source, /behavior-doc-static-admission\.mjs/u, relative)
    }
    for (const relative of [
        'tools/docs/behavior-doc-static-admission-contract.mjs',
        'tools/docs/behavior-doc-minimal-contract-build-contract.mjs'
    ])
    {
        const source = fs.readFileSync(path.join(root, relative), 'utf8')
        assert.doesNotMatch(
            source,
            /node:child_process|\/scanner\.mjs|\/runner\.mjs|behavior-doc-static-admission\.mjs|behavior-doc-minimal-contract-build\.mjs/u,
            relative
        )
    }
})

test('BehaviorDoc admission removes stale global terminal before any fail-closed exit', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-claim-admission-'))
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const componentsDirectory = path.join(directory, 'components')
    const terminal = path.join(componentsDirectory, behaviorDocGlobalClaimExactnessComponent)
    fs.mkdirSync(componentsDirectory, { recursive: true })
    fs.writeFileSync(terminal, '{"status":"stale"}\n')

    await assert.rejects(
        runBehaviorDocStaticAdmission({
            repositoryRoot: root,
            runId: 'global-claim-stale-terminal',
            outputFile: path.join(directory, 'admission.json'),
            componentsDirectory,
            candidateSpawnCountBeforeReceipt: 1
        }),
        /candidate process spawned before BehaviorDoc admission/u
    )
    assert.equal(fs.existsSync(terminal), false)
    const admission = JSON.parse(fs.readFileSync(path.join(directory, 'admission.json'), 'utf8'))
    assert.equal(admission.status, 'failed')
    assert.equal(admission.candidateSpawnCountBeforeReceipt, 1)
})
