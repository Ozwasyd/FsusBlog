import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAdminAppearanceState, encodeAdminAppearanceCommand, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function verifyAppearanceActivation({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
  priorCookie, grant, revoke, logIn, probe, readCookie, evidence }) {
  const admin = path => adminOrigin.origin + path
  const pub = path => siteOrigin.origin + path
  const stateUrl = admin(WireRoutes.AdminAppearanceState)
  const catalogUrl = admin(WireRoutes.AdminAppearanceCatalog)
  const applyUrl = admin(WireRoutes.AdminAppearanceApply)
  const alias = '/site-appearance/current.css'
  const legacyFont = process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE_FSFONT === '1'
  const fontName = legacyFont ? 'fsusblog.font.fixture' : 'fixture.font'
  const section = page.getByRole('region', { name: 'Site appearance', exact: true })
  const check = () => section.getByRole('button', { name: 'Check active appearance', exact: true }).click()
  assert.equal(await page.locator('link[href^="/site-appearance/"]').count(), 0)
  await probe(stateUrl, adminCookieName, siteCookie.value, 401)
  await probe(pub(WireRoutes.AdminAppearanceState), adminCookieName, priorCookie.value, 404)
  await probe(admin(alias), adminCookieName, priorCookie.value, 404)
  assert.equal((await context.request.get(stateUrl)).status(), 403)
  assert.equal((await context.request.get(catalogUrl)).status(), 403)
  await section.waitFor({ state: 'detached' })

  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await probe(stateUrl, adminCookieName, priorCookie.value, 401)
  await page.reload()
  await page.getByRole('button', { name: 'Log in as administrator', exact: true }).waitFor()
  await logIn(page)
  await check()
  await section.getByText(`Active theme: fixture.theme · Active font: ${fontName}`).waitFor()

  const sites = await context.newPage()
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
  await page.getByRole('option', { name: 'fixture.alternate 1.0', exact: true }).click()
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
  for (const path of Object.values(initial)) assert.equal((await context.request.get(pub(path))).status(), 404)
  await section.getByRole('button', { name: `Restore fixture.theme / ${fontName} with Passkey` }).click()
  await section.getByText('Previous appearance restored.', { exact: true }).waitFor()
  const restored = await current(2, '#225533')
  for (const path of [...Object.values(initial), ...Object.values(alternate)])
    assert.equal((await context.request.get(pub(path))).status(), 404)
  await writeFile(join(evidence, 'appearance-rollback-url.txt'), restored.css)
  await page.screenshot({ path: join(evidence, 'administrator-appearance.png') })
  await sites.close()
  await promisify(execFile)(revoke, [], { timeout: 8_000 })
  await probe(stateUrl, adminCookieName, cookie.value, 401)
  await check()
  await page.getByRole('button', { name: 'Log in as administrator', exact: true }).waitFor()
  await logIn(page)
  assert.equal((await context.request.get(stateUrl)).status(), 403)
  assert.equal((await context.request.get(catalogUrl)).status(), 403)
  await section.waitFor({ state: 'detached' })
  return await readCookie(context, stateUrl, adminCookieName)
}
