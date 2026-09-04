import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import {
    buildPostRuntimeAcceptedClaimsReceipt,
    readAndValidatePostRuntimeAcceptedClaimsReceipt,
    root,
    validatePostRuntimeAcceptedClaimsValue,
    writePostRuntimeAcceptedClaimsReceipt
} from '../../tools/docs/post-runtime-accepted-claims.mjs'

function sealTerminal(value)
{
    const receipt = { ...value, contentDigest: null }
    receipt.contentDigest = digestValue(receipt)
    return receipt
}

function currentTerminal(runId = 'post-runtime-accepted-claims-run')
{
    const source = sealSourceIdentity(root)
    const migrationLedger = JSON.parse(fs.readFileSync(
        path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
    return sealTerminal({
        schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1',
        scopeId: 'global-document-claim-exactness',
        runId,
        source: {
            sourceCommit: source.sourceCommit,
            worktreeFingerprint: source.worktreeFingerprint,
            catalogDigest: '1'.repeat(64),
            migrationLedgerDigest: digestValue(migrationLedger),
            sectionCatalogDigest: '2'.repeat(64),
            observationDigests: {}
        },
        authorityDigests: [],
        counts: {
            requiredBehaviors: 9,
            scopes: 6,
            ledgerEntries: 43,
            generatedClaimCount: 84,
            proseClaimCount: 35,
            proseTotal: 35,
            proseVerified: 35,
            generatedSectionsVerified: 84,
            generatedSectionDrifts: 0,
            missing: 0,
            extra: 0,
            residue: 0,
            mutationKilled: 12,
            mutationTotal: 12,
            warnings: 0
        },
        mutationAggregate: { killed: 12, total: 12 },
        residue: [],
        proseVerification: { diagnostics: [] },
        status: 'ok',
        failureReasons: []
    })
}

function fixture(context)
{
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
    const directory = fs.mkdtempSync(path.join(root, '.tmp', 'post-runtime-accepted-claims-'))
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const relative = (name) => path.relative(root, path.join(directory, name)).replaceAll(path.sep, '/')
    const write = (name, value) => fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
    const runId = 'post-runtime-accepted-claims-run'
    write('terminal.json', currentTerminal(runId))
    return { directory, relative, runId, write }
}

test('publisher derives one exact accepted-claim receipt and independent verifier replays it', (context) =>
{
    const value = fixture(context)
    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'),
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    assert.equal(receipt.schema, 'fsusblog.post-runtime-accepted-claims.v1')
    assert.equal(receipt.status, 'accepted')
    assert.equal(receipt.claims.length, 6)
    assert.ok(receipt.claims.every((entry) => entry.behaviorId === 'browserless-production-correctness'))

    const output = value.relative('accepted-claims.json')
    writePostRuntimeAcceptedClaimsReceipt({
        outputPath: output,
        receipt,
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    assert.deepEqual(
        readAndValidatePostRuntimeAcceptedClaimsReceipt({
            receiptPath: output,
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        receipt)
})

test('CLI produces and verifies a persisted current-run receipt', (context) =>
{
    const value = fixture(context)
    const cli = path.join(root, 'tools/docs/post-runtime-accepted-claims.mjs')
    const output = value.relative('cli-accepted-claims.json')
    const produced = spawnSync(process.execPath, [
        cli,
        'produce',
        '--terminal', value.relative('terminal.json'),
        '--run-id', value.runId,
        '--out', output
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(produced.status, 0, produced.stderr)
    assert.match(produced.stdout,
        /produced run=post-runtime-accepted-claims-run producer=production-correctness-scheduler claims=6/u)

    const verified = spawnSync(process.execPath, [
        cli,
        'verify',
        '--receipt', output,
        '--run-id', value.runId,
        '--producer', 'production-correctness-scheduler'
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(verified.status, 0, verified.stderr)
    assert.match(verified.stdout,
        /verified run=post-runtime-accepted-claims-run producer=production-correctness-scheduler claims=6/u)
})

test('terminal tamper, stale source and wrong producer fail closed', (context) =>
{
    const value = fixture(context)
    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'),
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    value.write('accepted.json', receipt)

    const terminal = JSON.parse(fs.readFileSync(path.join(value.directory, 'terminal.json'), 'utf8'))
    terminal.counts.warnings = 1
    value.write('terminal.json', terminal)
    assert.throws(
        () => readAndValidatePostRuntimeAcceptedClaimsReceipt({
            receiptPath: value.relative('accepted.json'),
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        /file digest mismatch/u
    )

    const staleTerminal = currentTerminal()
    staleTerminal.source.sourceCommit = 'f'.repeat(40)
    value.write('stale-terminal.json', sealTerminal(
        Object.fromEntries(Object.entries(staleTerminal).filter(([key]) => key !== 'contentDigest'))))
    assert.throws(
        () => buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: value.relative('stale-terminal.json'),
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        /current repository state/u
    )
    assert.throws(
        () => buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: value.relative('stale-terminal.json'),
            expectedRunId: value.runId,
            producerId: 'missing-producer',
            repositoryRoot: root
        }),
        /current repository state|unknown post-runtime producer/u
    )
})

test('symlink inputs and output overwrite are rejected without replacing evidence', (context) =>
{
    const value = fixture(context)
    const link = path.join(value.directory, 'terminal-link.json')
    fs.symlinkSync(path.join(value.directory, 'terminal.json'), link)
    assert.throws(
        () => buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: value.relative('terminal-link.json'),
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        /must not contain symlinks/u
    )

    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'),
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    const output = value.relative('terminal-output.json')
    writePostRuntimeAcceptedClaimsReceipt({
        outputPath: output,
        receipt,
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    const before = fs.readFileSync(path.join(root, output), 'utf8')
    assert.throws(
        () => writePostRuntimeAcceptedClaimsReceipt({
            outputPath: output,
            receipt,
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        /already exists/u
    )
    assert.equal(fs.readFileSync(path.join(root, output), 'utf8'), before)
})

test('value verifier rejects a self-resealed claim set not owned by the terminal ledger', (context) =>
{
    const value = fixture(context)
    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'),
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    receipt.claims[0].claimId = 'browserless-production-correctness.unowned'
    const withoutDigest = Object.fromEntries(Object.entries(receipt)
        .filter(([key]) => key !== 'contentDigest'))
    receipt.contentDigest = `sha256:${digestValue(withoutDigest)}`
    assert.throws(
        () => validatePostRuntimeAcceptedClaimsValue({
            receipt,
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        /claim set does not exact-match/u
    )
})

test('missing, wrong and self-resealed cross-run identities fail closed', (context) =>
{
    const value = fixture(context)
    assert.throws(
        () => buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: value.relative('terminal.json'),
            repositoryRoot: root
        }),
        /expected run id is required/u
    )
    assert.throws(
        () => buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: value.relative('terminal.json'),
            expectedRunId: 'wrong-run',
            repositoryRoot: root
        }),
        /runId mismatch/u
    )

    value.write('cross-run-terminal.json', currentTerminal('other-run'))
    assert.throws(
        () => buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: value.relative('cross-run-terminal.json'),
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        /runId mismatch/u
    )

    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'),
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    value.write('accepted.json', receipt)
    assert.throws(
        () => readAndValidatePostRuntimeAcceptedClaimsReceipt({
            receiptPath: value.relative('accepted.json'),
            expectedRunId: 'other-run',
            repositoryRoot: root
        }),
        /runId mismatch/u
    )
})

test('CLI requires an explicit expected run identity for produce and verify', (context) =>
{
    const value = fixture(context)
    const cli = path.join(root, 'tools/docs/post-runtime-accepted-claims.mjs')
    const output = value.relative('missing-run.json')
    const produced = spawnSync(process.execPath, [
        cli,
        'produce',
        '--terminal', value.relative('terminal.json'),
        '--out', output
    ], { cwd: root, encoding: 'utf8' })
    assert.notEqual(produced.status, 0)
    assert.match(produced.stderr, /produce requires --terminal, --run-id and --out/u)

    const verified = spawnSync(process.execPath, [
        cli,
        'verify',
        '--receipt', value.relative('terminal.json')
    ], { cwd: root, encoding: 'utf8' })
    assert.notEqual(verified.status, 0)
    assert.match(verified.stderr, /verify requires --receipt, --run-id/u)
})
