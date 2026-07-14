#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';

import { parseMatrix } from '../test-matrix/parse-matrix.mjs';

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
const frontendBuildCapacity = resolveFrontendBuildCapacity();

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

export function resolveStageEnvironment(resource, env = process.env) {
  const cpuUnits = requiredPositiveNumber(resource?.cpuUnits, 'stage CPU grant');
  const memoryGiB = requiredPositiveNumber(resource?.memoryGiB, 'stage memory grant');
  const maxParallel = Math.max(1, Math.floor(cpuUnits));
  return {
    ...env,
    FSUSBLOG_STEP_CPU_BUDGET: formatResourceNumber(cpuUnits),
    FSUSBLOG_STEP_MEMORY_GIB: formatResourceNumber(memoryGiB),
    FSUSBLOG_BUNDLE_CPU_UNITS: formatResourceNumber(cpuUnits),
    FSUSBLOG_BUNDLE_CPU_BUDGET: String(maxParallel),
    FSUSBLOG_BUNDLE_MEMORY_GIB: formatResourceNumber(memoryGiB),
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: String(maxParallel),
    FSUSBLOG_NODE_TEST_CONCURRENCY: String(maxParallel),
    UV_THREADPOOL_SIZE: String(maxParallel)
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

function runStage(name, command, args, resource = frontendBuildCapacity) {
  return new Promise((resolve, reject) => {
    const timeoutMs = stageTimeoutMs();
    log(`starting ${name}`);
    const useShell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: resolveStageEnvironment(resource),
      cwd: clientRoot,
      detached: process.platform !== 'win32',
      shell: useShell,
      windowsHide: true
    });
    let settled = false;
    let timedOut = false;
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
      if (error) reject(error);
      else resolve();
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
      if (settled) return;
      timedOut = true;
      signalProcessGroup('SIGTERM');
      const terminationGraceMs = Math.max(100, Math.min(5_000, Math.ceil(timeoutMs * 0.02)));
      escalationTimer = setTimeout(() => {
        signalProcessGroup('SIGKILL');
        closePipes();
        forcedSettleTimer = setTimeout(() => {
          const timeoutError = new Error(`${name} exceeded remaining execution deadline of ${timeoutMs}ms`);
          timeoutError.code = 'ETIMEDOUT';
          finish(timeoutError);
        }, Math.max(25, Math.min(250, terminationGraceMs)));
        forcedSettleTimer.unref?.();
      }, terminationGraceMs);
      escalationTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => {
      closePipes();
      finish(error);
    });

    child.once('close', (code, signal) => {
      if (timedOut) return;
      if (code === 0) {
        log(`finished ${name}`);
        finish();
        return;
      }

      const exitReason = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(new Error(`${name} failed with ${exitReason}`));
    });
  });
}

async function runStageGroup(stages) {
  const plan = resolveConcurrentStageResources(stages.length, frontendBuildCapacity);
  if (!plan.concurrent) {
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      await runStage(stage.name, stage.command, stage.args, plan.stages[index]);
    }
    return;
  }

  const results = await Promise.allSettled(stages.map((stage, index) =>
    runStage(stage.name, stage.command, stage.args, plan.stages[index])));
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length > 0) {
    const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
    throw new AggregateError(errors, `${errors.length} frontend build stage(s) failed: ${details}`);
  }
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
  const sourceDir = join(clientRoot, 'node_modules', '@ozwasyd', 'element-plus', 'es', 'wasm', 'dist');
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

async function main() {
  log(`execution deadline=${buildDeadlineMs}ms source=${inheritedDeadlineMs === null ? 'host-capacity' : 'step-grant'}`);
  log(`resource grant cpu=${formatResourceNumber(frontendBuildCapacity.cpuUnits)} memoryGiB=${formatResourceNumber(frontendBuildCapacity.memoryGiB)}`);
  const generatedArgs = process.env.FSUSBLOG_VALIDATE_GENERATED_ONLY === '1' ? ['--check'] : [];
  const generatedAction = generatedArgs.length > 0 ? 'check' : 'generate';
  await runStageGroup([
    {
      name: `${generatedAction}-public-page-manifest`,
      command: process.execPath,
      args: [generatePublicPageManifestScript, ...generatedArgs]
    },
    {
      name: `${generatedAction}-public-shell-emergency`,
      command: process.execPath,
      args: [generatePublicShellEmergencyScript, ...generatedArgs]
    }
  ]);
  if (process.env.FSUSBLOG_SKIP_ENSURE_WASM === '1') {
    log('skipping ensure-wasm because FSUSBLOG_SKIP_ENSURE_WASM=1');
  } else {
    await runStage('ensure-wasm', process.execPath, [ensureWasmScript, 'ensure']);
  }

  await runStageGroup([
    { name: 'vue-tsc', command: vueTscBin, args: [] },
    { name: 'vite-build', command: viteBin, args: ['build', '--outDir', distRoot, '--logLevel', 'warn'] }
  ]);
  await runStage('vite-public-ssr-build', process.execPath, [buildPublicSsrBundleScript]);
  if (process.env.FSUSBLOG_FRONTEND_DIST_ROOT) {
    await runStage('assemble-run-bound-public-shell-emergency', process.execPath, [
      generatePublicShellEmergencyScript
    ]);
  }
  await syncRunBoundPublicAssets();
  await Promise.all([
    syncStableSpaEntryAlias(),
    syncFsusUiMarkdownRuntimeAssets()
  ]);
  await syncBackendWebRoot();
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
