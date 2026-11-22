import { exactLabel, roleWithExactName, exactText } from './role-locators.mjs'
import assert from 'node:assert/strict'

const inspectorName = 'Article inspector'
const compactViewport = { width: 375, height: 850 }

function label(page) {
  return exactLabel(page, 'Property label')
}

function launcher(page) {
  return roleWithExactName(page, 'button', 'Inspector')
}

function pane(page) {
  return roleWithExactName(page, 'complementary', inspectorName)
}

function drawer(page) {
  return roleWithExactName(page, 'dialog', inspectorName)
}

async function closedWithFocus(page, host) {
  await host.waitFor({ state: 'hidden' })
  const trigger = launcher(page)
  await trigger.and(page.locator(':focus')).waitFor({ timeout: 5000 })
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
}

async function settledDrawer(page) {
  const dialog = await drawer(page).elementHandle()
  assert(dialog)
  try {
    await page.waitForFunction(element => {
      const bounds = element.getBoundingClientRect()
      return Math.abs(bounds.left) < 1 && bounds.right <= window.innerWidth + 1
    }, dialog)
  } finally {
    await dialog.dispose()
  }
}

async function snapshotInput(page, content) {
  const input = label(page)
  await input.fill(content)
  const element = await input.elementHandle()
  assert(element)
  return element
}

async function requireSameInput(page, host, element, content) {
  const target = exactLabel(host, 'Property label')
  await target.waitFor()
  assert.equal(await target.evaluate((current, previous) => current === previous, element), true,
    'Moving the Inspector must keep the same editing control and Vue slot')
  assert.equal(await label(page).inputValue(), content)
  assert.equal(await page.locator('#new-property-label').count(), 1, 'Rehosting must not clone the property input')
}

export async function exerciseInspector({ page, screenshot, token, observations }) {
  const desktopViewport = page.viewportSize()
  assert(desktopViewport && desktopViewport.width >= 1024)

  const first = `Inspector draft ${token}`
  const second = `Inspector reverse ${token}`
  const originalUrl = page.url()
  const originalBody = await exactLabel(page, 'Body').inputValue()
  const handles = []
  try {
    const originalLauncher = await launcher(page).elementHandle()
    assert(originalLauncher)
    handles.push(originalLauncher)
    await launcher(page).focus()
    await page.keyboard.press('Enter')
    await pane(page).waitFor()
    await roleWithExactName(pane(page), 'button', 'Add property').click()
    const element = await snapshotInput(page, first)
    handles.push(element)

    await page.setViewportSize(compactViewport)
    await drawer(page).waitFor()
    await pane(page).waitFor({ state: 'hidden' })
    await requireSameInput(page, drawer(page), element, first)
    assert.equal(await originalLauncher.evaluate(button => button.isConnected), false, 'The retired desktop opener must be detached')
    await settledDrawer(page)
    await screenshot(page, 'inspector-mobile')
    await label(page).focus()
    await page.keyboard.press('Escape')
    await closedWithFocus(page, drawer(page))

    const compactLauncher = await launcher(page).elementHandle()
    assert(compactLauncher)
    handles.push(compactLauncher)
    await page.keyboard.press('Enter')
    await drawer(page).waitFor()
    await label(page).fill(second)

    await page.setViewportSize(desktopViewport)
    await pane(page).waitFor()
    await drawer(page).waitFor({ state: 'hidden' })
    await requireSameInput(page, pane(page), element, second)
    assert.equal(await compactLauncher.evaluate(button => button.isConnected), false, 'The retired compact opener must be detached')
    await screenshot(page, 'inspector-desktop')
    await label(page).focus()
    await page.keyboard.press('Escape')
    await closedWithFocus(page, pane(page))

    // Reopen immediately after Escape focus. Delayed events from the closed host may not overwrite this branch.
    await page.keyboard.press('Enter')
    await requireSameInput(page, pane(page), element, second)
    await roleWithExactName(pane(page), 'button', 'Cancel').click()
    await roleWithExactName(pane(page), 'heading', inspectorName).waitFor()
    await roleWithExactName(pane(page), 'button', 'Close').click()
    await closedWithFocus(page, pane(page))
    await launcher(page).click()
    await pane(page).waitFor()
    assert.equal(page.url(), originalUrl, 'Inspector actions cannot navigate to a different article')
    assert.equal(await exactLabel(page, 'Body').inputValue(), originalBody)
  } finally {
    await Promise.all(handles.map(element => element.dispose()))
    await page.setViewportSize(desktopViewport)
  }

  observations.push('Inspector moves the same property input from desktop pane to the real 375px Drawer and back, retains edits, and returns Escape focus to the live launcher in both directions.')
}

export async function exerciseInspectorDate(page, observations) {
  const desktopViewport = page.viewportSize()
  assert(desktopViewport && desktopViewport.width >= 1024)
  await pane(page).waitFor()
  const field = 'Editorial date'
  const canonicalDate = '2024-02-29T17:06:01.150Z'
  try {
    await page.setViewportSize(compactViewport)
    const compact = drawer(page)
    await compact.waitFor()
    await roleWithExactName(compact, 'button', 'Add property').click()
    await exactLabel(compact, 'Property label').fill(field)
    await exactLabel(compact, 'Property key').fill('editorial-date')
    await roleWithExactName(compact, 'combobox', 'Property type').click()
    await roleWithExactName(page, 'option', 'Date').click()
    await roleWithExactName(compact, 'button', 'Create property').click()
    await roleWithExactName(compact, 'button', `Edit ${field}`).click()
    await exactLabel(compact, `${field} value`).fill('2024-02-29T17:06:01.15Z')
    await roleWithExactName(compact, 'button', 'Save property').click()
    await exactText(compact, canonicalDate).waitFor()
  } finally {
    await page.setViewportSize(desktopViewport)
  }
  await exactText(pane(page), canonicalDate).waitFor()
  observations.push('The compact Inspector commits a leap-day UTC date and the desktop pane shows the same canonical millisecond value.')
}
