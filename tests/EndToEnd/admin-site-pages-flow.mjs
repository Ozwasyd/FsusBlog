import { waitForUrlResponse } from './response-wait-fixture.mjs'
import { visitAdminWorkspace } from './admin-workspace-fixture.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { adminClusterFlow } from './admin-cluster-flow.mjs'
import { adminRiskReadinessFlow, verifyRootCommentPowPolicy } from './admin-risk-readiness-flow.mjs'
import { decodeSitePage } from '../../src/Contracts/site-pages.ts'
import { decodeAdminSitePageRevision, encodeAdminSitePagePublish, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exactButton, roleWithExactName } from './role-locators.mjs'

export async function verifyAdminSitePages({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
  priorCookie, grant, revoke, logIn, probe, readCookie, evidence }) {
  const cluster = adminClusterFlow({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie, probe, evidence })
  const riskFixture = process.env.FSUSBLOG_TEST_ADMIN_RISK_EXPECTED
  const risk = riskFixture ? adminRiskReadinessFlow({ page, context, adminOrigin, siteOrigin, adminCookieName,
    siteCookie, priorCookie, probe, evidence, expected: JSON.parse(riskFixture) }) : null
  const openRiskControls = async () => {
    await visitAdminWorkspace(page, '/admin/interaction')
    await roleWithExactName(page, 'tab', 'Risk controls').click()
  }
  await visitAdminWorkspace(page, '/admin/site')
  await cluster.denied()
  if (risk) {
    await openRiskControls()
    await risk.denied()
    await visitAdminWorkspace(page, '/admin/site')
  }
  const legacy = '/api/binary/system/admin/page/about'
  const overview = adminOrigin.origin + WireRoutes.AdminSitePages
  const detail = WireRoutes.AdminSitePage.replace('{slug}', 'about')
  const section = roleWithExactName(page, 'region', 'Site pages')
  const button = exactButton(section, 'Refresh')
  const check = async () => (await Promise.all([
    waitForUrlResponse(page, () => overview, 'GET'), button.click(),
  ]))[0]
  await probe(adminOrigin.origin + legacy, adminCookieName, siteCookie.value, 401)
  await probe(siteOrigin.origin + legacy, adminCookieName, priorCookie.value, 404)
  assert.equal((await context.request.get(adminOrigin.origin + legacy + '/nested')).status(), 404)
  assert.equal((await context.request.get(adminOrigin.origin + '/api/binary/system/page/about')).status(), 404)
  assert.equal((await context.request.put(adminOrigin.origin + legacy)).status(), 404)
  assert.equal((await context.request.get(adminOrigin.origin + legacy)).status(), 403)
  assert.equal((await context.request.get(overview)).status(), 403)
  await section.waitFor({ state: 'detached' })

  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await probe(adminOrigin.origin + legacy, adminCookieName, priorCookie.value, 401)
  await probe(overview, adminCookieName, priorCookie.value, 401)
  await page.reload()
  await logIn(page)
  await visitAdminWorkspace(page, '/admin/site')
  await cluster.granted()
  if (risk) {
    await openRiskControls()
    await risk.granted()
    if (process.env.FSUSBLOG_TEST_ADMIN_RISK_CASE === 'root-pow-policy')
      await verifyRootCommentPowPolicy({ page, context, adminOrigin, siteOrigin, evidence })
    await visitAdminWorkspace(page, '/admin/site')
  }
  const allowed = await check()
  assert.equal(allowed.status(), 200)
  assert.match(allowed.headers()['cache-control'], /no-store/)
  const overviewFrame = decodeFrame(await allowed.body(), FrameType.AdminSitePages)
  assert.equal(overviewFrame.payload.length, 4)
  assert.equal(new DataView(overviewFrame.payload.buffer, overviewFrame.payload.byteOffset, 4).getInt32(0, true), 15)
  assert.equal(await section.getByText('Configured', { exact: true }).count(), 4)
  const editor = process.env.FSUSBLOG_TEST_ADMIN_SITE_PAGE_EDITOR === '1'
  assert.equal(allowed.headers()[WireHeaders.AdminSitePageEditor.toLowerCase()], editor ? '1' : undefined)
  let displayed
  if (!editor) {
    await exactButton(section, 'View about content').click()
    displayed = section.getByLabel('about Markdown')
    await displayed.waitFor()
    assert.match(await displayed.textContent(), /# Verified about\n\n<script>literal<\/script>/)
    assert.equal(await section.locator('script').count(), 0)
  }

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
  if (editor) await verifyEditor({ page, section, context, adminOrigin, siteOrigin, adminCookieName, grantCookie, probe, legacy, evidence })
  else assert.equal(await exactButton(section, 'Edit about content').count(), 0)
  const revokeAndObserve = async () => {
    await visitAdminWorkspace(page, '/admin/site')
    await promisify(execFile)(revoke, [], { timeout: 8_000 })
    await probe(adminOrigin.origin + legacy, adminCookieName, grantCookie.value, 401)
    const revision = adminOrigin.origin + WireRoutes.AdminSitePageRevision.replace('{slug}', 'about')
    await probe(revision, adminCookieName, grantCookie.value, editor ? 401 : 404)
    assert.equal((await check()).status(), 401)
  }
  if (risk) {
    await openRiskControls()
    // A new Interaction mount independently revalidates the same authority and observation.
    await risk.granted()
    // The retained reply must not resurrect Risk controls after navigation and Site observes revocation.
    await risk.duringRevocation(grantCookie, revokeAndObserve)
    assert.equal(new URL(page.url()).pathname, '/admin/site')
  }
  else await revokeAndObserve()
  if (displayed) await displayed.waitFor({ state: 'hidden' })
  await cluster.cleared(grantCookie)
  await logIn(page)
  assert.equal((await context.request.get(overview)).status(), 403)
  await section.waitFor({ state: 'detached' })
  await visitAdminWorkspace(page, '/admin/site')
  await cluster.denied()
  return await readCookie(context, adminOrigin.origin + WireRoutes.AdminSession, adminCookieName)
}

async function verifyEditor({ page, section, context, adminOrigin, siteOrigin, adminCookieName, grantCookie, probe, legacy, evidence }) {
  const html = siteOrigin.origin + '/about'
  const binary = siteOrigin.origin + '/api/binary/system/page/about'
  const admin = path => adminOrigin.origin + path
  const getRevision = admin(WireRoutes.AdminSitePageRevision.replace('{slug}', 'about'))
  const before = await context.request.get(getRevision)
  assert.equal(before.status(), 200)
  const old = decodeAdminSitePageRevision(decodeFrame(await before.body(), FrameType.AdminSitePageRevision).payload)
  assert.equal(old.revision, 0n)
  assert.match(old.digest, /^[a-z0-9]{64}$/)
  const fixtures = await Promise.all([html, binary].map(async path => {
    const response = await context.request.get(path)
    assert.equal(response.status(), 200)
    const tag = response.headers().etag
    assert.match(tag, /^"[a-f0-9]{64}"$/)
    const cached = await context.request.get(path, { headers: { 'If-None-Match': tag } })
    assert.equal(cached.status(), 304)
    assert.equal(await cached.body().then(body => body.length), 0)
    return { path, tag }
  }))
  assert.notEqual(fixtures[0].tag, fixtures[1].tag)
  await probe(siteOrigin.origin + WireRoutes.AdminSitePageRevision.replace('{slug}', 'about'), adminCookieName, grantCookie.value, 404)

  const markdown = '# Published by authorized editor\n\n<script data-page-fixture>literal</script>\n\n[unsafe](javascript:alert%281%29)\n'
  const edit = { slug: 'about', expectedRevision: old.revision, expectedDigest: old.digest, markdown }
  const frame = input => Buffer.from(encodeFrame(FrameType.AdminSitePagePublish, encodeAdminSitePagePublish(input)))
  const submit = (path, input, headers = {}) => context.request.post(admin(path), {
    headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream', ...headers }, data: frame(input)
  })
  const legacyTag = (await context.request.get(admin(legacy))).headers().etag
  assert.equal(legacyTag, `"about.${old.revision}.${old.digest}"`)
  const legacyFrameFor = (input) => {
    const markdown = Buffer.from(input.markdown)
    const pod = Buffer.alloc(140 + markdown.length)
    pod.write(input.slug)
    pod.writeUInt32LE(markdown.length, 132)
    pod.writeUInt32LE(markdown.length, 136)
    markdown.copy(pod, 140)
    return Buffer.from(encodeFrame(36, pod))
  }
  const legacyWrite = (input, { headers = {}, tag = legacyTag, target = adminOrigin.origin, data = legacyFrameFor(input) } = {}) =>
    context.request.put(target + WireRoutes.AdminLegacySitePageUpdate, {
      headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream', ...(tag ? { 'If-Match': tag } : {}), ...headers },
      data,
    })
  const legacyRefusals = await Promise.all([
    legacyWrite(edit, { target: siteOrigin.origin }),
    legacyWrite(edit, { headers: { Origin: siteOrigin.origin } }),
    legacyWrite(edit, { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
    legacyWrite(edit, { tag: '' }),
    legacyWrite(edit, { tag: `W/${legacyTag}` }),
    legacyWrite(edit, { data: frame(edit) }),
    legacyWrite(edit),
  ])
  assert.deepEqual(legacyRefusals.map(r => r.status()), [404, 403, 403, 428, 400, 400, 403])
  assert.equal((await submit(WireRoutes.AdminSitePagePublish, edit)).status(), 403)
  assert.equal((await submit(WireRoutes.AdminSitePageStepUpBegin, edit, { Origin: siteOrigin.origin })).status(), 403)
  assert.equal((await submit(WireRoutes.AdminSitePageStepUpBegin, { ...edit, slug: 'elsewhere' })).status(), 400)

  let observed = []
  const commandPath = admin(WireRoutes.AdminSitePagePublish)
  const intercept = async route => {
    const request = route.request()
    const headers = await request.allHeaders()
    const collected = {
      [WireHeaders.MfaProof]: headers[WireHeaders.MfaProof.toLowerCase()],
      [WireHeaders.PowProof]: headers[WireHeaders.PowProof.toLowerCase()],
    }
    const tampered = await legacyWrite({ ...edit, markdown: '# Changed intent' }, { headers: collected })
    const badPow = await legacyWrite(edit, { headers: { ...collected, [WireHeaders.PowProof]: 'invalid' } })
    const attempts = await Promise.all([legacyWrite(edit, { headers: collected }), legacyWrite(edit, { headers: collected })])
    const legacyStatuses = attempts.map(response => response.status()).sort((left, right) => left - right)
    const published = attempts.find(response => response.status() === 200) ?? attempts[0]
    if (published.status() === 200) {
      assert.deepEqual(Array.from(decodeFrame(await published.body(), FrameType.EmptySuccess).payload), [1, 0, 0, 0])
    }
    const v2Replay = await submit(WireRoutes.AdminSitePagePublish, edit, collected)
    observed = [tampered.status(), badPow.status(), ...legacyStatuses, v2Replay.status()]
    await route.fulfill({ response: published })
  }
  await page.route(commandPath, intercept)
  await exactButton(section, 'Edit about content').click()
  const textarea = section.getByRole('textbox', { name: 'about Markdown editor' })
  await textarea.fill(markdown)
  const publish = section.getByRole('button', { name: 'Publish with Passkey' })
  assert(await publish.isDisabled())
  await section.getByText('Replace the public /about page', { exact: true }).click()
  assert(await section.getByRole('checkbox', { name: 'Replace the public /about page' }).isChecked())
  await publish.click()
  await section.getByText('Published /about', { exact: true }).waitFor({ timeout: 18_000 })
  await page.unroute(commandPath, intercept)
  assert.deepEqual(observed, [403, 400, 200, 412, 409])
  for (const { path, tag } of fixtures) {
    const current = await context.request.get(path, { headers: { 'If-None-Match': tag } })
    assert.equal(current.status(), 200)
    assert.notEqual(current.headers().etag, tag)
    assert.match(current.headers()['cache-control'], /no-store/)
    const date = await context.request.get(path, { headers: { 'If-Modified-Since': new Date(Date.now() + 1000).toUTCString() } })
    assert.equal(date.status(), 200)
    assert.deepEqual(await date.body(), await current.body())
    const fresh = await context.request.head(path, { headers: { 'If-None-Match': current.headers().etag } })
    assert.equal(fresh.status(), 304)
  }
  const snapshot = await context.request.get(getRevision)
  const revised = decodeAdminSitePageRevision(decodeFrame(await snapshot.body(), FrameType.AdminSitePageRevision).payload)
  assert.equal(revised.revision, 1n)
  assert.equal(revised.markdown, markdown)
  const publicFrame = await context.request.get(binary)
  const legacyFrame = await context.request.get(admin(legacy))
  assert.equal(legacyFrame.headers().etag, `"about.${revised.revision}.${revised.digest}"`)
  assert.deepEqual(await legacyFrame.body(), await publicFrame.body())
  assert.equal(decodeSitePage(decodeFrame(await publicFrame.body(), FrameType.PageContent).payload).markdown, markdown)
  const publicPage = await context.newPage()
  await publicPage.goto(html)
  const article = publicPage.locator('[data-site-page-body]')
  await article.getByRole('heading', { name: 'Published by authorized editor' }).waitFor()
  assert.equal(await article.locator('script').count(), 0)
  assert.equal(await article.getByRole('link', { name: 'unsafe' }).getAttribute('href'), '#')
  await publicPage.close()
  assert.equal((await submit(WireRoutes.AdminSitePageStepUpBegin, edit)).status(), 409)
  await writeFile(join(evidence, 'legacy-site-page-result.json'), JSON.stringify({
    legacyFrameType: 36, initialRevision: old.revision.toString(), publishedRevision: revised.revision.toString(),
    wrongSite: 404, wrongOrigin: 403, crossSite: 403, missingTag: 428, weakTag: 400, wrongFrame: 400, missingPasskey: 403,
    tamperedIntent: observed[0], invalidProofOfWork: observed[1], concurrentLegacyWrites: observed.slice(2, 4), v2Replay: observed[4],
  }, null, 2) + '\n')
  await page.screenshot({ path: join(evidence, 'administrator-site-page-published.png') })
}
