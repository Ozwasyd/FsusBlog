import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as props from '../../src/Contracts/property-values.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { pressForResponse, selectOption } from './admin-workspace-fixture.mjs'
import { authorFixture, expect } from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { assertApiError, assertNoneIn, assertStatus, readFrame } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireLimits, WireRoutes } = wire
const { FSUSBLOG_TEST_URL: url, FSUSBLOG_TEST_AUTHOR_BOOTSTRAP: authorBootstrap, FSUSBLOG_TEST_OUTSIDER_BOOTSTRAP: outsiderBootstrap,
  FSUSBLOG_TEST_EVIDENCE: evidence } = process.env
assert(url && authorBootstrap && outsiderBootstrap && evidence)
const origin = new URL(url).origin
const browser = await isolated.launchChrome()
const result = { browser: browser.version(), observations: [], diagnostics: [] }
const fx = authorFixture(origin, result.diagnostics)
const savedBefore = 'Frozen private value 漢字 🧭', savedAfter = 'New privately saved value à 🔒'
const beforeLabel = 'First property name', afterLabel = 'Renamed property name'

await isolated.withBrowserEvidence(browser, evidence, 'property-history-result.json', result, async () => {
  const owner = await browser.newContext({ viewport: { width: 1280, height: 850 } })
  const outsider = await browser.newContext(), anonymous = await browser.newContext()
  const credential = await fx.signInWithPasskey(owner, authorBootstrap)
  const outsiderCredential = await fx.signInWithPasskey(outsider, outsiderBootstrap)
  const initial = await fx.createDraft(owner, 'Revision property witness', 'Original article source.', credential)
  const definitionId = randomUUID(), machineKey = 'revision-property'
  const changeDefinition = (operation, schemaRevision, definitionRevision, label, id = definitionId, key = machineKey) =>
    fx.savePropertySchema(owner, { operation, definitionId: id, schemaRevision, definitionRevision,
      machineKey: operation === 1 ? key : '', label, kind: 'text' }, credential)
  async function writeValue(draft, def, valueRevision, value) {
    const receipt = await fx.savePropertyValue(owner, { articleId: draft.id, articleRevision: draft.revision,
      schemaRevision: def.schemaRevision, valueRevision, definitionId: def.definitionId, definitionRevision: def.revision,
      value: { kind: 'text', value } }, credential)
    assert.deepEqual(receipt, { definitionId: def.definitionId, schemaRevision: def.schemaRevision, revision: valueRevision + 1n })
    return receipt.revision
  }

  const firstDefinition = await changeDefinition(1, 0n, 0n, beforeLabel)
  let schema = firstDefinition.schemaRevision
  const extra = []
  for (let i = 1; i <= WireLimits.PropertyPageSize; ++i) {
    const ordinal = String(i).padStart(2, '0')
    const id = randomUUID(), key = `zz-property-${ordinal}`, label = `Saved field ${ordinal}`, text = `Saved value ${ordinal}`
    const receipt = await changeDefinition(1, schema, 0n, label, id, key)
    schema = receipt.schemaRevision
    extra.push({ definitionId: id, definitionRevision: receipt.revision, machineKey: key, label, deprecated: false,
      kind: 'text', options: [], value: { kind: 'text', value: text } })
  }
  let firstValueRevision = await writeValue(initial, { ...firstDefinition, schemaRevision: schema }, 0n, savedBefore)
  for (const field of extra) {
    firstValueRevision = await writeValue(initial, { definitionId: field.definitionId, revision: field.definitionRevision,
      schemaRevision: schema }, firstValueRevision, field.value.value)
  }
  const rights = wire.decodeArticleRightsPolicy((await fx.post(owner, WireRoutes.DraftRightsCommand, FrameType.ArticleRightsCommand,
    wire.encodeArticleRightsCommand({ id: initial.id, expectedRevision: initial.revision, idempotencyKey: randomUUID(), enabled: true,
      licenseType: 'CC0-1.0', copyrightHolder: '', copyrightYear: 0, rightsStatement: '', attributionTemplate: '', copyPolicy: 'disabled',
      maxExcerptChars: 0, allowCodeCopy: false, showPublicBadge: false, proofBindingEnabled: false }),
    FrameType.ArticleRightsPolicy, credential)).payload)
  const earlierSummary = 'Earlier saved summary 漢字', currentSummary = 'Changed private summary 🧭'
  async function metadata(revision, text, categoryId, tagIds) {
    const saved = await fx.saveSummary(owner, { id: initial.id, revision }, text, credential)
    return (await fx.assignTaxonomy(owner, saved, categoryId, tagIds, credential)).revision
  }
  const earlier = await fx.publishDraft(owner, { id: initial.id, revision: await metadata(rights.revision, earlierSummary, 1, [4]) }, credential)
  const finalDefinition = await changeDefinition(2, schema, firstDefinition.revision, afterLabel)
  const finalValueRevision = await writeValue(earlier, finalDefinition, firstValueRevision, savedAfter)
  const changed = await metadata(earlier.revision, currentSummary, 2, [])
  const current = await fx.saveDraft(owner, { id: initial.id, revision: changed, title: initial.title }, 'New private article source.', credential)

  const comparisonPath = revision => WireRoutes.DraftRevisionComparison.replace('{id:int}', String(initial.id))
    .replace('{sourceRevision:long}', String(revision))
  const historyPath = (source, head = current.revision) => origin + comparisonPath(source) + `?revision=${head}&map=properties`
  const privateTexts = [beforeLabel, afterLabel, savedBefore, savedAfter]
  await assertApiError(await outsider.request.get(historyPath(earlier.revision), { headers: { [WireHeaders.CurrentSession]: outsiderCredential } }), 404, ...privateTexts)
  await assertApiError(await anonymous.request.get(historyPath(earlier.revision)), 401, ...privateTexts)
  await assertApiError(await owner.request.get(historyPath(earlier.revision, current.revision + 1n), { headers: { [WireHeaders.CurrentSession]: credential } }), 409, ...privateTexts)

  const page = fx.monitor(await owner.newPage())
  let requests = 0
  page.on('request', req => { if (req.method() === 'GET' && new URL(req.url()).searchParams.get('map') === 'properties') requests++ })
  await page.goto(fx.editPath(initial.id))
  await expect(loc.exactLabel(page, 'Body')).toHaveValue(current.body)
  await loc.exactButton(page, 'Inspector').click()
  const inspector = loc.roleWithExactName(page, 'complementary', 'Article inspector')
  await loc.exactText(inspector, 'Revision history').click()
  const compare = loc.exactButton(inspector, `Compare revision ${earlier.revision}`)
  await compare.click()
  const modal = loc.exactDialog(page, 'Revision comparison')
  const closeModal = async () => { await page.keyboard.press('Escape'); await expect(modal).toBeHidden() }
  const metadataUrl = historyPath(earlier.revision).replace('map=properties', 'map=metadata')
  const metadataLink = loc.exactText(modal, 'Saved summary and classification')
  const fields = await pressForResponse(page, metadataUrl, metadataLink)
  assert.equal(fields.headers()['cache-control'], 'no-store')
  assert.equal(fields.request().headers()[WireHeaders.CurrentSession.toLowerCase()], credential)
  await readFrame(fields, FrameType.RevisionMetadataComparison)
  await expect(loc.exactText(modal, 'Summary changed. Category changed. Tags changed.')).toBeVisible()
  await expect(modal.locator('dd')).toHaveText([earlierSummary, 'Web engineering', 'Café', currentSummary, 'Empty category', 'No tags'])
  await isolated.withViewport(page, 375, 850, async () => {
    await isolated.assertScrollWidth(page, 375)
    await isolated.saveShot(modal, evidence, 'revision-metadata-mobile.png')
    await metadataLink.press('Enter')
    await expect(modal.locator('dd')).toHaveCount(0)
  })
  const disclosure = loc.exactText(modal, 'Saved properties')
  await expect(disclosure).toBeVisible()
  assert.equal(requests, 0)
  const requestsForPair = [earlier.revision, current.revision].map(rev => page.waitForResponse(res => res.url() === historyPath(rev)))
  await disclosure.press('Enter')
  const snapshots = await Promise.all(requestsForPair)
  const expected = [[earlier, { ...firstDefinition, schemaRevision: schema }, firstValueRevision, beforeLabel, savedBefore],
    [current, finalDefinition, finalValueRevision, afterLabel, savedAfter]]
  for (const [index, response] of snapshots.entries()) {
    const [draft, definition, valueRevision, label, value] = expected[index]
    assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], credential)
    const snapshot = await readFrame(response, FrameType.PropertyEditor, props.decodePropertyEditor)
    const firstFields = extra.slice(0, WireLimits.PropertyPageSize - 1)
    assert.deepEqual(snapshot, { articleId: initial.id, articleRevision: draft.revision, schemaRevision: definition.schemaRevision,
      valueRevision, nextKey: firstFields.at(-1).machineKey, fields: [{ definitionId, definitionRevision: definition.revision,
        machineKey, label, deprecated: false, kind: 'text', options: [], value: { kind: 'text', value } }, ...firstFields] })
  }
  const earlierPanel = loc.exactRegion(modal, 'Earlier saved properties')
  const currentPanel = loc.exactRegion(modal, 'Current saved properties')
  for (const [panel, label, val] of [[earlierPanel, beforeLabel, savedBefore], [currentPanel, afterLabel, savedAfter]]) {
    await expect(loc.exactText(panel, label)).toBeVisible()
    await expect(loc.exactText(panel, val)).toBeVisible()
    assert.equal(await panel.getByRole('textbox').count(), 0)
  }
  await isolated.withViewport(page, 375, 850, async () => {
    await expect(earlierPanel).toBeVisible()
    await expect(currentPanel).toBeVisible()
    await isolated.assertScrollWidth(page, 375)
    assert.equal(requests, 2)
    const next = await pressForResponse(page, historyPath(earlier.revision) + `&offset=${WireLimits.PropertyPageSize}`,
      loc.exactButton(earlierPanel, 'Next'))
    assert.deepEqual(await readFrame(next, FrameType.PropertyEditor, props.decodePropertyEditor), { articleId: initial.id,
      articleRevision: earlier.revision, schemaRevision: schema, valueRevision: firstValueRevision, nextKey: '', fields: [extra.at(-1)] })
    await expect(earlierPanel.getByRole('heading')).toBeFocused()
    await expect(earlierPanel.locator('dt')).toHaveText([extra.at(-1).label])
    await expect(currentPanel.locator('dt')).toHaveCount(WireLimits.PropertyPageSize)
    await expect(loc.exactButton(earlierPanel, 'Next')).toBeDisabled()
    await loc.exactButton(earlierPanel, 'Previous').press('Enter')
    await expect(loc.exactText(earlierPanel, savedBefore)).toBeVisible()
    assert.equal(requests, 4)
    await isolated.saveShot(page, evidence, 'property-history-mobile.png', {})
    await closeModal()
  })

  const localTitle = 'Unsaved comparison title', localBody = 'Browser-only Markdown change 漢字 🧭\n'
  const draftUrl = fx.draftPath(initial.id), beforeMetadata = await fields.body()
  async function ownerFrame(targetUrl) {
    const response = await owner.request.get(targetUrl, { headers: { [WireHeaders.CurrentSession]: credential } })
    try { assertStatus(response, 200); return await response.body() } finally { await response.dispose() }
  }
  const beforeComparison = await ownerFrame(draftUrl)
  assert.deepEqual(await fx.getDraft(owner, initial.id), current)
  await expect(inspector).toBeVisible()
  const compareEditor = loc.exactCheckbox(modal, 'Compare with current editor')
  const currentEditor = loc.exactLabel(modal, 'Current editor Markdown')
  const currentSaved = loc.exactLabel(modal, 'Current saved revision Markdown')
  async function openEditorMetadata() {
    await compare.press('Enter')
    await compareEditor.press('Space')
    await loc.exactText(modal, 'Summary and classification').press('Enter')
  }

  const localSummary = 'Unsaved summary visible in this browser only'
  await loc.exactText(inspector, 'Article summary').press('Enter')
  const summaryInput = loc.exactLabel(inspector, 'Summary text')
  await expect(summaryInput).toHaveValue(currentSummary)
  await summaryInput.fill(localSummary)
  await openEditorMetadata()
  await expect(loc.exactText(modal, localSummary)).toBeVisible()
  await expect(loc.exactText(modal, earlierSummary)).toBeVisible()
  await expect(loc.exactText(modal, currentSummary)).toHaveCount(0)
  assert.deepEqual(await ownerFrame(metadataUrl), beforeMetadata)
  await closeModal()
  await loc.exactButton(inspector, 'Discard summary changes').press('Enter')
  await expect(summaryInput).toHaveValue(currentSummary)

  const classification = loc.exactHeading(inspector, 'Classification')
  await selectOption(page, inspector, 'Category', 'Web engineering')
  await classification.click()
  await loc.exactCombobox(inspector, 'Tags').and(page.locator(':not([readonly])')).click()
  await loc.exactOption(page, 'Café').click()
  await classification.click()
  await openEditorMetadata()
  await expect(loc.exactText(modal, 'Summary changed. Category unchanged. Tags unchanged.')).toBeVisible()
  await expect(modal.locator('dd')).toHaveText([earlierSummary, 'Web engineering', 'Café', currentSummary, 'Web engineering', 'Café'])
  assert.deepEqual(await ownerFrame(metadataUrl), beforeMetadata)
  await closeModal()
  const discardClassification = loc.exactButton(inspector, 'Discard classification changes')
  await discardClassification.press('Enter')
  await expect(discardClassification).toBeHidden()

  await loc.exactLabel(page, 'Title').fill(localTitle)
  await loc.exactLabel(page, 'Body').fill(localBody)
  await compare.press('Enter')
  await expect(currentSaved).toBeVisible()
  assert.equal(await currentSaved.textContent(), current.body)
  await compareEditor.press('Space')
  await expect(currentEditor).toBeVisible()
  assert.equal(await currentEditor.textContent(), localBody)
  await expect(loc.exactText(modal, localTitle)).toBeVisible()
  assert.equal(await loc.exactLabel(modal, 'Earlier revision Markdown').textContent(), earlier.body)
  await modal.getByLabel('Reason for restoring this draft').fill('A valid reason cannot discard pending edits.')
  await expect(loc.exactButton(modal, 'Restore as new draft')).toBeDisabled()
  await isolated.withViewport(page, 375, 850, async () => {
    await expect(currentEditor).toBeVisible()
    await isolated.saveShot(modal, evidence, 'revision-current-editor-mobile.png')
    await compareEditor.press('Space')
    await expect(currentSaved).toBeVisible()
    assert.equal(await currentSaved.textContent(), current.body)
    await closeModal()
  })
  await expect(loc.exactLabel(page, 'Title')).toHaveValue(localTitle)
  await expect(loc.exactLabel(page, 'Body')).toHaveValue(localBody)
  assert.deepEqual(await ownerFrame(draftUrl), beforeComparison)

  for (const path of [`/article/${initial.id}`, WireRoutes.PublicArticle.replace('{id}', String(initial.id))]) {
    const publicResponse = await anonymous.request.get(origin + path)
    assertStatus(publicResponse, 200, path)
    const bytes = await publicResponse.body()
    assert.equal(bytes.includes(Buffer.from(earlier.body)), true)
    assertNoneIn(bytes, ...privateTexts, currentSummary, localTitle, localBody, localSummary)
  }
  assert.deepEqual(result.diagnostics, [])
  result.observations.push('The saved-revision comparison shows exact summaries and taxonomy assignments, with disclosure scoped to the current author session.')
  result.observations.push('The author compared exact saved property values and their frozen labels after a rename. The compact Inspector shows both readonly snapshots and retrieves one numeric-offset page at a time. Anonymous, outsider and stale reads reveal nothing, and public HTML/AEDS omit private property labels and values.')
  result.observations.push('The comparison showed unsaved summary and classification without changing saved frames, then compared unsaved title and Markdown on desktop and at 375px. The form and stored draft stayed intact, and a valid restore reason did not override the dirty guard.')
}, { newline: true })
