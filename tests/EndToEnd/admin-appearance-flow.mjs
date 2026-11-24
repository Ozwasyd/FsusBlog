import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeAppearanceHistory } from '../../src/Contracts/admin-appearance.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import * as adminFx from './admin-workspace-fixture.mjs'
import { saveShot } from './isolated-browser-fixture.mjs'
import { assertFields, assertStatus, readFrame } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireRoutes: R } = wire

export async function verifyAppearanceActivation({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
  priorCookie, revoke, logIn, probe, readCookie, evidence }) {
  await adminFx.visitAdminWorkspace(page, '/admin/site')
  const admin = path => adminOrigin.origin + path, pub = path => siteOrigin.origin + path
  const stateUrl = admin(R.AdminAppearanceState), catalogUrl = admin(R.AdminAppearanceCatalog)
  const historyUrl = admin(R.AdminAppearanceHistory), applyUrl = admin(R.AdminAppearanceApply)
  const alias = '/site-appearance/current.css'
  const legacyFont = process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE_FSFONT === '1'
  const legacyTheme = process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE_FSTHEME === '1'
  const legacyThemeDigest = legacyTheme ? process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE_FSTHEME_SHA256 : undefined
  if (legacyTheme) assert.match(legacyThemeDigest, /^[a-f0-9]{64}$/)
  const fontName = legacyFont ? 'fsusblog.font.fixture' : 'fixture.font'
  const fontDetailPath = digest => R.AdminAppearanceFontDetail + `?digest=${digest}`
  const fixtureRoot = process.env.FSUSBLOG_APPEARANCE_ROOT
  const registry = legacyFont ? JSON.parse(await readFile(join(fixtureRoot, 'appearance.json'), 'utf8')) : null
  const legacyFontDigest = registry?.Packages.find(entry => entry.Format === 'fsfont-v1')?.ArchiveSha256
  const fontDetailUrl = legacyFontDigest && admin(fontDetailPath(legacyFontDigest))
  const section = loc.exactRegion(page, 'Site appearance')
  const check = () => loc.exactButton(section, 'Check active appearance').click()
  assert.equal(await page.locator('link[href^="/site-appearance/"]').count(), 0)
  for (const url of [stateUrl, catalogUrl, historyUrl]) await probe(url, adminCookieName, siteCookie.value, 401)
  if (legacyFont) {
    assert.match(legacyFontDigest, /^[a-f0-9]{64}$/)
    for (const token of ['', siteCookie.value]) await probe(fontDetailUrl, adminCookieName, token, 401)
    await probe(pub(fontDetailPath(legacyFontDigest)), adminCookieName, priorCookie.value, 404)
  }
  for (const url of [pub(R.AdminAppearanceState), pub(R.AdminAppearanceHistory), admin(alias)])
    await probe(url, adminCookieName, priorCookie.value, 404)
  await check()
  await section.getByText(`Active theme: fixture.theme · Active font: ${fontName}`).waitFor()
  if (fontDetailUrl) {
    const themeDigest = registry.Sources.find(entry => entry.Reference === 'approved-source/theme').ArchiveSha256
    await verifyFontDetails({ page, section, context, fontDetailUrl, fontName, legacyFontDigest, themeDigest,
      detailUrl: digest => admin(fontDetailPath(digest)), fixtureRoot })
  }
  const history = loc.exactRegion(section, 'Appearance history')
  const checkHistory = () => loc.exactButton(section, 'Check appearance history').click()
  await checkHistory()
  await loc.exactText(history, 'No appearance changes recorded.').waitFor()

  const sites = await context.newPage()
  const siteErrors = []
  sites.on('pageerror', error => siteErrors.push(error.message))
  await sites.emulateMedia({ colorScheme: 'light' })
  const current = async (revision, accent) => {
    const redirect = await context.request.get(pub(alias), { maxRedirects: 0 })
    assertStatus(redirect, 302)
    assert.equal(redirect.headers()['cache-control'], 'no-store')
    const css = redirect.headers().location
    assert.match(css, new RegExp(`^/site-appearance/${revision}/[a-f0-9]{64}\\.css$`))
    const styles = await context.request.get(pub(css))
    assertStatus(styles, 200)
    assert.deepEqual([styles.headers()['cross-origin-resource-policy'], styles.headers()['cache-control']], ['same-origin', 'no-store'])
    assert.match(styles.headers()['content-type'], /^text\/css/)
    const cssText = await styles.text()
    if (legacyFont) assert(cssText.includes(';unicode-range:U+0000-00FF}'))
    assert.equal(adminFx.sha256Hex(cssText), css.split('/').at(-1).slice(0, -4))
    const font = cssText.match(/\/site-appearance\/font\/\d+\/[a-f0-9]{64}\.woff2/)?.[0]
    assert(font)
    const fontBytes = await context.request.get(pub(font))
    assertStatus(fontBytes, 200)
    assert.equal(fontBytes.headers()['cache-control'], 'no-store')
    assert.equal(adminFx.sha256Hex(await fontBytes.body()), font.split('/').at(-1).slice(0, -6))
    assertStatus(await context.request.get(pub(css), { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 404)
    assertStatus(await context.request.get(pub(font), { headers: { Origin: adminOrigin.origin } }), 404)
    await sites.goto(pub('/'))
    assert.equal(await sites.locator('link[href="/site-appearance/current.css"]').count(), 1)
    await sites.waitForFunction(expected => getComputedStyle(document.documentElement)
      .getPropertyValue('--fsus-color-action-primary').trim() === expected, accent)
    assert.equal(await sites.evaluate(async () => {
      await document.fonts.load('16px FsusBlogSiteFont', 'A')
      return [...document.fonts].some(font => font.family === 'FsusBlogSiteFont' && font.status === 'loaded')
    }), true)
    return { css, font }
  }

  const initial = await current(0, '#225533')
  const cookie = await readCookie(context, stateUrl, adminCookieName)
  const state = await readFrame(await context.request.get(stateUrl), FrameType.AdminAppearanceState, wire.decodeAdminAppearanceState)
  const rejectedFrame = adminFx.packFrame(FrameType.AdminAppearanceCommand, wire.encodeAdminAppearanceCommand({
    expectedRevision: state.revision, currentTheme: state.theme, currentFont: state.font, theme: '0'.repeat(64), font: state.font, rollback: false,
  }))
  const submit = (data, headers = {}) => adminFx.postBinary(context.request, applyUrl, adminOrigin.origin, data, headers)
  assertStatus(await submit(rejectedFrame), 400)
  assertStatus(await submit(rejectedFrame, { Origin: siteOrigin.origin }), 403)

  await adminFx.selectOption(page, section, 'Theme', legacyThemeDigest ? 'fsusblog.theme.fixture 1.0.0' : 'fixture.alternate 1.0')
  let observations = []
  const intercept = async route => {
    const request = route.request(), frame = request.postDataBuffer(), captured = await request.allHeaders()
    const headers = { [WireHeaders.MfaProof]: captured[WireHeaders.MfaProof.toLowerCase()], [WireHeaders.PowProof]: captured[WireHeaders.PowProof.toLowerCase()] }
    const refused = await submit(frame, { ...headers, [WireHeaders.MfaProof]: 'A'.repeat(43) })
    const deniedWork = await submit(frame, { ...headers, [WireHeaders.PowProof]: 'invalid' })
    const attempts = await Promise.all([route.fetch(), submit(frame, headers)])
    observations = [refused.status(), deniedWork.status(), ...attempts.map(item => item.status()).sort((a, b) => a - b)]
    await route.fulfill({ response: attempts.find(item => item.status() === 200) ?? attempts[0] })
  }
  await page.route(applyUrl, intercept)
  await section.getByRole('button', { name: 'Apply appearance with Passkey' }).click()
  await loc.exactText(section, 'Appearance applied.').waitFor({ timeout: 18_000 })
  await page.unroute(applyUrl, intercept)
  assert.deepEqual(observations, [403, 400, 200, 409])
  const alternate = await current(1, '#663322')
  if (legacyThemeDigest) {
    assert.equal((await readFrame(await context.request.get(stateUrl), FrameType.AdminAppearanceState, wire.decodeAdminAppearanceState)).theme, legacyThemeDigest)
    const readTokens = (accent, hover) => sites.waitForFunction(([primary, alternate]) => {
      const root = getComputedStyle(document.documentElement)
      return root.getPropertyValue('--fsus-color-action-primary').trim() === primary &&
        root.getPropertyValue('--fsus-color-action-primary-hover').trim() === alternate
    }, [accent, hover])
    await readTokens('#663322', '#774433')
    const skipLink = loc.exactLink(sites, 'Skip to content')
    await skipLink.waitFor({ state: 'attached' })
    await sites.keyboard.press('Tab')
    const focusedSkipLink = () => skipLink.evaluate(element => {
      const style = getComputedStyle(element)
      return { focused: element.matches(':focus-visible'), ring: style.boxShadow, text: style.color, surface: style.backgroundColor }
    })
    assert.deepEqual(await focusedSkipLink(), {
      focused: true, ring: 'rgb(102, 51, 34) 0px 0px 0px 2px inset', text: 'rgb(15, 15, 17)', surface: 'rgb(255, 255, 255)',
    })
    assert.equal(new URL(sites.url()).origin, siteOrigin.origin)
    await saveShot(sites, evidence, 'appearance-public-light.png', {})
    await sites.emulateMedia({ colorScheme: 'dark' })
    await readTokens('#eecc99', '#ffddcc')
    assert.deepEqual(await focusedSkipLink(), {
      focused: true, ring: 'rgb(238, 204, 153) 0px 0px 0px 2px inset', text: 'rgb(240, 240, 244)', surface: 'rgb(18, 18, 20)',
    })
    await saveShot(sites, evidence, 'appearance-public-dark.png', {})
    await sites.emulateMedia({ colorScheme: 'light' })
  }
  for (const path of Object.values(initial)) assertStatus(await context.request.get(pub(path)), 404)
  await section.getByRole('button', { name: `Restore fixture.theme / ${fontName} with Passkey` }).click()
  await loc.exactText(section, 'Previous appearance restored.').waitFor()
  const restored = await current(2, '#225533')
  for (const path of [...Object.values(initial), ...Object.values(alternate)]) assertStatus(await context.request.get(pub(path)), 404)

  const readHistory = async (path, beforeRevision) => {
    const response = await context.request.get(historyUrl + path)
    assert.equal(response.headers()['cache-control'], 'no-store')
    const payload = await readFrame(response, FrameType.AdminAppearanceHistory)
    const decoded = decodeAppearanceHistory(payload, beforeRevision, 1)
    if (decoded.nextBefore !== null) {
      const invalidCursor = Buffer.from(payload)
      invalidCursor.writeBigInt64LE(decoded.nextBefore + 1n)
      assert.throws(() => decodeAppearanceHistory(invalidCursor, beforeRevision, 1), /Invalid next appearance history revision/)
    }
    return decoded
  }
  const latest = await readHistory('?limit=1')
  assert.equal(latest.nextBefore, 2n)
  const earlier = await readHistory('?before=2&limit=1', latest.nextBefore)
  assert.equal(earlier.nextBefore, null)
  assert.deepEqual(await readHistory('?before=1&limit=1', 1n), { nextBefore: null, items: [] })
  const [rollback] = latest.items, [applied] = earlier.items
  assert.deepEqual([rollback.revision, rollback.actor, rollback.rollback, rollback.previousTheme, rollback.theme],
    [2n, 'tls-admin-fixture', true, applied.theme, applied.previousTheme])
  assert.deepEqual([applied.revision, applied.actor, applied.rollback, applied.previousTheme], [1n, 'tls-admin-fixture', false, state.theme])
  if (legacyThemeDigest) assert.equal(applied.theme, legacyThemeDigest)
  assert.deepEqual([applied.previousFont, applied.font, rollback.previousFont, rollback.font], Array(4).fill(state.font))
  for (const query of ['?before=02', '?before=1&before=2', '?before=9223372036854775808', '?before=0', '?limit=0', '?limit=51', '?scope=public'])
    assertStatus(await context.request.get(historyUrl + query), 400)
  await checkHistory()
  await loc.exactText(history, 'Rolled back · revision 2').waitFor()
  await loc.exactText(history, 'Applied · revision 1').waitFor()
  await loc.exactHeading(history, 'Appearance history').and(page.locator(':focus-within')).waitFor()

  await writeFile(join(evidence, 'appearance-rollback-url.txt'), restored.css)
  assert.deepEqual(siteErrors, [])
  await saveShot(page, evidence, 'administrator-appearance.png', {})
  await sites.close()
  await adminFx.runFixtureCommand(revoke)
  for (const url of [stateUrl, historyUrl, ...(fontDetailUrl ? [fontDetailUrl] : [])]) await probe(url, adminCookieName, cookie.value, 401)
  await check()
  await loc.exactButton(page, 'Log in as administrator').waitFor()
  await logIn(page)
  for (const url of [stateUrl, catalogUrl, historyUrl, ...(fontDetailUrl ? [fontDetailUrl] : [])]) assertStatus(await context.request.get(url), 200)
  return readCookie(context, stateUrl, adminCookieName)
}

async function verifyFontDetails({ page, section, context, fontDetailUrl, fontName, legacyFontDigest, themeDigest, detailUrl, fixtureRoot }) {
  const fontSource = new URL('../../src/Web/node_modules/@fontsource/google-sans/', import.meta.url)
  const [archive, face, licenseText] = await Promise.all([
    readFile(join(fixtureRoot, legacyFontDigest + '.fsfont')),
    readFile(new URL('files/google-sans-latin-400-normal.woff2', fontSource)),
    readFile(new URL('LICENSE', fontSource), 'utf8'),
  ])
  assert.equal(adminFx.sha256Hex(archive), legacyFontDigest)
  for (const [digest, code] of [['0'.repeat(64), 404], [themeDigest, 404], ['A'.repeat(64), 400]])
    assertStatus(await context.request.get(detailUrl(digest)), code)

  await adminFx.selectOption(page, section, 'Font', `${fontName} 1.0.0`)
  const response = await adminFx.clickForResponse(page, fontDetailUrl, loc.exactButton(section, 'Font details'))
  assert.equal(response.headers()['cache-control'], 'no-store')
  const detail = await readFrame(response, FrameType.AdminAppearanceFontDetail, wire.decodeAdminAppearanceFontDetail)
  const expected = {
    id: fontName, version: '1.0.0', archiveDigest: legacyFontDigest, name: 'Fixture Sans', family: 'Fixture Sans',
    licenseName: 'OFL-1.1', licenseText, faceWeight: 400, faceStyle: 'normal', faceDigest: adminFx.sha256Hex(face),
    faceBytes: face.byteLength, unicodeRange: 'U+0000-00FF', sourceKind: 'npm-fontsource',
    sourcePackage: '@fontsource/google-sans', sourceVersion: '5.2.1', sourceUpstream: 'Google Fonts',
  }
  assertFields(detail, expected)

  const panel = section.locator('section[aria-labelledby="admin-font-details"]')
  await loc.exactHeading(panel, 'Font details').waitFor()
  assert.equal(await panel.locator('pre').textContent(), licenseText)
  const displayed = await panel.textContent()
  for (const value of [expected.family, expected.licenseName, expected.unicodeRange, expected.sourcePackage, expected.sourceUpstream])
    assert(displayed.includes(value), `Font detail panel should display ${value}`)
}
