import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkFrontendTestLayout } from '../../tools/test/check-frontend-test-layout.mjs'
import {
  frontendTestDependencyDedupe,
  frontendTestSupportRoot,
  frontendUnitSetupFile,
  resolveFrontendTestSupportFile
} from '../../src/frontend/vitest.shared.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const canonicalManifest = JSON.parse(readFileSync(
  path.join(repositoryRoot, 'tests/governance/frontend-test-layout.json'),
  'utf8'
))
const temporaryRoots = []

function write(root, relativePath, contents = 'fixture\n') {
  const absolute = path.join(root, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents)
}

function writeManifest(root, manifest) {
  write(root, 'tests/governance/frontend-test-layout.json', `${JSON.stringify(manifest, null, 2)}\n`)
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'fsusblog-frontend-test-layout-'))
  temporaryRoots.push(root)
  const manifest = structuredClone(canonicalManifest)
  writeManifest(root, manifest)
  write(root, 'src/frontend/src/application.ts', 'export const application = true\n')

  for (const declaration of Object.values(manifest.categories)) {
    for (const directory of declaration.roots) write(root, `${directory}/fixture.txt`)
    for (const file of declaration.files) {
      write(root, file, file.endsWith('.json') ? '{}\n' : 'fixture\n')
    }
  }

  write(root, manifest.unitSetup.canonicalFile, "import './animationFrameEnvironment'\n")
  write(root, manifest.unitSetup.supportFiles[1], 'export const support = true\n')
  write(root, manifest.unitSetup.resolverModule, `
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../..', import.meta.url))
export const frontendUnitSetupFile = path.join(root, 'tests/frontend/support/unit/setup.ts')
export const frontendTestDependencyDedupe = ['happy-dom']
`.trimStart())
  write(root, 'src/frontend/vitest.transform-cache-coverage.mjs', 'export default {}\n')

  const setupConfigs = new Set(manifest.unitSetup.configs)
  for (const config of manifest.runnerConfiguration.files) {
    write(root, config, setupConfigs.has(config)
      ? `import { frontendTestDependencyDedupe, frontendUnitSetupFile } from './vitest.shared.mjs'\nexport default { resolve: { dedupe: frontendTestDependencyDedupe }, test: { setupFiles: [frontendUnitSetupFile] } }\n`
      : 'export default { test: {} }\n')
  }
  write(root, manifest.unitSetup.transformCacheIdentity, `export const inputs = [
  'tests/frontend/support/unit/setup.ts',
  'tests/frontend/support/unit/animationFrameEnvironment.ts'
]\n`)
  write(root, manifest.unitSetup.environmentConsumer, `
import { support } from '../../support/unit/animationFrameEnvironment'
export { support }
`.trimStart())
  write(root, manifest.visualFixture.module, 'export const fixture = true\n')
  const fixtureRelative = path.posix.relative(path.posix.dirname(manifest.visualFixture.consumer), manifest.visualFixture.module)
  write(root, manifest.visualFixture.consumer, `
import { fileURLToPath } from 'node:url'
const moduleUrl = \`/@fs/\${fileURLToPath(new URL('${fixtureRelative}', import.meta.url))}\`
export { moduleUrl }
`.trimStart())
  write(root, manifest.visualFixture.viteConfig, `export default ({ command }) => ({ resolve: { dedupe: command === 'serve' ? ['vue', 'vue-router'] : [] } })\n`)
  return { root, manifest }
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

test('accepts the canonical repository and distinguishes every declared ownership category', async () => {
  assert.deepEqual(await checkFrontendTestLayout(repositoryRoot), [])
  assert.deepEqual(await checkFrontendTestLayout(createFixture().root), [])
})

test('shared setup resolver stays canonical and rejects absolute or escaping support paths', () => {
  assert.equal(frontendTestSupportRoot, path.join(repositoryRoot, 'tests/frontend/support'))
  assert.equal(frontendUnitSetupFile, path.join(frontendTestSupportRoot, 'unit/setup.ts'))
  assert.deepEqual(frontendTestDependencyDedupe, ['happy-dom'])
  assert.throws(() => resolveFrontendTestSupportFile('../unit/setup.ts'), /escapes the canonical support root/u)
  assert.throws(() => resolveFrontendTestSupportFile(path.resolve('/tmp/setup.ts')), /must be a non-empty relative path/u)
  assert.throws(() => resolveFrontendTestSupportFile(''), /must be a non-empty relative path/u)
})

test('rejects a reintroduced secondary source test root even when its files look valid', async () => {
  const { root } = createFixture()
  write(root, 'src/frontend/tests/frontend/unit/rogue.test.ts', 'export {}\n')

  const errors = await checkFrontendTestLayout(root)
  assert.ok(errors.some((error) => error.includes('retired frontend test root exists: src/frontend/tests')))
  assert.ok(errors.some((error) => error.includes('retired frontend test root exists: src/frontend/tests/frontend')))
  assert.ok(errors.some((error) => error.includes('source-local test tree is forbidden')))
})

test('permits only an explicit reasoned source-test exception outside the retired frontend root', async () => {
  const { root, manifest } = createFixture()
  write(root, 'src/frontend/legacy/tests/toolchain/probe.ts', 'export {}\n')
  manifest.sourceTestAllowlist = [{
    path: 'src/frontend/legacy/tests/toolchain',
    reason: 'fixture proves the exception mechanism remains explicit and narrow'
  }]
  writeManifest(root, manifest)

  assert.deepEqual(await checkFrontendTestLayout(root), [])
})

test('rejects unresolved or independently wired setupFiles paths across Vitest configs', async () => {
  const { root, manifest } = createFixture()
  const config = manifest.unitSetup.configs[0]
  write(root, config, "export default { test: { setupFiles: ['./missing.ts'] } }\n")
  rmSync(path.join(root, manifest.unitSetup.canonicalFile))

  const errors = await checkFrontendTestLayout(root)
  assert.ok(errors.some((error) => error.includes(`canonical frontend unit support file must be an existing file: ${manifest.unitSetup.canonicalFile}`)))
  assert.ok(errors.some((error) => error.includes(`${config} must import frontendUnitSetupFile`)))
  assert.ok(errors.some((error) => error.includes(`${config} must declare setupFiles: [frontendUnitSetupFile] exactly once`)))
  assert.ok(errors.some((error) => error.includes('does not resolve to a file')))
})

test('rejects unclassified paths, undeclared support namespaces, and setup code outside support', async () => {
  const { root } = createFixture()
  write(root, 'tests/frontend/rogue/support/helper.ts', 'export {}\n')
  write(root, 'tests/frontend/unit/setup.ts', 'export {}\n')

  const errors = await checkFrontendTestLayout(root)
  assert.ok(errors.some((error) => error.includes('frontend test path has no ownership category: tests/frontend/rogue/support/helper.ts')))
  assert.ok(errors.some((error) => error.includes('undeclared frontend test support namespace: tests/frontend/rogue/support')))
  assert.ok(errors.some((error) => error.includes('frontend test setup must live in a declared support namespace: tests/frontend/unit/setup.ts')))
})

test('rejects transform-cache identity drift and imports back into the retired source root', async () => {
  const { root, manifest } = createFixture()
  write(root, manifest.unitSetup.transformCacheIdentity, `export const inputs = ['src/frontend/tests/frontend/unit/setup.ts']\n`)
  write(root, manifest.unitSetup.environmentConsumer, `
import { support } from '../../../../src/frontend/tests/frontend/unit/animationFrameEnvironment'
export { support }
`.trimStart())

  const errors = await checkFrontendTestLayout(root)
  for (const supportFile of manifest.unitSetup.supportFiles) {
    assert.ok(errors.some((error) => error.includes(`transform-cache identity omits canonical support input: ${supportFile}`)))
  }
  assert.ok(errors.some((error) => error.includes('transform-cache identity still accepts the retired frontend test root')))
  assert.ok(errors.some((error) => error.includes('must import animationFrameEnvironment from canonical unit support')))
  assert.ok(errors.some((error) => error.includes('still imports from the retired frontend test root')))
})

test('rejects a visual fixture served from the retired Vite-root path without package dedupe', async () => {
  const { root, manifest } = createFixture()
  write(root, manifest.visualFixture.consumer, '<script type="module" src="/tests/frontend/fixtures/adminDashboardWorkbenchVisual.ts"></script>\n')
  write(root, manifest.visualFixture.viteConfig, 'export default { resolve: { alias: [] } }\n')

  const errors = await checkFrontendTestLayout(root)
  assert.ok(errors.some((error) => error.includes('must serve the canonical visual fixture through a fileURLToPath /@fs/ URL')))
  assert.ok(errors.some((error) => error.includes('still serves the retired source-local visual fixture')))
  assert.ok(errors.some((error) => error.includes('must limit repository-level browser-fixture dedupe to Vite serve mode')))
  assert.ok(errors.some((error) => error.includes('must dedupe vue for repository-level browser fixtures')))
  assert.ok(errors.some((error) => error.includes('must dedupe vue-router for repository-level browser fixtures')))
})
