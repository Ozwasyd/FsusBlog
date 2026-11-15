import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAdminRiskReadiness, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const path = '/api/v2/admin/identity/operations/risk-readiness.aeds'
const bindingHeader = WireHeaders.AdminPermissionSession.toLowerCase()
const modes = {
  publicReadMode: [1], rootWriteMode: [0, 1], replyWriteMode: [0, 1, 2],
  forwardingMode: [0, 1], dynamicRisk: [0], strongAnonymous: [0],
}

export function adminRiskReadinessFlow({ page, context, adminOrigin, siteOrigin, adminCookieName,
  siteCookie, priorCookie, probe, evidence, expected }) {
  assert.equal(WireRoutes.AdminRiskReadiness, path)
  assert.equal(FrameType.AdminRiskReadiness, 32851)
  for (const [field, values] of Object.entries(modes)) {
    assert(values.includes(expected?.[field]), `The fixture must specify a supported ${field}.`)
  }
  const endpoint = adminOrigin.origin + path
  const section = page.getByRole('region', { name: 'Risk controls', exact: true })
  const button = section.getByRole('button', { name: 'Check risk controls', exact: true })
  const observation = section.locator('dl')
  const failure = section.getByRole('alert').filter({ hasText: 'Could not check risk controls. Try again.' })
  const check = async () => (await Promise.all([
    page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'GET'),
    button.click(),
  ]))[0]

  function readObservation(response, bytes) {
    assert.equal(response.status(), 200)
    assert.match(response.headers()['content-type'] ?? '', /^application\/octet-stream(?:\s*;|$)/i)
    assert(response.headers()['cache-control']?.split(',').some(value => value.trim() === 'no-store'))
    const binding = response.headers()[bindingHeader]
    assert.match(binding ?? '', /^[0-9a-f]{64}$/)
    const { payload } = decodeFrame(bytes, FrameType.AdminRiskReadiness)
    assert.equal(payload.byteLength, 24)
    const fields = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    for (const [index, field] of Object.keys(modes).entries()) {
      assert.equal(fields.getInt32(index * 4, true), expected[field], `${field} differs from the fixture.`)
    }
    assert.deepEqual(decodeAdminRiskReadiness(payload), expected)
    return { binding, payload }
  }

  async function displayed() {
    const values = [
      ['Public comment reads', 'Fixed query concurrency limit'],
      ['Signed-in top-level comments', ['Route not installed', 'Classic PoW route installed'][expected.rootWriteMode]],
      ['Signed-in comment replies', ['Route not installed', 'Classic PoW route installed. Reply notice table absent.',
        'Classic PoW route installed. Reply notice table present.'][expected.replyWriteMode]],
      ['Forwarded client address', ['Connection peer address', 'Trusted loopback proxy'][expected.forwardingMode]],
      ['Dynamic risk policy', 'Not installed'],
      ['Strong anonymous comments', 'Not installed'],
    ]
    await observation.waitFor()
    assert.deepEqual(await observation.locator('dt').allTextContents(), values.map(([label]) => label))
    assert.deepEqual(await observation.locator('dd').allTextContents(), values.map(([, value]) => value))
  }

  async function rejectResponse(body, binding) {
    const headers = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
    if (binding !== undefined) headers[bindingHeader] = binding
    const handler = route => route.fulfill({ status: 200, headers, body })
    await page.route(endpoint, handler, { times: 1 })
    try {
      assert.equal((await check()).status(), 200)
      await failure.waitFor()
      await observation.waitFor({ state: 'detached' })
    } finally {
      await page.unroute(endpoint, handler)
    }
  }

  async function cleared(staleCookie) {
    await probe(endpoint, adminCookieName, staleCookie.value, 401)
    await section.waitFor({ state: 'detached' })
  }

  return {
    async denied() {
      await probe(siteOrigin.origin + path, adminCookieName, priorCookie.value, 404)
      await probe(endpoint, adminCookieName, siteCookie.value, 401)
      assert.equal((await context.request.get(endpoint, { maxRedirects: 0 })).status(), 403)
      await section.waitFor({ state: 'detached' })
    },
    async granted() {
      const commentRoutes = [
        [WireRoutes.PublicCommentPowChallenge, expected.rootWriteMode],
        [WireRoutes.SubmitPublicComment, expected.rootWriteMode],
        [WireRoutes.PublicCommentReplyPow, expected.replyWriteMode],
        [WireRoutes.SubmitPublicCommentReply, expected.replyWriteMode],
      ]
      for (const [route, installed] of commentRoutes) {
        const response = await context.request.post(siteOrigin.origin + route, {
          headers: { Origin: siteOrigin.origin }, maxRedirects: 0,
        })
        assert.equal(response.status(), installed ? 415 : 404)
      }

      await button.waitFor()
      await observation.waitFor({ state: 'detached' })
      const response = await check()
      const body = await response.body()
      const { binding, payload } = readObservation(response, body)
      const authority = await context.request.get(adminOrigin.origin + WireRoutes.AdminSession, { maxRedirects: 0 })
      assert.equal(authority.status(), 200)
      assert.equal(binding, authority.headers()[bindingHeader])
      await displayed()

      await rejectResponse(body)
      await rejectResponse(body, 'invalid-association')
      const different = (binding.startsWith('0') ? '1' : '0') + binding.slice(1)
      await rejectResponse(body, different)
      const truncated = Buffer.from(encodeFrame(FrameType.AdminRiskReadiness, payload.subarray(0, 23)))
      await rejectResponse(truncated, binding)
      await rejectResponse(Buffer.from(encodeFrame(FrameType.AdminOperationsStatus, payload)), binding)
      const unknown = Uint8Array.from(payload)
      new DataView(unknown.buffer).setInt32(0, 2, true)
      await rejectResponse(Buffer.from(encodeFrame(FrameType.AdminRiskReadiness, unknown)), binding)
      const extra = Buffer.concat([payload, Buffer.from([0])])
      await rejectResponse(Buffer.from(encodeFrame(FrameType.AdminRiskReadiness, extra)), binding)

      const restored = await check()
      assert.equal(readObservation(restored, await restored.body()).binding, binding)
      await displayed()
      await page.screenshot({ path: join(evidence, 'administrator-risk-readiness.png') })
    },
    cleared,
    async duringRevocation(staleCookie, revokeAndObserveSessionLoss) {
      const started = Promise.withResolvers()
      const release = Promise.withResolvers()
      const finished = Promise.withResolvers()
      let intercepted = false
      const handler = async route => {
        intercepted = true
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 12_000 })
          readObservation(response, await response.body())
          started.resolve()
          await release.promise
          // Session loss may have already aborted the browser request.
          await route.fulfill({ response }).catch(() => {})
        } catch (error) {
          started.reject(error)
          await route.abort().catch(() => {})
        } finally {
          finished.resolve()
        }
      }
      await observation.waitFor()
      await page.route(endpoint, handler, { times: 1 })
      const deadline = AbortSignal.timeout(12_000)
      const timeout = () => started.reject(new Error('The in-flight risk control read was not observed.'))
      deadline.addEventListener('abort', timeout, { once: true })
      try {
        await Promise.all([started.promise, button.click()])
        await observation.waitFor({ state: 'detached' })
        await revokeAndObserveSessionLoss()
        await cleared(staleCookie)
      } finally {
        deadline.removeEventListener('abort', timeout)
        release.resolve()
        await page.unroute(endpoint, handler)
        if (intercepted) await finished.promise
      }
      await section.waitFor({ state: 'detached' })
    },
  }
}
