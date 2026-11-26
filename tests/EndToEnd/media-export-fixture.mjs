import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function captureAttachmentDownload(page, button, attachment) {
  const [receipt, download] = await Promise.all([attachment, page.waitForEvent('download'), button.click()])
  return { receipt, download }
}

export async function inspectDownloadedFile(download, response, prefix, name, inspect) {
  const scratch = await mkdtemp(join(tmpdir(), prefix))
  try {
    const filename = join(scratch, name)
    await download.saveAs(filename)
    assert.deepEqual(await readFile(filename), await response.body())
    await inspect(filename, scratch)
  } finally {
    await rm(scratch, { recursive: true })
  }
}

export async function inspectOfflinePage(browser, page, filename, inspect) {
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: page.viewportSize() })
  try {
    const network = []
    context.on('request', request => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
    const offline = await context.newPage()
    const url = pathToFileURL(filename).href
    await offline.goto(url)
    await inspect(offline, url)
    assert.deepEqual(network, [])
  } finally {
    await context.close()
  }
}
