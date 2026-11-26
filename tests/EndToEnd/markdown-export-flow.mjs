import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { captureAttachmentDownload, inspectDownloadedFile, inspectOfflinePage } from './media-export-fixture.mjs'

export async function readMarkdownDownload(page, button, body) {
  const download = page.waitForEvent('download')
  await button.click()
  const result = await download
  assert.equal(result.suggestedFilename(), 'article.md')
  const bytes = await readFile(await result.path())
  const opening = Buffer.from('---\nfsusFormat: fsusblog-markdown-v2\n')
  assert.deepEqual(bytes.subarray(0, opening.length), opening)
  const closing = Buffer.from('\n---\n')
  const end = bytes.indexOf(closing, opening.length)
  assert(end >= opening.length)
  assert.deepEqual(bytes.subarray(end + closing.length), Buffer.from(body))
  const [, title, revision] = bytes.subarray(0, end).toString('utf8').split('\n').slice(1)
  assert(title.startsWith('title: '))
  assert(/^revision: [1-9]\d*$/.test(revision))
  return { title: JSON.parse(title.slice('title: '.length)), revision: BigInt(revision.slice('revision: '.length)), bytes }
}

async function readAttachmentDownload(page, button, format, type) {
  // Retain the original fetch body at the response event instead of waiting for
  // the click and Blob download to finish before asking Chromium for its bytes.
  const attachment = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/export.${format}`))
    .then(async response => {
      assert.equal(response.status(), 200)
      assert.equal(response.headers()['content-type'], type)
      assert.equal(response.headers()['cache-control'], 'private, no-store')
      return { response, expected: await response.body() }
    })
  const { receipt: { response, expected }, download: result } = await captureAttachmentDownload(page, button, attachment)
  assert.equal(result.suggestedFilename(), `article.${format}`)
  const actual = await readFile(await result.path())
  assert.deepEqual(actual, expected)
  return { result, actual, response }
}

async function readPackageDownload(page, button, format, type) {
  const attachment = await readAttachmentDownload(page, button, format, type)
  assert.deepEqual(attachment.actual.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  return attachment
}

export async function readWordDownload(page, button) {
  const { result } = await readPackageDownload(
    page, button, 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  return result
}

export async function readEpubDownload(page, button) {
  const { result, actual } = await readPackageDownload(page, button, 'epub', 'application/epub+zip')
  assert.equal(actual.readUInt16LE(8), 0)
  assert.equal(actual.readUInt16LE(26), 8)
  assert.equal(actual.readUInt16LE(28), 0)
  assert.equal(actual.subarray(30, 58).toString('ascii'), 'mimetypeapplication/epub+zip')
  return result
}

export async function readPdfDownload(page, button, article, current, selected) {
  const { result, actual, response } = await readAttachmentDownload(page, button, 'pdf', 'application/pdf')
  const url = new URL(response.url())
  assert.equal(url.pathname, `/api/v2/authoring/draft/${article}/export.pdf`)
  assert.deepEqual([...url.searchParams], [['revision', String(current)], ['sourceRevision', String(selected)]])
  assert.match(response.headers()['content-disposition'], /^attachment;.*article\.pdf/u)
  assert.equal(response.headers()['x-content-type-options'], 'nosniff')
  assert(actual.length <= 4 * 1024 * 1024)
  assert.equal(actual.subarray(0, 5).toString('ascii'), '%PDF-')
  assert.equal(actual.subarray(-16).toString('ascii').trimEnd().endsWith('%%EOF'), true)
  return result
}

export async function verifyOfflineHtmlDownload(page, button, title, text, excludedText) {
  const { result, response } = await readAttachmentDownload(page, button, 'html', 'text/html; charset=utf-8')
  const policy = "default-src 'none'; base-uri 'none'; form-action 'none'"
  assert.equal(response.headers()['content-security-policy'], policy + "; frame-ancestors 'none'")
  await inspectDownloadedFile(result, response, 'fsusv2-html-download-', 'article.html', async destination => {
    const browser = page.context().browser()
    assert(browser)
    await inspectOfflinePage(browser, page, destination, async (offline, url) => {
      assert.equal(offline.url(), url)
      assert.equal(await offline.title(), title)
      await offline.getByRole('heading', { name: title, level: 1, exact: true }).waitFor()
      const article = await offline.locator('article').textContent()
      assert(article?.includes(text))
      if (excludedText) assert(!article?.includes(excludedText))
      assert.equal(await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), policy)
      assert.equal(await offline.locator('script, style, link, iframe, object, embed, form, [href], [src]').count(), 0)
      assert.equal(await offline.evaluate(() => performance.getEntriesByType('resource').length), 0)
    })
  })
}
