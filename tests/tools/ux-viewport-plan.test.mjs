import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  UX_SAFE_AREA_ASSERTION_NAMES,
  UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS,
  UX_VIEWPORT_MODEL_ROUTE_IDS,
  buildUxViewportPlan,
  listUxViewportCases,
  listUxViewportSafeAreaCases,
  safeAreaProfileCssOverrides,
  safeRectFromProfile,
  validateSafeAreaMatrix
} from '../frontend/support/playwright/uxViewportPlan.mjs'
import {
  buildViewportPlanProgressSummary,
  viewportPlanProgressTestFiles
} from '../../tools/ux/run-viewport-plan-progress.mjs'

const matrix = JSON.parse(await readFile(
  new URL('../frontend/fixtures/ux-viewport-matrix.json', import.meta.url),
  'utf8'
))

const routeIds = [
  'public-home',
  'public-article',
  'public-archive',
  'public-about',
  'public-privacy',
  'public-guidelines',
  'public-copyright',
  'public-category',
  'public-tag',
  'public-search',
  'public-login',
  'public-register',
  'public-forbidden',
  'public-not-found',
  'public-anon-user-redirect',
  'public-anon-manage-redirect',
  'user-profile',
  'user-comments',
  'user-messagebox',
  'user-login-redirect',
  'manage-dashboard',
  'manage-write',
  'manage-edit',
  'manage-list',
  'manage-trash',
  'manage-category',
  'manage-tag',
  'manage-settings',
  'manage-users',
  'manage-message',
  'manage-audit',
  'manage-user-profile',
  'manage-login-redirect'
]

assert.deepEqual(routeIds, UX_VIEWPORT_MODEL_ROUTE_IDS)

const routes = routeIds.map((id) => ({
  id,
  storage: id.startsWith('public-') ? 'anonymous' : id.startsWith('user-') ? 'user' : 'admin'
}))

test('plan/progress tier summary binds the exact executable governance suite to its fresh run', () => {
  const summary = buildViewportPlanProgressSummary({
    env: {
      FSUSBLOG_TEST_RUN_ID: 'production-fresh',
      FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
      FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64)
    },
    generatedAt: '2026-07-11T00:00:00.000Z'
  })

  assert.equal(summary.status, 'success')
  assert.equal(summary.executionSource, 'fresh')
  assert.equal(summary.schedulerRunId, 'production-fresh')
  assert.equal(summary.sourceState.commit, 'a'.repeat(40))
  assert.deepEqual(summary.testFiles, [...viewportPlanProgressTestFiles])
  assert.deepEqual(summary.testFiles, [
    'tests/tools/ux-viewport-plan.test.mjs',
    'tests/tools/ux-viewport-progress.test.mjs',
    'tests/tools/ux-viewport-risk-settle.test.mjs',
    'tests/tools/ux-viewport-runtime-contract.test.mjs'
  ])

  const standalone = buildViewportPlanProgressSummary({ env: {}, generatedAt: '2026-07-11T00:00:00.000Z' })
  assert.equal(standalone.executionSource, 'standalone')
  assert.equal(standalone.schedulerRunId, null)
  assert.equal(standalone.sourceState, null)
})

test('shared planner preserves the exact smoke, visual, and boundaries coverage budgets', () => {
  const smoke = buildUxViewportPlan({ matrix, routes, mode: 'smoke' })
  const visual = buildUxViewportPlan({ matrix, routes, mode: 'visual' })
  const boundaries = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' })

  assert.deepEqual(smoke.counts, {
    routes: 10,
    routeThemeGroups: 20,
    safeAreaGroups: 3,
    navigations: 123,
    cases: 339,
    safeAreaCases: 3
  })
  assert.deepEqual(visual.counts, {
    routes: 9,
    routeThemeGroups: 18,
    safeAreaGroups: 14,
    navigations: 140,
    cases: 392,
    safeAreaCases: 14
  })
  assert.deepEqual(boundaries.counts, {
    routes: 33,
    routeThemeGroups: 66,
    safeAreaGroups: 24,
    navigations: 1080,
    cases: 7416,
    safeAreaCases: 24
  })
})

test('canonical boundaries enumerate the 375 and 768 viewport records for every route and theme', () =>
{
    const plan = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' });
    for (const group of plan.groups.filter((entry) => entry.kind === 'route-theme'))
    {
        for (const [name, width, height] of [['mobile-375', 375, 812], ['tablet-768', 768, 1024]])
        {
            const matching = group.viewports.filter((entry) => entry.viewport.name === name);
            assert.equal(matching.length, 1);
            assert.equal(matching[0].viewport.width, width);
            assert.equal(matching[0].viewport.height, height);
            assert.deepEqual(matching[0].steps.map((entry) => entry.media), matrix.modes.boundaries.media);
            assert.equal(matching[0].viewport.screenshotBaseline, false);
        }
    }
    assert.equal(plan.groups.filter((entry) => entry.kind === 'route-theme').length, 66);
});

test('canonical boundaries reject missing and duplicate 375 or 768 viewport registrations', () =>
{
    for (const name of ['mobile-375', 'tablet-768'])
    {
        const missing = structuredClone(matrix);
        missing.viewports = missing.viewports.filter((entry) => entry.name !== name);
        assert.throws(() => buildUxViewportPlan({ matrix: missing, routes, mode: 'boundaries' }), /unknown UX viewport mode boundaries viewport/);

        const duplicate = structuredClone(matrix);
        duplicate.viewports.push(duplicate.viewports.find((entry) => entry.name === name));
        assert.throws(() => buildUxViewportPlan({ matrix: duplicate, routes, mode: 'boundaries' }), /duplicate UX viewport/);
    }
});

test('safe-area matrix only pairs overlay-risk surfaces and freezes profile table', () => {
  validateSafeAreaMatrix(matrix.safeArea)
  assert.deepEqual(matrix.safeArea.assertions, [...UX_SAFE_AREA_ASSERTION_NAMES])

  const smoke = buildUxViewportPlan({ matrix, routes, mode: 'smoke' })
  const safeArea = listUxViewportSafeAreaCases(smoke)
  assert.equal(safeArea.length, 3)
  assert.deepEqual(
    safeArea.map((entry) => entry.id).sort(),
    [
      'case:safe-area:article-lightbox:portrait-notch:light:webkit',
      'case:safe-area:fsus-dialog:portrait-notch:light:chromium',
      'case:safe-area:message-box:portrait-notch:light:chromium'
    ]
  )

  // No unbounded route × profile × media cartesian product.
  const boundaries = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' })
  assert.ok(boundaries.counts.safeAreaCases <= 40)
  assert.ok(boundaries.counts.safeAreaGroups <= 40)
  assert.equal(
    listUxViewportSafeAreaCases(boundaries).every((entry) => entry.media === 'default'),
    true
  )
  assert.equal(
    listUxViewportSafeAreaCases(boundaries).every((entry) => entry.safeArea === true),
    true
  )

  const portrait = matrix.safeArea.profiles['portrait-notch']
  assert.deepEqual(safeAreaProfileCssOverrides(portrait), {
    '--fsus-safe-area-inset-top': '47px',
    '--fsus-safe-area-inset-right': '0px',
    '--fsus-safe-area-inset-bottom': '34px',
    '--fsus-safe-area-inset-left': '0px',
    '--fsus-viewport-block-size': '844px'
  })
  assert.deepEqual(safeRectFromProfile(portrait), {
    left: 0,
    top: 47,
    right: 390,
    bottom: 810,
    width: 390,
    height: 763
  })
})

test('safe-area plan rejects non-overlay-risk cartesian explosion mutations', () => {
  const polluted = structuredClone(matrix)
  polluted.safeArea.overlayRiskSurfaces.push({
    id: 'leak-all-routes',
    surface: 'Leak',
    routeId: 'public-home',
    open: 'policy-modal',
    overlayRisk: false,
    profilesByMode: {
      boundaries: ['zero-inset', 'portrait-notch', 'landscape-notch', 'short-visual']
    },
    browsersByMode: { boundaries: ['chromium', 'webkit'] },
    themesByMode: { boundaries: ['light', 'dark'] }
  })
  assert.throws(
    () => buildUxViewportPlan({ matrix: polluted, routes, mode: 'boundaries' }),
    /overlayRisk=true/u
  )
})

test('group and step identities are stable semantic values without ordinal prefixes', () => {
  const plan = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' })
  const firstGroup = plan.groups.find((group) => group.route.id === 'public-home' && group.theme === 'light')

  assert.equal(firstGroup.id, 'route-theme:public-home:light')
  assert.equal(firstGroup.viewports[0].steps[0].id, 'case:public-home:light:xs-mobile:default')
  assert.doesNotMatch(firstGroup.id, /(?:^|[-_:])\d+(?:[-_:]|$)/)
  assert.ok(plan.groups.every((group) => !/^group-\d+/u.test(group.id)))
  assert.equal(new Set(plan.groups.map((group) => group.id)).size, plan.groups.length)
  assert.equal(new Set(listUxViewportCases(plan).map((entry) => entry.id)).size, plan.counts.cases)
})

test('planner keeps matrix media order inside one cold navigation per viewport', () => {
  const plan = buildUxViewportPlan({
    matrix,
    routes,
    mode: 'boundaries',
    filters: {
      routeIds: ['public-article'],
      themes: ['dark'],
      viewportIds: ['mobile-landscape'],
      skipSafeArea: true
    }
  })

  assert.equal(plan.groups.length, 1)
  assert.equal(plan.groups[0].viewports.length, 1)
  assert.equal(plan.counts.navigations, 1)
  assert.deepEqual(
    plan.groups[0].viewports[0].steps.map((entry) => entry.media),
    matrix.modes.boundaries.media
  )
})

test('local production risk plan covers every dimension within 48 navigations', () => {
  const plan = buildUxViewportPlan({
    matrix,
    routes,
    mode: 'boundaries',
    filters: { riskMatrix: true, skipSafeArea: true }
  })

  assert.equal(plan.counts.navigations, 32)
  assert.equal(plan.counts.cases, 224)
  assert.ok(plan.counts.navigations <= 48)
  assert.deepEqual(plan.selection.themes, matrix.modes.boundaries.themes)
  assert.deepEqual(plan.selection.viewportIds, matrix.modes.boundaries.viewports)
  assert.deepEqual(plan.selection.media, matrix.modes.boundaries.media)
  assert.ok(plan.selection.routeIds.some((id) => id.startsWith('public-')))
  assert.ok(plan.selection.routeIds.some((id) => id.startsWith('user-')))
  assert.ok(plan.selection.routeIds.some((id) => id.startsWith('manage-')))
})

test('risk matrix plus safe-area stays bounded and overlay-risk only', () => {
  const plan = buildUxViewportPlan({
    matrix,
    routes,
    mode: 'boundaries',
    filters: { riskMatrix: true }
  })
  assert.equal(plan.counts.navigations, 32 + 24)
  assert.equal(plan.counts.safeAreaCases, 24)
  assert.ok(plan.counts.safeAreaGroups <= 40)
  assert.ok(plan.counts.navigations <= 48 + 40)
})

test('unknown filters fail closed even when another requested value is valid', () => {
  for (const filters of [
    { routeIds: ['public-home', 'unknown-route'] },
    { themes: ['light', 'sepia'] },
    { viewportIds: ['mobile', 'watch'] },
    { media: ['default', 'print'] }
  ]) {
    assert.throws(
      () => buildUxViewportPlan({ matrix, routes, mode: 'boundaries', filters }),
      /unknown UX viewport filter/u
    )
  }
})

test('mobile-landscape canary is a planner parity list, not a fabricated golden catalog', () => {
  assert.deepEqual(UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS, [
    'public-home',
    'user-profile',
    'manage-dashboard',
    'manage-audit',
    'manage-settings'
  ])

  const plan = buildUxViewportPlan({
    matrix,
    routes,
    mode: 'boundaries',
    filters: {
      routeIds: UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS,
      viewportIds: ['mobile-landscape'],
      skipSafeArea: true
    }
  })
  const actual = listUxViewportCases(plan).map(({ routeId, theme, viewportId, media }) => (
    `${routeId}|${theme}|${viewportId}|${media}`
  ))
  const expected = UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS.flatMap((routeId) => (
    matrix.modes.boundaries.themes.flatMap((theme) => (
      matrix.modes.boundaries.media.map((media) => (
        `${routeId}|${theme}|mobile-landscape|${media}`
      ))
    ))
  ))

  assert.equal(actual.length, 70)
  assert.deepEqual(actual, expected)
})
