import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const sourceRoot = path.join(repositoryRoot, 'src/frontend/src')
const sourceFiles = collectTypeScriptFiles(sourceRoot)
const sourceByPath = new Map(sourceFiles.map((file) => [file, fs.readFileSync(file, 'utf8')]))
const graph = new Map(sourceFiles.map((file) => [file, resolveImports(file, sourceByPath.get(file))]))
const failures = []

const contractRoot = path.join(sourceRoot, 'contracts')
const binaryAdapterRoot = path.join(sourceRoot, 'adapters/binary')
const binaryTransportPath = path.join(sourceRoot, 'services/binaryTransport.ts')
const decoderRegistryPath = path.join(sourceRoot, 'composition/binaryDecoderRegistry.ts')
const composedTransportPath = path.join(sourceRoot, 'composition/binaryTransport.ts')
const retiredAdapterBarrelPath = path.join(binaryAdapterRoot, 'index.ts')

for (const [file, content] of sourceByPath) {
  if (file.startsWith(`${contractRoot}${path.sep}`)) {
    for (const imported of parseStaticImports(content)) {
      if (!imported.typeOnly) {
        failures.push(`${relative(file)}: contracts must not have runtime import ${imported.specifier}`)
      }
    }
  }

  if (file.startsWith(`${binaryAdapterRoot}${path.sep}`)) {
    assertNoImport(file, content, /^@\/api(?:\/|$)/u, 'binary adapter must not import API implementation')
  }

  if (file.startsWith(`${path.join(sourceRoot, 'api')}${path.sep}`)) {
    assertNoImport(file, content, /^@\/adapters\/binary(?:\/|$)/u, 'API must not import binary decoder adapter')
  }
}

const transportSource = requiredSource(binaryTransportPath)
assertNoImport(binaryTransportPath, transportSource, /^@\/adapters\/binary(?:\/|$)/u, 'binaryTransport must not import decoder adapter or barrel')
assertIncludes(binaryTransportPath, transportSource, 'createBinaryTransport', 'binaryTransport must expose decoder injection')
assertIncludes(binaryTransportPath, transportSource, 'BinaryFramePayloadDecoder', 'binaryTransport must consume the decoder contract')

const registrySource = requiredSource(decoderRegistryPath)
assertIncludes(decoderRegistryPath, registrySource, 'binaryFrameDecoderRegistry', 'composition root must own an explicit decoder registry')
assertIncludes(decoderRegistryPath, registrySource, 'decodeBinaryFramePayload', 'composition root must expose registry dispatch')
assertIncludes(decoderRegistryPath, registrySource, 'Object.freeze', 'decoder registry must be immutable after composition')

const compositionSource = requiredSource(composedTransportPath)
assertIncludes(composedTransportPath, compositionSource, 'createBinaryTransport(decodeBinaryFramePayload)', 'transport composition must inject the decoder registry')

if (fs.existsSync(retiredAdapterBarrelPath)) {
  failures.push(`${relative(retiredAdapterBarrelPath)}: retired binary adapter barrel must not exist`)
}

for (const component of stronglyConnectedComponents(graph)) {
  const hasSelfLoop = component.length === 1 && (graph.get(component[0]) ?? []).includes(component[0])
  if ((component.length > 1 || hasSelfLoop) && component.some(isBinaryArchitectureFile)) {
    failures.push(`binary import cycle: ${component.map(relative).sort().join(' -> ')}`)
  }
}

if (failures.length > 0) {
  console.error('[binary-import-boundaries] FAILED')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`[binary-import-boundaries] PASSED files=${sourceFiles.length}`)

function collectTypeScriptFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(resolved)
      } else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(resolved)
      }
    }
  }
  return files.sort()
}

function parseStaticImports(content) {
  const imports = []
  const pattern = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gu
  for (const match of content.matchAll(pattern)) {
    imports.push({
      specifier: match[3],
      typeOnly: Boolean(match[2])
    })
  }
  return imports
}

function resolveImports(importer, content) {
  const dependencies = new Set()
  for (const { specifier } of parseStaticImports(content)) {
    const candidate = specifier.startsWith('@/')
      ? path.join(sourceRoot, specifier.slice(2))
      : specifier.startsWith('.')
        ? path.resolve(path.dirname(importer), specifier)
        : null
    if (!candidate) continue
    const resolved = resolveSourceFile(candidate)
    if (resolved && sourceByPath.has(resolved)) dependencies.add(resolved)
  }
  return [...dependencies]
}

function resolveSourceFile(candidate) {
  for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const resolved = `${candidate}${suffix}`
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
  }
  return null
}

function stronglyConnectedComponents(inputGraph) {
  let nextIndex = 0
  const indices = new Map()
  const lowLinks = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  const visit = (node) => {
    indices.set(node, nextIndex)
    lowLinks.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const dependency of inputGraph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)))
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(dependency)))
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return
    const component = []
    while (stack.length > 0) {
      const member = stack.pop()
      onStack.delete(member)
      component.push(member)
      if (member === node) break
    }
    components.push(component)
  }

  for (const node of inputGraph.keys()) {
    if (!indices.has(node)) visit(node)
  }
  return components
}

function isBinaryArchitectureFile(file) {
  return file === binaryTransportPath
    || file === decoderRegistryPath
    || file === composedTransportPath
    || file.startsWith(`${binaryAdapterRoot}${path.sep}`)
    || file.startsWith(`${path.join(sourceRoot, 'api')}${path.sep}`)
}

function assertNoImport(file, content, forbidden, message) {
  for (const { specifier } of parseStaticImports(content)) {
    if (forbidden.test(specifier)) failures.push(`${relative(file)}: ${message}: ${specifier}`)
  }
}

function assertIncludes(file, content, token, message) {
  if (!content.includes(token)) failures.push(`${relative(file)}: ${message}`)
}

function requiredSource(file) {
  const content = sourceByPath.get(file)
  if (content === undefined) failures.push(`${relative(file)}: required architecture file is missing`)
  return content ?? ''
}

function relative(file) {
  return path.relative(repositoryRoot, file).split(path.sep).join('/')
}
