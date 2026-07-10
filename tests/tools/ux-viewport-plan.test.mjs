import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS,
  UX_VIEWPORT_MODEL_ROUTE_IDS,
  buildUxViewportPlan,
  listUxViewportCases
} from '../frontend/support/playwright/uxViewportPlan.mjs'

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

test('shared planner preserves the exact smoke, visual, and boundaries coverage budgets', () => {
  const smoke = buildUxViewportPlan({ matrix, routes, mode: 'smoke' })
  const visual = buildUxViewportPlan({ matrix, routes, mode: 'visual' })
  const boundaries = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' })

  assert.deepEqual(smoke.counts, {
    routes: 10,
    routeThemeGroups: 20,
    navigations: 120,
    cases: 336
  })
  assert.deepEqual(visual.counts, {
    routes: 9,
    routeThemeGroups: 18,
    navigations: 126,
    cases: 378
  })
  assert.deepEqual(boundaries.counts, {
    routes: 33,
    routeThemeGroups: 66,
    navigations: 924,
    cases: 6468
  })
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
      viewportIds: ['mobile-landscape']
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
    filters: { riskMatrix: true }
  })

  assert.equal(plan.counts.navigations, 28)
  assert.equal(plan.counts.cases, 196)
  assert.ok(plan.counts.navigations <= 48)
  assert.deepEqual(plan.selection.themes, matrix.modes.boundaries.themes)
  assert.deepEqual(plan.selection.viewportIds, matrix.modes.boundaries.viewports)
  assert.deepEqual(plan.selection.media, matrix.modes.boundaries.media)
  assert.ok(plan.selection.routeIds.some((id) => id.startsWith('public-')))
  assert.ok(plan.selection.routeIds.some((id) => id.startsWith('user-')))
  assert.ok(plan.selection.routeIds.some((id) => id.startsWith('manage-')))
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
      viewportIds: ['mobile-landscape']
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
