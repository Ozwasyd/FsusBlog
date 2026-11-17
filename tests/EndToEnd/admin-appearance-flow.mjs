import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAppearanceHistory } from '../../src/Contracts/admin-appearance.ts'
import { decodeAdminAppearanceFontDetail, decodeAdminAppearanceState, encodeAdminAppearanceCommand,
  FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function verifyAppearanceActivation({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
  priorCookie, grant, revoke, logIn, probe, readCookie, evidence }) {
  const admin = path => adminOrigin.origin + path
  const pub = path => siteOrigin.origin + path
  const stateUrl = admin(WireRoutes.AdminAppearanceState)
  const catalogUrl = admin(WireRoutes.AdminAppearanceCatalog)
  const historyUrl = admin(WireRoutes.AdminAppearanceHistory)
  const applyUrl = admin(WireRoutes.AdminAppearanceApply)
  const alias = '/site-appearance/current.css'
  const legacyFont = process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE_FSFONT === '1'
  const legacyTheme = process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE_FSTHEME === '1'
  const legacyThemeDigest = legacyTheme ? process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE_FSTHEME_SHA256 : undefined
  if (legacyTheme) assert.match(legacyThemeDigest, /^[a-f0-9]{64}$/)
  const fontName = legacyFont ? 'fsusblog.font.fixture' : 'fixture.font'
  const fontDetailPath = digest => WireRoutes.AdminAppearanceFontDetail + `?digest=${digest}`
  const fixtureRoot = process.env.FSUSBLOG_APPEARANCE_ROOT
  const registry = legacyFont ? JSON.parse(await readFile(join(fixtureRoot, 'appearance.json'), 'utf8')) : null
  const legacyFontDigest = registry?.Packages.find(entry => entry.Format === 'fsfont-v1')?.ArchiveSha256
  const fontDetailUrl = legacyFontDigest && admin(fontDetailPath(legacyFontDigest))
  const section = page.getByRole('region', { name: 'Site appearance', exact: true })
  const check = () => section.getByRole('button', { name: 'Check active appearance', exact: true }).click()
  assert.equal(await page.locator('link[href^="/site-appearance/"]').count(), 0)
  await probe(stateUrl, adminCookieName, siteCookie.value, 401)
  await probe(historyUrl, adminCookieName, siteCookie.value, 401)
  if (legacyFont) {
    assert.match(legacyFontDigest, /^[a-f0-9]{64}$/)
    await probe(fontDetailUrl, adminCookieName, '', 401)
    await probe(fontDetailUrl, adminCookieName, siteCookie.value, 401)
    await probe(pub(fontDetailPath(legacyFontDigest)), adminCookieName, priorCookie.value, 404)
    assert.equal((await context.request.get(fontDetailUrl)).status(), 403)
  }
  await probe(pub(WireRoutes.AdminAppearanceState), adminCookieName, priorCookie.value, 404)
  await probe(pub(WireRoutes.AdminAppearanceHistory), adminCookieName, priorCookie.value, 404)
  await probe(admin(alias), adminCookieName, priorCookie.value, 404)
  assert.equal((await context.request.get(stateUrl)).status(), 403)
  assert.equal((await context.request.get(catalogUrl)).status(), 403)
  assert.equal((await context.request.get(historyUrl)).status(), 403)
  await section.waitFor({ state: 'detached' })

  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await probe(stateUrl, adminCookieName, priorCookie.value, 401)
  await page.reload()
  await page.getByRole('button', { name: 'Log in as administrator', exact: true }).waitFor()
  await logIn(page)
  await check()
  await section.getByText(`Active theme: fixture.theme · Active font: ${fontName}`).waitFor()
  if (fontDetailUrl) {
    const themeDigest = registry.Sources.find(entry => entry.Reference === 'approved-source/theme').ArchiveSha256
    await verifyFontDetails({ page, section, context, fontDetailUrl, fontName, legacyFontDigest, themeDigest,
      detailUrl: digest => admin(fontDetailPath(digest)), fixtureRoot })
  }
  const history = section.getByRole('region', { name: 'Appearance history', exact: true })
  const checkHistory = () => section.getByRole('button', { name: 'Check appearance history', exact: true }).click()
  await checkHistory()
  await history.getByText('No appearance changes recorded.', { exact: true }).waitFor()

  const sites = await context.newPage()
  const siteErrors = []
  sites.on('pageerror', error => siteErrors.push(error.message))
  await sites.emulateMedia({ colorScheme: 'light' })
  const current = async (revision, accent) => {
    const redirect = await context.request.get(pub(alias), { maxRedirects: 0 })
    assert.equal(redirect.status(), 302)
    assert.equal(redirect.headers()['cache-control'], 'no-store')
    const css = redirect.headers().location
    assert.match(css, new RegExp(`^/site-appearance/${revision}/[a-f0-9]{64}\\.css$`))
    const styles = await context.request.get(pub(css))
    assert.equal(styles.status(), 200)
    assert.equal(styles.headers()['cross-origin-resource-policy'], 'same-origin')
    assert.equal(styles.headers()['cache-control'], 'no-store')
    assert.match(styles.headers()['content-type'], /^text\/css/)
    const cssText = await styles.text()
    if (legacyFont) assert(cssText.includes(';unicode-range:U+0000-00FF}'))
    assert.equal(createHash('sha256').update(cssText).digest('hex'), css.split('/').at(-1).slice(0, -4))
    const font = cssText.match(/\/site-appearance\/font\/\d+\/[a-f0-9]{64}\.woff2/)?.[0]
    assert(font)
    const fontBytes = await context.request.get(pub(font))
    assert.equal(fontBytes.status(), 200)
    assert.equal(fontBytes.headers()['cache-control'], 'no-store')
    assert.equal(createHash('sha256').update(await fontBytes.body()).digest('hex'), font.split('/').at(-1).slice(0, -6))
    const foreign = await context.request.get(pub(css), { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(foreign.status(), 404)
    assert.equal((await context.request.get(pub(font), { headers: { Origin: adminOrigin.origin } })).status(), 404)
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
  const before = await context.request.get(stateUrl)
  const state = decodeAdminAppearanceState(decodeFrame(await before.body(), FrameType.AdminAppearanceState).payload)
  const rejected = { expectedRevision: state.revision, currentTheme: state.theme, currentFont: state.font,
    theme: '0'.repeat(64), font: state.font, rollback: false }
  const rejectedFrame = Buffer.from(encodeFrame(FrameType.AdminAppearanceCommand, encodeAdminAppearanceCommand(rejected)))
  const submit = (data, headers = {}) => context.request.post(applyUrl, {
    headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream', ...headers }, data,
  })
  assert.equal((await submit(rejectedFrame)).status(), 400)
  assert.equal((await submit(rejectedFrame, { Origin: siteOrigin.origin })).status(), 403)

  const theme = section.getByRole('combobox', { name: 'Theme', exact: true })
  await theme.click()
  await page.getByRole('option', { name: legacyThemeDigest ? 'fsusblog.theme.fixture 1.0.0' : 'fixture.alternate 1.0', exact: true }).click()
  let observations = []
  const intercept = async route => {
    const request = route.request()
    const frame = request.postDataBuffer()
    const captured = await request.allHeaders()
    const headers = {
      [WireHeaders.MfaProof]: captured[WireHeaders.MfaProof.toLowerCase()],
      [WireHeaders.PowProof]: captured[WireHeaders.PowProof.toLowerCase()],
    }
    const refused = await submit(frame, { ...headers, [WireHeaders.MfaProof]: 'A'.repeat(43) })
    const deniedWork = await submit(frame, { ...headers, [WireHeaders.PowProof]: 'invalid' })
    const attempts = await Promise.all([route.fetch(), submit(frame, headers)])
    observations = [refused.status(), deniedWork.status(), ...attempts.map(item => item.status()).sort((a, b) => a - b)]
    await route.fulfill({ response: attempts.find(item => item.status() === 200) ?? attempts[0] })
  }
  await page.route(applyUrl, intercept)
  await section.getByRole('button', { name: 'Apply appearance with Passkey' }).click()
  await section.getByText('Appearance applied.', { exact: true }).waitFor({ timeout: 18_000 })
  await page.unroute(applyUrl, intercept)
  assert.deepEqual(observations, [403, 400, 200, 409])
  const alternate = await current(1, '#663322')
  if (legacyThemeDigest) {
    const activeFrame = await context.request.get(stateUrl)
    const active = decodeAdminAppearanceState(decodeFrame(await activeFrame.body(), FrameType.AdminAppearanceState).payload)
    assert.equal(active.theme, legacyThemeDigest)
    const readTokens = (accent, hover) => sites.waitForFunction(([primary, alternate]) => {
      const root = getComputedStyle(document.documentElement)
      return root.getPropertyValue('--fsus-color-action-primary').trim() === primary &&
        root.getPropertyValue('--fsus-color-action-primary-hover').trim() === alternate
    }, [accent, hover])
    await readTokens('#663322', '#774433')
    const skipLink = sites.getByRole('link', { name: '跳到正文', exact: true })
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
    await sites.screenshot({ path: join(evidence, 'appearance-public-light.png') })
    await sites.emulateMedia({ colorScheme: 'dark' })
    await readTokens('#eecc99', '#ffddcc')
    assert.deepEqual(await focusedSkipLink(), {
      focused: true, ring: 'rgb(238, 204, 153) 0px 0px 0px 2px inset', text: 'rgb(240, 240, 244)', surface: 'rgb(18, 18, 20)',
    })
    await sites.screenshot({ path: join(evidence, 'appearance-public-dark.png') })
    await sites.emulateMedia({ colorScheme: 'light' })
  }
  for (const path of Object.values(initial)) assert.equal((await context.request.get(pub(path))).status(), 404)
  await section.getByRole('button', { name: `Restore fixture.theme / ${fontName} with Passkey` }).click()
  await section.getByText('Previous appearance restored.', { exact: true }).waitFor()
  const restored = await current(2, '#225533')
  for (const path of [...Object.values(initial), ...Object.values(alternate)])
    assert.equal((await context.request.get(pub(path))).status(), 404)

  const readHistory = async (path, beforeRevision) => {
    const response = await context.request.get(historyUrl + path)
    assert.equal(response.status(), 200)
    assert.equal(response.headers()['cache-control'], 'no-store')
    const { payload } = decodeFrame(await response.body(), FrameType.AdminAppearanceHistory)
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
  const [rollback] = latest.items
  const [applied] = earlier.items
  assert.equal(rollback.revision, 2n)
  assert.equal(rollback.actor, 'tls-admin-fixture')
  assert.equal(rollback.rollback, true)
  assert.equal(rollback.previousTheme, applied.theme)
  assert.equal(rollback.theme, applied.previousTheme)
  assert.equal(applied.revision, 1n)
  assert.equal(applied.actor, 'tls-admin-fixture')
  assert.equal(applied.rollback, false)
  assert.equal(applied.previousTheme, state.theme)
  if (legacyThemeDigest) assert.equal(applied.theme, legacyThemeDigest)
  assert.deepEqual([applied.previousFont, applied.font, rollback.previousFont, rollback.font], Array(4).fill(state.font))
  for (const query of ['?before=02', '?before=1&before=2', '?before=9223372036854775808', '?before=0', '?limit=0', '?limit=51', '?scope=public'])
    assert.equal((await context.request.get(historyUrl + query)).status(), 400)
  await checkHistory()
  await history.getByText('Rolled back · revision 2', { exact: true }).waitFor()
  await history.getByText('Applied · revision 1', { exact: true }).waitFor()
  assert.equal(await history.getByRole('heading', { name: 'Appearance history', exact: true })
    .evaluate(element => element === document.activeElement), true)

  await writeFile(join(evidence, 'appearance-rollback-url.txt'), restored.css)
  assert.deepEqual(siteErrors, [])
  await page.screenshot({ path: join(evidence, 'administrator-appearance.png') })
  await sites.close()
  await promisify(execFile)(revoke, [], { timeout: 8_000 })
  await probe(stateUrl, adminCookieName, cookie.value, 401)
  await probe(historyUrl, adminCookieName, cookie.value, 401)
  if (fontDetailUrl) await probe(fontDetailUrl, adminCookieName, cookie.value, 401)
  await check()
  await page.getByRole('button', { name: 'Log in as administrator', exact: true }).waitFor()
  await logIn(page)
  assert.equal((await context.request.get(stateUrl)).status(), 403)
  assert.equal((await context.request.get(catalogUrl)).status(), 403)
  assert.equal((await context.request.get(historyUrl)).status(), 403)
  if (fontDetailUrl) assert.equal((await context.request.get(fontDetailUrl)).status(), 403)
  await section.waitFor({ state: 'detached' })
  return await readCookie(context, stateUrl, adminCookieName)
}

async function verifyFontDetails({ page, section, context, fontDetailUrl, fontName, legacyFontDigest, themeDigest,
  detailUrl, fixtureRoot }) {
  const fontSource = new URL('../../src/Web/node_modules/@fontsource/google-sans/', import.meta.url)
  const [archive, face, licenseText] = await Promise.all([
    readFile(join(fixtureRoot, legacyFontDigest + '.fsfont')),
    readFile(new URL('files/google-sans-latin-400-normal.woff2', fontSource)),
    readFile(new URL('LICENSE', fontSource), 'utf8'),
  ])
  assert.equal(createHash('sha256').update(archive).digest('hex'), legacyFontDigest)
  assert.equal((await context.request.get(detailUrl('0'.repeat(64)))).status(), 404)
  assert.equal((await context.request.get(detailUrl(themeDigest))).status(), 404)
  assert.equal((await context.request.get(detailUrl('A'.repeat(64)))).status(), 400)

  const font = section.getByRole('combobox', { name: 'Font', exact: true })
  await font.click()
  await page.getByRole('option', { name: `${fontName} 1.0.0`, exact: true }).click()
  const served = page.waitForResponse(response => response.url() === fontDetailUrl && response.request().method() === 'GET')
  await section.getByRole('button', { name: 'Font details', exact: true }).click()
  const response = await served
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['cache-control'], 'no-store')
  const detail = decodeAdminAppearanceFontDetail(decodeFrame(await response.body(), FrameType.AdminAppearanceFontDetail).payload)
  const expected = {
    id: fontName,
    version: '1.0.0',
    archiveDigest: legacyFontDigest,
    name: 'Fixture Sans',
    family: 'Fixture Sans',
    licenseName: 'OFL-1.1',
    licenseText,
    faceWeight: 400,
    faceStyle: 'normal',
    faceDigest: createHash('sha256').update(face).digest('hex'),
    faceBytes: face.byteLength,
    unicodeRange: 'U+0000-00FF',
    sourceKind: 'npm-fontsource',
    sourcePackage: '@fontsource/google-sans',
    sourceVersion: '5.2.1',
    sourceUpstream: 'Google Fonts',
  }
  for (const [field, value] of Object.entries(expected)) assert.equal(detail[field], value, field)

  const panel = section.locator('section[aria-labelledby="admin-font-details"]')
  await panel.getByRole('heading', { name: 'Font details', exact: true }).waitFor()
  assert.equal(await panel.locator('pre').textContent(), licenseText)
  const displayed = await panel.textContent()
  for (const value of [expected.family, expected.licenseName, expected.unicodeRange, expected.sourcePackage, expected.sourceUpstream])
    assert(displayed.includes(value), `Font detail panel should display ${value}`)
}
