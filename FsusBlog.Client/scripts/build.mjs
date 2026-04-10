#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const vueTscBin = join(rootDir, 'node_modules/.bin/vue-tsc');
const viteBin = join(rootDir, 'node_modules/.bin/vite');

const stageTimeoutMs = Number(process.env.FSUSBLOG_BUILD_TIMEOUT_MS || String(20 * 60 * 1000));

function log(message) {
  console.log(`[client-build] ${message}`);
}

function runStage(name, command, args) {
  return new Promise((resolve, reject) => {
    log(`starting ${name}`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env
    });

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

async function main() {
  log(`stage timeout=${stageTimeoutMs}ms`);
  await runStage('vue-tsc', vueTscBin, []);
  await runStage('vite-build', viteBin, ['build']);
  log('build completed');
}

main().catch((error) => {
  console.error('[client-build] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
