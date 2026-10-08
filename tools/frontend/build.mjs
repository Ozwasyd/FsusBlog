#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    runFrontendBuildStageDag
} from './build-stage-dag.mjs';

const [
    { localFsusUiConsumptionDisabled, resolveLocalFsusUiRepositoryRoot },
    { resolveMachineExecutionTimeoutMs },
    { resolveManifestLiveCapacity },
    { createReleaseIdentitySnapshot, parseReleaseId },
    { parseMatrix }
] = await Promise.all([
    import(new URL('../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)),
    import(new URL('../test/bundles/bundle-steps.mjs', import.meta.url)),
    import(new URL('../test/run-command-manifest.mjs', import.meta.url)),
    import(new URL('../release/release-id.mjs', import.meta.url)),
    import(new URL('../test-matrix/parse-matrix.mjs', import.meta.url))
]);

export { resolveStageEnvironment } from './build-stage-dag.mjs';

export function resolveProductionFrontendBuildEnv(env = process.env)
{
    const frontendBuildId = env.VITE_FSUSBLOG_BUILD_ID?.trim() || '';
    const runtimeReleaseId = env.FSUSBLOG_RELEASE_ID?.trim() || '';
    if (frontendBuildId && runtimeReleaseId && frontendBuildId !== runtimeReleaseId)
    {
        throw new Error('production frontend build identity does not match the sealed runtime release identity');
    }
    if (frontendBuildId)
    {
        return env;
    }
    const commitSha = String(
        env.FSUSBLOG_TEST_SOURCE_COMMIT
        || spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        }).stdout
        || ''
    ).trim();
    if (!/^[0-9a-f]{40}$/u.test(commitSha))
    {
        return env;
    }
    if (runtimeReleaseId)
    {
        const parsedRuntimeRelease = parseReleaseId(runtimeReleaseId);
        if (!parsedRuntimeRelease)
        {
            throw new Error('sealed runtime release identity is invalid');
        }
        if (!commitSha.startsWith(parsedRuntimeRelease.commitShaPrefix))
        {
            throw new Error('sealed runtime release identity does not match the frontend source commit');
        }
        return {
            ...env,
            VITE_FSUSBLOG_BUILD_ID: runtimeReleaseId
        };
    }
    const identity = createReleaseIdentitySnapshot({
        commitSha,
        createdAtUtc: env.FSUSBLOG_RELEASE_CREATED_AT_UTC || new Date()
    });
    return {
        ...env,
        VITE_FSUSBLOG_BUILD_ID: identity.releaseId
    };
}

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const clientRoot = join(repositoryRoot, 'src', 'frontend');
const ensureWasmScript = fileURLToPath(new URL('./ensure-wasm.mjs', import.meta.url));
const generatePublicPageManifestScript = fileURLToPath(new URL('./generate-public-page-manifest.mjs', import.meta.url));
const generatePublicShellEmergencyScript = fileURLToPath(new URL('./generate-public-shell-emergency.mjs', import.meta.url));
const buildPublicSsrBundleScript = fileURLToPath(new URL('./build-public-ssr-bundle.mjs', import.meta.url));
const releaseBrowserArtifactsScript = fileURLToPath(new URL('../storage/create-release-browser-artifacts.mjs', import.meta.url));
const binExtension = process.platform === 'win32' ? '.cmd' : '';
const distRoot = resolve(process.env.FSUSBLOG_FRONTEND_DIST_ROOT || join(clientRoot, 'dist'));
const distAssetsDir = join(distRoot, 'assets');
const publicRoot = join(clientRoot, 'public');
const frontendWasmRoot = resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT || join(publicRoot, 'wasm'));
const backendWebRoot = resolve(process.env.FSUSBLOG_BACKEND_WEBROOT || join(clientRoot, '..', 'backend', 'wwwroot'));
const stableSpaEntryName = 'fsus-spa-entry.js';
const stablePublicBootKernelName = 'fsus-public-boot-kernel.js';
const managedDistEntries = ['.vite', 'assets', 'current-release-assets.js', 'dist', 'favicon.svg', 'generated', 'index.html', 'server', 'sw.js', 'vite.svg', 'wasm'];
// Static `public/` entries the release preview serves itself (vite.config.ts
// proxy exclusions). The run-bound build disables Vite's publicDir copy, so
// sync-run-bound-public-assets must re-assemble them into the shared dist root.
const runBoundPublicAssets = ['favicon', 'fixtures', 'generated', 'manifest.webmanifest', 'public-shell-emergency.css', 'social', 'sw.js'];
const fsusUiMarkdownRuntimeAssets = [
    'markdown_simd.js',
    'markdown_simd.wasm',
    'markdown_basic.js',
    'markdown_basic.wasm'
];

function fsusUiMarkdownRuntimeSourceDir({
    root = clientRoot,
    repository = repositoryRoot,
    env = process.env
} = {})
{
    const localRoot = localFsusUiConsumptionDisabled(env)
        ? null
        : resolveLocalFsusUiRepositoryRoot({
            override: env.FSUSBLOG_LOCAL_FSUSUI_ROOT,
            repositoryRoot: repository
        });
    return localRoot
        ? join(localRoot, 'vue', 'packages', 'wasm', 'dist')
        : join(root, 'node_modules', '@ozwasyd', 'element-plus', 'es', 'wasm', 'dist');
}

const inheritedDeadlineMs = positiveNumber(
    process.env.FSUSBLOG_STEP_DEADLINE_MS
    ?? process.env.FSUSBLOG_BUNDLE_DEADLINE_MS);
const configuredTimeoutMs = positiveNumber(process.env.FSUSBLOG_BUILD_TIMEOUT_MS);
const productionProfile = parseMatrix(fs.readFileSync(join(repositoryRoot, 'tests/matrix.yml'), 'utf8')).localProfiles?.production;
const directBuildBundle = productionProfile?.bundles?.find((entry) => entry.id === 'build-static');
if (!Number.isFinite(productionProfile?.budgetMs) || !directBuildBundle)
{
    throw new Error('production build-static machine budget is unavailable');
}
const directBuildDeadlineMs = resolveFrontendBuildDeadline({
    env: process.env,
    baseTimeoutMs: productionProfile.budgetMs,
    workload: directBuildBundle
});
const buildDeadlineMs = inheritedDeadlineMs ?? directBuildDeadlineMs;
const buildStartedAt = Date.now();

export function resolveFrontendBuildCapacity({
    env = process.env,
    availableCpu = os.availableParallelism?.() ?? os.cpus().length,
    freeMemoryGiB = os.freemem() / (1024 ** 3)
} = {})
{
    const detectedCpu = requiredPositiveNumber(availableCpu, 'available CPU');
    const detectedMemoryGiB = requiredPositiveNumber(freeMemoryGiB, 'available memory');
    const inheritedCpu = optionalPositiveNumber(env, [
        'FSUSBLOG_STEP_CPU_BUDGET',
        'FSUSBLOG_BUNDLE_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_BUDGET'
    ]);
    const inheritedMemoryGiB = optionalPositiveNumber(env, [
        'FSUSBLOG_STEP_MEMORY_GIB',
        'FSUSBLOG_BUNDLE_MEMORY_GIB'
    ]);
    const cpuUnits = Math.min(detectedCpu, inheritedCpu ?? detectedCpu);
    const memoryGiB = Math.min(detectedMemoryGiB, inheritedMemoryGiB ?? detectedMemoryGiB);
    return {
        cpuUnits,
        memoryGiB,
        maxParallel: Math.max(1, Math.floor(cpuUnits))
    };
}

export function resolveFrontendBuildDeadline({
    env = process.env,
    baseTimeoutMs = productionProfile?.budgetMs,
    workload = directBuildBundle,
    actualCapacity = resolveManifestLiveCapacity({
        env,
        workload: 'scheduler-admitted',
        orchestrationMemoryGiBPerWorker: 0.25
    })
} = {})
{
    const inherited = positiveNumber(
        env.FSUSBLOG_STEP_DEADLINE_MS
        ?? env.FSUSBLOG_BUNDLE_DEADLINE_MS
    );
    if (inherited !== null)
    {
        return inherited;
    }
    return resolveMachineExecutionTimeoutMs({
        baseTimeoutMs,
        workload,
        actualCapacity
    });
}

export function resolveConcurrentStageResources(stageCount, capacity)
{
    if (!Number.isInteger(stageCount) || stageCount <= 0)
    {
        throw new Error('stage count must be a positive integer');
    }
    const cpuUnits = requiredPositiveNumber(capacity?.cpuUnits, 'frontend build CPU grant');
    const memoryGiB = requiredPositiveNumber(capacity?.memoryGiB, 'frontend build memory grant');
    const integralCpuUnits = Math.max(1, Math.floor(cpuUnits));
    if (integralCpuUnits < stageCount)
    {
        return {
            concurrent: false,
            stages: Array.from({ length: stageCount }, () => ({
                cpuUnits,
                memoryGiB,
                maxParallel: integralCpuUnits
            }))
        };
    }

    const stageCpuUnits = cpuUnits / stageCount;
    return {
        concurrent: true,
        stages: Array.from({ length: stageCount }, () => ({
            cpuUnits: stageCpuUnits,
            memoryGiB: memoryGiB / stageCount,
            maxParallel: Math.max(1, Math.floor(stageCpuUnits))
        }))
    };
}

function remainingBuildDeadlineMs()
{
    const remaining = buildDeadlineMs - (Date.now() - buildStartedAt);
    if (remaining <= 0)
    {
        const error = new Error(`frontend build exceeded execution deadline of ${buildDeadlineMs}ms`);
        error.code = 'ETIMEDOUT';
        throw error;
    }
    return Math.max(1, Math.floor(remaining));
}

function stageTimeoutMs()
{
    const remaining = remainingBuildDeadlineMs();
    return configuredTimeoutMs === null ? remaining : Math.min(configuredTimeoutMs, remaining);
}
function log(message)
{
    console.log(`[client-build] ${message}`);
}

function runStage(name, command, args, { env = process.env, signal } = {})
{
    return new Promise((resolve, reject) =>
    {
        const timeoutMs = stageTimeoutMs();
        log(`starting ${name}`);
        const useShell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
        const child = spawn(command, args, {
            stdio: ['inherit', 'pipe', 'pipe'],
            env,
            cwd: clientRoot,
            detached: process.platform !== 'win32',
            shell: useShell,
            windowsHide: true
        });
        let settled = false;
        let terminationError = null;
        let escalationTimer = null;
        let forcedSettleTimer = null;

        const signalProcessGroup = (signal) =>
        {
            if (process.platform === 'win32')
            {
                if (child.exitCode === null && child.signalCode === null)
                {
                    child.kill(signal);
                }
                return;
            }
            try
            {
                process.kill(-child.pid, signal);
            }
            catch (error)
            {
                if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null)
                {
                    child.kill(signal);
                }
            }
        };
        const closePipes = () =>
        {
            child.stdout?.destroy();
            child.stderr?.destroy();
        };
        const finish = (error = null) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (escalationTimer !== null)
            {
                clearTimeout(escalationTimer);
            }
            if (forcedSettleTimer !== null)
            {
                clearTimeout(forcedSettleTimer);
            }
            signal?.removeEventListener('abort', abortStage);
            if (error)
            {
                reject(error);
            }
            else
            {
                resolve();
            }
        };

        const terminate = (error) =>
        {
            if (settled || terminationError)
            {
                return;
            }
            terminationError = error;
            signalProcessGroup('SIGTERM');
            const terminationGraceMs = Math.max(100, Math.min(5_000, Math.ceil(timeoutMs * 0.02)));
            escalationTimer = setTimeout(() =>
            {
                signalProcessGroup('SIGKILL');
                closePipes();
                forcedSettleTimer = setTimeout(() => finish(terminationError), Math.max(25, Math.min(250, terminationGraceMs)));
                forcedSettleTimer.unref?.();
            }, terminationGraceMs);
            escalationTimer.unref?.();
        };
        const abortStage = () =>
        {
            const error = signal?.reason instanceof Error ? signal.reason : new Error(`${name} cancelled`);
            terminate(error);
        };

        const forwardOutput = (stream, writer) =>
        {
            let buffered = '';

            stream.on('data', (chunk) =>
            {
                buffered += chunk.toString();
                const lines = buffered.split(/\r?\n/);
                buffered = lines.pop() ?? '';

                for (const line of lines)
                {
                    writer.write(`${line}\n`);
                }
            });

            stream.on('end', () =>
            {
                if (!buffered)
                {
                    return;
                }

                writer.write(buffered);
            });
        };

        if (child.stdout)
        {
            forwardOutput(child.stdout, process.stdout);
        }

        if (child.stderr)
        {
            forwardOutput(child.stderr, process.stderr);
        }

        const timer = setTimeout(() =>
        {
            const timeoutError = new Error(`${name} exceeded remaining execution deadline of ${timeoutMs}ms`);
            timeoutError.code = 'ETIMEDOUT';
            terminate(timeoutError);
        }, timeoutMs);
        timer.unref?.();

        if (signal?.aborted)
        {
            abortStage();
        }
        else
        {
            signal?.addEventListener('abort', abortStage, { once: true });
        }

        child.once('error', (error) =>
        {
            closePipes();
            finish(error);
        });

        child.once('close', (code, childSignal) =>
        {
            if (terminationError)
            {
                finish(terminationError);
                return;
            }
            if (code === 0)
            {
                log(`finished ${name}`);
                finish();
                return;
            }

            const exitReason = childSignal ? `signal ${childSignal}` : `exit code ${code}`;
            finish(new Error(`${name} failed with ${exitReason}`));
        });
    });
}

async function syncStableSpaEntryAlias()
{
    const assetFiles = await readdir(distAssetsDir, { withFileTypes: true });
    const entryCandidates = assetFiles
        .filter((entry) => entry.isFile() && /^index-[A-Za-z0-9_-]+\.js$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort();

    if (entryCandidates.length === 0)
    {
        throw new Error('stable spa entry alias sync failed: missing built index-*.js asset');
    }

    const stableEntry = join(distAssetsDir, stableSpaEntryName);

    await mkdir(distAssetsDir, { recursive: true });
    await rm(stableEntry, { force: true });
    await writeFile(stableEntry, renderStableSpaEntryAlias(entryCandidates[0]), 'utf8');
    log(`synced stable spa entry alias ${stableSpaEntryName} -> ${entryCandidates[0]}`);
}

async function syncStablePublicBootKernelAlias()
{
    const assetFiles = await readdir(distAssetsDir, { withFileTypes: true });
    const entry = assetFiles
        .filter((candidate) => candidate.isFile() && /^publicBootKernel-[A-Za-z0-9_-]+\.js$/iu.test(candidate.name))
        .map((candidate) => candidate.name)
        .sort()[0];
    if (!entry)
    {
        throw new Error('stable public boot kernel alias sync failed: missing built publicBootKernel asset');
    }
    await writeFile(join(distAssetsDir, stablePublicBootKernelName), renderStablePublicBootKernelAlias(entry), 'utf8');
    log(`synced stable public boot kernel alias ${stablePublicBootKernelName} -> ${entry}`);
}

export function renderStableSpaEntryAlias(entryName)
{
    if (!/^index-[A-Za-z0-9_-]+\.js$/iu.test(entryName))
    {
        throw new Error(`stable spa entry alias target is invalid: ${String(entryName)}`);
    }

    // Copying the entry chunk gives it a second module URL. Circular imports from
    // split chunks then evaluate both URLs, duplicating application bootstrap and
    // module-private Trusted Types policy creation. Keep the stable URL as a tiny
    // redirect module so the hashed entry remains the single module identity.
    return `import './${entryName}';\n`;
}

export function renderStablePublicBootKernelAlias(entryName)
{
    if (!/^publicBootKernel-[A-Za-z0-9_-]+\.js$/iu.test(entryName))
    {
        throw new Error(`stable public boot kernel alias target is invalid: ${String(entryName)}`);
    }
    return `import './${entryName}';\n`;
}

async function syncFsusUiMarkdownRuntimeAssets()
{
    const sourceDir = fsusUiMarkdownRuntimeSourceDir();
    const targetDir = join(distRoot, 'dist');

    await mkdir(targetDir, { recursive: true });

    for (const fileName of fsusUiMarkdownRuntimeAssets)
    {
        const sourcePath = join(sourceDir, fileName);
        if (!(await pathExists(sourcePath)))
        {
            throw new Error(`FsusUI markdown runtime asset missing: ${sourcePath}`);
        }
        await copyFile(sourcePath, join(targetDir, fileName));
    }

    log(`synced FsusUI markdown runtime assets into ${targetDir}`);
}

async function syncRunBoundPublicAssets()
{
    if (!process.env.FSUSBLOG_FRONTEND_DIST_ROOT)
    {
        return;
    }
    await mkdir(distRoot, { recursive: true });
    const publicAssets = resolveReleaseBrowserBuildTrust()
        ? [...runBoundPublicAssets, 'current-release-assets.js']
        : runBoundPublicAssets;
    for (const entryName of publicAssets)
    {
        const sourcePath = join(publicRoot, entryName);
        if (!(await pathExists(sourcePath)))
        {
            throw new Error(`run-bound public asset missing: ${sourcePath}`);
        }
        await cp(sourcePath, join(distRoot, entryName), { recursive: true, force: true });
    }
    await rm(join(distRoot, 'wasm'), { recursive: true, force: true });
    await cp(frontendWasmRoot, join(distRoot, 'wasm'), { recursive: true, force: true });
    log(`assembled run-bound public assets into ${distRoot}`);
}

async function pathExists(path)
{
    try
    {
        await stat(path);
        return true;
    }
    catch
    {
        return false;
    }
}

async function syncBackendWebRoot()
{
    if (process.env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC === '1')
    {
        log('skipping backend wwwroot sync because FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1');
        return;
    }

    await mkdir(backendWebRoot, { recursive: true });

    for (const entryName of managedDistEntries)
    {
        const sourcePath = join(distRoot, entryName);
        if (!(await pathExists(sourcePath)))
        {
            continue;
        }

        const destinationPath = join(backendWebRoot, entryName);
        await rm(destinationPath, { recursive: true, force: true });
        await cp(sourcePath, destinationPath, { recursive: true, force: true });
    }

    log(`synced dist output into backend wwwroot (${backendWebRoot})`);
}

function buildStageResources(cpuWeight, memoryWeight, minMemoryGiB, exclusiveResources = [])
{
    return { cpuWeight, memoryWeight, minCpuUnits: 1, minMemoryGiB, exclusiveResources };
}

export function resolveReleaseBrowserBuildTrust(env = process.env)
{
    const names = ['FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY', 'FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY_SHA256',
        'FSUSBLOG_RELEASE_BROWSER_KEY_ID'];
    const values = names.map((name) => String(env[name] ?? ''));
    if (values.every((value) => value === ''))
    {
        return null;
    }
    const [publicKey, publicKeySha256, keyId] = values;
    if (values.some((value) => !value || value !== value.trim())
        || !isAbsolute(publicKey) || resolve(publicKey) !== publicKey
        || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(publicKeySha256)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyId))
    {
        throw new Error('release browser build trust requires all three explicit canonical pinned public inputs');
    }
    return { publicKey, publicKeySha256, keyId };
}

export function createFrontendBuildStages(generatedArgs, generatedAction, {
    frontendRoot,
    env = process.env
} = {})
{
    if (!String(frontendRoot ?? '').trim())
    {
        throw new Error('frontend build stage declaration requires frontendRoot');
    }
    const stageClientRoot = resolve(frontendRoot);
    const stageDistRoot = resolve(env.FSUSBLOG_FRONTEND_DIST_ROOT || join(stageClientRoot, 'dist'));
    const stageDistAssetsDir = join(stageDistRoot, 'assets');
    const stagePublicRoot = join(stageClientRoot, 'public');
    const stageFrontendWasmRoot = resolve(env.FSUSBLOG_FRONTEND_WASM_ROOT || join(stagePublicRoot, 'wasm'));
    const stageBackendWebRoot = resolve(env.FSUSBLOG_BACKEND_WEBROOT || join(stageClientRoot, '..', 'backend', 'wwwroot'));
    const stageVueTscBin = join(stageClientRoot, 'node_modules', '.bin', `vue-tsc${binExtension}`);
    const stageViteBin = join(stageClientRoot, 'node_modules', '.bin', `vite${binExtension}`);
    const markdownRuntimeSource = fsusUiMarkdownRuntimeSourceDir({
        root: stageClientRoot,
        repository: repositoryRoot,
        env
    });
    const runBound = Boolean(env.FSUSBLOG_FRONTEND_DIST_ROOT);
    const syncBackend = env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC !== '1';
    const browserTrust = resolveReleaseBrowserBuildTrust(env);
    const browserTrustOutput = join(stagePublicRoot, 'generated', 'current-release-trust.js');
    const stagePublicAssets = browserTrust ? [...runBoundPublicAssets, 'current-release-assets.js'] : runBoundPublicAssets;
    return [
        ...(browserTrust ? [{
            id: 'prepare-current-release-browser-trust',
            command: [process.execPath, releaseBrowserArtifactsScript, '--mode', 'trust',
                '--public-key', browserTrust.publicKey, '--public-key-sha256', browserTrust.publicKeySha256,
                '--key-id', browserTrust.keyId, '--out', browserTrustOutput],
            dependsOn: [],
            consumedInputs: [browserTrust.publicKey],
            producedArtifacts: [browserTrustOutput],
            ownedOutputs: [browserTrustOutput],
            resources: buildStageResources(1, 1, 0.05, ['release-browser-build-trust']),
            estimatedDurationMs: 2_000,
            toolchain: { executable: process.execPath }
        }] : []),
        {
            id: `${generatedAction}-public-page-manifest`,
            command: [process.execPath, generatePublicPageManifestScript, ...generatedArgs],
            dependsOn: [],
            consumedInputs: ['src/shared/Contracts/Outputs/PublicPageContracts.cs'],
            producedArtifacts: ['src/public-renderers/generated/publicPageManifest.ts'],
            ownedOutputs: ['src/public-renderers/generated/publicPageManifest.ts'],
            resources: buildStageResources(1, 1, 0.05, ['generated-public-page-manifest']),
            estimatedDurationMs: 2_000,
            toolchain: { executable: process.execPath }
        },
        {
            id: `${generatedAction}-public-shell-emergency`,
            command: [process.execPath, generatePublicShellEmergencyScript, ...generatedArgs, '--public-only'],
            dependsOn: [],
            consumedInputs: ['src/assets/public-shell-foundation.css'],
            producedArtifacts: ['public/public-shell-emergency.css'],
            ownedOutputs: ['public/public-shell-emergency.css'],
            resources: buildStageResources(1, 1, 0.05, ['generated-public-shell-emergency']),
            estimatedDurationMs: 2_000,
            toolchain: { executable: process.execPath }
        },
        {
            id: 'ensure-wasm',
            command: [process.execPath, ensureWasmScript, 'ensure'],
            dependsOn: [],
            consumedInputs: ['wasm'],
            producedArtifacts: env.FSUSBLOG_SKIP_ENSURE_WASM === '1'
                ? []
                : [
                    join(stageFrontendWasmRoot, 'wasm-manifest.aeds'),
                    join(stageFrontendWasmRoot, 'aeds-runtime-manifest.json'),
                    join(stageFrontendWasmRoot, 'wasm-build-receipt.json')
                ],
            ownedOutputs: env.FSUSBLOG_SKIP_ENSURE_WASM === '1'
                ? []
                : [
                    join(stageFrontendWasmRoot, 'wasm-manifest.aeds'),
                    join(stageFrontendWasmRoot, 'aeds-runtime-manifest.json'),
                    join(stageFrontendWasmRoot, 'wasm-build-receipt.json')
                ],
            resources: buildStageResources(3, 2, 0.05, ['frontend-wasm-output']),
            estimatedDurationMs: 45_000,
            toolchain: { executable: process.execPath }
        },
        {
            id: 'vue-tsc',
            command: [stageVueTscBin],
            dependsOn: [`${generatedAction}-public-page-manifest`],
            consumedInputs: ['src'],
            producedArtifacts: [],
            ownedOutputs: [],
            resources: buildStageResources(2, 2, 0.05),
            estimatedDurationMs: 35_000,
            toolchain: { executable: stageVueTscBin }
        },
        {
            id: 'vite-build',
            command: [
                stageViteBin,
                'build',
                '--outDir',
                stageDistRoot,
                ...(runBound ? ['--emptyOutDir=false'] : []),
                '--logLevel',
                'warn'
            ],
            dependsOn: [
                `${generatedAction}-public-page-manifest`,
                `${generatedAction}-public-shell-emergency`,
                ...(browserTrust ? ['prepare-current-release-browser-trust'] : []),
                ...(!runBound ? ['ensure-wasm'] : [])
            ],
            consumedInputs: ['src', 'public'],
            producedArtifacts: [
                join(stageDistRoot, 'index.html'),
                join(stageDistAssetsDir, stableSpaEntryName),
                join(stageDistAssetsDir, stablePublicBootKernelName)
            ],
            ownedOutputs: [join(stageDistRoot, 'index.html'), join(stageDistRoot, 'assets')],
            resources: buildStageResources(4, 4, 0.05, ['frontend-dist-client']),
            estimatedDurationMs: 50_000,
            toolchain: { executable: stageViteBin }
        },
        {
            id: 'vite-public-ssr-build',
            command: [process.execPath, buildPublicSsrBundleScript],
            dependsOn: [`${generatedAction}-public-page-manifest`, `${generatedAction}-public-shell-emergency`],
            consumedInputs: [
                'src/public-renderers',
                'public/public-shell-emergency.css',
                markdownRuntimeSource
            ],
            producedArtifacts: [
                join(stageDistRoot, 'server', 'public-ssr.mjs'),
                join(stageDistRoot, 'server', 'renderPublicPage.js'),
                join(stageDistRoot, 'server', 'package.json'),
                join(stageDistRoot, 'server', 'server-public-ssr.bundle.mjs'),
                join(stageDistRoot, 'server', 'server-public-ssr.worker-core.mjs'),
                join(stageDistRoot, 'server', 'public-shell-emergency.css'),
                ...fsusUiMarkdownRuntimeAssets.map(
                    (fileName) => join(stageDistRoot, 'server', 'dist', fileName)
                )
            ],
            ownedOutputs: [join(stageDistRoot, 'server')],
            resources: buildStageResources(3, 3, 0.05, ['frontend-dist-server']),
            estimatedDurationMs: 25_000,
            toolchain: { executable: process.execPath }
        },
        {
            id: 'sync-run-bound-public-assets',
            command: ['internal', 'sync-run-bound-public-assets'],
            dependsOn: ['ensure-wasm', 'vite-build'],
            consumedInputs: [stageFrontendWasmRoot, stagePublicRoot, join(stageDistRoot, 'index.html')],
            producedArtifacts: runBound
                ? [...stagePublicAssets.map((entryName) => join(stageDistRoot, entryName)), join(stageDistRoot, 'wasm')]
                : [],
            ownedOutputs: runBound
                ? [...stagePublicAssets.map((entryName) => join(stageDistRoot, entryName)), join(stageDistRoot, 'wasm')]
                : [],
            resources: buildStageResources(1, 1, 0.05, ['frontend-dist-wasm']),
            estimatedDurationMs: 5_000,
            toolchain: { executable: 'node:fs/promises' }
        },
        {
            id: 'sync-fsusui-markdown-runtime-assets',
            command: ['internal', 'sync-fsusui-markdown-runtime-assets'],
            dependsOn: ['vite-build'],
            consumedInputs: [markdownRuntimeSource],
            producedArtifacts: fsusUiMarkdownRuntimeAssets.map((fileName) => join(stageDistRoot, 'dist', fileName)),
            ownedOutputs: [join(stageDistRoot, 'dist')],
            resources: buildStageResources(1, 1, 0.05, ['frontend-dist-markdown']),
            estimatedDurationMs: 2_000,
            toolchain: { executable: 'node:fs/promises' }
        },
        {
            id: 'sync-backend-wwwroot',
            command: ['internal', 'sync-backend-wwwroot'],
            dependsOn: ['vite-build', 'vite-public-ssr-build', 'sync-run-bound-public-assets', 'sync-fsusui-markdown-runtime-assets'],
            consumedInputs: [stageDistRoot],
            producedArtifacts: syncBackend ? [stageBackendWebRoot] : [],
            ownedOutputs: syncBackend ? [stageBackendWebRoot] : [],
            resources: buildStageResources(1, 1, 0.05, ['backend-wwwroot']),
            estimatedDurationMs: 6_000,
            toolchain: { executable: 'node:fs/promises' }
        }
    ];
}

export async function prepareFrontendBuildOutputRoot({ frontendRoot, distRoot: candidateDistRoot, runBound })
{
    const resolvedFrontendRoot = resolve(frontendRoot);
    const resolvedDistRoot = resolve(candidateDistRoot);
    if (!runBound)
    {
        return { mode: 'vite-default', status: 'skipped', path: resolvedDistRoot, removedExisting: false };
    }
    const protectedRoots = new Set([resolve('/'), resolvedFrontendRoot, repositoryRoot]);
    if (protectedRoots.has(resolvedDistRoot))
    {
        throw new Error(`refusing to prepare unsafe frontend build output root: ${resolvedDistRoot}`);
    }
    const removedExisting = await pathExists(resolvedDistRoot);
    await rm(resolvedDistRoot, { recursive: true, force: true });
    await mkdir(resolvedDistRoot, { recursive: true });
    return {
        mode: 'run-bound-fresh-root',
        status: 'success',
        path: resolvedDistRoot,
        removedExisting,
        preparedAtMs: Date.now()
    };
}

async function executeFrontendBuildStage(stage, context)
{
    switch (stage.id)
    {
        case 'ensure-wasm':
            if (process.env.FSUSBLOG_SKIP_ENSURE_WASM === '1')
            {
                log('skipping ensure-wasm because FSUSBLOG_SKIP_ENSURE_WASM=1');
                return { skipped: true, detail: 'FSUSBLOG_SKIP_ENSURE_WASM=1' };
            }
            break;
        case 'sync-run-bound-public-assets':
            if (!process.env.FSUSBLOG_FRONTEND_DIST_ROOT)
            {
                return { skipped: true, detail: 'not a run-bound frontend build' };
            }
            if (stage.id === 'sync-run-bound-public-assets')
            {
                await syncRunBoundPublicAssets();
                return;
            }
            break;
        case 'sync-fsusui-markdown-runtime-assets':
            await syncFsusUiMarkdownRuntimeAssets();
            return;
        case 'sync-backend-wwwroot':
            if (process.env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC === '1')
            {
                await syncBackendWebRoot();
                return { skipped: true, detail: 'FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1' };
            }
            await syncBackendWebRoot();
            return;
        default:
            break;
    }
    await runStage(stage.id, stage.command[0], stage.command.slice(1), context);
    if (stage.id === 'vite-build')
    {
        await syncStableSpaEntryAlias();
        await syncStablePublicBootKernelAlias();
    }
}

async function cleanupPartialBuildOutputs(_error, { stages } = { stages: [] })
{
    const distPrefix = `${pathWithTrailingSeparator(distRoot)}`;
    const touchedDist = stages.some((stage) => stage.ownedOutputs.some((output) =>
    {
        const absolute = resolve(clientRoot, output);
        return absolute === distRoot || absolute.startsWith(distPrefix);
    }));
    if (!touchedDist)
    {
        return { status: 'skipped', removed: [], reason: 'dist was not touched' };
    }
    await rm(distRoot, { recursive: true, force: true });
    return { status: 'success', removed: [distRoot] };
}

function pathWithTrailingSeparator(value)
{
    return value.endsWith('/') || value.endsWith('\\') ? value : `${value}${process.platform === 'win32' ? '\\' : '/'}`;
}

function packageVersion(packageName)
{
    try
    {
        return JSON.parse(fs.readFileSync(join(clientRoot, 'node_modules', packageName, 'package.json'), 'utf8')).version ?? null;
    }
    catch
    {
        return null;
    }
}

async function main()
{
    log(`execution deadline=${buildDeadlineMs}ms source=${inheritedDeadlineMs === null ? 'direct-grant-capacity' : 'step-grant'}`);
    const generatedArgs = process.env.FSUSBLOG_VALIDATE_GENERATED_ONLY === '1' ? ['--check'] : [];
    const generatedAction = generatedArgs.length > 0 ? 'check' : 'generate';
    const controller = new AbortController();
    const abortBuild = (signal) => controller.abort(new Error(`frontend build cancelled by ${signal}`));
    const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => abortBuild(signal)]));
    for (const [signal, handler] of signalHandlers)
    {
        process.once(signal, handler);
    }
    const deadlineTimer = setTimeout(() =>
    {
        const error = new Error(`frontend build exceeded execution deadline of ${buildDeadlineMs}ms`);
        error.code = 'ETIMEDOUT';
        controller.abort(error);
    }, remainingBuildDeadlineMs());
    deadlineTimer.unref?.();
    const receiptFile = resolve(process.env.FSUSBLOG_FRONTEND_BUILD_STAGE_RECEIPT || join(
        process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT || join(repositoryRoot, '.tmp', 'frontend'),
        'generated',
        'frontend-build-stages.json'
    ));
    try
    {
        const buildEnv = resolveProductionFrontendBuildEnv(process.env);
        if (buildEnv.VITE_FSUSBLOG_BUILD_ID && buildEnv.VITE_FSUSBLOG_BUILD_ID !== process.env.VITE_FSUSBLOG_BUILD_ID)
        {
            log(`production build identity=${buildEnv.VITE_FSUSBLOG_BUILD_ID}`);
        }
        const outputPreparation = await prepareFrontendBuildOutputRoot({
            frontendRoot: clientRoot,
            distRoot: buildEnv.FSUSBLOG_FRONTEND_DIST_ROOT || distRoot,
            runBound: Boolean(buildEnv.FSUSBLOG_FRONTEND_DIST_ROOT)
        });
        const receipt = await runFrontendBuildStageDag(createFrontendBuildStages(generatedArgs, generatedAction, {
            frontendRoot: clientRoot,
            env: buildEnv
        }), {
            cwd: clientRoot,
            env: buildEnv,
            receiptFile,
            outputPreparation,
            signal: controller.signal,
            toolchain: {
                node: process.version,
                packageManager: process.env.npm_config_user_agent ?? null,
                vite: packageVersion('vite'),
                vueTsc: packageVersion('vue-tsc')
            },
            execute: executeFrontendBuildStage,
            cleanupPartialOutputs: cleanupPartialBuildOutputs
        });
        const lastGrant = receipt.grantHistory.at(-1);
        log(`resource grant source=${receipt.grantSource ?? 'unknown'} changes=${receipt.grantHistory.length} finalCpu=${lastGrant?.cpuUnits ?? 'unknown'} finalMemoryGiB=${lastGrant?.memoryGiB ?? 'unknown'}`);
        log(`stage receipt=${receiptFile}`);
    }
    finally
    {
        clearTimeout(deadlineTimer);
        for (const [signal, handler] of signalHandlers)
        {
            process.removeListener(signal, handler);
        }
    }
    remainingBuildDeadlineMs();
    log('build completed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error('[client-build] fatal:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}

function positiveNumber(value)
{
    if (value === undefined || value === null || String(value).trim() === '')
    {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
    {
        throw new Error(`build timeout must be a finite positive number, got ${String(value)}`);
    }
    return parsed;
}

function requiredPositiveNumber(value, name)
{
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
    {
        throw new Error(`${name} must be a finite positive number, got ${String(value)}`);
    }
    return parsed;
}

function optionalPositiveNumber(env, names)
{
    for (const name of names)
    {
        if (env[name] === undefined || String(env[name]).trim() === '')
        {
            continue;
        }
        return requiredPositiveNumber(env[name], name);
    }
    return null;
}
