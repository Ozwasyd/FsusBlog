import { expect, test, type FileChooser, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import { resolveSystemChromiumExecutablePath } from '../support/system-chromium.mjs'

const executablePath = resolveSystemChromiumExecutablePath()
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const pngFile = { name: 'logo.png', mimeType: 'image/png', buffer: pngBytes }

test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=LocalNetworkAccessChecks']
  }
})

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/settingsBrandUploadTrigger.ts', import.meta.url)
).replaceAll('\\', '/')}`

const productionCases = [
  'brand-empty',
  'brand-preview',
  'brand-failed',
  'og-empty',
  'og-preview',
  'icon-set'
] as const
const blockedCases = [
  'brand-disabled',
  'brand-uploading',
  'og-disabled',
  'icon-set-disabled',
  'icon-set-uploading'
] as const
const viewports = [
  { id: '375', width: 375, height: 812 },
  { id: '768', width: 768, height: 1024 },
  { id: '1440', width: 1440, height: 900 }
] as const

async function openFixture(page: Page): Promise<void> {
  await page.route('**/__settings-brand-upload-trigger-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Settings brand upload trigger</title></head>
          <body>
            <div id="settings-brand-upload-trigger-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
    })
  })
  await page.goto('/__settings-brand-upload-trigger-fixture__', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.settingsBrandUploadTriggerReady
  ))).toBe('true')
}

function caseSurface(page: Page, caseName: string) {
  return page.locator(`[data-fixture-case="${caseName}"] [data-settings-upload-surface]`)
}

function triggerOf(page: Page, caseName: string) {
  const surface = caseSurface(page, caseName)
  return surface.locator('[tabindex="0"]')
}

async function inspectCase(page: Page, caseName: string) {
  return page.evaluate((name) => {
    const probe = (window as unknown as {
      __settingsBrandUploadProbe: { inspectCase: (value: string) => Record<string, unknown> }
    }).__settingsBrandUploadProbe
    return probe.inspectCase(name)
  }, caseName)
}

async function collectChoosers(page: Page, action: () => Promise<void>, settleMs = 250): Promise<FileChooser[]> {
  const choosers: FileChooser[] = []
  const onChooser = (chooser: FileChooser) => {
    choosers.push(chooser)
  }
  page.on('filechooser', onChooser)
  try {
    await action()
    await page.waitForTimeout(settleMs)
    return choosers
  } finally {
    page.off('filechooser', onChooser)
  }
}

test.describe('settings brand upload trigger / FsusUI final DOM (#1893)', () => {
  test('published-or-local FsusUI probe rejects nested buttons and accepts the public trigger', async ({ page }) => {
    await openFixture(page)
    const source = await page.evaluate(() => document.documentElement.dataset.fsusuiSource)
    expect(['local', 'published']).toContain(source)

    const legal = await inspectCase(page, 'probe-legal')
    expect(legal.nativeButtons).toBe(0)
    expect(legal.nestedInteractive).toBe(0)
    expect(legal.tabbableOwners).toBe(1)
    expect(legal.activationOwners).toBe(1)
    expect(String(legal.accessibleName)).toContain('选择文件')

    const nested = await inspectCase(page, 'probe-nested')
    expect(nested.nativeButtons).toBe(1)
    expect(Number(nested.nestedInteractive)).toBeGreaterThan(0)
    expect(Number(nested.tabbableOwners)).toBeGreaterThan(1)
  })

  test('production surfaces have one keyboard owner, one name, and no nested interactive', async ({ page }) => {
    await openFixture(page)
    await expect(page.locator('[data-fixture-case="brand-preview"] img')).toHaveAttribute('alt', /点击更换/u)
    await expect(page.locator('[data-fixture-case="brand-failed"] [role="status"]')).toContainText('预览加载失败')
    for (const caseName of productionCases) {
      const report = await inspectCase(page, caseName)
      expect(report.nativeButtons, caseName).toBe(0)
      expect(report.roleButtons, caseName).toBe(0)
      expect(report.nestedInteractive, caseName).toBe(0)
      expect(report.fileInputs, caseName).toBe(1)
      expect(report.activationOwners, caseName).toBe(1)
      expect(report.tabbableOwners, caseName).toBe(1)
      expect(String(report.accessibleName), caseName).not.toBe('')
    }

    const preview = await inspectCase(page, 'brand-preview')
    expect(String(preview.accessibleName)).toMatch(/预览/)
    expect(String(preview.accessibleName)).toMatch(/点击更换/)

    const failed = await inspectCase(page, 'brand-failed')
    expect(failed.state).toBe('preview-failed')
    expect(String(failed.accessibleName)).toMatch(/预览加载失败/)

    for (const caseName of blockedCases) {
      const report = await inspectCase(page, caseName)
      expect(report.nativeButtons, caseName).toBe(0)
      expect(report.nestedInteractive, caseName).toBe(0)
      expect(report.tabbableOwners, caseName).toBe(0)
      expect(report.ariaDisabled, caseName).toBe(true)
    }
  })

  test('pointer, Enter and Space each request the file chooser once', async ({ page }) => {
    await openFixture(page)
    const trigger = triggerOf(page, 'brand-empty')
    await expect(trigger).toBeVisible()

    const pointer = await collectChoosers(page, () => trigger.click())
    expect(pointer).toHaveLength(1)
    await pointer[0].setFiles(pngFile)

    const enter = await collectChoosers(page, async () => {
      await trigger.focus()
      await page.keyboard.press('Enter')
    })
    expect(enter).toHaveLength(1)
    await enter[0].setFiles(pngFile)

    const space = await collectChoosers(page, async () => {
      await trigger.focus()
      await page.keyboard.press(' ')
    })
    expect(space).toHaveLength(1)
    await space[0].setFiles(pngFile)

    const selected = await page.evaluate(() => (
      (window as unknown as { __settingsBrandUploadProbe: { selections: () => Record<string, string[]> } })
        .__settingsBrandUploadProbe.selections()
    ))
    expect(selected['brand:siteLogoUrl']).toEqual(['logo.png', 'logo.png', 'logo.png'])
  })

  test('disabled and uploading surfaces cannot open the chooser by pointer or keyboard', async ({ page }) => {
    await openFixture(page)
    for (const caseName of ['brand-disabled', 'brand-uploading', 'icon-set-disabled', 'icon-set-uploading'] as const) {
      const surface = caseSurface(page, caseName)
      const pointer = await collectChoosers(page, () => surface.click({ force: true }))
      expect(pointer, caseName).toHaveLength(0)
      const keyboard = await collectChoosers(page, async () => {
        await surface.focus()
        await page.keyboard.press('Enter')
        await page.keyboard.press(' ')
      })
      expect(keyboard, caseName).toHaveLength(0)
    }
  })

  test('cancel leaves no loading and the same file can be selected twice', async ({ page }) => {
    await openFixture(page)
    const trigger = triggerOf(page, 'icon-set')
    const first = await collectChoosers(page, () => trigger.click())
    expect(first).toHaveLength(1)
    await trigger.focus()
    expect(await inspectCase(page, 'icon-set')).toMatchObject({ state: 'empty', ariaBusy: false })

    const second = await collectChoosers(page, () => trigger.click())
    expect(second).toHaveLength(1)
    await second[0].setFiles(pngFile)
    const third = await collectChoosers(page, () => trigger.click())
    expect(third).toHaveLength(1)
    await third[0].setFiles(pngFile)

    const selected = await page.evaluate(() => (
      (window as unknown as { __settingsBrandUploadProbe: { selections: () => Record<string, string[]> } })
        .__settingsBrandUploadProbe.selections()
    ))
    expect(selected['icon-set']).toEqual(['logo.png', 'logo.png'])
  })

  test('focus returns to the legal trigger after chooser interception', async ({ page }) => {
    await openFixture(page)
    const trigger = triggerOf(page, 'og-empty')
    await trigger.focus()
    await expect(trigger).toBeFocused()
    const choosers = await collectChoosers(page, () => page.keyboard.press('Enter'))
    expect(choosers).toHaveLength(1)
    await choosers[0].setFiles(pngFile)
    await expect(trigger).toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.tagName === 'BODY')).toBe(false)
    expect(await page.evaluate(() => {
      const active = document.activeElement
      return Boolean(active && active.getAttribute('tabindex') === '0')
    })).toBe(true)
  })

  for (const viewport of viewports) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${theme} ${viewport.id} and 200% zoom keep a single visible owner`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await openFixture(page)
        await page.evaluate((mode) => {
          document.documentElement.classList.toggle('dark', mode === 'dark')
          document.documentElement.dataset.themeMode = mode
          document.documentElement.dataset.themeResolved = mode
        }, theme)

        for (const caseName of productionCases) {
          const report = await inspectCase(page, caseName)
          expect(report.tabbableOwners, caseName).toBe(1)
          expect(report.nestedInteractive, caseName).toBe(0)
          await expect(triggerOf(page, caseName)).toBeVisible()
        }

        await page.evaluate(() => {
          document.documentElement.style.zoom = '2'
        })
        const zoomed = await inspectCase(page, 'brand-empty')
        expect(zoomed.tabbableOwners).toBe(1)
        expect(zoomed.nestedInteractive).toBe(0)
        await expect(triggerOf(page, 'brand-empty')).toBeVisible()
      })
    }
  }
})
