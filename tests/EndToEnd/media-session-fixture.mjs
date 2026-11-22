import assert from 'node:assert/strict'
import { WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { assertStatus } from './response-status-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

export const mediaBootstraps = [process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP, process.env.FSUSBLOG_TEST_MOBILE_BOOTSTRAP]

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
