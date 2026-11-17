import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeModerationBatchReceipt } from '../../src/Contracts/admin-moderation-batch.ts'
import { readMfaProof } from '../../src/Contracts/mfa.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function verifyAdminModerationBatch({ page, context, section, adminOrigin, publicRoute, evidence }) {
  const approved = ['Batch approve fixture one', 'Batch approve fixture two']
  const rejected = ['Batch reject fixture one', 'Batch reject fixture two']
  const claim = section.getByRole('button', { name: 'Claim selected comments', exact: true })
  const initialViewport = page.viewportSize()
  await page.setViewportSize({ width: 390, height: 844 })
  const errors = []
  const recordError = error => errors.push(error.message)
  page.on('pageerror', recordError)
  try {
    assert.equal(new URL(page.url()).pathname, '/admin/interaction')
    assert.equal(await claim.isDisabled(), true)
    await choose(approved[0])
    assert.equal(await claim.isDisabled(), true)
    await choose(approved[1])
    await takeClaims()
    await section.getByRole('button', { name: 'Cancel batch review', exact: true }).click()
    await section.getByText('Batch review canceled.', { exact: true }).waitFor()
    await claim.waitFor()
    assert.equal(await claim.isDisabled(), true)
    for (const body of approved) await choose(body)
    await takeClaims()
    await decide(1, 'Approve selected comments with Passkey', '2 comments approved.')

    for (const body of rejected) await choose(body)
    await takeClaims()
    await decide(2, 'Reject selected comments with Passkey', '2 comments rejected.')
    await section.getByText('No comments are waiting for moderation.', { exact: true }).waitFor()
    const published = await context.request.get(publicRoute)
    assert.equal(published.status(), 200)
    const publicFrame = await published.body()
    for (const body of approved) assert(publicFrame.includes(Buffer.from(body)))
    for (const body of rejected) assert(!publicFrame.includes(Buffer.from(body)))
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    page.off('pageerror', recordError)
    if (initialViewport) await page.setViewportSize(initialViewport)
  }

  async function choose(body) {
    const row = section.getByRole('article').filter({ has: page.getByText(body, { exact: true }) })
    const checkbox = row.getByRole('checkbox', { name: /Select comment \d+ for batch review/ })
    // FsusUI renders the clickable label around its visually-hidden native input.
    await row.getByText(/Select comment \d+ for batch review/, { exact: true }).click()
    assert.equal(await checkbox.isChecked(), true)
  }

  async function takeClaims() {
    const [response] = await Promise.all([waitPost(WireRoutes.AdminModerationBatchClaim), claim.click()])
    assert.equal(response.status(), 200)
    assert.equal(decodeFrame(await response.body()).type, FrameType.AdminModerationBatchClaims)
    await section.getByText('2 comments claimed for review.', { exact: true }).waitFor()
  }

  async function decide(decision, label, notice) {
    const action = section.getByRole('button', { name: label, exact: true })
    assert.equal(await action.isDisabled(), true)
    await section.getByLabel('Reason for batch decision', { exact: true }).fill('Batch moderation integration fixture')
    if (decision === 1)
      await page.screenshot({ path: join(evidence, 'admin-comment-batch-mobile.png'), animations: 'disabled' })
    const [started, completed, committed] = await Promise.all([
      waitPost(WireRoutes.AdminModerationBatchStepUpBegin), waitPost(WireRoutes.AdminModerationBatchStepUpComplete),
      waitPost(WireRoutes.AdminModerationBatchDecision), action.click(),
    ])
    for (const response of [started, completed, committed]) {
      assert.equal(response.status(), 200)
      assert((await response.headerValue('Cache-Control'))?.includes('no-store'))
    }
    assert.equal(decodeFrame(await started.body()).type, FrameType.PasskeyLoginBegin)
    const proof = readMfaProof(decodeFrame(await completed.body(), FrameType.MfaChallengeResult).payload, 'admin-sensitive', true)
    const command = committed.request().postDataBuffer()
    assert(command.equals(started.request().postDataBuffer()))
    assert.equal(await committed.request().headerValue(WireHeaders.MfaProof), proof)
    const payload = decodeFrame(command, FrameType.AdminModerationBatchDecision).payload
    assert.equal(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(0, true), decision)
    assert(decodeModerationBatchReceipt(decodeFrame(await committed.body(), FrameType.AdminModerationBatchReceipt).payload, 2).batchId > 0n)
    await section.getByText(notice, { exact: true }).waitFor()
    const repeated = await context.request.post(committed.url(), {
      headers: { Origin: adminOrigin, 'Content-Type': 'application/octet-stream', [WireHeaders.MfaProof]: proof }, data: command,
    })
    assert.equal(repeated.status(), 428)
  }

  function waitPost(path) {
    return page.waitForResponse(response => response.url() === adminOrigin + path && response.request().method() === 'POST')
  }
}
