import { assertStatus } from './response-status-fixture.mjs'
import { createCanvasThroughUi } from './browser-authoring-fixture.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCanvasReferenceResolution } from '../../src/Contracts/canvas-graph.ts'
import { decodeDraft, encodeArticleCommand, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { canvasEditorHandoffKey } from '../../src/Web/src/authoring/canvasEditorHandoff.ts'
import { exactButton, roleWithExactName, exactLabel, exactText } from './role-locators.mjs'

export async function exerciseCanvasReferences({ page, origin, createDraft, screenshot, observations }) {
  const viewportBefore = page.viewportSize()
  const title = `Canvas reference history ${Date.now()}`
  const articleTitle = 'Source coordinates <title-literal>'
  const sourceBody = '导言 🧭\n\nRésumé 𝄞 and 彩虹 🌈.\n\n# Planning heading ^planning\n\nA paragraph with <tag> ^detail\n\n' +
    'Duplicate first ^twice\n\nDuplicate second ^twice\n'
  const article = await createDraft(articleTitle, sourceBody)
  assert.equal(article.body, sourceBody)
  const button = name => exactButton(page, name)
  const outline = () => page.getByRole('region', { name: 'Canvas outline' })
  const viewport = () => page.getByRole('region', { name: 'Interactive Canvas Viewport' })
  const preview = () => page.getByRole('region', { name: 'Canvas reference preview' })
  const resolved = () => preview().getByRole('status').filter({ hasText: 'Reference resolved.' })
  const openAction = () => exactButton(preview(), 'Open in editor')
  const nativeEditor = () => page.locator('.el-markdown-editor')
  const canvasHeading = roleWithExactName(page, 'heading', title)
  const editorPath = `${origin}/admin/articles/edit/${article.id}`
  const draftReadPath = id => origin + WireRoutes.Draft.replace('{id:int}', String(id))
  const referencePrefix = WireRoutes.CanvasReference.split('{id:guid}', 1)[0]
  let canvasUrl

  async function createCanvas(name) {
    await createCanvasThroughUi(page, origin, name)
    await page.waitForURL(url => url.pathname.startsWith('/admin/canvas/'))
    await roleWithExactName(page, 'heading', name).waitFor()
    await button('Outline').click()
    return page.url()
  }

  async function fillReference(kind, { anchor, pinned, articleId = article.id } = {}) {
    await button('Add reference').click()
    const dialog = page.getByRole('dialog', { name: 'Add node' })
    await dialog.getByLabel('Reference type').selectOption(kind)
    await exactLabel(dialog, 'Article ID').fill(String(articleId))
    if (anchor !== undefined) await dialog.getByLabel('Anchor ID').fill(anchor)
    if (pinned) await dialog.getByLabel('Pinned revision (optional)').fill(String(pinned))
    return dialog
  }

  async function add(kind, options = {}) {
    const dialog = await fillReference(kind, options)
    await exactButton(dialog, 'Save node').click()
    await dialog.waitFor({ state: 'hidden' })
    const nodeName = { 'article-reference': 'Article', 'heading-reference': 'Heading', 'block-reference': 'Block' }[kind]
    await exactButton(outline(), `${nodeName} reference ${options.articleId ?? article.id}`).first().waitFor()
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
    assertStatus(response, 200)
    return decodeCanvasReferenceResolution(decodeFrame(await response.body(), FrameType.CanvasReferenceResolution).payload)
  }

  async function resolveSelected() {
    const pending = page.waitForResponse(response => {
      const address = new URL(response.url())
      return response.request().method() === 'GET' && address.origin === origin && address.pathname.startsWith(referencePrefix) &&
        address.pathname.includes('/references/') && address.searchParams.has('revision') && !address.searchParams.has('current')
    })
    await exactButton(preview(), 'Resolve reference').click()
    const response = await pending
    return { address: new URL(response.url()), resolution: await readReference(response) }
  }

  function currentRead(witness, address) {
    return address.origin === witness.address.origin && address.pathname === witness.address.pathname &&
      address.searchParams.get('revision') === witness.address.searchParams.get('revision') &&
      address.searchParams.get('current') === '1' && address.searchParams.size === 2
  }

  async function openResolved(witness, anchor, { draft = article, editorSource = draft.body } = {}) {
    const marker = anchor === undefined ? null : draft.body.indexOf(`^${anchor}`)
    const caret = anchor === undefined ? null : editorSource.indexOf(`^${anchor}`)
    if (marker !== null) {
      assert(marker > 0 && caret > 0)
      assert(Buffer.byteLength(draft.body.slice(0, marker)) > marker, 'Fixture must distinguish byte and UTF-16 offsets')
    }
    assert.equal(witness.resolution.articleId, draft.id)
    assert.equal(witness.resolution.articleRevision, draft.revision)
    assert.equal(witness.resolution.sourceOffset, marker)
    const pending = page.waitForResponse(response => response.request().method() === 'GET' && currentRead(witness, new URL(response.url())))
    const readDraft = page.waitForResponse(response => response.request().method() === 'GET' && response.url() === draftReadPath(draft.id))
    await openAction().click()
    assert.deepEqual(await readReference(await pending), witness.resolution, 'Current-only preflight must repeat the exact resolved witness')
    await page.waitForURL(url => url.origin + url.pathname === `${origin}/admin/articles/edit/${draft.id}`)
    const draftReceipt = await readDraft
    assertStatus(draftReceipt, 200)
    assert.deepEqual(decodeDraft(decodeFrame(await draftReceipt.body(), FrameType.Draft).payload), draft)
    await nativeEditor().waitFor()
    await page.waitForFunction(({ source, titleValue, caret }) => {
      const field = document.querySelector('#article-body')
      const title = document.querySelector('#article-title')
      return title instanceof HTMLInputElement && title.value === titleValue && field instanceof HTMLTextAreaElement && field.value === source &&
        (caret === null || field.selectionStart === caret && field.selectionEnd === caret)
    }, { source: editorSource, titleValue: draft.title, caret })
    await page.waitForFunction(key => !Object.hasOwn(history.state ?? {}, key), canvasEditorHandoffKey)
  }

  async function replaceDraft(previous, body) {
    const command = encodeArticleCommand({ id: previous.id, expectedRevision: previous.revision, idempotencyKey: randomUUID(), title: previous.title, body })
    const response = await page.request.post(`${origin}${WireRoutes.Save}`, {
      data: Buffer.from(encodeFrame(FrameType.ArticleCommand, command)), headers: { 'Content-Type': 'application/octet-stream' },
    })
    assertStatus(response, 200)
    const updated = decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
    assert.equal(updated.id, previous.id)
    assert.equal(updated.revision, previous.revision + 1n)
    assert.equal(updated.body, body)
    return updated.revision
  }

  async function saveFromEditor(previous, titleValue, rawBody) {
    const planned = page.waitForResponse(response => response.url() === `${origin}${WireRoutes.Save}` && response.request().method() === 'POST')
    await button('Save draft').click()
    const receipt = await planned
    assertStatus(receipt, 200)
    const saved = decodeDraft(decodeFrame(await receipt.body(), FrameType.Draft).payload)
    assert.equal(saved.id, previous.id)
    assert.equal(saved.revision, previous.revision + 1n)
    assert.equal(saved.title, titleValue)
    assert.equal(saved.body, rawBody)
    await exactText(page, 'Draft saved.').waitFor()
    return saved
  }

  async function exerciseCrlf() {
    const lines = ['港口 🧭', '', 'Decomposed Cafe\u0301 with 𝄞.', '', '# Harbor heading ^harbor', '', 'Downstream 🚤 keeps e\u0301.', '']
    const raw = lines.join('\r\n')
    const projected = lines.join('\n')
    const rawCaret = raw.indexOf('^harbor')
    const caret = projected.indexOf('^harbor')
    assert(rawCaret > caret && caret > 0, 'Fixture must distinguish raw and projected UTF-16 offsets')
    assert.notEqual(raw.normalize('NFC'), raw, 'Fixture must contain decomposed Unicode')
    const original = await createDraft('CRLF source coordinates', raw)
    assert.equal(original.body, raw)

    await page.setViewportSize({ width: 1280, height: 800 })
    await createCanvas(`${title} CRLF`)
    await add('heading-reference', { anchor: 'harbor', articleId: original.id })
    await exactButton(outline(), `Heading reference ${original.id}`).click()
    const witness = await resolveSelected()
    await resolved().waitFor()
    assert.equal(witness.resolution.sourceOffset, rawCaret)
    await openResolved(witness, 'harbor', { draft: original, editorSource: projected })
    await screenshot(page, 'canvas-reference-editor-crlf')

    async function expectProjected(value, position = null) {
      await page.waitForFunction(({ value, position }) => {
        const field = document.querySelector('#article-body')
        return field instanceof HTMLTextAreaElement && !field.disabled && !field.readOnly && field.value === value &&
          (position === null || field.selectionStart === position && field.selectionEnd === position)
      }, { value, position })
    }

    const editedTitle = 'CRLF source coordinates renamed'
    await expectProjected(projected, caret)
    await roleWithExactName(page, 'textbox', 'Title').fill(editedTitle)
    const titled = await saveFromEditor(original, editedTitle, raw)

    const body = page.locator('#article-body')
    await expectProjected(projected, caret)
    await body.focus()
    const reversible = 'Reversible e\u0301 🧪. '
    await page.keyboard.insertText(reversible)
    await expectProjected(projected.slice(0, caret) + reversible + projected.slice(caret))
    await body.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expectProjected(projected, caret)
    const reverted = await saveFromEditor(titled, editedTitle, raw)

    await expectProjected(projected, caret)
    await body.focus()
    const inserted = ['New line e\u0301 🧪.', 'Trailing marker ']
    await page.keyboard.insertText(inserted.join('\n'))
    const newProjected = projected.slice(0, caret) + inserted.join('\n') + projected.slice(caret)
    const newRaw = raw.slice(0, rawCaret) + inserted.join('\r\n') + raw.slice(rawCaret)
    await expectProjected(newProjected)
    const edited = await saveFromEditor(reverted, editedTitle, newRaw)
    await expectProjected(newProjected)
    const stored = await page.request.get(draftReadPath(original.id))
    assertStatus(stored, 200)
    assert.deepEqual(decodeDraft(decodeFrame(await stored.body(), FrameType.Draft).payload), edited)
    observations.push('Canvas witnesses the raw UTF-16 caret of a uniform CRLF draft and opens its LF editor projection without normalizing decomposed Unicode. Title-only save, undo, and multiline editing retain the exact CRLF source in the saved draft.')
  }

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    canvasUrl = await createCanvas(title)

    await add('article-reference')
    await exactButton(outline(), `Article reference ${article.id}`).click()
    const articleWitness = await resolveSelected()
    await resolved().waitFor()
    assert.equal(articleWitness.resolution.excerpt, null)
    await openResolved(articleWitness)
    await returnToCanvas('outline')

    await add('heading-reference', { anchor: 'planning' })
    await exactButton(outline(), `Heading reference ${article.id}`).click()
    const headingWitness = await resolveSelected()
    await resolved().waitFor()
    await preview().getByRole('heading', { name: /Source coordinates/ }).waitFor()
    await exactText(preview(), `Resolved revision ${article.revision}`).waitFor()
    await preview().getByText(/Planning heading/).waitFor()
    await openResolved(headingWitness, 'planning')
    await returnToCanvas('outline')

    const rejected = await fillReference('block-reference', { anchor: 'twice' })
    const rejectedWrite = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url() === origin + WireRoutes.CanvasGraphWrite)
    await exactButton(rejected, 'Save node').click()
    const denied = await rejectedWrite
    assertStatus(denied, 404)
    decodeFrame(await denied.body(), FrameType.ApiError)
    await rejected.getByRole('alert').filter({ hasText: 'Canvas reference is unavailable.' }).waitFor()
    await exactButton(rejected, 'Cancel').click()
    await rejected.waitFor({ state: 'hidden' })
    assert.equal(await exactButton(outline(), `Block reference ${article.id}`).count(), 0)

    const aging = await createDraft('Anchor from an earlier draft', 'Duplicate first ^twice')
    await add('block-reference', { anchor: 'twice', articleId: aging.id })
    await replaceDraft(aging, 'Duplicate first ^twice\n\nDuplicate second ^twice')
    await exactButton(outline(), `Block reference ${aging.id}`).click()
    assert.equal(await resolved().count(), 0)
    await exactButton(preview(), 'Resolve reference').click()
    await preview().getByRole('status').filter({ hasText: 'The anchor is ambiguous at this revision.' }).waitFor()
    assert.equal(await preview().getByText(/Duplicate (first|second)/).count(), 0)
    assert.equal(await openAction().count(), 0)

    // Switch the same page to the compact viewport, then select the actual spatial node.
    await page.setViewportSize({ width: 375, height: 850 })
    await add('block-reference', { anchor: 'detail', pinned: article.revision })
    await button('Outline').click()
    await selectPinnedBlock()
    const blockWitness = await resolveSelected()
    await resolved().waitFor()
    await exactText(preview(), `Pinned revision ${article.revision}`).waitFor()
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
    await exactButton(outline(), `Heading reference ${article.id}`).click()
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
        const revision = await replaceDraft(article, `A newer draft 🧪.\n\n${sourceBody}`)
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
    await exactText(page, 'The referenced revision is no longer current. Resolve it again from the Canvas.').waitFor()
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
    await exactText(preview(), 'The pinned revision cannot be opened as the current draft.').waitFor()
    await resolved().waitFor()
    await exactText(preview(), `Pinned revision ${article.revision}`).waitFor()
    await preview().getByText(/A paragraph with ‹tag›/).waitFor()
    assert.equal(page.url(), canvasUrl)
    assert.equal(await nativeEditor().count(), 0)
    observations.push('Canvas saves a unique heading and pinned block through the author-only API, refuses an ambiguous new anchor, reports ambiguity after a valid anchor becomes duplicated, and clears previews after viewport changes and reload.')
    observations.push('Canvas opens the exact current article with no retained handoff, reveals verified heading and block anchors at their UTF-16 source offsets in FsusUI, refuses an intervening draft revision before mounting the editor, and retains the historical pinned preview with no action for ambiguous anchors.')
    await exerciseCrlf()
  } catch (error) {
    await screenshot(page, 'canvas-reference-failed').catch(() => {})
    throw error
  } finally {
    if (viewportBefore) await page.setViewportSize(viewportBefore)
  }
}
