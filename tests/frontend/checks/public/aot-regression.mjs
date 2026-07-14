#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const repoRoot = join(root, '..', '..');
const wasmDir = join(root, 'public', 'wasm');
const joinToken = (...parts) => parts.join('');

const checks = [
  { file: join(wasmDir, 'aeds_decoder_basic.js'), label: 'aeds_decoder_basic.js' },
  { file: join(wasmDir, 'aeds_decoder_basic.wasm'), label: 'aeds_decoder_basic.wasm' },
  { file: join(wasmDir, 'aeds_decoder_speed.js'), label: 'aeds_decoder_speed.js' },
  { file: join(wasmDir, 'aeds_decoder_speed.wasm'), label: 'aeds_decoder_speed.wasm' },
  { file: join(wasmDir, 'aeds-runtime-manifest.json'), label: 'aeds-runtime-manifest.json' },
  { file: join(wasmDir, 'fsus_pow_simd.js'), label: 'fsus_pow_simd.js' },
  { file: join(wasmDir, 'fsus_pow_simd.wasm'), label: 'fsus_pow_simd.wasm' },
  { file: join(wasmDir, 'fsus_pow_basic.js'), label: 'fsus_pow_basic.js' },
  { file: join(wasmDir, 'fsus_pow_basic.wasm'), label: 'fsus_pow_basic.wasm' },
  { file: join(wasmDir, 'image_codec_simd.js'), label: 'image_codec_simd.js' },
  { file: join(wasmDir, 'image_codec_simd.wasm'), label: 'image_codec_simd.wasm' },
  { file: join(wasmDir, 'image_codec_basic.js'), label: 'image_codec_basic.js' },
  { file: join(wasmDir, 'image_codec_basic.wasm'), label: 'image_codec_basic.wasm' }
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

const decoderJsPaths = [
  join(wasmDir, 'aeds_decoder_basic.js'),
  join(wasmDir, 'aeds_decoder_speed.js')
];
const requiredSymbols = [
  'decode_io_buffer',
  'reserve_io_buffer',
  'clear_io_buffer',
  'get_last_payload_ptr',
  'get_last_payload_len',
  'get_last_frame_type'
];

for (const decoderJsPath of decoderJsPaths) {
  const decoderJs = readFileSync(decoderJsPath, 'utf8');
  for (const symbol of requiredSymbols) {
    if (!decoderJs.includes(symbol)) {
      console.error(`[aot-check] export symbol not found in ${decoderJsPath}: ${symbol}`);
      failed = true;
    }
  }
}

const sourceChecks = [
  join(root, 'src', 'services', 'binaryTransport.ts'),
  join(root, 'wasm', 'web', 'aeds.ts'),
  join(root, 'src', 'workers', 'wasmDecode.worker.ts'),
  join(repoRoot, 'src', 'backend', 'Infrastructure', 'PublicAot', 'PublicAotNodeSsrRenderer.cs')
];

for (const file of sourceChecks) {
  if (!existsSync(file)) {
    console.error(`[aot-check] source file missing: ${file}`);
    failed = true;
  }
}

const forbiddenFiles = [
  join(root, 'src', 'components', joinToken('Aot', 'Host.vue')),
  join(root, 'src', 'composables', joinToken('use', 'Aot', 'RenderBridge.ts')),
  join(root, 'src', 'renderers', 'aot', 'index.ts')
];

for (const file of forbiddenFiles) {
  if (existsSync(file)) {
    console.error(`[aot-check] legacy source should be removed: ${file}`);
    failed = true;
  }
}

const legacySourceScans = [
  {
    file: join(root, 'src', 'services', 'binaryTransport.ts'),
    forbidden: [
      joinToken('fsus:binary:', 'rendered'),
      joinToken('render', 'Html'),
      joinToken('render', 'Context')
    ]
  },
  {
    file: join(root, 'src', 'workers', 'wasmDecode.worker.ts'),
    forbidden: [
      joinToken('rendered', 'Html'),
      joinToken('render', 'Html'),
      joinToken('render', 'Context')
    ]
  },
  {
    file: join(root, 'wasm', 'web', 'aeds.ts'),
    forbidden: [
      joinToken('handle', 'Aot', 'Event'),
      joinToken('render', '_view'),
      joinToken('get_last_', 'html_ptr'),
      joinToken('get_last_', 'html_len'),
      joinToken('handle', '_event')
    ]
  }
];

for (const scan of legacySourceScans) {
  const content = readFileSync(scan.file, 'utf8');
  for (const forbidden of scan.forbidden) {
    if (content.includes(forbidden)) {
      console.error(`[aot-check] legacy marker still present in ${scan.file}: ${forbidden}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('[aot-check] ok');
