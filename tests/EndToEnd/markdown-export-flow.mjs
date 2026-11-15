import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  const attachment = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/export.${format}`))
  const download = page.waitForEvent('download')
  await button.click()
  const response = await attachment
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['content-type'], type)
  assert.equal(response.headers()['cache-control'], 'private, no-store')
  const result = await download
  assert.equal(result.suggestedFilename(), `article.${format}`)
  const actual = await readFile(await result.path())
  assert.deepEqual(actual, await response.body())
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
  const attachment = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/export.html'))
  const download = page.waitForEvent('download')
  await button.click()
  const response = await attachment
  assert.equal(response.status(), 200)
  const policy = "default-src 'none'; base-uri 'none'; form-action 'none'"
  assert.equal(response.headers()['content-security-policy'], policy + "; frame-ancestors 'none'")
  assert.equal(response.headers()['content-type'], 'text/html; charset=utf-8')
  assert.equal(response.headers()['cache-control'], 'private, no-store')
  const result = await download
  assert.equal(result.suggestedFilename(), 'article.html')
  const scratch = await mkdtemp(join(tmpdir(), 'fsusv2-html-download-'))
  try {
    const destination = join(scratch, 'article.html')
    await result.saveAs(destination)
    assert.deepEqual(await readFile(destination), await response.body())
    const browser = page.context().browser()
    assert(browser)
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: page.viewportSize() })
    try {
      const network = []
      context.on('request', request => {
        if (/^https?:/u.test(request.url())) network.push(request.url())
      })
      const offline = await context.newPage()
      const url = pathToFileURL(destination).href
      await offline.goto(url)
      assert.equal(offline.url(), url)
      assert.equal(await offline.title(), title)
      await offline.getByRole('heading', { name: title, level: 1, exact: true }).waitFor()
      const article = await offline.locator('article').textContent()
      assert(article?.includes(text))
      if (excludedText) assert(!article?.includes(excludedText))
      assert.equal(await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), policy)
      assert.equal(await offline.locator('script, style, link, iframe, object, embed, form, [href], [src]').count(), 0)
      assert.equal(await offline.evaluate(() => performance.getEntriesByType('resource').length), 0)
      assert.deepEqual(network, [])
    } finally {
      await context.close()
    }
  } finally {
    await rm(scratch, { recursive: true })
  }
}
