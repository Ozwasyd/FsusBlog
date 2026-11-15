import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCanvasReferenceResolution } from '../../src/Contracts/canvas-graph.ts'
import { decodeDraft, encodeArticleCommand, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { canvasEditorHandoffKey } from '../../src/Web/src/authoring/canvasEditorHandoff.ts'

export async function exerciseCanvasReferences({ page, origin, createDraft, screenshot, observations }) {
  const viewportBefore = page.viewportSize()
  const title = `Canvas reference history ${Date.now()}`
  const articleTitle = 'Source coordinates <title-literal>'
  const sourceBody = '导言 🧭\n\nRésumé 𝄞 and 彩虹 🌈.\n\n# Planning heading ^planning\n\nA paragraph with <tag> ^detail\n\n' +
    'Duplicate first ^twice\n\nDuplicate second ^twice\n'
  const article = await createDraft(articleTitle, sourceBody)
  const button = name => page.getByRole('button', { name, exact: true })
  const outline = () => page.getByRole('region', { name: 'Canvas outline' })
  const viewport = () => page.getByRole('region', { name: 'Interactive Canvas Viewport' })
  const preview = () => page.getByRole('region', { name: 'Canvas reference preview' })
  const resolved = () => preview().getByRole('status').filter({ hasText: 'Reference resolved.' })
  const openAction = () => preview().getByRole('button', { name: 'Open in editor', exact: true })
  const nativeEditor = () => page.locator('.el-markdown-editor')
  const canvasHeading = page.getByRole('heading', { name: title, exact: true })
  const editorPath = `${origin}/user/manage/article/edit/${article.id}`
  const draftReadPath = origin + WireRoutes.Draft.replace('{id:int}', String(article.id))
  const referencePrefix = WireRoutes.CanvasReference.split('{id:guid}', 1)[0]
  let canvasUrl

  async function add(kind, anchor, pinned) {
    await button('Add reference').click()
    const dialog = page.getByRole('dialog', { name: 'Add node' })
    await dialog.getByLabel('Reference type').selectOption(kind)
    await dialog.getByLabel('Article ID', { exact: true }).fill(String(article.id))
    if (anchor !== undefined) await dialog.getByLabel('Anchor ID').fill(anchor)
    if (pinned) await dialog.getByLabel('Pinned revision (optional)').fill(String(pinned))
    await dialog.getByRole('button', { name: 'Save node', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const nodeName = { 'article-reference': 'Article', 'heading-reference': 'Heading', 'block-reference': 'Block' }[kind]
    await outline().getByRole('button', { name: `${nodeName} reference ${article.id}`, exact: true }).first().waitFor()
  }

  async function returnToCanvas(mode = 'canvas') {
    await page.goto(canvasUrl)
    await canvasHeading.waitFor()
    if (mode === 'outline') {
      await button('Outline').click()
      await outline().waitFor()
    }
  }

  async function selectPinnedBlock() {
    const node = viewport().getByRole('button', { name: /Article #\d+ · detail · Revision/ })
    await node.waitFor()
    const bounds = await node.boundingBox()
    assert(bounds)
    // The fixture creates overlapping cards; the lowest part of the newest block is unobstructed.
    await node.click({ position: { x: Math.floor(bounds.width / 2), y: Math.floor(bounds.height - 8) } })
  }

  async function readReference(response) {
    assert.equal(response.status(), 200)
    return decodeCanvasReferenceResolution(decodeFrame(await response.body(), FrameType.CanvasReferenceResolution).payload)
  }

  async function resolveSelected() {
    const pending = page.waitForResponse(response => {
      const address = new URL(response.url())
      return response.request().method() === 'GET' && address.origin === origin && address.pathname.startsWith(referencePrefix) &&
        address.pathname.includes('/references/') && address.searchParams.has('revision') && !address.searchParams.has('current')
    })
    await preview().getByRole('button', { name: 'Resolve reference', exact: true }).click()
    const response = await pending
    return { address: new URL(response.url()), resolution: await readReference(response) }
  }

  function currentRead(witness, address) {
    return address.origin === witness.address.origin && address.pathname === witness.address.pathname &&
      address.searchParams.get('revision') === witness.address.searchParams.get('revision') &&
      address.searchParams.get('current') === '1' && address.searchParams.size === 2
  }

  async function openResolved(witness, anchor) {
    const marker = anchor === undefined ? null : sourceBody.indexOf(`^${anchor}`)
    if (marker !== null) {
      assert(marker > 0)
      assert(Buffer.byteLength(sourceBody.slice(0, marker)) > marker, 'Fixture must distinguish byte and UTF-16 offsets')
    }
    assert.equal(witness.resolution.articleId, article.id)
    assert.equal(witness.resolution.articleRevision, article.revision)
    assert.equal(witness.resolution.sourceOffset, marker)
    const pending = page.waitForResponse(response => response.request().method() === 'GET' && currentRead(witness, new URL(response.url())))
    const readDraft = page.waitForResponse(response => response.request().method() === 'GET' && response.url() === draftReadPath)
    await openAction().click()
    assert.deepEqual(await readReference(await pending), witness.resolution, 'Current-only preflight must repeat the exact resolved witness')
    await page.waitForURL(url => url.origin + url.pathname === editorPath)
    const draftReceipt = await readDraft
    assert.equal(draftReceipt.status(), 200)
    assert.deepEqual(decodeDraft(decodeFrame(await draftReceipt.body(), FrameType.Draft).payload), article)
    await nativeEditor().waitFor()
    await page.waitForFunction(({ source, articleTitle, marker }) => {
      const field = document.querySelector('#article-body')
      const title = document.querySelector('#article-title')
      return title instanceof HTMLInputElement && title.value === articleTitle && field instanceof HTMLTextAreaElement && field.value === source &&
        (marker === null || field.selectionStart === marker && field.selectionEnd === marker)
    }, { source: sourceBody, articleTitle, marker })
    await page.waitForFunction(key => !Object.hasOwn(history.state ?? {}, key), canvasEditorHandoffKey)
  }

  async function advanceArticle() {
    const body = `A newer draft 🧪.\n\n${sourceBody}`
    const command = encodeArticleCommand({ id: article.id, expectedRevision: article.revision, idempotencyKey: randomUUID(), title: articleTitle, body })
    const response = await page.request.post(`${origin}${WireRoutes.Save}`, {
      data: Buffer.from(encodeFrame(FrameType.ArticleCommand, command)), headers: { 'Content-Type': 'application/octet-stream' },
    })
    assert.equal(response.status(), 200)
    const updated = decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
    assert.equal(updated.id, article.id)
    assert(updated.revision > article.revision)
    assert.equal(updated.body, body)
    return updated.revision
  }

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(origin + '/user/manage/canvas')
    await button('New Canvas').click()
    const create = page.getByRole('dialog', { name: 'New Canvas' })
    await create.getByLabel('Canvas title').fill(title)
    await create.getByRole('button', { name: 'Save Canvas', exact: true }).click()
    await page.waitForURL(url => url.pathname.startsWith('/user/manage/canvas/'))
    await canvasHeading.waitFor()
    canvasUrl = page.url()
    await button('Outline').click()

    await add('article-reference')
    await outline().getByRole('button', { name: `Article reference ${article.id}`, exact: true }).click()
    const articleWitness = await resolveSelected()
    await resolved().waitFor()
    assert.equal(articleWitness.resolution.excerpt, null)
    await openResolved(articleWitness)
    await returnToCanvas('outline')

    await add('heading-reference', 'planning')
    await outline().getByRole('button', { name: `Heading reference ${article.id}`, exact: true }).click()
    const headingWitness = await resolveSelected()
    await resolved().waitFor()
    await preview().getByRole('heading', { name: /Source coordinates/ }).waitFor()
    await preview().getByText(`Resolved revision ${article.revision}`, { exact: true }).waitFor()
    await preview().getByText(/Planning heading/).waitFor()
    await openResolved(headingWitness, 'planning')
    await returnToCanvas('outline')

    await add('block-reference', 'twice')
    await outline().getByRole('button', { name: `Block reference ${article.id}`, exact: true }).click()
    assert.equal(await resolved().count(), 0)
    await preview().getByRole('button', { name: 'Resolve reference', exact: true }).click()
    await preview().getByRole('status').filter({ hasText: 'The anchor is ambiguous at this revision.' }).waitFor()
    assert.equal(await preview().getByText(/Duplicate (first|second)/).count(), 0)
    assert.equal(await openAction().count(), 0)

    // Switch the same page to the compact viewport, then select the actual spatial node.
    await page.setViewportSize({ width: 375, height: 850 })
    await add('block-reference', 'detail', article.revision)
    await button('Outline').click()
    await selectPinnedBlock()
    const blockWitness = await resolveSelected()
    await resolved().waitFor()
    await preview().getByText(`Pinned revision ${article.revision}`, { exact: true }).waitFor()
    await preview().getByText(/A paragraph with ‹tag›/).waitFor()
    assert.equal(await preview().locator('tag, title-literal').count(), 0)
    await screenshot(page, 'canvas-reference-mobile')
    await openResolved(blockWitness, 'detail')
    await screenshot(page, 'canvas-reference-editor-mobile')
    await returnToCanvas()
    await selectPinnedBlock()
    await resolveSelected()
    await resolved().waitFor()

    await button('Zoom in').click()
    await page.waitForFunction(() => {
      const region = document.querySelector('[aria-label="Canvas reference preview"]')
      return region && !region.textContent.includes('Reference resolved.')
    })
    await page.reload()
    await canvasHeading.waitFor()
    assert.equal(await preview().count(), 0)

    // Commit a new draft after a successful live preflight, while its old result is still held outside the renderer.
    await page.setViewportSize({ width: 1280, height: 800 })
    await button('Outline').click()
    await outline().getByRole('button', { name: `Heading reference ${article.id}`, exact: true }).click()
    const race = await resolveSelected()
    await resolved().waitFor()
    await page.evaluate(() => {
      const field = '.el-markdown-editor, #article-body'
      window.canvasReferenceEditorMounted = false
      const observer = new MutationObserver(records => {
        if (records.some(record => Array.from(record.addedNodes).some(node =>
          node instanceof Element && (node.matches(field) || node.querySelector(field))))) {
          window.canvasReferenceEditorMounted = true
          observer.disconnect()
        }
      })
      observer.observe(document, { childList: true, subtree: true })
    })
    const changed = Promise.withResolvers()
    await page.route(url => currentRead(race, url), async route => {
      try {
        const fresh = await route.fetch({ maxRedirects: 0, maxRetries: 0 })
        assert.deepEqual(await readReference(fresh), race.resolution)
        const revision = await advanceArticle()
        await route.fulfill({ response: fresh })
        changed.resolve(revision)
      } catch (error) {
        await route.abort().catch(() => {})
        changed.resolve(error)
      }
    }, { times: 1 })
    const raceRequest = page.waitForRequest(request => request.method() === 'GET' && currentRead(race, new URL(request.url())))
    await openAction().click()
    await raceRequest
    const changedRevision = await changed.promise
    if (changedRevision instanceof Error) throw changedRevision
    assert.equal(typeof changedRevision, 'bigint')
    await page.getByText('The referenced revision is no longer current. Resolve it again from the Canvas.', { exact: true }).waitFor()
    await page.waitForURL(url => url.origin + url.pathname === editorPath)
    assert.equal(await nativeEditor().count(), 0)
    assert.equal(await page.evaluate(() => window.canvasReferenceEditorMounted), false)

    await page.setViewportSize({ width: 375, height: 850 })
    await returnToCanvas()
    await selectPinnedBlock()
    const historic = await resolveSelected()
    await resolved().waitFor()
    assert.equal(historic.resolution.articleRevision, article.revision)
    assert.equal(historic.resolution.excerpt, blockWitness.resolution.excerpt)
    const historicalRead = page.waitForResponse(response => response.request().method() === 'GET' && currentRead(historic, new URL(response.url())))
    await openAction().click()
    const refusal = await readReference(await historicalRead)
    const { canvasId, nodeId, canvasRevision } = historic.resolution
    assert.deepEqual(refusal, { canvasId, nodeId, canvasRevision, state: 'stale-revision', articleId: null,
      articleRevision: null, pinned: false, title: null, excerpt: null, sourceOffset: null })
    await preview().getByText('The pinned revision cannot be opened as the current draft.', { exact: true }).waitFor()
    await resolved().waitFor()
    await preview().getByText(`Pinned revision ${article.revision}`, { exact: true }).waitFor()
    await preview().getByText(/A paragraph with ‹tag›/).waitFor()
    assert.equal(page.url(), canvasUrl)
    assert.equal(await nativeEditor().count(), 0)
    observations.push('Canvas resolves a heading and a pinned block through the author-only reference API, reports ambiguity, and clears previews after viewport changes and reload.')
    observations.push('Canvas opens the exact current article with no retained handoff, reveals verified heading and block anchors at their UTF-16 source offsets in FsusUI, refuses an intervening draft revision before mounting the editor, and retains the historical pinned preview with no action for ambiguous anchors.')
  } catch (error) {
    await screenshot(page, 'canvas-reference-failed').catch(() => {})
    throw error
  } finally {
    if (viewportBefore) await page.setViewportSize(viewportBefore)
  }
}
