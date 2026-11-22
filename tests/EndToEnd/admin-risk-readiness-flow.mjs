import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeApiError, decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAdminRiskReadiness, decodeAdminRootCommentPowPolicy, encodeAdminRootCommentPowCommand, FrameType,
  WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { waitForUrlResponse } from './response-wait-fixture.mjs'

const path = '/api/v2/admin/identity/operations/risk-readiness.aeds'
const bindingHeader = WireHeaders.AdminPermissionSession.toLowerCase()
const modes = {
  publicReadMode: [1], rootWriteMode: [0, 1], replyWriteMode: [0, 1, 2],
  forwardingMode: [0, 1], dynamicRisk: [0], strongAnonymous: [0],
}

export async function verifyRootCommentPowPolicy({ page, context, adminOrigin, siteOrigin, evidence }) {
  const route = adminOrigin.origin + WireRoutes.AdminRootCommentPowPolicy
  const apply = adminOrigin.origin + WireRoutes.AdminRootCommentPowApply
  const submit = siteOrigin.origin + WireRoutes.SubmitPublicComment
  const policy = page.getByRole('region', { name: 'Root comment proof policy', exact: true })
  const proofLifetime = policy.getByLabel('Proof lifetime in seconds')
  const site = await context.newPage()
  site.setDefaultTimeout(12_000)
  const release = Promise.withResolvers()
  const digest = seconds => createHash('sha256').update('root-comment-classic-pow-v1:12:' + seconds).digest('hex')

  async function read(generation, proofSeconds, previousSeconds) {
    const response = await context.request.get(route, { timeout: 15_000 })
    assert.equal(response.status(), 200)
    assert.match(response.headers()['cache-control'], /no-store/)
    const { payload } = decodeFrame(await response.body(), FrameType.AdminRootCommentPowPolicy)
    const result = decodeAdminRootCommentPowPolicy(payload)
    assert.deepEqual(result, { generation, proofSeconds, previousSeconds, digest: digest(proofSeconds) })
    return result
  }

  async function change(label, generation, proofSeconds) {
    const [response] = await Promise.all([
      waitForUrlResponse(page, () => apply, 'POST', { timeout: 15_000 }),
      policy.getByRole('button', { name: label, exact: true }).click({ timeout: 12_000 }),
    ])
    assert.equal(response.status(), 200)
    await policy.getByText('Generation ' + generation + ' · ' + proofSeconds + ' seconds', { exact: true }).waitFor({ timeout: 12_000 })
  }

  try {
    await policy.getByText('Generation 1 · 120 seconds', { exact: true }).waitFor({ timeout: 12_000 })
    const initial = await read(1n, 120, 0)
    await site.route(submit, async request => {
      await release.promise
      await request.continue()
    }, { times: 1 })
    await site.goto(siteOrigin.origin + '/article/1')
    const send = site.getByRole('button', { name: 'Submit for review', exact: true })
    await site.getByRole('textbox', { name: 'Comment', exact: true }).fill('One pending comment from the current root policy fixture.')
    const label = 'Publish as Policy Fixture Author after review'
    await site.getByText(label, { exact: true }).click()
    assert(await site.getByRole('checkbox', { name: label, exact: true }).isChecked())
    assert(await send.isEnabled())
    const [outgoing] = await Promise.all([
      site.waitForRequest(request => request.url() === submit && request.method() === 'POST', { timeout: 15_000 }),
      send.click(),
    ])
    assert(typeof outgoing.headers()[WireHeaders.PowProof.toLowerCase()] === 'string',
      'The original Worker must solve a real generation 1 challenge.')

    await page.bringToFront()
    await proofLifetime.fill('60', { timeout: 12_000 })
    await change('Apply proof lifetime', '2', 60)
    await read(2n, 60, 120)
    const staleCommand = encodeFrame(FrameType.AdminRootCommentPowCommand, encodeAdminRootCommentPowCommand({
      expectedGeneration: initial.generation, expectedDigest: initial.digest, proofSeconds: 90, rollback: false,
    }))
    const stale = await context.request.post(apply, { data: Buffer.from(staleCommand), timeout: 15_000,
      headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream' } })
    assert.equal(stale.status(), 409)
    await change('Restore previous proof lifetime', '3', 120)
    const restored = await read(3n, 120, 60)
    assert.equal(restored.digest, initial.digest)

    const refusal = waitForUrlResponse(site, () => submit, 'POST', { timeout: 15_000 })
    release.resolve()
    const old = await refusal
    assert.equal(old.status(), 401)
    const rejected = decodeApiError(decodeFrame(await old.body(), FrameType.ApiError).payload, old.status())
    assert.equal(rejected.details, 'comment_pow_rejected')
    await site.getByRole('alert').filter({ hasText: 'Public comment submission is unavailable.' }).waitFor()
    await site.bringToFront()
    const [fresh] = await Promise.all([
      waitForUrlResponse(site, () => submit, 'POST'),
      send.click(),
    ])
    assert.equal(fresh.status(), 200)
    assert.deepEqual(fresh.request().postDataBuffer(), old.request().postDataBuffer())
    await site.getByText('Comment submitted for review.', { exact: true }).waitFor()
    await writeFile(join(evidence, 'root-comment-pow-policy.json'), JSON.stringify({
      initial: initial.generation.toString(), restored: restored.generation.toString(), digest: restored.digest,
      stalePolicyCommand: stale.status(), staleProof: old.status(), currentProof: fresh.status(), sameCommand: true,
    }, null, 2) + '\n')
  } finally {
    release.resolve()
    await site.close()
  }
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
    waitForUrlResponse(page, () => endpoint, 'GET'),
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
