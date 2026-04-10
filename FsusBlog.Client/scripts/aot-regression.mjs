#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const wasmDir = join(root, 'public', 'wasm');

const checks = [
  { file: join(wasmDir, 'aeds_decoder.js'), label: 'aeds_decoder.js' },
  { file: join(wasmDir, 'aeds_decoder.wasm'), label: 'aeds_decoder.wasm' },
  { file: join(wasmDir, 'fsus_pow_simd.js'), label: 'fsus_pow_simd.js' },
  { file: join(wasmDir, 'fsus_pow_simd.wasm'), label: 'fsus_pow_simd.wasm' },
  { file: join(wasmDir, 'fsus_pow_basic.js'), label: 'fsus_pow_basic.js' },
  { file: join(wasmDir, 'fsus_pow_basic.wasm'), label: 'fsus_pow_basic.wasm' }
];

let failed = false;
for (const check of checks) {
  if (!existsSync(check.file)) {
    console.error(`[aot-check] missing: ${check.label}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

const decoderJsPath = join(wasmDir, 'aeds_decoder.js');
const decoderJs = readFileSync(decoderJsPath, 'utf8');
const requiredSymbols = [
  'decode_aeds',
  'get_last_payload_ptr',
  'get_last_payload_len',
  'get_last_frame_type',
  'render_view',
  'get_last_html_ptr',
  'get_last_html_len',
  'handle_event'
];

for (const symbol of requiredSymbols) {
  if (!decoderJs.includes(symbol)) {
    console.error(`[aot-check] export symbol not found in decoder js: ${symbol}`);
    failed = true;
  }
}

const sourceChecks = [
  join(root, 'src', 'components', 'AotHost.vue'),
  join(root, 'src', 'services', 'binaryTransport.ts'),
  join(root, 'wasm', 'web', 'aeds.ts'),
  join(root, 'src', 'workers', 'wasmDecode.worker.ts')
];

for (const file of sourceChecks) {
  if (!existsSync(file)) {
    console.error(`[aot-check] source file missing: ${file}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log('[aot-check] ok');
