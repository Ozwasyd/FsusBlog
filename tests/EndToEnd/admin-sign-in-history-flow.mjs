import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function expectSignInHistory({ page, context, origin, generation, currentCookie, expected }) {
  const route = origin + WireRoutes.AdminSignInHistory
  const panel = page.getByRole('region', { name: 'Administrator session history', exact: true })
  const response = page.waitForResponse(item => item.url() === route)
  await panel.getByRole('button', { name: 'Load session history', exact: true }).click()
  const snapshot = await response
  assert.equal(snapshot.status(), 200)
  assert.match(snapshot.headers()['cache-control'], /no-store/)

  const current = await context.request.get(origin + WireRoutes.AdminSession)
  const association = WireHeaders.AdminPermissionSession.toLowerCase()
  assert.match(current.headers()[association], /^[a-f0-9]{64}$/)
  assert.equal(snapshot.headers()[association], current.headers()[association])

  const body = await snapshot.body()
  assert.equal(body.includes(Buffer.from(currentCookie)), false)
  const { payload } = decodeFrame(body, FrameType.AdminSignInHistory)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  assert.equal(view.getBigInt64(0, true), generation)
  assert.equal(view.getInt32(8, true), expected.length)
  assert.equal(payload.byteLength, 12 + expected.length * 25)
  const rows = []
  for (const [index, state] of expected.entries()) {
    const at = 12 + index * 25
    const startedAt = view.getBigInt64(at, true)
    const expiresAt = view.getBigInt64(at + 8, true)
    const endedAt = view.getBigInt64(at + 16, true)
    assert.equal(view.getUint8(at + 24), state === 'Current' ? 1 : 2)
    assert.equal(expiresAt - startedAt, 7_200_000n)
    if (state === 'Current') assert.equal(endedAt, 0n)
    else assert(endedAt >= startedAt && endedAt < expiresAt)
    rows.push({ startedAt, expiresAt, endedAt })
    await panel.getByRole('listitem').nth(index).getByText(state, { exact: true }).waitFor()
  }
  assert.equal(await panel.getByRole('listitem').count(), expected.length)
  return rows
}

export async function rejectMismatchedSignInHistory(page, origin) {
  const panel = page.getByRole('region', { name: 'Administrator session history', exact: true })
  await page.route(origin + WireRoutes.AdminSignInHistory, async route => {
    const response = await route.fetch({ maxRedirects: 0 })
    const headers = response.headers()
    const association = WireHeaders.AdminPermissionSession.toLowerCase()
    assert.match(headers[association], /^[a-f0-9]{64}$/)
    const first = headers[association][0] === '0' ? '1' : '0'
    headers[association] = first + headers[association].slice(1)
    await route.fulfill({ response, headers })
  }, { times: 1 })
  await panel.getByRole('button', { name: 'Load session history', exact: true }).click()
  await panel.getByText('Could not load administrator session history. Try again.', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('listitem').count(), 0)
}
