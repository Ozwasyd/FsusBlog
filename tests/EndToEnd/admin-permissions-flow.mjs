import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function expectPermissions(page, context, origin, expected) {
  const section = page.getByRole('region', { name: 'Effective permissions', exact: true })
  await section.getByText('admin.manage', { exact: true }).waitFor()
  const [response, session] = await Promise.all([
    context.request.get(origin + WireRoutes.AdminEffectivePermissions),
    context.request.get(origin + WireRoutes.AdminSession),
  ])
  assert.equal(response.status(), 200)
  assert.equal(session.status(), 200)
  assert.match(response.headers()['cache-control'], /no-store/)
  const association = WireHeaders.AdminPermissionSession.toLowerCase()
  assert(Boolean(response.headers()[association]) && response.headers()[association] === session.headers()[association],
    'Permission projection and session response do not refer to the same live administrative authority.')
  const frame = decodeFrame(await response.body(), FrameType.AdminEffectivePermissions)
  const reader = new PodReader(frame.payload)
  const generation = reader.i64()
  assert(generation > 0n)
  assert.equal(reader.i32(), expected.length)
  const actual = expected.map(() => reader.text(32))
  reader.finish()
  assert.deepEqual(actual, expected)
  assert.deepEqual(await section.getByRole('listitem').allTextContents(), expected)
  return generation
}

export async function expectPanelHidden(page, name) {
  await page.getByRole('heading', { name, exact: true }).waitFor({ state: 'detached' })
}

export async function verifyMismatchedPermissionSession(page, context, origin) {
  const endpoint = origin + WireRoutes.AdminEffectivePermissions
  await page.route(endpoint, async route => {
    const response = await route.fetch({ maxRedirects: 0 })
    const headers = response.headers()
    const association = WireHeaders.AdminPermissionSession.toLowerCase()
    assert(/^[a-f0-9]{64}$/.test(headers[association]), 'Fixture response lacks an opaque session association.')
    const first = headers[association][0] === '0' ? '1' : '0'
    headers[association] = first + headers[association].slice(1)
    await route.fulfill({ response, headers })
  }, { times: 1 })
  await page.reload()
  await page.getByText('Could not verify effective permissions. Reload to try again.', { exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Administrator session', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Log out of administrator session', exact: true }).waitFor()
  await expectPanelHidden(page, 'Support inbox')
  await expectPanelHidden(page, 'Operations status')
  assert.equal((await context.request.get(origin + WireRoutes.AdminSession)).status(), 200)
  await page.getByRole('button', { name: 'Reload effective permissions', exact: true }).click()
  await expectPermissions(page, context, origin, ['admin.manage'])
  await page.getByRole('heading', { name: 'Support inbox', exact: true }).waitFor()
}
