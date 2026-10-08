import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, URL } from 'node:url';

import { validateCoverageExecutionRequest } from './atomic-coverage-compiler-bridge.mjs';
import { prepareCoverageProducer, validateCoverageSummary } from './atomic-coverage-inputs.mjs';
import { readCoverageBytes, requireCoverage } from './atomic-coverage-plan.mjs';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const { validateReplayPlan } = await import(new URL('../test/execution-replay-contract.mjs', import.meta.url));
const { verifyExecutionReplay } = await import(new URL('../test/execution-replay-verifier.mjs', import.meta.url));

/** Load only deterministic completed attempt locations, never a directory scan or latest selector. */
export function loadCoverageAttemptMaterial(root, request, producerId)
{
    const base = `${request.evidenceRoot}/${request.plan.identity.runId}/${producerId}/attempt-1`;
    const snapshot = JSON.parse(readCoverageBytes(root, `${base}/coverage-material.json`));
    requireCoverage(Object.keys(snapshot).join(',') === 'artifacts', 'invalid captured coverage roster');
    const receiptPath = `${base}/receipt.json`;
    return { attemptRef: { path: receiptPath, digest: sha256(readCoverageBytes(root, receiptPath)) }, artifacts: snapshot.artifacts };
}

function writeSidecar(file, failureKind, artifactPaths, executedTestIds = [], failedTestIds = [])
{
    fs.writeFileSync(file, `${JSON.stringify({ schema: 'fsusblog.test-attempt-result.v1',
        failureClass: failureKind === null ? null : 'product', failureKind,
        executedTestIds, failedTestIds, artifactPaths: [...artifactPaths].sort() }, null, 4)}\n`);
}

function observeCollection(request, replay, root)
{
    if (!['coverage-backend', 'coverage-frontend'].includes(request.producerId))
    {
        requireCoverage(replay.testEnumerationOrder.length === 0, 'scope/merge/threshold action must not claim test executions');
        return { executedTestIds: [], failedTestIds: [], snapshots: [] };
    }
    if (request.collectionExecution === null)
    {
        requireCoverage(replay.run.mode === 'diagnostic' && replay.testEnumerationOrder.length === 0,
            'native collection execution receipt unavailable; never copy planned test IDs into result');
        return { executedTestIds: [], failedTestIds: [], snapshots: [] };
    }
    const native = request.collectionExecution;
    requireCoverage(Object.keys(native).sort().join(',') === 'frameworkActualsPath,receiptPath', 'exact original native receipt/actuals paths required');
    const receiptBytes = readCoverageBytes(root, native.receiptPath);
    const actualsBytes = readCoverageBytes(root, native.frameworkActualsPath);
    const receipt = JSON.parse(receiptBytes);
    const frameworkActuals = JSON.parse(actualsBytes);
    verifyExecutionReplay({ plan: replay, receipt, frameworkActuals });
    return { executedTestIds: receipt.testIds, failedTestIds: [], snapshots: [
        { path: 'native-execution-receipt.json', bytes: receiptBytes },
        { path: 'native-execution-actuals.json', bytes: actualsBytes }
    ] };
}

/** One unchanged physical coverage action inside the existing first-and-only attempt. */
export async function runCoverageAction(requestPath, { root = process.cwd(), env = process.env } = {})
{
    const bytes = readCoverageBytes(root, requestPath);
    const request = validateCoverageExecutionRequest(JSON.parse(bytes), root);
    requireCoverage(request.requestPath === requestPath, 'wrong explicit action request path');
    const producer = request.plan.producers.find((item) => item.id === request.producerId);
    const expectedAttemptRoot = path.resolve(root, request.evidenceRoot, request.plan.identity.runId, producer.id, 'attempt-1');
    requireCoverage(env.FSUSBLOG_ATTEMPT_NUMBER === '1' && env.FSUSBLOG_ATTEMPT_ARTIFACT_ROOT === expectedAttemptRoot
        && env.FSUSBLOG_ATTEMPT_RESULT_PATH === path.join(expectedAttemptRoot, 'result.json'), 'original attempt owner context missing/mismatched');
    const artifacts = ['coverage-request.json', 'coverage-launch.json'];
    fs.writeFileSync(path.join(expectedAttemptRoot, artifacts[0]), bytes, { flag: 'wx', mode: 0o444 });
    let spawned = false;
    try
    {
        const verifier = await import(pathToFileURL(path.resolve(root, request.authorityVerifier.path)).href);
        requireCoverage(typeof verifier[request.authorityVerifier.exportName] === 'function', 'independent authority verifier unavailable');
        const verifyAuthority = (reference) => verifier[request.authorityVerifier.exportName](reference, {
            root, identity: request.plan.identity, producerId: reference.kind === 'replay-plan'
                ? JSON.parse(readCoverageBytes(root, reference.artifactPath)).producer.id : null
        });
        const inputs = Object.fromEntries(producer.dependsOn.map((id) => [id, loadCoverageAttemptMaterial(root, request, id)]));
        const prepared = prepareCoverageProducer({ root, plan: request.plan, producerId: producer.id, inputs, verifyAuthority });
        const replayBytes = readCoverageBytes(root, request.replayPlanPath);
        const replay = validateReplayPlan(JSON.parse(replayBytes));
        fs.writeFileSync(path.join(expectedAttemptRoot, 'coverage-replay.json'), replayBytes, { flag: 'wx', mode: 0o444 });
        artifacts.push('coverage-replay.json');
        requireCoverage(replay.producer.id === producer.id && replay.run.id === request.plan.identity.runId
            && replay.source.commit === request.plan.identity.sourceCommit
            && replay.source.worktreeFingerprint === request.plan.identity.sourceFingerprint, 'action replay crosses identity');
        writeSidecar(env.FSUSBLOG_ATTEMPT_RESULT_PATH, 'coverage-action-incomplete', artifacts);
        const code = await new Promise((resolve, reject) =>
        {
            const child = spawn(prepared.command[0], prepared.command.slice(1), { cwd: root, env, stdio: 'inherit' });
            child.once('spawn', () =>
            {
                spawned = true;
                const launch = sealContentDigest({ producerId: producer.id, identity: request.plan.identity,
                    planDigest: request.plan.contentDigest, requestDigest: request.contentDigest,
                    physicalSpawnCount: 1, processId: child.pid, commandDigest: digestCanonical(prepared.command), inputRefs: prepared.inputRefs });
                fs.writeFileSync(path.join(expectedAttemptRoot, 'coverage-launch.json'), `${JSON.stringify(launch, null, 4)}\n`, { flag: 'wx', mode: 0o444 });
            });
            child.once('error', reject);
            child.once('close', (exitCode, signal) => resolve(signal === null && Number.isInteger(exitCode) ? exitCode : 1));
        });
        if (code !== 0)
        {
            writeSidecar(env.FSUSBLOG_ATTEMPT_RESULT_PATH, 'coverage-command-exit-nonzero', artifacts);
            return code;
        }
        const observed = observeCollection(request, replay, root);
        const summaryOutput = producer.outputs.find((item) => item.role === 'summary');
        if (summaryOutput)
        {
            validateCoverageSummary(JSON.parse(readCoverageBytes(root, summaryOutput.path)), producer.id.slice('coverage-'.length), request.plan.identity);
        }
        for (const snapshot of observed.snapshots)
        {
            fs.writeFileSync(path.join(expectedAttemptRoot, snapshot.path), snapshot.bytes, { flag: 'wx', mode: 0o444 });
            artifacts.push(snapshot.path);
        }
        const snapshots = producer.outputs.map((output) =>
        {
            const outputBytes = readCoverageBytes(root, output.path);
            const attemptPath = `outputs/${output.role}`;
            fs.mkdirSync(path.join(expectedAttemptRoot, 'outputs'), { recursive: true });
            fs.writeFileSync(path.join(expectedAttemptRoot, attemptPath), outputBytes, { flag: 'wx', mode: 0o444 });
            artifacts.push(attemptPath);
            return { ...output, digest: sha256(outputBytes), attemptPath };
        });
        fs.writeFileSync(path.join(expectedAttemptRoot, 'coverage-material.json'), `${JSON.stringify({ artifacts: snapshots }, null, 4)}\n`, { flag: 'wx', mode: 0o444 });
        artifacts.push('coverage-material.json');
        writeSidecar(env.FSUSBLOG_ATTEMPT_RESULT_PATH, null, artifacts, observed.executedTestIds, observed.failedTestIds);
        return 0;
    }
    catch (error)
    {
        if (!spawned)
        {
            const launch = sealContentDigest({ producerId: producer.id, identity: request.plan.identity,
                planDigest: request.plan.contentDigest, requestDigest: request.contentDigest,
                physicalSpawnCount: 0, processId: null, reason: error.message });
            fs.writeFileSync(path.join(expectedAttemptRoot, 'coverage-launch.json'), `${JSON.stringify(launch, null, 4)}\n`, { flag: 'wx', mode: 0o444 });
        }
        writeSidecar(env.FSUSBLOG_ATTEMPT_RESULT_PATH, 'coverage-input-or-output-refused', artifacts);
        console.error(error.stack ?? String(error));
        return 1;
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    try
    {
        process.exitCode = await runCoverageAction(process.argv[2]);
    }
    catch (error)
    {
        console.error(error.stack ?? String(error));
        process.exitCode = 1;
    }
}
