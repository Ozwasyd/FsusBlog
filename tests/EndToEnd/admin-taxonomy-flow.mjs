import { assertStatus } from './response-status-fixture.mjs'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import { visitAdminWorkspace } from './admin-workspace-fixture.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAdminTaxonomyPage } from '../../src/Contracts/admin-taxonomy.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { decodePowChallenge } from '../../src/Contracts/pow.ts'
import { decodeTaxonomyMetadata } from '../../src/Contracts/taxonomy.ts'
import {
  decodeDraft, decodeDraftTaxonomy, encodeArticleCommand, encodeArticleScheduleCommand, encodeTaxonomyAssignment,
  FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'
import { exactButton, roleWithExactName, exactText, exactLabel } from './role-locators.mjs'

const run = promisify(execFile)

export async function verifyTaxonomy({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie,
  revoke, seed, logIn, probe, snapshot, readCookie, evidence }) {
  await visitAdminWorkspace(page, '/admin/articles')
  const categoryEndpoint = adminOrigin.origin + WireRoutes.AdminCategories
  const tagEndpoint = adminOrigin.origin + WireRoutes.AdminTags
  const panel = roleWithExactName(page.getByRole('tabpanel'), 'region', 'Taxonomy usage')
  const scrollRegion = roleWithExactName(panel, 'region', 'Taxonomy usage table')
  const categories = roleWithExactName(page, 'tab', 'Categories')
  const tags = roleWithExactName(page, 'tab', 'Tags')
  const revoked = page.getByRole('alert').filter({ hasText: 'Your administrator session expired or was revoked. Log in again.' })
  const active = await snapshot(context)

  assertStatus(await context.request.get(siteOrigin.origin + WireRoutes.AdminCategories), 404)
  for (const path of ['/user/manage/category', '/user/manage/tag']) {
    assertStatus(await context.request.get(adminOrigin.origin + path), 404)
  }
  await probe(categoryEndpoint, siteCookie.name, siteCookie.value, 401)
  await probe(categoryEndpoint, adminCookieName, siteCookie.value, 401)
  const categoryDependency = categoryEndpoint + '?dependency=1'
  await probe(categoryDependency, adminCookieName, siteCookie.value, 401)
  await probe(tagEndpoint + '?dependency=2', siteCookie.name, siteCookie.value, 401)
  const adminSession = adminOrigin.origin + WireRoutes.AdminSession

  await expectPage(await read(tags, tagEndpoint), [])
  await exactText(panel, 'No tags found').waitFor()
  await run(seed, [], { timeout: 8_000 })
  await seedArticles(context, adminOrigin.origin)
  await expectPage(await read(categories, categoryEndpoint), [{
    id: 1, name: 'Taxonomy QA category', published: 0, drafts: 1, scheduled: 1,
    retracted: 0, deleted: 1, retainedArticles: 3,
  }])
  await assertRow('Taxonomy QA category', ['0', '1', '1', '0', '1', '3'])
  if (process.env.FSUSBLOG_TEST_ADMIN_CATEGORY_METADATA !== '1') {
    assertStatus(await context.request.get(adminOrigin.origin + WireRoutes.AdminCategoryMetadataAvailability), 404)
    assert.equal(await exactButton(panel, 'Create category').count(), 0)
  }
  const referencedTag = {
    id: 2, name: 'Taxonomy QA tag', published: 0, drafts: 0, scheduled: 1,
    retracted: 0, deleted: 0, retainedArticles: 2,
  }
  const spareTag = id => ({
    id, name: `Taxonomy QA filler ${id}`, published: 0, drafts: 0, scheduled: 0,
    retracted: 0, deleted: 0, retainedArticles: 0,
  })
  await expectPage(await read(tags, tagEndpoint), [referencedTag, ...Array.from({ length: 23 }, (_, index) => spareTag(index + 3))], 25)
  await assertRow('Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  await expectPage(await read(exactButton(panel, 'Next page'), `${tagEndpoint}?after=25`), [spareTag(26)])
  await exactText(panel, 'Page 2').waitFor()
  await assertRow('Taxonomy QA filler 26', ['0', '0', '0', '0', '0', '0'])
  await read(exactButton(panel, 'Previous page'), tagEndpoint)
  await assertRow('Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  assert(await scrollRegion.evaluate(element => element.scrollWidth <= element.clientWidth), 'Desktop must show all taxonomy columns without scrolling.')
  await roleWithExactName(panel, 'heading', 'Taxonomy usage').evaluate(heading => heading.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(evidence, 'administrator-taxonomy.png'), animations: 'disabled' })
  const initialViewport = page.viewportSize()
  await page.setViewportSize({ width: 375, height: 812 })
  await assertRow('Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Taxonomy table must scroll inside the mobile panel.')
  assert(await scrollRegion.evaluate(element => element.scrollWidth > element.clientWidth), 'Narrow taxonomy tables must expose horizontal scrolling.')
  await roleWithExactName(panel, 'heading', 'Taxonomy usage').evaluate(heading => heading.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(evidence, 'administrator-taxonomy-mobile.png'), animations: 'disabled' })
  const tagsWritable = process.env.FSUSBLOG_TEST_ADMIN_TAG_METADATA === '1'
  await inspectReferences(tagEndpoint, 2, [1, 1, 0])
  await checkLinkedItem('tag', 'Taxonomy QA tag', 2, tagsWritable)
  await inspectReferences(tagEndpoint, 3, [0, 0, 0])
  await read(categories, categoryEndpoint)
  const categoriesWritable = process.env.FSUSBLOG_TEST_ADMIN_CATEGORY_METADATA === '1'
  await inspectReferences(categoryEndpoint, 1, [2, 1, 0])
  await checkLinkedItem('category', 'Taxonomy QA category', 3, categoriesWritable)
  await page.screenshot({ path: join(evidence, 'administrator-taxonomy-references-mobile.png'), animations: 'disabled' })
  await probe(siteOrigin.origin + WireRoutes.AdminCategories + '?dependency=1', adminCookieName, priorCookie.value, 404)
  await read(tags, tagEndpoint)
  if (tagsWritable) await editUnusedTag()
  if (categoriesWritable) await createAndRenameCategory()

  await run(revoke, [], { timeout: 8_000 })
  await probe(tagEndpoint, adminCookieName, priorCookie.value, 401)
  await probe(categoryDependency, adminCookieName, priorCookie.value, 401)
  assertStatus(await read(tags, tagEndpoint), 401)
  await revoked.waitFor()
  await panel.waitFor({ state: 'hidden' })
  if (initialViewport) await page.setViewportSize(initialViewport)
  await logIn(page)
  assert((await snapshot(context)).principal.generation > active.principal.generation)
  assertStatus(await context.request.get(tagEndpoint), 200)
  return readCookie(context, adminSession, adminCookieName)

  async function read(button, endpoint) {
    const selectedTab = await button.getAttribute('role') === 'tab' && await button.getAttribute('aria-selected') === 'true'
    const trigger = selectedTab ? exactButton(panel, 'Refresh list') : button
    const [response] = await Promise.all([
      waitForUrlResponse(page, () => endpoint, 'GET'),
      trigger.click(),
    ])
    return response
  }

  function taxonomyRow(name) {
    return scrollRegion.getByRole('row').filter({ has: roleWithExactName(page, 'rowheader', name) })
  }

  async function assertRow(name, [published, drafts, scheduled, retracted, deleted, retained]) {
    const row = taxonomyRow(name)
    await row.waitFor()
    const summary = [drafts, scheduled, retracted, deleted].every(value => value === '0') && retained === published
      ? 'No other references'
      : `Draft ${drafts} · Scheduled ${scheduled} · Retracted ${retracted} · Deleted ${deleted} · Retained ${retained}`
    const cells = row.getByRole('cell')
    assert.equal((await cells.nth(0).innerText()).trim(), published)
    assert.equal((await cells.nth(1).innerText()).trim(), summary)
  }

  async function inspectReferences(endpoint, id, counts) {
    const received = await context.request.get(`${endpoint}?dependency=${id}`)
    assertStatus(received, 200)
    assert(received.headers()['cache-control']?.includes('no-store'))
    const packet = decodeFrame(await received.body(), FrameType.AdminTaxonomyDependencies).payload
    assert.equal(packet.length, 16)
    const input = new PodReader(packet)
    assert.deepEqual([input.i32(), input.i32(), input.i32(), input.i32()], [id, ...counts])
    input.finish()
  }

  async function checkLinkedItem(kind, name, count, writable) {
    const row = taxonomyRow(name)
    await exactButton(row, 'View articles').waitFor()
    const remove = exactButton(row, 'Delete')
    if (!writable) {
      assert.equal(await exactButton(panel, `Create ${kind}`).count(), 0)
      assert.equal(await exactButton(row, 'Edit').count(), 0)
      assert.equal(await remove.count(), 0)
      return
    }
    const dialog = roleWithExactName(page, 'dialog', `Delete ${kind}`)
    await remove.click()
    await exactText(dialog, `${kind} “${name}” is still referenced by ${count} article(s) (including saved revisions) and cannot be deleted.`).waitFor()
    assert.equal(await exactButton(dialog, 'Delete').count(), 0)
    await exactButton(dialog, 'View linked articles').waitFor()
    await exactButton(dialog, 'Cancel').click()
    await dialog.waitFor({ state: 'hidden' })
    await remove.and(page.locator(':focus')).waitFor()
  }

  async function writeMetadata(form, method, path, powPath, buttonName, commandType, receiptType) {
    const endpoint = adminOrigin.origin + path
    const proof = adminOrigin.origin + powPath
    const [challenge, accepted] = await Promise.all([
      waitForUrlResponse(page, () => proof, 'POST'),
      page.waitForResponse(response => response.url() === endpoint && response.request().method() === method),
      exactButton(form, buttonName).click(),
    ])
    assertStatus(challenge, 200)
    assertStatus(accepted, 200)
    assert.equal(decodePowChallenge(decodeFrame(await challenge.body(), FrameType.PowChallenge).payload).difficulty, WireLimits.PowChallengeDifficulty)
    const command = accepted.request().postDataBuffer()
    assert(command)
    const formBytes = decodeFrame(command, commandType).payload
    if (method === 'POST') {
      const coordinates = new PodReader(formBytes)
      assert.equal(coordinates.i32(), 0)
      assert.equal(coordinates.i64(), 0n)
    }
    assert.deepEqual(challenge.request().postDataBuffer(), command)
    assert.match(challenge.request().headers()[WireHeaders.PowClientNonce.toLowerCase()], /^[a-f0-9]{32}$/)
    assert(accepted.request().headers()[WireHeaders.PowProof.toLowerCase()])
    assert((await accepted.headerValue('Cache-Control'))?.includes('no-store'))
    return decodeMetadata(accepted, receiptType)
  }

  async function decodeMetadata(response, receiptType) {
    const input = new PodReader(decodeFrame(await response.body(), receiptType).payload)
    const result = { id: input.i32(), revision: input.i64(), name: input.text(WireLimits.TaxonomyNameBytes),
      description: input.text(WireLimits.TaxonomyDescriptionBytes), changed: input.bool() }
    input.finish()
    return result
  }

  async function createAndRenameCategory() {
    await read(categories, categoryEndpoint)
    const availability = WireRoutes.AdminCategoryMetadataAvailability
    assertStatus(await context.request.get(adminOrigin.origin + availability), 204)
    await probe(siteOrigin.origin + availability, adminCookieName, priorCookie.value, 404)
    const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
    const original = 'Taxonomy QA category'
    const renamed = 'Taxonomy linked renamed Café'
    const renamedDescription = 'Verified metadata for the same linked category.'
    const createdName = 'Taxonomy new Cafe\u0301'
    const createdDescription = 'Created in the administrator category editor.'
    const route = (template, id) => template.replace('{id:int}', String(id))
    const lookup = id => siteOrigin.origin + route(WireRoutes.CategoryMetadata, id)
    const before = await context.request.get(lookup(1))
    assertStatus(before, 200)
    assert.deepEqual(decodeTaxonomyMetadata(decodeFrame(await before.body(), FrameType.TaxonomyExactMetadata).payload),
      { id: 1, name: original, description: null })
    const previousGeneration = before.headers()[generationHeader]
    assert(previousGeneration)

    async function publicCategory(id, name, description) {
      const raw = await context.request.get(lookup(id))
      assertStatus(raw, 200)
      assert.deepEqual(decodeTaxonomyMetadata(decodeFrame(await raw.body(), FrameType.TaxonomyExactMetadata).payload),
        { id, name, description })
      const html = await context.request.get(siteOrigin.origin + `/category/${id}`)
      assertStatus(html, 200)
      assert((await html.text()).includes(description))
      assert.equal(html.headers()[generationHeader], raw.headers()[generationHeader])
      return raw.headers()[generationHeader]
    }

    await exactButton(panel, 'Create category').click()
    const create = roleWithExactName(page, 'dialog', 'Create category')
    await exactLabel(create, 'Category name').fill(`  ${createdName}  `)
    await exactLabel(create, 'Category description').fill(createdDescription)
    const frames = [FrameType.AdminCategoryMetadataCommand, FrameType.AdminCategoryMetadata]
    const created = await writeMetadata(create, 'POST', WireRoutes.AdminCategoryCreate, WireRoutes.AdminCategoryCreatePow,
      'Create category', ...frames)
    assert(created.id > 1 && created.revision > 0n)
    assert.deepEqual({ name: created.name, description: created.description, changed: created.changed },
      { name: createdName, description: createdDescription, changed: true })
    await exactText(panel, 'Category created.').waitFor()
    await assertRow(createdName, ['0', '0', '0', '0', '0', '0'])
    const createdGeneration = await publicCategory(created.id, createdName, createdDescription)
    assert(createdGeneration && createdGeneration !== previousGeneration)
    assertStatus(await context.request.post(siteOrigin.origin + WireRoutes.AdminCategoryCreate), 404)

    const editPath = route(WireRoutes.AdminCategoryMetadata, 1)
    const editPow = route(WireRoutes.AdminCategoryMetadataPow, 1)
    const loaded = await read(exactButton(taxonomyRow(original), 'Edit'), adminOrigin.origin + editPath)
    assertStatus(loaded, 200)
    const current = await decodeMetadata(loaded, FrameType.AdminCategoryMetadata)
    assert.deepEqual({ id: current.id, name: current.name, description: current.description, changed: current.changed },
      { id: 1, name: original, description: '', changed: false })
    const editor = roleWithExactName(page, 'dialog', 'Edit category metadata')
    await exactLabel(editor, 'Category name').fill(renamed)
    await exactLabel(editor, 'Category description').fill(renamedDescription)
    const updated = await writeMetadata(editor, 'PUT', editPath, editPow, 'Save category metadata', ...frames)
    assert(updated.revision > current.revision)
    assert.deepEqual({ id: updated.id, name: updated.name, description: updated.description, changed: updated.changed },
      { id: 1, name: renamed, description: renamedDescription, changed: true })
    await exactText(panel, 'Category metadata saved.').waitFor()
    await assertRow(renamed, ['0', '1', '1', '0', '1', '3'])
    const after = await read(categories, categoryEndpoint)
    await expectPage(after, [{ id: 1, name: renamed, published: 0, drafts: 1, scheduled: 1,
      retracted: 0, deleted: 1, retainedArticles: 3 }, { id: created.id, name: createdName, published: 0, drafts: 0, scheduled: 0,
      retracted: 0, deleted: 0, retainedArticles: 0 }])
    const renamedGeneration = await publicCategory(1, renamed, renamedDescription)
    assert(renamedGeneration && renamedGeneration !== createdGeneration)
    await probe(siteOrigin.origin + editPath, adminCookieName, priorCookie.value, 404)
    assertStatus(await context.request.put(siteOrigin.origin + editPath), 404)
    await page.screenshot({ path: join(evidence, 'administrator-category-metadata-mobile.png'), animations: 'disabled' })
  }

  async function editUnusedTag() {
    const current = 'Taxonomy QA filler 3'
    const renamed = 'Taxonomy renamed Café'
    const state = WireRoutes.AdminTagMetadata.replace('{id:int}', '3')
    const route = WireRoutes.TagMetadata.replace('{id:int}', '3')
    const before = await context.request.get(siteOrigin.origin + route)
    assertStatus(before, 200)
    const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
    const generation = before.headers()[generationHeader]
    assert(generation)
    const authorization = await context.request.get(adminOrigin.origin + WireRoutes.AdminTagMetadataAvailability)
    assertStatus(authorization, 204)
    await exactButton(taxonomyRow(current), 'Edit').click()
    const editor = roleWithExactName(page, 'dialog', 'Edit tag metadata')
    const name = exactLabel(editor, 'Tag name')
    await name.fill(renamed)
    await exactLabel(editor, 'Tag description').fill('Verified for an unused tag.')
    const saved = waitForPathResponse(page, () => state, 'PUT')
    await exactButton(editor, 'Save tag metadata').click()
    assertStatus(await saved, 200)
    await exactText(panel, 'Tag metadata saved.').waitFor()
    await assertRow(renamed, ['0', '0', '0', '0', '0', '0'])
    await inspectReferences(tagEndpoint, 3, [0, 0, 2])
    const shorthand = await context.request.get(siteOrigin.origin + '/tag/' + encodeURIComponent(current) + '?page=2', { maxRedirects: 0 })
    assertStatus(shorthand, 301)
    assert.equal(shorthand.headers().location, '/tag/3?page=2')
    const html = await context.request.get(siteOrigin.origin + '/tag/3')
    assertStatus(html, 200)
    assert.match(await html.text(), /Verified for an unused tag\./)
    assert.notEqual(html.headers()[generationHeader], generation)
    await page.screenshot({ path: join(evidence, 'administrator-tag-metadata-mobile.png'), animations: 'disabled' })

    await exactButton(panel, 'Create tag').click()
    const create = roleWithExactName(page, 'dialog', 'Create tag')
    const createdName = 'Taxonomy new Café tag'
    const description = 'Created by the scoped tag editor.'
    await exactLabel(create, 'Tag name').fill('  Taxonomy new Cafe\u0301 tag  ')
    await exactLabel(create, 'Tag description').fill(description)
    const created = await writeMetadata(create, 'POST', WireRoutes.AdminTagCreate, WireRoutes.AdminTagCreatePow,
      'Create tag', FrameType.AdminTagCreateCommand, FrameType.AdminTagMetadata)
    assert(created.id > 26 && created.revision > 0n)
    assert.deepEqual([created.name, created.description, created.changed], [createdName, description, true])
    await exactText(panel, 'Tag created.').waitFor()
    await read(exactButton(panel, 'Next page'), `${tagEndpoint}?after=25`)
    await assertRow(createdName, ['0', '0', '0', '0', '0', '0'])

    const alias = '/tag/' + encodeURIComponent('Taxonomy new CAFE\u0301 tag') + '?page=2'
    const redirect = await context.request.get(siteOrigin.origin + alias, { maxRedirects: 0 })
    assertStatus(redirect, 301)
    assert.equal(redirect.headers().location, `/tag/${created.id}?page=2`)
    const publicPath = WireRoutes.TagMetadata.replace('{id:int}', String(created.id))
    const publicRead = await context.request.get(siteOrigin.origin + publicPath)
    assertStatus(publicRead, 200)
    assert.deepEqual(decodeTaxonomyMetadata(decodeFrame(await publicRead.body(), FrameType.TaxonomyExactMetadata).payload),
      { id: created.id, name: createdName, description })
    assert(publicRead.headers()[generationHeader] && publicRead.headers()[generationHeader] !== html.headers()[generationHeader])
    const canonical = await context.request.get(`${siteOrigin.origin}/tag/${created.id}`)
    assertStatus(canonical, 200)
    assert((await canonical.text()).includes(description))
    await page.screenshot({ path: join(evidence, 'administrator-tag-create-mobile.png'), animations: 'disabled' })
  }
}

async function expectPage(response, items, nextId = null) {
  assertStatus(response, 200)
  assert((await response.headerValue('Cache-Control'))?.includes('no-store'))
  const frame = decodeFrame(await response.body(), FrameType.AdminTaxonomyPage)
  assert.deepEqual(decodeAdminTaxonomyPage(frame.payload), { items, nextId })
}

async function seedArticles(context, origin) {
  const draft = await create('Taxonomy browser historical-tag draft', [2])
  await assign(draft.id, draft.revision, [])
  const scheduled = await create('Taxonomy browser scheduled', [2])
  await post(WireRoutes.DraftScheduleCommand, FrameType.ArticleScheduleCommand, encodeArticleScheduleCommand({
    id: scheduled.id, expectedRevision: scheduled.revision, idempotencyKey: randomUUID(), dueUnixMs: BigInt(Date.now() + 3_600_000),
  }), FrameType.ArticleSchedule)
  const deleted = await create('Taxonomy browser deleted', [])
  await command(WireRoutes.Delete, deleted.id, deleted.revision, '', '', FrameType.EmptySuccess)

  async function create(title, tagIds) {
    const article = decodeDraft(await command(WireRoutes.Save, 0, 0n, title, 'Author-only browser fixture.'))
    return assign(article.id, article.revision, tagIds)
  }

  async function assign(id, expectedRevision, tagIds) {
    return decodeDraftTaxonomy(await post(WireRoutes.TaxonomyAssignment, FrameType.TaxonomyAssignment, encodeTaxonomyAssignment({
      id, expectedRevision, idempotencyKey: randomUUID(), categoryId: 1, tagIds,
    }), FrameType.DraftTaxonomy))
  }

  async function command(path, id, expectedRevision, title, body, expected = FrameType.Draft) {
    return post(path, FrameType.ArticleCommand, encodeArticleCommand({ id, expectedRevision, idempotencyKey: randomUUID(), title, body }), expected)
  }

  async function post(path, type, payload, expected) {
    const response = await context.request.post(origin + path, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(encodeFrame(type, payload)),
    })
    assert.equal(response.status(), 200, path)
    return decodeFrame(await response.body(), expected).payload
  }
}
