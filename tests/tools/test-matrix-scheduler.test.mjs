import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scheduler = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { validateBehaviorDocStaticAdmissionReceipt } = await import(new URL("../../tools/docs/behavior-doc-static-admission.mjs", import.meta.url));
const { sealSourceIdentity } = await import(new URL("../../tools/fact-extractors/identity.mjs", import.meta.url));
const { currentProcessIdentity } = await import(new URL("../../tools/test/process-identity.mjs", import.meta.url));
const { createArtifactDigestTable } = await import(new URL("../../tools/test-matrix/artifact-digest-table.mjs", import.meta.url));
const { RunEvidenceObjectStore } = await import(new URL("../../tools/test-matrix/content-addressed-evidence-store.mjs", import.meta.url));
const { artifactSubstitutionBindingDigest, digestDeclaredOutputs, externalEvidenceReceiptDigest, resolveExternalEvidenceReceipts } = await import(new URL("../../tools/test-matrix/local-profile.mjs", import.meta.url));
const { parseMatrix } = await import(new URL("../../tools/test-matrix/parse-matrix.mjs", import.meta.url));
const { bindResidentLeaseEnforcement, consumeResidentLeaseHandoff, createResidentLeaseInventory, readResidentLeaseDocument, writeResidentLeaseDocument } = await import(new URL("../../tools/test-matrix/resident-resource-leases.mjs", import.meta.url));
const { createSchedulerRunOwner, schedulerCandidateIdentityDigest, sealSchedulerRunOwner } = await import(new URL("../../tools/test-matrix/scheduler-run-owner.mjs", import.meta.url));
const runOnce = await import(new URL("../../tools/test/run-once.mjs", import.meta.url));
const temporal = await import(new URL("../../tools/test/temporal-context.mjs", import.meta.url));

import { runActiveJsonProbe } from './support/active-json-probe.mjs';
import {
    createBehaviorDocAdmissionFixture,
    prepareBehaviorDocAdmissionFixtureAuthority
} from './support/behavior-doc-admission-fixture.mjs';
import {
    assertAllowedRootBoundary,
    assertMissingDependencyDiagnostic,
    assertTransitiveMaterialization,
    materializeTestMatrixRunner
} from './support/esm-fixture-materializer-contracts.mjs';
import { materializeEsmFixture, preflightMaterializedEsmFixture } from './support/esm-fixture-materializer.mjs';
import { provisionLockedSchemaValidator } from './support/locked-schema-validator-fixture.mjs';
import { posixCancellationFailureSource } from './support/posix-cancellation-fixture.mjs';
import { prepareSchedulerCliMatrixFixture } from './support/scheduler-cli-fixture.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const schedulerFile = path.join(root, 'tools/test-matrix/scheduler.mjs');

test('scheduler source snapshot excludes owned current-run outputs but detects source drift', async (t) =>
{
    const { snapshotSourceState } = scheduler;
    const repository = createTempDir('current-run-scheduler-source');
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
    git('init', '--quiet');
    fs.copyFileSync(path.join(root, '.gitignore'), path.join(repository, '.gitignore'));
    fs.writeFileSync(path.join(repository, 'source.txt'), 'source-before');
    git('add', '.gitignore', 'source.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const before = await snapshotSourceState(repository);
    const output = path.join(repository, 'artifacts/current-run/run-1/attempt-1/receipt.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, '{"status":"prepared"}');
    assert.deepEqual(await snapshotSourceState(repository), before);
    fs.writeFileSync(output, '{"status":"verified"}');
    assert.deepEqual(await snapshotSourceState(repository), before);
    assert.match(git('check-ignore', 'artifacts/current-run/run-1/attempt-1/receipt.json'), /receipt\.json/u);

    for (const relative of ['untracked-source.txt', 'artifacts/authority.json', 'nested/artifacts/current-run/source.json'])
    {
        const file = path.join(repository, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'source-after');
        assert.notEqual((await snapshotSourceState(repository)).worktreeFingerprint, before.worktreeFingerprint, relative);
        fs.rmSync(file);
        assert.deepEqual(await snapshotSourceState(repository), before);
    }
    fs.writeFileSync(path.join(repository, 'source.txt'), 'source-after');
    assert.notEqual((await snapshotSourceState(repository)).worktreeFingerprint, before.worktreeFingerprint);
    fs.writeFileSync(path.join(repository, 'source.txt'), 'source-before');
    git('add', '-f', 'artifacts/current-run/run-1/attempt-1/receipt.json');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'tracked output fixture');
    const tracked = await snapshotSourceState(repository);
    fs.writeFileSync(output, '{"status":"tampered"}');
    assert.notEqual((await snapshotSourceState(repository)).worktreeFingerprint, tracked.worktreeFingerprint);
});

async function loadScheduler()
{
    return scheduler;
}

function createTempDir(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`));
}

function createRunnerFixture(temp)
{
    const runner = materializeTestMatrixRunner(root, temp);
    fs.mkdirSync(path.join(temp, 'tools/fixtures'), { recursive: true });
    return commitRunnerFixture(temp, runner);
}

function sealRunnerFixture(temp, matrixFile)
{
    prepareSchedulerCliMatrixFixture(root, temp, matrixFile);
    return commitRunnerFixture(temp, path.join(temp, 'tools/run-test-matrix.mjs'));
}

function commitRunnerFixture(temp, runner)
{
    if (!fs.existsSync(path.join(temp, '.git')))
    {
        execFileSync('git', ['init', '--quiet'], { cwd: temp });
    }
    const ignoreFile = path.join(temp, '.gitignore');
    fs.writeFileSync(ignoreFile, [
        '/*',
        '!/.gitignore',
        '!/.github/',
        '!/config/',
        '!/tools/',
        '!/tests/'
    ].join('\n') + '\n');
    prepareBehaviorDocAdmissionFixtureAuthority({
        sourceRepositoryRoot: root,
        repositoryRoot: temp
    });
    execFileSync('git', ['add', '--all', '--', '.gitignore', '.github', 'config', 'tools', 'tests'], {
        cwd: temp
    });
    execFileSync(
        'git',
        [
            '-c', 'user.name=Test',
            '-c', 'user.email=test@example.invalid',
            '-c', 'commit.gpgsign=false',
            'commit', '--quiet', '--allow-empty', '-m', 'fixture'
        ],
        { cwd: temp }
    );
    const admission = createBehaviorDocAdmissionFixture({
        sourceRepositoryRoot: root,
        repositoryRoot: temp
    });
    const wrapper = path.join(temp, '.tmp', 'fixture-runner.mjs');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, [
        `process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT = ${JSON.stringify(admission.receiptFile)}`,
        `process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST = ${JSON.stringify(admission.contentDigest)}`,
        `process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID = ${JSON.stringify(admission.runId)}`,
        `process.argv[1] = ${JSON.stringify(runner)}`,
        `await import(${JSON.stringify(pathToFileURL(runner).href)})`
    ].join('\n'));
    return wrapper;
}

function createCanonicalCliFixture(temp, payloads, configureTier = () =>
{
}, options = {})
{
    assert.deepEqual(fs.readdirSync(temp), [], 'scheduler CLI fixture must start isolated and empty');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-hardlinks',
        '--no-checkout', '--', root, temp], { cwd: root });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', revision],
        { cwd: temp });
    const runner = materializeTestMatrixRunner(root, temp);
    const matrix = parseMatrix(fs.readFileSync(path.join(temp, 'tests/matrix.yml'), 'utf8'));
    const scripts = typeof payloads === 'string'
        ? { 'ux-viewport-plan-progress': payloads }
        : payloads;
    const tierIds = Object.keys(scripts);
    assert.ok(tierIds.length >= 1 && tierIds.length <= 2);
    for (const tierId of tierIds)
    {
        const selected = matrix.tiers.find((entry) => entry.id === tierId);
        assert.ok(selected);
        assert.match(selected.command, /^(?:node tools\/[a-z0-9/-]+\.mjs|tools\/test\/lanes\/[a-z0-9-]+\.sh)$/u);
        const commandPath = selected.command.startsWith('node ')
            ? selected.command.slice('node '.length)
            : selected.command;
        fs.writeFileSync(path.join(temp, commandPath), scripts[tierId]);
        Object.assign(selected, {
            executionDependsOn: [], requiresEvidenceFrom: [], services: [],
            parallelizable: true, exclusiveResources: [], resourceClass: 'cpu',
            maxParallel: 1, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [],
            cacheProfile: 'none', requiresPlaywright: 'none', requiresBootstrap: 'none',
            artifacts: [], evidence: []
        });
        configureTier(selected, tierId);
    }
    if (options.prSmartSelectedOnly === true)
    {
        assert.equal(tierIds.length, 2);
        for (const tier of matrix.tiers)
        {
            if (tierIds.includes(tier.id))
            {
                continue;
            }
            // Preserve the canonical finalizer graph while isolating this CLI
            // concurrency scenario from unrelated PR-default work.
            if (tier.smartGateMode === 'always' || tier.prDefault === true
                || (tier.smartGateMode === undefined && tier.requiredFor === 'fast'))
            {
                tier.smartGateMode = 'full-only';
                tier.prDefault = false;
            }
        }
    }
    const flow = (value) =>
    {
        if (Array.isArray(value))
        {
            return `[${value.map(flow).join(', ')}]`;
        }
        if (value && typeof value === 'object')
        {
            return `{${Object.entries(value).map(([key, entry]) => `${key}: ${flow(entry)}`).join(', ')}}`;
        }
        return JSON.stringify(value);
    };
    const matrixFile = path.join(temp, '.tmp/cli-scenario-matrix.yml');
    fs.mkdirSync(path.dirname(matrixFile), { recursive: true });
    fs.writeFileSync(matrixFile, Object.entries(matrix)
        .map(([key, value]) => `${key}: ${flow(value)}`).join('\n') + '\n');
    assert.deepEqual(parseMatrix(fs.readFileSync(matrixFile, 'utf8')), matrix);
    prepareBehaviorDocAdmissionFixtureAuthority({ sourceRepositoryRoot: root, repositoryRoot: temp });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '--all', '--', 'tools', 'config'],
        { cwd: temp });
    execFileSync(process.execPath, ['tools/test-matrix/generate-release-final-execution-authority.mjs'],
        { cwd: temp });
    const admission = createBehaviorDocAdmissionFixture({ sourceRepositoryRoot: root,
        repositoryRoot: temp });
    return {
        runner,
        tierId: tierIds[0],
        tierIds,
        matrixFile,
        admissionEnvironment: {
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT: admission.receiptFile,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST: admission.contentDigest,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID: admission.runId
        }
    };
}

test('ESM fixture materializer follows first- and second-level relative imports without a file list', assertTransitiveMaterialization);
test('materialized runner admission is bound to tracked executable source', (t) =>
{
    const temp = createTempDir('scheduler-admission-source-binding');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    createRunnerFixture(temp);
    const receipt = JSON.parse(fs.readFileSync(path.join(
        temp,
        '.tmp/behavior-doc-static-admission/fixture-receipt.json'
    ), 'utf8'));
    const initialSource = sealSourceIdentity(temp);
    assert.deepEqual(receipt.source, {
        commit: initialSource.sourceCommit,
        worktreeFingerprint: initialSource.worktreeFingerprint
    });
    fs.appendFileSync(path.join(temp, 'tools/run-test-matrix.mjs'), '\n// tracked source drift\n');
    const driftedSource = sealSourceIdentity(temp);
    assert.equal(driftedSource.sourceCommit, initialSource.sourceCommit);
    assert.notEqual(driftedSource.worktreeFingerprint, initialSource.worktreeFingerprint);
    assert.throws(
        () => validateBehaviorDocStaticAdmissionReceipt(receipt, {
            expectedRunId: receipt.run.id,
            expectedSourceIdentity: driftedSource,
            expectedWorktree: temp
        }),
        /source\/worktree identity mismatch/u
    );
});
test('ESM fixture preflight reports importer, specifier and resolved target for a missing dependency', assertMissingDependencyDiagnostic);
test('ESM fixture materializer rejects a relative import outside explicit allowed roots', assertAllowedRootBoundary);

test('runtime cleanup creates an early failure checkpoint through journaled scheduler authority', async (t) =>
{
    const { recordCheckpointRuntimeCleanup } = await loadScheduler();
    assert.equal(typeof recordCheckpointRuntimeCleanup, 'function');
    const temp = createTempDir('runtime-cleanup-early-checkpoint');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const runsRoot = path.join(temp, 'runs');
    const runId = 'production-preflight-blocked';
    const checkpointFile = path.join(runsRoot, runId, 'checkpoint.json');
    const failure = {
        tierId: 'production',
        exitCode: 1,
        reason: 'runtime cleanup preflight blocked'
    };
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    };
    const checkpoint = recordCheckpointRuntimeCleanup(
        checkpointFile,
        runId,
        {
            preflight: {
                path: '.tmp/release-evidence/runtime-cleanup/preflight.json',
                status: 'blocked',
                digest: `sha256:${'c'.repeat(64)}`
            }
        },
        failure,
        {
            targetTierId: 'production',
            sourceState,
            runtimeNamespace: `${runId}-fresh-local-production-0`
        }
    );

    assert.equal(checkpoint.status, 'failure');
    assert.equal(checkpoint.runtimeCleanup.preflight.status, 'blocked');
    assert.equal(checkpoint.revision, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(checkpointFile, 'utf8')), checkpoint);
    const journalFile = path.join(
        path.dirname(checkpointFile),
        'evidence-store',
        'journals',
        `${runId}.jsonl`
    );
    const journal = fs.readFileSync(journalFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.equal(journal.length, 1);
    assert.equal(journal[0].eventType, 'runtime-cleanup-blocked');
    assert.equal(
        fs.existsSync(path.join(
            path.dirname(checkpointFile),
            'evidence-store',
            'checkpoints',
            `${runId}.json`
        )),
        true
    );
    assert.throws(
        () => recordCheckpointRuntimeCleanup(
            checkpointFile,
            runId,
            {
                preflight: {
                    path: '.tmp/release-evidence/runtime-cleanup/retry.json',
                    status: 'complete',
                    digest: `sha256:${'d'.repeat(64)}`
                }
            }
        ),
        /cannot upgrade blocked evidence/u
    );
    assert.equal(
        JSON.parse(fs.readFileSync(checkpointFile, 'utf8')).runtimeCleanup.preflight.status,
        'blocked'
    );
});

test('checkpoint failure fallback journals a valid failure after runtime cleanup evidence rejects', async (t) =>
{
    const { recordCheckpointFailure, recordCheckpointRuntimeCleanup } = await loadScheduler();
    assert.equal(typeof recordCheckpointFailure, 'function');
    const temp = createTempDir('runtime-cleanup-fallback-checkpoint');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const runsRoot = path.join(temp, 'runs');
    const runId = 'production-finalization-failed';
    const checkpointFile = path.join(runsRoot, runId, 'checkpoint.json');
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    };
    assert.throws(
        () => recordCheckpointRuntimeCleanup(
            checkpointFile,
            runId,
            { postflight: { path: '', status: 'blocked', digest: 'invalid' } },
            null
        ),
        /evidence is invalid/u
    );
    const failure = {
        tierId: 'production',
        exitCode: 1,
        reason: 'postflight receipt persistence failed'
    };
    const checkpoint = recordCheckpointFailure(checkpointFile, runId, failure, {
        targetTierId: 'production',
        sourceState,
        runtimeNamespace: `${runId}-fresh-local-production-0`,
        stage: 'runtime-cleanup-finalization-failed',
        eventType: 'runtime-cleanup-finalization-failed',
        step: 'runtime-cleanup'
    });

    assert.equal(checkpoint.status, 'failure');
    assert.equal(checkpoint.failure.reason, failure.reason);
    assert.equal(checkpoint.revision, 1);
    const journalFile = path.join(
        path.dirname(checkpointFile),
        'evidence-store',
        'journals',
        `${runId}.jsonl`
    );
    const journal = fs.readFileSync(journalFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.deepEqual(journal.map((entry) => entry.eventType), [
        'runtime-cleanup-finalization-failed'
    ]);
});

function tier(id, overrides = {})
{
    return {
        id,
        command: `${process.execPath} -e "process.exit(0)"`,
        executionDependsOn: [],
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        phase: 0,
        resourceClass: 'cpu',
        maxParallel: 8,
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        executionKey: `test/${id}`,
        executionVariant: 'ordinary',
        coverage: ['ordinary-unit'],
        ...overrides
    };
}

const stableSnapshot = async () => ({ fingerprint: 'stable', entries: {} });

function applyFixtureCheckpointPatch(state, _event, payload)
{
    let result = structuredClone(state);
    for (const operation of payload?.operations ?? [])
    {
        if (operation.path.length === 0)
        {
            result = structuredClone(operation.value);
            continue;
        }
        let parent = result;
        for (const segment of operation.path.slice(0, -1))
        {
            parent = parent[segment];
        }
        const key = operation.path.at(-1);
        if (operation.kind === 'set')
        {
            parent[key] = structuredClone(operation.value);
        }
        else if (operation.kind === 'delete')
        {
            delete parent[key];
        }
        else if (operation.kind === 'append')
        {
            parent[key].push(...structuredClone(operation.values));
        }
    }
    return result;
}

function digestFile(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function fileOutputFingerprint(file)
{
    const stat = fs.lstatSync(file);
    return `file:${stat.mode}:${stat.size}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

async function createCheckpointEvidenceFixture(runDag, name = 'scheduler-checkpoint-evidence')
{
    const temp = createTempDir(name);
    execFileSync('git', ['init', '-q'], { cwd: temp });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: temp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: temp });
    fs.writeFileSync(path.join(temp, 'tracked'), 'fixture\n');
    execFileSync('git', ['add', '.'], { cwd: temp });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: temp });
    const runsRoot = path.join(temp, 'runs');
    const summaryPath = '.tmp/local-production/build-static/summary.json';
    const artifactPath = '.tmp/local-production/build-static/production.log';
    const artifactDirectoryPath = '.tmp/local-production/build-static/evidence-directory';
    const artifactDirectoryFile = `${artifactDirectoryPath}/nested/result.txt`;
    const artifactWildcardPath = '.tmp/local-production/build-static/evidence-wildcard/**/*.json';
    const artifactWildcardFile = '.tmp/local-production/build-static/evidence-wildcard/nested/result.json';
    const summaryOnlyPath = '.tmp/local-production/summary-only/external-operations-evidence.json';
    const result = await runDag({
        tiers: [tier('local-production-build-static', {
            artifacts: [summaryPath],
            evidence: [summaryPath]
        })],
        root: temp,
        runsRoot,
        runId: 'production-fresh',
        targetTierId: 'production',
        mode: 'fresh',
        maxParallel: 1,
        snapshotWorktree: stableSnapshot,
        executeTier: async (_current, context) =>
        {
            const summaryFile = path.join(temp, summaryPath);
            const artifactFile = path.join(temp, artifactPath);
            const artifactDirectoryOutput = path.join(temp, artifactDirectoryFile);
            const artifactWildcardOutput = path.join(temp, artifactWildcardFile);
            const summaryOnlyFile = path.join(temp, summaryOnlyPath);
            fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
            fs.mkdirSync(path.dirname(artifactDirectoryOutput), { recursive: true });
            fs.mkdirSync(path.dirname(artifactWildcardOutput), { recursive: true });
            fs.mkdirSync(path.dirname(summaryOnlyFile), { recursive: true });
            fs.writeFileSync(artifactFile, 'fresh bundle\n');
            fs.writeFileSync(artifactDirectoryOutput, 'directory evidence\n');
            fs.writeFileSync(artifactWildcardOutput, '{"status":"success"}\n');
            fs.writeFileSync(summaryOnlyFile, '{"status":"collected-blocked"}\n');
            const memberEvidence = {
                status: 'success',
                durationMs: 1,
                testIds: ['command:production'],
                artifactProofMode: 'matrix-runtime-artifacts',
                matrixRuntimePaths: [
                    artifactDirectoryPath,
                    artifactWildcardPath,
                    artifactPath
                ].sort(),
                artifactSubstitutionProofs: {},
                artifactDigests: digestDeclaredOutputs(temp, [
                    artifactPath,
                    artifactDirectoryPath,
                    artifactWildcardPath
                ])
            };
            fs.writeFileSync(summaryFile, `${JSON.stringify({ status: 'success', members: { production: memberEvidence } })}\n`);
            context.writeOutput('fresh bundle\n');
            return { code: 0, signal: null };
        }
    });
    const projection = {
        schema: 'fsusblog.local-profile-projection.v1',
        profileId: 'production',
        runId: 'production-fresh',
        sourceState: result.checkpoint.sourceState,
        executionSource: 'fresh',
        status: 'incomplete-external-evidence',
        qualificationEligible: false,
        logicalTierCount: 2,
        executedTierCount: 1,
        summaryOnlyTierCount: 1,
        requiredSummaryOnlyTierIds: ['external-operations-evidence'],
        logicalTierIds: ['external-operations-evidence', 'production'],
        entries: {
            production: {
                tierId: 'production',
                evidenceKind: 'executed',
                physicalBundleId: 'build-static',
                status: 'success',
                executionSource: 'fresh',
                durationMs: 1,
                testIds: ['command:production'],
                artifactProofMode: 'matrix-runtime-artifacts',
                matrixRuntimePaths: [
                    artifactDirectoryPath,
                    artifactWildcardPath,
                    artifactPath
                ].sort(),
                artifactSubstitutionProofs: {},
                artifactDigests: digestDeclaredOutputs(temp, [
                    artifactPath,
                    artifactDirectoryPath,
                    artifactWildcardPath
                ])
            },
            'external-operations-evidence': {
                tierId: 'external-operations-evidence',
                evidenceKind: 'summary-only',
                physicalBundleId: null,
                status: 'collected-blocked',
                executionSource: 'external-environment',
                durationMs: null,
                testIds: [],
                artifactDigests: { [summaryOnlyPath]: digestFile(path.join(temp, summaryOnlyPath)) }
            }
        }
    };
    return {
        temp,
        result,
        projection,
        attachOptions: {
            root: temp,
            expectedRevision: result.checkpoint.revision,
            snapshotWorktree: stableSnapshot
        },
        summaryPath,
        artifactPaths: {
            direct: artifactPath,
            directoryFile: artifactDirectoryFile,
            wildcardFile: artifactWildcardFile
        }
    };
}

function addArtifactSubstitutionProof(fixture)
{
    const entry = fixture.projection.entries.production;
    const canonicalPath = '.tmp/local-production/build-static/canonical/missing.json';
    const actualPaths = [
        fixture.artifactPaths.direct,
        '.tmp/local-production/build-static/evidence-wildcard/**/*.json'
    ].sort();
    const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
        actualPath,
        entry.artifactDigests[actualPath]
    ]));
    const canonicalDigest = artifactSubstitutionBindingDigest(canonicalPath, actualDigests);
    entry.artifactProofMode = 'matrix-runtime-artifacts-with-substitutions';
    entry.matrixRuntimePaths = [...new Set([...entry.matrixRuntimePaths, canonicalPath])].sort();
    entry.artifactDigests[canonicalPath] = canonicalDigest;
    entry.artifactSubstitutionProofs[canonicalPath] = {
        canonicalPath,
        canonicalDigest,
        actualPaths,
        actualDigests
    };
    const summaryFile = path.join(fixture.temp, fixture.summaryPath);
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    summary.members.production = {
        status: entry.status,
        durationMs: entry.durationMs,
        testIds: entry.testIds,
        artifactProofMode: entry.artifactProofMode,
        matrixRuntimePaths: entry.matrixRuntimePaths,
        artifactSubstitutionProofs: entry.artifactSubstitutionProofs,
        artifactDigests: entry.artifactDigests
    };
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary)}\n`);
    const checkpoint = JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'));
    checkpoint.tiers['local-production-build-static'].outputs[fixture.summaryPath] = fileOutputFingerprint(summaryFile);
    fs.writeFileSync(fixture.result.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    return { canonicalPath, actualPaths, canonicalDigest };
}

function bindFixtureToArtifactDigestTable(fixture)
{
    const sourceState = fixture.result.checkpoint.sourceState;
    const tableFile = path.join(fixture.temp, '.tmp/build/production-fresh/generated/artifact-digest-table.json');
    const table = createArtifactDigestTable({
        root: fixture.temp,
        file: tableFile,
        runId: 'production-fresh',
        sourceState
    });
    const productionEntry = fixture.projection.entries.production;
    const productionArtifacts = table.digestDeclarations(Object.keys(productionEntry.artifactDigests), {
        producer: { bundle: 'build-static', step: 'projection' }
    });
    productionEntry.artifactDigests = productionArtifacts.digests;
    productionEntry.artifactRefs = productionArtifacts.refs;

    const summaryOnlyEntry = fixture.projection.entries['external-operations-evidence'];
    const summaryOnlyPath = Object.keys(summaryOnlyEntry.artifactDigests)[0];
    const summaryOnlyArtifact = table.digestDeclarations([summaryOnlyPath], {
        producer: { bundle: 'projection', step: 'summary-only' }
    });
    summaryOnlyEntry.artifactDigests = summaryOnlyArtifact.digests;
    summaryOnlyEntry.artifactRefs = summaryOnlyArtifact.refs;

    const summaryFile = path.join(fixture.temp, fixture.summaryPath);
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    summary.members.production.artifactDigests = productionArtifacts.digests;
    summary.members.production.artifactRefs = productionArtifacts.refs;
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary)}\n`);
    const checkpoint = JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'));
    checkpoint.tiers['local-production-build-static'].outputs[fixture.summaryPath] = fileOutputFingerprint(summaryFile);
    fs.writeFileSync(fixture.result.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

    const snapshot = path.join(fixture.temp, '.tmp/release-evidence/production-artifact-digest-table.json');
    fixture.projection.artifactDigestTable = table.finalize(snapshot);
    return { tableFile: snapshot, descriptor: fixture.projection.artifactDigestTable };
}

test('runDag executes independent tiers concurrently before their dependent tier', async () =>
{
    const { runDag } = await loadScheduler();
    assert.equal(typeof runDag, 'function');

    const temp = createTempDir('scheduler-dag');
    const events = [];
    let active = 0;
    let maxActive = 0;
    const result = await runDag({
        tiers: [
            tier('left'),
            tier('right'),
            tier('join', { executionDependsOn: ['left', 'right'] })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'dag',
        maxParallel: 3,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current, context) =>
        {
            events.push(`start:${current.id}`);
            active += 1;
            maxActive = Math.max(maxActive, active);
            context.writeOutput(`${current.id}\n`);
            await delay(current.id === 'join' ? 1 : 25);
            active -= 1;
            events.push(`end:${current.id}`);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    assert.equal(maxActive, 2);
    assert.ok(events.indexOf('start:join') > events.indexOf('end:left'));
    assert.ok(events.indexOf('start:join') > events.indexOf('end:right'));
    assert.ok(fs.existsSync(path.join(temp, 'runs/dag/tiers/left.log')));
    const checkpoint = JSON.parse(fs.readFileSync(path.join(temp, 'runs/dag/checkpoint.json'), 'utf8'));
    assert.deepEqual(checkpoint.completedTiers.sort(), ['join', 'left', 'right']);
    assert.equal(typeof checkpoint.tiers.join.inputFingerprint, 'string');
    assert.equal(typeof checkpoint.tiers.join.dependencyFingerprint, 'string');
    assert.equal(typeof checkpoint.tiers.join.durationMs, 'number');
    assert.equal(checkpoint.sourceState.worktreeFingerprint, 'stable');
    assert.ok(Object.hasOwn(checkpoint.sourceState, 'commit'));
});

test('runDag waits for selected evidence producers and preserves their outputs', async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-evidence-dependency');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const producerOutput = path.join(temp, '.tmp/evidence/producer.json');
    const aggregateOutput = path.join(temp, '.tmp/evidence/aggregate.json');
    const events = [];
    const result = await runDag({
        tiers: [
            tier('aggregate', {
                requiresEvidenceFrom: ['producer'],
                artifacts: [
                    '.tmp/evidence/producer.json',
                    '.tmp/evidence/aggregate.json'
                ],
                evidence: [
                    '.tmp/evidence/producer.json',
                    '.tmp/evidence/aggregate.json'
                ]
            }),
            tier('producer', {
                artifacts: ['.tmp/evidence/producer.json'],
                evidence: ['.tmp/evidence/producer.json']
            })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'evidence-dependency',
        mode: 'fresh',
        maxParallel: 2,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            events.push(current.id);
            fs.mkdirSync(path.dirname(producerOutput), { recursive: true });
            if (current.id === 'producer')
            {
                fs.writeFileSync(producerOutput, '{"status":"ok"}\n');
            }
            else
            {
                assert.equal(fs.readFileSync(producerOutput, 'utf8'), '{"status":"ok"}\n');
                fs.writeFileSync(aggregateOutput, '{"aggregate":"ok"}\n');
            }
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(events, ['producer', 'aggregate']);
    assert.equal(fs.readFileSync(producerOutput, 'utf8'), '{"status":"ok"}\n');
    assert.equal(fs.readFileSync(aggregateOutput, 'utf8'), '{"aggregate":"ok"}\n');
});

test('failed selected evidence producer blocks only its evidence consumers', async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-failed-evidence-dependency');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const executed = [];
    const result = await runDag({
        tiers: [
            tier('consumer', { requiresEvidenceFrom: ['producer'] }),
            tier('producer'),
            tier('independent')
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'failed-evidence-dependency',
        mode: 'fresh',
        maxParallel: 1,
        collectFailures: true,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            executed.push(current.id);
            return {
                code: current.id === 'producer' ? 1 : 0,
                signal: null
            };
        }
    });

    assert.equal(result.status, 'failure');
    assert.equal(result.checkpoint.tiers.consumer.status, 'blocked');
    assert.match(result.checkpoint.tiers.consumer.reason, /producer/u);
    assert.ok(executed.includes('producer'));
    assert.ok(executed.includes('independent'));
    assert.ok(!executed.includes('consumer'));
});

test('failed post-runtime seal keeps release-final spawn and admission counts at zero', async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-release-final-post-runtime-failure');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const executions = new Map();
    const result = await runDag({
        tiers: [
            tier('release-final', {
                requiresEvidenceFrom: ['behavior-evidence-post-runtime']
            }),
            tier('behavior-evidence-post-runtime')
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'release-final-post-runtime-failure',
        mode: 'fresh',
        maxParallel: 1,
        collectFailures: true,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            executions.set(current.id, (executions.get(current.id) ?? 0) + 1);
            return {
                code: current.id === 'behavior-evidence-post-runtime' ? 1 : 0,
                signal: null
            };
        }
    });

    assert.equal(result.status, 'failure');
    assert.equal(executions.get('behavior-evidence-post-runtime'), 1);
    assert.equal(executions.get('release-final') ?? 0, 0);
    assert.equal(result.checkpoint.tiers['release-final'].status, 'blocked');
    assert.match(
        result.checkpoint.tiers['release-final'].reason,
        /behavior-evidence-post-runtime/u
    );
    assert.equal(
        result.checkpoint.tiers['release-final'].producerSpawnCount ?? 0,
        0
    );
    assert.equal(
        result.checkpoint.schedulerAdmissions?.['release-final'],
        undefined
    );
});

test('fresh scheduler preserves prepared authority entries and removes only scheduler-owned stale state', async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-prepared-fresh-root');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const runsRoot = path.join(temp, 'runs');
    const runDirectory = path.join(runsRoot, 'prepared');
    const outputMarker = path.join(runDirectory, 'outputs/attempts/attempt-0001/marker.json');
    const authorityFile = path.join(runDirectory, 'production-fresh-output-authority.json');
    fs.mkdirSync(path.dirname(outputMarker), { recursive: true });
    fs.writeFileSync(outputMarker, 'prepared\n');
    fs.writeFileSync(authorityFile, 'authority\n');
    fs.mkdirSync(path.join(runDirectory, 'tiers'), { recursive: true });
    fs.writeFileSync(path.join(runDirectory, 'tiers/stale.log'), 'stale\n');
    fs.writeFileSync(path.join(runDirectory, 'stale.json'), 'stale\n');

    const result = await runDag({
        tiers: [tier('producer')],
        root: temp,
        runsRoot,
        runId: 'prepared',
        mode: 'fresh',
        freshRunDirectoryPreservation: {
            entries: [
                { name: 'production-fresh-output-authority.json', type: 'file' },
                { name: 'outputs', type: 'directory' }
            ]
        },
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    });

    assert.equal(result.status, 'success');
    assert.equal(fs.readFileSync(outputMarker, 'utf8'), 'prepared\n');
    assert.equal(fs.readFileSync(authorityFile, 'utf8'), 'authority\n');
    assert.equal(fs.existsSync(path.join(runDirectory, 'stale.json')), false);
    assert.equal(fs.existsSync(path.join(runDirectory, 'tiers/stale.log')), false);
    assert.equal(fs.existsSync(path.join(runDirectory, 'checkpoint.json')), true);
});

test('fresh and resume schedulers preserve authenticated current-run BehaviorDoc admission receipt', async (t) =>
{
    const {
        createCurrentRunBehaviorDocAdmissionBinding,
        runDag
    } = await loadScheduler();
    const temp = createTempDir('scheduler-current-run-behavior-doc');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    createRunnerFixture(temp);
    const receiptRelative =
        '.tmp/behavior-doc-static-admission/fixture-receipt.json';
    const receiptFile = path.join(temp, receiptRelative);
    const originalReceiptBytes = fs.readFileSync(receiptFile);
    const receipt = JSON.parse(originalReceiptBytes);
    const source = sealSourceIdentity(temp);
    const sourceState = {
        commit: source.sourceCommit,
        worktreeFingerprint: 'f'.repeat(64)
    };
    const runId = 'current-run-behavior-doc';
    const binding = createCurrentRunBehaviorDocAdmissionBinding({
        root: temp,
        tierId: 'behavior-doc-static-admission',
        schedulerRunId: runId,
        admissionRunId: receipt.run.id,
        sourceState,
        receiptFile
    });
    const admissionTier = tier('behavior-doc-static-admission', {
        artifacts: [receiptRelative],
        evidence: [receiptRelative]
    });
    let executionCount = 0;
    const result = await runDag({
        tiers: [admissionTier],
        root: temp,
        runsRoot: path.join(temp, 'runs-success'),
        runId,
        mode: 'fresh',
        sourceState,
        currentRunPreexecutedTierBindings: [binding],
        snapshotWorktree: stableSnapshot,
        env: { FSUSBLOG_BEHAVIOR_DOC_RESUME_PROBE: 'fresh' },
        executeTier: async () =>
        {
            executionCount += 1;
            assert.deepEqual(fs.readFileSync(receiptFile), originalReceiptBytes);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    assert.equal(executionCount, 1);
    assert.notEqual(
        binding.sourceState.worktreeFingerprint,
        binding.admissionSourceIdentity.worktreeFingerprint
    );
    assert.deepEqual(fs.readFileSync(receiptFile), originalReceiptBytes);

    const exactResume = await runDag({
        tiers: [admissionTier],
        root: temp,
        runsRoot: path.join(temp, 'runs-success'),
        runId,
        mode: 'resume',
        sourceState,
        currentRunPreexecutedTierBindings: [binding],
        snapshotWorktree: stableSnapshot,
        env: { FSUSBLOG_BEHAVIOR_DOC_RESUME_PROBE: 'fresh' },
        executeTier: async () =>
        {
            executionCount += 1;
            return { code: 0, signal: null };
        }
    });
    assert.equal(exactResume.status, 'success');
    assert.equal(executionCount, 1);
    assert.deepEqual(exactResume.reusedTiers, ['behavior-doc-static-admission']);

    await assert.rejects(
        runDag({
            tiers: [admissionTier],
            root: temp,
            runsRoot: path.join(temp, 'runs-success'),
            runId,
            mode: 'resume',
            sourceState,
            currentRunPreexecutedTierBindings: [{
                ...binding,
                receiptContentDigest: '0'.repeat(64)
            }],
            snapshotWorktree: stableSnapshot,
            env: { FSUSBLOG_BEHAVIOR_DOC_RESUME_PROBE: 'fresh' }
        }),
        /current-run BehaviorDoc admission binding is invalid/u
    );
    assert.equal(executionCount, 1);

    const resumed = await runDag({
        tiers: [admissionTier],
        root: temp,
        runsRoot: path.join(temp, 'runs-success'),
        runId,
        mode: 'resume',
        sourceState,
        currentRunPreexecutedTierBindings: [binding],
        snapshotWorktree: stableSnapshot,
        env: { FSUSBLOG_BEHAVIOR_DOC_RESUME_PROBE: 'resume' },
        executeTier: async () =>
        {
            executionCount += 1;
            assert.deepEqual(fs.readFileSync(receiptFile), originalReceiptBytes);
            return { code: 0, signal: null };
        }
    });
    assert.equal(resumed.status, 'success');
    assert.equal(executionCount, 2);
    assert.deepEqual(resumed.reusedTiers, []);
    assert.equal(
        resumed.checkpoint.tiers['behavior-doc-static-admission'].reused,
        false
    );
    assert.deepEqual(fs.readFileSync(receiptFile), originalReceiptBytes);

    const disguisedBinding = createCurrentRunBehaviorDocAdmissionBinding({
        root: temp,
        tierId: 'validate-matrix',
        schedulerRunId: runId,
        admissionRunId: receipt.run.id,
        sourceState,
        receiptFile
    });
    await assert.rejects(
        runDag({
            tiers: [tier('validate-matrix', {
                artifacts: [receiptRelative],
                evidence: [receiptRelative]
            })],
            root: temp,
            runsRoot: path.join(temp, 'runs-disguised-resume-tier'),
            runId,
            mode: 'resume',
            sourceState,
            currentRunPreexecutedTierBindings: [disguisedBinding],
            snapshotWorktree: stableSnapshot
        }),
        /only accepts schema .*current-run-behavior-doc-admission-binding\.v1 for tier behavior-doc-static-admission; received schema .* for tier validate-matrix/u
    );

    await assert.rejects(
        runDag({
            tiers: [admissionTier],
            root: temp,
            runsRoot: path.join(temp, 'runs-forged'),
            runId,
            mode: 'fresh',
            sourceState,
            currentRunPreexecutedTierBindings: [{
                ...binding,
                receiptContentDigest: '0'.repeat(64)
            }],
            snapshotWorktree: stableSnapshot
        }),
        /current-run BehaviorDoc admission binding is invalid/u
    );

    await assert.rejects(
        runDag({
            tiers: [tier('behavior-doc-static-admission', {
                artifacts: ['.tmp/behavior-doc-static-admission/other.json'],
                evidence: ['.tmp/behavior-doc-static-admission/other.json']
            })],
            root: temp,
            runsRoot: path.join(temp, 'runs-unowned'),
            runId,
            mode: 'fresh',
            sourceState,
            currentRunPreexecutedTierBindings: [binding],
            snapshotWorktree: stableSnapshot
        }),
        /receipt is not owned by tier/u
    );

    const driftedReceipt = JSON.parse(originalReceiptBytes);
    driftedReceipt.durationMs += 1;
    fs.writeFileSync(receiptFile, `${JSON.stringify(driftedReceipt, null, 2)}\n`);
    await assert.rejects(
        runDag({
            tiers: [admissionTier],
            root: temp,
            runsRoot: path.join(temp, 'runs-drifted'),
            runId,
            mode: 'fresh',
            sourceState,
            currentRunPreexecutedTierBindings: [binding],
            snapshotWorktree: stableSnapshot
        }),
        /BehaviorDoc admission content digest mismatch/u
    );
    fs.writeFileSync(receiptFile, originalReceiptBytes);

    fs.rmSync(receiptFile);
    await assert.rejects(
        runDag({
            tiers: [admissionTier],
            root: temp,
            runsRoot: path.join(temp, 'runs-missing'),
            runId,
            mode: 'fresh',
            sourceState,
            currentRunPreexecutedTierBindings: [binding],
            snapshotWorktree: stableSnapshot
        }),
        /current-run BehaviorDoc admission receipt is missing/u
    );
});

test('fresh scheduler preserves authenticated current-run prerequisite outputs for reuse', async (t) =>
{
    const {
        createCurrentRunPreexecutedTierBinding,
        runDag
    } = await loadScheduler();
    const temp = createTempDir('scheduler-current-run-prerequisite');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const runId = 'current-run-prerequisite';
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    };
    const plan = path.join(temp, '.tmp/release-evidence/test-plan.json');
    const projectionRelative =
        '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json';
    const projection = path.join(
        temp,
        projectionRelative
    );
    const physicalExecutionRoot = path.join(temp, '.tmp/physical-executions');
    const runBoundOptions = {
        root: physicalExecutionRoot,
        runId,
        key: 'matrix-governance',
        command: ['node', 'matrix-governance.mjs'],
        cwd: temp,
        inputDigest: 'matrix-governance-input',
        environmentDigest: 'matrix-governance-environment',
        outputContract: ['.tmp/release-evidence/test-plan.json'],
        requiredOutputs: [plan],
        commit: sourceState.commit,
        worktreeFingerprint: sourceState.worktreeFingerprint,
        testIds: ['matrix-validate'],
        consumerId: 'validate-matrix',
        heartbeatMs: 5
    };
    const prerequisite = await runOnce.runBoundExecution(runBoundOptions, async () =>
    {
        fs.mkdirSync(path.dirname(plan), { recursive: true });
        fs.writeFileSync(plan, '{"run":"current"}\n');
    });
    const prerequisiteProjection = await runOnce.validateRunBoundProjection({
        root: physicalExecutionRoot,
        runId,
        key: 'matrix-governance',
        consumerId: 'validate-matrix',
        projectionFile: prerequisite.projectionFile,
        receiptFile: prerequisite.receiptFile
    });
    const prerequisiteEvidence = runOnce.buildRunBoundConsumerEvidence({
        validatedProjection: prerequisiteProjection
    });
    const temporalArtifacts = temporal.bindProducerTemporalArtifacts({
        contextInput: {
            sourceCommit: sourceState.commit,
            sourceFingerprint: `sha256:${sourceState.worktreeFingerprint}`,
            producerId: 'validate-matrix',
            schedulerRunId: runId,
            businessEpochUtc: '2024-02-29T23:59:59.000Z',
            locale: 'en-US',
            uiLocale: 'en-US',
            timeoutPolicyDigest: temporal.defaultTimeoutPolicyDigest()
        },
        outcome: {
            status: prerequisite.status,
            executionKey: 'matrix-governance',
            runBoundReceiptDigest: prerequisiteProjection.receipt.receiptDigest
        },
        observations: {
            businessEpochUtc: '2024-02-29T23:59:59.000Z',
            timezone: 'UTC',
            nodeTimezone: 'UTC',
            locale: 'en-US',
            monotonicClockSource: 'performance-now',
            observationBoundary: 'test-producer'
        },
        generatedAt: '2026-07-29T00:00:00.000Z'
    });
    const temporalDirectory = path.dirname(prerequisite.receiptFile);
    for (const [kind, document] of [
        ['plan', temporalArtifacts.plan],
        ['actual', temporalArtifacts.actual],
        ['receipt', temporalArtifacts.receipt]
    ])
    {
        fs.writeFileSync(
            path.join(temporalDirectory, `matrix-governance-temporal-${kind}.json`),
            `${JSON.stringify(document, null, 2)}\n`
        );
    }
    fs.mkdirSync(path.dirname(projection), { recursive: true });
    fs.writeFileSync(projection, `${JSON.stringify(prerequisiteEvidence, null, 2)}\n`);
    const binding = createCurrentRunPreexecutedTierBinding({
        root: temp,
        tierId: 'validate-matrix',
        schedulerRunId: runId,
        sourceState,
        consumerEvidenceFile: projectionRelative,
        consumerEvidence: prerequisiteEvidence
    });
    let executed = false;

    const result = await runDag({
        tiers: [tier('validate-matrix', {
            artifacts: [
                '.tmp/release-evidence/test-plan.json',
                '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
            ],
            evidence: [
                '.tmp/release-evidence/test-plan.json',
                '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
            ]
        })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId,
        mode: 'fresh',
        sourceState,
        currentRunPreexecutedTierBindings: [binding],
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            executed = true;
            assert.equal(fs.readFileSync(plan, 'utf8'), '{"run":"current"}\n');
            const consumer = await runOnce.runBoundExecution(
                { ...runBoundOptions, consumerId: 'validate-matrix' },
                async () => assert.fail('same-run consumer must not rerun the producer')
            );
            const consumerProjection = await runOnce.validateRunBoundProjection({
                root: physicalExecutionRoot,
                runId,
                key: 'matrix-governance',
                consumerId: 'validate-matrix',
                projectionFile: consumer.projectionFile,
                receiptFile: consumer.receiptFile
            });
            const consumerEvidence = runOnce.buildRunBoundConsumerEvidence({
                validatedProjection: consumerProjection
            });
            fs.writeFileSync(projection, `${JSON.stringify(consumerEvidence, null, 2)}\n`);
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(executed, true);
    assert.equal(fs.readFileSync(plan, 'utf8'), '{"run":"current"}\n');
    const currentConsumerEvidence = JSON.parse(fs.readFileSync(projection, 'utf8'));
    assert.equal(currentConsumerEvidence.schedulerRunId, runId);
    const currentBinding = createCurrentRunPreexecutedTierBinding({
        root: temp,
        tierId: 'validate-matrix',
        schedulerRunId: runId,
        sourceState,
        consumerEvidenceFile: projectionRelative,
        consumerEvidence: currentConsumerEvidence
    });

    await assert.rejects(
        runDag({
            tiers: [tier('validate-matrix', {
                artifacts: [
                    '.tmp/release-evidence/test-plan.json',
                    '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
                ],
                evidence: [
                    '.tmp/release-evidence/test-plan.json',
                    '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
                ]
            })],
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId: 'unknown-current-run-prerequisite',
            mode: 'fresh',
            currentRunPreexecutedTierBindings: [{ ...currentBinding, tierId: 'unknown' }],
            snapshotWorktree: stableSnapshot
        }),
        /current-run preexecuted tier is unknown: unknown/u
    );
    await assert.rejects(
        runDag({
            tiers: [tier('validate-matrix')],
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId: 'resumed-current-run-prerequisite',
            mode: 'resume',
            currentRunPreexecutedTierBindings: [currentBinding],
            snapshotWorktree: stableSnapshot
        }),
        /only accepts schema .*current-run-behavior-doc-admission-binding\.v1 for tier behavior-doc-static-admission; received schema .*current-run-preexecuted-tier-binding\.v1 for tier validate-matrix/u
    );
    await assert.rejects(
        runDag({
            tiers: [tier('validate-matrix')],
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId: 'resumed-unknown-current-run-prerequisite',
            mode: 'resume',
            currentRunPreexecutedTierBindings: [{
                ...currentBinding,
                schema: 'fsusblog.test-matrix.unknown-binding.v1'
            }],
            snapshotWorktree: stableSnapshot
        }),
        /received schema fsusblog\.test-matrix\.unknown-binding\.v1/u
    );

    await assert.rejects(
        runDag({
            tiers: [tier('validate-matrix')],
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId,
            mode: 'fresh',
            sourceState,
            currentRunPreexecutedTierBindings: [{
                ...currentBinding,
                consumerEvidenceDigest: 'forged'
            }],
            snapshotWorktree: stableSnapshot
        }),
        /current-run preexecuted tier binding is invalid: validate-matrix/u
    );

    const temporalReceiptFile = path.join(temp, currentBinding.temporalReceiptFile);
    const temporalReceiptBytes = fs.readFileSync(temporalReceiptFile);
    const forgedTemporalReceipt = JSON.parse(temporalReceiptBytes);
    forgedTemporalReceipt.source.fingerprint = `sha256:${'c'.repeat(64)}`;
    fs.writeFileSync(
        temporalReceiptFile,
        `${JSON.stringify(forgedTemporalReceipt, null, 2)}\n`
    );
    await assert.rejects(
        runDag({
            tiers: [tier('validate-matrix', {
                artifacts: [
                    '.tmp/release-evidence/test-plan.json',
                    '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
                ],
                evidence: [
                    '.tmp/release-evidence/test-plan.json',
                    '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
                ]
            })],
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId,
            mode: 'fresh',
            sourceState,
            currentRunPreexecutedTierBindings: [currentBinding],
            snapshotWorktree: stableSnapshot
        }),
        /temporal.*binding/u
    );
    fs.writeFileSync(temporalReceiptFile, temporalReceiptBytes);

    fs.rmSync(plan);
    let missingOutputExecuted = false;
    await assert.rejects(
        runDag({
            tiers: [tier('validate-matrix', {
                artifacts: [
                    '.tmp/release-evidence/test-plan.json',
                    '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
                ],
                evidence: [
                    '.tmp/release-evidence/test-plan.json',
                    '.tmp/physical-execution-projections/validate-matrix-matrix-governance.json'
                ]
            })],
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId,
            mode: 'fresh',
            sourceState,
            currentRunPreexecutedTierBindings: [currentBinding],
            snapshotWorktree: stableSnapshot,
            executeTier: async () =>
            {
                missingOutputExecuted = true;
                return { code: 0, signal: null };
            }
        }),
        /run-bound projection output validation failed/u
    );
    assert.equal(missingOutputExecuted, false);
});

test('runDag collectFailures executes independent tiers and blocks only failed dependency descendants', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-collect-failures');
    const executed = [];
    const result = await runDag({
        tiers: [
            tier('fails'),
            tier('independent'),
            tier('blocked-child', { executionDependsOn: ['fails'] })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'collect-failures',
        maxParallel: 1,
        collectFailures: true,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            executed.push(current.id);
            return { code: current.id === 'fails' ? 7 : 0, signal: null };
        }
    });

    assert.equal(result.status, 'failure');
    assert.deepEqual(executed, ['fails', 'independent']);
    assert.equal(result.checkpoint.tiers.independent.status, 'success');
    assert.equal(result.checkpoint.tiers['blocked-child'].status, 'blocked');
    assert.equal(result.checkpoint.failures.length, 1);
    assert.equal(result.checkpoint.failures[0].tierId, 'fails');
});

test('real subprocess failure blocks the production correctness consumer and preserves its root cause', async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('production-correctness-barrier');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const producerMarker = path.join(temp, 'producer-started');
    const diagnosticMarker = path.join(temp, 'diagnostic-finished');
    const consumerMarker = path.join(temp, 'coverage-merge-ran');
    const command = (source) => `${process.execPath} -e ${JSON.stringify(source)}`;
    const result = await runDag({
        tiers: [
            tier('frontend-tests', {
                command: command(`require('node:fs').writeFileSync(${JSON.stringify(producerMarker)}, 'failed\\n'); process.exit(23)`)
            }),
            tier('diagnostic-continuation', {
                command: command(`require('node:fs').writeFileSync(${JSON.stringify(diagnosticMarker)}, 'complete\\n')`)
            }),
            tier('performance-evidence', {
                command: command(`require('node:fs').writeFileSync(${JSON.stringify(consumerMarker)}, 'must not run\\n')`),
                executionDependsOn: ['frontend-tests']
            })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'production-correctness-failure-barrier',
        maxParallel: 1,
        collectFailures: true,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: stableSnapshot
    });

    assert.equal(result.status, 'failure');
    assert.equal(fs.existsSync(producerMarker), true);
    assert.equal(fs.existsSync(diagnosticMarker), true);
    assert.equal(fs.existsSync(consumerMarker), false);
    assert.equal(result.checkpoint.failurePoint, 'frontend-tests');
    assert.deepEqual(result.checkpoint.failures.map((failure) => failure.tierId), ['frontend-tests']);
    assert.equal(result.checkpoint.tiers['diagnostic-continuation'].status, 'success');
    assert.equal(result.checkpoint.tiers['performance-evidence'].status, 'blocked');
    assert.match(result.checkpoint.tiers['performance-evidence'].reason, /frontend-tests/u);
});

test('checkpoint evidence attach is atomic, run-bound, and preserves physical scheduler tiers', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    assert.equal(typeof attachCheckpointEvidence, 'function');
    const { result, projection, attachOptions } = await createCheckpointEvidenceFixture(runDag);

    const attached = await attachCheckpointEvidence(result.checkpointPath, 'production-fresh', {
        logicalTierProjection: projection
    }, attachOptions);
    const persisted = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));

    assert.deepEqual(attached.logicalTierProjection, projection);
    assert.deepEqual(persisted.logicalTierProjection, projection);
    assert.deepEqual(Object.keys(persisted.tiers), ['local-production-build-static']);
    assert.deepEqual(persisted.completedTiers, ['local-production-build-static']);
    await assert.rejects(
        attachCheckpointEvidence(result.checkpointPath, 'another-run', { logicalTierProjection: projection }, {
            ...attachOptions,
            expectedRevision: attached.revision
        }),
        /checkpoint run production-fresh does not match expected run another-run/u
    );
    await assert.rejects(
        attachCheckpointEvidence(result.checkpointPath, 'production-fresh', { logicalTierProjection: projection }, attachOptions),
        /checkpoint revision .* does not match expected revision/u
    );
    assert.equal(JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8')).status, 'success');
});

test('projection resume commits only after its locked completion callback succeeds', async () =>
{
    const {
        attachCheckpointEvidence,
        isProjectionOnlyCheckpointFailure,
        markCheckpointWallClockTimeout,
        resumeCheckpointEvidence,
        runDag,
        validateLocalProfileCheckpointEvidence
    } = await loadScheduler();
    const fixture = await createCheckpointEvidenceFixture(runDag, 'external-receipt-binding');
    const placeholderPath = '.tmp/local-production/summary-only/external-operations-evidence.json';
    const receiptPath = '.tmp/external-receipts/external-operations-evidence.json';
    const placeholderDocument = {
        schema: 'fsusblog.local-production.summary-only.v1',
        tierId: 'external-operations-evidence', status: 'collected-blocked', executionSource: 'external-environment',
        schedulerRunId: fixture.result.runId, sourceState: fixture.result.checkpoint.sourceState
    };
    fs.writeFileSync(path.join(fixture.temp, placeholderPath), `${JSON.stringify(placeholderDocument)}\n`);
    const receipt = {
        schema: 'fsusblog.external-correctness-receipt.v1',
        tierId: 'external-operations-evidence',
        authorityId: 'external-production-authority',
        schedulerRunId: fixture.result.runId,
        sourceState: fixture.result.checkpoint.sourceState,
        buildIdentity: {
            schedulerRunId: fixture.result.runId,
            sourceState: fixture.result.checkpoint.sourceState,
            artifactDigestTableDigest: `sha256:${'1'.repeat(64)}`
        },
        testIds: ['external:operation'],
        coverageIds: ['coverage:external-operation'],
        assertionIds: ['assertion:external-operation'],
        status: 'success'
    };
    receipt.contentDigest = externalEvidenceReceiptDigest(receipt);
    fs.mkdirSync(path.dirname(path.join(fixture.temp, receiptPath)), { recursive: true });
    fs.writeFileSync(path.join(fixture.temp, receiptPath), `${JSON.stringify(receipt)}\n`);
    const placeholder = {
        ...placeholderDocument,
        evidencePath: placeholderPath,
        artifactDigest: digestFile(path.join(fixture.temp, placeholderPath))
    };
    const resolved = resolveExternalEvidenceReceipts({
        summaryOnlyEvidence: { 'external-operations-evidence': placeholder },
        externalEvidenceReceipts: { 'external-operations-evidence': [{ receiptPath, receipt }] },
        checkpoint: fixture.result.checkpoint,
        canonicalAuthorities: { 'external-operations-evidence': 'external-production-authority' },
        buildIdentity: receipt.buildIdentity
    });
    fixture.projection.entries['external-operations-evidence'] = resolved['external-operations-evidence'];
    fixture.projection.summaryOnlyTierCount = 0;
    fixture.projection.executedTierCount = 2;
    fixture.projection.status = 'complete-success';
    fixture.projection.qualificationEligible = true;
    const invalidProjection = structuredClone(fixture.projection);
    invalidProjection.logicalTierCount += 1;
    await assert.rejects(
        attachCheckpointEvidence(fixture.result.checkpointPath, fixture.result.runId, {
            logicalTierProjection: invalidProjection
        }, fixture.attachOptions),
        /logicalTierCount must match its entries/u
    );
    const failedCheckpointText = fs.readFileSync(fixture.result.checkpointPath, 'utf8');
    assert.equal(isProjectionOnlyCheckpointFailure(JSON.parse(failedCheckpointText)), true);
    let completionCalls = 0;
    await assert.rejects(
        resumeCheckpointEvidence(
            fixture.result.checkpointPath,
            fixture.result.runId,
            () => ({ logicalTierProjection: fixture.projection }),
            {
                root: fixture.temp,
                snapshotWorktree: stableSnapshot,
                beforeCommit: async () =>
                {
                    completionCalls += 1;
                    throw new Error('projection capacity completion failed');
                }
            }
        ),
        /projection capacity completion failed/u
    );
    assert.equal(completionCalls, 1);
    assert.equal(fs.readFileSync(fixture.result.checkpointPath, 'utf8'), failedCheckpointText);
    await assert.rejects(
        resumeCheckpointEvidence(
            fixture.result.checkpointPath,
            fixture.result.runId,
            () => ({ logicalTierProjection: fixture.projection }),
            {
                root: fixture.temp,
                snapshotWorktree: stableSnapshot
            }
        ),
        /requires a beforeCommit completion callback/u
    );
    assert.equal(fs.readFileSync(fixture.result.checkpointPath, 'utf8'), failedCheckpointText);
    let snapshotCalls = 0;
    await assert.rejects(
        resumeCheckpointEvidence(
            fixture.result.checkpointPath,
            fixture.result.runId,
            () => ({ logicalTierProjection: fixture.projection }),
            {
                root: fixture.temp,
                snapshotWorktree: async () =>
                {
                    snapshotCalls += 1;
                    return snapshotCalls < 3
                        ? { fingerprint: 'stable', entries: {} }
                        : { fingerprint: 'drifted-after-completion', entries: {} };
                },
                beforeCommit: async () =>
                {
                    completionCalls += 1;
                }
            }
        ),
        /checkpoint sourceState does not match the current repository source/u
    );
    assert.equal(snapshotCalls, 3);
    assert.equal(completionCalls, 2);
    assert.equal(fs.readFileSync(fixture.result.checkpointPath, 'utf8'), failedCheckpointText);
    assert.equal(
        isProjectionOnlyCheckpointFailure(
            JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'))),
        true
    );
    const transactionFile =
        `${fixture.result.checkpointPath}.projection-resume-transaction.json`;
    const transactionText = fs.readFileSync(transactionFile, 'utf8');
    const assertTransactionRejected = async (pattern) =>
    {
        await assert.rejects(
            resumeCheckpointEvidence(
                fixture.result.checkpointPath,
                fixture.result.runId,
                () => ({ logicalTierProjection: fixture.projection }),
                {
                    root: fixture.temp,
                    snapshotWorktree: stableSnapshot,
                    beforeCommit: async () => assert.fail('invalid transaction cannot complete')
                }
            ),
            pattern
        );
        assert.equal(fs.readFileSync(fixture.result.checkpointPath, 'utf8'), failedCheckpointText);
    };
    fs.writeFileSync(transactionFile, '{"tampered":true}\n');
    await assertTransactionRejected(/transaction checkpoint bytes are invalid/u);
    fs.writeFileSync(transactionFile, transactionText);
    const digestMismatch = JSON.parse(transactionText);
    digestMismatch.contentDigest = '0'.repeat(64);
    fs.writeFileSync(transactionFile, `${JSON.stringify(digestMismatch, null, 2)}\n`);
    await assertTransactionRejected(/transaction authority is invalid/u);
    fs.writeFileSync(transactionFile, transactionText);
    const symlinkTarget = `${transactionFile}.symlink-target`;
    fs.writeFileSync(symlinkTarget, transactionText);
    fs.rmSync(transactionFile);
    fs.symlinkSync(symlinkTarget, transactionFile);
    await assertTransactionRejected(/must be a regular file/u);
    fs.rmSync(transactionFile);
    fs.writeFileSync(transactionFile, transactionText);
    assert.throws(
        () => markCheckpointWallClockTimeout(
            fixture.result.checkpointPath,
            { tierId: 'production', reason: 'generic writer must be guarded' }),
        /generic checkpoint writer cannot enter a projection resume transaction/u
    );
    assert.equal(fs.readFileSync(fixture.result.checkpointPath, 'utf8'), failedCheckpointText);
    for (const persistenceStage of [
        'journal-durable',
        'compact-durable',
        'compatibility-staged',
        'metrics-durable',
        'commit-before'
    ])
    {
        const observedStages = [];
        await assert.rejects(
            resumeCheckpointEvidence(
                fixture.result.checkpointPath,
                fixture.result.runId,
                () => ({ logicalTierProjection: fixture.projection }),
                {
                    root: fixture.temp,
                    snapshotWorktree: stableSnapshot,
                    beforeCommit: async () =>
                    {
                        completionCalls += 1;
                    },
                    projectionPersistenceFaultInjector: (stage) =>
                    {
                        observedStages.push(stage);
                        if (stage === persistenceStage)
                        {
                            throw new Error(`projection persistence failed at ${stage}`);
                        }
                    }
                }
            ),
            new RegExp(`projection persistence failed at ${persistenceStage}`, 'u')
        );
        assert.equal(observedStages.includes(persistenceStage), true);
        assert.equal(fs.readFileSync(fixture.result.checkpointPath, 'utf8'), failedCheckpointText);
        assert.equal(
            fs.existsSync(`${fixture.result.checkpointPath}.projection-resume-transaction.json`),
            true
        );
        assert.equal(
            isProjectionOnlyCheckpointFailure(
                JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'))),
            true
        );
    }
    const preparedTransaction = JSON.parse(transactionText);
    const stagedCheckpoint =
        `${fixture.result.checkpointPath}.projection-success-${preparedTransaction.expectedSuccessDigest}`;
    await assert.rejects(
        resumeCheckpointEvidence(
            fixture.result.checkpointPath,
            fixture.result.runId,
            () => ({ logicalTierProjection: fixture.projection }),
            {
                root: fixture.temp,
                snapshotWorktree: stableSnapshot,
                beforeCommit: async () =>
                {
                    completionCalls += 1;
                },
                projectionPersistenceFaultInjector: (stage) =>
                {
                    if (stage === 'commit-before')
                    {
                        fs.writeFileSync(fixture.result.checkpointPath, `${failedCheckpointText} `);
                    }
                }
            }
        ),
        /baseline checkpoint changed before commit/u
    );
    fs.writeFileSync(fixture.result.checkpointPath, failedCheckpointText);
    await assert.rejects(
        resumeCheckpointEvidence(
            fixture.result.checkpointPath,
            fixture.result.runId,
            () => ({ logicalTierProjection: fixture.projection }),
            {
                root: fixture.temp,
                snapshotWorktree: stableSnapshot,
                beforeCommit: async () =>
                {
                    completionCalls += 1;
                },
                projectionPersistenceFaultInjector: (stage) =>
                {
                    if (stage === 'commit-before')
                    {
                        fs.writeFileSync(stagedCheckpoint, `${preparedTransaction.expectedSuccessBytes} `);
                    }
                }
            }
        ),
        /staged checkpoint changed before commit/u
    );
    fs.writeFileSync(stagedCheckpoint, preparedTransaction.expectedSuccessBytes);
    const attached = await resumeCheckpointEvidence(
        fixture.result.checkpointPath,
        fixture.result.runId,
        () => ({ logicalTierProjection: fixture.projection }),
        {
            root: fixture.temp,
            snapshotWorktree: stableSnapshot,
            beforeCommit: async ({ checkpoint, evidence, checkpointFile }) =>
            {
                completionCalls += 1;
                assert.equal(checkpoint.status, 'success');
                assert.deepEqual(checkpoint.logicalTierProjection, fixture.projection);
                assert.deepEqual(evidence.logicalTierProjection, fixture.projection);
                assert.equal(checkpointFile, path.resolve(fixture.result.checkpointPath));
                assert.equal(fs.readFileSync(fixture.result.checkpointPath, 'utf8'), failedCheckpointText);
            }
        }
    );
    assert.equal(completionCalls, 10);
    assert.equal(
        fs.existsSync(`${fixture.result.checkpointPath}.projection-resume-transaction.json`),
        true
    );
    const committedTransaction = JSON.parse(fs.readFileSync(transactionFile, 'utf8'));
    const committedCheckpointText = fs.readFileSync(fixture.result.checkpointPath, 'utf8');
    const committedCheckpoint = JSON.parse(committedCheckpointText);
    assert.equal(committedCheckpointText, committedTransaction.expectedSuccessBytes);
    assert.equal(
        createHash('sha256').update(committedCheckpointText).digest('hex'),
        committedTransaction.expectedSuccessDigest
    );
    assert.equal(committedCheckpoint.revision, committedTransaction.expectedRevision);
    assert.deepEqual(committedCheckpoint, attached);
    const committedStore = new RunEvidenceObjectStore({
        root: path.join(path.dirname(fixture.result.checkpointPath), 'evidence-store'),
        runId: fixture.result.runId,
        sourceState: committedCheckpoint.sourceState
    });
    const recovered = committedStore.recover(applyFixtureCheckpointPatch);
    const compact = committedStore.readCompactCheckpoint();
    assert.deepEqual(recovered.state, committedCheckpoint);
    assert.deepEqual(compact.state, committedCheckpoint);
    assert.equal(recovered.lastSequence, compact.checkpoint.lastSequence);
    const storageMetrics = JSON.parse(fs.readFileSync(
        path.join(path.dirname(fixture.result.checkpointPath), 'evidence-storage-metrics.json'),
        'utf8'
    ));
    assert.equal(
        storageMetrics.projectionCheckpointDigest,
        committedTransaction.expectedSuccessDigest
    );
    assert.equal(
        storageMetrics.projectionCheckpointRevision,
        committedTransaction.expectedRevision
    );
    assert.equal(storageMetrics.schedulerCompatibilityCheckpointWrites, 2);
    assert.equal(
        storageMetrics.schedulerCompatibilityCheckpointBytesWritten,
        Buffer.byteLength(committedTransaction.baselineBytes)
        + Buffer.byteLength(committedTransaction.expectedSuccessBytes)
    );
    assert.throws(
        () => markCheckpointWallClockTimeout(
            fixture.result.checkpointPath,
            { tierId: 'production', reason: 'committed generic writer must be guarded' }),
        /generic checkpoint writer cannot enter a projection resume transaction/u
    );
    assert.equal(
        fs.readFileSync(fixture.result.checkpointPath, 'utf8'),
        committedCheckpointText
    );
    assert.equal(attached.logicalTierProjection.entries['external-operations-evidence'].evidenceKind, 'external-executed');
    assert.deepEqual(attached.logicalTierProjection.entries['external-operations-evidence'].blockedPlaceholder, placeholder);
    fs.writeFileSync(path.join(fixture.temp, placeholderPath), '{"tampered":true}\n');
    assert.throws(() => validateLocalProfileCheckpointEvidence(attached, fixture.temp), /blocked placeholder/u);

    for (const mutate of [
        (candidate) =>
        {
            candidate.schedulerRunId = 'old-run';
        },
        (candidate) =>
        {
            candidate.status = 'failed';
        },
        (candidate) =>
        {
            candidate.status = 'cancelled';
        },
        (candidate) =>
        {
            candidate.authorityId = 'forged-authority';
        },
        (candidate) =>
        {
            candidate.buildIdentity.buildId = 'forged-build';
        },
        (candidate) =>
        {
            candidate.contentDigest = `sha256:${'0'.repeat(64)}`;
        }
    ])
    {
        const invalid = structuredClone(receipt);
        mutate(invalid);
        assert.throws(() => resolveExternalEvidenceReceipts({
            summaryOnlyEvidence: { 'external-operations-evidence': placeholder },
            externalEvidenceReceipts: { 'external-operations-evidence': [{ receiptPath, receipt: invalid }] },
            checkpoint: fixture.result.checkpoint,
            canonicalAuthorities: { 'external-operations-evidence': 'external-production-authority' },
            buildIdentity: receipt.buildIdentity
        }));
    }
    for (const field of ['testIds', 'coverageIds', 'assertionIds'])
    {
        const invalid = structuredClone(receipt);
        invalid[field] = [];
        invalid.contentDigest = externalEvidenceReceiptDigest(invalid);
        assert.throws(() => resolveExternalEvidenceReceipts({
            summaryOnlyEvidence: { 'external-operations-evidence': placeholder },
            externalEvidenceReceipts: { 'external-operations-evidence': [{ receiptPath, receipt: invalid }] },
            checkpoint: fixture.result.checkpoint,
            canonicalAuthorities: { 'external-operations-evidence': 'external-production-authority' },
            buildIdentity: receipt.buildIdentity
        }), new RegExp(`${field} must be non-empty`, 'u'));
    }
    assert.deepEqual(resolveExternalEvidenceReceipts({
        summaryOnlyEvidence: { 'external-operations-evidence': placeholder }, externalEvidenceReceipts: {},
        checkpoint: fixture.result.checkpoint, canonicalAuthorities: { 'external-operations-evidence': 'external-production-authority' },
        buildIdentity: receipt.buildIdentity
    }), {});
    assert.throws(() => resolveExternalEvidenceReceipts({
        summaryOnlyEvidence: { 'external-operations-evidence': placeholder },
        externalEvidenceReceipts: { 'external-operations-evidence': [{ receiptPath, receipt }, { receiptPath, receipt }] },
        checkpoint: fixture.result.checkpoint,
        canonicalAuthorities: { 'external-operations-evidence': 'external-production-authority' },
        buildIdentity: receipt.buildIdentity
    }), /exact-one/u);
    assert.throws(() => resolveExternalEvidenceReceipts({
        summaryOnlyEvidence: { 'external-operations-evidence': placeholder },
        externalEvidenceReceipts: {
            'external-operations-evidence': [{ receiptPath, receipt }],
            'extra-tier': []
        },
        checkpoint: fixture.result.checkpoint,
        canonicalAuthorities: { 'external-operations-evidence': 'external-production-authority' },
        buildIdentity: receipt.buildIdentity
    }), /exactly match/u);
});

test('checkpoint projection rejects deleting a blocked entry to forge complete-success', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    const fixture = await createCheckpointEvidenceFixture(runDag, 'deleted-summary-only-entry');
    delete fixture.projection.entries['external-operations-evidence'];
    fixture.projection.logicalTierIds = ['production'];
    fixture.projection.logicalTierCount = 1;
    fixture.projection.summaryOnlyTierCount = 0;
    fixture.projection.executedTierCount = 1;
    fixture.projection.status = 'complete-success';
    fixture.projection.qualificationEligible = true;
    await assert.rejects(() => attachCheckpointEvidence(fixture.result.checkpointPath, fixture.result.runId, {
        logicalTierProjection: fixture.projection
    }, fixture.attachOptions), /logical tier projection|summary-only|logicalTierIds/u);
});

test('projection-only resume cannot promote an incomplete external-evidence projection', async () =>
{
    const { resumeCheckpointEvidence, runDag } = await loadScheduler();
    const fixture = await createCheckpointEvidenceFixture(runDag, 'resume-incomplete-external-evidence');
    const checkpoint = JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'));
    checkpoint.status = 'failure';
    checkpoint.authoritative = true;
    checkpoint.failure = { reason: 'checkpoint evidence finalization failed: incomplete external evidence' };
    checkpoint.ungeneratedEvidence = [{ tierId: 'production', declaration: 'logicalTierProjection' }];
    fs.writeFileSync(fixture.result.checkpointPath, `${JSON.stringify(checkpoint)}\n`);
    await assert.rejects(() => resumeCheckpointEvidence(
        fixture.result.checkpointPath,
        fixture.result.runId,
        () => ({ logicalTierProjection: fixture.projection }),
        { root: fixture.temp, snapshotWorktree: stableSnapshot }
    ), /qualification-eligible complete-success/u);
});

test('checkpoint projection validates logical artifact refs through one final run-bound digest table', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    const fixture = await createCheckpointEvidenceFixture(runDag, 'scheduler-artifact-table');
    const { descriptor } = bindFixtureToArtifactDigestTable(fixture);
    const attached = await attachCheckpointEvidence(fixture.result.checkpointPath, 'production-fresh', {
        logicalTierProjection: fixture.projection
    }, fixture.attachOptions);

    assert.equal(attached.logicalTierProjection.artifactDigestTable.contentDigest, descriptor.contentDigest);
    assert.deepEqual(
        Object.keys(attached.logicalTierProjection.entries.production.artifactRefs).sort(),
        Object.keys(attached.logicalTierProjection.entries.production.artifactDigests).sort()
    );
});

test('checkpoint projection rejects a corrupted or source-mismatched digest table', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    for (const mode of ['corrupt', 'source'])
    {
        const fixture = await createCheckpointEvidenceFixture(runDag, `scheduler-artifact-table-${mode}`);
        const { tableFile } = bindFixtureToArtifactDigestTable(fixture);
        if (mode === 'corrupt')
        {
            const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
            table.metrics.shaCalls += 1;
            fs.writeFileSync(tableFile, `${JSON.stringify(table, null, 2)}\n`);
        }
        else
        {
            fixture.projection.artifactDigestTable.sourceState.worktreeFingerprint = 'wrong-source';
        }
        await assert.rejects(
            attachCheckpointEvidence(fixture.result.checkpointPath, 'production-fresh', {
                logicalTierProjection: fixture.projection
            }, fixture.attachOptions),
      mode === 'corrupt' ? /content digest mismatch/u : /descriptor does not match its table|source fingerprint/u
        );
    }
});

test('checkpoint evidence attach rejects deep projection entry tampering and persists failure', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    const cases = [
        {
            name: 'summary-only-success',
            mutate: (projection) =>
            {
                projection.status = 'complete-success';
                projection.qualificationEligible = false;
            },
            pattern: /summary-only entries must be incomplete or failed and unqualified/u
        },
        {
            name: 'summary-only-qualification',
            mutate: (projection) =>
            {
                projection.qualificationEligible = true;
            },
            pattern: /qualificationEligible must match summary-only entries/u
        },
        {
            name: 'tier-id',
            mutate: (projection) =>
            {
                projection.entries.production.tierId = 'other';
            },
            pattern: /tierId must match its key/u
        },
        {
            name: 'status',
            mutate: (projection) =>
            {
                projection.entries.production.status = 'failure';
            },
            pattern: /status must be success/u
        },
        {
            name: 'source',
            mutate: (projection) =>
            {
                projection.entries.production.executionSource = 'cache';
            },
            pattern: /executionSource must be fresh/u
        },
        {
            name: 'test-ids',
            mutate: (projection) =>
            {
                projection.entries.production.testIds = [];
            },
            pattern: /testIds do not match its evidenceKind/u
        },
        {
            name: 'digests',
            mutate: (projection) =>
            {
                const artifactPath = Object.keys(projection.entries.production.artifactDigests)[0];
                projection.entries.production.artifactDigests[artifactPath] = `sha256:${'0'.repeat(64)}`;
            },
            pattern: /artifact digest does not match/u
        },
        {
            name: 'physical-bundle',
            mutate: (projection) =>
            {
                projection.entries.production.physicalBundleId = 'other';
            },
            pattern: /physical bundle local-production-other must be fresh and successful/u
        },
        {
            name: 'substitution-proofs',
            mutate: (projection) =>
            {
                projection.entries.production.artifactSubstitutionProofs = null;
            },
            pattern: /artifactSubstitutionProofs must be an object/u
        }
    ];

    for (const fixtureCase of cases)
    {
        const { result, projection, attachOptions } = await createCheckpointEvidenceFixture(
            runDag,
            `scheduler-checkpoint-entry-${fixtureCase.name}`
        );
        fixtureCase.mutate(projection);
        await assert.rejects(
            attachCheckpointEvidence(result.checkpointPath, 'production-fresh', {
                logicalTierProjection: projection
            }, attachOptions),
            fixtureCase.pattern
        );
        const persisted = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
        assert.equal(persisted.status, 'failure');
        assert.equal(persisted.failurePoint, 'production');
        assert.match(persisted.failure.reason, /checkpoint evidence finalization failed/u);
        assert.deepEqual(persisted.ungeneratedEvidence, [{
            tierId: 'production',
            declaration: 'logicalTierProjection'
        }]);
    }
});

test('checkpoint evidence attach rejects tampered bundle summaries and changed source state', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();

    const tampered = await createCheckpointEvidenceFixture(runDag, 'scheduler-checkpoint-summary-tamper');
    let tamperedBuilderCalled = false;
    fs.appendFileSync(path.join(tampered.temp, tampered.summaryPath), '{"tampered":true}\n');
    await assert.rejects(
        attachCheckpointEvidence(tampered.result.checkpointPath, 'production-fresh', () =>
        {
            tamperedBuilderCalled = true;
            return { logicalTierProjection: tampered.projection };
        }, tampered.attachOptions),
        /checkpoint output digest does not match current bundle summary/u
    );
    assert.equal(tamperedBuilderCalled, false);
    assert.equal(JSON.parse(fs.readFileSync(tampered.result.checkpointPath, 'utf8')).status, 'failure');

    const changedSource = await createCheckpointEvidenceFixture(runDag, 'scheduler-checkpoint-source-tamper');
    await assert.rejects(
        attachCheckpointEvidence(changedSource.result.checkpointPath, 'production-fresh', {
            logicalTierProjection: changedSource.projection
        }, {
            ...changedSource.attachOptions,
            snapshotWorktree: async () => ({ fingerprint: 'changed', entries: {} })
        }),
        /sourceState does not match the current repository source/u
    );
    assert.equal(JSON.parse(fs.readFileSync(changedSource.result.checkpointPath, 'utf8')).status, 'failure');
});

test('checkpoint evidence attach accepts later mutations of outputs sealed by the bundle summary', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    for (const declarationKind of ['direct', 'directoryFile', 'wildcardFile'])
    {
        const fixture = await createCheckpointEvidenceFixture(
            runDag,
            `scheduler-checkpoint-${declarationKind}-tamper`
        );
        fs.appendFileSync(path.join(fixture.temp, fixture.artifactPaths[declarationKind]), 'tampered\n');
        const attached = await attachCheckpointEvidence(fixture.result.checkpointPath, 'production-fresh', {
            logicalTierProjection: fixture.projection
        }, fixture.attachOptions);
        assert.equal(attached.status, 'success');
    }
});

test('checkpoint evidence attach accepts a missing canonical artifact only with a bound substitution proof', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    const fixture = await createCheckpointEvidenceFixture(runDag, 'scheduler-checkpoint-substitution-success');
    const { canonicalPath } = addArtifactSubstitutionProof(fixture);
    assert.equal(fs.existsSync(path.join(fixture.temp, canonicalPath)), false);
    const attached = await attachCheckpointEvidence(fixture.result.checkpointPath, 'production-fresh', {
        logicalTierProjection: fixture.projection
    }, fixture.attachOptions);
    assert.equal(attached.status, 'success');
    assert.deepEqual(
        attached.logicalTierProjection.entries.production.artifactSubstitutionProofs,
        fixture.projection.entries.production.artifactSubstitutionProofs
    );
});

test('checkpoint evidence attach rejects tampered substitution bindings and undeclared synthetic digests', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    const cases = [
        {
            name: 'canonical-key',
            mutate(fixture, proof)
            {
                fixture.projection.entries.production.artifactSubstitutionProofs[proof.canonicalPath].canonicalPath = 'other';
            },
            pattern: /substitution canonicalPath must match its key/u
        },
        {
            name: 'actual-digests',
            mutate(fixture, proof)
            {
                const actualPath = proof.actualPaths[0];
                fixture.projection.entries.production.artifactSubstitutionProofs[proof.canonicalPath]
                    .actualDigests[actualPath] = `sha256:${'0'.repeat(64)}`;
            },
            pattern: /substitution actual digest must match artifactDigests/u
        },
        {
            name: 'binding-digest',
            mutate(fixture, proof)
            {
                fixture.projection.entries.production.artifactSubstitutionProofs[proof.canonicalPath]
                    .canonicalDigest = `sha256:${'0'.repeat(64)}`;
            },
            pattern: /substitution canonicalDigest is invalid/u
        }
    ];
    for (const fixtureCase of cases)
    {
        const fixture = await createCheckpointEvidenceFixture(
            runDag,
            `scheduler-checkpoint-substitution-${fixtureCase.name}`
        );
        const proof = addArtifactSubstitutionProof(fixture);
        fixtureCase.mutate(fixture, proof);
        await assert.rejects(
            attachCheckpointEvidence(fixture.result.checkpointPath, 'production-fresh', {
                logicalTierProjection: fixture.projection
            }, fixture.attachOptions),
            fixtureCase.pattern
        );
        assert.equal(JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8')).status, 'failure');
    }

    const synthetic = await createCheckpointEvidenceFixture(runDag, 'scheduler-checkpoint-undeclared-synthetic');
    synthetic.projection.entries.production.artifactDigests[
        '.tmp/local-production/build-static/undeclared-synthetic.json'
    ] = `sha256:${'f'.repeat(64)}`;
    await assert.rejects(
        attachCheckpointEvidence(synthetic.result.checkpointPath, 'production-fresh', {
            logicalTierProjection: synthetic.projection
        }, synthetic.attachOptions),
        /artifact digest does not match: .*undeclared-synthetic/u
    );
    assert.equal(JSON.parse(fs.readFileSync(synthetic.result.checkpointPath, 'utf8')).status, 'failure');
});

test('checkpoint evidence builder failure is persisted instead of leaving a success checkpoint', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    const { result, attachOptions } = await createCheckpointEvidenceFixture(runDag, 'scheduler-checkpoint-builder-failure');
    await assert.rejects(
        attachCheckpointEvidence(result.checkpointPath, 'production-fresh', () =>
        {
            throw new Error('projection builder exploded');
        }, attachOptions),
        /projection builder exploded/u
    );
    const persisted = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'));
    assert.equal(persisted.status, 'failure');
    assert.match(persisted.failure.reason, /projection builder exploded/u);
});

test('projection-only resume rejects physical evidence from a different source state', async () =>
{
    const {
        attachCheckpointEvidence,
        isProjectionOnlyCheckpointFailure,
        resumeCheckpointEvidence,
        runDag
    } = await loadScheduler();
    const fixture = await createCheckpointEvidenceFixture(runDag, 'scheduler-projection-resume');
    const invalidProjection = structuredClone(fixture.projection);
    invalidProjection.logicalTierCount += 1;
    await assert.rejects(
        attachCheckpointEvidence(fixture.result.checkpointPath, 'production-fresh', {
            logicalTierProjection: invalidProjection
        }, fixture.attachOptions),
        /logicalTierCount must match its entries/u
    );
    assert.equal(
        isProjectionOnlyCheckpointFailure(JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'))),
        true
    );
    const failedCheckpoint = JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'));
    assert.equal(isProjectionOnlyCheckpointFailure({ ...failedCheckpoint, mode: 'resume' }), false);
    assert.equal(isProjectionOnlyCheckpointFailure({ ...failedCheckpoint, authoritative: false }), false);

    let builderCalled = false;
    await assert.rejects(
        resumeCheckpointEvidence(
            fixture.result.checkpointPath,
            'production-fresh',
            () =>
            {
                builderCalled = true;
                return { logicalTierProjection: fixture.projection };
            },
            {
                root: fixture.temp,
                snapshotWorktree: async () => ({ fingerprint: 'projection-fix', entries: {} })
            }
        ),
        /checkpoint sourceState does not match the current repository source/u
    );
    assert.equal(builderCalled, false);
    assert.equal(JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8')).status, 'failure');
});

test('projection-only resume refuses same-source physical evidence when its projection remains incomplete', async () =>
{
    const {
        attachCheckpointEvidence,
        isProjectionOnlyCheckpointFailure,
        resumeCheckpointEvidence,
        runDag
    } = await loadScheduler();
    const fixture = await createCheckpointEvidenceFixture(runDag, 'scheduler-projection-resume-same-source');
    const invalidProjection = structuredClone(fixture.projection);
    invalidProjection.logicalTierCount += 1;
    await assert.rejects(
        attachCheckpointEvidence(fixture.result.checkpointPath, 'production-fresh', {
            logicalTierProjection: invalidProjection
        }, fixture.attachOptions),
        /logicalTierCount must match its entries/u
    );

    await assert.rejects(() => resumeCheckpointEvidence(
        fixture.result.checkpointPath,
        'production-fresh',
        (successfulCheckpoint) =>
        {
            assert.equal(successfulCheckpoint.status, 'success');
            return { logicalTierProjection: fixture.projection };
        },
        {
            root: fixture.temp,
            snapshotWorktree: stableSnapshot
        }
    ), /qualification-eligible complete-success/u);
    assert.equal(isProjectionOnlyCheckpointFailure(JSON.parse(fs.readFileSync(fixture.result.checkpointPath, 'utf8'))), true);
});

test('checkpoint evidence generation and attach reject a concurrent writer for the same run', async () =>
{
    const { attachCheckpointEvidence, runDag } = await loadScheduler();
    const { result, projection, attachOptions } = await createCheckpointEvidenceFixture(runDag, 'scheduler-checkpoint-attach-lock');
    let enterBuilder;
    let releaseBuilder;
    const builderEntered = new Promise((resolve) =>
    {
        enterBuilder = resolve;
    });
    const builderRelease = new Promise((resolve) =>
    {
        releaseBuilder = resolve;
    });
    const firstWriter = attachCheckpointEvidence(result.checkpointPath, 'production-fresh', async () =>
    {
        enterBuilder();
        await builderRelease;
        return { logicalTierProjection: projection };
    }, attachOptions);

    await builderEntered;
    await assert.rejects(
        attachCheckpointEvidence(result.checkpointPath, 'production-fresh', {
            logicalTierProjection: projection
        }, attachOptions),
        /test matrix run production-fresh is already active/u
    );
    releaseBuilder();
    const attached = await firstWriter;
    assert.equal(attached.status, 'success');
    assert.deepEqual(attached.logicalTierProjection, projection);
    assert.equal(JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8')).status, 'success');
});

test('runDag honors exclusive resources, load-adjusted CPU, memory, and maxParallel limits', async () =>
{
    const { runDag } = await loadScheduler();
    assert.equal(typeof runDag, 'function');

    const temp = createTempDir('scheduler-resources');
    const active = new Set();
    let maxActive = 0;
    let sharedOverlap = false;
    const result = await runDag({
        tiers: [
            tier('first', { exclusiveResources: ['database'], cpuUnits: 2, memoryGiB: 3 }),
            tier('second', { exclusiveResources: ['database'], cpuUnits: 2, memoryGiB: 3 }),
            tier('third', { cpuUnits: 2, memoryGiB: 3 })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'resources',
        maxParallel: 2,
        systemResources: { cpuCount: 4, availableMemoryGiB: 4, load1: 2 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            if (current.exclusiveResources.includes('database') && [...active].some((item) => item.exclusiveResources.includes('database')))
            {
                sharedOverlap = true;
            }
            active.add(current);
            maxActive = Math.max(maxActive, active.size);
            await delay(20);
            active.delete(current);
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(sharedOverlap, false);
    assert.equal(maxActive, 1, 'load-adjusted CPU and available memory should serialize these tiers');
});

test('runDag refuses an oversized first tier without spawning it', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-unschedulable-resource');
    let executions = 0;
    const result = await runDag({
        tiers: [tier('oversized', { cpuUnits: 5, memoryGiB: 2 })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'unschedulable-resource',
        maxParallel: 1,
        systemResources: { cpuCount: 4, availableMemoryGiB: 4, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            executions += 1;
            return { code: 0, signal: null };
        }
    });

    assert.equal(executions, 0);
    assert.equal(result.status, 'failure');
    assert.equal(result.failure.tierId, 'oversized');
    assert.match(result.failure.reason, /unschedulable resource request.*cpu=5\/4/u);
});

test('runDag accepts an explicit measured CPU envelope without discarding it for recorded load', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-explicit-cpu-envelope');
    let active = 0;
    let peak = 0;
    const result = await runDag({
        tiers: [tier('one', { cpuUnits: 4, memoryGiB: 1 }), tier('two', { cpuUnits: 4, memoryGiB: 1 })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'explicit-cpu-envelope',
        maxParallel: 2,
        systemResources: { cpuCount: 8, availableCpuUnits: 8, availableMemoryGiB: 4, load1: 7 },
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            active += 1;
            peak = Math.max(peak, active);
            await delay(20);
            active -= 1;
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(result.checkpoint.resourceBudget.cpuUnits, 8);
    assert.equal(peak, 2);
});

test('dynamic admission grants fill the live envelope across only the currently ready tiers', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-dynamic-admission');
    const grants = new Map();
    const dynamicTier = (id, overrides = {}) => tier(id, {
        resourceGrantMode: 'dynamic',
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        cpuUnits: 8,
        memoryGiB: 12,
        ...overrides
    });
    const result = await runDag({
        tiers: [
            dynamicTier('ready-heavy', { cpuWeight: 3, memoryWeight: 2, minCpuUnits: 2 }),
            dynamicTier('ready-light'),
            dynamicTier('later-only', { executionDependsOn: ['ready-heavy', 'ready-light'] })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'dynamic-admission',
        maxParallel: 8,
        systemResources: { cpuCount: 8, availableCpuUnits: 8, availableMemoryGiB: 12, load1: 0 },
        currentFreeMemoryGiB: () => 10,
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            grants.set(current.id, { cpuUnits: current.cpuUnits, memoryGiB: current.memoryGiB });
            await delay(20);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    assert.equal(grants.get('ready-heavy').cpuUnits + grants.get('ready-light').cpuUnits, 8);
    assert.equal(grants.get('ready-heavy').cpuUnits, 6);
    assert.equal(grants.get('ready-light').cpuUnits, 2);
    assert.equal(grants.get('ready-heavy').memoryGiB + grants.get('ready-light').memoryGiB, 10);
    assert.equal(grants.get('later-only').cpuUnits, 8, 'a sole ready tier must receive the full CPU envelope');
    assert.equal(grants.get('later-only').memoryGiB, 10, 'a sole ready tier must receive current free memory');
});

test('five-CPU startup admits all production t0 bundles deterministically with safe memory grants', async () =>
{
    const { runDag } = await loadScheduler();
    const runOrder = async (ids, runId) =>
    {
        const temp = createTempDir(`scheduler-startup-${runId}`);
        const declarations = {
            build: { startupMinCpuUnits: 1, minCpuUnits: 2, startupMemoryWeight: 3, startupPriority: 3, deadlineWeight: 18 },
            backend: { startupMinCpuUnits: 1, minCpuUnits: 2, startupMemoryWeight: 4, startupPriority: 4, deadlineWeight: 44 },
            frontend: { startupMinCpuUnits: 1, minCpuUnits: 1, startupMemoryWeight: 2, startupPriority: 3, deadlineWeight: 27 },
            runtime: { startupMinCpuUnits: 1, minCpuUnits: 1, startupMemoryWeight: 5, startupPriority: 4, deadlineWeight: 24 }
        };
        const starts = [];
        let releaseWave;
        const waveReady = new Promise((resolve) =>
        {
            releaseWave = resolve;
        });
        const result = await runDag({
            tiers: ids.map((id) => tier(id, {
                resourceGrantMode: 'dynamic',
                cpuWeight: declarations[id].minCpuUnits,
                memoryWeight: declarations[id].startupMemoryWeight,
                cpuUnits: 5,
                memoryGiB: 9,
                ...declarations[id]
            })),
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId,
            maxParallel: 5,
            systemResources: { cpuCount: 5, availableCpuUnits: 5, availableMemoryGiB: 9, load1: 0 },
            currentFreeMemoryGiB: () => 7,
            snapshotWorktree: stableSnapshot,
            executeTier: async (current) =>
            {
                starts.push({ id: current.id, cpuUnits: current.cpuUnits, memoryGiB: current.memoryGiB });
                if (starts.length === 4)
                {
                    releaseWave();
                }
                await waveReady;
                return { code: 0, signal: null };
            }
        });
        assert.equal(result.status, 'success');
        assert.equal(starts.length, 4);
        assert.equal(starts.reduce((sum, entry) => sum + entry.cpuUnits, 0), 5);
        assert.ok(Math.abs(starts.reduce((sum, entry) => sum + entry.memoryGiB, 0) - 7) < 1e-9);
        assert.deepEqual(Object.fromEntries(starts.map((entry) => [entry.id, entry.cpuUnits])), {
            backend: 2,
            runtime: 1,
            frontend: 1,
            build: 1
        });
        for (const [id, evidence] of Object.entries(result.checkpoint.tiers))
        {
            assert.ok(evidence.startupGrant.cpuUnits >= declarations[id].startupMinCpuUnits);
            assert.ok(evidence.startupGrant.memoryGiB > 0);
            assert.ok(Number.isFinite(evidence.admittedAtMs));
            assert.ok(Number.isFinite(evidence.firstExecutableStepAtMs));
            assert.ok(evidence.firstExecutableStepAtMs >= evidence.admittedAtMs);
            assert.deepEqual(evidence.resourceGrantHistory[0].cpuUnits, evidence.startupGrant.cpuUnits);
        }
        return starts.map((entry) => entry.id);
    };

    const declaredOrder = await runOrder(['build', 'backend', 'frontend', 'runtime'], 'declared');
    const shuffledOrder = await runOrder(['runtime', 'frontend', 'backend', 'build'], 'shuffled');
    assert.deepEqual(declaredOrder, ['backend', 'runtime', 'frontend', 'build']);
    assert.deepEqual(shuffledOrder, declaredOrder);
});

test('dynamic startup capacity wait and later grant expansion remain auditable', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-startup-wait');
    const dynamicTier = (id, overrides = {}) => tier(id, {
        resourceGrantMode: 'dynamic',
        cpuWeight: 1,
        memoryWeight: 1,
        startupMemoryWeight: 1,
        minCpuUnits: 2,
        startupMinCpuUnits: 1,
        startupPriority: 1,
        cpuUnits: 2,
        memoryGiB: 2,
        ...overrides
    });
    const result = await runDag({
        tiers: [
            dynamicTier('holder', { startupPriority: 2 }),
            dynamicTier('waiting'),
            dynamicTier('blocked', { startupPriority: 0 })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'startup-wait',
        maxParallel: 2,
        systemResources: { cpuCount: 2, availableCpuUnits: 2, availableMemoryGiB: 2, load1: 0 },
        currentFreeMemoryGiB: () => 2,
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            await delay(current.id === 'holder' ? 100 : 150);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    assert.equal(result.checkpoint.tiers.holder.startupGrant.cpuUnits, 1);
    assert.ok(result.checkpoint.tiers.blocked.resourceGrantHistory.at(-1).cpuUnits >= 1);
    assert.ok(result.checkpoint.resourceUtilization.waits.totalsMs['waiting-for-startup-capacity'] > 0);
});

test('dynamic startup refuses admission when live memory has no safe positive grant', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-startup-memory');
    let executed = false;
    const result = await runDag({
        tiers: [tier('memory-blocked', {
            resourceGrantMode: 'dynamic',
            cpuWeight: 1,
            memoryWeight: 1,
            startupMemoryWeight: 1,
            minCpuUnits: 1,
            startupMinCpuUnits: 1,
            cpuUnits: 2,
            memoryGiB: 2
        })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'startup-memory',
        maxParallel: 2,
        systemResources: { cpuCount: 2, availableCpuUnits: 2, availableMemoryGiB: 2, load1: 0 },
        currentFreeMemoryGiB: () => 0,
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            executed = true;
            return { code: 0, signal: null };
        }
    });
    assert.equal(executed, false);
    assert.equal(result.status, 'failure');
    assert.match(result.failure.reason, /unschedulable resource request.*memoryGiB=.*\/0/u);
});

test('dynamic startup rejects malformed memory weights before executing a tier', async () =>
{
    const { runDag } = await loadScheduler();
    for (const [label, startupMemoryWeight] of [
        ['zero', 0],
        ['negative', -1],
        ['not-a-number', Number.NaN]
    ])
    {
        const temp = createTempDir(`scheduler-startup-memory-policy-${label}`);
        let executed = false;
        await assert.rejects(runDag({
            tiers: [tier('invalid-memory-policy', {
                resourceGrantMode: 'dynamic',
                cpuWeight: 1,
                memoryWeight: 1,
                startupMemoryWeight,
                minCpuUnits: 1,
                startupMinCpuUnits: 1,
                cpuUnits: 2,
                memoryGiB: 2
            })],
            root: temp,
            runsRoot: path.join(temp, 'runs'),
            runId: `startup-memory-policy-${label}`,
            maxParallel: 2,
            systemResources: { cpuCount: 2, availableCpuUnits: 2, availableMemoryGiB: 2, load1: 0 },
            currentFreeMemoryGiB: () => 2,
            snapshotWorktree: stableSnapshot,
            executeTier: async () =>
            {
                executed = true;
                return { code: 0, signal: null };
            }
        }), /unresolved dynamic resource policy/u);
        assert.equal(executed, false);
    }
});

test('a failed dynamic startup grant is released for independent collect-failures work', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-startup-release');
    const executed = [];
    const dynamicTier = (id, startupPriority) => tier(id, {
        resourceGrantMode: 'dynamic',
        cpuWeight: 1,
        memoryWeight: 1,
        startupMemoryWeight: 1,
        startupPriority,
        minCpuUnits: 1,
        startupMinCpuUnits: 1,
        cpuUnits: 1,
        memoryGiB: 1
    });
    const result = await runDag({
        tiers: [dynamicTier('fails', 2), dynamicTier('after-failure', 1)],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'startup-release',
        maxParallel: 1,
        collectFailures: true,
        systemResources: { cpuCount: 1, availableCpuUnits: 1, availableMemoryGiB: 1, load1: 0 },
        currentFreeMemoryGiB: () => 1,
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            executed.push(current.id);
            return { code: current.id === 'fails' ? 1 : 0, signal: null };
        }
    });
    assert.equal(result.status, 'failure');
    assert.deepEqual(executed, ['fails', 'after-failure']);
    assert.equal(result.checkpoint.tiers['after-failure'].status, 'success');
    assert.equal(result.checkpoint.tiers['after-failure'].startupGrant.cpuUnits, 1);
});

test('active dynamic bundles expand from the live scheduler grant after a sibling releases capacity', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-elastic-grants');
    let expandedGrant = null;
    const dynamicTier = (id) => tier(id, {
        resourceGrantMode: 'dynamic',
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        cpuUnits: 8,
        memoryGiB: 8
    });
    const result = await runDag({
        tiers: [dynamicTier('short'), dynamicTier('long')],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'elastic-grants',
        maxParallel: 8,
        systemResources: { cpuCount: 8, availableCpuUnits: 8, availableMemoryGiB: 8, load1: 0 },
        currentFreeMemoryGiB: () => 8,
        snapshotWorktree: stableSnapshot,
        executeTier: async (current, context) =>
        {
            if (current.id === 'short')
            {
                await delay(20);
                return { code: 0, signal: null };
            }
            const deadline = Date.now() + 1_000;
            do
            {
                const grants = JSON.parse(fs.readFileSync(context.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE, 'utf8'));
                expandedGrant = grants.grants.long;
                if (expandedGrant?.cpuUnits === 8)
                {
                    break;
                }
                await delay(5);
            } while (Date.now() < deadline);
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(expandedGrant.cpuUnits, 8);
    assert.equal(result.checkpoint.tiers.long.startupGrant.cpuUnits, 4);
    assert.ok(Number.isFinite(result.checkpoint.tiers.long.admittedAtMs));
    assert.ok(Number.isFinite(result.checkpoint.tiers.long.firstExecutableStepAtMs));
    assert.equal(result.checkpoint.tiers.long.resourceGrantHistory[0].cpuUnits, 4);
    assert.equal(result.checkpoint.tiers.long.resourceGrantHistory.at(-1).cpuUnits, 8);
});

test('active dynamic bundles transfer weighted surplus to a sibling steady CPU floor', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-steady-floor-transfer');
    const observed = new Map();
    let arrived = 0;
    let releaseReaders;
    const bothReadersArrived = new Promise((resolve) =>
    {
        releaseReaders = resolve;
    });
    const dynamicTier = (id, overrides) => tier(id, {
        resourceGrantMode: 'dynamic',
        memoryWeight: 1,
        startupMinCpuUnits: 1,
        startupMemoryWeight: 1,
        cpuUnits: 8,
        memoryGiB: 8,
        ...overrides
    });
    const result = await runDag({
        tiers: [
            dynamicTier('frontend', { cpuWeight: 3, minCpuUnits: 3 }),
            dynamicTier('performance', { cpuWeight: 8, minCpuUnits: 1 })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'steady-floor-transfer',
        maxParallel: 8,
        systemResources: { cpuCount: 8, availableCpuUnits: 8, availableMemoryGiB: 8, load1: 0 },
        currentFreeMemoryGiB: () => 8,
        snapshotWorktree: stableSnapshot,
        executeTier: async (current, context) =>
        {
            await delay(30);
            arrived += 1;
            if (arrived === 2)
            {
                releaseReaders();
            }
            await bothReadersArrived;
            const grants = JSON.parse(fs.readFileSync(context.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE, 'utf8'));
            observed.set(current.id, grants.grants[current.id].cpuUnits);
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(observed.get('frontend'), 3);
    assert.equal(observed.get('performance'), 5);
});

test('released elastic capacity admits newly-ready work before expanding active bundles', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-elastic-admission-fairness');
    const events = new Map();
    const runtimeStarted = Promise.withResolvers();
    const dynamicTier = (id, overrides = {}) => tier(id, {
        resourceGrantMode: 'dynamic',
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        cpuUnits: 8,
        memoryGiB: 8,
        ...overrides
    });
    const result = await runDag({
        tiers: [
            dynamicTier('short'),
            dynamicTier('long'),
            dynamicTier('runtime', { executionDependsOn: ['short'] })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'elastic-admission-fairness',
        maxParallel: 8,
        systemResources: { cpuCount: 8, availableCpuUnits: 8, availableMemoryGiB: 8, load1: 0 },
        currentFreeMemoryGiB: () => 8,
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            events.set(`${current.id}:start`, events.size);
            events.set(`${current.id}:cpu`, current.cpuUnits);
            if (current.id === 'long')
            {
                await runtimeStarted.promise;
            }
            if (current.id === 'runtime')
            {
                runtimeStarted.resolve();
            }
            events.set(`${current.id}:finish`, events.size);
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(events.get('runtime:cpu'), 4);
    assert.ok(
        events.get('runtime:start') < events.get('long:finish'),
        'runtime must start from released capacity while the independent long bundle is still active'
    );
});

test('runDag stops the whole POSIX process group on the first tier failure', { skip: process.platform === 'win32' }, async () =>
{
    const { runDag } = await loadScheduler();
    assert.equal(typeof runDag, 'function');

    const temp = createTempDir('scheduler-stop');
    const pidFile = path.join(temp, 'grandchild.pid');
    const grandchildFile = path.join(temp, 'grandchild.mjs');
    const slowFile = path.join(temp, 'slow.mjs');
    const failFile = path.join(temp, 'fail.mjs');
    fs.writeFileSync(grandchildFile, 'setInterval(() => {}, 1000)\n');
    fs.writeFileSync(slowFile, [
        "import { spawn } from 'node:child_process'",
        "import fs from 'node:fs'",
        `const child = spawn(process.execPath, [${JSON.stringify(grandchildFile)}], { stdio: 'ignore' })`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
        'setInterval(() => {}, 1000)'
    ].join('\n'));
    fs.writeFileSync(failFile, posixCancellationFailureSource({ pidFile }));

    const result = await runDag({
        tiers: [
            tier('slow', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowFile)}` }),
            tier('fail', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(failFile)}` })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'stop',
        maxParallel: 2,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        snapshotWorktree: stableSnapshot,
        terminationGraceMs: 100
    });

    assert.equal(result.status, 'failure');
    assert.equal(result.failure.tierId, 'fail');
    assert.equal(result.failure.exitCode, 7);
    assert.ok(fs.existsSync(pidFile), 'the slow tier should have started its grandchild');
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1)
    {
        try
        {
            process.kill(grandchildPid, 0);
            await delay(25);
        }
        catch (error)
        {
            if (error.code === 'ESRCH')
            {
                alive = false;
            }
            else
            {
                throw error;
            }
        }
    }
    assert.equal(alive, false, `grandchild ${grandchildPid} survived sibling failure`);
});

test('runDag enforces a wall-clock deadline and records the timed-out tier', { skip: process.platform === 'win32' }, async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-deadline');
    const slowFile = path.join(temp, 'slow.mjs');
    fs.writeFileSync(slowFile, 'setInterval(() => {}, 1000)\n');

    const result = await runDag({
        tiers: [tier('slow', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowFile)}` })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'deadline',
        maxParallel: 1,
        wallClockBudgetMs: 150,
        terminationGraceMs: 50,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        snapshotWorktree: stableSnapshot
    });

    assert.equal(result.status, 'failure');
    assert.equal(result.failure.tierId, 'slow');
    assert.equal(result.failure.reason, 'wall-clock budget exceeded (150ms)');
    assert.equal(result.checkpoint.budgetMs, 150);
    assert.equal(result.checkpoint.timedOut, true);
    assert.deepEqual(result.checkpoint.criticalPath.tierIds, ['slow']);
    assert.ok(result.checkpoint.resourcePeaks.usedMemoryGiB > 0);
    assert.ok(Array.isArray(result.checkpoint.ungeneratedEvidence));
});

test('runDag charges pre-DAG elapsed time against the same wall-clock budget', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-pre-dag-deadline');
    const wallClockStartedAtMs = Date.now() - 300;
    let executed = false;

    const result = await runDag({
        tiers: [tier('slow')],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'pre-dag-deadline',
        maxParallel: 1,
        wallClockBudgetMs: 250,
        wallClockStartedAtMs,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            executed = true;
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'failure');
    assert.equal(result.checkpoint.timedOut, true);
    assert.equal(Date.parse(result.checkpoint.startedAt), wallClockStartedAtMs);
    assert.equal(result.failure.reason, 'wall-clock budget exceeded (250ms)');
    assert.equal(executed, false, 'an exhausted end-to-end budget must prevent DAG work from starting');
});

test('collectFailures consumes active settlements once after the wall-clock deadline without busy looping', { skip: process.platform === 'win32' }, async () =>
{
    const temp = createTempDir('scheduler-deadline-collect-settle');
    const probeFile = path.join(temp, 'probe.mjs');
    fs.writeFileSync(probeFile, [
        "import { setTimeout as delay } from 'node:timers/promises'",
        `import { runDag } from ${JSON.stringify(pathToFileURL(schedulerFile).href)}`,
        `const root = ${JSON.stringify(temp)}`,
        "const makeTier = (id) => ({ id, command: 'custom', executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [], phase: 0, resourceClass: 'cpu', maxParallel: 2, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [], executionKey: `probe/${id}`, executionVariant: 'ordinary', coverage: ['ordinary-unit'] })",
        'const executed = [], aborted = [], completed = [], releases = new Map()',
        'const result = await runDag({',
        "  tiers: [makeTier('active-a'), makeTier('active-b'), makeTier('pending-after-deadline')],",
        '  root,',
        "  runsRoot: `${root}/runs`,",
        "  runId: 'deadline-collect-settle',",
        '  maxParallel: 2,',
        '  collectFailures: true,',
        '  wallClockBudgetMs: 2000,',
        '  terminationGraceMs: 10,',
        '  systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },',
        "  snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),",
        '  executeTier: async (current) => {',
        '    executed.push(current.id)',
        "    if (executed.length === 2) console.log('ACTIVE')",
        '    return new Promise((resolve) => { const handle = setInterval(() => {}, 30000); releases.set(current.id, (result) => { clearInterval(handle); resolve(result) }) })',
        '  },',
        '  abortTier: (current) => { aborted.push(current.id); releases.get(current.id)?.({ code: 0, signal: null }) },',
        '  onTierComplete: (current) => { completed.push(current.id) }',
        '})',
        'console.log(JSON.stringify({',
        '  status: result.status,',
        '  timedOut: result.checkpoint.timedOut,',
        '  executed,',
        '  aborted,',
        '  completed,',
        '  tierStatuses: Object.fromEntries(Object.entries(result.checkpoint.tiers).map(([id, value]) => [id, value.status]))',
        '}))'
    ].join('\n'));

    const outcome = await runActiveJsonProbe({ file: probeFile, cwd: temp });
    assert.equal(outcome.status, 'failure');
    assert.equal(outcome.timedOut, true);
    assert.deepEqual(outcome.executed.sort(), ['active-a', 'active-b']);
    assert.deepEqual(outcome.aborted.sort(), ['active-a', 'active-b']);
    assert.deepEqual(outcome.completed.sort(), ['active-a', 'active-b']);
    assert.deepEqual(outcome.tierStatuses, {
        'active-a': 'cancelled',
        'active-b': 'cancelled'
    });
});

test('runDag enforces an individual physical bundle budget', { skip: process.platform === 'win32' }, async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-bundle-deadline');
    const slowFile = path.join(temp, 'slow.mjs');
    fs.writeFileSync(slowFile, 'setInterval(() => {}, 1000)\n');

    const result = await runDag({
        tiers: [tier('bundle', {
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slowFile)}`,
            budgetMs: 120
        })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'bundle-deadline',
        maxParallel: 1,
        terminationGraceMs: 50,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        snapshotWorktree: stableSnapshot
    });

    assert.equal(result.status, 'failure');
    assert.equal(result.failure.exitCode, 124);
    assert.equal(result.failure.reason, 'bundle budget exceeded (120ms)');
});

test('bundle timeout kills a pipe-holding grandchild and still collects independent failures', { skip: process.platform === 'win32' }, async (t) =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-bundle-timeout-tree');
    const pidFile = path.join(temp, 'grandchild.pid');
    const identityReadyMarker = path.join(temp, 'independent.identity-ready');
    const grandchildFile = path.join(temp, 'grandchild.sh');
    const parentFile = path.join(temp, 'parent.sh');
    const failFile = path.join(temp, 'fail.mjs');
    fs.writeFileSync(grandchildFile, String.raw`trap "exit 0" TERM
while true; do printf 'holding-pipe\n'; sleep 0.025; done`);
    fs.writeFileSync(parentFile, String.raw`set -euo pipefail
/bin/bash ${JSON.stringify(grandchildFile)} &
child=$!; printf '%s\n' "$child" > ${JSON.stringify(pidFile)}; wait "$child"`);
    fs.writeFileSync(failFile, String.raw`import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
while (!fs.existsSync(${JSON.stringify(identityReadyMarker)})) await delay(10)
process.exit(7)`);

    t.after(() =>
    {
        if (!fs.existsSync(pidFile))
        {
            return;
        }
        try
        {
            process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
        }
        catch (error)
        {
            if (error.code !== 'ESRCH')
            {
                throw error;
            }
        }
    });

    const startedAt = Date.now();
    const result = await runDag({
        tiers: [
            tier('timeout-bundle', {
                command: `/bin/bash ${JSON.stringify(parentFile)}`,
                budgetMs: 150
            }),
            tier('independent-failure', {
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(failFile)}`, budgetMs: 1_500
            })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'bundle-timeout-tree',
        maxParallel: 2,
        collectFailures: true,
        terminationGraceMs: 75,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        onTierStart: (startedTier) => startedTier.id === 'independent-failure' && fs.writeFileSync(identityReadyMarker, 'verified'),
        snapshotWorktree: stableSnapshot
    });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2_000, `scheduler took ${elapsedMs}ms after the bundle deadline`);
    assert.equal(result.status, 'failure');
    assert.ok(fs.existsSync(pidFile), 'the timed-out shell did not start its grandchild');
    assert.deepEqual(
        result.checkpoint.failures.map((failure) => failure.tierId).sort(),
        ['independent-failure', 'timeout-bundle']
    );
    assert.equal(result.checkpoint.tiers['timeout-bundle'].status, 'failure');
    assert.equal(result.checkpoint.tiers['timeout-bundle'].exitCode, 124);
    assert.equal(result.checkpoint.tiers['timeout-bundle'].reason, 'bundle budget exceeded (150ms)');
    assert.equal(result.checkpoint.tiers['independent-failure'].exitCode, 7);

    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1)
    {
        try
        {
            process.kill(grandchildPid, 0);
            await delay(25);
        }
        catch (error)
        {
            if (error.code === 'ESRCH')
            {
                alive = false;
            }
            else
            {
                throw error;
            }
        }
    }
    assert.equal(alive, false, `pipe-holding grandchild ${grandchildPid} survived bundle timeout`);
});

test('resume reuses successful tiers only while input and dependency fingerprints match', async () =>
{
    const { runDag } = await loadScheduler();
    assert.equal(typeof runDag, 'function');

    const temp = createTempDir('scheduler-resume');
    const inputFile = path.join(temp, 'input.txt');
    fs.writeFileSync(inputFile, 'v1\n');
    const tiers = [
        tier('compile', { cacheInputs: ['input.txt'] }),
        tier('verify', { executionDependsOn: ['compile'] })
    ];
    const runsRoot = path.join(temp, 'runs');
    const executed = [];
    const executeTier = async (current) =>
    {
        executed.push(current.id);
        return { code: 0, signal: null };
    };

    await runDag({ tiers, root: temp, runsRoot, runId: 'resume', maxParallel: 2, snapshotWorktree: stableSnapshot, executeTier });
    assert.deepEqual(executed, ['compile', 'verify']);

    executed.length = 0;
    const resumed = await runDag({ tiers, root: temp, runsRoot, runId: 'resume', resume: true, maxParallel: 2, snapshotWorktree: stableSnapshot, executeTier });
    assert.equal(resumed.status, 'success');
    assert.deepEqual(executed, []);
    assert.deepEqual(resumed.reusedTiers.sort(), ['compile', 'verify']);

    fs.writeFileSync(inputFile, 'v2\n');
    executed.length = 0;
    const invalidated = await runDag({ tiers, root: temp, runsRoot, runId: 'resume', resume: true, maxParallel: 2, snapshotWorktree: stableSnapshot, executeTier });
    assert.equal(invalidated.status, 'success');
    assert.deepEqual(executed, ['compile', 'verify']);
    assert.deepEqual(invalidated.reusedTiers, []);
});

test('resume ignores invocation timing metadata but invalidates real execution environment changes', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-resume-orchestration-env');
    const runsRoot = path.join(temp, 'runs');
    const current = tier('work');
    const executed = [];
    let invocationStartedAtMs = '1000';
    let tierMemoryGiB = '1.5';
    let featureMode = 'stable';
    const run = (resume) => runDag({
        tiers: [current],
        root: temp,
        runsRoot,
        runId: 'orchestration-env',
        mode: resume ? 'resume' : 'fresh',
        resume,
        maxParallel: 1,
        snapshotWorktree: stableSnapshot,
        envForTier: () => ({
            FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS: invocationStartedAtMs,
            FSUSBLOG_TIER_MEMORY_GIB: tierMemoryGiB,
            FSUSBLOG_FEATURE_MODE: featureMode
        }),
        executeTier: async (selected) =>
        {
            executed.push(selected.id);
            return { code: 0, signal: null };
        }
    });

    await run(false);
    assert.deepEqual(executed, ['work']);

    invocationStartedAtMs = '2000';
    tierMemoryGiB = '2.25';
    executed.length = 0;
    const timingOnlyResume = await run(true);
    assert.equal(timingOnlyResume.status, 'success');
    assert.deepEqual(timingOnlyResume.reusedTiers, ['work']);
    assert.deepEqual(executed, [], 'scheduler-only timing and live resource grants must not fragment resume candidates');

    featureMode = 'changed';
    executed.length = 0;
    const executionEnvironmentResume = await run(true);
    assert.equal(executionEnvironmentResume.status, 'success');
    assert.deepEqual(executionEnvironmentResume.reusedTiers, []);
    assert.deepEqual(executed, ['work']);
});

test('scheduler injects its authoritative Fresh or resume mode into every tier environment', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-execution-source');
    const runsRoot = path.join(temp, 'runs');
    const inputFile = path.join(temp, 'input.txt');
    fs.writeFileSync(inputFile, 'fresh\n');
    const current = tier('work', { cacheInputs: ['input.txt'] });
    const executionSources = [];
    const run = (mode) => runDag({
        tiers: [current],
        root: temp,
        runsRoot,
        runId: 'execution-source',
        mode,
        resume: mode === 'resume',
        maxParallel: 1,
        snapshotWorktree: stableSnapshot,
        envForTier: () => ({
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'caller-must-not-override-scheduler-mode'
        }),
        executeTier: async (_selected, context) =>
        {
            executionSources.push(context.env.FSUSBLOG_TEST_EXECUTION_SOURCE);
            return { code: 0, signal: null };
        }
    });

    await run('fresh');
    fs.writeFileSync(inputFile, 'resume\n');
    await run('resume');
    assert.deepEqual(executionSources, ['fresh', 'resume']);
});

test('an early resume failure requires a new independent run', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-resume-early-failure');
    const runsRoot = path.join(temp, 'runs');
    const gateInput = path.join(temp, 'gate.txt');
    fs.writeFileSync(gateInput, 'v1\n');
    const tiers = [
        tier('gate', { cacheInputs: ['gate.txt'], phase: 0 }),
        tier('later-independent', { phase: 1 })
    ];
    const executed = [];
    let failGate = false;
    const run = (resume) => runDag({
        tiers,
        root: temp,
        runsRoot,
        runId: 'early-failure',
        mode: resume ? 'resume' : 'fresh',
        resume,
        maxParallel: 2,
        snapshotWorktree: stableSnapshot,
        executeTier: async (selected) =>
        {
            executed.push(selected.id);
            if (selected.id === 'gate' && failGate)
            {
                return { code: 7, signal: null };
            }
            return { code: 0, signal: null };
        }
    });

    const fresh = await run(false);
    assert.equal(fresh.status, 'success');
    assert.deepEqual(executed, ['gate', 'later-independent']);

    fs.writeFileSync(gateInput, 'v2\n');
    failGate = true;
    executed.length = 0;
    const failedResume = await run(true);
    assert.equal(failedResume.status, 'failure');
    assert.deepEqual(executed, ['gate']);
    assert.deepEqual(failedResume.checkpoint.completedTiers, []);
    assert.equal(failedResume.checkpoint.tiers.gate.status, 'failure');
    assert.equal(failedResume.checkpoint.resumeCandidates.gate, undefined);
    assert.equal(failedResume.checkpoint.resumeCandidates['later-independent'].tierResult.status, 'success');

    failGate = false;
    executed.length = 0;
    await assert.rejects(run(true), /cannot re-execute failed tiers.*gate/u);
    assert.deepEqual(executed, []);
});

test('carried resume candidates cannot hide an early failed attempt', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-resume-candidate-source');
    const runsRoot = path.join(temp, 'runs');
    fs.writeFileSync(path.join(temp, 'gate.txt'), 'v1\n');
    const tiers = [
        tier('gate', { cacheInputs: ['gate.txt'], phase: 0 }),
        tier('later-independent', { phase: 1 })
    ];
    const executed = [];
    let sourceFingerprint = 'source-v1';
    let failGate = false;
    const run = (resume) => runDag({
        tiers,
        root: temp,
        runsRoot,
        runId: 'candidate-source',
        mode: resume ? 'resume' : 'fresh',
        resume,
        reuseAcrossSourceChanges: false,
        maxParallel: 2,
        snapshotWorktree: async () => ({ fingerprint: sourceFingerprint, entries: {} }),
        executeTier: async (selected) =>
        {
            executed.push(selected.id);
            if (selected.id === 'gate' && failGate)
            {
                return { code: 7, signal: null };
            }
            return { code: 0, signal: null };
        }
    });

    const fresh = await run(false);
    assert.equal(fresh.status, 'success');

    sourceFingerprint = 'source-v2';
    fs.writeFileSync(path.join(temp, 'gate.txt'), 'v2\n');
    failGate = true;
    executed.length = 0;
    const failedResume = await run(true);
    assert.equal(failedResume.status, 'failure');
    assert.deepEqual(executed, ['gate']);
    assert.equal(
        failedResume.checkpoint.resumeCandidates['later-independent'].sourceState.worktreeFingerprint,
        'source-v1'
    );

    failGate = false;
    executed.length = 0;
    await assert.rejects(run(true), /cannot re-execute failed tiers.*gate/u);
    assert.deepEqual(executed, []);
});

test('resume can require one coherent source state instead of reusing otherwise valid tiers', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-resume-source-state');
    const runsRoot = path.join(temp, 'runs');
    const tiers = [tier('compile'), tier('verify', { executionDependsOn: ['compile'] })];
    const executed = [];
    let sourceFingerprint = 'source-v1';
    const snapshotWorktree = async () => ({ fingerprint: sourceFingerprint, entries: {} });
    const executeTier = async (current) =>
    {
        executed.push(current.id);
        return { code: 0, signal: null };
    };

    await runDag({ tiers, root: temp, runsRoot, runId: 'source-state', snapshotWorktree, executeTier });
    executed.length = 0;
    sourceFingerprint = 'source-v2';
    const resumed = await runDag({
        tiers,
        root: temp,
        runsRoot,
        runId: 'source-state',
        resume: true,
        reuseAcrossSourceChanges: false,
        snapshotWorktree,
        executeTier
    });

    assert.equal(resumed.status, 'success');
    assert.deepEqual(executed, ['compile', 'verify']);
    assert.deepEqual(resumed.reusedTiers, []);
    assert.deepEqual(resumed.checkpoint.resumePolicy, {
        sourceChanged: true,
        budgetPolicyChanged: false,
        reuseAcrossSourceChanges: false
    });
});

test('resume reruns tiers when declared artifacts disappear and never reuses service bootstraps', async () =>
{
    const { runDag } = await loadScheduler();
    assert.equal(typeof runDag, 'function');

    const temp = createTempDir('scheduler-resume-outputs');
    const runsRoot = path.join(temp, 'runs');
    const artifactFile = path.join(temp, 'artifact.txt');
    const executed = [];
    const tiers = [
        tier('artifact', { artifacts: ['artifact.txt'] }),
        tier('service-bootstrap', {
            executionDependsOn: ['artifact'],
            services: ['postgres'],
            artifacts: ['service-ready.txt']
        })
    ];
    const executeTier = async (current) =>
    {
        executed.push(current.id);
        if (current.id === 'artifact')
        {
            fs.writeFileSync(artifactFile, 'ready\n');
        }
        if (current.id === 'service-bootstrap')
        {
            fs.writeFileSync(path.join(temp, 'service-ready.txt'), 'ready\n');
        }
        return { code: 0, signal: null };
    };

    await runDag({ tiers, root: temp, runsRoot, runId: 'outputs', mode: 'fresh', snapshotWorktree: stableSnapshot, executeTier });
    assert.deepEqual(executed, ['artifact', 'service-bootstrap']);

    executed.length = 0;
    const resumed = await runDag({ tiers, root: temp, runsRoot, runId: 'outputs', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier });
    assert.deepEqual(resumed.reusedTiers, ['artifact']);
    assert.deepEqual(executed, ['service-bootstrap']);

    fs.rmSync(artifactFile);
    executed.length = 0;
    const invalidated = await runDag({ tiers, root: temp, runsRoot, runId: 'outputs', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier });
    assert.deepEqual(invalidated.reusedTiers, []);
    assert.deepEqual(executed, ['artifact', 'service-bootstrap']);
});

test('a successful command fails closed when required direct or wildcard artifact paths are missing', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-missing-output');
    const result = await runDag({
        tiers: [tier('missing-output', { artifacts: ['required.json'], evidence: ['optional/**/*.png'] })],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'missing-output',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    });
    assert.equal(result.status, 'failure');
    assert.match(result.failure.reason, /required\.json \(missing\)/u);
    assert.match(result.failure.reason, /optional\/\*\*\/\*\.png \(missing-wildcard\)/u);
});

test('fresh execution cannot pass by inheriting a stale pre-existing generated artifact', async () =>
{
    const { runDag } = await loadScheduler();
    const repo = createTempDir('scheduler-stale-output');
    const staleFile = path.join(repo, '.tmp/required.json');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, '{"stale":true}\n');
    const result = await runDag({
        tiers: [tier('stale-output', {
            artifacts: ['.tmp/required.json'],
            evidence: ['.tmp/required.json']
        })],
        root: repo,
        runsRoot: path.join(repo, '.tmp/runs'),
        runId: 'stale-output',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    });

    assert.equal(result.status, 'failure');
    assert.match(result.failure.reason, /required artifact\/evidence missing|did not produce or update/u);
});

test('a consumer does not claim generated evidence owned by a transitive dependency', async () =>
{
    const { runDag } = await loadScheduler();
    const repo = createTempDir('scheduler-transitive-output-owner');
    const sharedRelativePath = '.tmp/shared/test-plan.json';
    const sharedFile = path.join(repo, sharedRelativePath);
    const result = await runDag({
        tiers: [
            tier('producer', {
                artifacts: [sharedRelativePath],
                evidence: [sharedRelativePath]
            }),
            tier('aggregate', {
                command: 'tools/test/lanes/noop.sh aggregate',
                executionDependsOn: ['producer']
            }),
            tier('consumer', {
                executionDependsOn: ['aggregate'],
                artifacts: [sharedRelativePath],
                evidence: [sharedRelativePath]
            })
        ],
        root: repo,
        runsRoot: path.join(repo, '.tmp/runs'),
        runId: 'transitive-output-owner',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            if (current.id === 'producer')
            {
                fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
                fs.writeFileSync(sharedFile, '{"source":"producer"}\n');
            }
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(result.checkpoint.tiers.producer.ownedGeneratedOutputs, [sharedRelativePath]);
    assert.deepEqual(result.checkpoint.tiers.consumer.ownedGeneratedOutputs, []);
    assert.equal(fs.readFileSync(sharedFile, 'utf8'), '{"source":"producer"}\n');
});

test('fresh execution removes stale siblings from an owned generated directory', async () =>
{
    const { runDag } = await loadScheduler();
    const repo = createTempDir('scheduler-stale-directory');
    const outputDirectory = path.join(repo, '.tmp/evidence');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const staleFile = path.join(outputDirectory, 'stale-authority.json');
    fs.writeFileSync(staleFile, '{"stale":true}\n');
    const result = await runDag({
        tiers: [tier('directory-producer', {
            artifacts: ['.tmp/evidence'],
            evidence: ['.tmp/evidence']
        })],
        root: repo,
        runsRoot: path.join(repo, '.tmp/runs'),
        runId: 'directory-producer',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            fs.mkdirSync(outputDirectory, { recursive: true });
            fs.writeFileSync(path.join(outputDirectory, 'current.json'), '{"current":true}\n');
            return { code: 0, signal: null };
        }
    });

    assert.equal(result.status, 'success');
    assert.equal(fs.existsSync(staleFile), false);
});

test('derived cache inputs invalidate only the affected backend or frontend tier', async () =>
{
    const { runDag } = await loadScheduler();
    const repo = createTempDir('scheduler-fallback-inputs');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'src/backend'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src/frontend/src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/backend/source.cs'), 'backend-v1\n');
    fs.writeFileSync(path.join(repo, 'src/frontend/src/source.ts'), 'frontend-v1\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    const runsRoot = createTempDir('scheduler-fallback-runs');
    const current = tier('fallback-inputs', {
        owner: 'ServerContractAgent',
        requiresDotnet: true,
        requiresNode: false
    });
    delete current.cacheInputs;
    const executed = [];
    const executeTier = async () =>
    {
        executed.push('run');
        return { code: 0, signal: null };
    };
    await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'fresh', snapshotWorktree: stableSnapshot, executeTier });
    await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier });
    assert.deepEqual(executed, ['run']);
    fs.writeFileSync(path.join(repo, 'src/frontend/src/source.ts'), 'frontend-v2\n');
    await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier });
    assert.deepEqual(executed, ['run']);
    fs.writeFileSync(path.join(repo, 'src/backend/source.cs'), 'backend-v2\n');
    await runDag({ tiers: [current], root: repo, runsRoot, runId: 'fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier });
    assert.deepEqual(executed, ['run', 'run']);

    const frontend = tier('frontend-derived-inputs', {
        owner: 'InteropGlueAgent',
        requiresDotnet: false,
        requiresNode: true
    });
    delete frontend.cacheInputs;
    const frontendExecutions = [];
    const executeFrontend = async () =>
    {
        frontendExecutions.push('run');
        return { code: 0, signal: null };
    };
    await runDag({ tiers: [frontend], root: repo, runsRoot, runId: 'frontend-fallback', mode: 'fresh', snapshotWorktree: stableSnapshot, executeTier: executeFrontend });
    fs.writeFileSync(path.join(repo, 'src/backend/source.cs'), 'backend-v3\n');
    await runDag({ tiers: [frontend], root: repo, runsRoot, runId: 'frontend-fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier: executeFrontend });
    assert.deepEqual(frontendExecutions, ['run']);
    fs.writeFileSync(path.join(repo, 'src/frontend/src/source.ts'), 'frontend-v3\n');
    await runDag({ tiers: [frontend], root: repo, runsRoot, runId: 'frontend-fallback', mode: 'resume', snapshotWorktree: stableSnapshot, executeTier: executeFrontend });
    assert.deepEqual(frontendExecutions, ['run', 'run']);
});

test('runDag and latest-run discovery reject concurrent writers for one run id', async () =>
{
    const { findLatestRunId, runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-run-lock');
    const runsRoot = path.join(temp, 'runs');
    let release;
    let started;
    const startedPromise = new Promise((resolve) =>
    {
        started = resolve;
    });
    const releasePromise = new Promise((resolve) =>
    {
        release = resolve;
    });
    const first = runDag({
        tiers: [tier('slow')],
        root: temp,
        runsRoot,
        runId: 'shared',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            started();
            await releasePromise;
            return { code: 0, signal: null };
        }
    });
    await startedPromise;
    assert.throws(() => findLatestRunId(runsRoot), /already active/i);
    await assert.rejects(runDag({
        tiers: [tier('slow')],
        root: temp,
        runsRoot,
        runId: 'shared',
        mode: 'resume',
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    }), /already active/i);
    release();
    assert.equal((await first).status, 'success');
    assert.equal(findLatestRunId(runsRoot), 'shared');
});

test('stale running checkpoints are resumable when their lock owner is dead', async () =>
{
    const { findLatestRunId, runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-stale-running');
    const runsRoot = path.join(temp, 'runs');
    const runDirectory = path.join(runsRoot, 'stale');
    const lockDirectory = path.join(runsRoot, '.locks/stale.lock');
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, 'checkpoint.json'), `${JSON.stringify({
        schema: 'fsusblog.test-matrix.checkpoint.v1',
        runId: 'stale',
        targetTierId: 'fixture',
        status: 'running',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        namespace: 'test-matrix',
        schedulerCandidateIdentityDigest: schedulerCandidateIdentityDigest({
            runId: 'stale',
            targetTierId: 'fixture',
            namespace: 'test-matrix',
            sourceState: { commit: 'unversioned', worktreeFingerprint: 'stable' }
        }),
        sourceState: { commit: 'unversioned', worktreeFingerprint: 'stable' },
        tiers: {}
    })}\n`);
    const staleIdentity = currentProcessIdentity();
    fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify(sealSchedulerRunOwner({
        ...createSchedulerRunOwner({
            runId: 'stale',
            candidateIdentityDigest: schedulerCandidateIdentityDigest({
                runId: 'stale',
                targetTierId: 'fixture',
                namespace: 'test-matrix',
                sourceState: { commit: 'unversioned', worktreeFingerprint: 'stable' }
            }),
            targetTierId: 'fixture',
            ownerToken: 'dead',
            identity: staleIdentity
        }),
        ownerToken: 'dead',
        processStartIdentity: `${staleIdentity.processStartIdentity}:exited`
    }))}\n`);
    assert.equal(findLatestRunId(runsRoot, 'fixture'), 'stale');
    let executions = 0;
    const result = await runDag({
        tiers: [tier('fixture')],
        root: temp,
        runsRoot,
        runId: 'stale',
        targetTierId: 'fixture',
        mode: 'resume',
        resume: true,
        snapshotWorktree: stableSnapshot,
        executeTier: async () =>
        {
            executions += 1;
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    assert.equal(executions, 1);
});

test('scheduler fails closed when a tier reaches admission without a resolved resource grant', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-resource-defaults');
    const browserTier = (id) =>
    {
        const current = tier(id, { resourceClass: 'browser' });
        delete current.cpuUnits;
        delete current.memoryGiB;
        return current;
    };
    await assert.rejects(runDag({
        tiers: [browserTier('browser-a'), browserTier('browser-b')],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'defaults',
        mode: 'fresh',
        maxParallel: 2,
        systemResources: { cpuCount: 8, availableMemoryGiB: 6, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    }), /has no resolved resource grant/u);
});

test('supersedes rewires ordinary unit coverage subsets and rejects protected test kinds', async () =>
{
    const { applySupersedes, validateSupersedesRules } = await loadScheduler();
    assert.equal(typeof applySupersedes, 'function');
    assert.equal(typeof validateSupersedesRules, 'function');

    const ordinary = [
        tier('unit-slow', { executionKey: 'unit/shared', coverage: ['ordinary-unit'] }),
        tier('unit-fast', {
            executionKey: 'unit/shared',
            executionVariant: 'coverage',
            coverage: ['ordinary-unit', 'ordinary-unit-extra'],
            supersedes: ['unit-slow']
        }),
        tier('summary', {
            executionDependsOn: ['unit-slow'],
            requiresEvidenceFrom: ['unit-slow'],
            coverage: []
        })
    ];
    const registry = new Map([
        ['ordinary-unit', { assertionType: 'unit' }],
        ['ordinary-unit-extra', { assertionType: 'unit' }]
    ]);
    assert.deepEqual(validateSupersedesRules(ordinary, registry), []);
    const selected = applySupersedes(ordinary);
    assert.deepEqual(selected.map((item) => item.id).sort(), ['summary', 'unit-fast']);
    assert.deepEqual(selected.find((item) => item.id === 'summary').executionDependsOn, ['unit-fast']);
    assert.deepEqual(selected.find((item) => item.id === 'summary').requiresEvidenceFrom, ['unit-fast']);

    for (const kind of ['property', 'model', 'perf', 'runtime'])
    {
        const protectedTiers = [
            tier(`${kind}-suite`, { executionKey: `protected/${kind}`, coverage: [`${kind}-coverage`] }),
            tier(`${kind}-replacement`, {
                executionKey: `protected/${kind}`,
                executionVariant: 'coverage',
                coverage: [`${kind}-coverage`],
                supersedes: [`${kind}-suite`]
            })
        ];
        const errors = validateSupersedesRules(
            protectedTiers,
            new Map([[`${kind}-coverage`, { assertionType: kind === 'perf' || kind === 'runtime' ? kind : 'unit' }]])
        );
        assert.ok(errors.some((message) => message.includes('must not supersede')), `${kind} supersedes should be rejected`);
    }
});

test('worktree pollution fails a tier while an unchanged pre-existing dirty tree is allowed', async () =>
{
    const { runDag } = await loadScheduler();
    assert.equal(typeof runDag, 'function');

    const repo = createTempDir('scheduler-pollution');
    const runsRoot = createTempDir('scheduler-pollution-runs');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'already dirty\n');

    const cleanResult = await runDag({
        tiers: [tier('clean')],
        root: repo,
        runsRoot,
        runId: 'preexisting-dirty',
        maxParallel: 1
    });
    assert.equal(cleanResult.status, 'success');

    const pollutingFile = path.join(repo, 'polluting.mjs');
    const generatedFile = path.join(repo, 'generated.txt');
    fs.writeFileSync(pollutingFile, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(generatedFile)}, 'generated\\n')\n`);
    execFileSync('git', ['add', 'polluting.mjs'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'add polluter'], { cwd: repo });
    const pollutedResult = await runDag({
        tiers: [tier('polluter', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(pollutingFile)}` })],
        root: repo,
        runsRoot,
        runId: 'polluted',
        maxParallel: 1
    });
    assert.equal(pollutedResult.status, 'failure');
    assert.equal(pollutedResult.failure.tierId, 'polluter');
    assert.match(pollutedResult.failure.reason, /working tree pollution/i);
    assert.ok(pollutedResult.failure.changedPaths.includes('generated.txt'));
});

test('matrix schema exposes scheduler resource, fingerprint, and supersedes metadata', () =>
{
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'tests/matrix.schema.json'), 'utf8'));
    const localProfile = schema.properties.localProfiles.additionalProperties;
    const localBundle = localProfile.properties.bundles.items;
    const properties = schema.properties.tiers.items.properties;
    assert.deepEqual(localProfile.required, ['budgetMs', 'minimumSupportedCpuUnits', 'memoryReserveShare', 'bundles', 'summaryOnly']);
    assert.equal(localProfile.properties.minimumSupportedCpuUnits.minimum, 1);
    assert.equal(localProfile.properties.memoryReserveShare.exclusiveMinimum, 0);
    assert.equal(localProfile.properties.memoryReserveShare.exclusiveMaximum, 1);
    assert.equal(localProfile.properties.enforceBudget.type, 'boolean');
    assert.ok(localBundle.required.includes('cpuWeight'));
    assert.ok(localBundle.required.includes('memoryWeight'));
    assert.ok(localBundle.required.includes('minCpuUnits'));
    assert.equal(localBundle.required.includes('startupMinCpuUnits'), false);
    assert.equal(localBundle.required.includes('startupMemoryWeight'), false);
    assert.equal(localBundle.required.includes('startupPriority'), false);
    assert.ok(localBundle.required.includes('deadlineWeight'));
    assert.equal(localBundle.properties.cpuWeight.exclusiveMinimum, 0);
    assert.equal(localBundle.properties.memoryWeight.exclusiveMinimum, 0);
    assert.equal(localBundle.properties.deadlineWeight.exclusiveMinimum, 0);
    assert.equal(localBundle.properties.minimumDeadlineShare.minimum, 0);
    assert.equal(localBundle.properties.minimumDeadlineShare.exclusiveMaximum, 1);
    assert.equal(localBundle.properties.minCpuUnits.minimum, 1);
    assert.equal(localBundle.properties.startupMinCpuUnits.minimum, 1);
    assert.equal(localBundle.properties.startupMemoryWeight.exclusiveMinimum, 0);
    assert.equal(localBundle.properties.startupPriority.minimum, 0);
    assert.equal(Object.hasOwn(localBundle.properties, 'budgetMs'), false);
    assert.equal(Object.hasOwn(localBundle.properties, 'cpuUnits'), false);
    assert.equal(Object.hasOwn(localBundle.properties, 'memoryGiB'), false);
    assert.equal(Object.hasOwn(localBundle.properties, 'stepMaxParallel'), false);
    assert.equal(properties.cpuWeight.exclusiveMinimum, 0);
    assert.equal(properties.memoryWeight.exclusiveMinimum, 0);
    assert.equal(properties.minCpuUnits.minimum, 1);
    assert.equal(properties.maxParallel.const, 1);
    assert.equal(properties.defaultShards.const, 1);
    assert.equal(Object.hasOwn(properties, 'cpuUnits'), false);
    assert.equal(Object.hasOwn(properties, 'memoryGiB'), false);
    assert.equal(properties.executionKey.type, 'string');
    assert.deepEqual(properties.executionVariant.enum, ['ordinary', 'coverage', 'property', 'model', 'performance', 'runtime']);
    assert.equal(properties.supersedes.type, 'array');
    assert.equal(properties.cacheInputs.type, 'array');
});

test('logical tier matrix stores only weights and serial/single fixed-one semantics', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    assert.ok(matrix.tiers.length > 0);
    for (const current of matrix.tiers)
    {
        assert.ok(current.cpuWeight > 0, current.id);
        assert.ok(current.memoryWeight > 0, current.id);
        assert.ok(Number.isInteger(current.minCpuUnits) && current.minCpuUnits > 0, current.id);
        assert.equal(Object.hasOwn(current, 'cpuUnits'), false, current.id);
        assert.equal(Object.hasOwn(current, 'memoryGiB'), false, current.id);
        assert.equal(current.parallelizable ? !Object.hasOwn(current, 'maxParallel') : current.maxParallel === 1, true, current.id);
        assert.equal(current.shardable ? !Object.hasOwn(current, 'defaultShards') : current.defaultShards === 1, true, current.id);
        if (current.parallelizable)
        {
            assert.equal(Object.hasOwn(current, 'maxParallel'), false, current.id);
        }
        if (current.shardable)
        {
            assert.equal(Object.hasOwn(current, 'defaultShards'), false, current.id);
        }
    }
});

test('CI matrix exposes live machine resource resolution and derived shard concurrency', () =>
{
    const result = spawnSync(process.execPath, [path.join(root, 'tools/run-test-matrix.mjs'), 'ci-job-matrix', 'browser-contract'], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const resolution = payload.matrix.resource_resolution;
    assert.equal(resolution.cpuCount, os.availableParallelism?.() ?? os.cpus().length);
    assert.equal(resolution.availableCpuUnits, resolution.cpuCount);
    assert.ok(resolution.availableMemoryGiB > 0);
    assert.ok(resolution.totalMemoryGiB >= resolution.availableMemoryGiB);
    assert.ok(Number.isInteger(resolution.defaultShards) && resolution.defaultShards >= 1);
    const entries = payload.matrix.include;
    const browserContract = entries.find((entry) => entry.tier === 'browser-contract');
    assert.ok(browserContract, 'browser-contract tier must remain in the shared CI job matrix');
    assert.equal(browserContract.shard, '');
    assert.equal(browserContract.max_parallel, 1);
    assert.equal(browserContract.playwright_workers, 1);
    assert.equal(browserContract.timeout_minutes, 10);
    assert.ok(browserContract.cpu_units <= resolution.availableCpuUnits);
    assert.ok(browserContract.memory_gib <= resolution.availableMemoryGiB);
});

test('effective cache inputs include shared lane, Vitest, and setup consumers', async () =>
{
    const { effectiveCacheInputs } = await loadScheduler();
    const backendInputs = effectiveCacheInputs(tier('backend-explicit', {
        command: 'tools/test/lanes/backend-unit.sh',
        cacheInputs: ['tools/test/lanes/backend-unit.sh']
    }));
    assert.ok(!backendInputs.includes('tools/test/lanes/_lane-collect-support.sh'));
    assert.ok(!backendInputs.includes('tools/test/lanes/_suite-support.sh'));
    assert.ok(!backendInputs.includes('tools/test/run-once.mjs'));

    const frontendInputs = effectiveCacheInputs(tier('frontend-unit-shard', {
        command: 'tools/test/lanes/frontend-unit-shard.sh',
        cacheInputs: ['tools/test/lanes/frontend-unit-shard.sh']
    }));
    assert.ok(frontendInputs.includes('tests/frontend'));
    assert.equal(frontendInputs.includes('src/frontend/tests'), false);
    assert.ok(frontendInputs.includes('src/frontend/vitest*.config.ts'));
    assert.ok(frontendInputs.includes('src/frontend/vitest.shared.mjs'));
});

test('coverage registry tierIds fail closed on stale or non-covering tiers', () =>
{
    const temp = createTempDir('coverage-registry-tier-ids');
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'));
    registry.entries[0].tierIds = ['removed-tier'];
    const registryFile = path.join(temp, 'coverage-registry.json');
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
    const result = spawnSync(process.execPath, [path.join(root, 'tools/run-test-matrix.mjs'), 'validate'], {
        cwd: root,
        env: { ...process.env, FSUSBLOG_COVERAGE_REGISTRY_FILE: registryFile },
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tierIds references unknown tier: removed-tier/u);
    assert.match(result.stderr, /tierIds must exactly match matrix covering tiers/u);
});

test('runner accepts fresh, resume, and max-parallel flags while CI always executes fresh', (t) =>
{
    const temp = createTempDir('scheduler-cli');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const marker = path.join(temp, '.tmp/marker.txt');
    const fixture = createCanonicalCliFixture(temp,
        `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, 'x')\n`);

    const baseEnv = {
        ...process.env,
        ...fixture.admissionEnvironment,
        FSUSBLOG_MATRIX_FILE: fixture.matrixFile,
        FSUSBLOG_TEST_RUN_ID: `scheduler-cli-${process.pid}`
    };
    const fresh = spawnSync(process.execPath, [fixture.runner, 'run', fixture.tierId, '--fresh', '--max-parallel', '1'], {
        cwd: temp,
        env: baseEnv,
        encoding: 'utf8'
    });
    assert.equal(fresh.status, 0, fresh.stderr);
    const ciResume = spawnSync(process.execPath, [fixture.runner, 'run', fixture.tierId, '--resume', '--max-parallel=1'], {
        cwd: temp,
        env: { ...baseEnv, CI: 'true' },
        encoding: 'utf8'
    });
    assert.equal(ciResume.status, 0, ciResume.stderr);
    assert.match(ciResume.stderr, /CI.*fresh/i);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'xx');
});

test('matrix job summaries explicitly separate browser diagnostics from correctness', () =>
{
    const temp = createTempDir('diagnostic-job-summary');
    try
    {
        const diagnosticTierId = 'ux-viewport-plan-progress';
        const correctnessTierId = 'runtime-cache-evidence';
        const fixture = createCanonicalCliFixture(temp, {
            [diagnosticTierId]: 'process.exit(0)\n',
            [correctnessTierId]: 'process.exit(0)\n'
        }, (tier, id) =>
        {
            tier.ciJob = id === diagnosticTierId ? 'browser-diagnostics' : 'correctness-fixture';
        });
        const env = {
            ...process.env,
            ...fixture.admissionEnvironment,
            FSUSBLOG_MATRIX_FILE: fixture.matrixFile,
            FSUSBLOG_TEST_RUN_ID: `diagnostic-job-summary-${process.pid}`
        };
        for (const id of [diagnosticTierId, correctnessTierId])
        {
            const result = spawnSync(process.execPath, [fixture.runner, 'run', id, '--no-deps', '--fresh'], {
                cwd: temp,
                env,
                encoding: 'utf8'
            });
            assert.equal(result.status, 0, result.stderr);
        }
        const diagnostic = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/jobs/browser-diagnostics.json'), 'utf8'));
        assert.equal(diagnostic.evidenceClass, 'diagnostic');
        assert.equal(diagnostic.affectsCorrectness, false);
        const correctness = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/jobs/correctness-fixture.json'), 'utf8'));
        assert.equal(correctness.evidenceClass, 'correctness');
        assert.equal(correctness.affectsCorrectness, true);
    }
    finally
    {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('viewport CLI never reuses failed Playwright progress across scheduler resume', (t) =>
{
    const temp = createTempDir('scheduler-viewport-resume');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const history = path.join(temp, '.tmp/resume-env.txt');
    const artifact = path.join(temp, '.tmp/viewport-output.json');
    const fixture = createCanonicalCliFixture(temp, {
        'ux-viewport-smoke': [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'printf "%s\\n" "$FSUSBLOG_UX_VIEWPORT_RESUME" >> ' + JSON.stringify(history),
            'printf "{}\\n" > ' + JSON.stringify(artifact)
        ].join('\n') + '\n'
    }, (tier) =>
    {
        Object.assign(tier, { resourceClass: 'browser', executionVariant: 'runtime',
            executionKey: 'viewport-smoke', requiresPlaywright: 'chromium',
            artifacts: ['.tmp/viewport-output.json'], evidence: ['.tmp/viewport-output.json'],
            ciJob: 'ux-viewport-smoke' });
    });

    const env = {
        ...process.env,
        ...fixture.admissionEnvironment,
        FSUSBLOG_MATRIX_FILE: fixture.matrixFile,
        FSUSBLOG_TEST_RUN_ID: `viewport-resume-${process.pid}`,
        FSUSBLOG_UX_VIEWPORT_RESUME: '1'
    };
    const fresh = spawnSync(process.execPath, [fixture.runner, 'run', fixture.tierId, '--fresh'], {
        cwd: temp,
        env,
        encoding: 'utf8'
    });
    assert.equal(fresh.status, 0, fresh.stderr);
    fs.rmSync(artifact);
    const resumed = spawnSync(process.execPath, [fixture.runner, 'run', fixture.tierId, '--resume'], {
        cwd: temp,
        env,
        encoding: 'utf8'
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(fs.readFileSync(history, 'utf8').trim().split('\n'), ['0', '0']);
});

test('local fresh runs isolate the default namespace by scheduler run id', (t) =>
{
    const temp = createTempDir('scheduler-fresh-namespace');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const marker = path.join(temp, '.tmp/namespaces.txt');
    const fixture = createCanonicalCliFixture(temp,
        `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, process.env.FSUSBLOG_TEST_NAMESPACE + '\\n')\n`);

    for (const runId of ['fresh-namespace-a', 'fresh-namespace-b'])
    {
        const result = spawnSync(process.execPath, [fixture.runner, 'run', fixture.tierId, '--fresh'], {
            cwd: temp,
            env: {
                ...process.env,
                ...fixture.admissionEnvironment,
                FSUSBLOG_MATRIX_FILE: fixture.matrixFile,
                FSUSBLOG_TEST_RUN_ID: runId,
                FSUSBLOG_TEST_NAMESPACE: ''
            },
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
    }

    const namespaces = fs.readFileSync(marker, 'utf8').trim().split('\n');
    assert.equal(new Set(namespaces).size, 2);
    assert.match(namespaces[0], /fresh-namespace-a/u);
    assert.match(namespaces[1], /fresh-namespace-b/u);
});

test('fresh summaries reset locally while tier resources cap nested worker pools', (t) =>
{
    const temp = createTempDir('scheduler-summary-fresh');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const marker = path.join(temp, '.tmp/workers.json');
    const fixture = createCanonicalCliFixture(temp,
        `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ vitest: process.env.FSUSBLOG_VITEST_MAX_WORKERS, manifest: process.env.FSUSBLOG_COMMAND_MANIFEST_WORKERS, bundleBudget: process.env.FSUSBLOG_BUNDLE_CPU_BUDGET }))\n`,
        (tier) =>
        {
            Object.assign(tier, { physicalBundleId: 'fixture-bundle', cpuWeight: 2,
                memoryWeight: 2, minCpuUnits: 1, ciJob: 'fixture' });
            delete tier.cpuUnits;
            delete tier.memoryGiB;
        });
    const env = { ...process.env, ...fixture.admissionEnvironment,
        FSUSBLOG_MATRIX_FILE: fixture.matrixFile, FSUSBLOG_TEST_RUN_ID: 'same-fresh-run' };
    delete env.FSUSBLOG_VITEST_MAX_WORKERS;
    delete env.FSUSBLOG_COMMAND_MANIFEST_WORKERS;
    delete env.FSUSBLOG_BUNDLE_CPU_BUDGET;
    const run = () => spawnSync(process.execPath, [fixture.runner, 'run', fixture.tierId, '--fresh'],
        { cwd: temp, env, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const workers = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const machineCpu = os.availableParallelism?.() ?? os.cpus().length;
    assert.equal(Number(workers.bundleBudget), machineCpu);
    assert.ok(Number(workers.vitest) >= 1 && Number(workers.vitest) <= machineCpu);
    assert.ok(Number(workers.manifest) >= 1 && Number(workers.manifest) <= machineCpu);
    const summaryFile = path.join(temp, '.tmp/release-evidence/jobs/fixture.json');
    const poisoned = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    poisoned.durationMs = 999_999;
    fs.writeFileSync(summaryFile, `${JSON.stringify(poisoned)}\n`);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.ok(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).durationMs < 100_000);
});

test('fresh CI steps accumulate within one workflow job but reset on the next workflow run', (t) =>
{
    const temp = createTempDir('scheduler-summary-ci');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const firstTierId = 'ux-viewport-plan-progress';
    const secondTierId = 'runtime-cache-evidence';
    const fixture = createCanonicalCliFixture(temp, {
        [firstTierId]: 'process.exit(0)\n',
        [secondTierId]: 'process.exit(0)\n'
    }, (tier) =>
    {
        Object.assign(tier, { ciJob: 'fixture', maxParallel: 1, memoryGiB: 1 });
    });
    const run = (tierId, githubRunId) => spawnSync(process.execPath,
        [fixture.runner, 'run', tierId, '--no-deps', '--fresh'], {
            cwd: temp,
            env: {
                ...process.env,
                ...fixture.admissionEnvironment,
                CI: 'true',
                GITHUB_ACTIONS: 'true',
                GITHUB_RUN_ID: githubRunId,
                GITHUB_RUN_ATTEMPT: '1',
                GITHUB_JOB: 'fixture-workflow-job',
                FSUSBLOG_MATRIX_FILE: fixture.matrixFile,
                FSUSBLOG_TEST_RUN_ID: `${githubRunId}-${tierId}`
            },
            encoding: 'utf8'
        });
    const firstRun = run(firstTierId, '100');
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const secondRun = run(secondTierId, '100');
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const summaryFile = path.join(temp, '.tmp/release-evidence/jobs/fixture.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).tierIds.sort(),
        [firstTierId, secondTierId].sort());
    const nextWorkflowRun = run(secondTierId, '101');
    assert.equal(nextWorkflowRun.status, 0, nextWorkflowRun.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(summaryFile, 'utf8')).tierIds, [secondTierId]);
});

test('production cleanup uses the same safe namespace for dot segments as fixture writers', (t) =>
{
    const temp = createTempDir('scheduler-namespace-cleanup');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const fixture = createCanonicalCliFixture(temp, {
        production: [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'mkdir -p .tmp/fixtures/local/auth',
            'printf "{}\\n" > .tmp/fixtures/local/auth/secret.json'
        ].join('\n') + '\n'
    }, (tier) =>
    {
        Object.assign(tier, { phase: 1, resourceClass: 'cpu', ciJob: 'production-summary' });
    });
    const result = spawnSync(process.execPath, [fixture.runner, 'run', fixture.tierId, '--no-deps', '--fresh'], {
        cwd: temp,
        env: { ...process.env, ...fixture.admissionEnvironment,
            FSUSBLOG_MATRIX_FILE: fixture.matrixFile, FSUSBLOG_TEST_NAMESPACE: '..' },
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(temp, '.tmp/fixtures/local/auth')), false);
    const evidence = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/sensitive-fixture-cleanup.json'), 'utf8'));
    assert.equal(evidence.namespace, 'local');
});

test('ci-job keeps its CLI contract while using one scheduler checkpoint for all job tiers', (t) =>
{
    const temp = createTempDir('scheduler-ci-job');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const marker = path.join(temp, '.tmp/marker.txt');
    const firstTierId = 'ux-viewport-plan-progress';
    const secondTierId = 'runtime-cache-evidence';
    const fixture = createCanonicalCliFixture(temp, {
        [firstTierId]: `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, 'a')\n`,
        [secondTierId]: `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, 'b')\n`
    }, (tier) =>
    {
        Object.assign(tier, { ciJob: 'fixture-job', localOnly: false,
            nightlyOnly: false, maxParallel: 2 });
    });

    const runId = `scheduler-ci-job-${process.pid}`;
    const result = spawnSync(process.execPath, [
        fixture.runner,
        'ci-job',
        'fixture-job',
        '--fresh',
        '--max-parallel=2'
    ], {
        cwd: temp,
        env: {
            ...process.env,
            ...fixture.admissionEnvironment,
            FSUSBLOG_MATRIX_FILE: fixture.matrixFile,
            FSUSBLOG_TEST_RUN_ID: runId
        },
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual([...fs.readFileSync(marker, 'utf8')].sort(), ['a', 'b']);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/test-runs', runId, 'checkpoint.json'), 'utf8'));
    assert.deepEqual(checkpoint.completedTiers.sort(), [firstTierId, secondTierId].sort());
});

test('tier fingerprints include shard, selected runtime environment, platform, architecture, and Node version', async () =>
{
    const { tierInputFingerprint } = await loadScheduler();
    assert.equal(typeof tierInputFingerprint, 'function');
    const temp = createTempDir('scheduler-fingerprint-context');
    fs.writeFileSync(path.join(temp, 'input.txt'), 'input\n');
    const current = tier('contextual', { cacheInputs: ['input.txt'] });
    const baseContext = {
        env: {
            MATRIX_SHARD: '1/2',
            FSUSBLOG_TEST_SHARD_INDEX: '1',
            FSUSBLOG_TEST_SHARD_TOTAL: '2',
            FSUSBLOG_PLAYWRIGHT_SHARD_ARG: '--shard=1/2',
            FSUSBLOG_PRODUCTION_BUILD_ROOT: '/tmp/build-a',
            FSUSBLOG_WASM_FUZZ_SEEDS_PER_CORPUS: '320',
            FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS: '1000',
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh',
            FSUSBLOG_TIER_CPU_UNITS: '2',
            FSUSBLOG_TIER_MEMORY_GIB: '1.5',
            FSUSBLOG_TIER_DEADLINE_MS: '60000',
            FSUSBLOG_BUNDLE_CPU_BUDGET: '2',
            FSUSBLOG_BUNDLE_MEMORY_GIB: '1.5',
            FSUSBLOG_BUNDLE_DEADLINE_MS: '60000',
            FSUSBLOG_VITEST_MAX_WORKERS: '2',
            FSUSBLOG_COMMAND_MANIFEST_WORKERS: '2',
            FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/grant-a.json',
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'contextual',
            FSUSBLOG_CGROUP_ENFORCEMENT_MODE: 'advisory',
            FSUSBLOG_CGROUP_BUNDLE_PATH: '/sys/fs/cgroup/run-a/contextual',
            FSUSBLOG_CGROUP_ENFORCEMENT_REASON: 'delegate-unavailable',
            FSUSBLOG_CGROUP_EFFECTIVE_CPU_MAX: '200000 100000',
            FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_HIGH_BYTES: '1610612736',
            FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_MAX_BYTES: '1879048192',
            FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX: '256',
            PLAYWRIGHT_BROWSERS: 'chromium',
            VITE_MODE: 'test',
            CI: 'false',
            NODE_ENV: 'test',
            DOTNET_ROOT: '/dotnet',
            HOME: '/ignored-a'
        },
        platform: 'linux',
        arch: 'x64',
        nodeVersion: 'v22.0.0'
    };
    const base = tierInputFingerprint(current, temp, baseContext);
    assert.equal(base, tierInputFingerprint(current, temp, {
        ...baseContext,
        env: { ...baseContext.env, HOME: '/ignored-b' }
    }), 'unrelated environment variables must not fragment the cache');
    assert.equal(base, tierInputFingerprint(current, temp, {
        ...baseContext,
        env: { ...baseContext.env, FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS: '2000' }
    }), 'invocation timing metadata must not fragment the cache');
    assert.equal(base, tierInputFingerprint(current, temp, {
        ...baseContext,
        env: {
            ...baseContext.env,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'resume',
            FSUSBLOG_TIER_CPU_UNITS: '6',
            FSUSBLOG_TIER_MEMORY_GIB: '4.75',
            FSUSBLOG_TIER_DEADLINE_MS: '60000',
            FSUSBLOG_BUNDLE_CPU_BUDGET: '6',
            FSUSBLOG_BUNDLE_MEMORY_GIB: '4.75',
            FSUSBLOG_BUNDLE_DEADLINE_MS: '60000',
            FSUSBLOG_VITEST_MAX_WORKERS: '6',
            FSUSBLOG_COMMAND_MANIFEST_WORKERS: '5',
            FSUSBLOG_PLAYWRIGHT_WORKERS: '3',
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/grant-b.json',
            FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'contextual-resume',
            FSUSBLOG_CGROUP_ENFORCEMENT_MODE: 'advisory',
            FSUSBLOG_CGROUP_BUNDLE_PATH: '/sys/fs/cgroup/run-b/contextual',
            FSUSBLOG_CGROUP_ENFORCEMENT_REASON: 'delegate-unavailable',
            FSUSBLOG_CGROUP_EFFECTIVE_CPU_MAX: '600000 100000',
            FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_HIGH_BYTES: '5100273664',
            FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_MAX_BYTES: '5368709120',
            FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX: '768'
        }
    }), 'scheduler-only execution grants and enforcement paths must not fragment the cache');

    for (const changedContext of [
        { ...baseContext, env: { ...baseContext.env, MATRIX_SHARD: '2/2' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_TEST_SHARD_TOTAL: '3' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_PLAYWRIGHT_SHARD_ARG: '--shard=2/2' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_PRODUCTION_BUILD_ROOT: '/tmp/build-b' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_WASM_FUZZ_SEEDS_PER_CORPUS: '960' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_FEATURE_FLAG: '1' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_CGROUP_ENFORCEMENT_MODE: 'enforced' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_CGROUP_ENFORCEMENT_REASON: 'delegated' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_TIER_DEADLINE_MS: '90000' } },
        { ...baseContext, env: { ...baseContext.env, FSUSBLOG_BUNDLE_DEADLINE_MS: '90000' } },
        { ...baseContext, env: { ...baseContext.env, PLAYWRIGHT_BROWSERS: 'all' } },
        { ...baseContext, env: { ...baseContext.env, VITE_MODE: 'production' } },
        { ...baseContext, env: { ...baseContext.env, CI: 'true' } },
        { ...baseContext, platform: 'win32' },
        { ...baseContext, arch: 'arm64' },
        { ...baseContext, nodeVersion: 'v24.0.0' }
    ])
    {
        assert.notEqual(base, tierInputFingerprint(current, temp, changedContext));
    }
});

test('resume never reuses a successful tier from a different shard and records checkpoint authority', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-shard-resume');
    const runsRoot = path.join(temp, 'runs');
    const current = tier('sharded');
    const executed = [];
    const executeTier = async () =>
    {
        executed.push('run');
        return { code: 0, signal: null };
    };
    const run = (shard, resume) => runDag({
        tiers: [current],
        root: temp,
        runsRoot,
        runId: 'same-run',
        mode: resume ? 'resume' : 'fresh',
        resume,
        maxParallel: 1,
        snapshotWorktree: stableSnapshot,
        envForTier: () => ({
            MATRIX_SHARD: shard,
            FSUSBLOG_TEST_SHARD_INDEX: shard.split('/')[0],
            FSUSBLOG_TEST_SHARD_TOTAL: shard.split('/')[1]
        }),
        executeTier
    });

    const fresh = await run('1/2', false);
    assert.equal(fresh.checkpoint.mode, 'fresh');
    assert.equal(fresh.checkpoint.authoritative, true);
    const otherShard = await run('2/2', true);
    assert.equal(otherShard.checkpoint.mode, 'resume');
    assert.equal(otherShard.checkpoint.authoritative, false);
    assert.deepEqual(executed, ['run', 'run']);
    const sameShard = await run('2/2', true);
    assert.deepEqual(sameShard.reusedTiers, ['sharded']);
    assert.deepEqual(executed, ['run', 'run']);
});

test('phase barrier settles every lower phase before release evidence can start', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-phase-barrier');
    const events = [];
    const lowerSettled = new Set();
    let releaseStartedEarly = false;
    const result = await runDag({
        tiers: [
            tier('unit-left', { phase: 1 }),
            tier('unit-right', { phase: 1 }),
            tier('release-evidence', { phase: 4 })
        ],
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'phase-barrier',
        mode: 'fresh',
        maxParallel: 3,
        systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            events.push(`start:${current.id}`);
            if (current.id === 'release-evidence' && lowerSettled.size !== 2)
            {
                releaseStartedEarly = true;
            }
            await delay(current.phase === 4 ? 1 : 25);
            if (current.phase === 1)
            {
                lowerSettled.add(current.id);
            }
            events.push(`end:${current.id}`);
            return { code: 0, signal: null };
        }
    });
    assert.equal(result.status, 'success');
    assert.equal(releaseStartedEarly, false);
    assert.ok(events.indexOf('start:release-evidence') > events.indexOf('end:unit-left'));
    assert.ok(events.indexOf('start:release-evidence') > events.indexOf('end:unit-right'));
});

test('supersedes rejects variant misuse, cycles, and chains and runDag fails closed', async () =>
{
    const { runDag, validateSupersedesRules } = await loadScheduler();
    const registry = new Map([['unit', { assertionType: 'unit' }]]);
    const variantMisuse = [
        tier('base', { executionKey: 'shared', coverage: ['unit'] }),
        tier('replacement', { executionKey: 'shared', coverage: ['unit'], supersedes: ['base'] })
    ];
    assert.ok(validateSupersedesRules(variantMisuse, registry).some((message) => message.includes('executionVariant')));

    const cycle = [
        tier('cycle-a', {
            executionKey: 'cycle',
            executionVariant: 'coverage',
            coverage: ['unit'],
            supersedes: ['cycle-b']
        }),
        tier('cycle-b', {
            executionKey: 'cycle',
            executionVariant: 'coverage',
            coverage: ['unit'],
            supersedes: ['cycle-a']
        })
    ];
    assert.ok(validateSupersedesRules(cycle, registry).some((message) => /cycle/i.test(message)));

    const chain = [
        tier('chain-base', { executionKey: 'chain', coverage: ['unit'] }),
        tier('chain-middle', {
            executionKey: 'chain',
            executionVariant: 'coverage',
            coverage: ['unit'],
            supersedes: ['chain-base']
        }),
        tier('chain-top', {
            executionKey: 'chain',
            executionVariant: 'coverage',
            coverage: ['unit'],
            supersedes: ['chain-middle']
        })
    ];
    assert.ok(validateSupersedesRules(chain, registry).some((message) => /chain/i.test(message)));
    await assert.rejects(runDag({
        tiers: cycle,
        coverageRegistry: registry,
        root: createTempDir('scheduler-supersedes-cycle'),
        runId: 'cycle',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    }), /supersedes/i);
});

test('runDag validates supersedes against the full universe but applies only selected tiers', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-supersedes-universe');
    const registry = new Map([
        ['unit', { assertionType: 'unit' }],
        ['unit-extra', { assertionType: 'unit' }]
    ]);
    const target = tier('universe-target', {
        executionKey: 'universe/shared',
        executionVariant: 'ordinary',
        coverage: ['unit']
    });
    const replacement = tier('universe-replacement', {
        executionKey: 'universe/shared',
        executionVariant: 'coverage',
        coverage: ['unit', 'unit-extra'],
        supersedes: ['universe-target']
    });
    const executed = [];
    const standalone = await runDag({
        tiers: [replacement],
        supersedesUniverse: [target, replacement],
        coverageRegistry: registry,
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'replacement-only',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async (current) =>
        {
            executed.push(current.id);
            return { code: 0, signal: null };
        }
    });
    assert.equal(standalone.status, 'success');
    assert.deepEqual(executed, ['universe-replacement']);

    const cycle = [
        tier('universe-cycle-a', {
            executionKey: 'universe/cycle',
            executionVariant: 'coverage',
            coverage: ['unit'],
            supersedes: ['universe-cycle-b']
        }),
        tier('universe-cycle-b', {
            executionKey: 'universe/cycle',
            executionVariant: 'coverage',
            coverage: ['unit'],
            supersedes: ['universe-cycle-a']
        })
    ];
    await assert.rejects(runDag({
        tiers: [cycle[0]],
        supersedesUniverse: cycle,
        coverageRegistry: registry,
        root: temp,
        runsRoot: path.join(temp, 'runs'),
        runId: 'global-cycle',
        mode: 'fresh',
        snapshotWorktree: stableSnapshot,
        executeTier: async () => ({ code: 0, signal: null })
    }), /cycle/i);
});

test('snapshot hashes only dirty and untracked paths while retaining status, mode, and index state', async () =>
{
    const { snapshotGitWorktree } = await loadScheduler();
    const repo = createTempDir('scheduler-incremental-snapshot');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo });
    for (let index = 0; index < 120; index += 1)
    {
        fs.writeFileSync(path.join(repo, `clean-${index}.txt`), `clean ${index}\n`);
    }
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    const clean = await snapshotGitWorktree(repo);
    assert.equal(clean.hashedPathCount, 0);
    assert.deepEqual(clean.entries, {});
    fs.writeFileSync(path.join(repo, 'clean-0.txt'), 'dirty\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    execFileSync('git', ['add', 'clean-0.txt'], { cwd: repo });
    const dirty = await snapshotGitWorktree(repo);
    assert.equal(dirty.hashedPathCount, 2);
    assert.deepEqual(Object.keys(dirty.entries).sort(), ['clean-0.txt', 'untracked.txt']);
    assert.match(dirty.entries['clean-0.txt'].status, /^M/);
    assert.match(dirty.entries['clean-0.txt'].index, /^100644:/);
    assert.equal(typeof dirty.entries['clean-0.txt'].mode, 'number');
});

test('pollution detection catches staging and executable-bit changes without rejecting prior dirt', { skip: process.platform === 'win32' }, async () =>
{
    const { runDag } = await loadScheduler();
    const createRepo = (name) =>
    {
        const repo = createTempDir(name);
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'scheduler@example.invalid'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Scheduler Test'], { cwd: repo });
        execFileSync('git', ['config', 'core.filemode', 'true'], { cwd: repo });
        fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
        execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
        return repo;
    };

    const stagedRepo = createRepo('scheduler-staged-pollution');
    fs.writeFileSync(path.join(stagedRepo, 'tracked.txt'), 'pre-existing dirt\n');
    const staged = await runDag({
        tiers: [tier('stage', { command: 'git add tracked.txt' })],
        root: stagedRepo,
        runsRoot: createTempDir('scheduler-stage-runs'),
        runId: 'stage',
        mode: 'fresh',
        maxParallel: 1
    });
    assert.equal(staged.status, 'failure');
    assert.ok(staged.failure.changedPaths.includes('tracked.txt'));

    const modeRepo = createRepo('scheduler-mode-pollution');
    const mode = await runDag({
        tiers: [tier('chmod', { command: 'chmod 755 tracked.txt' })],
        root: modeRepo,
        runsRoot: createTempDir('scheduler-mode-runs'),
        runId: 'chmod',
        mode: 'fresh',
        maxParallel: 1
    });
    assert.equal(mode.status, 'failure');
    assert.ok(mode.failure.changedPaths.includes('tracked.txt'));
});

test('ci-pr-smart executes selected tiers through one asynchronous DAG run', (t) =>
{
    const temp = createTempDir('scheduler-ci-pr-smart');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const marker = path.join(temp, '.tmp/events.txt');
    const readyDir = path.join(temp, '.tmp/ready');
    const changedFiles = path.join(temp, '.tmp/changed.txt');
    const scriptFor = (id) =>
    {
        return [
            "import fs from 'node:fs'",
            "import path from 'node:path'",
            `fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`start:${id}\n`)})`,
            `fs.writeFileSync(path.join(${JSON.stringify(readyDir)}, ${JSON.stringify(id)}), 'ready')`,
            'const deadline = Date.now() + 10_000',
            'const waitForPeer = () => {',
            `  if (fs.readdirSync(${JSON.stringify(readyDir)}).length === 2) {`,
            `    fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`end:${id}\n`)})`,
            '    return',
            '  }',
            "  if (Date.now() >= deadline) throw new Error('peer tier was never admitted concurrently')",
            '  setTimeout(waitForPeer, 10)',
            '}',
            'waitForPeer()'
        ].join('\n');
    };
    const firstTierId = 'ux-viewport-plan-progress';
    const secondTierId = 'runtime-cache-evidence';
    const fixture = createCanonicalCliFixture(temp, {
        [firstTierId]: scriptFor(firstTierId),
        [secondTierId]: scriptFor(secondTierId)
    }, (tier) =>
    {
        Object.assign(tier, { phase: 1, ciJob: `fixture-${tier.id}`, smartGateMode: 'always',
            prDefault: true, localOnly: false, nightlyOnly: false, manualOnly: false });
    }, { prSmartSelectedOnly: true });
    fs.mkdirSync(readyDir, { recursive: true });
    fs.writeFileSync(changedFiles, '');

    const result = spawnSync(process.execPath, [
        fixture.runner,
        'ci-pr-smart',
        '--changed-files',
        changedFiles
    ], {
        cwd: temp,
        env: {
            ...process.env,
            ...fixture.admissionEnvironment,
            FSUSBLOG_MATRIX_FILE: fixture.matrixFile
        },
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual([...result.stderr.matchAll(/\[matrix:ci-pr-smart\] started ([^:]+):/gu)]
        .map((match) => match[1]).filter((id) => id !== 'managed-production-build-gc').sort(),
    [firstTierId, secondTierId].sort());
    const events = fs.readFileSync(marker, 'utf8').trim().split('\n');
    const firstEnd = Math.min(events.indexOf(`end:${firstTierId}`), events.indexOf(`end:${secondTierId}`));
    assert.ok(events.indexOf(`start:${firstTierId}`) < firstEnd);
    assert.ok(events.indexOf(`start:${secondTierId}`) < firstEnd);
});

test('resident leases stay in admission accounting, hand off once, and release capacity only after exit', async () =>
{
    const { runDag } = await loadScheduler();
    assert.equal(typeof runDag, 'function');
    const temp = createTempDir('scheduler-resident-leases');
    const runId = 'resident-run';
    const namespace = 'resident-namespace';
    const sourceState = { commit: 'unversioned', worktreeFingerprint: 'stable' };
    let residentLive = true;
    let consumerGrant = null;
    let consumerEnvironment = null;
    let consumerStartedBeforeHandoff = false;
    const runtime = tier('runtime', {
        physicalBundleId: 'runtime-browser',
        residentLeaseProducer: true,
        residentLeaseTarget: 'performance-evidence',
        cpuUnits: 2,
        memoryGiB: 2
    });
    const performance = tier('performance', {
        physicalBundleId: 'performance-evidence',
        residentLeaseConsumer: true,
        resourceGrantMode: 'dynamic',
        cpuWeight: 3,
        memoryWeight: 3,
        minCpuUnits: 3,
        startupMinCpuUnits: 1,
        startupMemoryWeight: 1,
        startupPriority: 0
    });
    const afterExit = tier('after-exit', {
        executionDependsOn: ['performance'],
        cpuUnits: 4,
        memoryGiB: 4
    });
    const result = await runDag({
        tiers: [runtime, performance, afterExit],
        root: temp,
        runsRoot: path.join(temp, '.tmp/test-runs'),
        runId,
        targetTierId: 'after-exit',
        mode: 'fresh',
        sourceState,
        maxParallel: 2,
        systemResources: { cpuCount: 4, availableCpuUnits: 4, availableMemoryGiB: 4, load1: 0 },
        currentFreeMemoryGiB: () => 4,
        resourceEnforcementMode: 'advisory',
        snapshotWorktree: stableSnapshot,
        observeResidentService: () => residentLive
            ? { status: 'live', observedRssBytes: 128, observedCpuTicks: 10 }
            : { status: 'exited', observedRssBytes: 0, observedCpuTicks: 20 },
        executeTier: async (current, context) =>
        {
            if (current.id === 'runtime')
            {
                const unboundInventory = createResidentLeaseInventory({
                    runId,
                    namespace,
                    sourceState,
                    ownerBundleId: 'runtime-browser',
                    resourceGrant: { cpuUnits: 2, memoryGiB: 1.9999996 },
                    schedulerResourceGrant: { cpuUnits: 2, memoryGiB: 2 },
                    resourceBudget: { cpuUnits: 4, memoryGiB: 4 },
                    services: [
                        {
                            id: 'backend',
                            kind: 'process',
                            identity: { pid: 42, startTimeTicks: '100' },
                            port: 24001,
                            generation: 'backend-1',
                            health: { status: 'ready', checkedAt: '2026-07-14T00:00:00.000Z' },
                            observedRssBytes: 128
                        },
                        {
                            id: 'postgres',
                            kind: 'container',
                            identity: { containerId: 'a'.repeat(64), createdAt: '2026-07-14T00:00:00.000Z' },
                            port: 24002,
                            generation: 'postgres-1',
                            health: { status: 'ready', checkedAt: '2026-07-14T00:00:00.000Z' },
                            observedRssBytes: 128
                        }
                    ]
                });
                const backend = unboundInventory.services.find((service) => service.id === 'backend');
                const postgres = unboundInventory.services.find((service) => service.id === 'postgres');
                const inventory = bindResidentLeaseEnforcement(unboundInventory, {
                    mode: 'advisory',
                    processScope: { status: 'advisory', path: null, reservation: backend.reservation },
                    containers: {
                        postgres: {
                            status: 'advisory', containerId: postgres.identity.containerId, reservation: postgres.reservation
                        }
                    },
                    boundAt: '2026-07-14T00:00:01.000Z'
                });
                writeResidentLeaseDocument(path.join(context.runDirectory, 'resident-resource-leases.json'), inventory);
            }
            else if (current.id === 'performance')
            {
                consumerEnvironment = context.env;
                consumerStartedBeforeHandoff = !fs.existsSync(context.env.FSUSBLOG_RESIDENT_LEASE_HANDOFF);
                const handoffDeadline = Date.now() + 5_000;
                while (!fs.existsSync(context.env.FSUSBLOG_RESIDENT_LEASE_HANDOFF))
                {
                    if (Date.now() >= handoffDeadline)
                    {
                        throw new Error('resident handoff was not published');
                    }
                    await delay(2);
                }
                const inventory = readResidentLeaseDocument(context.env.FSUSBLOG_RESIDENT_LEASE_INVENTORY);
                const handoff = readResidentLeaseDocument(context.env.FSUSBLOG_RESIDENT_LEASE_HANDOFF);
                const consumed = consumeResidentLeaseHandoff(handoff, {
                    inventory,
                    consumerBundleId: 'performance-evidence'
                });
                writeResidentLeaseDocument(context.env.FSUSBLOG_RESIDENT_LEASE_HANDOFF, consumed);
                consumerGrant = JSON.parse(fs.readFileSync(context.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE, 'utf8'));
                const restartedUnbound = createResidentLeaseInventory({
                    runId,
                    namespace,
                    sourceState,
                    ownerBundleId: 'runtime-browser',
                    resourceGrant: { cpuUnits: 2, memoryGiB: 2 },
                    resourceBudget: { cpuUnits: 4, memoryGiB: 4 },
                    services: [
                        {
                            id: 'backend', kind: 'process', identity: { pid: 43, startTimeTicks: '101' }, port: 24001,
                            generation: 'backend-2', health: { status: 'ready', checkedAt: '2026-07-14T00:00:05.000Z' },
                            observedRssBytes: 512
                        },
                        {
                            id: 'postgres', kind: 'container',
                            identity: { containerId: 'a'.repeat(64), createdAt: '2026-07-14T00:00:00.000Z' }, port: 24002,
                            generation: 'postgres-1', health: { status: 'ready', checkedAt: '2026-07-14T00:00:05.000Z' },
                            observedRssBytes: 128
                        }
                    ]
                });
                const restartedBackend = restartedUnbound.services.find((service) => service.id === 'backend');
                const restartedPostgres = restartedUnbound.services.find((service) => service.id === 'postgres');
                const restarted = bindResidentLeaseEnforcement(restartedUnbound, {
                    mode: 'advisory',
                    processScope: { status: 'advisory', path: null, reservation: restartedBackend.reservation },
                    containers: {
                        postgres: {
                            status: 'advisory',
                            containerId: restartedPostgres.identity.containerId,
                            reservation: restartedPostgres.reservation
                        }
                    },
                    boundAt: '2026-07-14T00:00:06.000Z'
                });
                writeResidentLeaseDocument(context.env.FSUSBLOG_RESIDENT_LEASE_INVENTORY, restarted);
                residentLive = false;
            }
            return { code: 0, signal: null };
        },
        envForTier: (current) => ({
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_PHYSICAL_BUNDLE_ID: current.physicalBundleId ?? current.id
        })
    });
    assert.equal(result.status, 'success', JSON.stringify(result.failure ?? result.checkpoint.failures));
    assert.equal(result.checkpoint.tiers.performance.resourceGrant.cpuUnits, 3);
    assert.equal(consumerStartedBeforeHandoff, true);
    assert.ok(result.checkpoint.tiers.performance.resourceGrantHistory.length >= 2);
    assert.equal(result.checkpoint.tiers['after-exit'].resourceGrant.cpuUnits, 4);
    assert.equal(consumerGrant.residentReservation.cpuUnits, 1);
    assert.equal(consumerGrant.grants.performance.cpuUnits, 3);
    assert.ok(consumerEnvironment.FSUSBLOG_RESIDENT_LEASE_INVENTORY);
    assert.equal(result.checkpoint.residentResourceLeases.handoff.status, 'consumed');
    assert.deepEqual(result.checkpoint.residentResourceLeases.resourceGrant, { cpuUnits: 2, memoryGiB: 2 });
    assert.equal(result.checkpoint.residentResourceLeases.status, 'released');
    assert.ok(result.checkpoint.residentResourceLeases.services.backend.history.some((entry) => entry.status === 'live'));
    assert.ok(result.checkpoint.residentResourceLeases.services.backend.history.some((entry) => entry.status === 'exited'));
    assert.equal(result.checkpoint.residentResourceLeases.services.backend.restartCount, 1);
    assert.ok(result.checkpoint.residentResourceLeases.events.some((event) => event.type === 'generation-replaced'));
    const enforcement = result.checkpoint.resourceEnforcement.bundles['runtime-browser'];
    assert.equal(enforcement.grants.at(-1).cpuUnits, 0.5);
    assert.ok(enforcement.grants.length >= 3);
});

test('failed resident producer retains partial live-service evidence without publishing a handoff', async () =>
{
    const { runDag } = await loadScheduler();
    const temp = createTempDir('scheduler-resident-partial');
    const runId = 'resident-partial';
    const namespace = 'resident-partial-namespace';
    const sourceState = { commit: 'unversioned', worktreeFingerprint: 'stable' };
    const runtime = tier('runtime', {
        physicalBundleId: 'runtime-browser', residentLeaseProducer: true,
        residentLeaseTarget: 'performance-evidence', cpuUnits: 2, memoryGiB: 2
    });
    const performance = tier('performance', {
        physicalBundleId: 'performance-evidence', residentLeaseConsumer: true,
        executionDependsOn: ['runtime'], cpuUnits: 1, memoryGiB: 1
    });
    const result = await runDag({
        tiers: [runtime, performance],
        root: temp,
        runsRoot: path.join(temp, '.tmp/test-runs'),
        runId,
        targetTierId: 'performance',
        mode: 'fresh',
        sourceState,
        collectFailures: true,
        maxParallel: 1,
        systemResources: { cpuCount: 4, availableCpuUnits: 4, availableMemoryGiB: 4, load1: 0 },
        currentFreeMemoryGiB: () => 4,
        resourceEnforcementMode: 'advisory',
        snapshotWorktree: stableSnapshot,
        observeResidentService: () => ({ status: 'live', observedRssBytes: 128, observedCpuTicks: 10 }),
        envForTier: (current) => ({
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_PHYSICAL_BUNDLE_ID: current.physicalBundleId ?? current.id
        }),
        executeTier: async (current, context) =>
        {
            if (current.id === 'runtime')
            {
                const unboundInventory = createResidentLeaseInventory({
                    runId,
                    namespace,
                    sourceState,
                    ownerBundleId: 'runtime-browser',
                    resourceGrant: { cpuUnits: 2, memoryGiB: 2 },
                    resourceBudget: { cpuUnits: 4, memoryGiB: 4 },
                    services: [{
                        id: 'backend', kind: 'process', identity: { pid: 42, startTimeTicks: '100' }, port: 24001,
                        generation: 'backend-1', health: { status: 'ready', checkedAt: '2026-07-14T00:00:00.000Z' },
                        observedRssBytes: 128
                    }]
                });
                writeResidentLeaseDocument(path.join(context.runDirectory, 'resident-resource-leases.json'), bindResidentLeaseEnforcement(unboundInventory, {
                    mode: 'advisory',
                    processScope: { status: 'advisory', path: null, reservation: unboundInventory.reservation },
                    containers: {},
                    boundAt: '2026-07-14T00:00:01.000Z'
                }));
                return { code: 7, signal: null };
            }
            throw new Error('blocked consumer must not execute');
        }
    });
    assert.equal(result.status, 'failure');
    assert.equal(result.checkpoint.residentResourceLeases.status, 'partial');
    assert.equal(result.checkpoint.residentResourceLeases.handoff, null);
    assert.ok(result.checkpoint.residentResourceLeases.reservation.cpuUnits > 0);
    assert.equal(result.checkpoint.tiers.performance.status, 'blocked');
});

function parserFixtureRoot(name)
{
    return fs.realpathSync(createTempDir(name));
}

test('ESM fixture materializer follows literal dynamic imports without treating comments as dependencies', async (t) =>
{
    const source = parserFixtureRoot('dynamic-import-source');
    const fixture = parserFixtureRoot('dynamic-import-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), [
        "// import('./missing-comment.mjs')",
        'const text = "import(\'./missing-string.mjs\')";',
        'export const value = (await import(`./adapter.mjs`)).value;',
        'export { text };',
        'process.stdout.write(String(value));'
    ].join('\n'));
    fs.writeFileSync(path.join(source, 'tools/adapter.mjs'),
        "export const value = (await import(new URL('./leaf.mjs', import.meta.url))).value;\n");
    fs.writeFileSync(path.join(source, 'tools/leaf.mjs'), 'export const value = 42;\n');
    const declaration = { entries: ['tools/entry.mjs'], allowedRoots: ['tools'] };
    const result = materializeEsmFixture({ repositoryRoot: source, fixtureRoot: fixture, ...declaration });
    assert.deepEqual(result.files, ['tools/adapter.mjs', 'tools/entry.mjs', 'tools/leaf.mjs']);
    assert.equal(execFileSync(process.execPath, [result.entryFiles[0]], { encoding: 'utf8' }), '42');
    fs.unlinkSync(path.join(fixture, 'tools/adapter.mjs'));
    assert.throws(() => preflightMaterializedEsmFixture({ fixtureRoot: fixture, ...declaration }),
        /local dependency is missing.*specifier=\.\/adapter\.mjs/u);
});

test('ESM fixture parser batches a complete cyclic fanout without evaluating its source', (t) =>
{
    const source = parserFixtureRoot('parser-batch-source');
    const fixture = parserFixtureRoot('parser-batch-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    const leaves = Array.from({ length: 40 }, (_, index) => `leaf-${index}.mjs`);
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), leaves.map(name => `import './${name}';`).join('\n'));
    for (const [index, name] of leaves.entries())
    {
        fs.writeFileSync(path.join(source, 'tools', name),
            `import './entry.mjs';\nexport const value = ${index};\nthrow new Error('fixture source was evaluated');\n`);
    }
    const program = [
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'let workers = 0;',
        'const original = childProcess.spawnSync;',
        'childProcess.spawnSync = function (command, args, options) {',
        "    if (args.includes('--experimental-vm-modules')) workers += 1;",
        '    return original.call(this, command, args, options);',
        '};',
        'syncBuiltinESMExports();',
        `const { materializeEsmFixture } = await import(${JSON.stringify(new URL('./support/esm-fixture-materializer.mjs', import.meta.url).href)});`,
        `const result = materializeEsmFixture({ repositoryRoot: ${JSON.stringify(source)}, fixtureRoot: ${JSON.stringify(fixture)}, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] });`,
        "process.stdout.write(String(workers) + '\\n' + String(result.files.length) + '\\n');"
    ].join('\n');
    const result = execFileSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8' });
    assert.equal(result, '4\n41\n', 'one entry batch and three bounded leaf batches must retain every module');
    for (const name of ['entry.mjs', ...leaves])
    {
        assert.deepEqual(fs.readFileSync(path.join(fixture, 'tools', name)), fs.readFileSync(path.join(source, 'tools', name)));
    }
});

test('ESM fixture parser rejects syntax in a later batch before copying any module', (t) =>
{
    const source = parserFixtureRoot('parser-late-syntax-source');
    const fixture = parserFixtureRoot('parser-late-syntax-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    const leaves = Array.from({ length: 32 }, (_, index) => `leaf-${index}.mjs`);
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), leaves.map(name => `import './${name}';`).join('\n'));
    for (const [index, name] of leaves.entries())
    {
        fs.writeFileSync(path.join(source, 'tools', name), index === 0 ? 'export const broken = ;\n' : `export const value = ${index};\n`);
    }
    const declaration = { repositoryRoot: source, fixtureRoot: fixture, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] };
    assert.throws(() => materializeEsmFixture(declaration), /parser failed for .*leaf-0\.mjs.*SyntaxError/su);
    assert.deepEqual(fs.readdirSync(fixture), [], 'a later failed parser batch must not leave a partial fixture');
    fs.writeFileSync(path.join(source, 'tools/leaf-0.mjs'), 'export const value = 0;\n');
    assert.equal(materializeEsmFixture(declaration).files.length, 33);
});

test('ESM fixture parser cache follows current source bytes rather than paths or buffer identity', async (t) =>
{
    const { parseStaticRelativeEsmSpecifiers } = await import('./support/esm-fixture-materializer.mjs');
    const bytes = Buffer.from("import './a.mjs';");
    assert.deepEqual(parseStaticRelativeEsmSpecifiers(bytes), ['./a.mjs']);
    bytes[10] = 'b'.charCodeAt(0);
    assert.deepEqual(parseStaticRelativeEsmSpecifiers(bytes), ['./b.mjs']);
    assert.deepEqual(parseStaticRelativeEsmSpecifiers(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)), ['./b.mjs']);
    assert.deepEqual(parseStaticRelativeEsmSpecifiers(`import './${String.fromCharCode(0xd800)}.mjs';`), ['./\ufffd.mjs']);
    const source = parserFixtureRoot('parser-cache-source');
    const fixture = parserFixtureRoot('parser-cache-target');
    const refused = parserFixtureRoot('parser-cache-refused');
    for (const location of [source, fixture, refused])
    {
        t.after(() => fs.rmSync(location, { recursive: true, force: true }));
    }
    fs.mkdirSync(path.join(source, 'tools'));
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), 'export const value = 12345;\n');
    const declaration = { repositoryRoot: source, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] };
    materializeEsmFixture({ ...declaration, fixtureRoot: fixture });
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), "import './missing-after-edit.mjs';\n");
    assert.throws(() => materializeEsmFixture({ ...declaration, fixtureRoot: refused }), /local dependency is missing/u);
    assert.deepEqual(fs.readdirSync(refused), []);
    assert.equal(fs.readFileSync(path.join(fixture, 'tools/entry.mjs'), 'utf8'), 'export const value = 12345;\n');
});

test('ESM fixture parser preserves the per-module output limit without truncating valid batch output', async (t) =>
{
    const { parseStaticRelativeEsmSpecifiers } = await import('./support/esm-fixture-materializer.mjs');
    const oversized = `import './${'a'.repeat(600000)}';\nimport './${'b'.repeat(600000)}';\n`;
    assert.throws(() => parseStaticRelativeEsmSpecifiers(oversized), /parser failed.*per-module parser output limit/su);
    const source = parserFixtureRoot('parser-output-source');
    const fixture = parserFixtureRoot('parser-output-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), "import './a.mjs';\nimport './b.mjs';\n");
    for (const letter of ['a', 'b'])
    {
        fs.writeFileSync(path.join(source, 'tools', letter + '.mjs'), `import '${letter.repeat(600000)}';\n`);
    }
    assert.equal(materializeEsmFixture({ repositoryRoot: source, fixtureRoot: fixture,
        entries: ['tools/entry.mjs'], allowedRoots: ['tools'] }).files.length, 3);
    for (const letter of ['a', 'b'])
    {
        assert.deepEqual(fs.readFileSync(path.join(fixture, 'tools', letter + '.mjs')),
            fs.readFileSync(path.join(source, 'tools', letter + '.mjs')));
    }
});

test('ESM fixture parser refuses malformed worker rows without populating its cache', () =>
{
    const responses = [
        "'{'", "'null'", "'[]'", "JSON.stringify([{ index: 1, requests: [] }])",
        "JSON.stringify([{ index: 0 }])", "JSON.stringify([{ index: 0, requests: [null] }])",
        "JSON.stringify([{ index: 0, requests: [], unknown: true }])",
        "JSON.stringify([{ index: 0, requests: ['./' + 'x'.repeat(1048576)] }])"
    ].map(stdout => `{ status: 0, stdout: ${stdout}, stderr: '' }`);
    responses.push(
        "{ status: 1, stdout: JSON.stringify([{ index: 0, requests: [] }]), stderr: 'controlled failed module' }",
        "{ status: 0, stdout: JSON.stringify([{ index: 0, requests: [] }]), stderr: '', error: new Error('controlled worker failure') }"
    );
    for (const response of responses)
    {
        const program = [
            "import assert from 'node:assert/strict';",
            "import childProcess from 'node:child_process';",
            "import { syncBuiltinESMExports } from 'node:module';",
            'let refuse = true, realWorkers = 0;',
            'const original = childProcess.spawnSync;',
            'childProcess.spawnSync = function (command, args, options) {',
            "    if (args.includes('--experimental-vm-modules')) {",
            '        if (refuse) { refuse = false;',
            `            return ${response};`,
            '        }',
            '        realWorkers += 1;',
            '    }',
            '    return original.call(this, command, args, options);',
            '};',
            'syncBuiltinESMExports();',
            `const { parseStaticRelativeEsmSpecifiers } = await import(${JSON.stringify(new URL('./support/esm-fixture-materializer.mjs', import.meta.url).href)});`,
            "const source = 'export const value = 48217;';",
            'assert.throws(() => parseStaticRelativeEsmSpecifiers(source), /malformed|over-limit|parser failed/);',
            'assert.deepEqual(parseStaticRelativeEsmSpecifiers(source), []);',
            'assert.equal(realWorkers, 1);',
            "process.stdout.write('verified\\n');"
        ].join('\n');
        assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8' }), 'verified\n');
    }
});

test('ESM fixture parser refuses a misbound batch before copying or caching an earlier row', (t) =>
{
    const source = parserFixtureRoot('parser-misbound-source');
    const fixture = parserFixtureRoot('parser-misbound-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(source, 'tools'));
    fs.writeFileSync(path.join(source, 'tools/entry.mjs'), "import './a.mjs';\nimport './b.mjs';\n");
    fs.writeFileSync(path.join(source, 'tools/a.mjs'), 'export const value = 19;\n');
    fs.writeFileSync(path.join(source, 'tools/b.mjs'), 'export const value = 29;\n');
    const program = [
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'let refuse = true, leafBatches = 0;',
        'const original = childProcess.spawnSync;',
        'childProcess.spawnSync = function (command, args, options) {',
        "    if (args.includes('--experimental-vm-modules') && JSON.parse(options.input).length === 2) {",
        '        leafBatches += 1;',
        '        if (refuse) { refuse = false;',
        "            return { status: 0, stdout: JSON.stringify([{ index: 0, requests: ['./poison-cache.mjs'] }, { index: 0, requests: [] }]), stderr: '' };",
        '        }',
        '    }',
        '    return original.call(this, command, args, options);',
        '};',
        'syncBuiltinESMExports();',
        `const { materializeEsmFixture } = await import(${JSON.stringify(new URL('./support/esm-fixture-materializer.mjs', import.meta.url).href)});`,
        `const declaration = { repositoryRoot: ${JSON.stringify(source)}, fixtureRoot: ${JSON.stringify(fixture)}, entries: ['tools/entry.mjs'], allowedRoots: ['tools'] };`,
        'assert.throws(() => materializeEsmFixture(declaration), /malformed/);',
        'assert.deepEqual(fs.readdirSync(declaration.fixtureRoot), []);',
        'assert.equal(materializeEsmFixture(declaration).files.length, 3);',
        'assert.equal(leafBatches, 2);',
        "process.stdout.write('verified\\n');"
    ].join('\n');
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8' }), 'verified\n');
});

function fixtureRoot(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-posix-readiness-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('POSIX cancellation fixture requires an absolute PID path and a finite bounded setup interval', () =>
{
    for (const startupTimeoutMs of [0, -1, 5001, Infinity, NaN, '5000'])
    {
        assert.throws(() => posixCancellationFailureSource({
            pidFile: path.join(os.tmpdir(), 'grandchild.pid'), startupTimeoutMs
        }), /requires an absolute PID path and finite setup bound/u);
    }
    for (const pidFile of [undefined, '', 'relative.pid'])
    {
        assert.throws(() => posixCancellationFailureSource({ pidFile }),
            /requires an absolute PID path and finite setup bound/u);
    }
});

test('POSIX cancellation fixture waits for a delayed real grandchild before injecting failure',
    { skip: process.platform === 'win32' }, async (context) =>
    {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-posix-readiness-'));
        const pidFile = path.join(root, 'grandchild.pid');
        const grandchildFile = path.join(root, 'grandchild.mjs');
        const slowFile = path.join(root, 'slow.mjs');
        const failFile = path.join(root, 'fail.mjs');
        fs.writeFileSync(grandchildFile, 'setInterval(() => {}, 1000)\n');
        fs.writeFileSync(slowFile, [
            "import { spawn } from 'node:child_process'",
            "import fs from 'node:fs'",
            "import { setTimeout as delay } from 'node:timers/promises'",
            'await delay(600)',
            `const child = spawn(process.execPath, [${JSON.stringify(grandchildFile)}], { stdio: 'ignore' })`,
            `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
            'setInterval(() => {}, 1000)'
        ].join('\n'));
        fs.writeFileSync(failFile, posixCancellationFailureSource({ pidFile }));
        context.after(() =>
        {
            if (!fs.existsSync(pidFile))
            {
                fs.rmSync(root, { recursive: true, force: true });
                return;
            }
            const pid = Number(fs.readFileSync(pidFile, 'utf8'));
            try
            {
                const command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
                if (command.trim() === `${process.execPath} ${grandchildFile}`)
                {
                    process.kill(pid, 'SIGKILL');
                }
            }
            catch (error)
            {
                if (error.code !== 'ESRCH' && error.status !== 1)
                {
                    throw error;
                }
            }
            finally
            {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
        const tier = (id, file) => ({ id, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`,
            executionDependsOn: [], services: [], parallelizable: true, exclusiveResources: [], phase: 0,
            resourceClass: 'cpu', maxParallel: 2, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [],
            executionKey: id, executionVariant: 'ordinary', coverage: ['ordinary-unit'] });
        const result = await (await loadScheduler()).runDag({
            tiers: [tier('slow', slowFile), tier('fail', failFile)], root,
            runsRoot: path.join(root, 'runs'), runId: 'stop', maxParallel: 2,
            systemResources: { cpuCount: 8, availableMemoryGiB: 8, load1: 0 },
            snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
            terminationGraceMs: 100
        });
        assert.equal(result.status, 'failure');
        assert.equal(result.failure.tierId, 'fail');
        assert.equal(result.failure.exitCode, 7);
        assert.ok(fs.existsSync(pidFile), 'the delayed slow tier must start its real grandchild before sibling failure');
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        let alive = true;
        for (let attempt = 0; attempt < 40 && alive; attempt += 1)
        {
            try
            {
                process.kill(pid, 0);
                await delay(25);
            }
            catch (error)
            {
                if (error.code !== 'ESRCH')
                {
                    throw error;
                }
                alive = false;
            }
        }
        assert.equal(alive, false, `grandchild ${pid} survived sibling failure`);
    });

test('POSIX cancellation fixture refuses absent, malformed and dead readiness instead of injecting exit 7',
    { skip: process.platform === 'win32' }, async (context) =>
    {
        for (const value of [null, '', 'NaN', '-1', '0', '1.5', '123x'])
        {
            await context.test(`readiness ${JSON.stringify(value)}`, (childContext) =>
            {
                const root = fixtureRoot(childContext);
                const pidFile = path.join(root, 'grandchild.pid');
                if (value !== null)
                {
                    fs.writeFileSync(pidFile, value);
                }
                const file = path.join(root, 'fail.mjs');
                fs.writeFileSync(file, posixCancellationFailureSource({ pidFile, startupTimeoutMs: 100 }));
                const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 2000 });
                assert.equal(result.error, undefined);
                assert.equal(result.status, 8, result.stderr);
                assert.match(result.stderr, /fixture readiness refused/u);
            });
        }
        await context.test('dead grandchild', (childContext) =>
        {
            const root = fixtureRoot(childContext);
            const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
            assert.equal(child.status, 0);
            const pidFile = path.join(root, 'grandchild.pid');
            fs.writeFileSync(pidFile, String(child.pid));
            const file = path.join(root, 'fail.mjs');
            fs.writeFileSync(file, posixCancellationFailureSource({ pidFile, startupTimeoutMs: 100 }));
            const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 2000 });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 8, result.stderr);
            assert.match(result.stderr, /fixture readiness refused/u);
        });
    });

test('sealed scheduler CLI fixture rejects missing finalizer and executable drift before child spawn', (t) =>
{
    const temp = createTempDir('scheduler-sealed-boundary');
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const runner = createRunnerFixture(temp);
    const marker = path.join(temp, 'marker.txt');
    const script = path.join(temp, 'tools/fixtures/marker.mjs');
    const matrix = path.join(temp, 'matrix.yml');
    fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`);
    fs.writeFileSync(matrix, [
        'version: fsusblog-test-matrix-v2',
        'tiers:',
        '  - id: backend-unit',
        '    command: node tools/fixtures/marker.mjs',
        '    executionDependsOn: []',
        '    ciJob: fixture'
    ].join('\n'));
    sealRunnerFixture(temp, matrix);
    const run = () => spawnSync(process.execPath, [runner, 'run', 'backend-unit', '--fresh'], {
        cwd: temp,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrix }
    });
    const finalizer = path.join(temp, 'tools/test/lanes/release-final.sh');
    const finalizerBytes = fs.readFileSync(finalizer);
    fs.rmSync(finalizer);
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT.*release-final\.sh/u);
    assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(finalizer, finalizerBytes);
    fs.appendFileSync(script, '// executable drift after fixture sealing\n');
    const drifted = run();
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /working-tree bytes differ from the repository index/u);
    assert.equal(fs.existsSync(marker), false);
});

function assertReleaseFinalSourceRefusal(t, linked)
{
    const source = createTempDir('scheduler-release-final-source');
    const fixture = createTempDir('scheduler-release-final-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, source);
    const relative = 'tools/test/lanes/release-final.sh';
    const asset = path.join(source, relative);
    const bytes = fs.readFileSync(asset);
    materializeTestMatrixRunner(source, fixture);
    fs.rmSync(asset);
    if (linked)
    {
        fs.symlinkSync(path.join(fixture, relative), asset);
    }
    for (let attempt = 0; attempt < 2; attempt += 1)
    {
        assert.throws(() => materializeTestMatrixRunner(source, fixture), linked
            ? /runtime asset must be a literal regular file.*release-final\.sh/u
            : /runtime asset is missing.*release-final\.sh/u);
        assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes);
    }
    if (linked)
    {
        fs.rmSync(asset);
    }
    fs.writeFileSync(asset, bytes);
    materializeTestMatrixRunner(source, fixture);
    assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), bytes);
}

test('original runner refuses missing release-final source despite an existing fixture copy', (t) =>
{
    assertReleaseFinalSourceRefusal(t, false);
});

test('original runner refuses linked release-final source despite an existing fixture copy', (t) =>
{
    assertReleaseFinalSourceRefusal(t, true);
});

test('original runner provisions the locked schema validator and preserves real schema refusals', (t) =>
{
    const fixture = createTempDir('scheduler-locked-validator');
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, fixture);
    const validator = pathToFileURL(path.join(fixture, 'tools/test-matrix/schema-validator/validate.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', [
        `const { validateJsonSchema } = await import(${JSON.stringify(validator)});`,
        "const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false };",
        'console.log(JSON.stringify([validateJsonSchema({count: 1}, schema), validateJsonSchema({}, schema), validateJsonSchema({count: 0}, schema)]));'
    ].join('\n')], { cwd: fixture, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    assert.equal(child.status, 0, child.stderr);
    const [positive, missing, invalid] = JSON.parse(child.stdout);
    assert.deepEqual(positive, []);
    assert.ok(missing.some((message) => message.includes('required')));
    assert.ok(invalid.some((message) => message.includes('>= 1')));
    for (const file of ['package.json', 'package-lock.json'])
    {
        const relative = path.join('tools/test-matrix/schema-validator', file);
        assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), fs.readFileSync(path.join(root, relative)));
    }
});

test('locked validator provisioning refuses cold or corrupt caches without adopting existing dependencies', (t) =>
{
    const fixture = createTempDir('scheduler-validator-cache');
    const cache = createTempDir('scheduler-validator-empty-cache');
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, fixture);
    const directory = path.join(fixture, 'tools/test-matrix/schema-validator');
    const entry = path.join(directory, 'node_modules/ajv/dist/2020.js');
    const bytes = fs.readFileSync(entry);
    assert.throws(() => provisionLockedSchemaValidator(fixture, { npmCache: cache }), /locked dependency provisioning failed/u);
    assert.deepEqual(fs.readFileSync(entry), bytes);
    assert.ok(!fs.readdirSync(directory).some((name) => name.startsWith('.fixture-npm-')));
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
    const integrity = lock.packages['node_modules/ajv'].integrity;
    const digest = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
    const tarball = path.join(cache, '_cacache/content-v2/sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
    fs.mkdirSync(path.dirname(tarball), { recursive: true });
    fs.writeFileSync(tarball, 'corrupted archive');
    assert.throws(() => provisionLockedSchemaValidator(fixture, { npmCache: cache }), (error) =>
    {
        assert.match(error.message, /locked dependency provisioning failed/u);
        assert.match(String(error.cause?.stderr), /integrity|checksum/iu);
        return true;
    });
    assert.deepEqual(fs.readFileSync(entry), bytes);
    assert.ok(!fs.readdirSync(directory).some((name) => name.startsWith('.fixture-npm-')));
    provisionLockedSchemaValidator(fixture);
    assert.deepEqual(fs.readFileSync(entry), bytes);
});

test('locked validator provisioning refuses linked destination bytes without touching outside files', (t) =>
{
    const fixture = createTempDir('scheduler-validator-destination');
    const outside = createTempDir('scheduler-validator-outside');
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, fixture);
    const sentinel = path.join(outside, 'sentinel.js');
    fs.writeFileSync(sentinel, 'sentinel');
    const entry = path.join(fixture, 'tools/test-matrix/schema-validator/node_modules/ajv/dist/2020.js');
    fs.rmSync(entry);
    fs.symlinkSync(sentinel, entry);
    assert.throws(() => provisionLockedSchemaValidator(fixture), /dependency must be literal/u);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel');
    fs.rmSync(entry);
    const modules = path.join(fixture, 'tools/test-matrix/schema-validator/node_modules');
    fs.rmSync(modules, { recursive: true });
    fs.symlinkSync(outside, modules);
    assert.throws(() => provisionLockedSchemaValidator(fixture), /dependency must be literal/u);
    assert.deepEqual(fs.readdirSync(outside), ['sentinel.js']);
});

test('original runner refuses missing or linked validator locks before provisioning', (t) =>
{
    const source = createTempDir('scheduler-validator-lock-source');
    const fixture = createTempDir('scheduler-validator-lock-target');
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, source);
    const relative = 'tools/test-matrix/schema-validator/package-lock.json';
    const file = path.join(source, relative);
    fs.rmSync(file);
    assert.throws(() => materializeTestMatrixRunner(source, fixture), /runtime asset is missing.*package-lock/u);
    fs.symlinkSync(path.join(root, relative), file);
    assert.throws(() => materializeTestMatrixRunner(source, fixture), /runtime asset must be a literal regular file.*package-lock/u);
    assert.equal(fs.existsSync(path.join(fixture, relative)), false);
    assert.throws(() => materializeTestMatrixRunner(root, root), /isolated from its source repository/u);
});

test('original runner binds installed validator bytes to its fixture admission source seal', (t) =>
{
    const fixture = createTempDir('scheduler-validator-source-seal');
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet'], { cwd: fixture });
    fs.writeFileSync(path.join(fixture, '.gitignore'), '**/node_modules/\n');
    materializeTestMatrixRunner(root, fixture);
    const relative = 'tools/test-matrix/schema-validator/node_modules/ajv/dist/2020.js';
    assert.ok(execFileSync('git', ['ls-files', '--', relative], { cwd: fixture, encoding: 'utf8' }).includes(relative));
    commitRunnerFixture(fixture, path.join(fixture, 'tools/run-test-matrix.mjs'));
    const before = sealSourceIdentity(fixture);
    const admission = createBehaviorDocAdmissionFixture({ sourceRepositoryRoot: root, repositoryRoot: fixture });
    const receipt = JSON.parse(fs.readFileSync(admission.receiptFile, 'utf8'));
    assert.doesNotThrow(() => validateBehaviorDocStaticAdmissionReceipt(receipt, {
        expectedRunId: admission.runId,
        expectedSourceIdentity: before,
        expectedWorktree: fixture
    }));
    fs.appendFileSync(path.join(fixture, relative), '\n// validator byte drift after admission\n');
    const after = sealSourceIdentity(fixture);
    assert.notEqual(before.worktreeFingerprint, after.worktreeFingerprint);
    assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(receipt, {
        expectedRunId: admission.runId,
        expectedSourceIdentity: after,
        expectedWorktree: fixture
    }), /source\/worktree identity mismatch/u);
});
