import fs from 'node:fs'
import path from 'node:path'

const generatedDirectories = Object.freeze([
  '.tmp',
  'src/frontend/coverage',
  'src/frontend/test-results',
  'src/frontend/dist',
  'src/frontend/public/wasm',
  'src/frontend/wasm/.artifacts',
  'src/frontend/wasm/build-basic',
  'src/frontend/wasm/build-simd',
  'src/frontend/wasm/build-pow-relaxed',
  'src/frontend/wasm/build-pow-threads',
  'src/backend/wwwroot',
  'src/backend/bin',
  'src/backend/obj',
  'src/core/bin',
  'src/core/obj',
  'src/shared/bin',
  'src/shared/obj',
  'src/frontend/bin',
  'src/frontend/obj',
  'tests/backend/bin',
  'tests/backend/obj',
  'benchmarks/core/bin',
  'benchmarks/core/obj',
  'ops/docker/bin',
  'ops/docker/obj'
])

export function localProductionGeneratedDirectories() {
  return [...generatedDirectories]
}

export function cleanLocalProductionOutputs(root) {
  const resolvedRoot = path.resolve(root)
  const emscriptenCache = path.join(resolvedRoot, '.tmp/emscripten-cache')
  const preservedCache = path.join(resolvedRoot, `.fsusblog-emscripten-cache-${process.pid}`)
  fs.rmSync(preservedCache, { recursive: true, force: true })
  if (fs.existsSync(emscriptenCache)) fs.renameSync(emscriptenCache, preservedCache)
  try {
    for (const relativeDirectory of generatedDirectories) {
      const target = path.resolve(resolvedRoot, relativeDirectory)
      if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`refusing to clean path outside repository root: ${relativeDirectory}`)
      }
      fs.rmSync(target, { recursive: true, force: true })
    }
  } finally {
    if (fs.existsSync(preservedCache)) {
      fs.mkdirSync(path.dirname(emscriptenCache), { recursive: true })
      fs.renameSync(preservedCache, emscriptenCache)
    }
  }
}
