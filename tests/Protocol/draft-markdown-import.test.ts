import assert from 'node:assert/strict'
import test from 'node:test'
import { WireLimits } from '../../src/Contracts/wire.generated.ts'
import { parseDraftMarkdown, readDraftMarkdownFile } from '../../src/Web/src/authoring/draftMarkdownImport.ts'

const header = (title: string, revision = '32') =>
  `---\nfsusFormat: fsusblog-markdown-v2\ntitle: ${title}\nrevision: ${revision}\n---\n`

test('markdown export imports title and exact UTF-8 body without restoring the source revision', async () => {
  const body = '\uFEFF## 中文\r\n\r\nTwo  \r\n\r\n'
  const bytes = new File([header('"\u4e2d\u6587 \\"quoted\\"Z"') + body], 'article.md')
  const result = parseDraftMarkdown(await readDraftMarkdownFile(bytes), 'Unrelated given title')
  assert.deepEqual(result, { title: '中文 "quoted"Z', body })
  assert.deepEqual(parseDraftMarkdown(header('"Title without a body"'), ''), { title: 'Title without a body', body: '' })
  assert.deepEqual(parseDraftMarkdown(header('"\\uFEFFChapter"') + body, ''), { title: '\uFEFFChapter', body })
})

test('plain Markdown requires an explicit title and preserves source text', () => {
  const body = '---\n\n# Heading\r\n title: literal text\r\n'
  assert.deepEqual(parseDraftMarkdown(body, '  A title  '), { title: 'A title', body })
  assert.deepEqual(parseDraftMarkdown(body, '\u0085A title\u0085'), { title: 'A title', body })
  assert.throws(() => parseDraftMarkdown(body, ''), /valid title/)
  assert.throws(() => parseDraftMarkdown(' \n ', 'Title'), /Enter Markdown/)
})

test('legacy and broken export headers cannot fall back to plain Markdown', () => {
  for (const source of [
    '---\ntitle: Old format\nfsusMetadataJson: legacy\n---\nBody',
    header('"unterminated') + 'Body',
    header('"Named too new"', '9223372036854775808') + 'Body',
    header('"Named zero"', '0') + 'Body',
    header('"Named with BOM"').replace(/^---/, '\uFEFF---') + 'Body',
    header('"Wrong format"').replace('markdown-v2', 'markdown-v3') + 'Body',
  ]) assert.throws(() => parseDraftMarkdown(source, 'Valid explicit title'), /header|exported by FsusBlog/)
})

test('import rejects invalid Unicode, draft overflow and invalid UTF-8 before loading', async () => {
  assert.throws(() => parseDraftMarkdown('Invalid \0 body', 'Title'), /NUL/)
  assert.throws(() => parseDraftMarkdown('Invalid \ud800 body', 'Title'), /Unicode/)
  assert.throws(() => parseDraftMarkdown(header('"\\ud800"') + 'Body', ''), /valid title/)
  assert.throws(() => parseDraftMarkdown('text', '字'.repeat(86)), /valid title/)
  assert.throws(() => parseDraftMarkdown('a'.repeat(200_001), 'Title'), /size limit/)
  await assert.rejects(readDraftMarkdownFile(new File([new Uint8Array([0xc3, 0x28])], 'invalid.md')), /UTF-8/)
  await assert.rejects(readDraftMarkdownFile(new File([new Uint8Array(WireLimits.BodyBytes + 2048)], 'oversize.md')), /size limit/)
})
