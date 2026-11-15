import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodePropertyEditor, encodePropertySchemaCommand, propertyKinds } from '../../src/Contracts/property-values.ts'
import {
  decodeDraft, decodePropertyCommandReceipt, decodePropertyWorkspaceRequest, encodeArticleCommand, encodeSignIn,
  FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

const { chromium, expect } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const { FSUSBLOG_TEST_URL: url, FSUSBLOG_TEST_TICKET: ticket, FSUSBLOG_TEST_EVIDENCE: evidence,
  FSUSBLOG_TEST_CHROME: executablePath } = process.env
assert(url && ticket && evidence)
const origin = new URL(url).origin
const desktop = { width: 1280, height: 850 }
const compact = { width: 375, height: 850 }
const clock = () => performance.now()
const editorPath = origin + WireRoutes.PropertyEditor
const kindOptions = [{ id: '10000000-0000-4000-8000-000000000001', label: 'Red' },
  { id: '10000000-0000-4000-8000-000000000002', label: 'Blue' }]
const definitionCount = 1_000
const pageSize = WireLimits.PropertyPageSize
const pages = definitionCount / pageSize
assert.equal(pageSize, 25)
assert.equal(pages, 40)
const fields = Array.from({ length: definitionCount }, (_, index) => {
  const ordinal = String(index + 1).padStart(4, '0')
  const kind = propertyKinds[index % propertyKinds.length]
  return { definitionId: randomUUID(), machineKey: `scope-${ordinal}`, label: `Scale field ${ordinal}`, kind,
    options: kind === 'single-select' || kind === 'multi-select' ? kindOptions : [] }
})
const browser = await chromium.launch({ executablePath })
const result = { browser: browser.version(), expectedDefinitions: definitionCount, responses: [], domSamples: [], collectedSamples: [], diagnostics: [] }
let context

try {
  context = await browser.newContext({ viewport: desktop })
  let session
  async function post(path, type, input, expected) {
    const response = await context.request.post(origin + path, {
      data: Buffer.from(encodeFrame(type, input)),
      headers: { 'Content-Type': 'application/octet-stream', ...(session ? { [WireHeaders.CurrentSession]: session } : {}) },
    })
    try {
      assert.equal(response.status(), 200, path)
      return { payload: decodeFrame(await response.body(), expected).payload, headers: response.headers() }
    } finally {
      await response.dispose()
    }
  }

  const signIn = await post(WireRoutes.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }), FrameType.OperatorSession)
  session = signIn.headers[WireHeaders.CurrentSession.toLowerCase()]
  assert(session, 'Scale fixture requires the current protected author session')

  const draft = decodeDraft((await post(WireRoutes.Save, FrameType.ArticleCommand, encodeArticleCommand({
    id: 0, expectedRevision: 0n, idempotencyKey: randomUUID(), title: 'Property scale inspector draft', body: 'Inspector scale source.',
  }), FrameType.Draft)).payload)
  const seedAt = clock()
  let schema = 0n
  for (const field of fields) {
    const payload = encodePropertySchemaCommand({ ...field, operation: 1, requestId: randomUUID(), schemaRevision: schema, definitionRevision: 0n })
    const receipt = decodePropertyCommandReceipt((await post(WireRoutes.PropertySchemaCommand,
      FrameType.PropertySchemaCommand, payload, FrameType.PropertyCommandReceipt)).payload)
    assert.deepEqual(receipt, { definitionId: field.definitionId, schemaRevision: ++schema, revision: 1n })
  }
  result.seedMilliseconds = Math.round(clock() - seedAt)
  result.createdDefinitions = Number(schema)

  const page = await context.newPage()
  const diagnostics = result.diagnostics
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', event => {
    if (event.type() === 'error' && !event.text().startsWith('Failed to load resource:')) diagnostics.push(event.text())
  })
  const editorRead = request => request.method() === 'POST' && request.url() === editorPath
  const readRequests = []
  const readResponses = []
  page.on('request', request => { if (editorRead(request)) readRequests.push(request) })
  page.on('response', response => { if (editorRead(response.request())) readResponses.push(response) })

  const memory = await context.newCDPSession(page)
  let screen = desktop
  const pane = () => page.getByRole(screen === compact ? 'dialog' : 'complementary', { name: 'Article inspector', exact: true })
  const panel = () => pane().getByRole('region', { name: 'Properties', exact: true })
  const paging = label => panel().getByRole('navigation', { name: 'Property pages', exact: true })
    .getByRole('button', { name: label, exact: true })
  const launcher = page.getByRole('button', { name: 'Inspector', exact: true })

  async function visiblePage(ordinal) {
    await expect(panel().getByRole('status').filter({ hasText: new RegExp(`^Property page ${ordinal}$`) })).toBeVisible()
    const expected = fields.slice((ordinal - 1) * pageSize, ordinal * pageSize)
    await expect(panel().locator('dt')).toHaveText(expected.map(field => field.label))
    await expect(panel().getByRole('button', { name: /^Edit Scale field / })).toHaveCount(pageSize)
    return expected
  }

  async function checkedRead(ordinal, action, checkFocus = true) {
    const started = clock()
    const count = readResponses.length
    const waiting = page.waitForResponse(response => editorRead(response.request()))
    await action()
    const reply = await waiting
    assert.equal(reply.status(), 200)
    const packet = reply.request().postDataBuffer()
    assert(packet)
    const query = decodePropertyWorkspaceRequest(decodeFrame(packet, FrameType.PropertyWorkspaceRequest).payload)
    assert.deepEqual(query, { articleId: draft.id, articleRevision: draft.revision, schemaRevision: ordinal > 1 ? schema : 0n,
      valueRevision: 0n, afterKey: ordinal > 1 ? fields[(ordinal - 1) * pageSize - 1].machineKey : '' })
    const bytes = await reply.body()
    const stored = decodePropertyEditor(decodeFrame(bytes, FrameType.PropertyEditor).payload)
    assert.deepEqual([stored.articleId, stored.articleRevision, stored.schemaRevision, stored.valueRevision],
      [draft.id, draft.revision, schema, 0n])
    const expected = await visiblePage(ordinal)
    assert.equal(stored.nextKey, ordinal < pages ? expected.at(-1).machineKey : '')
    assert.deepEqual(stored.fields, expected.map(field => ({ ...field, definitionRevision: 1n, deprecated: false, value: { kind: 'missing' } })))
    if (checkFocus) await expect(panel().getByRole('heading', { name: 'Properties', exact: true })).toBeFocused()
    assert.equal(readResponses.length, count + 1)
    assert.equal(readRequests.length, count + 1)
    result.responses.push({ page: ordinal, viewportWidth: screen.width, count: stored.fields.length, bytes: bytes.length,
      elapsedMilliseconds: Math.round(clock() - started) })
    result.domSamples.push({ page: ordinal, viewportWidth: screen.width, ...(await memory.send('Memory.getDOMCounters')) })
  }

  async function collectedSample(phase) {
    await memory.send('HeapProfiler.collectGarbage')
    result.collectedSamples.push({ phase, viewportWidth: screen.width, ...(await memory.send('Memory.getDOMCounters')) })
  }

  await checkedRead(1, async () => {
    await page.goto(`${origin}/user/manage/article/edit/${draft.id}`)
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(draft.title)
    await launcher.press('Enter')
  }, false)
  await expect(paging('Previous properties')).toBeDisabled()
  await collectedSample('first desktop page')
  for (let ordinal = 2; ordinal <= pages; ordinal++) {
    await checkedRead(ordinal, () => paging('More properties').press('Enter'))
    if (ordinal === 20) {
      await collectedSample('twentieth desktop page')
      screen = compact
      await page.setViewportSize(screen)
      await expect(pane()).toBeVisible()
      await visiblePage(ordinal)
      assert.equal(readRequests.length, ordinal)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), screen.width)
      await collectedSample('same page in compact drawer')
    }
  }
  await expect(paging('More properties')).toBeDisabled()
  await collectedSample('last compact page')
  await checkedRead(pages - 1, () => paging('Previous properties').press('Enter'))
  await page.screenshot({ path: join(evidence, 'property-inspector-scale-mobile.png') })
  screen = desktop
  await page.setViewportSize(screen)
  await expect(pane()).toBeVisible()
  await visiblePage(pages - 1)
  await collectedSample('returned to desktop')
  assert.equal(readRequests.length, 41)
  assert.equal(readResponses.length, 41)
  assert.deepEqual(diagnostics, [])
  result.initialDomSample = result.domSamples[0]
  result.peakSampledNodes = Math.max(...result.domSamples.map(sample => sample.nodes))
  result.peakSampledListeners = Math.max(...result.domSamples.map(sample => sample.jsEventListeners))
  await memory.detach()
} catch (error) {
  result.failure = String(error)
  throw error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'property-inspector-scale-result.json'), JSON.stringify(result, null, 2) + '\n')
}
