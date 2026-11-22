import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAdminClusterStatus, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { waitForUrlResponse } from './response-wait-fixture.mjs'

export function adminClusterFlow({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie,
  probe, evidence }) {
  const endpoint = adminOrigin.origin + WireRoutes.AdminClusterStatus
  const section = page.getByRole('region', { name: 'Service & version', exact: true })
  const button = section.getByRole('button', { name: 'Re-check', exact: true })
  const detailsToggle = section.locator('summary', { hasText: 'Runtime & publication diagnostics' })
  const check = async () => (await Promise.all([
    waitForUrlResponse(page, () => endpoint, 'GET'), button.click(),
  ]))[0]
  const instance = section.getByText('Instance ID', { exact: true })
  const expandDetails = async () => {
    await detailsToggle.waitFor()
    const isOpen = await section.locator('details').first().evaluate(el => el.open)
    if (!isOpen) await detailsToggle.click()
  }

  return {
    async denied() {
      await probe(siteOrigin.origin + WireRoutes.AdminClusterStatus, adminCookieName, priorCookie.value, 404)
      await probe(endpoint, adminCookieName, siteCookie.value, 401)
      assert.equal((await context.request.get(endpoint)).status(), 403)
      await instance.waitFor({ state: 'hidden' })
    },
    async granted() {
      const response = await check()
      assert.equal(response.status(), 200)
      assert.match(response.headers()['cache-control'], /no-store/)
      assert.match(response.headers()[WireHeaders.AdminPermissionSession.toLowerCase()], /^[a-f0-9]{64}$/)
      const bytes = await response.body()
      const observed = decodeAdminClusterStatus(decodeFrame(bytes, FrameType.AdminClusterStatus).payload)
      assert.equal(observed.mode, 1)
      assert.equal(observed.nodeId, process.env.FSUSBLOG_NODE_ID ?? '')
      assert(observed.instanceId !== '00000000-0000-0000-0000-000000000000')
      assert(observed.buildVersion && observed.startedAt > 0 && observed.observedAt >= observed.startedAt)
      assert(observed.snapshotReady && observed.leaseAgeMs >= 0 && observed.leaseAgeMs < 1000)
      await section.getByText('Service healthy', { exact: true }).waitFor()
      await expandDetails()
      await section.getByText(observed.instanceId, { exact: true }).waitFor()

      await page.route(endpoint, route => route.fulfill({ status: 200, body: bytes, headers: {
        'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        [WireHeaders.AdminPermissionSession]: '0'.repeat(64),
      } }))
      try {
        assert.equal((await check()).status(), 200)
        await section.getByRole('alert').filter({ hasText: 'Could not check service and version status.' }).waitFor()
        await instance.waitFor({ state: 'hidden' })
      } finally {
        await page.unroute(endpoint)
      }
      assert.equal((await check()).status(), 200)
      await expandDetails()
      await section.getByText(observed.instanceId, { exact: true }).waitFor()
      await page.screenshot({ path: join(evidence, 'administrator-single-mode.png') })
    },
    async cleared(staleCookie) {
      await probe(endpoint, adminCookieName, staleCookie.value, 401)
      await instance.waitFor({ state: 'hidden' })
    },
  }
}
