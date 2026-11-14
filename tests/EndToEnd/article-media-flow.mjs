import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api } from '../../src/Contracts/client.ts'
import { uploadMedia } from '../../src/Contracts/private-media.ts'

const { chromium } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
const assertions = []
let failure
try {
  for (const [index, viewport] of [{ width: 1280, height: 800 }, { width: 375, height: 850 }].entries()) {
    const name = index ? 'mobile' : 'desktop'
    const author = await browser.newContext({ viewport, colorScheme: index ? 'dark' : 'light' })
    try {
      const page = await author.newPage()
      await page.goto(`${origin}/login`)
      const bytes = Uint8Array.from(Buffer.from(await page.evaluate(() => {
        const fixture = document.createElement('canvas')
        fixture.width = 160
        fixture.height = 80
        const ctx = fixture.getContext('2d')
        ctx.fillStyle = '#2f5d96'
        ctx.fillRect(0, 0, 160, 80)
        ctx.fillStyle = '#e7aa70'
        ctx.fillRect(24, 20, 78, 34)
        return fixture.toDataURL('image/png').split(',')[1]
      }), 'base64'))
      const file = `private-attachment-${name}.png`
      const ticket = index ? process.env.FSUSBLOG_TEST_MOBILE_TICKET : process.env.FSUSBLOG_TEST_TICKET
      let cookie
      const native = globalThis.fetch
      globalThis.fetch = async (path, options) => {
        const headers = new Headers(options.headers)
        if (cookie) headers.set('Cookie', `fsus-v2-session=${cookie}`)
        const result = await native(new URL(path, origin), { ...options, headers })
        cookie ??= result.headers.get('set-cookie')?.match(/\bfsus-v2-session=([a-f0-9]{64})\b/)?.[1]
        return result
      }
      let draft
      try {
        await api.signIn(ticket)
        assert(cookie)
        await uploadMedia(new File([bytes], file, { type: 'image/png' }), crypto.randomUUID())
        draft = await api.save({ id: 0, expectedRevision: 0n, idempotencyKey: crypto.randomUUID(),
          title: `Private attachments ${name}`, body: 'Public text remains independent of private attachments.' })
      } finally { globalThis.fetch = native }
      await author.addCookies([{ name: 'fsus-v2-session', value: cookie, url: origin, httpOnly: true, sameSite: 'Strict' }])

      const diagnostics = []
      page.on('pageerror', error => diagnostics.push(error.message))
      page.on('console', item => { if (item.type() === 'error') diagnostics.push(item.text()) })
      await page.goto(`${origin}/user/manage/article/edit/${draft.id}`)
      await page.getByRole('button', { name: 'Inspector', exact: true }).click()
      await page.getByRole('button', { name: 'Manage private attachments' }).click()
      const choose = page.getByRole('combobox', { name: 'Choose a private image' })
      await choose.focus()
      await page.keyboard.press('Enter')
      await page.getByRole('option', { name: file }).click()
      await page.getByRole('button', { name: 'Attach image' }).click()
      const preview = page.getByRole('button', { name: `Preview ${file}` })
      await preview.waitFor()
      await preview.focus()
      await page.keyboard.press('Enter')
      const image = page.getByRole('img', { name: file })
      await image.waitFor()
      await page.waitForFunction(asset => [...document.images].find(candidate => candidate.alt === asset)?.naturalWidth === 160, file)
      const path = await image.getAttribute('src')
      const denied = await fetch(new URL(path, origin))
      assert.equal(denied.status, 404)
      assert.equal((await denied.arrayBuffer()).byteLength, 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: join(evidence, `article-media-${name}.png`), animations: 'disabled' })

      await page.getByRole('button', { name: `Detach ${file}` }).click()
      await page.getByText('No images are attached to this revision.', { exact: true }).waitFor()
      assert.equal((await author.request.get(new URL(path, origin).href)).status(), 404)
      assert.deepEqual(diagnostics, [])
      assertions.push({ name, viewport, title: await page.title(), uploadedAssetAttached: true, privatePreviewRendered: true,
        anonymousDenied: true, previousTicketInvalidAfterDetach: true, keyboard: true })
    } finally { await author.close() }
  }
} catch (error) { failure = error }
finally {
  await browser.close()
  await writeFile(join(evidence, 'article-media-browser.json'), JSON.stringify({ assertions, failure: failure?.stack }, null, 2))
}
if (failure) throw failure
console.log('Native article attachment and short-lived private previews passed in desktop and narrow Chrome.')
