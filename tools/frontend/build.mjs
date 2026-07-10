#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';

const clientRoot = process.cwd();
const ensureWasmScript = fileURLToPath(new URL('./ensure-wasm.mjs', import.meta.url));
const generatePublicPageManifestScript = fileURLToPath(new URL('./generate-public-page-manifest.mjs', import.meta.url));
const generatePublicShellEmergencyScript = fileURLToPath(new URL('./generate-public-shell-emergency.mjs', import.meta.url));
const buildPublicSsrBundleScript = fileURLToPath(new URL('./build-public-ssr-bundle.mjs', import.meta.url));
const binExtension = process.platform === 'win32' ? '.cmd' : '';
const vueTscBin = join(clientRoot, 'node_modules', '.bin', `vue-tsc${binExtension}`);
const viteBin = join(clientRoot, 'node_modules', '.bin', `vite${binExtension}`);
const distAssetsDir = join(clientRoot, 'dist', 'assets');
const distRoot = join(clientRoot, 'dist');
const backendWebRoot = join(clientRoot, '..', 'backend', 'wwwroot');
const stableSpaEntryName = 'fsus-spa-entry.js';
const managedDistEntries = ['.vite', 'assets', 'dist', 'favicon.svg', 'index.html', 'server', 'sw.js', 'vite.svg', 'wasm'];
const fsusUiMarkdownRuntimeAssets = [
  'markdown_simd.js',
  'markdown_simd.wasm',
  'markdown_basic.js',
  'markdown_basic.wasm'
];

const stageTimeoutMs = Number(process.env.FSUSBLOG_BUILD_TIMEOUT_MS || String(20 * 60 * 1000));
function log(message) {
  console.log(`[client-build] ${message}`);
}

function runStage(name, command, args) {
  return new Promise((resolve, reject) => {
    log(`starting ${name}`);
    const useShell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
      cwd: clientRoot,
      shell: useShell,
      windowsHide: true
    });

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
      child.kill('SIGTERM');
      const timeoutError = new Error(`${name} exceeded timeout of ${stageTimeoutMs}ms`);
      timeoutError.code = 'ETIMEDOUT';
      reject(timeoutError);
    }, stageTimeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        log(`finished ${name}`);
        resolve();
        return;
      }

      const exitReason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${name} failed with ${exitReason}`));
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
  log(`stage timeout=${stageTimeoutMs}ms`);
  const generatedArgs = process.env.FSUSBLOG_VALIDATE_GENERATED_ONLY === '1' ? ['--check'] : [];
  const generatedAction = generatedArgs.length > 0 ? 'check' : 'generate';
  await runStage(`${generatedAction}-public-page-manifest`, process.execPath, [generatePublicPageManifestScript, ...generatedArgs]);
  await runStage(`${generatedAction}-public-shell-emergency`, process.execPath, [generatePublicShellEmergencyScript, ...generatedArgs]);
  if (process.env.FSUSBLOG_SKIP_ENSURE_WASM === '1') {
    log('skipping ensure-wasm because FSUSBLOG_SKIP_ENSURE_WASM=1');
  } else {
    await runStage('ensure-wasm', process.execPath, [ensureWasmScript, 'ensure']);
  }

  await Promise.all([
    runStage('vue-tsc', vueTscBin, []),
    runStage('vite-build', viteBin, ['build', '--logLevel', 'warn'])
  ]);
  await runStage('vite-public-ssr-build', process.execPath, [buildPublicSsrBundleScript]);
  await syncStableSpaEntryAlias();
  await syncFsusUiMarkdownRuntimeAssets();
  await syncBackendWebRoot();
  log('build completed');
}

main().catch((error) => {
  console.error('[client-build] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
