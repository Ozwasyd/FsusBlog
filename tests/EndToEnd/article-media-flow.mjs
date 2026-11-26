import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PodWriter } from '../../src/Contracts/binary.ts'
import { uploadMedia } from '../../src/Contracts/private-media.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { packFrame } from './admin-workspace-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { captureAttachmentDownload, inspectDownloadedFile, inspectOfflinePage } from './media-export-fixture.mjs'
import * as media from './media-session-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { waitForPathResponse } from './response-wait-fixture.mjs'
import { exactButton, exactDialog, exactText, roleWithExactName } from './role-locators.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const browser = await isolated.launchChrome()
const assertions = []

async function verifyViewport(author, index, { name, viewport }) {
  const page = await author.newPage()
  await page.goto(`${origin}/login`)
  const bytes = await media.imageBytes(page, [160, 80], ['#2f5d96', '#e7aa70'], [24, 20, 78, 34])
  const file = `private-attachment-${name}.png`
  const { asset, second, draft } = await media.withMediaSession(page, origin, media.mediaBootstraps[index], async current => {
    const asset = await uploadMedia(new File([bytes], file, { type: 'image/png' }), crypto.randomUUID())
    const second = await uploadMedia(new File([bytes], 'companion-' + file, { type: 'image/png' }), crypto.randomUUID())
    const draft = await media.saveMediaDraft(current, `Private attachments ${name}`, 'Public text remains independent of private attachments.')
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
  await exactButton(page, 'Manage private attachments').click()
  await media.attachPrivateImage(page, file)
  const previewUrl = origin + WireRoutes.ArticleMediaPreview
  const { authorization, objectUrl, bytes: previewBytes } = await media.openPrivatePreview(page, origin, file, 160, { close: false, checkReferer: true })
  const denied = await fetch(previewUrl, { headers: { Authorization: authorization } })
  assert.equal(denied.status, 404)
  assert.equal((await denied.arrayBuffer()).byteLength, 0)
  assertStatus(await author.request.get(previewUrl), 404)
  await isolated.assertNoOverflow(page)
  await verifyOfflineAttachment(page, draft, asset.id, file, previewBytes)
  await verifyOfflineEpub(page, draft, asset.id, file, previewBytes)
  const taskWithImage = process.env.FSUSBLOG_DOCUMENT_EXPORT_TASKS === 'true'
  if (taskWithImage) {
    const [queued] = await Promise.all([
      waitForPathResponse(page, () => WireRoutes.DocumentExportCreate),
      exactButton(page, 'Queue HTML with this image').click(),
    ])
    assertStatus(queued, 200)
    assert.equal(await queued.request().headerValue(WireHeaders.HtmlExportAttachment), asset.id)
    await exactButton(page, 'HTML task added').waitFor()
    await exactText(page, 'Document export tasks').click()
    const tasks = page.getByRole('region', { name: 'Document export tasks' })
    const [result] = await Promise.all([
      page.waitForEvent('download'), exactButton(tasks, 'Download export').click(),
    ])
    const downloaded = await readFile(await result.path(), 'utf8')
    assert(downloaded.includes('data:image/png;base64,' + previewBytes.toString('base64')))
    assert(downloaded.includes('Public text remains independent of private attachments.'))
  }
  const word = await downloadAttachment(page, draft, asset.id, 'Word', 'docx')
  assert.equal(word.response.headers()['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.deepEqual(await readFile(await word.download.path()), await word.response.body())
  assert.deepEqual(execFileSync('unzip', ['-p', await word.download.path(), 'word/media/attachment.png']), previewBytes)

  await media.attachPrivateImage(page, 'companion-' + file)
  await exactButton(page, `Use ${file} as draft cover`).waitFor()
  const coverRead = response => new URL(response.url()).pathname === WireRoutes.ArticleMedia.replace('{id:int}', draft.id)
  const { draft: covered, saved: savedCover } = await media.saveDraftCover(page, draft.id, file, asset.id)
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
  async function assertCoverRejected(header, value, body, status) {
    assertStatus(await author.request.post(postCover, { headers: { ...headers, [header]: value }, data: body }), status)
  }
  const replay = await author.request.post(postCover, { headers, data })
  assertStatus(replay, 200)
  assert.deepEqual(await replay.body(), await savedCover.body())
  await assertCoverRejected(WireHeaders.CurrentSession, 'invalid', data, 409)
  const staleKey = crypto.randomUUID()
  await assertCoverRejected(WireHeaders.ClientMutationId, staleKey, coverFrame(draft.id, covered.revision - 1n, staleKey, second.id), 409)
  assert.equal((await fetch(postCover, { method: 'POST', headers, body: data })).status, 401)
  await exactText(page, 'Draft cover').waitFor()

  const [selection, images] = await Promise.all([
    waitForPathResponse(page, () => `/api/v2/authoring/draft/${draft.id}/export.html`),
    page.waitForEvent('download'), exactButton(page, 'Download saved HTML with these images').click(),
  ])
  assertStatus(selection, 200)
  assert.deepEqual((await selection.request().headerValue(WireHeaders.HtmlExportAttachment)).split(',').sort(), [asset.id, second.id].sort())
  assert.equal((await readFile(await images.path(), 'utf8')).split('data:image/png;base64,' + previewBytes.toString('base64')).length, 3)
  await isolated.saveShot(page, evidence, `article-media-${name}.png`)
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
  await assertCoverRejected(WireHeaders.ClientMutationId, unattachedKey, coverFrame(draft.id, current, unattachedKey, second.id), 404)
  await exactText(page, 'Revision history').click()
  await exactButton(page, `Compare revision ${covered.revision}`).click()
  const comparison = exactDialog(page, 'Revision comparison')
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
}

await isolated.withBrowserEvidence(
  browser,
  evidence,
  'article-media-browser.json',
  failure => ({ assertions, failure: failure?.stack }),
  () => isolated.withDesktopAndNarrow(browser, verifyViewport),
)
console.log('Native private previews, draft cover lifecycle and image downloads passed in desktop and narrow Chrome.')

function coverFrame(article, revision, key, asset) {
  const writer = new PodWriter()
  writer.i32(article)
  writer.i64(revision)
  writer.uuid(key)
  writer.uuid(asset)
  return packFrame(FrameType.ArticleCoverCommand, writer.finish())
}

async function downloadAttachment(page, draft, assetId, format, extension = format.toLowerCase()) {
  const attachment = waitForPathResponse(page, () => `/api/v2/authoring/draft/${draft.id}/export.${extension}`)
  const { receipt: response, download } = await captureAttachmentDownload(page,
    exactButton(page, `Download saved ${format} with this image`), attachment)
  assertStatus(response, 200)
  const revision = String(draft.revision + 1n)
  assert.deepEqual([...new URL(response.url()).searchParams], [['revision', revision], ['sourceRevision', revision]])
  assert.equal(await response.request().headerValue(WireHeaders.HtmlExportAttachment), assetId)
  assert.equal(response.headers()['cache-control'], 'private, no-store')
  assert.equal(download.suggestedFilename(), `article.${extension}`)
  return { response, download }
}

function inspectOfflineImage(page, target, draft, file, expectedSrc, policy) {
  return inspectOfflinePage(browser, page, target, async offline => {
    assert.equal(await offline.title(), draft.title)
    const image = roleWithExactName(offline, 'img', file)
    await image.waitFor()
    await offline.waitForFunction(() => document.images.length === 1 &&
      document.images[0].naturalWidth === 160 && document.images[0].naturalHeight === 80)
    assert.equal(await image.getAttribute('src'), expectedSrc)
    if (policy) assert.equal(await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), policy)
  })
}

async function verifyOfflineAttachment(page, draft, assetId, file, previewBytes) {
  const { response, download } = await downloadAttachment(page, draft, assetId, 'HTML')
  const policy = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data:"
  assert.equal(response.headers()['content-security-policy'], policy + "; frame-ancestors 'none'")
  await inspectDownloadedFile(download, response, 'fsusv2-attachment-html-', 'article.html', filename =>
    inspectOfflineImage(page, filename, draft, file, 'data:image/png;base64,' + previewBytes.toString('base64'), policy))
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
    await inspectOfflineImage(page, chapter, draft, file, path)
  })
}
