import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'

const [ui, output, blog] = process.argv.slice(2)
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'cancellation-fixture'
)
const requireUI = createRequire(path.join(ui, 'package.json'))
const { createServer } = await import(
  pathToFileURL(requireUI.resolve('vite'))
)
const { default: vue } = await import(
  pathToFileURL(requireUI.resolve('@vitejs/plugin-vue'))
)
const { chromium, expect } = requireUI('@playwright/test')
const { createFsusUiAliases } = await import(
  pathToFileURL(path.join(
    blog, 'src/frontend/scripts/fsusui-local.ts'
  ))
)

const server = await createServer({
  configFile: false,
  root: fixture,
  plugins: [vue()],
  resolve: {
    dedupe: ['vue'],
    alias: [
      ...createFsusUiAliases(ui),
      {
        find: /^vue$/,
        replacement: path.join(
          ui, 'node_modules/vue/dist/vue.runtime.esm-bundler.js'
        )
      }
    ]
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    fs: { allow: [path.dirname(fixture), ui] }
  }
})

let browser
try {
  await server.listen()
  browser = await chromium.launch()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(server.resolvedUrls.local[0])

  const trigger = page.locator('[data-test=trigger]')
  const menu = page.locator('[data-test=menu]')
  const item = page.locator('[data-test=item]')
  const outside = page.locator('[data-test=outside]')

  await trigger.click()
  await expect(menu).toBeVisible()
  await page.evaluate(async () => {
    await new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
    await Promise.allSettled(
      document.getAnimations()
        .filter(a =>
          a.effect?.getComputedTiming().iterations !== Infinity
        )
        .map(a => a.finished)
    )
  })

  await item.focus()
  await expect(item).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeVisible()

  await outside.click()
  await expect(menu).toBeHidden()
  await page.evaluate(async () => {
    await Promise.allSettled(
      document.getAnimations()
        .filter(a =>
          a.effect?.getComputedTiming().iterations !== Infinity
        )
        .map(a => a.finished)
    )
  })

  const active = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-test')
  )
  await fs.writeFile(output, JSON.stringify({
    ui, active, errors,
    url: page.url(),
    title: await page.title()
  }, null, 2) + '\n')
  await page.screenshot({
    path: output.replace('.json', '.png')
  })

  expect(errors).toEqual([])
  await expect(outside).toBeFocused()
} finally {
  await browser?.close()
  await server.close()
}
