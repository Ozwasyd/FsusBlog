import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
  return { title: JSON.parse(title.slice('title: '.length)), revision: BigInt(revision.slice('revision: '.length)) }
}

export async function readWordDownload(page, button) {
  const attachment = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/export.docx'))
  const download = page.waitForEvent('download')
  await button.click()
  const response = await attachment
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(response.headers()['cache-control'], 'private, no-store')
  const result = await download
  assert.equal(result.suggestedFilename(), 'article.docx')
  const actual = await readFile(await result.path())
  assert.deepEqual(actual, await response.body())
  assert.deepEqual(actual.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  return result
}
