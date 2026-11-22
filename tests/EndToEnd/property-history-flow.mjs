import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { encodeArticleSummaryCommand } from '../../src/Contracts/article-summary.ts'
import { decodePropertyEditor, encodePropertySchemaCommand, encodePropertyValueCommand } from '../../src/Contracts/property-values.ts'
import {
  decodeArticleRightsPolicy, decodeDraft, decodeDraftTaxonomy, decodePropertyCommandReceipt, encodeArticleCommand, encodeArticleRightsCommand, encodeTaxonomyAssignment,
  encodeSignIn, FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'
import { chromium, expect, observePageErrors, postReceipt } from './browser-authoring-fixture.mjs'
import { exactButton, roleWithExactName, exactLabel, exactText } from './role-locators.mjs'

const { FSUSBLOG_TEST_URL: url, FSUSBLOG_TEST_TICKET: ticket, FSUSBLOG_TEST_OUTSIDER_TICKET: outsiderTicket,
  FSUSBLOG_TEST_EVIDENCE: evidence, FSUSBLOG_TEST_CHROME: executablePath } = process.env
assert(url && ticket && outsiderTicket && evidence)
const origin = new URL(url).origin
const browser = await chromium.launch({ executablePath })
const result = { browser: browser.version(), observations: [], diagnostics: [] }
const savedBefore = 'Frozen private value 漢字 🧭'
const savedAfter = 'New privately saved value à 🔒'
const beforeLabel = 'First property name'
const afterLabel = 'Renamed property name'

const post = (context, path, type, input, expected, credential) =>
  postReceipt(context, origin, path, type, input, expected, credential)

async function login(context, ticket) {
  const { headers } = await post(context, WireRoutes.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }), FrameType.OperatorSession)
  const credential = headers[WireHeaders.CurrentSession.toLowerCase()]
  assert(credential)
  return credential
}

try {
  const owner = await browser.newContext({ viewport: { width: 1280, height: 850 } })
  const outsider = await browser.newContext()
  const anonymous = await browser.newContext()
  const credential = await login(owner, ticket)
  const outsiderCredential = await login(outsider, outsiderTicket)
  async function command(path, id, expectedRevision, title = '', body = '') {
    return decodeDraft((await post(owner, path, FrameType.ArticleCommand,
      encodeArticleCommand({ id, expectedRevision, idempotencyKey: randomUUID(), title, body }), FrameType.Draft, credential)).payload)
  }
  const initial = await command(WireRoutes.Save, 0, 0n, 'Revision property witness', 'Original article source.')
  const definitionId = randomUUID()
  const machineKey = 'revision-property'
  async function changeDefinition(operation, schemaRevision, definitionRevision, label, id = definitionId, key = machineKey) {
    return decodePropertyCommandReceipt((await post(owner, WireRoutes.PropertySchemaCommand, FrameType.PropertySchemaCommand,
      encodePropertySchemaCommand({ operation, definitionId: id, requestId: randomUUID(), schemaRevision, definitionRevision,
        machineKey: operation === 1 ? key : '', label, kind: 'text' }),
      FrameType.PropertyCommandReceipt, credential)).payload)
  }
  async function writeValue(draft, definition, valueRevision, value) {
    const receipt = decodePropertyCommandReceipt((await post(owner, WireRoutes.PropertyValueCommand, FrameType.PropertyValueCommand,
      encodePropertyValueCommand({ articleId: draft.id, articleRevision: draft.revision, schemaRevision: definition.schemaRevision,
        valueRevision, definitionId: definition.definitionId, definitionRevision: definition.revision,
        requestId: randomUUID(), value: { kind: 'text', value } }),
      FrameType.PropertyCommandReceipt, credential)).payload)
    assert.deepEqual(receipt, { definitionId: definition.definitionId, schemaRevision: definition.schemaRevision, revision: valueRevision + 1n })
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
  const rights = decodeArticleRightsPolicy((await post(owner, WireRoutes.DraftRightsCommand, FrameType.ArticleRightsCommand,
    encodeArticleRightsCommand({ id: initial.id, expectedRevision: initial.revision, idempotencyKey: randomUUID(), enabled: true,
      licenseType: 'CC0-1.0', copyrightHolder: '', copyrightYear: 0, rightsStatement: '', attributionTemplate: '', copyPolicy: 'disabled',
      maxExcerptChars: 0, allowCodeCopy: false, showPublicBadge: false, proofBindingEnabled: false }),
    FrameType.ArticleRightsPolicy, credential)).payload)
  const earlierSummary = 'Earlier saved summary 漢字'
  const currentSummary = 'Changed private summary 🧭'
  const beforePublish = await metadata(rights.revision, earlierSummary, 1, [4])
  const earlier = await command(WireRoutes.Publish, initial.id, beforePublish)
  const finalDefinition = await changeDefinition(2, schema, firstDefinition.revision, afterLabel)
  const finalValueRevision = await writeValue(earlier, finalDefinition, firstValueRevision, savedAfter)
  const changed = await metadata(earlier.revision, currentSummary, 2, [])
  const current = await command(WireRoutes.Save, initial.id, changed, initial.title, 'New private article source.')

  async function metadata(revision, text, categoryId, tagIds) {
    const idempotencyKey = randomUUID()
    const response = await owner.request.post(origin + WireRoutes.ArticleSummarySave, {
      data: Buffer.from(encodeArticleSummaryCommand({ id: initial.id, expectedRevision: revision, idempotencyKey, text })),
      headers: { 'Content-Type': 'application/octet-stream', [WireHeaders.CurrentSession]: credential,
        [WireHeaders.ClientMutationId]: idempotencyKey },
    })
    assert.equal(response.status(), 200)
    const saved = decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
    return decodeDraftTaxonomy((await post(owner, WireRoutes.TaxonomyAssignment, FrameType.TaxonomyAssignment,
      encodeTaxonomyAssignment({ id: initial.id, expectedRevision: saved.revision, idempotencyKey: randomUUID(), categoryId, tagIds }),
      FrameType.DraftTaxonomy, credential)).payload).revision
  }

  const comparisonPath = revision => WireRoutes.DraftRevisionComparison.replace('{id:int}', String(initial.id))
    .replace('{sourceRevision:long}', String(revision))
  function historyPath(source, head = current.revision) {
    return origin + comparisonPath(source) + `?revision=${head}&map=properties`
  }
  const outsiderResponse = await outsider.request.get(historyPath(earlier.revision), { headers: { [WireHeaders.CurrentSession]: outsiderCredential } })
  const anonymousResponse = await anonymous.request.get(historyPath(earlier.revision))
  assert.equal(outsiderResponse.status(), 404)
  assert.equal(anonymousResponse.status(), 401)
  const stale = await owner.request.get(historyPath(earlier.revision, current.revision + 1n), { headers: { [WireHeaders.CurrentSession]: credential } })
  assert.equal(stale.status(), 409)
  for (const denied of [outsiderResponse, anonymousResponse, stale]) {
    const bytes = await denied.body()
    assert.equal(decodeFrame(bytes).type, FrameType.ApiError)
    for (const text of [beforeLabel, afterLabel, savedBefore, savedAfter]) assert.equal(bytes.includes(Buffer.from(text)), false)
  }

  const page = await owner.newPage()
  observePageErrors(page, result.diagnostics)
  const historyRead = request => request.method() === 'GET' && new URL(request.url()).searchParams.get('map') === 'properties'
  let requests = 0
  page.on('request', request => { if (historyRead(request)) requests++ })
  await page.goto(`${origin}/user/manage/article/edit/${initial.id}`)
  await expect(exactLabel(page, 'Body')).toHaveValue(current.body)
  await exactButton(page, 'Inspector').click()
  const inspector = roleWithExactName(page, 'complementary', 'Article inspector')
  await exactText(inspector, 'Revision history').click()
  const compare = exactButton(inspector, `Compare revision ${earlier.revision}`)
  await compare.click()
  const modal = roleWithExactName(page, 'dialog', 'Revision comparison')
  const metadataLink = exactText(modal, 'Saved summary and classification')
  const [fields] = await Promise.all([
    page.waitForResponse(response => response.url() === historyPath(earlier.revision).replace('map=properties', 'map=metadata')),
    metadataLink.press('Enter'),
  ])
  assert.equal(fields.status(), 200)
  assert.equal(fields.headers()['cache-control'], 'no-store')
  assert.equal(fields.request().headers()[WireHeaders.CurrentSession.toLowerCase()], credential)
  assert.equal(decodeFrame(await fields.body()).type, FrameType.RevisionMetadataComparison)
  await expect(exactText(modal, 'Summary changed. Category changed. Tags changed.')).toBeVisible()
  await expect(modal.locator('dd')).toHaveText([earlierSummary, 'Web engineering', 'Café', currentSummary, 'Empty category', 'No tags'])
  await page.setViewportSize({ width: 375, height: 850 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
  await modal.screenshot({ path: join(evidence, 'revision-metadata-mobile.png'), animations: 'disabled' })
  await metadataLink.press('Enter')
  await expect(modal.locator('dd')).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 850 })
  const disclosure = exactText(modal, 'Saved properties')
  await expect(disclosure).toBeVisible()
  assert.equal(requests, 0)
  const requestsForPair = [earlier.revision, current.revision].map(revision =>
    page.waitForResponse(response => response.url() === historyPath(revision)))
  await disclosure.press('Enter')
  const snapshots = await Promise.all(requestsForPair)
  const expected = [[earlier, { ...firstDefinition, schemaRevision: schema }, firstValueRevision, beforeLabel, savedBefore],
    [current, finalDefinition, finalValueRevision, afterLabel, savedAfter]]
  for (const [index, response] of snapshots.entries()) {
    const [draft, definition, valueRevision, label, value] = expected[index]
    assert.equal(response.status(), 200)
    assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], credential)
    const snapshot = decodePropertyEditor(decodeFrame(await response.body(), FrameType.PropertyEditor).payload)
    const firstFields = extra.slice(0, WireLimits.PropertyPageSize - 1)
    assert.deepEqual(snapshot, { articleId: initial.id, articleRevision: draft.revision, schemaRevision: definition.schemaRevision,
      valueRevision, nextKey: firstFields.at(-1).machineKey, fields: [{ definitionId, definitionRevision: definition.revision,
        machineKey, label, deprecated: false, kind: 'text', options: [], value: { kind: 'text', value } }, ...firstFields] })
  }
  const earlierPanel = roleWithExactName(modal, 'region', 'Earlier saved properties')
  const currentPanel = roleWithExactName(modal, 'region', 'Current saved properties')
  await expect(exactText(earlierPanel, beforeLabel)).toBeVisible()
  await expect(exactText(earlierPanel, savedBefore)).toBeVisible()
  await expect(exactText(currentPanel, afterLabel)).toBeVisible()
  await expect(exactText(currentPanel, savedAfter)).toBeVisible()
  assert.equal(await earlierPanel.getByRole('textbox').count(), 0)
  assert.equal(await currentPanel.getByRole('textbox').count(), 0)
  await page.setViewportSize({ width: 375, height: 850 })
  await expect(earlierPanel).toBeVisible()
  await expect(currentPanel).toBeVisible()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
  assert.equal(requests, 2)
  const next = page.waitForResponse(response => response.url() === historyPath(earlier.revision) + `&offset=${WireLimits.PropertyPageSize}`)
  await exactButton(earlierPanel, 'Next').press('Enter')
  const nextResponse = await next
  assert.equal(nextResponse.status(), 200)
  const second = decodePropertyEditor(decodeFrame(await nextResponse.body(), FrameType.PropertyEditor).payload)
  assert.deepEqual(second, { articleId: initial.id, articleRevision: earlier.revision, schemaRevision: schema,
    valueRevision: firstValueRevision, nextKey: '', fields: [extra.at(-1)] })
  await expect(earlierPanel.getByRole('heading')).toBeFocused()
  await expect(earlierPanel.locator('dt')).toHaveText([extra.at(-1).label])
  await expect(currentPanel.locator('dt')).toHaveCount(WireLimits.PropertyPageSize)
  await expect(exactButton(earlierPanel, 'Next')).toBeDisabled()
  await exactButton(earlierPanel, 'Previous').press('Enter')
  await expect(exactText(earlierPanel, savedBefore)).toBeVisible()
  assert.equal(requests, 4)
  await page.screenshot({ path: join(evidence, 'property-history-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  const localTitle = 'Unsaved comparison title'
  const localBody = 'Browser-only Markdown change 漢字 🧭\n'
  const draftUrl = origin + WireRoutes.Draft.replace('{id:int}', String(initial.id))
  const metadataUrl = historyPath(earlier.revision).replace('map=properties', 'map=metadata')
  const beforeMetadata = await fields.body()
  async function ownerFrame(url) {
    const response = await owner.request.get(url, { headers: { [WireHeaders.CurrentSession]: credential } })
    try {
      assert.equal(response.status(), 200)
      return await response.body()
    } finally { await response.dispose() }
  }
  const beforeComparison = await ownerFrame(draftUrl)
  assert.deepEqual(decodeDraft(decodeFrame(beforeComparison, FrameType.Draft).payload), current)
  await page.setViewportSize({ width: 1280, height: 850 })
  await expect(inspector).toBeVisible()
  const compareEditor = roleWithExactName(modal, 'checkbox', 'Compare with current editor')
  const currentEditor = exactLabel(modal, 'Current editor Markdown')
  const currentSaved = exactLabel(modal, 'Current saved revision Markdown')
  async function openEditorMetadata() {
    await compare.press('Enter')
    await compareEditor.press('Space')
    await exactText(modal, 'Summary and classification').press('Enter')
  }

  const localSummary = 'Unsaved summary visible in this browser only'
  await exactText(inspector, 'Article summary').press('Enter')
  const summaryInput = exactLabel(inspector, 'Summary text')
  await expect(summaryInput).toHaveValue(currentSummary)
  await summaryInput.fill(localSummary)
  await openEditorMetadata()
  await expect(exactText(modal, localSummary)).toBeVisible()
  await expect(exactText(modal, earlierSummary)).toBeVisible()
  await expect(exactText(modal, currentSummary)).toHaveCount(0)
  assert.deepEqual(await ownerFrame(metadataUrl), beforeMetadata)
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await exactButton(inspector, 'Discard summary changes').press('Enter')
  await expect(summaryInput).toHaveValue(currentSummary)

  const classification = roleWithExactName(inspector, 'heading', 'Classification')
  await roleWithExactName(inspector, 'combobox', 'Category').click()
  await roleWithExactName(page, 'option', 'Web engineering').click()
  await classification.click()
  await roleWithExactName(inspector, 'combobox', 'Tags').and(page.locator(':not([readonly])')).click()
  await roleWithExactName(page, 'option', 'Café').click()
  await classification.click()
  await openEditorMetadata()
  await expect(exactText(modal, 'Summary changed. Category unchanged. Tags unchanged.')).toBeVisible()
  await expect(modal.locator('dd')).toHaveText([earlierSummary, 'Web engineering', 'Café', currentSummary, 'Web engineering', 'Café'])
  assert.deepEqual(await ownerFrame(metadataUrl), beforeMetadata)
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  const discardClassification = exactButton(inspector, 'Discard classification changes')
  await discardClassification.press('Enter')
  await expect(discardClassification).toBeHidden()

  await exactLabel(page, 'Title').fill(localTitle)
  await exactLabel(page, 'Body').fill(localBody)
  await compare.press('Enter')
  await expect(currentSaved).toBeVisible()
  assert.equal(await currentSaved.textContent(), current.body)
  await compareEditor.press('Space')
  await expect(currentEditor).toBeVisible()
  assert.equal(await currentEditor.textContent(), localBody)
  await expect(exactText(modal, localTitle)).toBeVisible()
  assert.equal(await exactLabel(modal, 'Earlier revision Markdown').textContent(), earlier.body)
  await modal.getByLabel('Reason for restoring this draft').fill('A valid reason cannot discard pending edits.')
  await expect(exactButton(modal, 'Restore as new draft')).toBeDisabled()
  await page.setViewportSize({ width: 375, height: 850 })
  await expect(currentEditor).toBeVisible()
  await modal.screenshot({ path: join(evidence, 'revision-current-editor-mobile.png'), animations: 'disabled' })
  await compareEditor.press('Space')
  await expect(currentSaved).toBeVisible()
  assert.equal(await currentSaved.textContent(), current.body)
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await page.setViewportSize({ width: 1280, height: 850 })
  await expect(exactLabel(page, 'Title')).toHaveValue(localTitle)
  await expect(exactLabel(page, 'Body')).toHaveValue(localBody)
  assert.deepEqual(await ownerFrame(draftUrl), beforeComparison)

  for (const path of [`/article/${initial.id}`, WireRoutes.PublicArticle.replace('{id}', String(initial.id))]) {
    const publicResponse = await anonymous.request.get(origin + path)
    assert.equal(publicResponse.status(), 200, path)
    const bytes = await publicResponse.body()
    assert.equal(bytes.includes(Buffer.from(earlier.body)), true)
    for (const text of [beforeLabel, afterLabel, savedBefore, savedAfter, currentSummary, localTitle, localBody, localSummary])
      assert.equal(bytes.includes(Buffer.from(text)), false)
  }
  assert.deepEqual(result.diagnostics, [])
  result.observations.push('The saved-revision comparison shows exact summaries and taxonomy assignments, with disclosure scoped to the current author session.')
  result.observations.push('The author compared exact saved property values and their frozen labels after a rename. The compact Inspector shows both readonly snapshots and retrieves one numeric-offset page at a time. Anonymous, outsider and stale reads reveal nothing, and public HTML/AEDS omit private property labels and values.')
  result.observations.push('The comparison showed unsaved summary and classification without changing saved frames, then compared unsaved title and Markdown on desktop and at 375px. The form and stored draft stayed intact, and a valid restore reason did not override the dirty guard.')
} catch (error) {
  result.failure = String(error)
  throw error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'property-history-result.json'), JSON.stringify(result, null, 2) + '\n')
}
