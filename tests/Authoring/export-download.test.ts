import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readWordDownload } from '../EndToEnd/markdown-export-flow.mjs'

const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x25, 0xff])

async function fixture(options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'fsus-download-test-'))
  try {
    const file = join(scratch, 'article.docx')
    await writeFile(file, options.actual ?? bytes)
    const responseReady = Promise.withResolvers()
    const downloadReady = Promise.withResolvers()
    const subscribed = []
    let retained = false
    const response = {
      url: () => 'http://127.0.0.1/api/v2/authoring/draft/1/export.docx?revision=1&sourceRevision=1',
      status: () => options.status ?? 200,
      headers: () => ({ 'content-type': options.type ?? type, 'cache-control': options.cache ?? 'private, no-store' }),
      body: async () => { retained = true; return bytes },
    }
    const result = {
      suggestedFilename: () => options.filename ?? 'article.docx',
      path: async () => file,
    }
    const page = {
      waitForResponse: predicate => {
        assert(predicate(response))
        subscribed.push('response')
        return responseReady.promise
      },
      waitForEvent: name => {
        assert.equal(name, 'download')
        subscribed.push('download')
        return downloadReady.promise
      },
    }
    const button = { click: async () => {
      assert.deepEqual(subscribed, ['response', 'download'])
      responseReady.resolve(response)
      await new Promise(resolve => setImmediate(resolve))
      // The body must be requested without waiting for click/download completion.
      if ((options.status ?? 200) === 200 && (options.type ?? type) === type && (options.cache ?? 'private, no-store') === 'private, no-store')
        assert.equal(retained, true)
      downloadReady.resolve(result)
    } }
    assert.equal(await readWordDownload(page, button), result)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

test('export observer retains the original response before the click/download completes', () => fixture())
for (const [name, options] of [
  ['changed download bytes', { actual: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x25, 0]) }],
  ['wrong HTTP status', { status: 403 }],
  ['wrong content type', { type: 'text/html' }],
  ['cacheable private export', { cache: 'public' }],
  ['wrong suggested filename', { filename: 'other.docx' }],
]) {
  test(`export observer still rejects ${name}`, () => assert.rejects(fixture(options), { name: 'AssertionError' }))
}
