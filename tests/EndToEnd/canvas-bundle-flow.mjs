import { assertStatus } from './response-status-fixture.mjs'
import { roleWithExactName, exactLabel, exactText } from './role-locators.mjs'
import { createCanvasThroughUi } from './browser-authoring-fixture.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCanvasGraphList, decodeCanvasGraphPage } from '../../src/Contracts/canvas-graph.ts'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exerciseCanvasBundle({ page, origin, screenshot, observations, createDraft }) {
  const previousViewport = page.viewportSize()
  const name = `Canvas bundle roundtrip ${Date.now()}`
  const note = 'Private planning note for the Canvas bundle.'
  const originalSource = 'Original source owns this paragraph ^proof\n'
  const remappedSource = 'Mapped source owns this paragraph ^proof\n'
  const article = await createDraft('Private original source title', originalSource)
  const remapped = await createDraft('Private mapped source title', remappedSource)
  const button = label => roleWithExactName(page, 'button', label)
  const dialog = label => roleWithExactName(page, 'dialog', label)
  const heading = label => roleWithExactName(page, 'heading', label)
  const importDialog = () => dialog('Import Canvas bundle')
  const exportLink = () => roleWithExactName(page, 'link', 'Export Canvas bundle')
  const documentId = () => new URL(page.url()).pathname.split('/').at(-1)

  async function aeds(path, type, decode) {
    const result = await page.request.get(origin + path)
    assertStatus(result, 200)
    return decode(decodeFrame(await result.body(), type).payload)
  }
  const canvasList = async () => (await aeds(WireRoutes.CanvasGraphList, FrameType.CanvasGraphList, decodeCanvasGraphList))
    .map(canvas => ({ id: canvas.id, revision: canvas.revision }))
  const graph = id => aeds(WireRoutes.CanvasGraphPage.replace('{id:guid}', id), FrameType.CanvasGraphPage, decodeCanvasGraphPage)
  const draft = id => aeds(WireRoutes.Draft.replace('{id:int}', String(id)), FrameType.Draft, decodeDraft)

  async function upload(bytes) {
    await button('Import Canvas').click()
    await exactLabel(importDialog(), 'Canvas bundle file').setInputFiles({
      name: 'canvas.fsuscanvas', mimeType: 'application/vnd.fsus.canvas+json', buffer: bytes,
    })
  }

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await createCanvasThroughUi(page, origin, name)
    await heading(name).waitFor()
    const originalId = documentId()

    await button('Add note').click()
    const add = dialog('Add node')
    await add.getByLabel('Note text').fill(note)
    await roleWithExactName(add, 'button', 'Save node').click()
    await add.waitFor({ state: 'hidden' })
    await exactText(page, 'Revision 2 · 1/1 nodes · 0/0 edges').waitFor()
    await button('Add reference').click()
    await add.getByLabel('Reference type').selectOption('block-reference')
    await exactLabel(add, 'Article ID').fill(String(article.id))
    await add.getByLabel('Anchor ID').fill('proof')
    await add.getByLabel('Pinned revision (optional)').fill(String(article.revision))
    await roleWithExactName(add, 'button', 'Save node').click()
    await add.waitFor({ state: 'hidden' })
    const display = exactText(page, 'Revision 3 · 2/2 nodes · 0/0 edges')
    await display.waitFor()
    const before = await graph(originalId)
    const configuredHref = await exportLink().getAttribute('href')
    assert.equal(configuredHref, `${WireRoutes.CanvasBundleExport.replace('{id:guid}', originalId)}?revision=3`)
    const downloadPromise = page.waitForEvent('download')
    await exportLink().click()
    const download = await downloadPromise
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
    assert.match(repeat.headers()['cache-control'], /no-store/)
    assert.deepEqual(await repeat.body(), bytes)

    await roleWithExactName(page, 'link', 'All canvases').click()
    await heading('Canvases').waitFor()
    await page.getByRole('link', { name, exact: true }).waitFor()
    const listBefore = await canvasList()
    const tampered = Buffer.from(importedText.replace('Private planning note', 'Altered planning note'), 'utf8')
    await upload(tampered)
    await importDialog().getByRole('alert').filter({ hasText: 'The file could not be validated' }).waitFor()
    assert.deepEqual(await canvasList(), listBefore)
    await roleWithExactName(importDialog(), 'button', 'Cancel').click()
    await importDialog().waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Import Canvas')

    await page.setViewportSize({ width: 375, height: 850 })
    await upload(bytes)
    await exactText(importDialog(), 'Bundle validated. No Canvas has been created.').waitFor()
    const apply = roleWithExactName(importDialog(), 'button', 'Create from bundle')
    assert(await apply.isDisabled())
    assert.deepEqual(await canvasList(), listBefore)
    await roleWithExactName(importDialog(), 'button', 'Cancel').click()
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
    const importedId = documentId()
    assert.notEqual(importedId, originalId)
    const after = await graph(importedId)
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
    assert.equal((await graph(importedId)).header.revision, 1n)
    assert.equal((await graph(originalId)).header.revision, 3n)
    const [originalDraft, mappedDraft] = await Promise.all([draft(article.id), draft(remapped.id)])
    assert.equal(originalDraft.revision, article.revision)
    assert.equal(originalDraft.body, originalSource)
    assert.equal(mappedDraft.revision, remapped.revision)
    assert.equal(mappedDraft.body, remappedSource)
    observations.push(`Canvas downloaded the same exact revision twice (${createHash('sha256').update(bytes).digest('hex')}), rejected tampering, preserved zero-write cancel, and imported a new Canvas at 375px only after an explicit fixed-reference mapping. Both article drafts stayed unchanged.`)
  } catch (error) {
    await screenshot(page, 'canvas-bundle-failed').catch(() => {})
    throw error
  } finally {
    if (previousViewport) await page.setViewportSize(previousViewport)
  }
}
