import assert from 'node:assert/strict'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { clickForResponse } from './admin-workspace-fixture.mjs'
import { assertNoStore, readFrame } from './response-status-fixture.mjs'
import { exactButton, exactRegion, exactText } from './role-locators.mjs'

const association = WireHeaders.AdminPermissionSession.toLowerCase()

async function readyPanel(page) {
  const panel = exactRegion(page, 'Administrator session history')
  const refresh = exactButton(panel, 'Refresh')
  await refresh.waitFor()
  await panel.locator('button.is-loading').waitFor({ state: 'detached' })
  return { panel, refresh }
}

export async function expectSignInHistory({ page, context, origin, generation, currentCookie, expected }) {
  const { panel, refresh } = await readyPanel(page)
  const snapshot = await clickForResponse(page, origin + WireRoutes.AdminSignInHistory, refresh)
  await assertNoStore(snapshot)

  const current = await context.request.get(origin + WireRoutes.AdminSession)
  assert.match(current.headers()[association], /^[a-f0-9]{64}$/)
  assert.equal(snapshot.headers()[association], current.headers()[association])

  const body = await snapshot.body()
  assert.equal(body.includes(Buffer.from(currentCookie)), false)
  const payload = await readFrame(snapshot, FrameType.AdminSignInHistory)
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
    await exactText(panel.getByRole('listitem').nth(index), state).waitFor()
  }
  assert.equal(await panel.getByRole('listitem').count(), expected.length)
  return rows
}

export async function rejectMismatchedSignInHistory(page, origin) {
  const { panel, refresh } = await readyPanel(page)
  await page.route(origin + WireRoutes.AdminSignInHistory, async route => {
    const response = await route.fetch({ maxRedirects: 0 })
    const headers = response.headers()
    assert.match(headers[association], /^[a-f0-9]{64}$/)
    const first = headers[association][0] === '0' ? '1' : '0'
    headers[association] = first + headers[association].slice(1)
    await route.fulfill({ response, headers })
  }, { times: 1 })
  await refresh.click()
  await exactText(panel, 'Could not load administrator session history. Try again.').waitFor()
  assert.equal(await panel.getByRole('listitem').count(), 0)
}
