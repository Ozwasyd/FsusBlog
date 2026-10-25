import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { RiskChallengeCommandRuntime } from '@/composables/useRiskChallengeCommand'

const mediaVectors = JSON.parse(readFileSync(
  new URL('../../../fixtures/security/perception-character-v3-vectors.json', import.meta.url),
  'utf8'
)) as {
  visual: { artifactBase64: string }
  audio: { artifactBase64: string }
}

const DESKTOP_VIEWPORT = { width: 1440, height: 960 }
const MOBILE_VIEWPORT = { width: 390, height: 844 }

type Representation = 'visual' | 'audio'

async function openChallenge(
  page: Page,
  representation: Representation = 'visual',
  expiresInMs = 60_000
): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.readyState === 'complete'
    && ((document.getElementById('global-loader') as HTMLElement | null)?.hidden ?? true))
  await page.evaluate(async ({ representation, expiresInMs, visualBase64, audioBase64 }) => {
    const fullAppPath = '/src/bootstrap/fullApp.ts'
    const coordinatorPath = '/src/composables/useRiskChallengeCommand.ts'
    const transportPath = '/src/composition/binaryTransport.ts'
    const securityPath = '/src/api/security.ts'
    const contractPath = '/src/contracts/binaryApi.ts'
    const { bootstrapFullApp } = await import(/* @vite-ignore */ fullAppPath)
    await bootstrapFullApp()
    const { getRiskChallengeCoordinator } = await import(/* @vite-ignore */ coordinatorPath)
    const { BinaryTransportError } = await import(/* @vite-ignore */ transportPath)
    const { SecurityChallengeKind } = await import(/* @vite-ignore */ securityPath)
    const { PerceptionCharacterV3Representation } = await import(/* @vite-ignore */ contractPath)
    const coordinator: RiskChallengeCommandRuntime = getRiskChallengeCoordinator()
    coordinator.handleCancel()
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL)
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL)

    const state = {
      representation,
      expiresInMs,
      identity: 0,
      verifyOutcome: 'verified',
      replacementOutcome: 'success',
      commandExecutions: 0,
      cancelled: [] as string[],
      cleared: 0,
      replacements: [] as Array<{ from: string; to: string }>,
      objectUrls: [] as string[],
      revokedObjectUrls: [] as string[],
      result: '',
      rejection: ''
    }
    ;(window as typeof window & { __v3DialogState?: typeof state }).__v3DialogState = state
    URL.createObjectURL = (blob: Blob) => {
      const url = nativeCreateObjectUrl(blob)
      state.objectUrls.push(url)
      return url
    }
    URL.revokeObjectURL = (url: string) => {
      state.revokedObjectUrls.push(url)
      nativeRevokeObjectUrl(url)
    }
    const decodeBase64 = (value: string) => {
      const decoded = atob(value)
      return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
    }

    const buildIssue = (nextRepresentation: Representation) => {
      state.identity += 1
      state.representation = nextRepresentation
      const challengeId = `challenge-v3-${state.identity}`
      const envelopeId = `01900000-0000-7000-8000-${String(state.identity).padStart(12, '0')}`
      const issuedAtUnixMs = Date.now() - 1_000
      const expiresAtUnixMs = Date.now() + state.expiresInMs
      const representationValue = nextRepresentation === 'visual'
        ? PerceptionCharacterV3Representation.Visual
        : PerceptionCharacterV3Representation.Audio
      const assignment = {
        challengeId,
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        tenantId: 'tenant-main',
        kind: SecurityChallengeKind.PerceptionCharacterV3,
        escalationLevel: 1,
        action: 'comment.create',
        routeKey: 'article:42',
        subjectHash: 'a'.repeat(64),
        clientIpHash: 'b'.repeat(64),
        deviceFpHash: 'c'.repeat(64),
        issuedAtUnixMs,
        expiresAtUnixMs
      }
      const payload = {
        algorithm: 'fsu.challenge/perception-character-artifact@v3' as const,
        challengeId,
        envelopeId,
        representation: representationValue,
        mediaType: nextRepresentation === 'visual' ? 'image/png' as const : 'audio/ogg; codecs=opus' as const,
        mediaBytes: decodeBase64(nextRepresentation === 'visual' ? visualBase64 : audioBase64),
        physicalWidth: nextRepresentation === 'visual' ? 384 : 0,
        physicalHeight: nextRepresentation === 'visual' ? 144 : 0,
        displayWidth: nextRepresentation === 'visual' ? 320 : 0,
        displayHeight: nextRepresentation === 'visual' ? 120 : 0,
        attemptBudget: 2 as const,
        policyVersion: 'policy-v3',
        issuedAtUnixMs,
        expiresAtUnixMs,
        stateToken: `opaque-state-${state.identity}`
      }
      const response = {
        decision: 'challenge' as const,
        riskScore: 0,
        effectiveRiskScore: 0,
        escalationLevel: 1,
        policyVersion: 'policy-v3',
        retryAfterMs: 0,
        envelope: { envelopeId, policyVersion: 'policy-v3', assignments: [assignment] },
        providerPayloads: []
      }
      return {
        status: 'challenge' as const,
        response,
        assignment,
        providerPayload: { challengeId, payload: {}, perceptionCharacterV3: payload },
        proof: null,
        kindGroup: 'perception' as const,
        capability: null,
        reason: null,
        retryAfterMs: 0
      }
    }

    let current = buildIssue(representation)
    coordinator.challengeClient.issue = async () => current
    coordinator.challengeClient.refresh = async () => {
      state.cancelled.push(current.assignment.challengeId)
      current = buildIssue(state.representation)
      return current
    }
    coordinator.challengeClient.replace = async (_context, nextRepresentation) => {
      const previousId = current.assignment.challengeId
      if (state.replacementOutcome === 'failure') {
        state.cancelled.push(previousId)
        return {
          status: 'failed' as const, response: null, assignment: null, providerPayload: null,
          proof: null, kindGroup: null, capability: null,
          reason: 'security_challenge_issue_failed', retryAfterMs: 0
        }
      }
      if (state.replacementOutcome === 'pending') {
        await new Promise<void>((resolve) => { (window as any).__resolveV3Replacement = resolve })
      }
      current = buildIssue(nextRepresentation)
      state.replacements.push({ from: previousId, to: current.assignment.challengeId })
      return current
    }
    coordinator.challengeClient.verify = async () => {
      if (state.verifyOutcome === 'pending') {
        await new Promise<void>((resolve) => { (window as any).__resolveV3Verify = resolve })
      }
      const verified = state.verifyOutcome === 'verified'
      const reason = verified ? '' : state.verifyOutcome
      const response = {
        verified,
        envelopeId: current.response.envelope.envelopeId,
        challengeId: current.assignment.challengeId,
        kind: SecurityChallengeKind.PerceptionCharacterV3,
        policyVersion: 'policy-v3',
        completedCount: verified ? 1 : 0,
        memberCount: 1,
        envelopeCompleted: verified,
        proofToken: verified ? 'opaque-proof' : '',
        expiresAtUnixMs: verified ? Date.now() + 30_000 : 0,
        reason,
        retryAfterMs: 0
      }
      return { status: verified ? 'verified' : 'failed', response, proof: null, next: null, reason, retryAfterMs: 0 }
    }
    coordinator.challengeClient.reserveProof = () => ({
      proof: {
        action: 'comment.create', routeKey: 'article:42', challengeId: current.assignment.challengeId,
        kind: SecurityChallengeKind.PerceptionCharacterV3, proofToken: 'opaque-proof', policyVersion: 'policy-v3',
        verifiedAtUnixMs: Date.now(), expiresAtUnixMs: Date.now() + 30_000
      },
      markInFlight: () => true,
      settle: () => true
    })
    coordinator.challengeClient.cancelEnvelope = () => state.cancelled.push(current.assignment.challengeId)
    coordinator.challengeClient.clearProof = () => { state.cleared += 1 }

    const trigger = document.createElement('button')
    trigger.dataset.test = 'challenge-source'
    trigger.textContent = 'Protected command'
    document.body.append(trigger)
    trigger.focus()
    void coordinator.run(
      { action: 'comment.create', routeKey: 'article:42' },
      { kind: 'mutation_with_identity', mutationIdentity: 'comment-42' },
      async (proof) => {
        state.commandExecutions += 1
        if (!proof) {
          throw new BinaryTransportError({
            kind: 'http_error',
            message: 'challenge_required',
            riskChallengeFailure: 'required',
            riskChallengeHandoff: {
              decision: 'challenge', action: 'comment.create', routeKey: 'article:42', policyVersion: 'policy-v3'
            }
          })
        }
        return 'resumed'
      }
    ).then((value) => { state.result = value }).catch((error: unknown) => {
      state.rejection = error instanceof Error ? error.message : String(error)
    })
  }, {
    representation,
    expiresInMs,
    visualBase64: mediaVectors.visual.artifactBase64,
    audioBase64: mediaVectors.audio.artifactBase64
  })

  await expect(page.locator('[data-test="security-challenge-dialog-host"]')).toBeVisible()
  await expect(page.locator('[data-fsus-perception-character-challenge="true"]')).toBeVisible()
}

for (const viewport of [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT }
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.name} ${theme} renders visual and audio with refresh`, async ({ page }) => {
      await page.setViewportSize(viewport.size)
      await page.addInitScript((value) => localStorage.setItem('fsus:theme-mode', value), theme)
      await openChallenge(page)

      const dialog = page.locator('[data-test="security-challenge-dialog-host"]')
      await expect(dialog.locator('.el-dialog__title')).toHaveCount(1)
      await expect(dialog.locator('[data-test="perception-character-refresh"]')).toHaveCount(1)
      await expect(dialog.locator('[role="status"][aria-live="polite"]')).toHaveCount(1)
      await expect(dialog.locator('[role="alert"]')).toHaveCount(0)
      await expect(dialog.locator('[data-test="perception-character-raster"]')).toBeVisible()
      await expect(dialog.locator('[data-test="perception-character-raster"]')).toHaveAttribute('src', /^blob:/)
      await expect(dialog.locator('[data-test="perception-character-input"]')).toBeFocused()

      const mediaStyle = await dialog.locator('[data-test="perception-character-raster"]').evaluate((element) => {
        const style = getComputedStyle(element)
        return { filter: style.filter, animation: style.animationName, boxShadow: style.boxShadow }
      })
      expect(['', 'none']).toContain(mediaStyle.filter)
      expect(mediaStyle.animation).toBe('none')
      expect(mediaStyle.boxShadow).toBe('none')

      const beforeRefresh = await page.evaluate(() => (window as any).__v3DialogState.identity)
      await dialog.locator('[data-test="perception-character-refresh"]').click()
      await expect.poll(() => page.evaluate(() => (window as any).__v3DialogState.identity)).toBeGreaterThan(beforeRefresh)
      await expect(dialog.locator('[data-test="perception-character-raster"]')).toBeVisible()

      await dialog.locator('[data-test="perception-character-representation"]').click()
      await expect(dialog.locator('[data-test="perception-character-audio"]')).toBeVisible()
      await expect(dialog.locator('[data-test="perception-character-audio"]')).toHaveJSProperty('paused', true)
      await expect.poll(() => page.evaluate(() =>
        (window as any).__v3DialogState.revokedObjectUrls.length
      )).toBeGreaterThanOrEqual(2)
    })
  }
}

test('retry, reissue, representation replacement and exact-once resume preserve the command', async ({ page }) => {
  await openChallenge(page)
  const input = page.locator('[data-test="perception-character-input"]')
  const submit = page.locator('[data-test="perception-character-submit"]')

  await page.evaluate(() => { (window as any).__v3DialogState.verifyOutcome = 'retryable' })
  await input.fill('wrong')
  await submit.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(page.locator('[data-test="perception-character-retry"]')).toBeVisible()
  await page.locator('[data-test="perception-character-retry"]').click()
  await expect(input).toBeFocused()

  await page.evaluate(() => { (window as any).__v3DialogState.verifyOutcome = 'reissueRequired' })
  await input.fill('wrong-again')
  await submit.click()
  await expect(page.locator('[data-test="perception-character-reissue"]')).toBeVisible()
  const beforeReissue = await page.evaluate(() => (window as any).__v3DialogState.identity)
  await page.locator('[data-test="perception-character-reissue"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).__v3DialogState.identity)).toBeGreaterThan(beforeReissue)
  await expect(input).toHaveValue('')

  const beforeSwitch = await page.evaluate(() => (window as any).__v3DialogState.identity)
  await page.locator('[data-test="perception-character-representation"]').click()
  await expect(page.locator('[data-test="perception-character-audio"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__v3DialogState.identity)).toBeGreaterThan(beforeSwitch)
  await expect(page.locator('[data-test="perception-character-audio"]')).toHaveJSProperty('paused', true)

  await page.evaluate(() => { (window as any).__v3DialogState.verifyOutcome = 'verified' })
  await input.fill('AB12')
  await submit.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(page.locator('[data-test="security-challenge-dialog-host"]')).toBeHidden()
  await expect.poll(() => page.evaluate(() => (window as any).__v3DialogState.result)).toBe('resumed')
  expect(await page.evaluate(() => (window as any).__v3DialogState.commandExecutions)).toBe(2)
  expect(await page.evaluate(() => (window as any).__v3DialogState.replacements[0])).toMatchObject({
    from: expect.stringMatching(/^challenge-v3-/),
    to: expect.stringMatching(/^challenge-v3-/)
  })
  const storageLeak = await page.evaluate(() => {
    const values = [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage)
    ].join('\n')
    return /opaque-(?:proof|state)|blob:/u.test(values)
  })
  expect(storageLeak).toBe(false)
})

test('cancel, Escape and route change revoke the envelope, reject the command and restore focus', async ({ page }) => {
  await openChallenge(page)
  await page.locator('[data-test="security-challenge-cancel"]').click()
  await expect(page.locator('[data-test="security-challenge-dialog-host"]')).toBeHidden()
  await expect(page.locator('[data-test="challenge-source"]')).toBeFocused()
  expect(await page.evaluate(() => (window as any).__v3DialogState.cancelled.length)).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).__v3DialogState.revokedObjectUrls.length)).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).__v3DialogState.rejection)).toContain('risk_challenge_cancelled')

  await openChallenge(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-test="security-challenge-dialog-host"]')).toBeHidden()
  await expect(page.locator('[data-test="challenge-source"]')).toBeFocused()

  await openChallenge(page)
  await page.evaluate(async () => {
    const modulePath = '/src/bootstrap/fullApp.ts'
    const { bootstrapFullApp } = await import(/* @vite-ignore */ modulePath)
    const router = await bootstrapFullApp()
    await router.push('/recover')
  })
  await expect(page.locator('[data-test="security-challenge-dialog-host"]')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__v3DialogState.cancelled.length)).toBeGreaterThan(0)
})

test('replacement failure and abort revoke ownership without resuming the command', async ({ page }) => {
  await openChallenge(page)
  const oldIdentity = await page.evaluate(() => (window as any).__v3DialogState.identity)
  await page.evaluate(() => { (window as any).__v3DialogState.replacementOutcome = 'failure' })
  await page.locator('[data-test="perception-character-representation"]').click()
  await expect(page.locator('[data-test="perception-character-blocking-error"]')).toBeVisible()
  await expect(page.locator('[role="alert"]')).toHaveCount(1)
  await expect(page.locator('[role="status"]')).toHaveText('')
  expect(await page.evaluate(() => (window as any).__v3DialogState.identity)).toBe(oldIdentity)
  expect(await page.evaluate(() => (window as any).__v3DialogState.commandExecutions)).toBe(1)

  await openChallenge(page)
  await page.evaluate(() => { (window as any).__v3DialogState.replacementOutcome = 'pending' })
  await page.locator('[data-test="perception-character-representation"]').click()
  await page.evaluate(async () => {
    const { bootstrapFullApp } = await import(/* @vite-ignore */ '/src/bootstrap/fullApp.ts')
    const router = await bootstrapFullApp()
    await router.push('/recover')
    ;(window as any).__resolveV3Replacement?.()
  })
  await expect(page.locator('[data-test="security-challenge-dialog-host"]')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__v3DialogState.cancelled.length)).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).__v3DialogState.commandExecutions)).toBe(1)
})

test('host unmount ignores a late verify and never resumes the pending command', async ({ page }) => {
  await openChallenge(page)
  await page.evaluate(() => { (window as any).__v3DialogState.verifyOutcome = 'pending' })
  await page.locator('[data-test="perception-character-input"]').fill('AB12')
  await page.locator('[data-test="perception-character-submit"]').click()
  await page.evaluate(async () => {
    const { bootstrapFullApp } = await import(/* @vite-ignore */ '/src/bootstrap/fullApp.ts')
    const router = await bootstrapFullApp()
    await router.push('/recover')
    ;(window as any).__v3DialogState.verifyOutcome = 'verified'
    ;(window as any).__resolveV3Verify?.()
  })
  await expect(page.locator('[data-test="security-challenge-dialog-host"]')).toBeHidden()
  await expect.poll(() => page.evaluate(() => (window as any).__v3DialogState.rejection)).toContain('risk_challenge_cancelled')
  expect(await page.evaluate(() => (window as any).__v3DialogState.commandExecutions)).toBe(1)
})

test('expired, unavailable, keyboard, reduced-motion, forced-colors and zoom paths remain usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  await openChallenge(page)
  await page.keyboard.type('AB12')
  await expect(page.locator('[data-test="perception-character-input"]')).toHaveValue('AB12')

  for (const zoomViewport of [
    { width: 720, height: 480 },
    { width: 360, height: 240 }
  ]) {
    await page.setViewportSize(zoomViewport)
    const inputBox = await page.locator('[data-test="perception-character-input"]').boundingBox()
    const viewport = page.viewportSize()
    expect(inputBox).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(inputBox!.x).toBeGreaterThanOrEqual(0)
    expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(viewport!.width + 1)
  }

  await page.evaluate(() => { (window as any).__v3DialogState.verifyOutcome = 'unavailable' })
  await page.locator('[data-test="perception-character-submit"]').click()
  await expect(page.locator('[data-test="perception-character-blocking-error"]')).toContainText(/暂不可用|unavailable/i)
  await expect(page.locator('[role="alert"]')).toHaveCount(1)
  await expect(page.locator('[role="status"]')).toHaveText('')

  await openChallenge(page, 'visual', 250)
  await expect(page.locator('[data-test="perception-character-reissue"]')).toBeVisible()
  await expect(page.locator('[role="status"]')).toContainText(/过期|expired/i)
})
