import assert from 'node:assert/strict'
import { requireWebPackage } from './web-package-fixture.mjs'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { validSiteSessionId } from '../../src/Contracts/client.ts'
import { decodePropertyMatches } from '../../src/Contracts/property-query.ts'
import { FrameType, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { expect } = requireWebPackage('@playwright/test')
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const mode = scope => button(scope, 'Pinned views')
const pins = scope => scope.getByRole('navigation', { name: 'Pinned saved views', exact: true })
const title = page => page.getByLabel('Title', { exact: true })
const placementPath = WireRoutes.SavedViewPlacement
const executionPath = WireRoutes.SavedViewExecute
const currentSession = WireHeaders.CurrentSession.toLowerCase()

function responseFor(response, path, method) {
  return new URL(response.url()).pathname === path && response.request().method() === method
}

async function openRail(page, pane) {
  const receipt = page.waitForResponse(response => responseFor(response, placementPath, 'GET'))
  const direct = button(page, 'Article library')
  if (await direct.isVisible()) {
    await direct.click()
  } else {
    await button(page, 'More actions').click()
    await page.getByRole('menuitem', { name: 'Article library', exact: true }).click()
  }
  await expect(pane).toBeVisible()
  const placement = await receipt
  assert.equal(placement.status(), 200)
  decodeFrame(await placement.body(), FrameType.SavedViewPlacement)
  const handle = placement.request().headers()[currentSession]
  assert(handle && validSiteSessionId(handle))
  return handle
}

async function startEditor(page, origin, article, width) {
  await page.setViewportSize({ width, height: 850 })
  await page.goto(new URL(`/user/manage/article/edit/${article.id}`, origin).href)
  await expect(title(page)).toHaveValue(article.title)
  await expect(title(page)).toBeEditable()
  return page.getByRole(width === 375 ? 'dialog' : 'complementary', { name: 'Article library', exact: true })
}

async function expectPins(pane, expected) {
  await mode(pane).click()
  const rail = pins(pane)
  await expect(rail).toBeVisible()
  const links = rail.getByRole('link')
  await expect(links).toHaveCount(expected.length)
  const actual = await links.evaluateAll(anchors => anchors.map(anchor => ({
    title: anchor.textContent.trim(), href: anchor.getAttribute('href'),
  })))
  assert.deepEqual(actual, expected)
  for (const { href } of actual) assert.match(href, /^\/user\/manage\/article\/list\?view=[0-9a-f-]{36}&viewSchema=1$/)
  return links
}

export async function verifyUnpinnedViewRail(page, article) {
  const probe = await page.context().newPage()
  try {
    const pane = await startEditor(probe, page.url(), article, 1280)
    await openRail(probe, pane)
    await probe.waitForLoadState('networkidle')
    await expect(mode(pane)).toHaveCount(0)
    await expect(pins(pane)).toHaveCount(0)
  } finally {
    await probe.close()
  }
}

export async function exercisePinnedViewRail({ page, article, links, observations }) {
  const context = page.context()
  const desktop = await context.newPage()
  const errors = []
  desktop.on('pageerror', error => errors.push(error.message))
  try {
    const pane = await startEditor(desktop, page.url(), article, 1280)
    await openRail(desktop, pane)
    await expectPins(pane, links)

    const mobile = await context.newPage()
    mobile.on('pageerror', error => errors.push(error.message))
    try {
      const drawer = await startEditor(mobile, page.url(), article, 375)
      const localTitle = `${article.title} · Unsaved Rail navigation`
      const editorUrl = mobile.url()
      await title(mobile).fill(localTitle)
      const handle = await openRail(mobile, drawer)
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 375)
      const [chosen] = links
      const clickTarget = (await expectPins(drawer, links)).first()
      if (process.env.FSUSBLOG_TEST_EVIDENCE)
        await mobile.screenshot({ path: join(process.env.FSUSBLOG_TEST_EVIDENCE, 'pinned-view-rail-mobile.png') })
      const executed = []
      mobile.on('request', request => {
        if (new URL(request.url()).pathname === executionPath) executed.push(request)
      })

      await clickTarget.click()
      const confirmation = mobile.getByText('Discard unsaved changes?', { exact: true })
      await expect(confirmation).toBeVisible()
      await button(mobile, 'Keep writing').click()
      await expect(confirmation).toBeHidden()
      await expect(mobile).toHaveURL(editorUrl)
      await expect(title(mobile)).toHaveValue(localTitle)
      assert.equal(executed.length, 0)

      await clickTarget.click()
      await expect(confirmation).toBeVisible()
      const pending = mobile.waitForResponse(response => responseFor(response, executionPath, 'POST'))
      await button(mobile, 'Discard changes').click()
      await expect(mobile).toHaveURL(new URL(chosen.href, editorUrl).href)
      const result = await pending
      assert.equal(result.status(), 200)
      assert.equal(result.request().headers()[currentSession], handle)
      assert.equal(executed.length, 1)
      const input = new PodReader(decodeFrame(result.request().postDataBuffer(), FrameType.SavedViewExecute).payload)
      assert.equal(input.uuid(), new URL(chosen.href, editorUrl).searchParams.get('view'))
      assert(input.i64() > 0n)
      assert.equal(input.text(WireLimits.PropertyQueryCursorChars), '')
      input.finish()
      const { rows, nextCursor } = decodePropertyMatches(decodeFrame(await result.body(), FrameType.PropertyArticlePage).payload)
      assert.equal(nextCursor, '')
      assert.deepEqual(rows.map(({ id, title }) => ({ id, title })), [{ id: article.id, title: article.title }])
      const output = mobile.getByRole('region', { name: '保存视图结果', exact: true })
      await expect(output.getByRole('heading', { name: chosen.title, exact: true })).toBeFocused()
      const resultLinks = output.getByRole('link')
      await expect(resultLinks).toHaveCount(rows.length)
      await expect(resultLinks.first()).toHaveAttribute('href', `/user/manage/article/edit/${article.id}`)
      await expect(resultLinks.first()).toHaveAccessibleName(article.title)
    } finally {
      await mobile.close()
    }

    observations.push('The editor Rail follows server pin order on desktop and in the 375px FsusUI Drawer. The ordinary dirty guard protects canceled navigation, and the confirmed link runs its exact saved view under the current session.')
    return {
      async refresh(expected) {
        await button(pane, 'Close library').click()
        await expect(pane).toBeHidden()
        await expect(button(desktop, 'Article library')).toBeFocused()
        await openRail(desktop, pane)
        if (expected.length) {
          await expectPins(pane, expected)
        } else {
          await desktop.waitForLoadState('networkidle')
          await expect(mode(pane)).toHaveCount(0)
          await expect(pins(pane)).toHaveCount(0)
          observations.push('Reopening the Rail in the same editor fetches fresh placement after each real retirement and hides the mode after the last pin is removed.')
        }
        assert.deepEqual(errors, [])
      },
      close: () => desktop.close(),
    }
  } catch (error) {
    await desktop.close()
    throw error
  }
}
