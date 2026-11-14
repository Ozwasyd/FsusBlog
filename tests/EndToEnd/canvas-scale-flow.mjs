import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeApiError, decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCanvasBundlePlan, encodeCanvasBundleExecute } from '../../src/Contracts/canvas-bundle.ts'
import { decodeCanvasGraphPage, decodeCanvasGraphReceipt, defaultCanvasViewport } from '../../src/Contracts/canvas-graph.ts'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import {
  CANVAS_SCALE_ARTICLE_SOURCE, CANVAS_SCALE_FAR_EDGE, CANVAS_SCALE_FAR_NOTE, CANVAS_SCALE_LOCATIONS,
  CANVAS_SCALE_HEADING_ANCHOR, CANVAS_SCALE_NEAR_NOTE, createCanvasScaleCorpus,
} from './canvas-scale-corpus.mjs'

const binary = 'application/octet-stream'
const nodeSelector = '.canvas-board__node'
const edgeSelector = '.canvas-board__edges g'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const round = milliseconds => Math.round(milliseconds * 10) / 10
const route = (pattern, id) => pattern.replace('{id:guid}', id).replace('{id:int}', String(id))
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
    data: Buffer.from(encodeFrame(kind, payload)), headers: { 'Content-Type': binary, Accept: binary },
  })
  return decode(await frame(response, expected))
}

function shape(document, revision, counts, viewport) {
  assert.equal(document.revision, revision)
  assert.deepEqual([document.nodeCount, document.edgeCount], counts)
  assert.deepEqual(document.viewport, viewport)
}

async function mountMetrics(page) {
  await page.evaluate(({ nodeSelector, edgeSelector }) => {
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
  const first = await createDraft('Canvas scale source', CANVAS_SCALE_ARTICLE_SOURCE)
  const secondDraft = await createDraft('Canvas scale target', CANVAS_SCALE_ARTICLE_SOURCE)
  const second = await publishDraft(secondDraft)
  const corpus = createCanvasScaleCorpus({ first, second })
  assert.equal(corpus.digest, digest(corpus.bundle))
  const counts = [corpus.nodeCount, corpus.edgeCount]
  assert.deepEqual(counts, [10_000, 10_000])
  const began = performance.now()
  const plan = await post(page, origin, WireRoutes.CanvasBundlePlan, FrameType.CanvasBundleIntake,
    corpus.bundle, FrameType.CanvasBundlePlan, decodeCanvasBundlePlan)
  const planMs = round(performance.now() - began)
  assert.deepEqual([plan.digest, plan.title, plan.sourceRevision, plan.nodeCount, plan.edgeCount, plan.references.length],
    [corpus.digest, corpus.title, corpus.sourceRevision, ...counts, corpus.mappings.length])
  assert(plan.references.every((reference, index) => reference.slot === corpus.mappings[index].slot &&
    reference.pinned === (corpus.mappings[index].pinnedRevision !== null)))

  const canvasId = randomUUID()
  const graphPath = route(WireRoutes.CanvasGraphPage, canvasId)
  const pageUrl = origin + '/user/manage/canvas/' + canvasId
  const startedImport = performance.now()
  const created = await post(page, origin, WireRoutes.CanvasBundleExecute, FrameType.CanvasBundleExecute,
    encodeCanvasBundleExecute({
      canvasId, commandId: randomUUID(), digest: corpus.digest, bundle: corpus.bundle, mappings: corpus.mappings,
    }), FrameType.CanvasGraphReceipt, decodeCanvasGraphReceipt)
  const importMs = round(performance.now() - startedImport)
  assert.equal(created.id, canvasId)
  assert.equal(created.title, corpus.title)
  shape(created, 1n, counts, defaultCanvasViewport)

  const report = {
    canvasId, corpus: { digest: corpus.digest, checksum: corpus.checksum, bytes: corpus.bundle.length,
      nodes: counts[0], edges: counts[1], mappedReferences: corpus.mappings.length },
    planMs, importMs, budget, trials: [], exactExport: null,
  }
  const beforeViewport = page.viewportSize()
  const button = name => page.getByRole('button', { name, exact: true })
  const outline = () => page.getByRole('region', { name: 'Canvas outline' })
  const board = () => page.getByRole('region', { name: 'Interactive Canvas Viewport' })
  const selection = () => page.getByRole('complementary', { name: 'Selected Canvas record' })
  const toolbar = () => page.getByRole('group', { name: 'Canvas tools' })
  const footer = revision => page.getByText(
    `Revision ${revision} · ${counts[0]}/${counts[0]} nodes · ${counts[1]}/${counts[1]} edges`, { exact: true },
  )
  const visibleNote = label => board().getByRole('button', { name: 'Note ' + label, exact: true })
  const finder = () => outline().getByRole('searchbox', { name: 'Find loaded records' })

  let revision = 1n
  let viewport = { ...defaultCanvasViewport }
  let farNodeX = CANVAS_SCALE_LOCATIONS.farNote.x
  async function timed(trial, name, action) {
    const start = performance.now()
    const result = await action()
    trial.milliseconds[name] = round(performance.now() - start)
    return result
  }

  async function write(trial, name, action, expectedViewport) {
    return timed(trial, name, async () => {
      const [response] = await Promise.all([
        page.waitForResponse(reply =>
          new URL(reply.url()).pathname === WireRoutes.CanvasGraphWrite && reply.request().method() === 'POST'),
        action(),
      ])
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
    const result = outline().getByRole('button', { name: label, exact: true })
    await result.press('Enter')
    await selection().getByText(label, { exact: true }).waitFor()
    assert.equal(await result.getAttribute('aria-pressed'), 'true')
  }

  async function verifyAnonymous() {
    const other = await page.context().browser().newContext()
    try {
      const tab = await other.newPage()
      const shell = await tab.goto(pageUrl)
      assert.match(shell.headers()['x-robots-tag'], /noindex/)
      await tab.getByRole('link', { name: 'Log in to access Canvas', exact: true }).waitFor()
      assert.equal(await tab.getByRole('heading', { name: corpus.title, exact: true }).count(), 0)
      assert.equal((await tab.request.get(origin + graphPath)).status(), 401)
      assert.equal((await tab.request.get(origin + route(WireRoutes.CanvasBundleExport, canvasId) + '?revision=1')).status(), 401)
    } finally {
      await other.close()
    }
  }

  try {
    await verifyAnonymous()
    if (outsider) {
      const other = await outsider()
      try {
        assert.equal((await other.request.get(origin + WireRoutes.CanvasGraphList)).status(), 200)
        assert.equal((await other.request.get(origin + graphPath)).status(), 404)
        assert.equal((await other.request.get(
          origin + route(WireRoutes.CanvasBundleExport, canvasId) + '?revision=1')).status(), 404)
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
          await page.getByRole('heading', { name: corpus.title, exact: true }).waitFor()
          await button('Load all records').waitFor()
          await board().waitFor()
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
          assert.equal(await board().locator(nodeSelector).count(), budget.nodes)
          assert.equal(await board().locator(edgeSelector).count(), budget.edges)
        }

        await timed(trial, 'keyboardRoving', async () => {
          const initial = board().locator(nodeSelector + '[tabindex="0"]')
          assert.equal(await initial.count(), 1)
          const id = await initial.getAttribute('id')
          await initial.focus()
          await page.keyboard.press('End')
          const focused = board().locator(nodeSelector + ':focus')
          await focused.waitFor()
          assert.notEqual(await focused.getAttribute('id'), id)
          assert.equal(await focused.getAttribute('tabindex'), '0')
          await page.keyboard.press('Home')
          assert.equal(await board().locator(nodeSelector + ':focus').count(), 1)
        })

        await button('Outline').click()
        assert((await outline().locator('li').count()) <= budget.outlineRows)
        if (settings.name === 'desktop-1') {
          await timed(trial, 'resolvePinnedHeading', async () => {
            await finder().fill(CANVAS_SCALE_HEADING_ANCHOR)
            const heading = outline().getByRole('button', { name: 'Heading reference ' + second.id, exact: true }).first()
            await heading.press('Enter')
            const preview = selection().getByRole('region', { name: 'Canvas reference preview', exact: true })
            await preview.getByRole('button', { name: 'Resolve reference', exact: true }).press('Enter')
            await preview.getByRole('status').filter({ hasText: 'Reference resolved.' }).waitFor()
            await preview.getByText('Pinned revision ' + second.revision, { exact: true }).waitFor()
            await preview.getByRole('heading', { name: second.title, exact: true }).waitFor()
            await preview.getByText(/Canvas scale heading/).waitFor()
          })
        }
        await timed(trial, 'findFarEdge', () => pickOutline(CANVAS_SCALE_FAR_EDGE))
        await timed(trial, 'findFarNode', () => pickOutline(CANVAS_SCALE_FAR_NOTE))
        await write(trial, 'seekFarNode', () => button('Show on Canvas').press('Enter'),
          { x: farNodeX - 3500, y: CANVAS_SCALE_LOCATIONS.farNote.y - 3500, zoom: 1000 })
        const farNode = visibleNote(CANVAS_SCALE_FAR_NOTE)
        await farNode.and(page.locator(':focus')).waitFor()
        await write(trial, 'zoom', () => button('Zoom in').click(), { ...viewport, zoom: 1250 })

        await board().scrollIntoViewIfNeeded()
        const box = await board().boundingBox()
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
          const beforeMove = await farNode.evaluate(element => element.getBoundingClientRect().x)
          await write(trial, 'keyboardMove', () => farNode.press('ArrowRight'), viewport)
          assert(Math.abs(await farNode.evaluate(element => element.getBoundingClientRect().x) - beforeMove - 10) < 1)
          await toolbar().getByRole('button', { name: 'Undo', exact: true }).and(page.locator(':enabled')).waitFor()
          await write(trial, 'undoMove', () => button('Undo').click(), viewport)
          assert(Math.abs(await farNode.evaluate(element => element.getBoundingClientRect().x) - beforeMove) < 1)
          await toolbar().getByRole('button', { name: 'Redo', exact: true }).and(page.locator(':enabled')).waitFor()
          await write(trial, 'redoMove', () => button('Redo').click(), viewport)
          assert(Math.abs(await farNode.evaluate(element => element.getBoundingClientRect().x) - beforeMove - 10) < 1)
          farNodeX += 800
        }
        await screenshot(page, 'canvas-scale-' + settings.name)
        await write(trial, 'resetView', () => button('Reset view').click(), defaultCanvasViewport)
        await button('Outline').click()
        await pickOutline(CANVAS_SCALE_NEAR_NOTE)
        await button('Show on Canvas').press('Enter')
        await visibleNote(CANVAS_SCALE_NEAR_NOTE).and(page.locator(':focus')).waitFor()

        const durable = decodeCanvasGraphPage(await frame(
          await page.request.get(origin + graphPath + '?revision=' + revision), FrameType.CanvasGraphPage))
        shape(durable.header, revision, counts, defaultCanvasViewport)
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
    const href = await page.getByRole('link', { name: 'Export Canvas bundle', exact: true }).getAttribute('href')
    assert.equal(href, route(WireRoutes.CanvasBundleExport, canvasId) + '?revision=' + revision)
    const exportStarted = performance.now()
    const exported = await page.request.get(origin + href)
    assert.equal(exported.status(), 200)
    assert.match(exported.headers()['content-type'], /^application\/vnd\.fsus\.canvas\+json/)
    const bytes = await exported.body()
    const archive = JSON.parse(bytes.toString('utf8'))
    assert.equal(BigInt(archive.sourceRevision), revision)
    assert.deepEqual([archive.nodes.length, archive.edges.length], counts)
    assert.deepEqual(archive.viewport, [0, 0, 1000])
    const original = JSON.parse(corpus.bundle.toString('utf8'))
    const moved = original.nodes.find(node => node[8] === CANVAS_SCALE_FAR_NOTE)
    assert(moved)
    moved[1] = farNodeX
    assert.deepEqual(archive.nodes, original.nodes)
    assert.deepEqual(archive.edges, original.edges)
    const repeatExport = await page.request.get(origin + href)
    assert.equal(repeatExport.status(), 200)
    assert.deepEqual(await repeatExport.body(), bytes)
    report.exactExport = { revision, bytes: bytes.length, digest: digest(bytes), milliseconds: round(performance.now() - exportStarted) }

    for (const article of [first, second]) {
      const stored = decodeDraft(await frame(await page.request.get(origin + route(WireRoutes.Draft, article.id)), FrameType.Draft))
      assert.deepEqual(stored, article)
    }
    observations.push('Three native Chrome trials loaded all 10,000 nodes and 10,000 edges from the deployed application. The graph stayed within 100 mounted nodes, 200 edge groups and 100 outline rows while seeking, zooming, panning and handling keyboard focus.')
    observations.push('The exact Canvas revisions retained the node movement across undo and redo, private Canvas routes denied anonymous access and rejected another authenticated owner, and both article revisions and source bytes remained unchanged.')
    return report
  } finally {
    if (beforeViewport) await page.setViewportSize(beforeViewport)
    if (evidenceDir) await writeFile(join(evidenceDir, 'canvas-scale-trials.json'),
      JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n')
  }
}
