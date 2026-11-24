import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import * as props from '../../src/Contracts/property-values.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { authorFixture, chromium, expect } from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { assertFields, assertStatus } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireLimits, WireRoutes } = wire
const { FSUSBLOG_TEST_URL: url, FSUSBLOG_TEST_AUTHOR_BOOTSTRAP: bootstrap, FSUSBLOG_TEST_EVIDENCE: evidence } = process.env
assert(url && bootstrap && evidence)
const origin = new URL(url).origin
const desktop = { width: 1280, height: 850 }, compact = { width: 375, height: 850 }
const clock = () => performance.now()
const editorPath = origin + WireRoutes.PropertyEditor
const kindOptions = [{ id: '10000000-0000-4000-8000-000000000001', label: 'Red' },
  { id: '10000000-0000-4000-8000-000000000002', label: 'Blue' }]
const definitionCount = 1_000, pageSize = WireLimits.PropertyPageSize, pages = definitionCount / pageSize
assert.equal(pageSize, 25)
assert.equal(pages, 40)
const fields = Array.from({ length: definitionCount }, (_, index) => {
  const ordinal = String(index + 1).padStart(4, '0')
  const kind = props.propertyKinds[index % props.propertyKinds.length]
  return { definitionId: randomUUID(), machineKey: `scope-${ordinal}`, label: `Scale field ${ordinal}`, kind,
    options: kind === 'single-select' || kind === 'multi-select' ? kindOptions : [] }
})
const browser = await isolated.launchChrome()
const result = { browser: browser.version(), expectedDefinitions: definitionCount, responses: [], domSamples: [], collectedSamples: [], diagnostics: [] }
const fx = authorFixture(origin, result.diagnostics)
let context

async function accessibility(draft, schema, session) {
  const field = fields[0]
  const setText = (value, valueRevision) => fx.savePropertyValue(context, { articleId: draft.id, articleRevision: draft.revision,
    schemaRevision: schema, valueRevision, definitionId: field.definitionId, definitionRevision: 1n,
    value: { kind: 'text', value } }, session)
  const initialValue = 'Saved accessibility witness'
  await setText(initialValue, 0n)
  const earlier = await fx.saveDraft(context, draft, 'Saved properties accessibility source.', session)
  // Property writes after this point must witness the new current article revision.
  draft = await fx.saveDraft(context, earlier, 'Current properties accessibility source.', session)
  const cookies = (await context.storageState()).cookies
  const matrix = result.accessibility = []
  for (const factor of [1, 1.5, 2]) {
    await isolated.withZoomedContext(chromium, 'fsus-property-native-zoom-', factor, cookies, async profile => {
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
        await page.goto(fx.editPath(draft.id))
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
        await loc.exactButton(page, 'Inspector').press('Enter')
        const properties = loc.exactRegion(inspector, 'Properties')
        const editButton = loc.exactButton(properties, `Edit ${field.label}`)
        await expect(loc.exactText(properties, initialValue)).toBeVisible()
        await axNode('region', 'Properties')
        await axNode('button', `Edit ${field.label}`)
        await loc.exactText(inspector, 'Revision history').press('Enter')
        const compare = loc.exactButton(inspector, `Compare revision ${earlier.revision}`)
        await compare.press('Enter')
        const dialog = loc.exactDialog(page, 'Revision comparison')
        await loc.exactText(dialog, 'Saved properties').press('Enter')
        await expect(loc.exactText(dialog, initialValue)).toHaveCount(2)
        for (const [role, name] of [['dialog', 'Revision comparison'], ['region', 'Earlier saved properties'], ['region', 'Current saved properties']])
          await axNode(role, name)
        await page.keyboard.press('Escape')
        await expect(compare).toBeFocused()
        for (const item of fields.slice(0, props.propertyKinds.length)) {
          const opener = loc.exactButton(properties, `Edit ${item.label}`)
          await opener.press('Enter')
          const [role, name] = item.kind === 'boolean' ? ['radio', 'True'] : item.kind === 'single-select' ? ['radio', 'Red']
            : item.kind === 'multi-select' ? ['checkbox', 'Red'] : ['textbox', `${item.label} value`]
          await expect(loc.roleWithExactName(properties, role, name)).toBeFocused({ timeout: 1_500 })
          assert.equal((await axNode(role, name)).properties?.find(p => p.name === 'focused')?.value.value, true)
          await loc.exactButton(properties, 'Cancel').press('Enter')
          await expect(opener).toBeFocused()
        }
        if (factor === 2 && theme === 'dark') {
          await loc.exactButton(properties, 'Edit multiple properties').press('Enter')
          await editButton.press('Enter')
          await loc.roleWithExactName(properties, 'textbox', `${field.label} value`).fill('Staged accessibility witness')
          await loc.exactButton(properties, 'Stage property').press('Enter')
          await setText('Concurrent accessibility witness', 1n)
          const conflict = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PropertyValueCommand)
          await loc.exactButton(properties, 'Save property changes').press('Enter')
          assertStatus(await conflict, 409)
          const message = 'The article properties changed. Reload before editing.'
          await expect(properties.getByRole('alert')).toHaveText(message)
          await axNode('StaticText', message)
          assert.equal(live(await axNode('alert')), 'assertive')
          await expect(properties.getByRole('list', { name: 'Staged property changes' })).toContainText('Staged accessibility witness')
          result.assertiveConflict = true
        }
        matrix.push({ factor, theme, ...bounds, keyboardAndAX: true, typedControls: props.propertyKinds.length })
        console.log(`Chrome accessibility verified at ${factor * 100}% in ${theme} theme.`)
      }
      await ax.detach()
    })
  }
}

await isolated.withBrowserEvidence(browser, evidence, 'property-inspector-scale-result.json', result, async () => {
  context = await browser.newContext({ viewport: desktop })
  const session = await fx.signInWithPasskey(context, bootstrap)
  const draft = await fx.createDraft(context, 'Property scale inspector draft', 'Inspector scale source.', session)
  const seedAt = clock()
  let schema = 0n
  for (const field of fields) {
    const receipt = await fx.savePropertySchema(context, { ...field, operation: 1, schemaRevision: schema, definitionRevision: 0n }, session)
    assert.deepEqual(receipt, { definitionId: field.definitionId, schemaRevision: ++schema, revision: 1n })
  }
  result.seedMilliseconds = Math.round(clock() - seedAt)
  result.createdDefinitions = Number(schema)

  const page = fx.monitor(await context.newPage())
  const editorRead = request => request.method() === 'POST' && request.url() === editorPath
  const readRequests = [], readResponses = []
  page.on('request', req => { if (editorRead(req)) readRequests.push(req) })
  page.on('response', res => { if (editorRead(res.request())) readResponses.push(res) })

  const memory = await context.newCDPSession(page)
  let screen = desktop
  const pane = () => loc.roleWithExactName(page, screen === compact ? 'dialog' : 'complementary', 'Article inspector')
  const panel = () => loc.exactRegion(pane(), 'Properties')
  const paging = label => loc.exactButton(loc.roleWithExactName(panel(), 'navigation', 'Property pages'), label)

  async function visiblePage(ordinal) {
    await expect(panel().getByRole('status').filter({ hasText: new RegExp(`^Property page ${ordinal}$`) })).toBeVisible()
    const expected = fields.slice((ordinal - 1) * pageSize, ordinal * pageSize)
    await expect(panel().locator('dt')).toHaveText(expected.map(field => field.label))
    await expect(panel().getByRole('button', { name: /^Edit Scale field / })).toHaveCount(pageSize)
    return expected
  }

  async function checkedRead(ordinal, action, checkFocus = true) {
    const started = clock(), count = readResponses.length
    const [reply] = await Promise.all([page.waitForResponse(res => editorRead(res.request())), action()])
    assertStatus(reply, 200)
    const packet = reply.request().postDataBuffer()
    assert(packet)
    assert.deepEqual(wire.decodePropertyWorkspaceRequest(decodeFrame(packet, FrameType.PropertyWorkspaceRequest).payload),
      { articleId: draft.id, articleRevision: draft.revision, schemaRevision: ordinal > 1 ? schema : 0n,
        valueRevision: 0n, afterKey: ordinal > 1 ? fields[(ordinal - 1) * pageSize - 1].machineKey : '' })
    const bytes = await reply.body()
    const stored = props.decodePropertyEditor(decodeFrame(bytes, FrameType.PropertyEditor).payload)
    assertFields(stored, { articleId: draft.id, articleRevision: draft.revision, schemaRevision: schema, valueRevision: 0n })
    const expected = await visiblePage(ordinal)
    assert.equal(stored.nextKey, ordinal < pages ? expected.at(-1).machineKey : '')
    assert.deepEqual(stored.fields, expected.map(field => ({ ...field, definitionRevision: 1n, deprecated: false, value: { kind: 'missing' } })))
    if (checkFocus) {
      const heading = loc.exactHeading(panel(), 'Properties')
      await expect.poll(() => heading.evaluate(element => element.contains(document.activeElement))).toBe(true)
    }
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
    await page.goto(fx.editPath(draft.id))
    await expect(loc.exactLabel(page, 'Title')).toHaveValue(draft.title)
    await loc.exactButton(page, 'Inspector').press('Enter')
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
  await isolated.saveShot(page, evidence, 'property-inspector-scale-mobile.png', {})
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
  if (process.env.FSUSBLOG_TEST_PROPERTY_ACCESSIBILITY === '1') await accessibility(draft, schema, session)
  assert.deepEqual(result.diagnostics, [])
}, { newline: true })
