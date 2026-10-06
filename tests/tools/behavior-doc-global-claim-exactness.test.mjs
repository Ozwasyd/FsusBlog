import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
    validateBehaviorDocStaticAdmissionReceipt
} = await import(new URL('../../tools/docs/behavior-doc-static-admission-contract.mjs', import.meta.url));
const {
    behaviorDocGlobalClaimExactnessComponent,
    runBehaviorDocStaticAdmission
} = await import(new URL('../../tools/docs/behavior-doc-static-admission.mjs', import.meta.url));
const { readBehaviorDocStaticAdmissionReceipt } = await import(new URL('../../tools/docs/behavior-doc-static-admission-reader.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../tools/fact-extractors/identity.mjs', import.meta.url));
const { loadRegistry } = await import(new URL('../../tools/fact-extractors/registry.mjs', import.meta.url));
const { beginCurrentRunEvidencePublication } = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));

import { createRuntimeRoleStaticV4Fixture } from './support/runtime-role-minimal-v3-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function seal(value)
{
    const receipt = { ...structuredClone(value), contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

function currentGlobalTerminalFixture(runId)
{
    return seal({ schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1', scopeId: 'global-document-claim-exactness', runId, source: {}, authorityDigests: [], claimAcceptance: [], counts: { generatedClaimCount: 0, proseClaimCount: 0, warnings: 0, missing: 0, extra: 0, residue: 0, generatedSectionDrifts: 0, proseVerified: 0, proseTotal: 0 }, mutationAggregate: { killed: 0, total: 0 }, residue: [], proseVerification: {}, status: 'ok', failureReasons: [] });
}

function validAdmissionReceipt()
{
    return createRuntimeRoleStaticV4Fixture('pure-behavior-doc-contract', {
        sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64)
    }, { repositoryRoot: root, extractorIds: loadRegistry(
        path.join(root, 'config/contracts/behavior-fact-extractors.json')
    ).extractors.map((extractor) => extractor.id) });
}

test('pure BehaviorDoc contract reads exact receipt and fails closed on missing or tampered input', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-behavior-doc-contract-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const receiptPath = path.join(directory, 'receipt.json');
    const receipt = validAdmissionReceipt();
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    assert.deepEqual(readBehaviorDocStaticAdmissionReceipt(receiptPath, {
        expectedRunId: receipt.run.id,
        expectedSourceIdentity: {
            sourceCommit: receipt.source.commit,
            worktreeFingerprint: receipt.source.worktreeFingerprint
        },
        expectedWorktree: root
    }), receipt);
    assert.throws(
        () => readBehaviorDocStaticAdmissionReceipt(path.join(directory, 'missing.json')),
        /receipt is missing/u
    );

    receipt.generated.documentCount += 1;
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.throws(
        () => readBehaviorDocStaticAdmissionReceipt(receiptPath),
        /content digest mismatch/u
    );
});

test('pure BehaviorDoc contract rejects unknown schema and stale caller identity', () =>
{
    const receipt = validAdmissionReceipt();
    assert.throws(
        () => validateBehaviorDocStaticAdmissionReceipt(seal({
            ...receipt,
            schema: 'fsusblog.behavior-doc-static-admission-receipt.v999'
        })),
        /schema must be/u
    );
    assert.throws(
        () => validateBehaviorDocStaticAdmissionReceipt(receipt, {
            expectedSourceIdentity: {
                sourceCommit: 'f'.repeat(40),
                worktreeFingerprint: receipt.source.worktreeFingerprint
            }
        }),
        /source\/worktree identity mismatch/u
    );
});

test('pure BehaviorDoc contract rejects self-resealed scalar type forgeries', () =>
{
    const mutations = [
        (receipt) =>
        {
            receipt.implementationOwner.bindingCount = '2';
        },
        (receipt) =>
        {
            receipt.generated.documentCount = '0';
        },
        (receipt) =>
        {
            receipt.prose.verifiedClaimCount = '2';
        },
        (receipt) =>
        {
            receipt.mutationFixtures.caseCount = '1';
        },
        (receipt) =>
        {
            receipt.durationMs = '1';
        },
        (receipt) =>
        {
            receipt.toolchain.node = 24;
        }
    ];
    for (const mutate of mutations)
    {
        const forged = structuredClone(validAdmissionReceipt());
        mutate(forged);
        forged.contentDigest = null;
        forged.contentDigest = digestValue(forged);
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(forged));
    }
});

test('aggregate-only BehaviorDoc consumers import the pure contract authority', () =>
{
    for (const relative of [
        'tools/test-matrix/scheduler.mjs',
        'tools/docs/auth-security-doc-exactness.mjs',
        'tests/tools/test-matrix-scheduler.test.mjs',
        'tests/tools/support/behavior-doc-admission-fixture.mjs'
    ])
    {
        const source = fs.readFileSync(path.join(root, relative), 'utf8');
        assert.match(source, /behavior-doc-static-admission-reader\.mjs/u, relative);
        assert.doesNotMatch(source, /behavior-doc-static-admission\.mjs/u, relative);
    }
    for (const relative of [
        'tools/docs/behavior-doc-static-admission-contract.mjs',
        'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs'
    ])
    {
        const source = fs.readFileSync(path.join(root, relative), 'utf8');
        assert.doesNotMatch(
            source,
            /node:child_process|\/scanner\.mjs|\/runner\.mjs|behavior-doc-static-admission\.mjs|behavior-doc-minimal-contract-build\.mjs/u,
            relative
        );
    }
});

test('BehaviorDoc admission removes stale global terminal before any fail-closed exit', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-claim-admission-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.copyFileSync(path.join(root, 'Directory.Build.props'), path.join(directory, 'Directory.Build.props'));
    for (const args of [['init', '--quiet'], ['add', 'Directory.Build.props'], ['-c', 'user.name=Source control fixture', '-c', 'user.email=source-fixture@example.invalid', 'commit', '--quiet', '-m', 'Owned source identity fixture']])
    {
        execFileSync('git', args, { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    }
    const componentsDirectory = path.join(directory, 'components');
    const terminal = path.join(componentsDirectory, behaviorDocGlobalClaimExactnessComponent);
    fs.mkdirSync(componentsDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(terminal, JSON.stringify(currentGlobalTerminalFixture('global-claim-stale-terminal')));

    await assert.rejects(
        runBehaviorDocStaticAdmission({
            repositoryRoot: directory,
            runId: 'global-claim-stale-terminal',
            outputFile: path.join(directory, 'admission.json'),
            componentsDirectory,
            candidateSpawnCountBeforeReceipt: 1
        }),
        /candidate process spawned before BehaviorDoc admission/u
    );
    assert.equal(fs.existsSync(terminal), false);
    const admission = JSON.parse(fs.readFileSync(path.join(directory, 'admission.json'), 'utf8'));
    assert.equal(admission.status, 'failed');
    assert.equal(admission.candidateSpawnCountBeforeReceipt, 1);
});


test('global terminal invalidation retains aliases and unknown neighboring outputs', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-claim-retention-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const componentsDirectory = path.join(directory, 'components');
    fs.mkdirSync(componentsDirectory, { mode: 0o700 });
    const terminal = path.join(componentsDirectory, behaviorDocGlobalClaimExactnessComponent);
    const unknown = path.join(componentsDirectory, 'unknown-retained.json');
    fs.writeFileSync(unknown, 'retained');
    for (const alias of ['symlink', 'hardlink', 'directory'])
    {
        if (alias === 'symlink')
        {
            fs.symlinkSync(unknown, terminal);
        }
        else if (alias === 'hardlink')
        {
            fs.linkSync(unknown, terminal);
        }
        else
        {
            fs.mkdirSync(terminal);
        }
        await assert.rejects(runBehaviorDocStaticAdmission({ repositoryRoot: directory, componentsDirectory }), /current owned regular output/u);
        assert.equal(fs.readFileSync(unknown, 'utf8'), 'retained');
        assert.ok(fs.lstatSync(terminal));
        if (alias === 'directory')
        {
            fs.rmdirSync(terminal);
        }
        else
        {
            fs.unlinkSync(terminal);
        }
    }
});


test('admission preserves unknown regular terminals and refuses an already reserved output', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-claim-unknown-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const terminal = path.join(directory, behaviorDocGlobalClaimExactnessComponent);
    fs.writeFileSync(terminal, '{"unknown":"retained"}');
    await assert.rejects(runBehaviorDocStaticAdmission({ repositoryRoot: directory, componentsDirectory: directory, runId: 'current-task' }), /unexpected global exactness schema/u);
    assert.equal(fs.readFileSync(terminal, 'utf8'), '{"unknown":"retained"}');
    const lock = path.join(directory, '.behavior-doc-admission-writer.lock');
    fs.writeFileSync(lock, 'retained existing reservation');
    await assert.rejects(runBehaviorDocStaticAdmission({ repositoryRoot: directory, componentsDirectory: directory, runId: 'current-task' }), /EEXIST/u);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'retained existing reservation');
    assert.equal(fs.readFileSync(terminal, 'utf8'), '{"unknown":"retained"}');
});


test('global terminal invalidation preserves a sealed terminal belonging to another task run', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-claim-other-run-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const terminal = path.join(directory, behaviorDocGlobalClaimExactnessComponent);
    const retained = JSON.stringify(currentGlobalTerminalFixture('another-task'));
    fs.writeFileSync(terminal, retained);
    await assert.rejects(runBehaviorDocStaticAdmission({ repositoryRoot: directory, componentsDirectory: directory, runId: 'current-task' }), /global exactness runId mismatch/u);
    assert.equal(fs.readFileSync(terminal, 'utf8'), retained);
    assert.equal(fs.existsSync(path.join(directory, '.behavior-doc-admission-writer.lock')), false);
});

test('admission rejects an actual output reservation epoch change before releasing its writer', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-global-claim-reservation-epoch-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.copyFileSync(path.join(root, 'Directory.Build.props'), path.join(directory, 'Directory.Build.props'));
    for (const args of [['init', '--quiet'], ['add', 'Directory.Build.props'], ['-c', 'user.name=Source control fixture', '-c', 'user.email=source-fixture@example.invalid', 'commit', '--quiet', '-m', 'Owned source identity fixture']])
    {
        execFileSync('git', args, { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    }
    const componentsDirectory = path.join(directory, 'components');
    const pending = runBehaviorDocStaticAdmission({ repositoryRoot: directory, componentsDirectory, outputFile: path.join(directory, 'admission.json'), runId: 'reservation-epoch', candidateSpawnCountBeforeReceipt: 1 });
    const lock = path.join(componentsDirectory, '.behavior-doc-admission-writer.lock');
    fs.utimesSync(lock, 1, 1);
    await assert.rejects(pending, error => error instanceof AggregateError
        && error.errors.some(cause => /candidate process spawned before BehaviorDoc admission/u.test(cause.message))
        && error.errors.some(cause => /output reservation changed/u.test(cause.message)));
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.statSync(lock).mtimeMs, 1000);
});


function unqualifiedGlobalPublicationCounterfixture(context)
{
    const directory = fs.mkdtempSync(path.join(root, '.tmp/global-terminal-counterfixture-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const relative = (file) => path.relative(root, path.join(directory, file)).replaceAll(path.sep, '/');
    const body = { schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'current-global-run',
        attemptId: 'attempt-0001', sourceCommit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        candidateIdentity: { id: 'source-counterfixture-candidate', digest: `sha256:${'c'.repeat(64)}` },
        buildIdentity: { id: 'source-counterfixture-build', digest: `sha256:${'d'.repeat(64)}` },
        ownedRoots: [path.relative(root, directory).replaceAll(path.sep, '/')] };
    const fileContext = { ...body, contentDigest: governanceContentDigest(body) };
    fs.writeFileSync(path.join(directory, 'context.json'), JSON.stringify(fileContext));
    // This is only an original prepared-state DATA counterfixture. No terminal,
    // reference, handoff, native grant, hook finalization or qualified facts exist.
    beginCurrentRunEvidencePublication({ authorityId: 'evidence-consumer.docs.global-claim-exactness-final.current-run',
        producerId: 'evidence-consumer.docs.global-claim-exactness-final.producer', context: fileContext,
        outputPath: relative('reference.json'), payloadPath: relative('payload.json'), repositoryRoot: root });
    const environment = { ...process.env, FSUSBLOG_TEST_RUN_ID: body.schedulerRunId,
        FSUSBLOG_TEST_SOURCE_COMMIT: body.sourceCommit, FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64),
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER: 'evidence-consumer.docs.global-claim-exactness-final',
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: relative('context.json'),
        FSUSBLOG_DOCS_GLOBAL_CLAIM_EXACTNESS_FINAL_EVIDENCE_PATH: relative('reference.json'),
        FSUSBLOG_DOCS_GLOBAL_CLAIM_EXACTNESS_FINAL_EVIDENCE_PAYLOAD_PATH: relative('payload.json') };
    return { directory, relative, environment, fileContext };
}

function invokeGlobalSourceCounterfixture(fixture, args, environment = fixture.environment)
{
    return spawnSync(process.execPath, [path.join(root, 'tools/docs/global-claim-exactness-final.mjs'), ...args],
        { cwd: root, encoding: 'utf8', env: environment });
}

test('global terminal CLI refuses malformed flags and foreign prepared-session run/source before payload effects', (context) =>
{
    const fixture = unqualifiedGlobalPublicationCounterfixture(context);
    const args = ['--receipts', fixture.relative('must-not-read-observations'), '--out', fixture.relative('payload.json')];
    for (const variant of [args.concat('--out', fixture.relative('foreign.json')), args.concat('--grant', 'true')])
    {
        const result = invokeGlobalSourceCounterfixture(fixture, variant);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unique closed --receipts and --out/u);
        assert.equal(result.stdout, '');
    }
    for (const [key, value] of [['FSUSBLOG_TEST_RUN_ID', 'foreign-run'], ['FSUSBLOG_TEST_SOURCE_COMMIT', 'e'.repeat(40)], ['FSUSBLOG_TEST_SOURCE_FINGERPRINT', 'f'.repeat(64)]])
    {
        const result = invokeGlobalSourceCounterfixture(fixture, args, { ...fixture.environment, [key]: value });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /run\/source differs from the original prepared publication session/u);
        assert.equal(result.stdout, '');
    }
    assert.equal(fs.existsSync(path.join(fixture.directory, 'payload.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.directory, 'reference.json')), false);
});

test('global terminal CLI rejects a resealed replacement context and preserves existing or aliased payloads', (context) =>
{
    const fixture = unqualifiedGlobalPublicationCounterfixture(context);
    const args = ['--receipts', fixture.relative('must-not-read-observations'), '--out', fixture.relative('payload.json')];
    const replacement = { ...fixture.fileContext, candidateIdentity: { id: 'foreign-candidate', digest: `sha256:${'e'.repeat(64)}` } };
    replacement.contentDigest = governanceContentDigest(replacement);
    fs.writeFileSync(path.join(fixture.directory, 'context.json'), JSON.stringify(replacement));
    const drift = invokeGlobalSourceCounterfixture(fixture, args);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /context differs from the original prepared publication session/u);
    fs.writeFileSync(path.join(fixture.directory, 'context.json'), JSON.stringify(fixture.fileContext));
    const retained = path.join(fixture.directory, 'payload.json');
    fs.writeFileSync(retained, 'unknown retained file');
    const existing = invokeGlobalSourceCounterfixture(fixture, args);
    assert.equal(existing.status, 1);
    assert.match(existing.stderr, /payload already exists/u);
    assert.equal(fs.readFileSync(retained, 'utf8'), 'unknown retained file');
    fs.renameSync(retained, path.join(fixture.directory, 'unknown.json'));
    fs.symlinkSync('unknown.json', retained);
    const alias = invokeGlobalSourceCounterfixture(fixture, args);
    assert.equal(alias.status, 1);
    assert.match(alias.stderr, /payload already exists/u);
    assert.equal(fs.lstatSync(retained).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(fixture.directory, 'unknown.json'), 'utf8'), 'unknown retained file');
    assert.equal(fs.existsSync(path.join(fixture.directory, 'reference.json')), false);
});

test('pre-runtime source caller retains the asserted join and refuses missing registered terminal bindings before outputs', (context) =>
{
    const directory = fs.mkdtempSync(path.join(root, '.tmp/global-caller-source-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'must-not-create');
    const environment = { ...process.env, FSUSBLOG_TEST_RUN_ID: 'source-counterfixture-run',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40), FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64),
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: '', FSUSBLOG_BEHAVIOR_EVIDENCE_PRE_RUNTIME_OUT: output };
    delete environment.BASH_ENV;
    const result = spawnSync('bash', [path.join(root, 'tools/test/bundles/behavior-evidence-pre-runtime.sh')],
        { cwd: root, encoding: 'utf8', env: environment });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT is required/u);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(output), false);
    const source = fs.readFileSync(path.join(root, 'tools/test/bundles/behavior-evidence-pre-runtime.sh'), 'utf8');
    const invocation = source.indexOf('FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER=evidence-consumer.docs.global-claim-exactness-final');
    assert.ok(invocation > source.indexOf('--assert'));
    assert.match(source.slice(invocation), /--import "\$ROOT_DIR\/tools\/test\/current-run-evidence-producer-hook\.mjs"/u);
    assert.match(source.slice(invocation), /--receipts "\$FACT_OBSERVATIONS_DIR"/u);
    assert.match(source.slice(invocation), /--out "\$GLOBAL_PAYLOAD"/u);
    assert.doesNotMatch(source.slice(invocation), /--out "\$GLOBAL_REFERENCE"/u);
});

test('global terminal CLI reaches original observation admission from matched prepared data and keeps terminal absent on missing facts', (context) =>
{
    const fixture = unqualifiedGlobalPublicationCounterfixture(context);
    const observations = path.join(fixture.directory, 'observations');
    fs.mkdirSync(observations, { mode: 0o700 });
    const result = invokeGlobalSourceCounterfixture(fixture, ['--receipts', fixture.relative('observations'), '--out', fixture.relative('payload.json')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /current observations are missing/u);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(fixture.directory, 'payload.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.directory, 'reference.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.directory, 'reference.json.handoff.json')), false);
});
