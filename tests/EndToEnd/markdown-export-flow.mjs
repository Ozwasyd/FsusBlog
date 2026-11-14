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
