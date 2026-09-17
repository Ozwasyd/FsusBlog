import { expect, test } from '@playwright/test'
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from '../../support/playwright/acceptance-shared'
import vector from '../../../fixtures/security/pospace-v1-vector.json' with { type: 'json' }

const providerPayload = {
  ...vector.providerPayload
}

const mobileHeavyPayload = {
  ...providerPayload,
  memoryKib: '19456'
}

const assignment = {
  ...vector.assignment
}

test.describe('Argon2idPoSpaceV1 worker harness', () => {
  test.use({ viewport: DESKTOP_VIEWPORT })

  test('solves inside a worker without blocking the page tick loop', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(async ({ payload, assignment, vector }) => {
      const modulePath = '/src/services/securityPoSpaceClient.ts'
      const { createPoSpaceWorkerClient } = await import(/* @vite-ignore */ modulePath)
      const client = createPoSpaceWorkerClient(30_000)
      let ticks = 0
      const interval = window.setInterval(() => {
        ticks += 1
      }, 0)

      try {
        const solved = await client.solve(assignment, payload, {
          nonceHex: vector.nonceHex,
          hints: {
            hardwareConcurrency: 4,
            deviceMemoryGb: 8,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
          }
        })
        window.clearInterval(interval)
        return {
          solved,
          ticks
        }
      } finally {
        window.clearInterval(interval)
        client.dispose()
      }
    }, { payload: providerPayload, assignment, vector })

    expect(result.solved.ok).toBe(true)
    expect(result.ticks).toBeGreaterThan(0)
    if (result.solved.ok) {
      expect(result.solved.proofHex).toBe(vector.expectedProofHex)
      expect(result.solved.nonceHex).toBe(vector.nonceHex)
    }
  })
})

test.describe('Argon2idPoSpaceV1 mobile and failure gates', () => {
  test.use({ viewport: MOBILE_VIEWPORT })

  test('returns unsupported for mobile memory cap, forced slow device, and worker failure', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(async ({ heavyPayload, payload, assignment, nonceHex }) => {
      const modulePath = '/src/services/securityPoSpaceClient.ts'
      const { createPoSpaceWorkerClient } = await import(/* @vite-ignore */ modulePath)
      const client = createPoSpaceWorkerClient(30_000)
      try {
        const mobileCap = await client.solve(assignment, heavyPayload, {
          nonceHex,
          hints: {
            hardwareConcurrency: 6,
            deviceMemoryGb: 8,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
          }
        })
        const slowDevice = await client.solve(assignment, payload, {
          nonceHex,
          hints: {
            hardwareConcurrency: 4,
            deviceMemoryGb: 8,
            forceSlowDevice: true
          }
        })
        let workerFailure = ''
        try {
          await client.capability(payload, { forceWorkerFailure: true })
        } catch (error) {
          workerFailure = error instanceof Error ? error.message : String(error)
        }
        return {
          mobileCap,
          slowDevice,
          workerFailure
        }
      } finally {
        client.dispose()
      }
    }, { heavyPayload: mobileHeavyPayload, payload: providerPayload, assignment, nonceHex: vector.nonceHex })

    expect(result.mobileCap.ok).toBe(false)
    if (!result.mobileCap.ok) {
      expect(result.mobileCap.reason).toBe('mobile_memory_cap')
      expect(result.mobileCap.unsupported).toBe(true)
    }
    expect(result.slowDevice.ok).toBe(false)
    if (!result.slowDevice.ok) {
      expect(result.slowDevice.reason).toBe('slow_device')
    }
    expect(result.workerFailure).toContain('pospace_forced_worker_failure')
  })
})
