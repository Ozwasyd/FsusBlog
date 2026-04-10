#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const wasmDir = join(root, 'public', 'wasm');

const artifacts = [
  'markdown_basic.js',
  'markdown_basic.wasm',
  'markdown_simd.js',
  'markdown_simd.wasm'
];

let failed = false;

for (const file of artifacts) {
  const filePath = join(wasmDir, file);
  if (!existsSync(filePath)) {
    console.error(`[markdown-wasm] missing: ${file}`);
    failed = true;
    continue;
  }

  const size = statSync(filePath).size;
  if (size <= 0) {
    console.error(`[markdown-wasm] empty: ${file}`);
    failed = true;
  }
}

const moduleChecks = [
  { file: 'markdown_basic.js', symbols: ['createMarkdownModule', '_markdown_render', '_markdown_get_last_html_ptr', '_markdown_get_last_metadata_ptr'] },
  { file: 'markdown_simd.js', symbols: ['createMarkdownModule', '_markdown_render', '_markdown_get_last_html_ptr', '_markdown_get_last_metadata_ptr'] }
];

for (const check of moduleChecks) {
  const filePath = join(wasmDir, check.file);
  if (!existsSync(filePath)) {
    continue;
  }

  const source = readFileSync(filePath, 'utf8');
  for (const symbol of check.symbols) {
    if (!source.includes(symbol)) {
      console.error(`[markdown-wasm] symbol missing in ${check.file}: ${symbol}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('[markdown-wasm] ok artifacts=basic+simd');
