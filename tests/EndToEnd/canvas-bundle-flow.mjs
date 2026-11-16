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
  const button = label => page.getByRole('button', { name: label, exact: true })
  const dialog = label => page.getByRole('dialog', { name: label, exact: true })
  const heading = label => page.getByRole('heading', { name: label, exact: true })
  const importDialog = () => dialog('Import Canvas bundle')
  const exportLink = () => page.getByRole('link', { name: 'Export Canvas bundle', exact: true })
  const documentId = () => new URL(page.url()).pathname.split('/').at(-1)

  async function aeds(path, type, decode) {
    const result = await page.request.get(origin + path)
    assert.equal(result.status(), 200)
    return decode(decodeFrame(await result.body(), type).payload)
  }
  const canvasList = async () => (await aeds(WireRoutes.CanvasGraphList, FrameType.CanvasGraphList, decodeCanvasGraphList))
    .map(canvas => ({ id: canvas.id, revision: canvas.revision }))
  const graph = id => aeds(WireRoutes.CanvasGraphPage.replace('{id:guid}', id), FrameType.CanvasGraphPage, decodeCanvasGraphPage)
  const draft = id => aeds(WireRoutes.Draft.replace('{id:int}', String(id)), FrameType.Draft, decodeDraft)

  async function upload(bytes) {
    await button('Import Canvas').click()
    await importDialog().getByLabel('Canvas bundle file', { exact: true }).setInputFiles({
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
    await add.getByRole('button', { name: 'Save node', exact: true }).click()
    await add.waitFor({ state: 'hidden' })
    await page.getByText('Revision 2 · 1/1 nodes · 0/0 edges', { exact: true }).waitFor()
    await button('Add reference').click()
    await add.getByLabel('Reference type').selectOption('block-reference')
    await add.getByLabel('Article ID', { exact: true }).fill(String(article.id))
    await add.getByLabel('Anchor ID').fill('proof')
    await add.getByLabel('Pinned revision (optional)').fill(String(article.revision))
    await add.getByRole('button', { name: 'Save node', exact: true }).click()
    await add.waitFor({ state: 'hidden' })
    const display = page.getByText('Revision 3 · 2/2 nodes · 0/0 edges', { exact: true })
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
    assert.equal(repeat.status(), 200)
    assert.match(repeat.headers()['content-type'], /^application\/vnd\.fsus\.canvas\+json/)
    assert.match(repeat.headers()['cache-control'], /no-store/)
    assert.deepEqual(await repeat.body(), bytes)

    await page.getByRole('link', { name: 'All canvases', exact: true }).click()
    await heading('Canvases').waitFor()
    await page.getByRole('link', { name, exact: true }).waitFor()
    const listBefore = await canvasList()
    const tampered = Buffer.from(importedText.replace('Private planning note', 'Altered planning note'), 'utf8')
    await upload(tampered)
    await importDialog().getByRole('alert').filter({ hasText: 'The file could not be validated' }).waitFor()
    assert.deepEqual(await canvasList(), listBefore)
    await importDialog().getByRole('button', { name: 'Cancel', exact: true }).click()
    await importDialog().waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Import Canvas')

    await page.setViewportSize({ width: 375, height: 850 })
    await upload(bytes)
    await importDialog().getByText('Bundle validated. No Canvas has been created.', { exact: true }).waitFor()
    const apply = importDialog().getByRole('button', { name: 'Create from bundle', exact: true })
    assert(await apply.isDisabled())
    assert.deepEqual(await canvasList(), listBefore)
    await importDialog().getByRole('button', { name: 'Cancel', exact: true }).click()
    await importDialog().waitFor({ state: 'hidden' })
    assert.deepEqual(await canvasList(), listBefore)

    await upload(bytes)
    await importDialog().getByText('Bundle validated. No Canvas has been created.', { exact: true }).waitFor()
    const articleId = importDialog().getByLabel(/Reference 1 article ID/)
    const pin = importDialog().getByLabel('Reference 1 fixed revision', { exact: true })
    assert.equal(await articleId.inputValue(), '')
    assert.equal(await pin.inputValue(), '')
    await articleId.fill(String(remapped.id))
    assert(await apply.isDisabled())
    await pin.fill(String(remapped.revision))
    assert(await apply.isEnabled())
    await screenshot(page, 'canvas-bundle-mobile-mapping')
    await apply.click()
    await heading(name).waitFor()
    await page.getByText('Revision 1 · 2/2 nodes · 0/0 edges', { exact: true }).waitFor()
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
