import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCanvasBundlePlan, encodeCanvasBundleExecute } from '../../src/Contracts/canvas-bundle.ts'
import { decodeCanvasGraphReceipt, defaultCanvasViewport } from '../../src/Contracts/canvas-graph.ts'
import { decodeCanvasConfirm, decodeCanvasLinked, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { packFrame, sha256Hex } from './admin-workspace-fixture.mjs'
import { canvasFixture } from './browser-authoring-fixture.mjs'
import * as corpusDef from './canvas-scale-corpus.mjs'
import { writeEvidenceJson } from './isolated-browser-fixture.mjs'
import { assertFields, assertStatus, fetchPublicArticle, readFrame } from './response-status-fixture.mjs'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'

const binary = 'application/octet-stream'
const nodeSelector = '.canvas-board__node'
const edgeSelector = '.canvas-board__edges g'
const round = milliseconds => Math.round(milliseconds * 10) / 10
const route = (pattern, id) => pattern.replace(/\{id(?::guid|:int)?\}/, String(id))
const budget = { nodes: 100, edges: 200, outlineRows: 100 }
const matrix = [
  { name: 'desktop-1', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 850 },
  { name: 'desktop-2', width: 1280, height: 800 },
]

async function frame(response, expected) {
  const bytes = await response.body()
  if (response.status() !== 200) {
    const reason = response.headers()['content-type']?.startsWith(binary)
      ? decodeApiError(decodeFrame(bytes, FrameType.ApiError).payload, response.status()).message
      : response.statusText()
    assert.fail(`HTTP ${response.status()} at ${new URL(response.url()).pathname}: ${reason}`)
  }
  return decodeFrame(bytes, expected).payload
}

async function post(page, origin, path, kind, payload, expected, decode) {
  const response = await page.request.post(origin + path, {
    data: packFrame(kind, payload), headers: { 'Content-Type': binary, Accept: binary },
  })
  return decode(await frame(response, expected))
}

function shape(document, revision, counts, viewport) {
  assertFields(document, { revision, nodeCount: counts[0], edgeCount: counts[1], viewport })
}

function mountMetrics(page) {
  return page.evaluate(({ nodeSelector, edgeSelector }) => {
    const peaks = { nodes: 0, edges: 0, outlineRows: 0, observations: 0, longTasks: [] }
    const sample = () => {
      peaks.nodes = Math.max(peaks.nodes, document.querySelectorAll(nodeSelector).length)
      peaks.edges = Math.max(peaks.edges, document.querySelectorAll(edgeSelector).length)
      peaks.outlineRows = Math.max(peaks.outlineRows, document.querySelectorAll('.canvas-outline li').length)
      peaks.observations++
    }
    const mutations = new MutationObserver(sample)
    mutations.observe(document.querySelector('.canvas-workspace'), { childList: true, subtree: true })
    const longTasks = PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver(list => peaks.longTasks.push(...list.getEntries().map(entry => Math.round(entry.duration))))
      : undefined
    longTasks?.observe({ type: 'longtask', buffered: true })
    sample()
    window.readCanvasScaleMetrics = () => {
      mutations.disconnect()
      if (longTasks) {
        peaks.longTasks.push(...longTasks.takeRecords().map(entry => Math.round(entry.duration)))
        longTasks.disconnect()
      }
      return { ...peaks, supportsLongTasks: Boolean(longTasks), navigation: performance.getEntriesByType('navigation')[0]?.toJSON() }
    }
  }, { nodeSelector, edgeSelector })
}

export async function exerciseCanvasScale({ page, origin, screenshot, observations, evidenceDir, createDraft, publishDraft, outsider }) {
  const first = await publishDraft(await createDraft('Canvas scale source', corpusDef.CANVAS_SCALE_ARTICLE_SOURCE))
  const second = await publishDraft(await createDraft('Canvas scale target', corpusDef.CANVAS_SCALE_ARTICLE_SOURCE))
  const corpus = corpusDef.createCanvasScaleCorpus({ first, second })
  assert.equal(corpus.digest, sha256Hex(corpus.bundle))
  const counts = [corpus.nodeCount, corpus.edgeCount]
  assert.deepEqual(counts, [10_000, 10_000])
  const began = performance.now()
  const plan = await post(page, origin, WireRoutes.CanvasBundlePlan, FrameType.CanvasBundleIntake,
    corpus.bundle, FrameType.CanvasBundlePlan, decodeCanvasBundlePlan)
  const planMs = round(performance.now() - began)
  assertFields(plan, { digest: corpus.digest, title: corpus.title, sourceRevision: corpus.sourceRevision, nodeCount: counts[0], edgeCount: counts[1] })
  assert.equal(plan.references.length, corpus.mappings.length)
  assert(plan.references.every((reference, index) => reference.slot === corpus.mappings[index].slot &&
    reference.pinned === (corpus.mappings[index].pinnedRevision !== null)))

  const canvasId = randomUUID()
  const graphPath = route(WireRoutes.CanvasGraphPage, canvasId)
  const exportPath = route(WireRoutes.CanvasBundleExport, canvasId)
  const pageUrl = origin + '/admin/canvas/' + canvasId
  const startedImport = performance.now()
  const created = await post(page, origin, WireRoutes.CanvasBundleExecute, FrameType.CanvasBundleExecute,
    encodeCanvasBundleExecute({
      canvasId, commandId: randomUUID(), digest: corpus.digest, bundle: corpus.bundle, mappings: corpus.mappings,
    }), FrameType.CanvasGraphReceipt, decodeCanvasGraphReceipt)
  const importMs = round(performance.now() - startedImport)
  assertFields(created, { id: canvasId, title: corpus.title })
  shape(created, 1n, counts, defaultCanvasViewport)

  const report = {
    canvasId, corpus: { digest: corpus.digest, checksum: corpus.checksum, bytes: corpus.bundle.length,
      nodes: counts[0], edges: counts[1], mappedReferences: corpus.mappings.length },
    planMs, importMs, budget, trials: [], exactExport: null,
  }
  const beforeViewport = page.viewportSize()
  const canvas = canvasFixture(page, origin)
  const button = name => loc.exactButton(page, name)
  const selection = () => page.getByRole('complementary', { name: 'Selected Canvas record' })
  const toolbar = () => page.getByRole('group', { name: 'Canvas tools' })
  const footer = rev => loc.exactText(page, `Revision ${rev} · ${counts[0]}/${counts[0]} nodes · ${counts[1]}/${counts[1]} edges`)
  const visibleNote = label => loc.exactButton(canvas.board(), 'Note ' + label)
  const finder = () => canvas.outline().getByRole('searchbox', { name: 'Find loaded records' })

  let revision = 1n
  let viewport = { ...defaultCanvasViewport }
  let farNodeX = corpusDef.CANVAS_SCALE_LOCATIONS.farNote.x
  async function timed(trial, name, action) {
    const start = performance.now()
    const result = await action()
    trial.milliseconds[name] = round(performance.now() - start)
    return result
  }

  function write(trial, name, action, expectedViewport) {
    return timed(trial, name, async () => {
      const [response] = await Promise.all([waitForPathResponse(page, () => WireRoutes.CanvasGraphWrite, 'POST'), action()])
      const receipt = decodeCanvasGraphReceipt(await frame(response, FrameType.CanvasGraphReceipt))
      revision += 1n
      assert.equal(receipt.id, canvasId)
      shape(receipt, revision, counts, expectedViewport)
      viewport = { ...expectedViewport }
      await footer(revision).waitFor({ timeout: 180_000 })
      return receipt
    })
  }

  async function pickOutline(label) {
    await finder().fill(label)
    const result = loc.exactButton(canvas.outline(), label)
    await result.press('Enter')
    await loc.exactText(selection(), label).waitFor()
    assert.equal(await result.getAttribute('aria-pressed'), 'true')
  }

  const fetchDraft = article => canvas.draft(article.id)
  const fetchPublic = article => fetchPublicArticle(page.request, origin, article.id)

  async function convertArticleLink() {
    await button('Outline').click()
    await pickOutline(corpusDef.CANVAS_SCALE_FIRST_EDGE)
    const review = canvas.dialog('Review article link')
    const [beforePublic, beforeTarget] = await Promise.all([fetchPublic(first), fetchPublic(second)])
    const started = performance.now()
    await button('Review article link').click()
    const inserted = `\n\n[${second.title}](/article/${second.id})`
    await review.locator('pre').waitFor()
    assert.equal(await review.locator('pre').textContent(), inserted)
    await loc.exactButton(review, 'Cancel').press('Enter')
    await review.waitFor({ state: 'hidden' })
    assert.deepEqual(await fetchDraft(first), first)
    shape((await canvas.graph(canvasId)).header, revision, counts, defaultCanvasViewport)

    await button('Review article link').click()
    const confirmation = origin + WireRoutes.CanvasConfirm
    const committed = Promise.withResolvers()
    const dropConfirmationResponse = async intercepted => {
      try {
        const request = intercepted.request()
        assert.equal(request.method(), 'POST')
        const payload = request.postDataBuffer()
        const expected = decodeCanvasConfirm(decodeFrame(payload, FrameType.CanvasConfirm).payload)
        const upstream = await intercepted.fetch({ maxRetries: 0, maxRedirects: 0 })
        try {
          const receipt = decodeCanvasLinked(await frame(upstream, FrameType.CanvasLinked))
          assert.equal(receipt.planId, expected.planId)
          await intercepted.abort('connectionreset')
          committed.resolve({ receipt, payload })
        } finally {
          await upstream.dispose()
        }
      } catch (cause) {
        await intercepted.abort('failed').catch(() => {})
        committed.reject(cause)
      }
    }
    await page.route(confirmation, dropConfirmationResponse, { times: 1 })
    let accepted
    try {
      accepted = await Promise.all([committed.promise, loc.exactButton(review, 'Confirm link').press('Enter')])
    } finally {
      await page.unroute(confirmation, dropConfirmationResponse)
    }
    const [{ receipt, payload }] = accepted
    assertFields(receipt, { articleId: first.id, articleRevision: first.revision + 1n, canvasRevision: revision + 1n })
    const retry = loc.exactButton(review, 'Retry confirmation')
    await retry.waitFor()
    const [response] = await Promise.all([waitForUrlResponse(page, () => confirmation, 'POST'), retry.press('Enter')])
    assert.deepEqual(response.request().postDataBuffer(), payload)
    assert.deepEqual(await readFrame(response, FrameType.CanvasLinked, decodeCanvasLinked), receipt)
    revision = receipt.canvasRevision
    await review.waitFor({ state: 'hidden' })
    await footer(revision).waitFor({ timeout: 180_000 })

    const linked = await fetchDraft(first)
    assert.deepEqual(linked, { ...first, body: first.body + inserted, revision: first.revision + 1n })
    assert.deepEqual(await fetchDraft(second), second)
    assert.equal(beforePublic.revision, first.revision)
    assert.deepEqual(await fetchPublic(first), beforePublic)
    assert.deepEqual(await fetchPublic(second), beforeTarget)
    report.link = { planId: receipt.planId, articleId: first.id, targetArticleId: second.id, draftRevision: linked.revision,
      publishedRevision: beforePublic.revision, canvasRevision: revision, bodySha256: sha256Hex(linked.body),
      confirmedWithSameBytes: true, milliseconds: round(performance.now() - started) }
  }

  try {
    await canvas.assertAnonymousDenied(pageUrl, corpus.title, graphPath, exportPath + '?revision=1')
    if (outsider) {
      const other = await outsider()
      try {
        for (const [path, code] of [[WireRoutes.CanvasGraphList, 200], [graphPath, 404], [exportPath + '?revision=1', 404]])
          assertStatus(await other.request.get(origin + path), code)
        report.otherOwnerDenied = true
      } finally {
        await other.close()
      }
    }
    for (const settings of matrix) {
      const trial = { name: settings.name, viewport: [settings.width, settings.height], startRevision: revision,
        milliseconds: {}, graphRequests: [], draftReads: 0, writes: 0 }
      report.trials.push(trial)
      const read = event => {
        const url = new URL(event.url())
        if (url.pathname === graphPath) {
          trial.graphRequests.push({ status: event.status(), offset: Number(url.searchParams.get('offset') ?? 0),
            revision: url.searchParams.get('revision') })
        }
        if (url.pathname === WireRoutes.CanvasGraphWrite) trial.writes++
        if (url.pathname === route(WireRoutes.Draft, first.id) || url.pathname === route(WireRoutes.Draft, second.id)) trial.draftReads++
      }
      page.on('response', read)
      try {
        await page.setViewportSize({ width: settings.width, height: settings.height })
        await timed(trial, 'firstPage', async () => {
          await page.goto(pageUrl)
          await loc.exactHeading(page, corpus.title).waitFor()
          await button('Load all records').waitFor()
          await canvas.board().waitFor()
        })
        await mountMetrics(page)
        await timed(trial, 'loadAll', async () => {
          await button('Load all records').click()
          await footer(revision).waitFor({ timeout: 180_000 })
          assert.equal(await button('Load all records').count(), 0)
        })
        const fullReads = trial.graphRequests.slice()
        assert.equal(fullReads[0]?.offset, 0)
        assert(fullReads.length > 1)
        assert(fullReads.every((request, index) => request.status === 200 &&
          (index === 0 || request.offset > fullReads[index - 1].offset && request.revision === revision.toString())))
        assert(fullReads.at(-1).offset >= counts[0])
        if (settings.width > 375) {
          assert.equal(await canvas.board().locator(nodeSelector).count(), budget.nodes)
          assert.equal(await canvas.board().locator(edgeSelector).count(), budget.edges)
        }

        await timed(trial, 'keyboardRoving', async () => {
          const initial = canvas.board().locator(nodeSelector + '[tabindex="0"]')
          assert.equal(await initial.count(), 1)
          const id = await initial.getAttribute('id')
          await initial.focus()
          await page.keyboard.press('End')
          const focused = canvas.board().locator(nodeSelector + ':focus')
          await focused.waitFor()
          assert.notEqual(await focused.getAttribute('id'), id)
          assert.equal(await focused.getAttribute('tabindex'), '0')
          await page.keyboard.press('Home')
          assert.equal(await canvas.board().locator(nodeSelector + ':focus').count(), 1)
        })

        await button('Outline').click()
        assert((await canvas.outline().locator('li').count()) <= budget.outlineRows)
        if (settings.name === 'desktop-1') {
          await timed(trial, 'resolvePinnedHeading', async () => {
            await finder().fill(corpusDef.CANVAS_SCALE_HEADING_ANCHOR)
            await loc.exactButton(canvas.outline(), 'Heading reference ' + second.id).first().press('Enter')
            const preview = loc.exactRegion(selection(), 'Canvas reference preview')
            await loc.exactButton(preview, 'Resolve reference').press('Enter')
            await preview.getByRole('status').filter({ hasText: 'Reference resolved.' }).waitFor()
            await loc.exactText(preview, 'Pinned revision ' + second.revision).waitFor()
            await loc.exactHeading(preview, second.title).waitFor()
            await preview.getByText(/Canvas scale heading/).waitFor()
          })
        }
        await timed(trial, 'findFarEdge', () => pickOutline(corpusDef.CANVAS_SCALE_FAR_EDGE))
        await timed(trial, 'findFarNode', () => pickOutline(corpusDef.CANVAS_SCALE_FAR_NOTE))
        await write(trial, 'seekFarNode', () => button('Show on Canvas').press('Enter'),
          { x: farNodeX - 3500, y: corpusDef.CANVAS_SCALE_LOCATIONS.farNote.y - 3500, zoom: 1000 })
        const farNode = visibleNote(corpusDef.CANVAS_SCALE_FAR_NOTE)
        await farNode.and(page.locator(':focus')).waitFor()
        await write(trial, 'zoom', () => button('Zoom in').click(), { ...viewport, zoom: 1250 })

        await canvas.board().scrollIntoViewIfNeeded()
        const box = await canvas.board().boundingBox()
        assert(box)
        const x = box.x + box.width - 25
        const y = Math.min(box.y + box.height - 90, settings.height - 100)
        assert(y > box.y + 100)
        assert(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('.canvas-board'), { x, y }))
        await write(trial, 'pointerPan', async () => {
          await page.mouse.move(x, y)
          await page.mouse.down()
          await page.mouse.move(x - 50, y + 25, { steps: 12 })
          await page.mouse.up()
        }, { ...viewport, x: viewport.x + 4000, y: viewport.y - 2000 })

        if (settings.name === 'desktop-1') {
          await farNode.focus()
          const farX = () => farNode.evaluate(element => element.getBoundingClientRect().x)
          const beforeMove = await farX()
          const moveStep = async (name, action, dx) => {
            await write(trial, name, action, viewport)
            assert(Math.abs(await farX() - beforeMove - dx) < 1)
          }
          await moveStep('keyboardMove', () => farNode.press('ArrowRight'), 10)
          await loc.exactButton(toolbar(), 'Undo').and(page.locator(':enabled')).waitFor()
          await moveStep('undoMove', () => button('Undo').click(), 0)
          await loc.exactButton(toolbar(), 'Redo').and(page.locator(':enabled')).waitFor()
          await moveStep('redoMove', () => button('Redo').click(), 10)
          farNodeX += 800
        }
        await screenshot(page, 'canvas-scale-' + settings.name)
        await write(trial, 'resetView', () => button('Reset view').click(), defaultCanvasViewport)
        await button('Outline').click()
        await pickOutline(corpusDef.CANVAS_SCALE_NEAR_NOTE)
        await button('Show on Canvas').press('Enter')
        await visibleNote(corpusDef.CANVAS_SCALE_NEAR_NOTE).and(page.locator(':focus')).waitFor()

        shape((await canvas.graph(canvasId, 0, revision)).header, revision, counts, defaultCanvasViewport)
        trial.endRevision = revision
        assert.equal(trial.draftReads, 0)
        assert(trial.graphRequests.every(request => request.status === 200))
        trial.rendering = await page.evaluate(() => window.readCanvasScaleMetrics())
        assert(trial.rendering.nodes <= budget.nodes && trial.rendering.edges <= budget.edges &&
          trial.rendering.outlineRows <= budget.outlineRows)
      } finally {
        page.off('response', read)
      }
    }
    await convertArticleLink()
    const href = await loc.exactLink(page, 'Export Canvas bundle').getAttribute('href')
    assert.equal(href, exportPath + '?revision=' + revision)
    const exportStarted = performance.now()
    const exported = await page.request.get(origin + href)
    assertStatus(exported, 200)
    assert.match(exported.headers()['content-type'], /^application\/vnd\.fsus\.canvas\+json/)
    const bytes = await exported.body()
    const archive = JSON.parse(bytes.toString('utf8'))
    assert.equal(BigInt(archive.sourceRevision), revision)
    assert.deepEqual([archive.nodes.length, archive.edges.length], counts)
    assert.deepEqual(archive.viewport, [0, 0, 1000])
    const original = JSON.parse(corpus.bundle.toString('utf8'))
    const moved = original.nodes.find(node => node[8] === corpusDef.CANVAS_SCALE_FAR_NOTE)
    assert(moved)
    moved[1] = farNodeX
    assert.deepEqual(archive.nodes, original.nodes)
    assert.deepEqual(archive.edges, original.edges)
    const repeatExport = await page.request.get(origin + href)
    assertStatus(repeatExport, 200)
    assert.deepEqual(await repeatExport.body(), bytes)
    report.exactExport = { revision, bytes: bytes.length, digest: sha256Hex(bytes), milliseconds: round(performance.now() - exportStarted) }

    observations.push('Three native Chrome trials loaded all 10,000 nodes and 10,000 edges from the deployed application. The graph stayed within 100 mounted nodes, 200 edge groups and 100 outline rows while seeking, zooming, panning and handling keyboard focus.')
    observations.push('The private graph retained one movement across undo and redo and denied anonymous and other-owner access.')
    observations.push('On the fully loaded graph the author cancelled an explicit link conversion, then confirmed a new plan. The server committed before the first response was lost. The same confirmation bytes returned the same receipt and inserted one draft link, with both published articles and all graph edges preserved.')
    return report
  } finally {
    if (beforeViewport) await page.setViewportSize(beforeViewport)
    if (evidenceDir) await writeEvidenceJson(evidenceDir, 'canvas-scale-trials.json', report, true,
      (_, value) => typeof value === 'bigint' ? value.toString() : value)
  }
}
