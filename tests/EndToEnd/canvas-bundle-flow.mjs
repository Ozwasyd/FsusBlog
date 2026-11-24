import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeCanvasGraphList } from '../../src/Contracts/canvas-graph.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { sha256Hex } from './admin-workspace-fixture.mjs'
import { canvasFixture, createCanvasThroughUi } from './browser-authoring-fixture.mjs'
import { assertNoStore, assertStatus, getFrame } from './response-status-fixture.mjs'
import { exactButton, exactHeading, exactLabel, exactLink, exactText } from './role-locators.mjs'

export async function exerciseCanvasBundle({ page, origin, screenshot, observations, createDraft }) {
  const previousViewport = page.viewportSize()
  const name = `Canvas bundle roundtrip ${Date.now()}`
  const note = 'Private planning note for the Canvas bundle.'
  const originalSource = 'Original source owns this paragraph ^proof\n'
  const remappedSource = 'Mapped source owns this paragraph ^proof\n'
  const article = await createDraft('Private original source title', originalSource)
  const remapped = await createDraft('Private mapped source title', remappedSource)
  const canvas = canvasFixture(page, origin)
  const heading = label => exactHeading(page, label)
  const importDialog = () => canvas.dialog('Import Canvas bundle')
  const exportLink = () => exactLink(page, 'Export Canvas bundle')
  const canvasList = async () => (await getFrame(page.request, origin + WireRoutes.CanvasGraphList,
    FrameType.CanvasGraphList, decodeCanvasGraphList)).map(({ id, revision }) => ({ id, revision }))

  async function upload(bytes) {
    await exactButton(page, 'Import Canvas').click()
    await exactLabel(importDialog(), 'Canvas bundle file').setInputFiles({
      name: 'canvas.fsuscanvas', mimeType: 'application/vnd.fsus.canvas+json', buffer: bytes,
    })
  }

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await createCanvasThroughUi(page, origin, name)
    await heading(name).waitFor()
    const originalId = canvas.documentId()

    await canvas.addNote(note)
    await exactText(page, 'Revision 2 · 1/1 nodes · 0/0 edges').waitFor()
    await canvas.addReference('block-reference', { articleId: article.id, anchor: 'proof', pinned: article.revision })
    await exactText(page, 'Revision 3 · 2/2 nodes · 0/0 edges').waitFor()
    const before = await canvas.graph(originalId)
    const configuredHref = await exportLink().getAttribute('href')
    assert.equal(configuredHref, `${WireRoutes.CanvasBundleExport.replace('{id:guid}', originalId)}?revision=3`)
    const [download] = await Promise.all([page.waitForEvent('download'), exportLink().click()])
    assert.equal(download.suggestedFilename(), 'canvas.fsuscanvas')
    const downloadedPath = await download.path()
    assert(downloadedPath)
    const bytes = await readFile(downloadedPath)
    const importedText = bytes.toString('utf8')
    assert(importedText.includes(note))
    assert(!importedText.includes(originalId) && !importedText.includes(originalSource.trim()) && !importedText.includes(article.title))
    const metadata = JSON.parse(importedText)
    assert.equal(metadata.kind, 'authoring-canvas')
    assert.equal(metadata.version, 1)
    assert.equal(metadata.sourceRevision, 3)
    assert.equal(metadata.nodes.length, 2)
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/)
    const repeat = await page.request.get(origin + configuredHref)
    assertStatus(repeat, 200)
    assert.match(repeat.headers()['content-type'], /^application\/vnd\.fsus\.canvas\+json/)
    await assertNoStore(repeat)
    assert.deepEqual(await repeat.body(), bytes)

    await exactLink(page, 'All canvases').click()
    await heading('Canvases').waitFor()
    await exactLink(page, name).waitFor()
    const listBefore = await canvasList()
    await upload(Buffer.from(importedText.replace('Private planning note', 'Altered planning note'), 'utf8'))
    await importDialog().getByRole('alert').filter({ hasText: 'The file could not be validated' }).waitFor()
    assert.deepEqual(await canvasList(), listBefore)
    await exactButton(importDialog(), 'Cancel').click()
    await importDialog().waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Import Canvas')

    await page.setViewportSize({ width: 375, height: 850 })
    await upload(bytes)
    await exactText(importDialog(), 'Bundle validated. No Canvas has been created.').waitFor()
    const apply = exactButton(importDialog(), 'Create from bundle')
    assert(await apply.isDisabled())
    assert.deepEqual(await canvasList(), listBefore)
    await exactButton(importDialog(), 'Cancel').click()
    await importDialog().waitFor({ state: 'hidden' })
    assert.deepEqual(await canvasList(), listBefore)

    await upload(bytes)
    await exactText(importDialog(), 'Bundle validated. No Canvas has been created.').waitFor()
    const articleId = importDialog().getByLabel(/Reference 1 article ID/)
    const pin = exactLabel(importDialog(), 'Reference 1 fixed revision')
    assert.equal(await articleId.inputValue(), '')
    assert.equal(await pin.inputValue(), '')
    await articleId.fill(String(remapped.id))
    assert(await apply.isDisabled())
    await pin.fill(String(remapped.revision))
    assert(await apply.isEnabled())
    await screenshot(page, 'canvas-bundle-mobile-mapping')
    await apply.click()
    await heading(name).waitFor()
    await exactText(page, 'Revision 1 · 2/2 nodes · 0/0 edges').waitFor()
    const importedId = canvas.documentId()
    assert.notEqual(importedId, originalId)
    const after = await canvas.graph(importedId)
    assert.deepEqual(after.header.viewport, before.header.viewport)
    assert.equal(after.nodes.find(node => node.kind === 'plain-text-note')?.text, note)
    const reference = after.nodes.find(node => node.kind === 'block-reference')
    assert(reference)
    assert.equal(reference.articleId, remapped.id)
    assert.equal(reference.pinnedRevision, remapped.revision)
    assert.equal(reference.anchor, 'proof')
    assert(!before.nodes.some(node => node.id === reference.id))
    await page.reload()
    await heading(name).waitFor()
    assert.equal((await canvas.graph(importedId)).header.revision, 1n)
    assert.equal((await canvas.graph(originalId)).header.revision, 3n)
    const [originalDraft, mappedDraft] = await Promise.all([canvas.draft(article.id), canvas.draft(remapped.id)])
    assert.equal(originalDraft.revision, article.revision)
    assert.equal(originalDraft.body, originalSource)
    assert.equal(mappedDraft.revision, remapped.revision)
    assert.equal(mappedDraft.body, remappedSource)
    observations.push(`Canvas downloaded the same exact revision twice (${sha256Hex(bytes)}), rejected tampering, preserved zero-write cancel, and imported a new Canvas at 375px only after an explicit fixed-reference mapping. Both article drafts stayed unchanged.`)
  } catch (error) {
    await screenshot(page, 'canvas-bundle-failed').catch(() => {})
    throw error
  } finally {
    if (previousViewport) await page.setViewportSize(previousViewport)
  }
}
