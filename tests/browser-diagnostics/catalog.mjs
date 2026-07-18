import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const uxViewportMatrix = JSON.parse(fs.readFileSync(
  path.join(root, 'tests/frontend/fixtures/ux-viewport-matrix.json'),
  'utf8'
))

function plannedDimensions(viewports, themes = ['light']) {
  return Object.freeze({
    viewports: Object.freeze([...new Set(viewports)].sort()),
    themes: Object.freeze([...new Set(themes)].sort())
  })
}

const fallbackDimensions = plannedDimensions(['1280x800'])
const uxModeDimensions = Object.freeze(Object.fromEntries(
  Object.entries(uxViewportMatrix.modes).map(([mode, config]) => [
    mode,
    plannedDimensions(config.viewports, config.themes)
  ])
))
const publicVisualDimensions = plannedDimensions(
  uxViewportMatrix.viewports.filter((viewport) => viewport.useInPublicVisual).map((viewport) => viewport.name),
  ['light', 'dark']
)
const consoleVisualDimensions = plannedDimensions(
  [
    ...uxViewportMatrix.viewports.filter((viewport) => viewport.useInConsoleVisual).map((viewport) => viewport.name),
    'dashboard-768px-first-fold'
  ],
  ['light', 'dark']
)
const allVisualDimensions = plannedDimensions(
  [...publicVisualDimensions.viewports, ...consoleVisualDimensions.viewports],
  ['light', 'dark']
)
const allUxDimensions = plannedDimensions(
  Object.values(uxModeDimensions).flatMap((dimensions) => dimensions.viewports),
  Object.values(uxModeDimensions).flatMap((dimensions) => dimensions.themes)
)

const replacementLayers = Object.freeze({
  visual: [
    'tests/frontend/checks/static/check-visual-density-governance.mjs',
    'tests/frontend/checks/static/check-shell-material-governance.mjs',
    'tests/frontend/unit/view-contracts/homeSpotlight.test.ts',
    'tests/frontend/unit/components/admin/AdminDashboardTaskWorkbench.test.ts'
  ],
  ux: [
    'tests/frontend/checks/static/check-views-constraints.mjs',
    'tests/frontend/unit/components/account/AccountNavigationPanel.test.ts',
    'tests/frontend/unit/router/index.test.ts'
  ],
  'cross-browser': [
    'tests/frontend/checks/public/check-public-aot-contracts.mjs',
    'tests/frontend/unit/public-renderers/publicBrowserEnvironment.test.ts',
    'tests/frontend/unit/services/passkeyCeremony.test.ts'
  ],
  'geometry-motion-focus': [
    'tests/frontend/unit/components/usePublicStickyGeometry.test.ts',
    'tests/frontend/checks/static/check-local-fsusui-public-shell-motion.mjs',
    'tests/frontend/unit/composables/useMotionPreference.test.ts'
  ],
  accessibility: [
    'tests/frontend/checks/static/check-admin-a11y-governance.mjs',
    'tests/frontend/checks/static/check-visual-density-governance.mjs',
    'tests/frontend/unit/components/account/AccountHeaderMenu.test.ts'
  ],
  performance: [
    'tests/frontend/checks/static/check-dom-depth-static.mjs',
    'tests/frontend/checks/perf/check-markdown-render-budget.mjs',
    'tests/frontend/unit/public-renderers/publicPageModel.test.ts'
  ],
  resilience: [
    'tests/frontend/checks/public/check-aot-cache-resilience.mjs',
    'tests/frontend/unit/services/telemetryService.test.ts',
    'tests/frontend/unit/services/notificationStreamRestartPolicy.test.ts'
  ],
  acceptance: [
    'tests/issue-1146-retention-replacements.json',
    'tests/tools/acceptance-layer-migration.test.mjs'
  ],
  'release-runtime': [
    'tests/browser-contract/scenarios.mjs',
    'tests/frontend/checks/public/check-public-aot-contracts.mjs',
    'tests/frontend/unit/router/index.test.ts'
  ],
  'runtime-risk': [
    'tests/backend/Unit/BackendAuthStateMachineTests.cs',
    'tests/frontend/unit/router/index.test.ts',
    'tests/frontend/unit/services/authBroadcastRuntime.test.ts'
  ]
})

function probe(id, command, artifactPaths = [], timeoutMinutes = 45, dimensions = fallbackDimensions) {
  return Object.freeze({
    id,
    command: Object.freeze(command),
    artifactPaths: Object.freeze(artifactPaths),
    timeoutMinutes,
    plannedDimensions: dimensions
  })
}

export const browserDiagnosticCatalog = Object.freeze([
  Object.freeze({
    id: 'visual',
    browsers: Object.freeze(['chromium']),
    risk: 'pixel-layout-theme',
    replacements: Object.freeze(replacementLayers.visual),
    probes: Object.freeze([
      probe('public', ['bash', 'tools/test/lanes/visual-public-playwright.sh'], [
        '.tmp/visual/public'
      ], 45, publicVisualDimensions),
      probe('console', ['bash', 'tools/test/lanes/visual-console-playwright.sh'], [
        '.tmp/visual/console'
      ], 45, consoleVisualDimensions),
      probe('aggregate', ['bash', 'tools/test/lanes/visual-screenshots-aggregate.sh'], [
        '.tmp/visual/summary.json',
        '.tmp/release-evidence/visual-screenshot-summary.json'
      ], 10, allVisualDimensions)
    ])
  }),
  Object.freeze({
    id: 'ux',
    browsers: Object.freeze(['chromium']),
    risk: 'viewport-overflow-hit-target-layout',
    replacements: Object.freeze(replacementLayers.ux),
    probes: Object.freeze([
      probe('smoke', ['bash', 'tools/test/lanes/ux-viewport-smoke.sh'], [
        '.tmp/ux/viewport-smoke.json'
      ], 45, uxModeDimensions.smoke),
      probe('visual', ['bash', 'tools/test/lanes/ux-viewport-visual.sh'], [
        '.tmp/ux/viewport-visual.json'
      ], 60, uxModeDimensions.visual),
      probe('boundaries', ['bash', 'tools/test/lanes/ux-viewport-boundaries.sh'], [
        '.tmp/ux/viewport-boundaries.json'
      ], 90, uxModeDimensions.boundaries),
      probe('risk-matrix', ['bash', 'tools/test/lanes/browser-ux-risk-diagnostics.sh'], [
        '.tmp/browser-diagnostics-runtime/ux-risk/summary.json',
        '.tmp/ux/viewport-boundaries.json',
        '.tmp/release-evidence/ux-viewport-summary.json'
      ], 90, allUxDimensions)
    ])
  }),
  Object.freeze({
    id: 'cross-browser',
    browsers: Object.freeze(['chromium', 'firefox', 'webkit']),
    risk: 'engine-compatibility-only',
    replacements: Object.freeze(replacementLayers['cross-browser']),
    probes: Object.freeze([
      probe('engine-smoke', ['bash', 'tools/test/lanes/cross-browser-smoke.sh'])
    ])
  }),
  Object.freeze({
    id: 'geometry-motion-focus',
    browsers: Object.freeze(['chromium']),
    risk: 'isolated-component-motion-focus-plus-archive-integration-geometry',
    replacements: Object.freeze(replacementLayers['geometry-motion-focus']),
    probes: Object.freeze([
      probe('component-harness-and-archive-integration', ['bash', 'tools/test/lanes/browser-geometry-motion-diagnostics.sh'], [
        '.tmp/browser-diagnostics-runtime/geometry-motion-focus/geometry-motion-focus-summary.json'
      ])
    ])
  }),
  Object.freeze({
    id: 'accessibility',
    browsers: Object.freeze(['chromium']),
    risk: 'rendered-focus-accessible-name',
    replacements: Object.freeze(replacementLayers.accessibility),
    probes: Object.freeze([
      probe('rendered-routes', ['bash', 'tools/test/lanes/browser-a11y-diagnostics.sh'], [
        '.tmp/browser-diagnostics-runtime/a11y'
      ])
    ])
  }),
  Object.freeze({
    id: 'performance',
    browsers: Object.freeze(['chromium', 'firefox', 'webkit']),
    risk: 'layout-heap-long-task-render-ready-aeds-engine-selection-fallback-copy',
    replacements: Object.freeze(replacementLayers.performance),
    probes: Object.freeze([
      probe('render-pressure', ['bash', 'tools/test/lanes/browser-render-diagnostics.sh'], [
        '.tmp/frontend/dom-budget.json',
        '.tmp/frontend/dom-budget',
        '.tmp/frontend/route-render-pressure.json'
      ]),
      probe('browser-performance-evidence', ['bash', 'tools/test/lanes/browser-performance-regression.sh'], [
        '.tmp/perf/browser-performance.json',
        '.tmp/perf/release-summaries/browser-performance-regression.json'
      ], 10),
      probe('aeds-browser-boundary', ['bash', 'tools/test/lanes/browser-aeds-diagnostics.sh'], [
        '.tmp/frontend/aeds-wasm-browser/summary.json',
        '.tmp/release-evidence/aeds-wasm-browser-summary.json'
      ], 10)
    ])
  }),
  Object.freeze({
    id: 'resilience',
    browsers: Object.freeze(['chromium']),
    risk: 'browser-runtime-recovery',
    replacements: Object.freeze(replacementLayers.resilience),
    probes: Object.freeze([
      probe('runtime-recovery', ['bash', 'tools/test/lanes/browser-resilience-diagnostics.sh'], [
        '.tmp/browser-diagnostics-runtime/resilience'
      ])
    ])
  }),
  Object.freeze({
    id: 'acceptance',
    browsers: Object.freeze(['chromium']),
    risk: 'retained-route-session-and-public-acceptance',
    replacements: Object.freeze(replacementLayers.acceptance),
    probes: Object.freeze([
      probe('full-suite', ['bash', 'tools/test/lanes/browser-diagnostics-risk.sh', 'acceptance'], [], 45)
    ])
  }),
  Object.freeze({
    id: 'release-runtime',
    browsers: Object.freeze(['chromium']),
    risk: 'release-rbac-and-aot-consumption',
    replacements: Object.freeze(replacementLayers['release-runtime']),
    probes: Object.freeze([
      probe('release-rbac-negative', ['bash', 'tools/test/lanes/browser-diagnostics-risk.sh', 'release-rbac-negative'], [], 35),
      probe('release-aot-consumption', ['bash', 'tools/test/lanes/browser-diagnostics-risk.sh', 'release-aot-consumption'], [], 25)
    ])
  }),
  Object.freeze({
    id: 'runtime-risk',
    browsers: Object.freeze(['chromium']),
    risk: 'pow-search-zero-auth-and-permission-browser-runtime',
    replacements: Object.freeze(replacementLayers['runtime-risk']),
    probes: Object.freeze([
      probe('pow-runtime', ['bash', 'tools/test/lanes/browser-diagnostics-risk.sh', 'pow-runtime'], [], 20),
      probe('search-runtime', ['bash', 'tools/test/lanes/browser-diagnostics-risk.sh', 'search-runtime'], [], 20),
      probe('zero-auth-probe', ['bash', 'tools/test/lanes/browser-diagnostics-risk.sh', 'zero-auth-probe'], [], 20),
      probe('permission-matrix', ['bash', 'tools/test/lanes/browser-diagnostics-risk.sh', 'permission-matrix'], [], 30)
    ])
  })
])

export function selectBrowserDiagnostics(categoryIds = []) {
  const requested = new Set(categoryIds.filter(Boolean))
  const known = new Set(browserDiagnosticCatalog.map((category) => category.id))
  const unknown = [...requested].filter((id) => !known.has(id))
  if (unknown.length > 0) throw new Error(`unknown browser diagnostic categories: ${unknown.join(', ')}`)
  return requested.size === 0
    ? [...browserDiagnosticCatalog]
    : browserDiagnosticCatalog.filter((category) => requested.has(category.id))
}

export function browserDiagnosticProbeCount(categories = browserDiagnosticCatalog) {
  return categories.reduce((count, category) => count + category.probes.length, 0)
}
