import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { api } from '../../src/Contracts/client.ts'
import { uploadMedia } from '../../src/Contracts/private-media.ts'
import { WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

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
      let asset
      try {
        await api.signIn(ticket)
        assert(cookie)
        asset = await uploadMedia(new File([bytes], file, { type: 'image/png' }), crypto.randomUUID())
        draft = await api.save({ id: 0, expectedRevision: 0n, idempotencyKey: crypto.randomUUID(),
          title: `Private attachments ${name}`, body: 'Public text remains independent of private attachments.' })
      } finally { globalThis.fetch = native }
      await author.addCookies([{ name: 'fsus-v2-session', value: cookie, url: origin, httpOnly: true, sameSite: 'Strict' }])

      const diagnostics = []
      page.on('pageerror', error => diagnostics.push(error.message))
      let revokedPreviewUrl
      page.on('console', item => {
        if (item.type() === 'error' &&
          (item.location().url !== revokedPreviewUrl || !item.text().includes('net::ERR_FILE_NOT_FOUND'))) diagnostics.push(item.text())
      })
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
      const previewUrl = origin + WireRoutes.ArticleMediaPreview
      const [previewResponse] = await Promise.all([
        page.waitForResponse(response => response.url() === previewUrl),
        page.keyboard.press('Enter'),
      ])
      assert.equal(previewResponse.status(), 200)
      const authorization = await previewResponse.request().headerValue('authorization')
      assert(/^Bearer [A-Za-z0-9_-]{91}$/.test(authorization ?? ''), 'Browser supplied the private preview header')
      assert.equal(await previewResponse.request().headerValue('referer'), null)
      const image = page.getByRole('img', { name: file })
      await image.waitFor()
      await page.waitForFunction(asset => [...document.images].find(candidate => candidate.alt === asset)?.naturalWidth === 160, file)
      const objectUrl = await image.getAttribute('src')
      assert(objectUrl?.startsWith('blob:' + origin + '/'), 'Preview used a local object URL')
      const denied = await fetch(previewUrl, { headers: { Authorization: authorization } })
      assert.equal(denied.status, 404)
      assert.equal((await denied.arrayBuffer()).byteLength, 0)
      const withoutAuthorization = await author.request.get(previewUrl)
      assert.equal(withoutAuthorization.status(), 404)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      const ownerPreview = await author.request.get(previewUrl, { headers: { Authorization: authorization } })
      assert.equal(ownerPreview.status(), 200)
      const previewBytes = await ownerPreview.body()
      assert(previewBytes.length > 0)
      await verifyOfflineAttachment(page, draft, asset.id, file, previewBytes)
      await verifyOfflineEpub(page, draft, asset.id, file, previewBytes)
      await page.screenshot({ path: join(evidence, `article-media-${name}.png`), animations: 'disabled' })

      await page.getByRole('button', { name: `Detach ${file}` }).click()
      await page.getByText('No images are attached to this revision.', { exact: true }).waitFor()
      assert.equal((await author.request.get(previewUrl, { headers: { Authorization: authorization } })).status(), 404)
      revokedPreviewUrl = objectUrl
      assert(await page.evaluate(url => new Promise(resolve => {
        const probe = new Image()
        probe.onload = () => resolve(false)
        probe.onerror = () => resolve(true)
        probe.src = url
      }), objectUrl), 'Previous object URL was revoked')
      assert.deepEqual(diagnostics, [])
      assertions.push({ name, viewport, title: await page.title(), uploadedAssetAttached: true, privatePreviewRendered: true,
        anonymousDenied: true, previousTicketInvalidAfterDetach: true, authorizationHeaderOnly: true,
        objectUrlRevoked: true, offlineHtmlImage: true, offlineEpubImage: true, keyboard: true })
    } finally { await author.close() }
  }
} catch (error) { failure = error }
finally {
  await browser.close()
  await writeFile(join(evidence, 'article-media-browser.json'), JSON.stringify({ assertions, failure: failure?.stack }, null, 2))
}
if (failure) throw failure
console.log('Native private previews and offline HTML and EPUB images passed in desktop and narrow Chrome.')

async function downloadAttachment(page, draft, assetId, format) {
  const extension = format.toLowerCase()
  const button = page.getByRole('button', { name: `Download saved ${format} with this image`, exact: true })
  const path = `/api/v2/authoring/draft/${draft.id}/export.${extension}`
  const [response, download] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === path),
    page.waitForEvent('download'),
    button.click(),
  ])
  assert.equal(response.status(), 200)
  const revision = String(draft.revision + 1n)
  assert.deepEqual([...new URL(response.url()).searchParams], [['revision', revision], ['sourceRevision', revision]])
  assert.equal(await response.request().headerValue(WireHeaders.HtmlExportAttachment), assetId)
  assert.equal(response.headers()['cache-control'], 'private, no-store')
  assert.equal(download.suggestedFilename(), `article.${extension}`)
  return { response, download }
}

async function verifyOfflineAttachment(page, draft, assetId, file, previewBytes) {
  const { response, download } = await downloadAttachment(page, draft, assetId, 'HTML')
  const policy = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data:"
  assert.equal(response.headers()['content-security-policy'], policy + "; frame-ancestors 'none'")

  const scratch = await mkdtemp(join(tmpdir(), 'fsusv2-attachment-html-'))
  try {
    const filename = join(scratch, 'article.html')
    await download.saveAs(filename)
    assert.deepEqual(await readFile(filename), await response.body())
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: page.viewportSize() })
    try {
      const network = []
      context.on('request', request => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
      const offline = await context.newPage()
      await offline.goto(pathToFileURL(filename).href)
      assert.equal(await offline.title(), draft.title)
      const image = offline.getByRole('img', { name: file, exact: true })
      await image.waitFor()
      await offline.waitForFunction(() => document.images.length === 1 &&
        document.images[0].naturalWidth === 160 && document.images[0].naturalHeight === 80)
      assert.equal(await image.getAttribute('src'), 'data:image/png;base64,' + previewBytes.toString('base64'))
      assert.equal(await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), policy)
      assert.deepEqual(network, [])
    } finally {
      await context.close()
    }
  } finally {
    await rm(scratch, { recursive: true })
  }
}

async function verifyOfflineEpub(page, draft, assetId, file, previewBytes) {
  const { response, download } = await downloadAttachment(page, draft, assetId, 'EPUB')
  assert.equal(response.headers()['content-type'], 'application/epub+zip')
  const scratch = await mkdtemp(join(tmpdir(), 'fsusv2-attachment-epub-'))
  try {
    const epub = join(scratch, 'article.epub')
    await download.saveAs(epub)
    assert.deepEqual(await readFile(epub), await response.body())
    const extract = entry => execFileSync('unzip', ['-p', epub, entry], { maxBuffer: 2 * 1024 * 1024 })
    const path = 'images/attachment.png'
    const picture = extract('EPUB/' + path)
    assert.deepEqual(picture, previewBytes)
    await mkdir(join(scratch, 'images'))
    await writeFile(join(scratch, path), picture)
    const chapter = join(scratch, 'article.xhtml')
    await writeFile(chapter, extract('EPUB/article.xhtml'))
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: page.viewportSize() })
    try {
      const network = []
      context.on('request', request => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
      const offline = await context.newPage()
      await offline.goto(pathToFileURL(chapter).href)
      assert.equal(await offline.title(), draft.title)
      const image = offline.getByRole('img', { name: file, exact: true })
      assert.equal(await image.getAttribute('src'), path)
      await offline.waitForFunction(() => document.images.length === 1 &&
        document.images[0].naturalWidth === 160 && document.images[0].naturalHeight === 80)
      assert.deepEqual(network, [])
    } finally {
      await context.close()
    }
  } finally {
    await rm(scratch, { recursive: true })
  }
}
