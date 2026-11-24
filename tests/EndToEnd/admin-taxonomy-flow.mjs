import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAdminTaxonomyPage } from '../../src/Contracts/admin-taxonomy.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { decodePowChallenge } from '../../src/Contracts/pow.ts'
import { decodeTaxonomyMetadata } from '../../src/Contracts/taxonomy.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import * as adminFx from './admin-workspace-fixture.mjs'
import { authorFixture } from './browser-authoring-fixture.mjs'
import { assertNoOverflow, saveShot } from './isolated-browser-fixture.mjs'
import { assertFields, assertNoStore, assertStatus, readFrame } from './response-status-fixture.mjs'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireLimits, WireRoutes: R } = wire
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()

export async function verifyTaxonomy({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie,
  revoke, seed, logIn, probe, snapshot, readCookie, evidence }) {
  await adminFx.visitAdminWorkspace(page, '/admin/articles')
  const categoryEndpoint = adminOrigin.origin + R.AdminCategories
  const tagEndpoint = adminOrigin.origin + R.AdminTags
  const panel = loc.exactRegion(page.getByRole('tabpanel'), 'Taxonomy usage')
  const scrollRegion = loc.exactRegion(panel, 'Taxonomy usage table')
  const categories = loc.exactTab(page, 'Categories')
  const tags = loc.exactTab(page, 'Tags')
  const revoked = page.getByRole('alert').filter({ hasText: 'Your administrator session expired or was revoked. Log in again.' })
  const active = await snapshot(context)

  assertStatus(await context.request.get(siteOrigin.origin + R.AdminCategories), 404)
  for (const path of ['/user/manage/category', '/user/manage/tag']) assertStatus(await context.request.get(adminOrigin.origin + path), 404)
  await probe(categoryEndpoint, siteCookie.name, siteCookie.value, 401)
  await probe(categoryEndpoint, adminCookieName, siteCookie.value, 401)
  const categoryDependency = categoryEndpoint + '?dependency=1'
  await probe(categoryDependency, adminCookieName, siteCookie.value, 401)
  await probe(tagEndpoint + '?dependency=2', siteCookie.name, siteCookie.value, 401)

  await expectPage(await read(tags, tagEndpoint), [])
  await loc.exactText(panel, 'No tags found').waitFor()
  await adminFx.runFixtureCommand(seed)
  await seedArticles(context, adminOrigin.origin)
  await expectPage(await read(categories, categoryEndpoint), [{
    id: 1, name: 'Taxonomy QA category', published: 0, drafts: 1, scheduled: 1, retracted: 0, deleted: 1, retainedArticles: 3,
  }])
  await assertRow('Taxonomy QA category', ['0', '1', '1', '0', '1', '3'])
  if (process.env.FSUSBLOG_TEST_ADMIN_CATEGORY_METADATA !== '1') {
    assertStatus(await context.request.get(adminOrigin.origin + R.AdminCategoryMetadataAvailability), 404)
    assert.equal(await loc.exactButton(panel, 'Create category').count(), 0)
  }
  const referencedTag = { id: 2, name: 'Taxonomy QA tag', published: 0, drafts: 0, scheduled: 1, retracted: 0, deleted: 0, retainedArticles: 2 }
  const spareTag = id => ({ id, name: `Taxonomy QA filler ${id}`, published: 0, drafts: 0, scheduled: 0, retracted: 0, deleted: 0, retainedArticles: 0 })
  await expectPage(await read(tags, tagEndpoint), [referencedTag, ...Array.from({ length: 23 }, (_, index) => spareTag(index + 3))], 25)
  await assertRow('Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  await expectPage(await read(loc.exactButton(panel, 'Next page'), `${tagEndpoint}?after=25`), [spareTag(26)])
  await loc.exactText(panel, 'Page 2').waitFor()
  await assertRow('Taxonomy QA filler 26', ['0', '0', '0', '0', '0', '0'])
  await read(loc.exactButton(panel, 'Previous page'), tagEndpoint)
  await assertRow('Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  assert(await scrollRegion.evaluate(element => element.scrollWidth <= element.clientWidth), 'Desktop must show all taxonomy columns without scrolling.')
  await loc.exactHeading(panel, 'Taxonomy usage').evaluate(heading => heading.scrollIntoView({ block: 'start' }))
  await saveShot(page, evidence, 'administrator-taxonomy.png')
  const initialViewport = page.viewportSize()
  await page.setViewportSize({ width: 375, height: 812 })
  await assertRow('Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  await assertNoOverflow(page)
  assert(await scrollRegion.evaluate(element => element.scrollWidth > element.clientWidth), 'Narrow taxonomy tables must expose horizontal scrolling.')
  await loc.exactHeading(panel, 'Taxonomy usage').evaluate(heading => heading.scrollIntoView({ block: 'start' }))
  await saveShot(page, evidence, 'administrator-taxonomy-mobile.png')
  const tagsWritable = process.env.FSUSBLOG_TEST_ADMIN_TAG_METADATA === '1'
  await inspectReferences(tagEndpoint, 2, [1, 1, 0])
  await checkLinkedItem('tag', 'Taxonomy QA tag', 2, tagsWritable)
  await inspectReferences(tagEndpoint, 3, [0, 0, 0])
  await read(categories, categoryEndpoint)
  const categoriesWritable = process.env.FSUSBLOG_TEST_ADMIN_CATEGORY_METADATA === '1'
  await inspectReferences(categoryEndpoint, 1, [2, 1, 0])
  await checkLinkedItem('category', 'Taxonomy QA category', 3, categoriesWritable)
  await saveShot(page, evidence, 'administrator-taxonomy-references-mobile.png')
  await probe(siteOrigin.origin + R.AdminCategories + '?dependency=1', adminCookieName, priorCookie.value, 404)
  await read(tags, tagEndpoint)
  if (tagsWritable) await editUnusedTag()
  if (categoriesWritable) await createAndRenameCategory()

  await adminFx.runFixtureCommand(revoke)
  await probe(tagEndpoint, adminCookieName, priorCookie.value, 401)
  await probe(categoryDependency, adminCookieName, priorCookie.value, 401)
  assertStatus(await read(tags, tagEndpoint), 401)
  await revoked.waitFor()
  await panel.waitFor({ state: 'hidden' })
  if (initialViewport) await page.setViewportSize(initialViewport)
  await logIn(page)
  assert((await snapshot(context)).principal.generation > active.principal.generation)
  assertStatus(await context.request.get(tagEndpoint), 200)
  return readCookie(context, adminOrigin.origin + R.AdminSession, adminCookieName)

  async function read(button, endpoint) {
    const selectedTab = await button.getAttribute('role') === 'tab' && await button.getAttribute('aria-selected') === 'true'
    return adminFx.clickForResponse(page, endpoint, selectedTab ? loc.exactButton(panel, 'Refresh list') : button)
  }

  const taxonomyRow = name => scrollRegion.getByRole('row').filter({ has: loc.roleWithExactName(page, 'rowheader', name) })

  async function assertRow(name, [published, drafts, scheduled, retracted, deleted, retained]) {
    const row = taxonomyRow(name)
    await row.waitFor()
    const summary = [drafts, scheduled, retracted, deleted].every(value => value === '0') && retained === published
      ? 'No other references'
      : `Draft ${drafts} · Scheduled ${scheduled} · Retracted ${retracted} · Deleted ${deleted} · Retained ${retained}`
    const cells = row.getByRole('cell')
    assert.deepEqual([(await cells.nth(0).innerText()).trim(), (await cells.nth(1).innerText()).trim()], [published, summary])
  }

  async function inspectReferences(endpoint, id, counts) {
    const received = await context.request.get(`${endpoint}?dependency=${id}`)
    await assertNoStore(received)
    const packet = await readFrame(received, FrameType.AdminTaxonomyDependencies)
    assert.equal(packet.length, 16)
    const input = new PodReader(packet)
    assert.deepEqual([input.i32(), input.i32(), input.i32(), input.i32()], [id, ...counts])
    input.finish()
  }

  async function checkLinkedItem(kind, name, count, writable) {
    const row = taxonomyRow(name)
    await loc.exactButton(row, 'View articles').waitFor()
    const remove = loc.exactButton(row, 'Delete')
    if (!writable) {
      assert.deepEqual([await loc.exactButton(panel, `Create ${kind}`).count(), await loc.exactButton(row, 'Edit').count(), await remove.count()], [0, 0, 0])
      return
    }
    const dialog = loc.exactDialog(page, `Delete ${kind}`)
    await remove.click()
    await loc.exactText(dialog, `${kind} “${name}” is still referenced by ${count} article(s) (including saved revisions) and cannot be deleted.`).waitFor()
    assert.equal(await loc.exactButton(dialog, 'Delete').count(), 0)
    await loc.exactButton(dialog, 'View linked articles').waitFor()
    await loc.exactButton(dialog, 'Cancel').click()
    await dialog.waitFor({ state: 'hidden' })
    await remove.and(page.locator(':focus')).waitFor()
  }

  async function writeMetadata(form, method, path, powPath, buttonName, commandType, receiptType) {
    const [challenge, accepted] = await Promise.all([
      waitForUrlResponse(page, () => adminOrigin.origin + powPath, 'POST'),
      waitForUrlResponse(page, () => adminOrigin.origin + path, method),
      loc.exactButton(form, buttonName).click(),
    ])
    assert.equal((await readFrame(challenge, FrameType.PowChallenge, decodePowChallenge)).difficulty, WireLimits.PowChallengeDifficulty)
    const command = accepted.request().postDataBuffer()
    assert(command)
    const formBytes = decodeFrame(command, commandType).payload
    if (method === 'POST') {
      const coordinates = new PodReader(formBytes)
      assert.deepEqual([coordinates.i32(), coordinates.i64()], [0, 0n])
    }
    assert.deepEqual(challenge.request().postDataBuffer(), command)
    assert.match(challenge.request().headers()[WireHeaders.PowClientNonce.toLowerCase()], /^[a-f0-9]{32}$/)
    assert(accepted.request().headers()[WireHeaders.PowProof.toLowerCase()])
    await assertNoStore(accepted)
    return decodeMetadata(accepted, receiptType)
  }

  async function decodeMetadata(response, receiptType) {
    const input = new PodReader(await readFrame(response, receiptType))
    const result = { id: input.i32(), revision: input.i64(), name: input.text(WireLimits.TaxonomyNameBytes),
      description: input.text(WireLimits.TaxonomyDescriptionBytes), changed: input.bool() }
    input.finish()
    return result
  }

  async function verifyPublicTaxonomy(kind, routeTemplate, id, name, description, matchGeneration = true) {
    const raw = await context.request.get(siteOrigin.origin + routeTemplate.replace('{id:int}', String(id)))
    assert.deepEqual(await readFrame(raw, FrameType.TaxonomyExactMetadata, decodeTaxonomyMetadata), { id, name, description })
    const html = await context.request.get(`${siteOrigin.origin}/${kind}/${id}`)
    assertStatus(html, 200)
    assert((await html.text()).includes(description))
    if (matchGeneration) assert.equal(html.headers()[generationHeader], raw.headers()[generationHeader])
    return raw.headers()[generationHeader]
  }

  async function createAndRenameCategory() {
    await read(categories, categoryEndpoint)
    assertStatus(await context.request.get(adminOrigin.origin + R.AdminCategoryMetadataAvailability), 204)
    await probe(siteOrigin.origin + R.AdminCategoryMetadataAvailability, adminCookieName, priorCookie.value, 404)
    const original = 'Taxonomy QA category', renamed = 'Taxonomy linked renamed Café'
    const renamedDescription = 'Verified metadata for the same linked category.'
    const createdName = 'Taxonomy new Cafe\u0301', createdDescription = 'Created in the administrator category editor.'
    const route = (template, id) => template.replace('{id:int}', String(id))
    const before = await context.request.get(siteOrigin.origin + route(R.CategoryMetadata, 1))
    assert.deepEqual(await readFrame(before, FrameType.TaxonomyExactMetadata, decodeTaxonomyMetadata), { id: 1, name: original, description: null })
    const previousGeneration = before.headers()[generationHeader]
    assert(previousGeneration)

    await loc.exactButton(panel, 'Create category').click()
    const create = loc.exactDialog(page, 'Create category')
    await loc.exactLabel(create, 'Category name').fill(`  ${createdName}  `)
    await loc.exactLabel(create, 'Category description').fill(createdDescription)
    const frames = [FrameType.AdminCategoryMetadataCommand, FrameType.AdminCategoryMetadata]
    const created = await writeMetadata(create, 'POST', R.AdminCategoryCreate, R.AdminCategoryCreatePow, 'Create category', ...frames)
    assert(created.id > 1 && created.revision > 0n)
    assertFields(created, { name: createdName, description: createdDescription, changed: true })
    await loc.exactText(panel, 'Category created.').waitFor()
    await assertRow(createdName, ['0', '0', '0', '0', '0', '0'])
    const createdGeneration = await verifyPublicTaxonomy('category', R.CategoryMetadata, created.id, createdName, createdDescription)
    assert(createdGeneration && createdGeneration !== previousGeneration)
    assertStatus(await context.request.post(siteOrigin.origin + R.AdminCategoryCreate), 404)

    const editPath = route(R.AdminCategoryMetadata, 1), editPow = route(R.AdminCategoryMetadataPow, 1)
    const current = await decodeMetadata(await read(loc.exactButton(taxonomyRow(original), 'Edit'), adminOrigin.origin + editPath), FrameType.AdminCategoryMetadata)
    assertFields(current, { id: 1, name: original, description: '', changed: false })
    const editor = loc.exactDialog(page, 'Edit category metadata')
    await loc.exactLabel(editor, 'Category name').fill(renamed)
    await loc.exactLabel(editor, 'Category description').fill(renamedDescription)
    const updated = await writeMetadata(editor, 'PUT', editPath, editPow, 'Save category metadata', ...frames)
    assert(updated.revision > current.revision)
    assertFields(updated, { id: 1, name: renamed, description: renamedDescription, changed: true })
    await loc.exactText(panel, 'Category metadata saved.').waitFor()
    await assertRow(renamed, ['0', '1', '1', '0', '1', '3'])
    await expectPage(await read(categories, categoryEndpoint), [
      { id: 1, name: renamed, published: 0, drafts: 1, scheduled: 1, retracted: 0, deleted: 1, retainedArticles: 3 },
      { id: created.id, name: createdName, published: 0, drafts: 0, scheduled: 0, retracted: 0, deleted: 0, retainedArticles: 0 },
    ])
    const renamedGeneration = await verifyPublicTaxonomy('category', R.CategoryMetadata, 1, renamed, renamedDescription)
    assert(renamedGeneration && renamedGeneration !== createdGeneration)
    await probe(siteOrigin.origin + editPath, adminCookieName, priorCookie.value, 404)
    assertStatus(await context.request.put(siteOrigin.origin + editPath), 404)
    await saveShot(page, evidence, 'administrator-category-metadata-mobile.png')
  }

  async function editUnusedTag() {
    const current = 'Taxonomy QA filler 3', renamed = 'Taxonomy renamed Café'
    const state = R.AdminTagMetadata.replace('{id:int}', '3')
    const before = await context.request.get(siteOrigin.origin + R.TagMetadata.replace('{id:int}', '3'))
    assertStatus(before, 200)
    const generation = before.headers()[generationHeader]
    assert(generation)
    assertStatus(await context.request.get(adminOrigin.origin + R.AdminTagMetadataAvailability), 204)
    await loc.exactButton(taxonomyRow(current), 'Edit').click()
    const editor = loc.exactDialog(page, 'Edit tag metadata')
    await loc.exactLabel(editor, 'Tag name').fill(renamed)
    await loc.exactLabel(editor, 'Tag description').fill('Verified for an unused tag.')
    const saved = waitForPathResponse(page, () => state, 'PUT')
    await loc.exactButton(editor, 'Save tag metadata').click()
    assertStatus(await saved, 200)
    await loc.exactText(panel, 'Tag metadata saved.').waitFor()
    await assertRow(renamed, ['0', '0', '0', '0', '0', '0'])
    await inspectReferences(tagEndpoint, 3, [0, 0, 2])
    const shorthand = await context.request.get(siteOrigin.origin + '/tag/' + encodeURIComponent(current) + '?page=2', { maxRedirects: 0 })
    assertStatus(shorthand, 301)
    assert.equal(shorthand.headers().location, '/tag/3?page=2')
    const html = await context.request.get(siteOrigin.origin + '/tag/3')
    assertStatus(html, 200)
    assert.match(await html.text(), /Verified for an unused tag\./)
    assert.notEqual(html.headers()[generationHeader], generation)
    await saveShot(page, evidence, 'administrator-tag-metadata-mobile.png')

    await loc.exactButton(panel, 'Create tag').click()
    const create = loc.exactDialog(page, 'Create tag')
    const createdName = 'Taxonomy new Café tag', description = 'Created by the scoped tag editor.'
    await loc.exactLabel(create, 'Tag name').fill('  Taxonomy new Cafe\u0301 tag  ')
    await loc.exactLabel(create, 'Tag description').fill(description)
    const created = await writeMetadata(create, 'POST', R.AdminTagCreate, R.AdminTagCreatePow, 'Create tag', FrameType.AdminTagCreateCommand, FrameType.AdminTagMetadata)
    assert(created.id > 26 && created.revision > 0n)
    assertFields(created, { name: createdName, description, changed: true })
    await loc.exactText(panel, 'Tag created.').waitFor()
    await read(loc.exactButton(panel, 'Next page'), `${tagEndpoint}?after=25`)
    await assertRow(createdName, ['0', '0', '0', '0', '0', '0'])

    const redirect = await context.request.get(siteOrigin.origin + '/tag/' + encodeURIComponent('Taxonomy new CAFE\u0301 tag') + '?page=2', { maxRedirects: 0 })
    assertStatus(redirect, 301)
    assert.equal(redirect.headers().location, `/tag/${created.id}?page=2`)
    const tagGeneration = await verifyPublicTaxonomy('tag', R.TagMetadata, created.id, createdName, description, false)
    assert(tagGeneration && tagGeneration !== html.headers()[generationHeader])
    await saveShot(page, evidence, 'administrator-tag-create-mobile.png')
  }
}

async function expectPage(response, items, nextId = null) {
  await assertNoStore(response)
  assert.deepEqual(await readFrame(response, FrameType.AdminTaxonomyPage, decodeAdminTaxonomyPage), { items, nextId })
}

async function seedArticles(context, origin) {
  const fx = authorFixture(origin, [])
  const create = async (title, tagIds) => fx.assignTaxonomy(context, await fx.createDraft(context, title, 'Author-only browser fixture.'), 1, tagIds)
  const draft = await create('Taxonomy browser historical-tag draft', [2])
  await fx.assignTaxonomy(context, draft, 1, [])
  const scheduled = await create('Taxonomy browser scheduled', [2])
  await fx.post(context, R.DraftScheduleCommand, FrameType.ArticleScheduleCommand, wire.encodeArticleScheduleCommand({
    id: scheduled.id, expectedRevision: scheduled.revision, idempotencyKey: randomUUID(), dueUnixMs: BigInt(Date.now() + 3_600_000),
  }), FrameType.ArticleSchedule)
  await fx.deleteDraft(context, await create('Taxonomy browser deleted', []))
}
