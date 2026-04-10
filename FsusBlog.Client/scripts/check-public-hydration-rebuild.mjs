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
  const packageJsonPath = resolve(clientRoot, 'package.json');
  const rebuildScriptPath = resolve(clientRoot, 'scripts/rebuild-public-hydration-bundle.mjs');
  const builderScriptPath = resolve(clientRoot, 'scripts/public-hydration-bundle.mjs');

  const packageJson = JSON.parse(await readUtf8(packageJsonPath));
  const rebuildCommand = packageJson?.scripts?.['rebuild:public-hydration'];

  assert(typeof rebuildCommand === 'string' && rebuildCommand.length > 0, 'missing package.json script: rebuild:public-hydration');
  assert(rebuildCommand === 'node ./scripts/rebuild-public-hydration-bundle.mjs', `unexpected rebuild:public-hydration: ${rebuildCommand}`);
  assert(!/\bvite-node\b/.test(rebuildCommand), `rebuild:public-hydration must not use vite-node, got: ${rebuildCommand}`);
  assert(!/\brun-vite-module\b/.test(rebuildCommand), `rebuild:public-hydration must not use run-vite-module, got: ${rebuildCommand}`);

  const rebuildSource = await readUtf8(rebuildScriptPath);
  assert(!/\bvite-node\b/.test(rebuildSource), 'rebuild-public-hydration-bundle.mjs must not reference vite-node');
  assert(!/\brun-vite-module\b/.test(rebuildSource), 'rebuild-public-hydration-bundle.mjs must not reference run-vite-module');
  assert(
    rebuildSource.includes("from './public-hydration-bundle.mjs'"),
    'rebuild-public-hydration-bundle.mjs must import the pure-node public-hydration-bundle helper'
  );

  const builderSource = await readUtf8(builderScriptPath);
  assert(!/\bvite-node\b/.test(builderSource), 'public-hydration-bundle.mjs must not reference vite-node');
  assert(!/\brun-vite-module\b/.test(builderSource), 'public-hydration-bundle.mjs must not reference run-vite-module');
  assert(builderSource.includes('export async function buildPublicHydrationBundle'), 'public-hydration-bundle.mjs must export buildPublicHydrationBundle');

  console.log('[check-public-hydration-rebuild] ok');
}

main().catch((error) => {
  console.error('[check-public-hydration-rebuild] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
