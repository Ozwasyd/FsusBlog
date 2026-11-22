import { assertStatus } from './response-status-fixture.mjs'
import { exactLabel, roleWithExactName, exactText } from './role-locators.mjs'
import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticleCommand, decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { readMarkdownDownload } from './markdown-export-flow.mjs'

export async function exerciseMarkdownImport({ page, origin, bytes, title, body }) {
  const button = name => page.getByRole('button', { name, exact: true })
  const titleInput = exactLabel(page, 'Title')
  const bodyInput = exactLabel(page, 'Body')
  const launcher = button('Import Markdown')
  const importer = roleWithExactName(page, 'region', 'Import Markdown')
  const action = name => importer.getByRole('button', { name, exact: true })
  const save = button('Save draft')
  const isSave = request => request.method() === 'POST' && new URL(request.url()).pathname === WireRoutes.Save
  const saveRequests = []
  const recordSave = request => { if (isSave(request)) saveRequests.push(request) }
  page.on('request', recordSave)

  async function expectBlank() {
    assert.equal(await titleInput.inputValue(), '')
    assert.equal(await bodyInput.inputValue(), '')
    assert.equal(await save.isEnabled(), false)
    assert.equal(saveRequests.length, 0, 'Loading local Markdown must not save a draft.')
  }
  async function chooseFile(buffer) {
    await exactLabel(importer, 'Markdown file').setInputFiles({
      name: 'article.md', mimeType: 'text/markdown', buffer,
    })
  }
  async function cancelImport() {
    await action('Cancel import').click()
    await importer.waitFor({ state: 'hidden' })
    await expectBlank()
  }

  try {
    await roleWithExactName(page, 'heading', 'New article').waitFor()
    await launcher.waitFor()
    await expectBlank()

    const exported = bytes.toString('utf8')
    const malformed = exported.replace(/^title: .*$/mu, 'title: "unterminated')
    assert.notEqual(malformed, exported)
    await launcher.click()
    await exactLabel(importer, 'Title for plain Markdown').fill('Must not downgrade a named export')
    await exactLabel(importer, 'Markdown to import').fill(malformed)
    await action('Load into draft').click()
    await importer.getByRole('alert').waitFor()
    await cancelImport()

    await launcher.click()
    await chooseFile(Buffer.from([0xc3, 0x28]))
    await importer.getByRole('alert').waitFor()
    await cancelImport()

    await launcher.click()
    await chooseFile(bytes)
    await expectBlank()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
    const sourceId = await exactLabel(importer, 'Markdown to import').getAttribute('id')
    await page.waitForFunction(({ id, value }) => document.getElementById(id)?.value === value,
      { id: sourceId, value: exported.replace(/\r\n?/gu, '\n') })
    await action('Load into draft').click()
    await importer.waitFor({ state: 'hidden' })
    await launcher.waitFor({ state: 'hidden' })
    assert.equal(await titleInput.inputValue(), title)
    assert.equal(await bodyInput.inputValue(), body.replace(/\r\n?/gu, '\n'))
    assert.equal(saveRequests.length, 0)
    await roleWithExactName(page, 'link', 'Back').click()
    await exactText(page, 'Discard unsaved changes?').waitFor()
    await button('Keep writing').click()
    assert.equal(await titleInput.inputValue(), title)

    const [response] = await Promise.all([
      page.waitForResponse(response => isSave(response.request())),
      save.click(),
    ])
    assertStatus(response, 200)
    const request = response.request().postDataBuffer()
    assert(request)
    const command = decodeArticleCommand(decodeFrame(request, FrameType.ArticleCommand).payload)
    assert.deepEqual({ id: command.id, revision: command.expectedRevision, title: command.title, body: command.body },
      { id: 0, revision: 0n, title, body })
    const draft = decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
    assert(draft.id > 0)
    assert.equal(draft.published, false)
    assert.deepEqual({ title: draft.title, body: draft.body }, { title, body })
    assert.equal(saveRequests.length, 1)
    await page.waitForURL(origin + '/admin/articles/edit/' + draft.id)
    await page.reload()
    await roleWithExactName(page, 'heading', 'Edit article').waitFor()
    assert.equal(await titleInput.inputValue(), title)
    assert.equal(await bodyInput.inputValue(), body.replace(/\r\n?/gu, '\n'))
    await launcher.waitFor({ state: 'hidden' })

    await button('Inspector').click()
    const downloaded = await readMarkdownDownload(page, button('Download saved Markdown'), body)
    assert.equal(downloaded.title, title)
    assert.equal(downloaded.revision, draft.revision)
    return draft
  } finally {
    page.off('request', recordSave)
  }
}
