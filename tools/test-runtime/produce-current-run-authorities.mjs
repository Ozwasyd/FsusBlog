#!/usr/bin/env node
/* eslint-disable import-x/no-relative-parent-imports -- This producer composes canonical build and evidence authorities. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { verifyProductionBuildReceipt } from '../ci/production-build-artifacts.mjs';
import {
    bindProductionBuildLayoutSource,
    finalizeProductionBuildLayout,
    prepareProductionBuildLayout,
    productionBuildEnvironment
} from '../test-matrix/production-build-layout.mjs';
import { publishRunBoundMarker, readRunBoundMarker } from '../test-matrix/run-bound-marker.mjs';
import {
    acquireSchedulerRunLock,
    schedulerCandidateIdentityDigest
} from '../test-matrix/scheduler-run-owner.mjs';

import {
    productionBuildLayoutBinding,
    publishBackendBuildReadyAuthority,
    publishFrontendBuildReadyAuthority
} from './production-build-ready-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function option(name, fallback = null)
{
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
}

function required(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} is required`);
    }
    return normalized;
}

function run(command, args, env)
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', (code, signal) =>
        {
            if (code === 0 && !signal)
            {
                resolve();
                return;
            }
            reject(new Error(`${command} failed code=${code ?? 'null'} signal=${signal ?? 'none'}`));
        });
    });
}

function removeExactOutput(outputRoot)
{
    if (fs.existsSync(outputRoot))
    {
        fs.rmSync(outputRoot, { recursive: true, force: true });
    }
}

async function produceBuildAuthorities({ runId, attemptId, sourceState })
{
    const namespace = `runtime-order-authority:${runId}`;
    const targetTierId = 'runtime-order-authority-producer';
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({
        runId,
        targetTierId,
        namespace,
        sourceState,
        budgetPolicyDigest: null
    });
    const scheduler = acquireSchedulerRunLock({
        runsRoot: path.join(root, '.tmp', 'test-runs'),
        runId,
        candidateIdentityDigest,
        targetTierId
    });
    let layout;
    let terminal = 'failed';
    try
    {
        layout = prepareProductionBuildLayout({ root, runId, sourceState, namespace, fresh: true });
        scheduler.markRunning();
        bindProductionBuildLayoutSource(layout, sourceState);
        const outputRoot = path.join(root, '.tmp', 'runtime-order-authorities', runId, attemptId);
        removeExactOutput(outputRoot);
        const artifactRoot = path.join(outputRoot, 'artifacts', 'production-build');
        const env = productionBuildEnvironment(layout, {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID: attemptId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: artifactRoot,
            FSUSBLOG_CI_PRODUCTION_REUSE_BUILD_OUTPUTS: '1',
            FSUSBLOG_CI_PRODUCTION_BUILD_DOMAINS:
                'backend-runtime,test-runtime,frontend-dist,wasm,generated-contracts',
            FSUSBLOG_FRONTEND_BUILD_STAGE_RECEIPT: path.join(layout.generatedRoot, 'frontend-build-stages.json'),
            FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC: '1'
        });
        await run(path.join(root, 'tools', 'test', 'run-with-dotnet-release-build-lock.sh'), [
            path.join(root, 'tools', 'build-with-data-env.sh'),
            'dotnet', 'restore', path.join(root, 'FsusBlog.slnx'), '-v', 'minimal', '/p:NuGetAudit=false'
        ], env);
        await run(path.join(root, 'tools', 'test', 'run-with-dotnet-release-build-lock.sh'), [
            path.join(root, 'tools', 'build-with-data-env.sh'),
            'dotnet', 'build', path.join(root, 'src/backend/FsusBlog.Server.csproj'),
            '-c', 'Release', '--no-restore', '--no-incremental', '-warnaserror', '-v', 'minimal', '/p:NuGetAudit=false'
        ], env);
        await run(path.join(root, 'tools', 'test', 'run-with-dotnet-release-build-lock.sh'), [
            path.join(root, 'tools', 'build-with-data-env.sh'),
            'dotnet', 'build', path.join(root, 'tests/backend/FsusBlog.Server.Tests.csproj'),
            '-c', 'Release', '--no-restore', '--no-dependencies', '--no-incremental',
            '-warnaserror', '-v', 'minimal', '/p:NuGetAudit=false'
        ], env);
        await run('npm', ['--prefix', path.join(root, 'src/frontend'), 'run', 'build:release'], env);
        fs.rmSync(layout.backendWebRoot, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(layout.backendWebRoot), { recursive: true });
        fs.cpSync(layout.frontendDist, layout.backendWebRoot, { recursive: true, preserveTimestamps: true });
        await run('bash', [path.join(root, 'tools/test/lanes/production-build-artifacts.sh')], env);
        scheduler.markFinalizing();
        finalizeProductionBuildLayout(layout, { status: 'success' });

        Object.assign(process.env, env);
        const { createFrontendBuildStages } = await import('../frontend/build.mjs');
        const expectedStages = createFrontendBuildStages([], 'generate', {
            frontendRoot: path.join(root, 'src', 'frontend'),
            env
        });
        const ownedOutputs = new Set(expectedStages.flatMap((stage) => stage.ownedOutputs));
        const criticalOutputPaths = [
            path.join(layout.frontendDist, 'index.html'),
            path.join(layout.frontendDist, 'server', 'public-shell-emergency.css'),
            path.join(layout.frontendDist, 'wasm'),
            path.join(layout.frontendDist, 'assets', 'fsus-spa-entry.js'),
            path.join(layout.frontendDist, 'dist'),
            path.join(layout.frontendWasm, 'wasm-manifest.aeds'),
            path.join(layout.frontendWasm, 'aeds-runtime-manifest.json'),
            layout.backendWebRoot
        ].filter((candidate) => ownedOutputs.has(candidate));
        publishBackendBuildReadyAuthority({ root, layout, sourceState });
        publishFrontendBuildReadyAuthority({
            root,
            layout,
            sourceState,
            expectedStages,
            criticalOutputPaths,
            stageReceiptFile: env.FSUSBLOG_FRONTEND_BUILD_STAGE_RECEIPT
        });
        const { receipt } = verifyProductionBuildReceipt({
            artifactRoot,
            expectedSourceState: sourceState,
            expectedProducer: { runId, job: 'production-build-artifacts' },
            repairReadOnlySeal: false
        });
        const bindings = {
            attemptId,
            buildLayout: productionBuildLayoutBinding({ root, layout, sourceState }),
            receipt: {
                path: path.relative(root, path.join(artifactRoot, 'receipt.json')).replaceAll(path.sep, '/'),
                contentDigest: receipt.contentDigest
            },
            producer: receipt.producer
        };
        const markerFile = path.join(root, '.tmp', 'test-runs', runId, 'production-build-artifacts-ready.json');
        const expectedMarker = {
            root,
            markerId: 'production-build-artifacts-ready',
            runId,
            sourceState,
            producerBundleId: 'build-static',
            producerStepId: 'production-build-artifacts',
            artifacts: [path.join(artifactRoot, 'receipt.json')],
            bindings
        };
        publishRunBoundMarker({ file: markerFile, ...expectedMarker });
        readRunBoundMarker(markerFile, expectedMarker);
        terminal = 'complete';
        return { outputRoot, artifactRoot, receipt, markerFile };
    }
    catch (error)
    {
        if (layout)
        {
            try
            {
                finalizeProductionBuildLayout(layout, { status: 'failure' });
            }
            catch (finalizeError)
            {
                throw new AggregateError([error, finalizeError], 'authority production and build finalization failed');
            }
        }
        throw error;
    }
    finally
    {
        scheduler.finalize(terminal);
    }
}

async function main()
{
    const runId = required(option('--run-id', process.env.FSUSBLOG_TEST_RUN_ID), '--run-id');
    const attemptId = required(option('--attempt-id', process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? 'authority-0001'), '--attempt-id');
    const sourceState = {
        commit: required(process.env.FSUSBLOG_TEST_SOURCE_COMMIT, 'FSUSBLOG_TEST_SOURCE_COMMIT'),
        worktreeFingerprint: required(
            process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT,
            'FSUSBLOG_TEST_SOURCE_FINGERPRINT'
        )
    };
    const build = await produceBuildAuthorities({ runId, attemptId, sourceState });
    console.log(`[runtime-order-authorities] build receipt=${path.relative(root, path.join(build.artifactRoot, 'receipt.json'))}`);
}

main().catch((error) =>
{
    console.error(`[runtime-order-authorities] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
});
