import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  openUxViewportProgress,
  readUxViewportProgress,
  recordUxViewportGroupResult
} from '../frontend/support/playwright/uxViewportProgress.mjs'
import { buildUxViewportPlan } from '../frontend/support/playwright/uxViewportPlan.mjs'

const matrix = {
  version: 'test-matrix-v1',
  viewports: [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'desktop', width: 1440, height: 960 }
  ],
  modes: {
    smoke: {
      themes: ['light', 'dark'],
      viewports: ['mobile', 'desktop'],
      routes: ['public-article'],
      media: ['default', 'large-text']
    }
  }
}
const routes = [{
  id: 'public-article',
  path: '/article/fixture',
  expectedUrl: '/article/fixture',
  storage: 'anonymous'
}]
const plan = buildUxViewportPlan({ matrix, routes, mode: 'smoke' })

test('fresh progress ignores an old current-run pointer and starts with no completed groups', async (t) => {
  const root = await tempRoot(t)
  const oldDir = path.join(root, '.tmp/ux/runs/old-run/smoke')
  await mkdir(oldDir, { recursive: true })
  await writeFile(path.join(oldDir, 'progress.json'), JSON.stringify({
    planFingerprint: plan.fingerprint,
    completedGroupIds: plan.groups.map((group) => group.id)
  }))
  await writeFile(path.join(root, '.tmp/ux/current-smoke-run.json'), JSON.stringify({
    runId: 'old-run',
    progressFile: '.tmp/ux/runs/old-run/smoke/progress.json'
  }))

  const run = await openUxViewportProgress({
    root,
    plan,
    resume: false,
    runId: 'fresh-run',
    runToken: 'fresh-token',
    now: () => '2026-07-10T00:00:00.000Z'
  })

  assert.equal(run.progress.runId, 'fresh-run')
  assert.deepEqual(run.progress.completedGroupIds, [])
  assert.equal(run.progress.actual.completedRouteThemeGroups, 0)
  assert.match(run.progressFile, /fresh-run\/smoke\/progress\.json$/u)
})

test('resume reuses only completed route-theme groups when the plan fingerprint matches', async (t) => {
  const root = await tempRoot(t)
  const fresh = await openUxViewportProgress({
    root,
    plan,
    resume: false,
    runId: 'resume-run',
    runToken: 'resume-token'
  })
  await recordUxViewportGroupResult({
    run: fresh,
    plan,
    groupId: plan.groups[0].id,
    status: 'passed'
  })

  const resumed = await openUxViewportProgress({ root, plan, resume: true })

  assert.equal(resumed.progress.runId, 'resume-run')
  assert.deepEqual(resumed.progress.completedGroupIds, [plan.groups[0].id])
  assert.equal(resumed.completedGroupIds.has(plan.groups[0].id), true)
  assert.equal(resumed.completedGroupIds.has(plan.groups[1].id), false)
})

test('resume rejects stale progress with a different plan fingerprint', async (t) => {
  const root = await tempRoot(t)
  await openUxViewportProgress({
    root,
    plan,
    resume: false,
    runId: 'stale-run',
    runToken: 'stale-token'
  })
  const changedPlan = buildUxViewportPlan({
    matrix,
    routes,
    mode: 'smoke',
    filters: { themes: ['light'] }
  })

  await assert.rejects(
    openUxViewportProgress({ root, plan: changedPlan, resume: true }),
    /fingerprint mismatch/u
  )
})

test('concurrent group completion merges results through atomic writes', async (t) => {
  const root = await tempRoot(t)
  const run = await openUxViewportProgress({
    root,
    plan,
    resume: false,
    runId: 'parallel-run',
    runToken: 'parallel-token'
  })

  await Promise.all(plan.groups.map((group) => recordUxViewportGroupResult({
    run,
    plan,
    groupId: group.id,
    status: 'passed'
  })))

  const progress = await readUxViewportProgress(run.progressFile)
  assert.equal(progress.status, 'passed')
  assert.deepEqual(progress.completedGroupIds.sort(), plan.groups.map((group) => group.id).sort())
  assert.deepEqual(progress.actual, {
    completedRouteThemeGroups: plan.counts.routeThemeGroups,
    navigations: plan.counts.navigations,
    cases: plan.counts.cases,
    failedRouteThemeGroups: 0
  })
  assert.deepEqual(
    (await readdir(path.dirname(run.progressFile))).filter((name) => name.includes('.tmp-') || name.endsWith('.lock')),
    []
  )
})

test('failed groups are recorded but never treated as resumable completion', async (t) => {
  const root = await tempRoot(t)
  const run = await openUxViewportProgress({
    root,
    plan,
    resume: false,
    runId: 'failed-run',
    runToken: 'failed-token'
  })
  await recordUxViewportGroupResult({
    run,
    plan,
    groupId: plan.groups[0].id,
    status: 'failed',
    error: new Error('viewport assertion failed')
  })

  const progress = await readUxViewportProgress(run.progressFile)
  assert.equal(progress.status, 'failed')
  assert.deepEqual(progress.completedGroupIds, [])
  assert.equal(progress.actual.failedRouteThemeGroups, 1)
  assert.match(progress.groupResults[0].error, /viewport assertion failed/u)
})

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fsusblog-ux-progress-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
