import assert from 'node:assert/strict'
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { sha256Hex } from './admin-workspace-fixture.mjs'
import { assertStatus, readFrame } from './response-status-fixture.mjs'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import { exactButton, roleWithExactName } from './role-locators.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

export const mediaBootstraps = [process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP, process.env.FSUSBLOG_TEST_MOBILE_BOOTSTRAP]
export const mediaViewports = [
  { name: 'desktop', colorScheme: 'light', viewport: { width: 1280, height: 800 } },
  { name: 'mobile', colorScheme: 'dark', viewport: { width: 375, height: 850 } },
]

export async function currentMediaSession(page, origin) {
  const response = await page.request.get(origin + WireRoutes.AuthoringSession)
  const current = response.headers()[WireHeaders.CurrentSession.toLowerCase()]
  try {
    assertStatus(response, 200)
    assert(current)
    return current
  } finally { await response.dispose() }
}

export async function withMediaSession(page, origin, bootstrap, prepare) {
  assert(bootstrap, 'Provide a one-time administrator bootstrap for each media fixture.')
  await signInFreshAdmin(page, origin, bootstrap)
  const current = await currentMediaSession(page, origin)

  const cookies = (await page.context().cookies(origin)).map(({ name, value }) => `${name}=${value}`).join('; ')
  const native = globalThis.fetch
  globalThis.fetch = (path, options) => {
    const url = new URL(path, origin)
    assert.equal(url.origin, origin)
    const headers = new Headers(options.headers)
    headers.set('Cookie', cookies)
    return native(url, { ...options, headers })
  }
  try {
    return await prepare(current)
  } finally { globalThis.fetch = native }
}

export function canvasDataUrl(page, size, palette, rect, type = 'image/png') {
  return page.evaluate(([[width, height], [background, accent], rect, type]) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
    context.fillStyle = accent
    context.fillRect(...rect)
    return canvas.toDataURL(type)
  }, [size, palette, rect, type])
}

export async function imageBytes(page, size, palette, rect, type = 'image/png') {
  const data = await canvasDataUrl(page, size, palette, rect, type)
  assert(data.startsWith(`data:${type};base64,`))
  return Buffer.from(data.split(',')[1], 'base64')
}

export async function imageFile(page, name, size, palette, rect, type = 'image/png') {
  return new File([await imageBytes(page, size, palette, rect, type)], name, { type })
}

export async function attachPrivateImage(page, name) {
  const choose = page.getByRole('combobox', { name: 'Choose a private image' })
  await choose.focus()
  await page.keyboard.press('Enter')
  await roleWithExactName(page, 'option', name).click()
  await exactButton(page, 'Attach image').click()
  await exactButton(page, `Preview ${name}`).waitFor()
}

export async function openPrivatePreview(page, origin, name, width, { close = true, checkReferer = false } = {}) {
  const preview = exactButton(page, `Preview ${name}`)
  await preview.focus()
  const [response] = await Promise.all([
    waitForUrlResponse(page, () => origin + WireRoutes.ArticleMediaPreview),
    page.keyboard.press('Enter'),
  ])
  assertStatus(response, 200)
  assert.equal(response.headers()['content-type'], name.endsWith('.webp') ? 'image/webp' : 'image/png')
  const authorization = await response.request().headerValue('authorization')
  assert.match(authorization ?? '', /^Bearer [A-Za-z0-9_-]{91}$/)
  if (checkReferer) assert.equal(await response.request().headerValue('referer'), null)
  const image = roleWithExactName(page, 'img', name)
  await image.waitFor()
  await page.waitForFunction(({ name, width }) => Array.from(document.images).some(candidate => candidate.alt === name && candidate.naturalWidth === width), { name, width })
  const objectUrl = await image.getAttribute('src')
  assert(objectUrl?.startsWith('blob:' + origin + '/'))
  const authorized = await page.context().request.get(response.url(), { headers: { Authorization: authorization } })
  assertStatus(authorized, 200)
  const bytes = await authorized.body()
  assert(bytes.length > 0 && bytes.length === Number(response.headers()['content-length']))
  if (close) await exactButton(page, 'Close image preview').click()
  return { digest: sha256Hex(bytes), length: bytes.length, bytes, authorization, objectUrl }
}

export async function saveDraftCover(page, articleId, name, assetId, pressEnter = false) {
  const attachmentPath = WireRoutes.ArticleMedia.replace('{id:int}', String(articleId))
  const trigger = exactButton(page, `Use ${name} as draft cover`)
  const [saved, attachments] = await Promise.all([
    waitForPathResponse(page, () => WireRoutes.ArticleCoverSave, 'POST'),
    page.waitForResponse(response => new URL(response.url()).pathname === attachmentPath &&
      response.headers()[WireHeaders.ArticleCover.toLowerCase()] === assetId),
    pressEnter ? trigger.press('Enter') : trigger.click(),
  ])
  assertStatus(saved, 200)
  assertStatus(attachments, 200)
  assert.equal(attachments.headers()['cache-control'], 'no-store')
  return { draft: await readFrame(saved, FrameType.Draft, decodeDraft), saved }
}
