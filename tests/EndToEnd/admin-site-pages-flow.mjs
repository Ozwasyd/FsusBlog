import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSitePage } from '../../src/Contracts/site-pages.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function verifyAdminSitePages({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
  priorCookie, grant, revoke, logIn, probe, readCookie, evidence }) {
  const legacy = '/api/binary/system/admin/page/about'
  const overview = adminOrigin.origin + WireRoutes.AdminSitePages
  const detail = WireRoutes.AdminSitePage.replace('{slug}', 'about')
  const section = page.getByRole('region', { name: 'Site pages', exact: true })
  const button = section.getByRole('button', { name: 'Check site pages', exact: true })
  const check = async () => (await Promise.all([
    page.waitForResponse(response => response.url() === overview && response.request().method() === 'GET'), button.click(),
  ]))[0]
  await probe(adminOrigin.origin + legacy, adminCookieName, siteCookie.value, 401)
  await probe(siteOrigin.origin + legacy, adminCookieName, priorCookie.value, 404)
  assert.equal((await context.request.get(adminOrigin.origin + legacy + '/nested')).status(), 404)
  assert.equal((await context.request.get(adminOrigin.origin + '/api/binary/system/page/about')).status(), 404)
  assert.equal((await context.request.put(adminOrigin.origin + legacy)).status(), 404)
  assert.equal((await context.request.get(adminOrigin.origin + legacy)).status(), 403)
  assert.equal((await check()).status(), 403)
  await section.getByText('The system.config permission is required.').waitFor()

  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await probe(adminOrigin.origin + legacy, adminCookieName, priorCookie.value, 401)
  assert.equal((await check()).status(), 401)
  await page.getByRole('button', { name: 'Log in as administrator', exact: true }).waitFor()
  await logIn(page)
  const allowed = await check()
  assert.equal(allowed.status(), 200)
  assert.match(allowed.headers()['cache-control'], /no-store/)
  const overviewFrame = decodeFrame(await allowed.body(), FrameType.AdminSitePages)
  assert.equal(overviewFrame.payload.length, 4)
  assert.equal(new DataView(overviewFrame.payload.buffer, overviewFrame.payload.byteOffset, 4).getInt32(0, true), 15)
  assert.equal(await section.getByText('Configured', { exact: true }).count(), 4)
  await section.getByRole('button', { name: 'View about content', exact: true }).click()
  const displayed = section.getByLabel('about Markdown')
  await displayed.waitFor()
  assert.match(await displayed.textContent(), /# Verified about\n\n<script>literal<\/script>/)
  assert.equal(await section.locator('script').count(), 0)

  const canonical = await context.request.get(adminOrigin.origin + legacy)
  const versioned = await context.request.get(adminOrigin.origin + detail)
  const publicPage = await context.request.get(siteOrigin.origin + '/api/binary/system/page/about')
  for (const response of [canonical, versioned, publicPage]) {
    assert.equal(response.status(), 200)
    assert.match(response.headers()['cache-control'], /no-store/)
  }
  const exact = await canonical.body()
  assert.deepEqual(await versioned.body(), exact)
  assert.deepEqual(await publicPage.body(), exact)
  assert.deepEqual(decodeSitePage(decodeFrame(exact, FrameType.PageContent).payload),
    { slug: 'about', markdown: '# Verified about\n\n<script>literal</script>\n' })
  assert.equal((await context.request.get(adminOrigin.origin + '/api/binary/system/admin/page/unknown')).status(), 404)
  await page.screenshot({ path: join(evidence, 'administrator-site-page.png') })

  const grantCookie = await readCookie(context, adminOrigin.origin + detail, adminCookieName)
  await promisify(execFile)(revoke, [], { timeout: 8_000 })
  await probe(adminOrigin.origin + legacy, adminCookieName, grantCookie.value, 401)
  assert.equal((await check()).status(), 401)
  await displayed.waitFor({ state: 'hidden' })
  await logIn(page)
  assert.equal((await check()).status(), 403)
  return await readCookie(context, adminOrigin.origin + WireRoutes.AdminSession, adminCookieName)
}
