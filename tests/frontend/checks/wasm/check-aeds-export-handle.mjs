#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const temp = mkdtempSync(resolve(tmpdir(), 'fsusblog-aeds-export-handle-'))
const compiler = process.env.CLANGXX || 'clang++'
const include = resolve(root, 'src/frontend/wasm/aeds/include')
const decoderSources = [
  resolve(root, 'src/frontend/wasm/aeds/src/aeds_crc32.cpp'),
  resolve(root, 'src/frontend/wasm/aeds/src/aeds_decode.cpp'),
  resolve(root, 'src/frontend/wasm/aeds/src/pod_parse_article.cpp')
]
const common = [
  '-std=c++23', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-O1', '-g',
  '-fno-omit-frame-pointer', '-fno-sanitize-recover=undefined',
  `-I${root}`, `-I${include}`
]

function run(command, args, label, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...environment }
  })
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`)
  }
}

try {
  const contract = resolve(temp, 'aeds-export-handle-contract')
  run(compiler, [
    ...common,
    '-fsanitize=address,undefined',
    resolve(root, 'tests/frontend/fixtures/aeds-export-handle-contract.cpp'),
    ...decoderSources,
    '-o', contract
  ], 'ASAN/UBSAN contract build')
  run(contract, [], 'ASAN/UBSAN handle contract', {
    ASAN_OPTIONS: 'abort_on_error=1:detect_leaks=1',
    UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1'
  })

  const fuzzer = resolve(temp, 'aeds-export-handle-fuzz')
  run(compiler, [
    ...common,
    '-fsanitize=fuzzer,address,undefined',
    resolve(root, 'tests/frontend/fixtures/aeds-export-handle-fuzz.cpp'),
    ...decoderSources,
    '-o', fuzzer
  ], 'libFuzzer build')
  run(fuzzer, ['-runs=256', '-max_len=8192', '-timeout=5'], 'libFuzzer handle run', {
    ASAN_OPTIONS: 'abort_on_error=1:detect_leaks=1',
    UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1'
  })

  console.log('[aeds-export-handle] ok sanitizer=address,undefined fuzz=libFuzzer runs=256')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
