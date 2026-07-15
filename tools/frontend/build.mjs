#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';

import { parseMatrix } from '../test-matrix/parse-matrix.mjs';
import {
  resolveStageEnvironment,
  runFrontendBuildStageDag
} from './build-stage-dag.mjs';

export { resolveStageEnvironment } from './build-stage-dag.mjs';

const clientRoot = process.cwd();
const ensureWasmScript = fileURLToPath(new URL('./ensure-wasm.mjs', import.meta.url));
const generatePublicPageManifestScript = fileURLToPath(new URL('./generate-public-page-manifest.mjs', import.meta.url));
const generatePublicShellEmergencyScript = fileURLToPath(new URL('./generate-public-shell-emergency.mjs', import.meta.url));
const buildPublicSsrBundleScript = fileURLToPath(new URL('./build-public-ssr-bundle.mjs', import.meta.url));
const binExtension = process.platform === 'win32' ? '.cmd' : '';
const vueTscBin = join(clientRoot, 'node_modules', '.bin', `vue-tsc${binExtension}`);
const viteBin = join(clientRoot, 'node_modules', '.bin', `vite${binExtension}`);
const distRoot = resolve(process.env.FSUSBLOG_FRONTEND_DIST_ROOT || join(clientRoot, 'dist'));
const distAssetsDir = join(distRoot, 'assets');
const publicRoot = join(clientRoot, 'public');
const frontendWasmRoot = resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT || join(publicRoot, 'wasm'));
const backendWebRoot = resolve(process.env.FSUSBLOG_BACKEND_WEBROOT || join(clientRoot, '..', 'backend', 'wwwroot'));
const stableSpaEntryName = 'fsus-spa-entry.js';
const managedDistEntries = ['.vite', 'assets', 'dist', 'favicon.svg', 'index.html', 'server', 'sw.js', 'vite.svg', 'wasm'];
const fsusUiMarkdownRuntimeAssets = [
  'markdown_simd.js',
  'markdown_simd.wasm',
  'markdown_basic.js',
  'markdown_basic.wasm'
];

function resolveLocalFsusUiRoot() {
  const disabled = process.env.FSUSBLOG_USE_LOCAL_FSUSUI === '0'
    || process.env.FSUSBLOG_USE_LOCAL_FSUSUI?.toLowerCase() === 'false';
  if (disabled) return null;
  const candidate = resolve(
    process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT || join(repositoryRoot, '..', 'FsusUI')
  );
  return fs.existsSync(join(candidate, 'vue', 'packages', 'element-plus', 'index.ts'))
    ? candidate
    : null;
}

function fsusUiMarkdownRuntimeSourceDir() {
  const localRoot = resolveLocalFsusUiRoot();
  return localRoot
    ? join(localRoot, 'vue', 'packages', 'wasm', 'dist')
    : join(clientRoot, 'node_modules', '@ozwasyd', 'element-plus', 'es', 'wasm', 'dist');
}

const inheritedDeadlineMs = positiveNumber(
  process.env.FSUSBLOG_STEP_DEADLINE_MS
    ?? process.env.FSUSBLOG_BUNDLE_DEADLINE_MS);
const configuredTimeoutMs = positiveNumber(process.env.FSUSBLOG_BUILD_TIMEOUT_MS);
const hostCpu = os.availableParallelism?.() ?? os.cpus().length;
const hostFreeMemoryGiB = os.freemem() / (1024 ** 3);
const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const productionProfile = parseMatrix(fs.readFileSync(join(repositoryRoot, 'tests/matrix.yml'), 'utf8')).localProfiles?.production;
const directBuildBundle = productionProfile?.bundles?.find((entry) => entry.id === 'build-static');
if (!Number.isFinite(productionProfile?.budgetMs) || !directBuildBundle) {
  throw new Error('production build-static machine budget is unavailable');
}
const directBuildDeadlineMs = Math.ceil(productionProfile.budgetMs * Math.max(
  1,
  directBuildBundle.cpuWeight / Math.max(1, hostCpu),
  directBuildBundle.memoryWeight / Math.max(Number.EPSILON, hostFreeMemoryGiB),
  directBuildBundle.minCpuUnits / Math.max(1, hostCpu)
));
const buildDeadlineMs = inheritedDeadlineMs ?? directBuildDeadlineMs;
const buildStartedAt = Date.now();

export function resolveFrontendBuildCapacity({
  env = process.env,
  availableCpu = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryGiB = os.freemem() / (1024 ** 3)
} = {}) {
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

export function resolveConcurrentStageResources(stageCount, capacity) {
  if (!Number.isInteger(stageCount) || stageCount <= 0) {
    throw new Error('stage count must be a positive integer');
  }
  const cpuUnits = requiredPositiveNumber(capacity?.cpuUnits, 'frontend build CPU grant');
  const memoryGiB = requiredPositiveNumber(capacity?.memoryGiB, 'frontend build memory grant');
  const integralCpuUnits = Math.max(1, Math.floor(cpuUnits));
  if (integralCpuUnits < stageCount) {
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

function remainingBuildDeadlineMs() {
  const remaining = buildDeadlineMs - (Date.now() - buildStartedAt);
  if (remaining <= 0) {
    const error = new Error(`frontend build exceeded execution deadline of ${buildDeadlineMs}ms`);
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.floor(remaining));
}

function stageTimeoutMs() {
  const remaining = remainingBuildDeadlineMs();
  return configuredTimeoutMs === null ? remaining : Math.min(configuredTimeoutMs, remaining);
}
function log(message) {
  console.log(`[client-build] ${message}`);
}

function runStage(name, command, args, { env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
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

    const signalProcessGroup = (signal) => {
      if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null) child.kill(signal);
      }
    };
    const closePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer !== null) clearTimeout(escalationTimer);
      if (forcedSettleTimer !== null) clearTimeout(forcedSettleTimer);
      signal?.removeEventListener('abort', abortStage);
      if (error) reject(error);
      else resolve();
    };

    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      signalProcessGroup('SIGTERM');
      const terminationGraceMs = Math.max(100, Math.min(5_000, Math.ceil(timeoutMs * 0.02)));
      escalationTimer = setTimeout(() => {
        signalProcessGroup('SIGKILL');
        closePipes();
        forcedSettleTimer = setTimeout(() => finish(terminationError), Math.max(25, Math.min(250, terminationGraceMs)));
        forcedSettleTimer.unref?.();
      }, terminationGraceMs);
      escalationTimer.unref?.();
    };
    const abortStage = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error(`${name} cancelled`);
      terminate(error);
    };

    const forwardOutput = (stream, writer) => {
      let buffered = '';

      stream.on('data', (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';

        for (const line of lines) {
          writer.write(`${line}\n`);
        }
      });

      stream.on('end', () => {
        if (!buffered) {
          return;
        }

        writer.write(buffered);
      });
    };

    if (child.stdout) {
      forwardOutput(child.stdout, process.stdout);
    }

    if (child.stderr) {
      forwardOutput(child.stderr, process.stderr);
    }

    const timer = setTimeout(() => {
      const timeoutError = new Error(`${name} exceeded remaining execution deadline of ${timeoutMs}ms`);
      timeoutError.code = 'ETIMEDOUT';
      terminate(timeoutError);
    }, timeoutMs);
    timer.unref?.();

    if (signal?.aborted) abortStage();
    else signal?.addEventListener('abort', abortStage, { once: true });

    child.once('error', (error) => {
      closePipes();
      finish(error);
    });

    child.once('close', (code, childSignal) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0) {
        log(`finished ${name}`);
        finish();
        return;
      }

      const exitReason = childSignal ? `signal ${childSignal}` : `exit code ${code}`;
      finish(new Error(`${name} failed with ${exitReason}`));
    });
  });
}

async function syncStableSpaEntryAlias() {
  const assetFiles = await readdir(distAssetsDir, { withFileTypes: true });
  const entryCandidates = assetFiles
    .filter((entry) => entry.isFile() && /^index-[A-Za-z0-9_-]+\.js$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (entryCandidates.length === 0) {
    throw new Error('stable spa entry alias sync failed: missing built index-*.js asset');
  }

  const sourceEntry = join(distAssetsDir, entryCandidates[0]);
  const stableEntry = join(distAssetsDir, stableSpaEntryName);

  await mkdir(distAssetsDir, { recursive: true });
  await rm(stableEntry, { force: true });
  await copyFile(sourceEntry, stableEntry);
  log(`synced stable spa entry alias ${stableSpaEntryName} -> ${entryCandidates[0]}`);
}

async function syncFsusUiMarkdownRuntimeAssets() {
  const sourceDir = fsusUiMarkdownRuntimeSourceDir();
  const targetDir = join(distRoot, 'dist');

  await mkdir(targetDir, { recursive: true });

  for (const fileName of fsusUiMarkdownRuntimeAssets) {
    const sourcePath = join(sourceDir, fileName);
    if (!(await pathExists(sourcePath))) {
      throw new Error(`FsusUI markdown runtime asset missing: ${sourcePath}`);
    }
    await copyFile(sourcePath, join(targetDir, fileName));
  }

  log(`synced FsusUI markdown runtime assets into ${targetDir}`);
}

async function syncRunBoundPublicAssets() {
  if (!process.env.FSUSBLOG_FRONTEND_DIST_ROOT) return;
  const entries = await readdir(publicRoot, { withFileTypes: true });
  await mkdir(distRoot, { recursive: true });
  for (const entry of entries) {
    if (entry.name === 'wasm') continue;
    await cp(join(publicRoot, entry.name), join(distRoot, entry.name), { recursive: true, force: true });
  }
  await rm(join(distRoot, 'wasm'), { recursive: true, force: true });
  await cp(frontendWasmRoot, join(distRoot, 'wasm'), { recursive: true, force: true });
  log(`assembled run-bound public assets into ${distRoot}`);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function syncBackendWebRoot() {
  if (process.env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC === '1') {
    log('skipping backend wwwroot sync because FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1');
    return;
  }

  await mkdir(backendWebRoot, { recursive: true });

  for (const entryName of managedDistEntries) {
    const sourcePath = join(distRoot, entryName);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const destinationPath = join(backendWebRoot, entryName);
    await rm(destinationPath, { recursive: true, force: true });
    await cp(sourcePath, destinationPath, { recursive: true, force: true });
  }

  log(`synced dist output into backend wwwroot (${backendWebRoot})`);
}

function buildStageResources(cpuWeight, memoryWeight, minMemoryGiB, exclusiveResources = []) {
  return { cpuWeight, memoryWeight, minCpuUnits: 1, minMemoryGiB, exclusiveResources };
}

export function createFrontendBuildStages(generatedArgs, generatedAction) {
  const runBound = Boolean(process.env.FSUSBLOG_FRONTEND_DIST_ROOT);
  const syncBackend = process.env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC !== '1';
  return [
    {
      id: `${generatedAction}-public-page-manifest`,
      command: [process.execPath, generatePublicPageManifestScript, ...generatedArgs],
      dependsOn: [],
      consumedInputs: ['src/shared/Contracts/Outputs/PublicPageContracts.cs'],
      ownedOutputs: ['src/public-renderers/generated/publicPageManifest.ts'],
      resources: buildStageResources(1, 1, 0.25, ['generated-public-page-manifest']),
      estimatedDurationMs: 2_000,
      toolchain: { executable: process.execPath }
    },
    {
      id: `${generatedAction}-public-shell-emergency`,
      command: [process.execPath, generatePublicShellEmergencyScript, ...generatedArgs],
      dependsOn: [],
      consumedInputs: ['src/assets/public-page.css'],
      ownedOutputs: ['public/public-shell-emergency.css'],
      resources: buildStageResources(1, 1, 0.25, ['generated-public-shell-emergency']),
      estimatedDurationMs: 2_000,
      toolchain: { executable: process.execPath }
    },
    {
      id: 'ensure-wasm',
      command: [process.execPath, ensureWasmScript, 'ensure'],
      dependsOn: [],
      consumedInputs: ['wasm'],
      ownedOutputs: process.env.FSUSBLOG_SKIP_ENSURE_WASM === '1'
        ? []
        : [join(frontendWasmRoot, 'wasm-manifest.aeds'), join(frontendWasmRoot, 'aeds-runtime-manifest.json')],
      resources: buildStageResources(3, 2, 0.75, ['frontend-wasm-output']),
      estimatedDurationMs: 45_000,
      toolchain: { executable: process.execPath }
    },
    {
      id: 'vue-tsc',
      command: [vueTscBin],
      dependsOn: [`${generatedAction}-public-page-manifest`, `${generatedAction}-public-shell-emergency`, 'ensure-wasm'],
      consumedInputs: ['src', 'public/wasm'],
      ownedOutputs: [],
      resources: buildStageResources(2, 2, 0.75),
      estimatedDurationMs: 35_000,
      toolchain: { executable: vueTscBin }
    },
    {
      id: 'vite-build',
      command: [viteBin, 'build', '--outDir', distRoot, '--logLevel', 'warn'],
      dependsOn: [`${generatedAction}-public-page-manifest`, `${generatedAction}-public-shell-emergency`, 'ensure-wasm'],
      consumedInputs: ['src', 'public'],
      ownedOutputs: [join(distRoot, 'index.html'), join(distRoot, 'assets')],
      resources: buildStageResources(4, 4, 1.5, ['frontend-dist']),
      estimatedDurationMs: 50_000,
      toolchain: { executable: viteBin }
    },
    {
      id: 'vite-public-ssr-build',
      command: [process.execPath, buildPublicSsrBundleScript],
      dependsOn: ['vue-tsc', 'vite-build'],
      consumedInputs: ['src/public-renderers', join(distRoot, 'assets')],
      ownedOutputs: [join(distRoot, 'server')],
      resources: buildStageResources(3, 3, 1, ['frontend-dist']),
      estimatedDurationMs: 25_000,
      toolchain: { executable: process.execPath }
    },
    {
      id: 'assemble-run-bound-public-shell-emergency',
      command: [process.execPath, generatePublicShellEmergencyScript],
      dependsOn: ['vite-public-ssr-build'],
      consumedInputs: ['src/assets/public-page.css'],
      ownedOutputs: runBound ? [join(distRoot, 'server', 'public-shell-emergency.css')] : [],
      resources: buildStageResources(1, 1, 0.25, ['frontend-dist']),
      estimatedDurationMs: 2_000,
      toolchain: { executable: process.execPath }
    },
    {
      id: 'sync-run-bound-public-assets',
      command: ['internal', 'sync-run-bound-public-assets'],
      dependsOn: ['assemble-run-bound-public-shell-emergency'],
      consumedInputs: ['public'],
      ownedOutputs: runBound ? [join(distRoot, 'wasm')] : [],
      resources: buildStageResources(1, 1, 0.5, ['frontend-dist']),
      estimatedDurationMs: 5_000,
      toolchain: { executable: 'node:fs/promises' }
    },
    {
      id: 'sync-stable-spa-entry',
      command: ['internal', 'sync-stable-spa-entry'],
      dependsOn: ['sync-run-bound-public-assets'],
      consumedInputs: [join(distRoot, 'assets')],
      ownedOutputs: [join(distAssetsDir, stableSpaEntryName)],
      resources: buildStageResources(1, 1, 0.25, ['frontend-dist-assets']),
      estimatedDurationMs: 2_000,
      toolchain: { executable: 'node:fs/promises' }
    },
    {
      id: 'sync-fsusui-markdown-runtime-assets',
      command: ['internal', 'sync-fsusui-markdown-runtime-assets'],
      dependsOn: ['sync-run-bound-public-assets'],
      consumedInputs: [fsusUiMarkdownRuntimeSourceDir()],
      ownedOutputs: [join(distRoot, 'dist')],
      resources: buildStageResources(1, 1, 0.25, ['frontend-dist-markdown']),
      estimatedDurationMs: 2_000,
      toolchain: { executable: 'node:fs/promises' }
    },
    {
      id: 'sync-backend-wwwroot',
      command: ['internal', 'sync-backend-wwwroot'],
      dependsOn: ['sync-stable-spa-entry', 'sync-fsusui-markdown-runtime-assets'],
      consumedInputs: [distRoot],
      ownedOutputs: syncBackend ? [backendWebRoot] : [],
      resources: buildStageResources(1, 1, 0.5, ['backend-wwwroot']),
      estimatedDurationMs: 6_000,
      toolchain: { executable: 'node:fs/promises' }
    }
  ];
}

async function executeFrontendBuildStage(stage, context) {
  switch (stage.id) {
    case 'ensure-wasm':
      if (process.env.FSUSBLOG_SKIP_ENSURE_WASM === '1') {
        log('skipping ensure-wasm because FSUSBLOG_SKIP_ENSURE_WASM=1');
        return { skipped: true, detail: 'FSUSBLOG_SKIP_ENSURE_WASM=1' };
      }
      break;
    case 'assemble-run-bound-public-shell-emergency':
    case 'sync-run-bound-public-assets':
      if (!process.env.FSUSBLOG_FRONTEND_DIST_ROOT) {
        return { skipped: true, detail: 'not a run-bound frontend build' };
      }
      if (stage.id === 'sync-run-bound-public-assets') {
        await syncRunBoundPublicAssets();
        return;
      }
      break;
    case 'sync-stable-spa-entry':
      await syncStableSpaEntryAlias();
      return;
    case 'sync-fsusui-markdown-runtime-assets':
      await syncFsusUiMarkdownRuntimeAssets();
      return;
    case 'sync-backend-wwwroot':
      if (process.env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC === '1') {
        await syncBackendWebRoot();
        return { skipped: true, detail: 'FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1' };
      }
      await syncBackendWebRoot();
      return;
    default:
      break;
  }
  await runStage(stage.id, stage.command[0], stage.command.slice(1), context);
}

async function cleanupPartialBuildOutputs(_error, { stages } = { stages: [] }) {
  const distPrefix = `${pathWithTrailingSeparator(distRoot)}`;
  const touchedDist = stages.some((stage) => stage.ownedOutputs.some((output) => {
    const absolute = resolve(clientRoot, output);
    return absolute === distRoot || absolute.startsWith(distPrefix);
  }));
  if (!touchedDist) return { status: 'skipped', removed: [], reason: 'dist was not touched' };
  await rm(distRoot, { recursive: true, force: true });
  return { status: 'success', removed: [distRoot] };
}

function pathWithTrailingSeparator(value) {
  return value.endsWith('/') || value.endsWith('\\') ? value : `${value}${process.platform === 'win32' ? '\\' : '/'}`;
}

function packageVersion(packageName) {
  try {
    return JSON.parse(fs.readFileSync(join(clientRoot, 'node_modules', packageName, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

async function main() {
  log(`execution deadline=${buildDeadlineMs}ms source=${inheritedDeadlineMs === null ? 'host-capacity' : 'step-grant'}`);
  const generatedArgs = process.env.FSUSBLOG_VALIDATE_GENERATED_ONLY === '1' ? ['--check'] : [];
  const generatedAction = generatedArgs.length > 0 ? 'check' : 'generate';
  const controller = new AbortController();
  const abortBuild = (signal) => controller.abort(new Error(`frontend build cancelled by ${signal}`));
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => abortBuild(signal)]));
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  const deadlineTimer = setTimeout(() => {
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
  try {
    const receipt = await runFrontendBuildStageDag(createFrontendBuildStages(generatedArgs, generatedAction), {
      cwd: clientRoot,
      env: process.env,
      receiptFile,
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
  } finally {
    clearTimeout(deadlineTimer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
  remainingBuildDeadlineMs();
  log('build completed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[client-build] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

function positiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`build timeout must be a finite positive number, got ${String(value)}`);
  }
  return parsed;
}

function requiredPositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite positive number, got ${String(value)}`);
  }
  return parsed;
}

function optionalPositiveNumber(env, names) {
  for (const name of names) {
    if (env[name] === undefined || String(env[name]).trim() === '') continue;
    return requiredPositiveNumber(env[name], name);
  }
  return null;
}

function formatResourceNumber(value) {
  return String(Number(requiredPositiveNumber(value, 'resource value').toFixed(6)));
}
