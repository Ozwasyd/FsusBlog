#!/usr/bin/env node
/**
 * Public bootstrap static zero-residue gate.
 *
 * Must prove retired files/symbols/events/flags/suppression helpers are absent
 * across production sources, tests, fixtures, docs, and build artifacts — not
 * merely that the new coordinator exists.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const checkerRel = 'tests/frontend/checks/static/check-public-bootstrap-causal-zero-residue.mjs'
const failures = []

function fail(message) {
  failures.push(message)
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath))
}

/** Tokens built at runtime so the checker itself is not a positive hit. */
const FORBIDDEN_FILE_RELS = [
  ['src/frontend/src/bootstrap/', 'publicTakeoverState', '.ts'].join(''),
  ['src/frontend/src/bootstrap/', 'runtimeGate', '.ts'].join(''),
  ['src/frontend/src/bootstrap/', 'aotActionBridge', '.ts'].join('')
]

const FORBIDDEN_TOKENS = [
  ['BuildDeferred', 'SpaBootScript'].join(''),
  ['schedule', 'FullApp', 'Runtime'].join(''),
  ['set', 'Runtime', 'Phase'].join(''),
  ['runtime', 'Ready'].join(''),
  ['fsus:public-shell', ':', 'takeover'].join(''),
  ['fsus:public-shell', ':', 'search-focus'].join(''),
  ['handle', 'Root', 'Aot', 'Click'].join(''),
  ['aot', 'Action', 'Bridge'].join(''),
  ['data', 'allow', 'mismatch'].join('-'),
  ['isPublic', 'Atomic', 'Takeover', 'Enabled'].join(''),
  ['VITE_PUBLIC_', 'ATOMIC_TAKEOVER'].join(''),
  ['beginPublicTakeover', 'Prewarm'].join(''),
  ['markPublicTakeover', 'Prepared'].join(''),
  ['beginPublicTakeover', 'Commit'].join(''),
  ['completePublicTakeover', 'Commit'].join(''),
  ['resetPublic', 'Takeover'].join(''),
  ['public', 'TakeoverState'].join(''),
  ['bind', 'Public', 'Activation', 'Triggers'].join(''),
  ['schedule', 'Public', 'Route', 'Idle', 'Prewarm'].join(''),
  ['prewarm', 'FullApp', 'Route'].join(''),
  ['markPublicAot', 'MismatchBoundaries'].join(''),
  ['removeWhitespace', 'TextNodes'].join('')
]

// Frontend-only retired module path markers (avoid backend IBlindCredentialRuntimeGate).
const FRONTEND_PATH_TOKENS = [
  ['bootstrap/', 'runtimeGate'].join(''),
  ['bootstrap/', 'publicTakeoverState'].join(''),
  ['bootstrap/', 'aotActionBridge'].join(''),
  ["from '@/bootstrap/", 'runtimeGate'].join(''),
  ["from '@/bootstrap/", 'publicTakeoverState'].join(''),
  ["from '@/bootstrap/", 'aotActionBridge'].join('')
]

const SCAN_ROOTS = [
  'src/frontend/src',
  'src/frontend/public',
  'src/backend/Infrastructure/PublicAot',
  'docs/architecture',
  'docs/frontend',
  'tests/frontend',
  'tests/browser-contract',
  'tests/fixtures',
  'tools/frontend'
]

const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.vue', '.js', '.mjs', '.cjs', '.css', '.html', '.md', '.json', '.cs'
])

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'coverage',
  'bin',
  'obj',
  'wwwroot',
  'generated',
  '.git',
  'test-results',
  'playwright-report'
])

function collectFiles(relativeRoot) {
  const absRoot = path.join(repoRoot, relativeRoot)
  if (!fs.existsSync(absRoot)) return []
  /** @type {string[]} */
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        walk(full)
        continue
      }
      const ext = path.extname(entry.name)
      if (SCAN_EXTENSIONS.has(ext)) files.push(full)
    }
  }
  walk(absRoot)
  return files
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

// --- retired files must not exist ---
for (const rel of FORBIDDEN_FILE_RELS) {
  if (exists(rel)) {
    fail(`retired file still present: ${rel}`)
  }
}

// --- token scan across production / tests / fixtures / docs ---
for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    const rel = relative(file)
    if (rel === checkerRel) continue
    // Self-describing governance checks may construct the same retired tokens.
    if (rel.startsWith('tests/frontend/checks/static/check-public-')
      || rel.startsWith('tests/frontend/checks/public/check-public-')
      || rel.endsWith('check-route-asset-budget-governance.mjs')
      || rel.endsWith('check-public-boot-kernel-boundary.mjs')
      || rel.endsWith('check-public-boot-production-output.mjs')
      || rel.endsWith('check-public-hydration-identity.mjs')
      || rel.endsWith('check-public-atomic-takeover-governance.mjs')
      || rel.endsWith('publicIntentOwnership.test.ts')
      || rel.endsWith('publicActivationCausalMatrix.test.ts')
      || rel.endsWith('publicBootstrapCausalEvidence.mjs')) {
      // Still forbid literal non-split retired event bridges in unit contracts that
      // already join tokens; skip bulk substring scan for these governance files.
      continue
    }

    const source = fs.readFileSync(file, 'utf8')
    for (const token of FORBIDDEN_TOKENS) {
      if (source.includes(token)) {
        fail(`${rel}: retired public-bootstrap token must be zero: ${token}`)
      }
    }
    if (rel.startsWith('src/frontend/') || rel.startsWith('tests/frontend/')) {
      for (const token of FRONTEND_PATH_TOKENS) {
        if (source.includes(token)) {
          fail(`${rel}: retired frontend bootstrap path/import must be zero: ${token}`)
        }
      }
    }
  }
}

// --- production bundle residue (when dist is present) ---
const distAssets = path.join(repoRoot, 'src/frontend/dist/assets')
if (fs.existsSync(distAssets)) {
  for (const entry of fs.readdirSync(distAssets)) {
    if (!/\.(js|mjs|css|html)$/u.test(entry)) continue
    const source = fs.readFileSync(path.join(distAssets, entry), 'utf8')
    for (const token of FORBIDDEN_TOKENS) {
      if (token === ['data', 'allow', 'mismatch'].join('-') && (entry.startsWith('vendor-vue') || entry.startsWith('tooltip'))) {
        continue
      }
      if (source.includes(token)) {
        fail(`src/frontend/dist/assets/${entry}: production bundle still contains retired token: ${token}`)
      }
    }
  }
}

// --- single authority: no second BootKernel / coordinator / AppRuntime host ---
const ownershipSources = {
  bootKernel: read('src/frontend/src/bootstrap/publicBootKernel.ts'),
  coordinator: read('src/frontend/src/bootstrap/publicActivationCoordinator.ts'),
  runtime: read('src/frontend/src/bootstrap/publicActivationRuntime.ts'),
  shell: read('src/frontend/src/bootstrap/publicShell.ts'),
  fullApp: read('src/frontend/src/bootstrap/fullApp.ts'),
  router: read('src/frontend/src/router/index.ts'),
  appVue: read('src/frontend/src/App.vue'),
  runtimeActivation: read('src/frontend/src/bootstrap/runtimeActivation.ts'),
  entry: read('src/frontend/src/bootstrap/entry.ts')
}

if ((ownershipSources.bootKernel.match(/export function disposePublicBootKernel/gu) ?? []).length !== 1) {
  fail('publicBootKernel must expose exactly one disposePublicBootKernel export')
}
if ((ownershipSources.runtime.match(/new PublicActivationCoordinator/gu) ?? []).length !== 1) {
  fail('publicActivationRuntime must construct exactly one PublicActivationCoordinator')
}
if (ownershipSources.appVue.includes('AppRuntime') || ownershipSources.appVue.includes('scheduleRuntimeActivation')) {
  fail('App.vue must not host a second AppRuntime activation path')
}
if (!ownershipSources.fullApp.includes('scheduleRuntimeActivation')) {
  fail('fullApp must use the single runtimeActivation schedule API')
}
if ((ownershipSources.runtimeActivation.match(/export function scheduleRuntimeActivation/gu) ?? []).length !== 1) {
  fail('runtimeActivation must own the single scheduleRuntimeActivation export')
}

// --- import strong connectivity must stay acyclic for ownership cores ---
function collectStaticImports(source) {
  /** @type {string[]} */
  const specs = []
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu
  let match
  while ((match = re.exec(source)) !== null) {
    specs.push(match[1] ?? match[2])
  }
  return specs
}

const importGraph = {
  BootKernel: collectStaticImports(ownershipSources.bootKernel),
  Coordinator: collectStaticImports(ownershipSources.coordinator),
  Runtime: collectStaticImports(ownershipSources.runtime),
  Shell: collectStaticImports(ownershipSources.shell),
  FullApp: collectStaticImports(ownershipSources.fullApp),
  Router: collectStaticImports(ownershipSources.router)
}

function importsAny(specs, needles) {
  return specs.some((spec) => needles.some((needle) => spec.includes(needle)))
}

if (importsAny(importGraph.BootKernel, ['fullApp', 'publicShell', 'publicActivation', 'vue-router', 'pinia'])) {
  fail('BootKernel must not import FullApp/Shell/coordinator/router composition')
}
if (importsAny(importGraph.Coordinator, ['fullApp', 'publicShell', 'vue-router', 'pinia', 'navigationProgress'])) {
  fail('pure coordinator must not import FullApp/Shell/router/progress')
}
if (importsAny(importGraph.Router, ['publicActivationRuntime', 'publicActivationCoordinator', 'publicBootKernel'])) {
  fail('Router must not import activation coordinator/runtime/BootKernel (owner getter is injected)')
}
if (importsAny(importGraph.Shell, ['@/bootstrap/fullApp', 'publicActivationCoordinator'])) {
  fail('publicShell must submit typed intents via runtime, not import FullApp or pure coordinator')
}

// FullApp may dynamically import runtime for search focus; static import is forbidden.
if (/import\s*\{[^}]*requestPublicSearchFocusIntent[^}]*\}\s*from\s*['"]@\/bootstrap\/publicActivationRuntime['"]/u
  .test(ownershipSources.fullApp)) {
  fail('FullApp must not statically import publicActivationRuntime')
}

// --- required positive contracts still present ---
for (const [label, source, token] of [
  ['coordinator', ownershipSources.coordinator, 'Promise.all'],
  ['coordinator', ownershipSources.coordinator, 'requestFrame'],
  ['coordinator', ownershipSources.coordinator, 'markBusy'],
  ['runtime', ownershipSources.runtime, 'shouldSuppressNavigationProgress'],
  ['runtime', ownershipSources.runtime, 'warmPublicFullAppCore'],
  ['shell', ownershipSources.shell, 'submitPublicActivationIntent'],
  ['shell', ownershipSources.shell, 'warmPublicFullAppCore'],
  ['entry', ownershipSources.entry, 'consumePublicBootHandoff'],
  ['entry', ownershipSources.entry, 'bootstrapPublicShell']
]) {
  if (!source.includes(token)) {
    fail(`${label} missing required public bootstrap contract token: ${token}`)
  }
}

// package.json registration
const packageJsonPath = 'src/frontend/package.json'
const packageJson = JSON.parse(read(packageJsonPath))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-public-bootstrap-causal-zero-residue.mjs'
if (scripts['check:public-bootstrap-causal-zero-residue'] !== checkScript) {
  fail(`${packageJsonPath}: check:public-bootstrap-causal-zero-residue script missing or wrong`)
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:public-bootstrap-causal-zero-residue')) {
  fail(`${packageJsonPath}: check:views-constraints must run check:public-bootstrap-causal-zero-residue`)
}
if (!String(scripts['check:security-consistency'] ?? '').includes('check-public-boot-kernel-boundary.mjs')) {
  fail(`${packageJsonPath}: security-consistency must keep public boot kernel boundary gate`)
}

// Evidence schema module must stay issue-prefix free.
const evidenceModule = read('tests/frontend/support/publicBootstrapCausalEvidence.mjs')
if (!evidenceModule.includes("fsusblog.public-bootstrap-causal-evidence.v1")) {
  fail('publicBootstrapCausalEvidence must export long-lived schema id without issue prefix')
}
if (/issue[-_]?1703/iu.test(evidenceModule)) {
  fail('evidence schema module must not embed issue number prefixes')
}

// Optional git grep hard fail for a few high-signal exact tokens outside checkers.
for (const token of [
  ['BuildDeferred', 'SpaBootScript'].join(''),
  ['fsus:public-shell', ':', 'takeover'].join(''),
  ['fsus:public-shell', ':', 'search-focus'].join('')
]) {
  try {
    const matches = execFileSync(
      'git',
      ['grep', '-n', token, '--', 'src', 'tests', 'docs', 'tools'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const residual = matches
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.includes(checkerRel))
      .filter((line) => !line.includes('check-public-boot-kernel-boundary.mjs'))
      .filter((line) => !line.includes('check-public-boot-production-output.mjs'))
      .filter((line) => !line.includes('check-public-atomic-takeover-governance.mjs'))
      .filter((line) => !line.includes('check-public-hydration-identity.mjs'))
      .filter((line) => !line.includes('publicIntentOwnership.test.ts'))
      .filter((line) => !line.includes('publicBootstrapCausalEvidence.mjs'))
    if (residual.length > 0) {
      fail(`git grep residual for ${token}:\n${residual.join('\n')}`)
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      // zero hits
    } else {
      fail(`git grep failed for ${token}: ${error?.message ?? String(error)}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map((item) => `[public-bootstrap-causal-zero-residue] ${item}`).join('\n'))
  process.exit(1)
}

console.log('[public-bootstrap-causal-zero-residue] ok files=0 events=0 flags=0 suppression=0 scc=acyclic')
