import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAdminTaxonomyPage } from '../../src/Contracts/admin-taxonomy.ts'
import {
  decodeDraft, decodeDraftTaxonomy, encodeArticleCommand, encodeArticleScheduleCommand, encodeTaxonomyAssignment,
  FrameType, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

const run = promisify(execFile)

export async function verifyTaxonomy({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie,
  grant, revoke, seed, logIn, probe, snapshot, readCookie, evidence }) {
  const categoryEndpoint = adminOrigin.origin + WireRoutes.AdminCategories
  const tagEndpoint = adminOrigin.origin + WireRoutes.AdminTags
  const panel = page.getByRole('region', { name: 'Taxonomy usage', exact: true })
  const categories = panel.getByRole('button', { name: 'Categories', exact: true })
  const tags = panel.getByRole('button', { name: 'Tags', exact: true })
  const denied = panel.getByRole('alert').filter({ hasText: 'You do not have permission to view taxonomy usage.' })
  const revoked = page.getByRole('alert').filter({ hasText: 'Your administrator session expired or was revoked. Log in again.' })
  const generation = (await snapshot(context)).principal.generation

  assert.equal((await context.request.get(siteOrigin.origin + WireRoutes.AdminCategories)).status(), 404)
  for (const path of ['/user/manage/category', '/user/manage/tag']) {
    assert.equal((await context.request.get(adminOrigin.origin + path)).status(), 404)
  }
  await probe(categoryEndpoint, siteCookie.name, siteCookie.value, 401)
  await probe(categoryEndpoint, adminCookieName, siteCookie.value, 401)
  assert.equal((await read(categories, categoryEndpoint)).status(), 403)
  await denied.waitFor()

  await run(grant, [], { timeout: 8_000 })
  assert.equal((await read(categories, categoryEndpoint)).status(), 401)
  await revoked.waitFor()
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

  await run(revoke, [], { timeout: 8_000 })
  await probe(tagEndpoint, adminCookieName, grantedCookie.value, 401)
  assert.equal((await read(tags, tagEndpoint)).status(), 401)
  await revoked.waitFor()
  await panel.waitFor({ state: 'hidden' })
  await logIn(page)
  assert((await snapshot(context)).principal.generation > granted.principal.generation)
  assert.equal((await read(tags, tagEndpoint)).status(), 403)
  await denied.waitFor()
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
