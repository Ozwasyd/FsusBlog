import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import {
    buildPostRuntimeAcceptedClaimsReceipt,
    readAndValidatePostRuntimeAcceptedClaimsReceipt,
    root as sourceRoot,
    validatePostRuntimeAcceptedClaimsValue,
    writePostRuntimeAcceptedClaimsReceipt
} from '../../tools/docs/post-runtime-accepted-claims.mjs'

const byteDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function sealTerminal(value)
{
    const receipt = { ...value, contentDigest: null }
    receipt.contentDigest = digestValue(receipt)
    return receipt
}

function currentTerminal(runId, root)
{
    const source = sealSourceIdentity(root)
    const migrationLedger = JSON.parse(fs.readFileSync(
        path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
    const claimAcceptance = migrationLedger.scopes.flatMap((scope) => scope.entries.flatMap((entry) =>
        entry.claimIds.map((claimId, index) => ({
            claimId, behaviorId: entry.behaviorId, scopeId: scope.scopeId,
            documentPath: entry.documentPath,
            claimType: entry.generatedSectionIds[index] ? 'generated-section' : 'prose',
            generatedSectionId: entry.generatedSectionIds[index] ?? null,
            claimDigest: `sha256:${digestValue({ claimId })}`
        })))).sort((left, right) => left.claimId.localeCompare(right.claimId))
    const generatedClaimCount = claimAcceptance.filter((claim) => claim.claimType === 'generated-section').length
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
        claimAcceptance,
        counts: {
            requiredBehaviors: 9,
            scopes: 6,
            ledgerEntries: 43,
            generatedClaimCount,
            proseClaimCount: claimAcceptance.length - generatedClaimCount,
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

function fixture(context, { publishWithHook = false } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-runtime-accepted-claims-'))
    const repositoryRoot = root
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    for (const file of ['config/contracts/behavior-contracts.json',
        'config/contracts/document-claim-migration-ledger.json',
        'config/testing/post-runtime-producer-registry.json',
        'config/testing/evidence-locator-registry.json',
        'config/schemas/post-runtime-accepted-claims.schema.json',
        'config/schemas/post-runtime-observation-result.schema.json',
        'config/configuration-ownership.json',
        'tools/test-matrix/post-runtime-producer-registry.mjs',
        'tools/test-matrix/parse-matrix.mjs',
        'tools/run-test-matrix.mjs',
        'tools/test/lanes/production-correctness-receipt.sh',
        'tools/test/current-run-evidence-producer-hook.mjs',
        'tools/test/run-current-run-evidence-producer.mjs',
        'tools/test/current-run-evidence-publication.mjs',
        'tools/test/current-run-evidence-locator.mjs',
        'tools/test/evidence-location-contract.mjs',
        'tools/yaml/parse-document.mjs',
        'tests/matrix.yml',
        'config/testing/correctness-attempt-producers.json',
        'config/testing/fixture-profile-catalog.json',
        'tools/fact-extractors/lib/canonicalize.mjs'])
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.copyFileSync(path.join(sourceRoot, file), path.join(root, file))
    }
    fs.copyFileSync(path.join(sourceRoot, '.gitignore'), path.join(root, '.gitignore'))
    for (const args of [['init', '-q'], ['add', '.'],
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']])
    {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
    }
    const runId = 'post-runtime-accepted-claims-run'
    const authority = JSON.parse(fs.readFileSync(path.join(root,
        'config/testing/post-runtime-producer-registry.json'), 'utf8')).receiptSemantics.acceptedTerminalAuthority
    const directory = path.join(root, authority.referenceRoot, runId, 'attempt-0001')
    fs.mkdirSync(directory, { recursive: true })
    const mapped = (name) => name === 'terminal.json' ? authority.referenceName : name
    const relative = (name) => path.relative(root, path.join(directory, mapped(name))).replaceAll(path.sep, '/')
    const write = (name, value) =>
    {
        if (value.schema !== 'fsusblog.global-claim-exactness-terminal-receipt.v1')
        {
            fs.writeFileSync(path.join(directory, mapped(name)), `${JSON.stringify(value, null, 2)}\n`)
            return
        }
        const bytes = `${JSON.stringify(value, null, 2)}\n`
        const payloadPath = relative(authority.payloadName)
        fs.writeFileSync(path.join(root, payloadPath), bytes)
        const body = {
            schema: authority.referenceSchema, schedulerRunId: value.runId, attemptId: 'attempt-0001',
            sourceCommit: value.source.sourceCommit, worktreeFingerprint: value.source.worktreeFingerprint,
            candidateIdentity: { candidateId: 'fixture' }, buildIdentity: { buildId: 'fixture' },
            authorityId: authority.authorityId, producerId: authority.producerId,
            payload: { path: payloadPath, schema: value.schema, digest: byteDigest(bytes) }
        }
        const sealed = { ...body, contentDigest: `sha256:${digestValue(body)}` }
        const reference = { ...sealed, producerReceiptDigest: `sha256:${digestValue(sealed)}` }
        fs.writeFileSync(path.join(directory, mapped(name)), `${JSON.stringify(reference, null, 2)}\n`)
    }
    const terminal = currentTerminal(runId, root)
    if (publishWithHook)
    {
        const sourceBefore = sealSourceIdentity(root)
        const sourceEnvironment = {
            ...process.env,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceBefore.sourceCommit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceBefore.worktreeFingerprint
        }
        const collected = spawnSync(process.execPath, ['--input-type=module', '-e',
            `import { collectSchedulerSourceState } from ${JSON.stringify(path.join(sourceRoot, 'tools/test-matrix/scheduler.mjs'))}; console.log(JSON.stringify(await collectSchedulerSourceState(${JSON.stringify(root)})));`
        ], { cwd: root, env: sourceEnvironment, encoding: 'utf8' })
        assert.equal(collected.status, 0, collected.stderr)
        const schedulerIdentity = JSON.parse(collected.stdout)
        assert.equal(schedulerIdentity.sourceState.commit, sourceBefore.sourceCommit)
        assert.equal(schedulerIdentity.sourceState.worktreeFingerprint, sourceBefore.worktreeFingerprint)
        assert.notEqual(schedulerIdentity.snapshot.fingerprint, sourceBefore.worktreeFingerprint)
        const evidenceContext = {
            schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId,
            attemptId: 'attempt-0001', sourceCommit: schedulerIdentity.sourceState.commit,
            worktreeFingerprint: `sha256:${schedulerIdentity.sourceState.worktreeFingerprint}`,
            candidateIdentity: { id: 'candidate-fixture', digest: `sha256:${'1'.repeat(64)}` },
            buildIdentity: { id: 'build-fixture', digest: `sha256:${'2'.repeat(64)}` },
            ownedRoots: [path.relative(root, directory).replaceAll(path.sep, '/')]
        }
        evidenceContext.contentDigest = `sha256:${digestValue(evidenceContext)}`
        write('context.json', evidenceContext)
        const registry = JSON.parse(fs.readFileSync(path.join(root,
            'config/testing/evidence-locator-registry.json'), 'utf8'))
        const entry = registry.entries.find((candidate) => candidate.authorityId === authority.authorityId)
        assert.ok(entry)
        const result = spawnSync(process.execPath, [
            '--import', path.join(root, 'tools/test/current-run-evidence-producer-hook.mjs'),
            '--input-type=module', '-e',
            `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(relative(authority.payloadName))}, JSON.stringify(${JSON.stringify(terminal)}, null, 2) + '\\n');`
        ], {
            cwd: root, encoding: 'utf8',
            env: {
                ...sourceEnvironment,
                FSUSBLOG_CURRENT_RUN_EVIDENCE_HOOK_OWNER_PID: '',
                FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER: entry.consumerId,
                FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: relative('context.json'),
                [entry.outputBindingKey]: relative('terminal.json'),
                [entry.payloadBindingKey]: relative(authority.payloadName)
            }
        })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /FSUSBLOG_CURRENT_RUN_EVIDENCE_HANDOFF=/u)
        assert.deepEqual(sealSourceIdentity(root), sourceBefore)
    }
    else write('terminal.json', terminal)
    fs.writeFileSync(path.join(directory, 'cli.mjs'),
        `import { runPostRuntimeAcceptedClaimsCli } from ${JSON.stringify(path.join(sourceRoot, 'tools/docs/post-runtime-accepted-claims.mjs'))};\nrunPostRuntimeAcceptedClaimsCli(process.argv.slice(2), ${JSON.stringify(root)});\n`)
    return { repositoryRoot, directory, relative, runId, write }
}

test('publisher derives one exact accepted-claim receipt and independent verifier replays it', (context) =>
{
    const value = fixture(context)
    const { repositoryRoot: root } = value
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
    const { repositoryRoot: root } = value
    const cli = path.join(value.directory, 'cli.mjs')
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
    const { repositoryRoot: root } = value
    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'),
        expectedRunId: value.runId,
        repositoryRoot: root
    })
    value.write('accepted.json', receipt)

    const terminal = currentTerminal(value.runId, root)
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

    const staleTerminal = currentTerminal(value.runId, root)
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
    const { repositoryRoot: root } = value
    const link = path.join(value.directory, 'terminal-link.json')
    fs.symlinkSync(path.join(root, value.relative('terminal.json')), link)
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
    const { repositoryRoot: root } = value
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
    const { repositoryRoot: root } = value
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

    value.write('cross-run-terminal.json', currentTerminal('other-run', root))
    assert.throws(
        () => buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: value.relative('cross-run-terminal.json'),
            expectedRunId: value.runId,
            repositoryRoot: root
        }),
        /runId mismatch/u
    )

    value.write('terminal.json', currentTerminal(value.runId, root))

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
    const { repositoryRoot: root } = value
    const cli = path.join(value.directory, 'cli.mjs')
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

test('resealed scheduler, attempt, candidate, build and registry identity substitutions fail closed', (context) =>
{
    const value = fixture(context)
    const { repositoryRoot: root } = value
    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'), expectedRunId: value.runId, repositoryRoot: root
    })
    for (const mutate of [
        (copy) => { copy.sourceState.schedulerRunId = 'different-run' },
        (copy) => { copy.sourceState.attemptId = 'attempt-0002' },
        (copy) => { copy.sourceState.candidateIdentityDigest = `sha256:${'a'.repeat(64)}` },
        (copy) => { copy.sourceState.buildIdentityDigest = `sha256:${'b'.repeat(64)}` },
        (copy) => { copy.registryDigest = `sha256:${'c'.repeat(64)}` },
        (copy) => { copy.claimsSchemaDigest = `sha256:${'d'.repeat(64)}` },
        (copy) => { delete copy.registryDigest },
        (copy) => { delete copy.claimsSchemaDigest },
        (copy) => { delete copy.sourceState.candidateIdentityDigest },
        (copy) => { delete copy.terminalReceiptRef.payloadPath },
        (copy) => { copy.terminalReceiptRef.path = copy.terminalReceiptRef.payloadPath },
        (copy) => { copy.terminalReceiptRef.payloadPath = copy.terminalReceiptRef.path },
        (copy) => { copy.terminalReceiptRef.payloadFileDigest = `sha256:${'e'.repeat(64)}` },
        (copy) => { copy.terminalReceiptRef.producerCommand = 'node tools/unregistered.mjs' }
    ])
    {
        const copy = structuredClone(receipt)
        mutate(copy)
        delete copy.contentDigest
        copy.contentDigest = `sha256:${digestValue(copy)}`
        assert.throws(() => validatePostRuntimeAcceptedClaimsValue({
            receipt: copy, expectedRunId: value.runId, repositoryRoot: root
        }))
    }
})

test('invalid publication and duplicate CLI identities cannot create output', (context) =>
{
    const value = fixture(context)
    const { repositoryRoot: root } = value
    const receipt = buildPostRuntimeAcceptedClaimsReceipt({
        terminalReceiptPath: value.relative('terminal.json'), expectedRunId: value.runId, repositoryRoot: root
    })
    const outputPath = value.relative('invalid.json')
    receipt.status = 'prepared'
    assert.throws(() => writePostRuntimeAcceptedClaimsReceipt({
        outputPath, receipt, expectedRunId: value.runId, repositoryRoot: root
    }))
    assert.equal(fs.existsSync(path.join(root, outputPath)), false)
    const duplicate = spawnSync(process.execPath, [path.join(value.directory, 'cli.mjs'),
        'produce', '--terminal', value.relative('terminal.json'), '--run-id', value.runId,
        '--run-id', 'other', '--out', outputPath], { cwd: root, encoding: 'utf8' })
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr, /duplicate option --run-id/u)
    assert.equal(fs.existsSync(path.join(root, outputPath)), false)
})

test('registered real process hook publishes context-bound reference consumed by accepted-claims CLI', (context) =>
{
    const value = fixture(context, { publishWithHook: true })
    const { repositoryRoot: root } = value
    const cli = path.join(value.directory, 'cli.mjs')
    const output = value.relative('hook-accepted.json')
    const produced = spawnSync(process.execPath, [cli, 'produce',
        '--terminal', value.relative('terminal.json'), '--run-id', value.runId, '--out', output],
    { cwd: root, encoding: 'utf8' })
    assert.equal(produced.status, 0, produced.stderr)
    const verified = spawnSync(process.execPath, [cli, 'verify', '--receipt', output,
        '--run-id', value.runId], { cwd: root, encoding: 'utf8' })
    assert.equal(verified.status, 0, verified.stderr)
    const receipt = JSON.parse(fs.readFileSync(path.join(root, output), 'utf8'))
    assert.equal(receipt.sourceState.schedulerRunId, value.runId)
    assert.equal(receipt.sourceState.attemptId, 'attempt-0001')
    fs.writeFileSync(path.join(root, 'unexpected-source.mjs'), 'export const changed = true\n')
    const stale = spawnSync(process.execPath, [cli, 'verify', '--receipt', output,
        '--run-id', value.runId], { cwd: root, encoding: 'utf8' })
    assert.notEqual(stale.status, 0)
    assert.match(stale.stderr, /current repository state/u)
})
