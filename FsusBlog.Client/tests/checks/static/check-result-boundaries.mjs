import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const clientRoot = process.cwd()

// Runtime-only guard. Dev/build scripts keep native throw semantics and are excluded by design.
const roots = [
  'src/api',
  'src/adapters',
  'src/services',
  'wasm/web'
]

const singleFiles = [
  'src/utils/wasmImageCodec.ts',
  'src/workers/pow.worker.ts',
  'src/composables/useAuthLogin.ts',
  'src/composables/useMfaActionFlow.ts',
  'src/composables/useAdminSettingsPage.ts',
  'src/composables/useHomeView.ts',
  'src/composables/useImageUploadRuntime.ts',
  'src/helpers/publicAotBundle.ts',
  'src/utils/imageCompression.ts',
  'src/view-contracts/publicPages.ts'
]

const allowList = new Set([
  'src/bootstrap/fullApp.ts',
  'src/public-renderers/hydrationIdentityGuard.ts'
])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(fullPath)
      continue
    }
    if (entry.isFile() && /\.(ts|tsx|vue|mjs)$/.test(entry.name)) {
      yield fullPath
    }
  }
}

const violations = []
for (const root of roots) {
  const rootPath = resolve(clientRoot, root)
  for await (const filePath of walk(rootPath)) {
    const relPath = relative(clientRoot, filePath).replaceAll('\\', '/')
    if (allowList.has(relPath)) {
      continue
    }

    const source = await readFile(filePath, 'utf8')
    const hasRawThrow = /\bthrow new Error\s*\(/.test(source)
    if (hasRawThrow) {
      violations.push(relPath)
    }
  }
}

for (const file of singleFiles) {
  const filePath = resolve(clientRoot, file)
  const source = await readFile(filePath, 'utf8')
  if (/\bthrow new Error\s*\(/.test(source)) {
    violations.push(file)
  }
}

if (violations.length > 0) {
  console.error('result-boundary violations:')
  for (const item of violations) {
    console.error(` - ${item}`)
  }
  process.exit(1)
}

console.log('ok: result boundaries do not use raw Error throws outside the allowlist')
