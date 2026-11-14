import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const { chromium } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const url = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const storage = process.env.FSUSBLOG_PRIVATE_MEDIA_ROOT
const tickets = [process.env.FSUSBLOG_TEST_TICKET, process.env.FSUSBLOG_TEST_MOBILE_TICKET]
assert(evidence && storage && tickets.every(Boolean))
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
const results = []
let failure
try {
  for (const [index, viewport] of [{ width: 1280, height: 800 }, { width: 375, height: 850 }].entries()) {
    const context = await browser.newContext({ viewport, colorScheme: index ? 'dark' : 'light' })
    const page = await context.newPage()
    const diagnostics = []
    const name = index ? 'mobile' : 'desktop'
    page.on('pageerror', error => diagnostics.push(error.message))
    page.on('console', info => {
      if (info.type() === 'error' && !info.text().startsWith('Failed to load resource:')) diagnostics.push(info.text())
    })
    page.on('response', response => {
      if (response.status() >= 500 || response.status() >= 400 && new URL(response.url()).pathname.startsWith('/assets/')) {
        diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`)
      }
    })

    await page.goto(`${url}/user/manage/assets`)
    await page.getByText('请使用作者账号登录', { exact: true }).waitFor()
    assert.match(await page.title(), /资产库/)
    assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex')
    assert.equal(await page.getByLabel('选择图片').count(), 0)

    await page.getByRole('link', { name: '登录', exact: true }).click()
    await page.getByLabel('Owner access key').fill(tickets[index])
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.getByRole('heading', { name: 'New article' }).waitFor()
    await page.getByRole('link', { name: '资产库' }).filter({ visible: true }).click()
    await page.getByText('还没有图片', { exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, `private-media-${name}-empty.png`) })

    const fileName = `integration-${name}.png`
    const imageBytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 180
      canvas.height = 90
      const draw = canvas.getContext('2d')
      draw.fillStyle = '#374f6b'
      draw.fillRect(0, 0, 180, 90)
      draw.fillStyle = '#cddfef'
      draw.fillRect(25, 20, 80, 50)
      return canvas.toDataURL('image/png').split(',')[1]
    }), 'base64')
    await page.getByLabel('选择图片').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: imageBytes })
    const upload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/media/upload.aeds')
    await page.getByRole('button', { name: '上传图片' }).click()
    assert.equal((await upload).status(), 200)
    await page.getByRole('status').getByText('图片已保存。').waitFor()
    const show = page.getByRole('button', { name: `查看 ${fileName}` })
    await show.focus()
    await page.keyboard.press('Enter')
    const preview = page.getByRole('img', { name: fileName })
    await preview.waitFor()
    await page.waitForFunction(name => [...document.images].find(image => image.alt === name)?.naturalWidth === 180, fileName)
    assert.equal(await page.getByRole('heading', { name: fileName }).evaluate(node => node === document.activeElement), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    const imageHref = await preview.getAttribute('src')
    const forbidden = await fetch(new URL(imageHref, url))
    assert.equal(forbidden.status, 404)
    assert.equal((await forbidden.arrayBuffer()).byteLength, 0)
    assert.equal((await readdir(storage)).length, 1)
    await page.screenshot({ path: join(evidence, `private-media-${name}-view.png`) })

    await page.getByRole('button', { name: '关闭预览' }).click()
    assert.equal(await show.evaluate(node => node === document.activeElement), true)
    const remove = page.getByRole('button', { name: `删除 ${fileName}` })
    await remove.click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await show.waitFor()
    await remove.click()
    const deletion = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/remove.aeds'))
    await page.getByRole('button', { name: '删除图片', exact: true }).click()
    assert.equal((await deletion).status(), 200)
    await page.getByRole('status').getByText('图片已删除。').waitFor()
    await show.waitFor({ state: 'hidden' })
    const removed = await context.request.get(new URL(imageHref, url).href)
    assert.equal(removed.status(), 404)
    assert.deepEqual(await readdir(storage), [])
    assert.deepEqual(diagnostics, [])
    results.push({ name, viewport, title: await page.title(), upload: true, privateRead: true,
      keyboardFocus: true, remove: true, assetFileRemoved: true, diagnostics })
    await context.close()
  }
} catch (error) { failure = error }
finally {
  await browser.close()
  await writeFile(join(evidence, 'private-media-browser.json'), JSON.stringify({ results, failure: failure?.stack }, null, 2))
}
if (failure) throw failure
console.log('Private PNG upload, authorized image read and file removal verified in desktop and mobile Chrome.')
