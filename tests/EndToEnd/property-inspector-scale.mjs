import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodePropertyEditor, encodePropertySchemaCommand, encodePropertyValueCommand, propertyKinds } from '../../src/Contracts/property-values.ts'
import {
  decodeDraft, decodePropertyCommandReceipt, decodePropertyWorkspaceRequest, encodeArticleCommand, encodeSignIn,
  FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'
import { chromium, expect, observePageErrors, postReceipt } from './browser-authoring-fixture.mjs'
import { exactButton, roleWithExactName } from './role-locators.mjs'

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

async function accessibility(draft, schema, post) {
  const field = fields[0]
  const edit = valueRevision => ({
    articleId: draft.id, articleRevision: draft.revision, schemaRevision: schema, valueRevision,
    definitionId: field.definitionId, definitionRevision: 1n, requestId: randomUUID(),
  })
  async function setText(value, valueRevision) {
    await post(WireRoutes.PropertyValueCommand, FrameType.PropertyValueCommand,
      encodePropertyValueCommand({ ...edit(valueRevision), value: { kind: 'text', value } }), FrameType.PropertyCommandReceipt)
  }
  async function saveSource(expectedRevision, body) {
    const payload = encodeArticleCommand({ id: draft.id, expectedRevision, title: draft.title, body, idempotencyKey: randomUUID() })
    return decodeDraft((await post(WireRoutes.Save, FrameType.ArticleCommand, payload, FrameType.Draft)).payload)
  }
  const initialValue = 'Saved accessibility witness'
  await setText(initialValue, 0n)
  const earlier = await saveSource(draft.revision, 'Saved properties accessibility source.')
  // Property writes after this point must witness the new current article revision.
  draft = await saveSource(earlier.revision, 'Current properties accessibility source.')
  const cookies = (await context.storageState()).cookies
  const matrix = result.accessibility = []
  for (const factor of [1, 1.5, 2]) {
    const directory = await mkdtemp(join(tmpdir(), 'fsus-property-native-zoom-'))
    let profile
    try {
      await mkdir(join(directory, 'Default'))
      await writeFile(join(directory, 'Default', 'Preferences'), JSON.stringify({
        partition: { default_zoom_level: { x: Math.log(factor) / Math.log(1.2) } },
      }))
      profile = await chromium.launchPersistentContext(directory, {
        executablePath, viewport: null, args: ['--window-size=1440,900'],
      })
      await profile.addCookies(cookies)
      const page = profile.pages()[0]
      page.on('pageerror', error => result.diagnostics.push(error.message))
      const ax = await profile.newCDPSession(page)
      await ax.send('Accessibility.enable')
      const live = node => node.properties?.find(property => property.name === 'live')?.value.value
      async function axNode(role, name) {
        const { nodes } = await ax.send('Accessibility.getFullAXTree')
        const node = nodes.find(node => !node.ignored && node.role?.value === role && (name === undefined || node.name?.value === name))
        assert(node, `Missing Chromium AX node: ${role} ${name ?? ''}`)
        return node
      }
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.goto(`${origin}/user/manage/article/edit/${draft.id}`)
        await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', theme)
        const bounds = await page.evaluate(() => ({
          outer: outerWidth, viewport: innerWidth, dpr: devicePixelRatio, scroll: document.documentElement.scrollWidth,
          scale: visualViewport.scale, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        }))
        const first = matrix[0] ?? bounds
        assert.equal(bounds.outer, first.outer)
        assert.equal(bounds.scale, 1)
        assert(bounds.reducedMotion && Math.abs(bounds.dpr / first.dpr - factor) < .01 &&
          Math.abs(bounds.viewport * factor - first.viewport) <= 2 && bounds.scroll === bounds.viewport)
        const inspector = page.getByRole(bounds.viewport <= 1023 ? 'dialog' : 'complementary', { name: 'Article inspector' })
        await exactButton(page, 'Inspector').press('Enter')
        const properties = roleWithExactName(inspector, 'region', 'Properties')
        const editButton = exactButton(properties, `Edit ${field.label}`)
        await expect(properties.getByText(initialValue, { exact: true })).toBeVisible()
        await axNode('region', 'Properties')
        await axNode('button', `Edit ${field.label}`)
        await inspector.getByText('Revision history', { exact: true }).press('Enter')
        const compare = exactButton(inspector, `Compare revision ${earlier.revision}`)
        await compare.press('Enter')
        const dialog = page.getByRole('dialog', { name: 'Revision comparison' })
        await dialog.getByText('Saved properties', { exact: true }).press('Enter')
        await expect(dialog.getByText(initialValue, { exact: true })).toHaveCount(2)
        await axNode('dialog', 'Revision comparison')
        await axNode('region', 'Earlier saved properties')
        await axNode('region', 'Current saved properties')
        await page.keyboard.press('Escape')
        await expect(compare).toBeFocused()
        for (const item of fields.slice(0, propertyKinds.length)) {
          const opener = exactButton(properties, `Edit ${item.label}`)
          await opener.press('Enter')
          const [role, name] = item.kind === 'boolean' ? ['radio', 'True'] : item.kind === 'single-select' ? ['radio', 'Red']
            : item.kind === 'multi-select' ? ['checkbox', 'Red'] : ['textbox', `${item.label} value`]
          await expect(properties.getByRole(role, { name, exact: true })).toBeFocused({ timeout: 1_500 })
          assert.equal((await axNode(role, name)).properties?.find(p => p.name === 'focused')?.value.value, true)
          await exactButton(properties, 'Cancel').press('Enter')
          await expect(opener).toBeFocused()
        }
        if (factor === 2 && theme === 'dark') {
          await exactButton(properties, 'Edit multiple properties').press('Enter')
          await editButton.press('Enter')
          await roleWithExactName(properties, 'textbox', `${field.label} value`).fill('Staged accessibility witness')
          await exactButton(properties, 'Stage property').press('Enter')
          await setText('Concurrent accessibility witness', 1n)
          const conflict = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PropertyValueCommand)
          await exactButton(properties, 'Save property changes').press('Enter')
          assert.equal((await conflict).status(), 409)
          const message = 'The article properties changed. Reload before editing.'
          await expect(properties.getByRole('alert')).toHaveText(message)
          await axNode('StaticText', message)
          assert.equal(live(await axNode('alert')), 'assertive')
          await expect(properties.getByRole('list', { name: 'Staged property changes' })).toContainText('Staged accessibility witness')
          result.assertiveConflict = true
        }
        matrix.push({ factor, theme, ...bounds, keyboardAndAX: true, typedControls: propertyKinds.length })
        console.log(`Chrome accessibility verified at ${factor * 100}% in ${theme} theme.`)
      }
      await ax.detach()
    } finally {
      try { await profile?.close() }
      finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
}

try {
  context = await browser.newContext({ viewport: desktop })
  let session
  const post = (path, type, input, expected) => postReceipt(context, origin, path, type, input, expected, session)

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
  observePageErrors(page, diagnostics)
  const editorRead = request => request.method() === 'POST' && request.url() === editorPath
  const readRequests = []
  const readResponses = []
  page.on('request', request => { if (editorRead(request)) readRequests.push(request) })
  page.on('response', response => { if (editorRead(response.request())) readResponses.push(response) })

  const memory = await context.newCDPSession(page)
  let screen = desktop
  const pane = () => page.getByRole(screen === compact ? 'dialog' : 'complementary', { name: 'Article inspector', exact: true })
  const panel = () => roleWithExactName(pane(), 'region', 'Properties')
  const paging = label => exactButton(roleWithExactName(panel(), 'navigation', 'Property pages'), label)
  const launcher = exactButton(page, 'Inspector')

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
    if (checkFocus) await expect(roleWithExactName(panel(), 'heading', 'Properties')).toBeFocused()
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
  result.initialDomSample = result.domSamples[0]
  result.peakSampledNodes = Math.max(...result.domSamples.map(sample => sample.nodes))
  result.peakSampledListeners = Math.max(...result.domSamples.map(sample => sample.jsEventListeners))
  await memory.detach()
  if (process.env.FSUSBLOG_TEST_PROPERTY_ACCESSIBILITY === '1') await accessibility(draft, schema, post)
  assert.deepEqual(diagnostics, [])
} catch (error) {
  result.failure = String(error)
  throw error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'property-inspector-scale-result.json'), JSON.stringify(result, null, 2) + '\n')
}
