import assert from 'node:assert/strict'
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import * as adminFx from './admin-workspace-fixture.mjs'
import { saveShot, writeEvidenceJson } from './isolated-browser-fixture.mjs'
import { assertNoStore, assertStatus, readFrame } from './response-status-fixture.mjs'
import { waitForUrlResponse } from './response-wait-fixture.mjs'
import { exactButton, exactRegion, exactText, roleWithExactName } from './role-locators.mjs'

const { FrameType, WireHeaders, WireRoutes: R } = wire
const path = '/api/v2/admin/identity/operations/risk-readiness.aeds'
const bindingHeader = WireHeaders.AdminPermissionSession.toLowerCase()
const modes = { publicReadMode: [1], rootWriteMode: [0, 1], replyWriteMode: [0, 1, 2], forwardingMode: [0, 1], dynamicRisk: [0], strongAnonymous: [0] }

export async function verifyRootCommentPowPolicy({ page, context, adminOrigin, siteOrigin, evidence }) {
  const route = adminOrigin.origin + R.AdminRootCommentPowPolicy
  const apply = adminOrigin.origin + R.AdminRootCommentPowApply
  const submit = siteOrigin.origin + R.SubmitPublicComment
  const policy = exactRegion(page, 'Root comment proof policy')
  const site = await context.newPage()
  site.setDefaultTimeout(12_000)
  const release = Promise.withResolvers()
  const digest = seconds => adminFx.sha256Hex('root-comment-classic-pow-v1:12:' + seconds)

  async function read(generation, proofSeconds, previousSeconds) {
    const response = await context.request.get(route, { timeout: 15_000 })
    await assertNoStore(response)
    const result = await readFrame(response, FrameType.AdminRootCommentPowPolicy, wire.decodeAdminRootCommentPowPolicy)
    assert.deepEqual(result, { generation, proofSeconds, previousSeconds, digest: digest(proofSeconds) })
    return result
  }

  async function change(label, generation, proofSeconds) {
    const [response] = await Promise.all([
      waitForUrlResponse(page, () => apply, 'POST', { timeout: 15_000 }),
      exactButton(policy, label).click({ timeout: 12_000 }),
    ])
    assertStatus(response, 200)
    await exactText(policy, `Generation ${generation} · ${proofSeconds} seconds`).waitFor({ timeout: 12_000 })
  }

  try {
    await exactText(policy, 'Generation 1 · 120 seconds').waitFor({ timeout: 12_000 })
    const initial = await read(1n, 120, 0)
    await site.route(submit, async request => { await release.promise; await request.continue() }, { times: 1 })
    await site.goto(siteOrigin.origin + '/article/1')
    const send = exactButton(site, 'Submit for review')
    await roleWithExactName(site, 'textbox', 'Comment').fill('One pending comment from the current root policy fixture.')
    await adminFx.checkLabeledCheckbox(site, 'Publish as Policy Fixture Author after review')
    assert(await send.isEnabled())
    const [outgoing] = await Promise.all([
      site.waitForRequest(request => request.url() === submit && request.method() === 'POST', { timeout: 15_000 }),
      send.click(),
    ])
    assert(typeof outgoing.headers()[WireHeaders.PowProof.toLowerCase()] === 'string', 'The original Worker must solve a real generation 1 challenge.')

    await page.bringToFront()
    await policy.getByLabel('Proof lifetime in seconds').fill('60', { timeout: 12_000 })
    await change('Apply proof lifetime', '2', 60)
    await read(2n, 60, 120)
    const staleCommand = adminFx.packFrame(FrameType.AdminRootCommentPowCommand, wire.encodeAdminRootCommentPowCommand({
      expectedGeneration: initial.generation, expectedDigest: initial.digest, proofSeconds: 90, rollback: false,
    }))
    const stale = await context.request.post(apply, { data: staleCommand, timeout: 15_000,
      headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream' } })
    assertStatus(stale, 409)
    await change('Restore previous proof lifetime', '3', 120)
    const restored = await read(3n, 120, 60)
    assert.equal(restored.digest, initial.digest)

    const refusal = waitForUrlResponse(site, () => submit, 'POST', { timeout: 15_000 })
    release.resolve()
    const old = await refusal
    assert.equal(decodeApiError(await readFrame(old, FrameType.ApiError, null, 401), old.status()).details, 'comment_pow_rejected')
    await site.getByRole('alert').filter({ hasText: 'Public comment submission is unavailable.' }).waitFor()
    await site.bringToFront()
    const fresh = await adminFx.clickForResponse(site, submit, send, 'POST')
    assertStatus(fresh, 200)
    assert.deepEqual(fresh.request().postDataBuffer(), old.request().postDataBuffer())
    await exactText(site, 'Comment submitted for review.').waitFor()
    await writeEvidenceJson(evidence, 'root-comment-pow-policy.json', {
      initial: initial.generation.toString(), restored: restored.generation.toString(), digest: restored.digest,
      stalePolicyCommand: stale.status(), staleProof: old.status(), currentProof: fresh.status(), sameCommand: true,
    })
  } finally {
    release.resolve()
    await site.close()
  }
}

export function adminRiskReadinessFlow({ page, context, adminOrigin, siteOrigin, adminCookieName, siteCookie, priorCookie, probe, evidence, expected }) {
  assert.equal(R.AdminRiskReadiness, path)
  assert.equal(FrameType.AdminRiskReadiness, 32851)
  for (const [field, values] of Object.entries(modes)) assert(values.includes(expected?.[field]), `The fixture must specify a supported ${field}.`)
  const endpoint = adminOrigin.origin + path
  const section = exactRegion(page, 'Risk controls')
  const button = exactButton(section, 'Check risk controls')
  const observation = section.locator('dl')
  const failure = section.getByRole('alert').filter({ hasText: 'Could not check risk controls. Try again.' })
  const check = () => adminFx.clickForResponse(page, endpoint, button)

  function readObservation(response, bytes) {
    assertStatus(response, 200)
    assert.match(response.headers()['content-type'] ?? '', /^application\/octet-stream(?:\s*;|$)/i)
    assert(response.headers()['cache-control']?.split(',').some(value => value.trim() === 'no-store'))
    const binding = response.headers()[bindingHeader]
    assert.match(binding ?? '', /^[0-9a-f]{64}$/)
    const { payload } = decodeFrame(bytes, FrameType.AdminRiskReadiness)
    assert.equal(payload.byteLength, 24)
    const fields = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    for (const [index, field] of Object.keys(modes).entries()) assert.equal(fields.getInt32(index * 4, true), expected[field], `${field} differs from the fixture.`)
    assert.deepEqual(wire.decodeAdminRiskReadiness(payload), expected)
    return { binding, payload }
  }

  async function displayed() {
    const values = [
      ['Public comment reads', 'Fixed query concurrency limit'],
      ['Signed-in top-level comments', ['Route not installed', 'Classic PoW route installed'][expected.rootWriteMode]],
      ['Signed-in comment replies', ['Route not installed', 'Classic PoW route installed. Reply notice table absent.',
        'Classic PoW route installed. Reply notice table present.'][expected.replyWriteMode]],
      ['Forwarded client address', ['Connection peer address', 'Trusted loopback proxy'][expected.forwardingMode]],
      ['Dynamic risk policy', 'Not installed'], ['Strong anonymous comments', 'Not installed'],
    ]
    await observation.waitFor()
    assert.deepEqual(await observation.locator('dt').allTextContents(), values.map(([label]) => label))
    assert.deepEqual(await observation.locator('dd').allTextContents(), values.map(([, value]) => value))
  }

  async function rejectResponse(body, binding) {
    const headers = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...(binding !== undefined && { [bindingHeader]: binding }) }
    const handler = route => route.fulfill({ status: 200, headers, body })
    await page.route(endpoint, handler, { times: 1 })
    try {
      assertStatus(await check(), 200)
      await failure.waitFor()
      await observation.waitFor({ state: 'detached' })
    } finally { await page.unroute(endpoint, handler) }
  }

  async function cleared(staleCookie) {
    await probe(endpoint, adminCookieName, staleCookie.value, 401)
    await section.waitFor({ state: 'detached' })
  }

  return {
    async verifyIsolation() {
      await probe(siteOrigin.origin + path, adminCookieName, priorCookie.value, 404)
      await probe(endpoint, adminCookieName, siteCookie.value, 401)
    },
    async verifyAvailable() {
      for (const [route, installed] of [[R.PublicCommentPowChallenge, expected.rootWriteMode], [R.SubmitPublicComment, expected.rootWriteMode],
        [R.PublicCommentReplyPow, expected.replyWriteMode], [R.SubmitPublicCommentReply, expected.replyWriteMode]]) {
        assertStatus(await context.request.post(siteOrigin.origin + route, { headers: { Origin: siteOrigin.origin }, maxRedirects: 0 }), installed ? 415 : 404)
      }
      await displayed()
      const response = await check(), body = await response.body(), { binding, payload } = readObservation(response, body)
      const authority = await context.request.get(adminOrigin.origin + R.AdminSession, { maxRedirects: 0 })
      assertStatus(authority, 200)
      assert.equal(binding, authority.headers()[bindingHeader])
      await displayed()

      const unknown = Uint8Array.from(payload)
      new DataView(unknown.buffer).setInt32(0, 2, true)
      for (const [badBody, badBinding] of [[body], [body, 'invalid-association'], [body, (binding.startsWith('0') ? '1' : '0') + binding.slice(1)],
        [adminFx.packFrame(FrameType.AdminRiskReadiness, payload.subarray(0, 23)), binding],
        [adminFx.packFrame(FrameType.AdminOperationsStatus, payload), binding],
        [adminFx.packFrame(FrameType.AdminRiskReadiness, unknown), binding],
        [adminFx.packFrame(FrameType.AdminRiskReadiness, Buffer.concat([payload, Buffer.from([0])])), binding]]) {
        await rejectResponse(badBody, badBinding)
      }
      const restored = await check()
      assert.equal(readObservation(restored, await restored.body()).binding, binding)
      await displayed()
      await saveShot(page, evidence, 'administrator-risk-readiness.png', {})
    },
    waitForObservation: displayed,
    async duringRevocation(staleCookie, revokeAndObserveSessionLoss) {
      const started = Promise.withResolvers(), release = Promise.withResolvers(), finished = Promise.withResolvers()
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
        } catch (error) { started.reject(error); await route.abort().catch(() => {}) }
        finally { finished.resolve() }
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
