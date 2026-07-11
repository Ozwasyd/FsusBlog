#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  delegatedSourceLockOwners as delegatedSourceLockOwnerEntries,
  fixtureReaderOwners as fixtureReaderOwnerEntries
} from './frontend-source-locking-migration-plan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const frontendRoot = resolve(root, 'src/frontend')
const require = createRequire(import.meta.url)
const ts = require(require.resolve('typescript', { paths: [frontendRoot] }))
const pkg = JSON.parse(readFileSync(resolve(root, 'src/frontend/package.json'), 'utf8'))
const matrix = readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8')
const legacyTestSh = readFileSync(resolve(root, 'tools/test/legacy-test.sh'), 'utf8')
const localBundleRunner = readFileSync(resolve(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8')
const productionVitestConfig = readFileSync(resolve(root, 'src/frontend/vitest.production.config.ts'), 'utf8')
const runtimeManifest = readFileSync(resolve(root, 'tests/frontend/checks/runtime/manifest.json'), 'utf8')
const staticManifest = readFileSync(resolve(root, 'tests/frontend/checks/static/manifest.json'), 'utf8')
const viteConfig = readFileSync(resolve(root, 'src/frontend/vite.config.ts'), 'utf8')
const errors = []

function fail(message) {
  errors.push(message)
}

const fixtureReaderOwners = new Map(fixtureReaderOwnerEntries.map(({ path, reason }) => [path, reason]))

// Final handoff keeps this map empty. Retaining the mechanism makes any future
// delegation visible in the summary without granting a permanent exemption.
const delegatedSourceLockOwners = new Map(
  delegatedSourceLockOwnerEntries.map(({ path, owner }) => [path, owner])
)

function walkUnitTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(dir, entry.name)
    if (entry.isDirectory()) return walkUnitTests(absolute)
    return /\.(?:test|spec)\.tsx?$/u.test(entry.name) ? [absolute] : []
  })
}

function sourceLockViolations(source, fileName) {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  const directReaders = new Set()
  const fsNamespaces = new Set()
  const violations = []

  const fsModules = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises'])

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (/\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/u.test(statement.moduleSpecifier.text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(statement.moduleSpecifier.getStart(sourceFile))
      violations.push({
        kind: 'test-source-import',
        line: position.line + 1,
        column: position.character + 1
      })
    }
    if (!fsModules.has(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) fsNamespaces.add(clause.name.text)
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) fsNamespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text
        if (['readFile', 'readFileSync'].includes(imported)) directReaders.add(element.name.text)
        if (imported === 'promises') fsNamespaces.add(element.name.text)
      }
    }
  }

  const collectCommonJsReaders = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'require'
      && node.initializer.arguments.length === 1
      && ts.isStringLiteral(node.initializer.arguments[0])
      && fsModules.has(node.initializer.arguments[0].text)
    ) {
      if (ts.isIdentifier(node.name)) fsNamespaces.add(node.name.text)
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.getText(sourceFile)
          if (['readFile', 'readFileSync'].includes(imported) && ts.isIdentifier(element.name)) {
            directReaders.add(element.name.text)
          }
          if (imported === 'promises' && ts.isIdentifier(element.name)) fsNamespaces.add(element.name.text)
        }
      }
    }
    ts.forEachChild(node, collectCommonJsReaders)
  }
  collectCommonJsReaders(sourceFile)

  const addViolation = (node, kind) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({ kind, line: position.line + 1, column: position.character + 1 })
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)) {
        if (directReaders.has(callee.text)) addViolation(callee, 'filesystem-source-read')
        if (/^(?:readRepoFile|repoFile|readSourceFile|readProductionFile)$/u.test(callee.text)) {
          addViolation(callee, 'source-lock-helper')
        }
      } else if (ts.isPropertyAccessExpression(callee) && ['readFile', 'readFileSync'].includes(callee.name.text)) {
        const directNamespace = ts.isIdentifier(callee.expression)
          && fsNamespaces.has(callee.expression.text)
        const promisesNamespace = ts.isPropertyAccessExpression(callee.expression)
          && callee.expression.name.text === 'promises'
          && ts.isIdentifier(callee.expression.expression)
          && fsNamespaces.has(callee.expression.expression.text)
        if (directNamespace || promisesNamespace) addViolation(callee, 'filesystem-source-read')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function assertSourceLockingFixtures() {
  const positivePath = resolve(root, 'tests/frontend/fixtures/source-locking/behavior-import.fixture.ts')
  const negativePath = resolve(root, 'tests/frontend/fixtures/source-locking/source-read.fixture.ts')
  const positive = sourceLockViolations(readFileSync(positivePath, 'utf8'), positivePath)
  const negative = sourceLockViolations(readFileSync(negativePath, 'utf8'), negativePath)
  if (positive.length > 0) fail(`source-locking positive fixture produced ${positive.length} violation(s)`)
  if (!negative.some((violation) => violation.kind === 'filesystem-source-read')) {
    fail('source-locking negative fixture did not detect filesystem source read')
  }
  if (!negative.some((violation) => violation.kind === 'source-lock-helper')) {
    fail('source-locking negative fixture did not detect readRepoFile/repoFile helper')
  }
  if (!negative.some((violation) => violation.kind === 'test-source-import')) {
    fail('source-locking negative fixture did not detect another test source import')
  }
}

function enforceActiveUnitSourceLocking() {
  const unitRoot = resolve(root, 'tests/frontend/unit')
  let scanned = 0
  for (const absolute of walkUnitTests(unitRoot)) {
    const relative = absolute.slice(root.length + 1).replaceAll('\\', '/')
    const violations = sourceLockViolations(readFileSync(absolute, 'utf8'), relative)
    if (fixtureReaderOwners.has(relative)) {
      if (violations.length === 0) fail(`${relative}: stale fixture-reader allowlist entry`)
      continue
    }
    if (delegatedSourceLockOwners.has(relative)) {
      if (violations.length === 0) fail(`${relative}: delegated source-lock entry is ready to remove`)
      continue
    }
    scanned += 1
    for (const violation of violations) {
      fail(`${relative}:${violation.line}:${violation.column} ${violation.kind}; use behavior imports/mounts or a static-governance owner`)
    }
  }
  return scanned
}

function requireScript(name) {
  if (!pkg.scripts?.[name]) {
    fail(`missing package script ${name}`)
  }
}

function requireFile(path) {
  if (!existsSync(resolve(root, path))) {
    fail(`missing file ${path}`)
  }
}

function legacyFastGateRuns(script) {
  return legacyTestSh.includes(`npm run ${script}`)
    || legacyTestSh.includes(`run_vitest_script ${script}`)
    || runtimeManifest.includes(`"script": "${script}"`)
    || staticManifest.includes(`"script": "${script}"`)
    || (script === 'test:property' && productionVitestConfig.includes('vitest.property.config'))
    || (script === 'check:frontend-state-machines' && productionVitestConfig.includes('vitest.model.config'))
    || (script === 'check:frontend-perf-regression' && productionVitestConfig.includes('vitest.perf.config'))
}

const coverageProfiles = [
  ['coverage:unit-core', 'src/frontend/vitest.unit-core.config.ts', 'coverage/unit-core'],
  ['coverage:public-renderers', 'src/frontend/vitest.public-renderers.config.ts', 'src/public-renderers'],
  ['coverage:bootstrap-hydration', 'src/frontend/vitest.bootstrap-hydration.config.ts', 'src/bootstrap'],
  ['coverage:workers', 'src/frontend/vitest.workers.config.ts', 'src/workers'],
  ['coverage:wasm-bridges', 'src/frontend/vitest.wasm-bridges.config.ts', 'src/wasm'],
  ['coverage:adapters-binary', 'src/frontend/vitest.adapters-binary.config.ts', 'src/adapters/binary'],
  ['coverage:composables-state', 'src/frontend/vitest.composables-state.config.ts', 'src/composables']
]

for (const [script, config, marker] of coverageProfiles) {
  requireScript(script)
  requireFile(config)
  const source = readFileSync(resolve(root, config), 'utf8')
  if (!source.includes(marker)) {
    fail(`${config} does not target ${marker}`)
  }
  if (!source.includes('thresholds')) {
    fail(`${config} has no coverage thresholds`)
  }
}

for (const script of [
  'test:property',
  'check:frontend-state-machines',
  'check:frontend-perf-regression',
  'check:worker-contracts',
  'check:a11y:deep',
  'check:frontend-test-governance',
  'prepare:playwright:fixtures',
  'capture:manual-layout-screenshots'
]) {
  requireScript(script)
}

const manualScreenshotScript = pkg.scripts?.['capture:manual-layout-screenshots'] ?? ''
if (!manualScreenshotScript.includes('prepare:playwright:fixtures')) {
  fail('capture:manual-layout-screenshots must refresh Playwright fixtures before capture')
}
if (!manualScreenshotScript.includes('manual/manual-layout-screenshots.spec.ts')) {
  fail('capture:manual-layout-screenshots must run the route-driven manual screenshot spec')
}
if (!manualScreenshotScript.includes('FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1')) {
  fail('capture:manual-layout-screenshots must suppress human-read proof side effects during screenshot capture')
}
if (
  !viteConfig.includes('createServerFsAllow')
  || !viteConfig.includes('fs.realpathSync')
  || !viteConfig.includes("path.resolve(FRONTEND_ROOT, 'node_modules')")
  || !viteConfig.includes('fsusUiWasmDist')
  || !viteConfig.includes('tryRealpath(fsusUiWasmDist)')
) {
  fail('vite dev server fs allow must include real node_modules and local FsusUI wasm dist paths for manual screenshot assets')
}

for (const dir of ['tests/frontend/property', 'tests/frontend/model', 'tests/frontend/benchmarks']) {
  requireFile(dir)
}

for (const token of [
  'test:property',
  'check:frontend-state-machines',
  'check:worker-contracts',
  'check:frontend-perf-regression',
  'check:a11y:deep',
  'check:frontend-test-governance'
]) {
  if (!legacyFastGateRuns(token)) {
    fail(`fast gate does not run ${token}`)
  }
}

if (!matrix.includes('version: fsusblog-test-matrix-v2') || !matrix.includes('risk:') || !matrix.includes('coverage:')) {
  fail('tests/matrix.yml lacks v2 version/risk/coverage traceability fields')
}

assertSourceLockingFixtures()
const sourceLockingScanned = enforceActiveUnitSourceLocking()

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[frontend-test-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[frontend-test-governance] ok profiles=${coverageProfiles.length} sourceLockingScanned=${sourceLockingScanned} delegated=${delegatedSourceLockOwners.size} fixtureReaders=${fixtureReaderOwners.size}`)
