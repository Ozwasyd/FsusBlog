import assert from 'node:assert/strict'

const inspectorName = 'Article inspector'
const compactViewport = { width: 375, height: 850 }

function label(page) {
  return page.getByLabel('Property label', { exact: true })
}

function launcher(page) {
  return page.getByRole('button', { name: 'Inspector', exact: true })
}

function pane(page) {
  return page.getByRole('complementary', { name: inspectorName, exact: true })
}

function drawer(page) {
  return page.getByRole('dialog', { name: inspectorName, exact: true })
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
  const target = host.getByLabel('Property label', { exact: true })
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
  const originalBody = await page.getByLabel('Body', { exact: true }).inputValue()
  const handles = []
  try {
    const originalLauncher = await launcher(page).elementHandle()
    assert(originalLauncher)
    handles.push(originalLauncher)
    await launcher(page).focus()
    await page.keyboard.press('Enter')
    await pane(page).waitFor()
    await pane(page).getByRole('button', { name: 'Add property', exact: true }).click()
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
    await pane(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await pane(page).getByRole('heading', { name: inspectorName, exact: true }).waitFor()
    await pane(page).getByRole('button', { name: 'Close', exact: true }).click()
    await closedWithFocus(page, pane(page))
    await launcher(page).click()
    await pane(page).waitFor()
    assert.equal(page.url(), originalUrl, 'Inspector actions cannot navigate to a different article')
    assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), originalBody)
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
    await compact.getByRole('button', { name: 'Add property', exact: true }).click()
    await compact.getByLabel('Property label', { exact: true }).fill(field)
    await compact.getByLabel('Property key', { exact: true }).fill('editorial-date')
    await compact.getByRole('combobox', { name: 'Property type', exact: true }).click()
    await page.getByRole('option', { name: 'Date', exact: true }).click()
    await compact.getByRole('button', { name: 'Create property', exact: true }).click()
    await compact.getByRole('button', { name: `Edit ${field}`, exact: true }).click()
    await compact.getByLabel(`${field} value`, { exact: true }).fill('2024-02-29T17:06:01.15Z')
    await compact.getByRole('button', { name: 'Save property', exact: true }).click()
    await compact.getByText(canonicalDate, { exact: true }).waitFor()
  } finally {
    await page.setViewportSize(desktopViewport)
  }
  await pane(page).getByText(canonicalDate, { exact: true }).waitFor()
  observations.push('The compact Inspector commits a leap-day UTC date and the desktop pane shows the same canonical millisecond value.')
}
