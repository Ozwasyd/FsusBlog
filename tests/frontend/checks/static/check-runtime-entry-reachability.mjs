import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from 'node:fs'
import {
  dirname,
  extname,
  join,
  relative,
  resolve
} from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const frontendRoot = join(repoRoot, 'src/frontend')
const sourceRoots = [
  join(frontendRoot, 'src'),
  join(frontendRoot, 'wasm/security'),
  join(frontendRoot, 'wasm/web')
]
const moduleExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.vue'])
const resolutionExtensions = [...moduleExtensions, '.json']

const declaredRuntimeEntries = [
  'src/main.ts',
  'src/bootstrap/preTheme.ts',
  'src/public-renderers/renderPublicPage.ts'
]

// #1274 owns replacing these generic-challenge placeholders with aggregate-proof
// execution or deleting them. They are deliberately not a permanent runtime
// allowlist: keeping the issue association visible makes the remaining cleanup
// an explicit integration obligation.
const pendingRuntimeIntegrations = new Map([
  ['src/components/security/FsusPasskeyStepUpChallenge.vue', '#1274'],
  ['src/components/admin/AdminFilterGroup.vue', '#1083'],
  ['src/performance/browserTaskScheduler.ts', '#1083'],
  ['src/views/user/Profile.vue', '#1083'],
])

function toFrontendPath(filePath) {
  return relative(frontendRoot, filePath).replaceAll('\\', '/')
}

function walkFiles(root) {
  if (!existsSync(root)) return []

  const files = []
  for (const entry of readdirSync(root)) {
    const filePath = join(root, entry)
    const stats = statSync(filePath)
    if (stats.isDirectory()) {
      files.push(...walkFiles(filePath))
    } else {
      files.push(filePath)
    }
  }
  return files
}

function isCompilationDeclaration(filePath) {
  return filePath.endsWith('.d.ts')
}

function isProductionModule(filePath) {
  return moduleExtensions.has(extname(filePath)) && !isCompilationDeclaration(filePath)
}

const productionModules = sourceRoots
  .flatMap(walkFiles)
  .filter(isProductionModule)
  .map((filePath) => resolve(filePath))
  .sort()

const productionModuleSet = new Set(productionModules)

function resolveFile(candidate) {
  const normalized = resolve(candidate)
  const candidates = [
    normalized,
    ...resolutionExtensions.map((extension) => `${normalized}${extension}`),
    ...resolutionExtensions.map((extension) => join(normalized, `index${extension}`))
  ]

  return candidates.find((filePath) => existsSync(filePath) && statSync(filePath).isFile()) ?? null
}

function localSpecifierBase(importer, specifier) {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0]
  if (cleanSpecifier.startsWith('@/')) {
    return resolve(frontendRoot, 'src', cleanSpecifier.slice(2))
  }
  if (cleanSpecifier.startsWith('@wasm/')) {
    return resolve(frontendRoot, 'wasm/web', cleanSpecifier.slice('@wasm/'.length))
  }
  if (cleanSpecifier.startsWith('/src/')) {
    return resolve(frontendRoot, cleanSpecifier.slice(1))
  }
  if (cleanSpecifier.startsWith('.')) {
    return resolve(dirname(importer), cleanSpecifier)
  }
  return null
}

function readImportSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1])
    }
  }
  return specifiers
}

function toKebabCase(name) {
  return name.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()
}

const autoImportedComponents = new Map()
for (const componentPath of walkFiles(join(frontendRoot, 'src/components')).filter((filePath) => filePath.endsWith('.vue'))) {
  const name = componentPath.slice(componentPath.lastIndexOf('/') + 1, -'.vue'.length)
  autoImportedComponents.set(name, resolve(componentPath))
  autoImportedComponents.set(toKebabCase(name), resolve(componentPath))
}

function readAutoImportedComponentEdges(filePath, source) {
  if (!filePath.endsWith('.vue')) return []

  const edges = new Set()
  for (const match of source.matchAll(/<([A-Za-z][\w-]*)\b/gu)) {
    const componentPath = autoImportedComponents.get(match[1])
    if (componentPath) edges.add(componentPath)
  }
  return edges
}

const roots = new Set(declaredRuntimeEntries.map((entry) => resolve(frontendRoot, entry)))

const contractMatrix = JSON.parse(readFileSync(join(repoRoot, 'tests/frontend/fixtures/cross-stack-contract-matrix.generated.json'), 'utf8'))
function addDeclaredContractEntries(value) {
  if (Array.isArray(value)) {
    for (const item of value) addDeclaredContractEntries(item)
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, item] of Object.entries(value)) {
    if (key === 'frontendWrapper' && typeof item === 'string') {
      const contractEntry = resolveFile(resolve(repoRoot, item))
      if (contractEntry) roots.add(contractEntry)
    } else {
      addDeclaredContractEntries(item)
    }
  }
}
addDeclaredContractEntries(contractMatrix)

const html = readFileSync(join(frontendRoot, 'index.html'), 'utf8')
for (const match of html.matchAll(/<script\b[^>]*\btype=['"]module['"][^>]*\bsrc=['"]([^'"]+)['"]/gu)) {
  const htmlEntry = resolveFile(resolve(frontendRoot, match[1].replace(/^\//u, '')))
  if (htmlEntry) roots.add(htmlEntry)
}

const unresolvedLocalImports = []
const visited = new Set()
const queue = [...roots]

while (queue.length > 0) {
  const filePath = queue.shift()
  if (visited.has(filePath)) continue
  if (!existsSync(filePath)) {
    unresolvedLocalImports.push(`<runtime-entry> -> ${toFrontendPath(filePath)}`)
    continue
  }

  visited.add(filePath)
  const source = readFileSync(filePath, 'utf8')
  const edges = new Set(readAutoImportedComponentEdges(filePath, source))

  for (const specifier of readImportSpecifiers(source)) {
    const base = localSpecifierBase(filePath, specifier)
    if (!base) continue

    const resolvedImport = resolveFile(base)
    if (!resolvedImport) {
      unresolvedLocalImports.push(`${toFrontendPath(filePath)} -> ${specifier}`)
      continue
    }
    if (isProductionModule(resolvedImport)) edges.add(resolve(resolvedImport))
  }

  for (const edge of edges) {
    if (!visited.has(edge)) queue.push(edge)
  }
}

const unreachable = productionModules.filter((filePath) => {
  const frontendPath = toFrontendPath(filePath)
  return !visited.has(filePath) && !pendingRuntimeIntegrations.has(frontendPath)
})
const invalidPendingIntegrations = [...pendingRuntimeIntegrations].flatMap(([frontendPath, issue]) => {
  const filePath = resolve(frontendRoot, frontendPath)
  if (!/^#[1-9]\d*$/u.test(issue)) return [`${frontendPath}: invalid issue owner ${issue}`]
  if (!productionModuleSet.has(filePath)) return [`${frontendPath}: pending integration file no longer exists`]
  if (visited.has(filePath)) return [`${frontendPath}: now reachable; remove its pending integration entry`]
  return []
})

if (unresolvedLocalImports.length > 0 || unreachable.length > 0 || invalidPendingIntegrations.length > 0) {
  if (unresolvedLocalImports.length > 0) {
    console.error('[runtime-entry-reachability] unresolved local imports:')
    for (const item of unresolvedLocalImports.sort()) console.error(`  - ${item}`)
  }
  if (unreachable.length > 0) {
    console.error('[runtime-entry-reachability] modules outside the runtime entry graph:')
    for (const filePath of unreachable) console.error(`  - ${toFrontendPath(filePath)}`)
  }
  if (invalidPendingIntegrations.length > 0) {
    console.error('[runtime-entry-reachability] invalid pending integrations:')
    for (const item of invalidPendingIntegrations) console.error(`  - ${item}`)
  }
  process.exitCode = 1
} else {
  const pending = [...pendingRuntimeIntegrations]
    .map(([filePath, issue]) => `${filePath} (${issue})`)
    .join(', ')
  console.log(`[runtime-entry-reachability] ok entries=${roots.size} modules=${productionModules.length} pending=${pending || 'none'}`)
}
