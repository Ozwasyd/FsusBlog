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

const run = promisify(execFile)

export async function verifyTaxonomy({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie,
  grant, revoke, seed, logIn, probe, snapshot, readCookie, evidence }) {
  await visitAdminWorkspace(page, '/admin/articles')
  const categoryEndpoint = adminOrigin.origin + WireRoutes.AdminCategories
  const tagEndpoint = adminOrigin.origin + WireRoutes.AdminTags
  const panel = page.getByRole('region', { name: 'Taxonomy usage', exact: true })
  const categories = panel.getByRole('button', { name: 'Categories', exact: true })
  const tags = panel.getByRole('button', { name: 'Tags', exact: true })
  const revoked = page.getByRole('alert').filter({ hasText: 'Your administrator session expired or was revoked. Log in again.' })
  const generation = (await snapshot(context)).principal.generation

  assert.equal((await context.request.get(siteOrigin.origin + WireRoutes.AdminCategories)).status(), 404)
  for (const path of ['/user/manage/category', '/user/manage/tag']) {
    assert.equal((await context.request.get(adminOrigin.origin + path)).status(), 404)
  }
  await probe(categoryEndpoint, siteCookie.name, siteCookie.value, 401)
  await probe(categoryEndpoint, adminCookieName, siteCookie.value, 401)
  assert.equal((await context.request.get(categoryEndpoint)).status(), 403)
  const categoryDependency = categoryEndpoint + '?dependency=1'
  assert.equal((await context.request.get(categoryDependency)).status(), 403)
  await probe(tagEndpoint + '?dependency=2', siteCookie.name, siteCookie.value, 401)
  await panel.waitFor({ state: 'detached' })

  await run(grant, [], { timeout: 8_000 })
  await probe(categoryEndpoint, adminCookieName, priorCookie.value, 401)
  await page.reload()
  await logIn(page)
  const granted = await snapshot(context)
  assert(granted.principal.generation > generation)
  const adminSession = adminOrigin.origin + WireRoutes.AdminSession
  const grantedCookie = await readCookie(context, adminSession, adminCookieName)
  assert.notEqual(grantedCookie.value, priorCookie.value)

  await expectPage(await read(tags, tagEndpoint), [])
  await panel.getByText('No tags found', { exact: true }).waitFor()
  await run(seed, [], { timeout: 8_000 })
  await seedArticles(context, siteOrigin.origin)
  await expectPage(await read(categories, categoryEndpoint), [{
    id: 1, name: 'Taxonomy QA category', published: 0, drafts: 1, scheduled: 1,
    retracted: 0, deleted: 1, retainedArticles: 3,
  }])
  await assertRow('Category usage', 'Taxonomy QA category', ['0', '1', '1', '0', '1', '3'])
  if (process.env.FSUSBLOG_TEST_ADMIN_CATEGORY_METADATA !== '1') {
    assert.equal((await context.request.get(adminOrigin.origin + WireRoutes.AdminCategoryMetadataAvailability)).status(), 404)
    assert.equal(await panel.getByRole('button', { name: 'Create category', exact: true }).count(), 0)
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
  await assertRow('Tag usage', 'Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  await expectPage(await read(panel.getByRole('button', { name: 'Next page', exact: true }), `${tagEndpoint}?after=25`), [spareTag(26)])
  await panel.getByText('Page 2', { exact: true }).waitFor()
  await assertRow('Tag usage', 'Taxonomy QA filler 26', ['0', '0', '0', '0', '0', '0'])
  await read(panel.getByRole('button', { name: 'Previous page', exact: true }), tagEndpoint)
  await assertRow('Tag usage', 'Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  assert.equal(await panel.getByRole('button', { name: /delete|remove/i }).count(), 0)
  const scrollRegion = panel.getByRole('region', { name: 'Taxonomy usage table', exact: true })
  assert(await scrollRegion.evaluate(element => element.scrollWidth <= element.clientWidth), 'Desktop must show all taxonomy columns without scrolling.')
  await panel.getByRole('heading', { name: 'Taxonomy usage', exact: true }).evaluate(heading => heading.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(evidence, 'administrator-taxonomy.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 375, height: 812 })
  await assertRow('Tag usage', 'Taxonomy QA tag', ['0', '0', '1', '0', '0', '2'])
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Taxonomy table must scroll inside the mobile panel.')
  assert(await scrollRegion.evaluate(element => element.scrollWidth > element.clientWidth), 'Narrow taxonomy tables must expose horizontal scrolling.')
  await panel.getByRole('heading', { name: 'Taxonomy usage', exact: true }).evaluate(heading => heading.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(evidence, 'administrator-taxonomy-mobile.png'), animations: 'disabled' })
  await inspectReferences('Tag', tagEndpoint, 2, [1, 1, 0], process.env.FSUSBLOG_TEST_ADMIN_TAG_METADATA === '1')
  await inspectReferences('Tag', tagEndpoint, 3, [0, 0, 0], process.env.FSUSBLOG_TEST_ADMIN_TAG_METADATA === '1')
  await read(categories, categoryEndpoint)
  await inspectReferences('Category', categoryEndpoint, 1, [2, 1, 0], process.env.FSUSBLOG_TEST_ADMIN_CATEGORY_METADATA === '1')
  await probe(siteOrigin.origin + WireRoutes.AdminCategories + '?dependency=1', adminCookieName, grantedCookie.value, 404)
  await read(tags, tagEndpoint)
  if (process.env.FSUSBLOG_TEST_ADMIN_TAG_METADATA === '1')
    await editUnusedTag()
  if (process.env.FSUSBLOG_TEST_ADMIN_CATEGORY_METADATA === '1')
    await createAndRenameCategory()

  await run(revoke, [], { timeout: 8_000 })
  await probe(tagEndpoint, adminCookieName, grantedCookie.value, 401)
  await probe(categoryDependency, adminCookieName, grantedCookie.value, 401)
  assert.equal((await read(tags, tagEndpoint)).status(), 401)
  await revoked.waitFor()
  await panel.waitFor({ state: 'hidden' })
  await logIn(page)
  assert((await snapshot(context)).principal.generation > granted.principal.generation)
  assert.equal((await context.request.get(tagEndpoint)).status(), 403)
  await panel.waitFor({ state: 'detached' })
  return readCookie(context, adminSession, adminCookieName)

  async function read(button, endpoint) {
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url() === endpoint && value.request().method() === 'GET'),
      button.click(),
    ])
    return response
  }

  async function assertRow(caption, name, values) {
    const row = panel.getByRole('table', { name: caption, exact: true }).getByRole('row').filter({ hasText: name })
    await row.getByRole('rowheader', { name, exact: true }).waitFor()
    assert.deepEqual(await row.getByRole('cell').allTextContents(), values)
  }
  async function inspectReferences(kind, endpoint, id, counts, writable) {
    const inspect = panel.getByRole('button', { name: 'Inspect references', exact: true })
    const details = panel.getByRole('region', { name: 'Taxonomy references', exact: true })
    const picker = panel.getByLabel(`${kind} to ${writable ? 'edit' : 'inspect'}`, { exact: true })
    const blocked = details.getByText('Physical deletion is blocked by existing references or reserved aliases.', { exact: true })
    if (!writable) {
      assert.equal(await panel.getByRole('button', { name: `Create ${kind.toLowerCase()}`, exact: true }).count(), 0)
      assert.equal(await panel.getByRole('button', { name: `Edit selected ${kind.toLowerCase()}`, exact: true }).count(), 0)
    }
    await picker.selectOption(String(id))
    const received = await read(inspect, `${endpoint}?dependency=${id}`)
    assert.equal(received.status(), 200)
    assert((await received.headerValue('Cache-Control'))?.includes('no-store'))
    const packet = decodeFrame(await received.body(), FrameType.AdminTaxonomyDependencies).payload
    assert.equal(packet.length, 16)
    const input = new PodReader(packet)
    assert.deepEqual([input.i32(), input.i32(), input.i32(), input.i32()], [id, ...counts])
    input.finish()
    await details.getByText('Active references', { exact: true }).waitFor()
    assert.deepEqual(await details.locator('dt').allTextContents(), ['Active references', 'Retained-only references', 'Reserved aliases'])
    assert.deepEqual(await details.locator('dd').allTextContents(), counts.map(String))
    if (counts.some(Boolean)) await blocked.waitFor()
    else assert.equal(await blocked.count(), 0)
    assert.equal(await panel.getByRole('button', { name: /delete|remove/i }).count(), 0)
    if (kind === 'Category')
      await page.screenshot({ path: join(evidence, 'administrator-taxonomy-references-mobile.png'), animations: 'disabled' })
    await details.getByRole('button', { name: 'Close reference details', exact: true }).click()
    await details.waitFor({ state: 'hidden' })
    await inspect.and(page.locator(':focus')).waitFor()
  }

  async function writeMetadata(form, method, path, powPath, buttonName, commandType, receiptType) {
    const endpoint = adminOrigin.origin + path
    const proof = adminOrigin.origin + powPath
    const [challenge, accepted] = await Promise.all([
      page.waitForResponse(response => response.url() === proof && response.request().method() === 'POST'),
      page.waitForResponse(response => response.url() === endpoint && response.request().method() === method),
      form.getByRole('button', { name: buttonName, exact: true }).click(),
    ])
    assert.equal(challenge.status(), 200)
    assert.equal(accepted.status(), 200)
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
    assert.equal((await context.request.get(adminOrigin.origin + availability)).status(), 204)
    await probe(siteOrigin.origin + availability, adminCookieName, grantedCookie.value, 404)
    const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
    const original = 'Taxonomy QA category'
    const renamed = 'Taxonomy linked renamed Café'
    const renamedDescription = 'Verified metadata for the same linked category.'
    const createdName = 'Taxonomy new Cafe\u0301'
    const createdDescription = 'Created in the administrator category editor.'
    const route = (template, id) => template.replace('{id:int}', String(id))
    const lookup = id => siteOrigin.origin + route(WireRoutes.CategoryMetadata, id)
    const before = await context.request.get(lookup(1))
    assert.equal(before.status(), 200)
    assert.deepEqual(decodeTaxonomyMetadata(decodeFrame(await before.body(), FrameType.TaxonomyExactMetadata).payload),
      { id: 1, name: original, description: null })
    const previousGeneration = before.headers()[generationHeader]
    assert(previousGeneration)

    async function publicCategory(id, name, description) {
      const raw = await context.request.get(lookup(id))
      assert.equal(raw.status(), 200)
      assert.deepEqual(decodeTaxonomyMetadata(decodeFrame(await raw.body(), FrameType.TaxonomyExactMetadata).payload),
        { id, name, description })
      const html = await context.request.get(siteOrigin.origin + `/category/${id}`)
      assert.equal(html.status(), 200)
      assert((await html.text()).includes(description))
      assert.equal(html.headers()[generationHeader], raw.headers()[generationHeader])
      return raw.headers()[generationHeader]
    }

    await panel.getByRole('button', { name: 'Create category', exact: true }).click()
    const create = panel.getByRole('region', { name: 'Create category', exact: true })
    await create.getByLabel('Category name', { exact: true }).fill(`  ${createdName}  `)
    await create.getByLabel('Category description', { exact: true }).fill(createdDescription)
    const frames = [FrameType.AdminCategoryMetadataCommand, FrameType.AdminCategoryMetadata]
    const created = await writeMetadata(create, 'POST', WireRoutes.AdminCategoryCreate, WireRoutes.AdminCategoryCreatePow,
      'Create category', ...frames)
    assert(created.id > 1 && created.revision > 0n)
    assert.deepEqual({ name: created.name, description: created.description, changed: created.changed },
      { name: createdName, description: createdDescription, changed: true })
    await panel.getByText('Category created.', { exact: true }).waitFor()
    await assertRow('Category usage', createdName, ['0', '0', '0', '0', '0', '0'])
    const createdGeneration = await publicCategory(created.id, createdName, createdDescription)
    assert(createdGeneration && createdGeneration !== previousGeneration)
    assert.equal((await context.request.post(siteOrigin.origin + WireRoutes.AdminCategoryCreate)).status(), 404)

    const editPath = route(WireRoutes.AdminCategoryMetadata, 1)
    const editPow = route(WireRoutes.AdminCategoryMetadataPow, 1)
    await panel.getByLabel('Category to edit').selectOption('1')
    const loaded = await read(panel.getByRole('button', { name: 'Edit selected category', exact: true }), adminOrigin.origin + editPath)
    assert.equal(loaded.status(), 200)
    const current = await decodeMetadata(loaded, FrameType.AdminCategoryMetadata)
    assert.deepEqual({ id: current.id, name: current.name, description: current.description, changed: current.changed },
      { id: 1, name: original, description: '', changed: false })
    const editor = panel.getByRole('region', { name: 'Edit category metadata', exact: true })
    await editor.getByLabel('Category name', { exact: true }).fill(renamed)
    await editor.getByLabel('Category description', { exact: true }).fill(renamedDescription)
    const updated = await writeMetadata(editor, 'PUT', editPath, editPow, 'Save category metadata', ...frames)
    assert(updated.revision > current.revision)
    assert.deepEqual({ id: updated.id, name: updated.name, description: updated.description, changed: updated.changed },
      { id: 1, name: renamed, description: renamedDescription, changed: true })
    await panel.getByText('Category metadata saved.', { exact: true }).waitFor()
    await assertRow('Category usage', renamed, ['0', '1', '1', '0', '1', '3'])
    const after = await read(categories, categoryEndpoint)
    await expectPage(after, [{ id: 1, name: renamed, published: 0, drafts: 1, scheduled: 1,
      retracted: 0, deleted: 1, retainedArticles: 3 }, { id: created.id, name: createdName, published: 0, drafts: 0, scheduled: 0,
      retracted: 0, deleted: 0, retainedArticles: 0 }])
    const renamedGeneration = await publicCategory(1, renamed, renamedDescription)
    assert(renamedGeneration && renamedGeneration !== createdGeneration)
    await probe(siteOrigin.origin + editPath, adminCookieName, grantedCookie.value, 404)
    assert.equal((await context.request.put(siteOrigin.origin + editPath)).status(), 404)
    await page.screenshot({ path: join(evidence, 'administrator-category-metadata-mobile.png'), animations: 'disabled' })
  }

  async function editUnusedTag() {
    const current = 'Taxonomy QA filler 3'
    const renamed = 'Taxonomy renamed Café'
    const state = WireRoutes.AdminTagMetadata.replace('{id:int}', '3')
    const route = WireRoutes.TagMetadata.replace('{id:int}', '3')
    const before = await context.request.get(siteOrigin.origin + route)
    assert.equal(before.status(), 200)
    const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
    const generation = before.headers()[generationHeader]
    assert(generation)
    const authorization = await context.request.get(adminOrigin.origin + WireRoutes.AdminTagMetadataAvailability)
    assert.equal(authorization.status(), 204)
    await panel.getByLabel('Tag to edit').selectOption('3')
    await panel.getByRole('button', { name: 'Edit selected tag', exact: true }).click()
    const editor = panel.getByRole('region', { name: 'Edit tag metadata', exact: true })
    const name = editor.getByLabel('Tag name', { exact: true })
    await name.fill(renamed)
    await editor.getByLabel('Tag description', { exact: true }).fill('Verified for an unused tag.')
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === state && response.request().method() === 'PUT')
    await editor.getByRole('button', { name: 'Save tag metadata', exact: true }).click()
    assert.equal((await saved).status(), 200)
    await panel.getByText('Tag metadata saved.', { exact: true }).waitFor()
    await assertRow('Tag usage', renamed, ['0', '0', '0', '0', '0', '0'])
    await inspectReferences('Tag', tagEndpoint, 3, [0, 0, 2], true)
    const shorthand = await context.request.get(siteOrigin.origin + '/tag/' + encodeURIComponent(current) + '?page=2', { maxRedirects: 0 })
    assert.equal(shorthand.status(), 301)
    assert.equal(shorthand.headers().location, '/tag/3?page=2')
    const html = await context.request.get(siteOrigin.origin + '/tag/3')
    assert.equal(html.status(), 200)
    assert.match(await html.text(), /Verified for an unused tag\./)
    assert.notEqual(html.headers()[generationHeader], generation)
    await page.screenshot({ path: join(evidence, 'administrator-tag-metadata-mobile.png'), animations: 'disabled' })

    await panel.getByRole('button', { name: 'Create tag', exact: true }).click()
    const create = panel.getByRole('region', { name: 'Create tag', exact: true })
    const createdName = 'Taxonomy new Café tag'
    const description = 'Created by the scoped tag editor.'
    await create.getByLabel('Tag name', { exact: true }).fill('  Taxonomy new Cafe\u0301 tag  ')
    await create.getByLabel('Tag description', { exact: true }).fill(description)
    const created = await writeMetadata(create, 'POST', WireRoutes.AdminTagCreate, WireRoutes.AdminTagCreatePow,
      'Create tag', FrameType.AdminTagCreateCommand, FrameType.AdminTagMetadata)
    assert(created.id > 26 && created.revision > 0n)
    assert.deepEqual([created.name, created.description, created.changed], [createdName, description, true])
    await panel.getByText('Tag created.', { exact: true }).waitFor()
    await read(panel.getByRole('button', { name: 'Next page', exact: true }), `${tagEndpoint}?after=25`)
    await assertRow('Tag usage', createdName, ['0', '0', '0', '0', '0', '0'])

    const alias = '/tag/' + encodeURIComponent('Taxonomy new CAFE\u0301 tag') + '?page=2'
    const redirect = await context.request.get(siteOrigin.origin + alias, { maxRedirects: 0 })
    assert.equal(redirect.status(), 301)
    assert.equal(redirect.headers().location, `/tag/${created.id}?page=2`)
    const publicPath = WireRoutes.TagMetadata.replace('{id:int}', String(created.id))
    const publicRead = await context.request.get(siteOrigin.origin + publicPath)
    assert.equal(publicRead.status(), 200)
    assert.deepEqual(decodeTaxonomyMetadata(decodeFrame(await publicRead.body(), FrameType.TaxonomyExactMetadata).payload),
      { id: created.id, name: createdName, description })
    assert(publicRead.headers()[generationHeader] && publicRead.headers()[generationHeader] !== html.headers()[generationHeader])
    const canonical = await context.request.get(`${siteOrigin.origin}/tag/${created.id}`)
    assert.equal(canonical.status(), 200)
    assert((await canonical.text()).includes(description))
    await page.screenshot({ path: join(evidence, 'administrator-tag-create-mobile.png'), animations: 'disabled' })
  }
}

async function expectPage(response, items, nextId = null) {
  assert.equal(response.status(), 200)
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
