#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readUtf8(path) {
  return await readFile(path, 'utf8');
}

async function main() {
  const clientRoot = process.cwd();
  const toolsFrontendRoot = resolve(clientRoot, '../../tools/frontend');
  const packageJsonPath = resolve(clientRoot, 'package.json');
  const rebuildScriptPath = resolve(toolsFrontendRoot, 'rebuild-public-hydration-bundle.mjs');

  const packageSource = await readUtf8(packageJsonPath);
  const scriptMatch = packageSource.match(/"rebuild:public-hydration"\s*:\s*"([^"]+)"/u);
  const rebuildCommand = scriptMatch?.[1];

  assert(typeof rebuildCommand === 'string' && rebuildCommand.length > 0, 'missing package.json script: rebuild:public-hydration');
  assert(rebuildCommand === 'node ../../tools/frontend/rebuild-public-hydration-bundle.mjs', `unexpected rebuild:public-hydration: ${rebuildCommand}`);
  assert(!/\bvite-node\b/.test(rebuildCommand), `rebuild:public-hydration must not use vite-node, got: ${rebuildCommand}`);
  assert(!/\brun-vite-module\b/.test(rebuildCommand), `rebuild:public-hydration must not use run-vite-module, got: ${rebuildCommand}`);

  const rebuildSource = await readUtf8(rebuildScriptPath);
  assert(!/\bvite-node\b/.test(rebuildSource), 'rebuild-public-hydration-bundle.mjs must not reference vite-node');
  assert(!/\brun-vite-module\b/.test(rebuildSource), 'rebuild-public-hydration-bundle.mjs must not reference run-vite-module');
  assert(!/aot-bundle/u.test(rebuildSource), 'rebuild-public-hydration-bundle.mjs must not upload AOT bundles');
  assert(!/postBundleWithPow|loginWithPow/u.test(rebuildSource), 'rebuild-public-hydration-bundle.mjs must not log in or POST generated AOT');
  assert(
    rebuildSource.includes("./warm-public-aot-cache.mjs"),
    'rebuild-public-hydration-bundle.mjs must delegate to public GET warmup/backfill'
  );

  console.log('[check-public-hydration-rebuild] ok');
}

main().catch((error) => {
  console.error('[check-public-hydration-rebuild] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
