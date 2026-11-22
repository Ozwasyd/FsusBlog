import { assertStatus } from './response-status-fixture.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import { requireWebPackage } from './web-package-fixture.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectDownloadedFile, inspectOfflinePage } from './media-export-fixture.mjs'
import { mediaBootstraps, withMediaSession } from './media-session-fixture.mjs'
import { api } from '../../src/Contracts/client.ts'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { PodWriter } from '../../src/Contracts/binary.ts'
import { uploadMedia } from '../../src/Contracts/private-media.ts'
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exactButton, roleWithExactName, exactText } from './role-locators.mjs'

const { chromium } = requireWebPackage('@playwright/test')
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
      const { asset, second, draft } = await withMediaSession(page, origin, mediaBootstraps[index], async current => {
        const asset = await uploadMedia(new File([bytes], file, { type: 'image/png' }), crypto.randomUUID())
        const second = await uploadMedia(new File([bytes], 'companion-' + file, { type: 'image/png' }), crypto.randomUUID())
        const draft = await api.save({ id: 0, expectedRevision: 0n, idempotencyKey: crypto.randomUUID(),
          title: `Private attachments ${name}`, body: 'Public text remains independent of private attachments.' }, undefined, current)
        return { asset, second, draft }
      })

      const diagnostics = []
      page.on('pageerror', error => diagnostics.push(error.message))
      let revokedPreviewUrl
      page.on('console', item => {
        if (item.type() === 'error' &&
          (item.location().url !== revokedPreviewUrl || !item.text().includes('net::ERR_FILE_NOT_FOUND'))) diagnostics.push(item.text())
      })
      await page.goto(`${origin}/admin/articles/edit/${draft.id}`)
      await exactButton(page, 'Inspector').click()
      await page.getByRole('button', { name: 'Manage private attachments' }).click()
      const choose = page.getByRole('combobox', { name: 'Choose a private image' })
      await choose.focus()
      await page.keyboard.press('Enter')
      await roleWithExactName(page, 'option', file).click()
      await page.getByRole('button', { name: 'Attach image' }).click()
      const preview = page.getByRole('button', { name: `Preview ${file}` })
      await preview.waitFor()
      await preview.focus()
      const previewUrl = origin + WireRoutes.ArticleMediaPreview
      const [previewResponse] = await Promise.all([
        waitForUrlResponse(page, () => previewUrl),
        page.keyboard.press('Enter'),
      ])
      assertStatus(previewResponse, 200)
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
      assertStatus(withoutAuthorization, 404)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      const ownerPreview = await author.request.get(previewUrl, { headers: { Authorization: authorization } })
      assertStatus(ownerPreview, 200)
      const previewBytes = await ownerPreview.body()
      assert(previewBytes.length > 0)
      await verifyOfflineAttachment(page, draft, asset.id, file, previewBytes)
      await verifyOfflineEpub(page, draft, asset.id, file, previewBytes)
      const taskWithImage = process.env.FSUSBLOG_DOCUMENT_EXPORT_TASKS === 'true'
      if (taskWithImage) {
        const [queued] = await Promise.all([
          waitForPathResponse(page, () => WireRoutes.DocumentExportCreate),
          page.getByRole('button', { name: 'Queue HTML with this image' }).click(),
        ])
        assertStatus(queued, 200)
        assert.equal(await queued.request().headerValue(WireHeaders.HtmlExportAttachment), asset.id)
        await page.getByRole('button', { name: 'HTML task added' }).waitFor()
        await exactText(page, 'Document export tasks').click()
        const tasks = page.getByRole('region', { name: 'Document export tasks' })
        const [result] = await Promise.all([
          page.waitForEvent('download'), tasks.getByRole('button', { name: 'Download export' }).click(),
        ])
        const downloaded = await readFile(await result.path(), 'utf8')
        assert(downloaded.includes('data:image/png;base64,' + previewBytes.toString('base64')))
        assert(downloaded.includes('Public text remains independent of private attachments.'))
      }
      const word = await downloadAttachment(page, draft, asset.id, 'Word', 'docx')
      assert.equal(word.response.headers()['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      const wordBytes = await word.response.body()
      assert.deepEqual(await readFile(await word.download.path()), wordBytes)
      assert.deepEqual(execFileSync('unzip', ['-p', await word.download.path(), 'word/media/attachment.png']), previewBytes)

      await choose.press('Enter')
      await roleWithExactName(page, 'option', 'companion-' + file).click()
      await page.getByRole('button', { name: 'Attach image' }).click()
      await exactButton(page, `Use ${file} as draft cover`).waitFor()
      const coverRead = response => new URL(response.url()).pathname === WireRoutes.ArticleMedia.replace('{id:int}', draft.id)
      const [savedCover, attachedCover] = await Promise.all([
        waitForPathResponse(page, () => WireRoutes.ArticleCoverSave),
        page.waitForResponse(response => coverRead(response) && response.headers()['x-fsus-article-cover'] === asset.id),
        exactButton(page, `Use ${file} as draft cover`).click(),
      ])
      assertStatus(savedCover, 200)
      assert.equal(attachedCover.headers()['cache-control'], 'no-store')
      const covered = decodeDraft(decodeFrame(await savedCover.body(), FrameType.Draft).payload)
      assert.equal(covered.revision, draft.revision + 3n)
      assert.equal(covered.body, draft.body)
      const command = savedCover.request()
      const headers = {
        'Content-Type': await command.headerValue('content-type'),
        [WireHeaders.CurrentSession]: await command.headerValue(WireHeaders.CurrentSession.toLowerCase()),
        [WireHeaders.ClientMutationId]: await command.headerValue(WireHeaders.ClientMutationId.toLowerCase()),
      }
      const data = command.postDataBuffer()
      const postCover = origin + WireRoutes.ArticleCoverSave
      async function assertCoverRejected(header, value, data, status) {
        const response = await author.request.post(postCover, { headers: { ...headers, [header]: value }, data })
        assert.equal(response.status(), status)
      }
      const replay = await author.request.post(postCover, { headers, data })
      assertStatus(replay, 200)
      assert.deepEqual(await replay.body(), await savedCover.body())
      await assertCoverRejected(WireHeaders.CurrentSession, 'invalid', data, 409)
      const staleKey = crypto.randomUUID()
      const staleData = coverFrame(draft.id, covered.revision - 1n, staleKey, second.id)
      await assertCoverRejected(WireHeaders.ClientMutationId, staleKey, staleData, 409)
      assert.equal((await fetch(postCover, { method: 'POST', headers, body: data })).status, 401)
      await exactText(page, 'Draft cover').waitFor()

      const [selection, images] = await Promise.all([
        waitForPathResponse(page, () => `/api/v2/authoring/draft/${draft.id}/export.html`),
        page.waitForEvent('download'), page.getByRole('button', { name: 'Download saved HTML with these images' }).click(),
      ])
      assertStatus(selection, 200)
      assert.deepEqual((await selection.request().headerValue(WireHeaders.HtmlExportAttachment)).split(',').sort(),
        [asset.id, second.id].sort())
      assert.equal((await readFile(await images.path(), 'utf8')).split('data:image/png;base64,' + previewBytes.toString('base64')).length, 3)
      await page.screenshot({ path: join(evidence, `article-media-${name}.png`), animations: 'disabled' })
      const [withOtherDetached] = await Promise.all([
        page.waitForResponse(response => coverRead(response) && new URL(response.url()).searchParams.get('revision') === String(covered.revision + 1n)),
        exactButton(page, 'Detach companion-' + file).click(),
      ])
      assert.equal(withOtherDetached.headers()['x-fsus-article-cover'], asset.id)
      const [cleared] = await Promise.all([
        page.waitForResponse(response => coverRead(response) && response.headers()['x-fsus-article-cover'] === 'none'),
        exactButton(page, 'Remove draft cover').click(),
      ])
      const current = BigInt(new URL(cleared.url()).searchParams.get('revision'))
      assert.equal(current, covered.revision + 2n)
      const unattachedKey = crypto.randomUUID()
      const unattached = coverFrame(draft.id, current, unattachedKey, second.id)
      await assertCoverRejected(WireHeaders.ClientMutationId, unattachedKey, unattached, 404)
      await exactText(page, 'Revision history').click()
      await exactButton(page, `Compare revision ${covered.revision}`).click()
      const comparison = roleWithExactName(page, 'dialog', 'Revision comparison')
      const [fields] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).searchParams.get('map') === 'metadata'),
        exactText(comparison, 'Saved summary and classification').press('Enter'),
      ])
      assert.equal(fields.headers()['x-fsus-article-cover'], 'none')
      assert.equal(fields.headers()['x-fsus-source-article-cover'], asset.id)
      await exactText(comparison, `Private image ${asset.id}`).waitFor()
      await comparison.getByLabel('Reason for restoring this draft').fill('Restore the selected private cover.')
      await exactButton(comparison, 'Restore as new draft').click()
      await comparison.waitFor({ state: 'hidden' })
      await exactText(page, 'Draft cover').waitFor()
      await exactButton(page, 'Detach companion-' + file).click()
      await exactButton(page, `Detach ${file}`).click()
      await exactText(page, 'No images are attached to this revision.').waitFor()
      assertStatus(await author.request.get(previewUrl, { headers: { Authorization: authorization } }), 404)
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
        objectUrlRevoked: true, offlineHtmlImage: true, htmlImageBatch: true, offlineEpubImage: true, privateWordImage: true, storedCover: true, coverReplay: true, historicalCover: true, restoredCover: true, taskWithImage, keyboard: true })
    } finally { await author.close() }
  }
} catch (error) { failure = error }
finally {
  await browser.close()
  await writeFile(join(evidence, 'article-media-browser.json'), JSON.stringify({ assertions, failure: failure?.stack }, null, 2))
}
if (failure) throw failure
console.log('Native private previews, draft cover lifecycle and image downloads passed in desktop and narrow Chrome.')

function coverFrame(article, revision, key, asset) {
  const writer = new PodWriter()
  writer.i32(article)
  writer.i64(revision)
  writer.uuid(key)
  writer.uuid(asset)
  return Buffer.from(encodeFrame(FrameType.ArticleCoverCommand, writer.finish()))
}

async function downloadAttachment(page, draft, assetId, format, extension = format.toLowerCase()) {
  const button = exactButton(page, `Download saved ${format} with this image`)
  const path = `/api/v2/authoring/draft/${draft.id}/export.${extension}`
  const [response, download] = await Promise.all([
    waitForPathResponse(page, () => path),
    page.waitForEvent('download'),
    button.click(),
  ])
  assertStatus(response, 200)
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

  await inspectDownloadedFile(download, response, 'fsusv2-attachment-html-', 'article.html', async filename => {
    await inspectOfflinePage(browser, page, filename, async offline => {
      assert.equal(await offline.title(), draft.title)
      const image = roleWithExactName(offline, 'img', file)
      await image.waitFor()
      await offline.waitForFunction(() => document.images.length === 1 &&
        document.images[0].naturalWidth === 160 && document.images[0].naturalHeight === 80)
      assert.equal(await image.getAttribute('src'), 'data:image/png;base64,' + previewBytes.toString('base64'))
      assert.equal(await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), policy)
    })
  })
}

async function verifyOfflineEpub(page, draft, assetId, file, previewBytes) {
  const { response, download } = await downloadAttachment(page, draft, assetId, 'EPUB')
  assert.equal(response.headers()['content-type'], 'application/epub+zip')
  await inspectDownloadedFile(download, response, 'fsusv2-attachment-epub-', 'article.epub', async (epub, scratch) => {
    const extract = entry => execFileSync('unzip', ['-p', epub, entry], { maxBuffer: 2 * 1024 * 1024 })
    const path = 'images/attachment.png'
    const picture = extract('EPUB/' + path)
    assert.deepEqual(picture, previewBytes)
    await mkdir(join(scratch, 'images'))
    await writeFile(join(scratch, path), picture)
    const chapter = join(scratch, 'article.xhtml')
    await writeFile(chapter, extract('EPUB/article.xhtml'))
    await inspectOfflinePage(browser, page, chapter, async offline => {
      assert.equal(await offline.title(), draft.title)
      const image = roleWithExactName(offline, 'img', file)
      assert.equal(await image.getAttribute('src'), path)
      await offline.waitForFunction(() => document.images.length === 1 &&
        document.images[0].naturalWidth === 160 && document.images[0].naturalHeight === 80)
    })
  })
}
