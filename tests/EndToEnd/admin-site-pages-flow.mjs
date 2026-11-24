import assert from 'node:assert/strict'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSitePage } from '../../src/Contracts/site-pages.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { adminClusterFlow } from './admin-cluster-flow.mjs'
import { adminRiskReadinessFlow, verifyRootCommentPowPolicy } from './admin-risk-readiness-flow.mjs'
import * as adminFx from './admin-workspace-fixture.mjs'
import { saveShot, writeEvidenceJson } from './isolated-browser-fixture.mjs'
import { assertNoStore, assertStatus, readFrame } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireRoutes: R } = wire

export async function verifyAdminSitePages({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
  priorCookie, revoke, logIn, probe, readCookie, evidence }) {
  const adminBase = adminOrigin.origin, siteBase = siteOrigin.origin
  const cluster = adminClusterFlow({ page, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie, probe, evidence })
  const riskFixture = process.env.FSUSBLOG_TEST_ADMIN_RISK_EXPECTED
  const risk = riskFixture ? adminRiskReadinessFlow({ page, context, adminOrigin, siteOrigin, adminCookieName,
    siteCookie, priorCookie, probe, evidence, expected: JSON.parse(riskFixture) }) : null
  const openRiskControls = async () => {
    await adminFx.visitAdminWorkspace(page, '/admin/interaction')
    await loc.exactTab(page, 'Risk controls').click()
  }
  await adminFx.visitAdminWorkspace(page, '/admin/site')
  await cluster.verifyIsolation()
  if (risk) await risk.verifyIsolation()
  const legacy = '/api/binary/system/admin/page/about'
  const overview = adminBase + R.AdminSitePages
  const detail = R.AdminSitePage.replace('{slug}', 'about')
  const section = loc.exactRegion(page, 'Site pages')
  const check = () => adminFx.clickForResponse(page, overview, loc.exactButton(section, 'Refresh'))
  await probe(adminBase + legacy, adminCookieName, siteCookie.value, 401)
  await probe(siteBase + legacy, adminCookieName, priorCookie.value, 404)
  for (const url of [adminBase + legacy + '/nested', adminBase + '/api/binary/system/page/about'])
    assertStatus(await context.request.get(url), 404)
  assertStatus(await context.request.put(adminBase + legacy), 404)
  await probe(overview, adminCookieName, siteCookie.value, 401)
  await cluster.verifyAvailable()
  if (risk) {
    await openRiskControls()
    await risk.verifyAvailable()
    if (process.env.FSUSBLOG_TEST_ADMIN_RISK_CASE === 'root-pow-policy')
      await verifyRootCommentPowPolicy({ page, context, adminOrigin, siteOrigin, evidence })
    await adminFx.visitAdminWorkspace(page, '/admin/site')
  }
  const allowed = await check()
  await assertNoStore(allowed)
  const overviewPayload = await readFrame(allowed, FrameType.AdminSitePages)
  assert.equal(overviewPayload.length, 4)
  assert.equal(new DataView(overviewPayload.buffer, overviewPayload.byteOffset, 4).getInt32(0, true), 15)
  assert.equal(await loc.exactText(section, 'Configured').count(), 4)
  const editor = process.env.FSUSBLOG_TEST_ADMIN_SITE_PAGE_EDITOR === '1'
  assert.equal(allowed.headers()[WireHeaders.AdminSitePageEditor.toLowerCase()], editor ? '1' : undefined)
  let displayed
  if (!editor) {
    await loc.exactButton(section, 'View about content').click()
    displayed = section.getByLabel('about Markdown')
    await displayed.waitFor()
    assert.match(await displayed.textContent(), /# Verified about\n\n<script>literal<\/script>/)
    assert.equal(await section.locator('script').count(), 0)
  }

  const responses = await Promise.all([adminBase + legacy, adminBase + detail,
    siteBase + '/api/binary/system/page/about'].map(url => context.request.get(url)))
  for (const response of responses) { assertStatus(response, 200); await assertNoStore(response) }
  const [exact, versionedBody, publicBody] = await Promise.all(responses.map(r => r.body()))
  assert.deepEqual(versionedBody, exact)
  assert.deepEqual(publicBody, exact)
  assert.deepEqual(decodeSitePage(decodeFrame(exact, FrameType.PageContent).payload),
    { slug: 'about', markdown: '# Verified about\n\n<script>literal</script>\n' })
  assertStatus(await context.request.get(adminBase + '/api/binary/system/admin/page/unknown'), 404)
  await saveShot(page, evidence, 'administrator-site-page.png', {})

  const sessionCookie = await readCookie(context, adminBase + detail, adminCookieName)
  if (editor) await verifyEditor({ page, section, context, adminBase, siteBase, adminCookieName, sessionCookie, probe, legacy, evidence })
  else assert.equal(await loc.exactButton(section, 'Edit about content').count(), 0)
  const revokeAndObserve = async () => {
    await adminFx.visitAdminWorkspace(page, '/admin/site')
    await adminFx.runFixtureCommand(revoke)
    await probe(adminBase + legacy, adminCookieName, sessionCookie.value, 401)
    await probe(adminBase + R.AdminSitePageRevision.replace('{slug}', 'about'), adminCookieName, sessionCookie.value, editor ? 401 : 404)
    assertStatus(await check(), 401)
  }
  if (risk) {
    await openRiskControls()
    // The new Interaction mount fetches a fresh observation before revocation.
    await risk.waitForObservation()
    // The retained reply must not resurrect Risk controls after navigation and Site observes revocation.
    await risk.duringRevocation(sessionCookie, revokeAndObserve)
    assert.equal(new URL(page.url()).pathname, '/admin/site')
  } else await revokeAndObserve()
  if (displayed) await displayed.waitFor({ state: 'hidden' })
  await cluster.cleared(sessionCookie)
  await logIn(page)
  assertStatus(await context.request.get(overview), 200)
  return readCookie(context, adminBase + R.AdminSession, adminCookieName)
}

async function verifyEditor({ page, section, context, adminBase, siteBase, adminCookieName, sessionCookie, probe, legacy, evidence }) {
  const html = siteBase + '/about', binary = siteBase + '/api/binary/system/page/about'
  const admin = path => adminBase + path
  const getRevision = admin(R.AdminSitePageRevision.replace('{slug}', 'about'))
  const old = await readFrame(await context.request.get(getRevision), FrameType.AdminSitePageRevision, wire.decodeAdminSitePageRevision)
  assert.equal(old.revision, 0n)
  assert.match(old.digest, /^[a-z0-9]{64}$/)
  const fixtures = await Promise.all([html, binary].map(async path => {
    const response = await context.request.get(path)
    assertStatus(response, 200)
    const tag = response.headers().etag
    assert.match(tag, /^"[a-f0-9]{64}"$/)
    const cached = await context.request.get(path, { headers: { 'If-None-Match': tag } })
    assertStatus(cached, 304)
    assert.equal((await cached.body()).length, 0)
    return { path, tag }
  }))
  assert.notEqual(fixtures[0].tag, fixtures[1].tag)
  await probe(siteBase + R.AdminSitePageRevision.replace('{slug}', 'about'), adminCookieName, sessionCookie.value, 404)

  const markdown = '# Published by authorized editor\n\n<script data-page-fixture>literal</script>\n\n[unsafe](javascript:alert%281%29)\n'
  const edit = { slug: 'about', expectedRevision: old.revision, expectedDigest: old.digest, markdown }
  const frame = input => adminFx.packFrame(FrameType.AdminSitePagePublish, wire.encodeAdminSitePagePublish(input))
  const submit = (path, input, headers = {}) => adminFx.postBinary(context.request, admin(path), adminBase, frame(input), headers)
  const legacyTag = (await context.request.get(admin(legacy))).headers().etag
  assert.equal(legacyTag, `"about.${old.revision}.${old.digest}"`)
  const legacyFrameFor = input => {
    const content = Buffer.from(input.markdown), pod = Buffer.alloc(140 + content.length)
    pod.write(input.slug)
    pod.writeUInt32LE(content.length, 132)
    pod.writeUInt32LE(content.length, 136)
    content.copy(pod, 140)
    return Buffer.from(encodeFrame(36, pod))
  }
  const legacyWrite = (input, { headers = {}, tag = legacyTag, target = adminBase, data = legacyFrameFor(input) } = {}) =>
    context.request.put(target + R.AdminLegacySitePageUpdate, {
      headers: { Origin: adminBase, 'Content-Type': 'application/octet-stream', ...(tag ? { 'If-Match': tag } : {}), ...headers }, data,
    })
  const legacyRefusals = await Promise.all([
    legacyWrite(edit, { target: siteBase }), legacyWrite(edit, { headers: { Origin: siteBase } }),
    legacyWrite(edit, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), legacyWrite(edit, { tag: '' }),
    legacyWrite(edit, { tag: `W/${legacyTag}` }), legacyWrite(edit, { data: frame(edit) }), legacyWrite(edit),
  ])
  assert.deepEqual(legacyRefusals.map(r => r.status()), [404, 403, 403, 428, 400, 400, 403])
  assertStatus(await submit(R.AdminSitePagePublish, edit), 403)
  assertStatus(await submit(R.AdminSitePageStepUpBegin, edit, { Origin: siteBase }), 403)
  assertStatus(await submit(R.AdminSitePageStepUpBegin, { ...edit, slug: 'elsewhere' }), 400)

  let observed = []
  const commandPath = admin(R.AdminSitePagePublish)
  const intercept = async route => {
    const headers = await route.request().allHeaders()
    const collected = { [WireHeaders.MfaProof]: headers[WireHeaders.MfaProof.toLowerCase()], [WireHeaders.PowProof]: headers[WireHeaders.PowProof.toLowerCase()] }
    const tampered = await legacyWrite({ ...edit, markdown: '# Changed intent' }, { headers: collected })
    const badPow = await legacyWrite(edit, { headers: { ...collected, [WireHeaders.PowProof]: 'invalid' } })
    const attempts = await Promise.all([legacyWrite(edit, { headers: collected }), legacyWrite(edit, { headers: collected })])
    const legacyStatuses = attempts.map(response => response.status()).sort((left, right) => left - right)
    const published = attempts.find(response => response.status() === 200) ?? attempts[0]
    if (published.status() === 200) assert.deepEqual(Array.from(decodeFrame(await published.body(), FrameType.EmptySuccess).payload), [1, 0, 0, 0])
    const v2Replay = await submit(R.AdminSitePagePublish, edit, collected)
    observed = [tampered.status(), badPow.status(), ...legacyStatuses, v2Replay.status()]
    await route.fulfill({ response: published })
  }
  await page.route(commandPath, intercept)
  await loc.exactButton(section, 'Edit about content').click()
  await section.getByRole('textbox', { name: 'about Markdown editor' }).fill(markdown)
  const publish = section.getByRole('button', { name: 'Publish with Passkey' })
  assert(await publish.isDisabled())
  await adminFx.checkLabeledCheckbox(section, 'Replace the public /about page')
  await publish.click()
  await loc.exactText(section, 'Published /about').waitFor({ timeout: 18_000 })
  await page.unroute(commandPath, intercept)
  assert.deepEqual(observed, [403, 400, 200, 412, 409])
  for (const { path, tag } of fixtures) {
    const current = await context.request.get(path, { headers: { 'If-None-Match': tag } })
    assertStatus(current, 200)
    assert.notEqual(current.headers().etag, tag)
    await assertNoStore(current)
    const date = await context.request.get(path, { headers: { 'If-Modified-Since': new Date(Date.now() + 1000).toUTCString() } })
    assertStatus(date, 200)
    assert.deepEqual(await date.body(), await current.body())
    assertStatus(await context.request.head(path, { headers: { 'If-None-Match': current.headers().etag } }), 304)
  }
  const revised = await readFrame(await context.request.get(getRevision), FrameType.AdminSitePageRevision, wire.decodeAdminSitePageRevision)
  assert.equal(revised.revision, 1n)
  assert.equal(revised.markdown, markdown)
  const publicFrame = await context.request.get(binary), legacyFrame = await context.request.get(admin(legacy))
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
  assertStatus(await submit(R.AdminSitePageStepUpBegin, edit), 409)
  await writeEvidenceJson(evidence, 'legacy-site-page-result.json', {
    legacyFrameType: 36, initialRevision: old.revision.toString(), publishedRevision: revised.revision.toString(),
    wrongSite: 404, wrongOrigin: 403, crossSite: 403, missingTag: 428, weakTag: 400, wrongFrame: 400, missingPasskey: 403,
    tamperedIntent: observed[0], invalidProofOfWork: observed[1], concurrentLegacyWrites: observed.slice(2, 4), v2Replay: observed[4],
  })
  await saveShot(page, evidence, 'administrator-site-page-published.png', {})
}
