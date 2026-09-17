import os from 'node:os'

import { resolveRuntimeBrowserTimeoutPlan } from '../runtime-browser-timeout.mjs'

const BASELINE_MAX_WAIT_MS = 1_500
const ABSOLUTE_MAX_WAIT_MS = 6_000
const DEADLINE_RESERVE_MS = 250

export function resolveUxViewportRiskMaxWaitMs(
  env = process.env,
  availableCpu = os.availableParallelism?.() ?? os.cpus().length,
  nowMs = Date.now()
) {
  const override = Number(env.FSUSBLOG_UX_SETTLE_MAX_WAIT_MS)
  const timeoutPlan = resolveRuntimeBrowserTimeoutPlan({ env, cpuCount: availableCpu })
  const poolSizeValue = Number(env.FSUSBLOG_UX_VIEWPORT_POOL_SIZE)
  const poolSize = Number.isFinite(poolSizeValue) && poolSizeValue > 0
    ? Math.max(1, Math.floor(poolSizeValue))
    : 1
  const requested = Number.isFinite(override) && override > 0
    ? Math.ceil(override)
    : Math.ceil(BASELINE_MAX_WAIT_MS * timeoutPlan.contentionMultiplier * Math.sqrt(poolSize))
  const bounded = Math.max(1, Math.min(ABSOLUTE_MAX_WAIT_MS, requested))
  const deadlineAtMs = Number(env.FSUSBLOG_STEP_DEADLINE_AT_MS)
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0) return bounded
  const remaining = Math.floor(deadlineAtMs - nowMs)
  return Math.max(1, Math.min(bounded, remaining - DEADLINE_RESERVE_MS))
}

export async function settleUxViewportRiskPage(page, {
  stabilityWindowMs,
  maxWaitMs = resolveUxViewportRiskMaxWaitMs()
} = {}) {
  for (const [label, value] of Object.entries({ maxWaitMs })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`UX viewport risk ${label} must be positive`)
    }
  }
  if (stabilityWindowMs !== undefined
    && (!Number.isFinite(stabilityWindowMs) || stabilityWindowMs <= 0)) {
    throw new Error('UX viewport risk stabilityWindowMs must be positive')
  }

  return await page.evaluate(async ({ stabilityWindowMs: configuredStableForMs, maxWaitMs: waitLimitMs }) => {
    const startedAt = performance.now()
    const deadline = startedAt + waitLimitMs
    const remainingMs = () => Math.max(0, deadline - performance.now())
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const visibleImages = () => Array.from(document.images).filter((image) => {
      const rect = image.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && Boolean(image.currentSrc || image.src)
    })
    const bounded = async (promise, label, required = true) => {
      const timeoutMs = remainingMs()
      if (timeoutMs <= 0) {
        if (!required) return { completed: false, value: undefined }
        throw new Error(`UX viewport risk settle timed out before ${label}`)
      }
      let timer
      try {
        const outcome = await Promise.race([
          promise.then((value) => ({ completed: true, value })),
          new Promise((resolve, reject) => {
            timer = setTimeout(
              () => required
                ? reject(new Error(`UX viewport risk settle timed out during ${label}`))
                : resolve({ completed: false, value: undefined }),
              timeoutMs
            )
          })
        ])
        return outcome
      } finally {
        clearTimeout(timer)
      }
    }
    const layoutSignature = () => {
      const root = document.documentElement
      const body = document.body
      return JSON.stringify({
        viewport: [root.clientWidth, root.clientHeight],
        document: [root.scrollWidth, root.scrollHeight, body?.scrollWidth ?? 0, body?.scrollHeight ?? 0],
        pending: document.querySelectorAll('[aria-busy="true"], [data-loading="true"], .is-loading').length,
        images: visibleImages().map((image) => {
          const rect = image.getBoundingClientRect()
          return [image.currentSrc || image.src, image.complete, image.naturalWidth, image.naturalHeight,
            Math.round(rect.width), Math.round(rect.height)]
        })
      })
    }

    const fontReadiness = {
      status: 'pending',
      elapsedMs: 0,
      error: null
    }
    const images = visibleImages().map((image) => ({
      image,
      url: String(image.currentSrc || image.src).slice(0, 240),
      completeBefore: image.complete,
      naturalWidthBefore: image.naturalWidth,
      naturalHeightBefore: image.naturalHeight,
      status: image.complete && image.naturalWidth > 0 ? 'already-complete' : 'pending',
      elapsedMs: 0,
      error: null
    }))
    const fontsReady = (async () => {
      const fontStartedAt = performance.now()
      try {
        await (document.fonts?.ready ?? Promise.resolve())
        fontReadiness.status = 'ready'
      } catch (error) {
        fontReadiness.status = 'failed'
        fontReadiness.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        fontReadiness.elapsedMs = performance.now() - fontStartedAt
      }
    })()
    const imageDecodes = Promise.all(images.map(async (record) => {
      if (record.status === 'already-complete') return
      const imageStartedAt = performance.now()
      try {
        if (typeof record.image.decode !== 'function') {
          record.status = 'decode-unavailable'
          return
        }
        await record.image.decode()
        record.status = 'decoded'
      } catch (error) {
        record.status = 'decode-failed'
        record.error = error instanceof Error ? error.message : String(error)
      } finally {
        record.elapsedMs = performance.now() - imageStartedAt
      }
    }))
    let readinessComplete = false
    let readinessError = null
    void Promise.all([fontsReady, imageDecodes]).then(
      () => {
        readinessComplete = true
      },
      (error) => {
        readinessError = error
      }
    )
    const throwReadinessError = () => {
      if (readinessError === null) return
      const imageState = images.map((record) => ({
        url: record.url,
        complete: record.image.complete,
        naturalWidth: record.image.naturalWidth,
        status: record.status,
        elapsedMs: Math.round(record.elapsedMs)
      }))
      throw new Error(
        `${readinessError instanceof Error ? readinessError.message : String(readinessError)}`
        + ` (font=${fontReadiness.status}:${Math.round(fontReadiness.elapsedMs)}ms`
        + ` images=${JSON.stringify(imageState)})`
      )
    }
    const readinessSnapshot = () => ({
      font: fontReadiness,
      images: images.map((record) => ({
        url: record.url,
        completeBefore: record.completeBefore,
        naturalWidthBefore: record.naturalWidthBefore,
        naturalHeightBefore: record.naturalHeightBefore,
        completeAfter: record.image.complete,
        naturalWidthAfter: record.image.naturalWidth,
        naturalHeightAfter: record.image.naturalHeight,
        status: record.status,
        elapsedMs: record.elapsedMs,
        error: record.error
      }))
    })
    const firstFrame = await bounded(nextFrame(), 'first animation frame')
    let previous = layoutSignature()
    const secondFrame = await bounded(nextFrame(), 'second animation frame')
    const observedFrameMs = Math.max(1, secondFrame.value - firstFrame.value)
    let stableSince = firstFrame.value
    let stableFrames = 0
    let attempts = 1
    let signatureChanges = 0
    const secondSignature = layoutSignature()
    if (secondSignature === previous) {
      stableFrames = 1
    } else {
      signatureChanges = 1
      stableSince = secondFrame.value
    }
    previous = secondSignature
    const isStable = (frameTimestamp) => readinessComplete && (configuredStableForMs === undefined
      ? stableFrames >= 2
      : frameTimestamp - stableSince >= configuredStableForMs)
    throwReadinessError()
    if (isStable(secondFrame.value)) {
      return {
        stable: true,
        elapsedMs: performance.now() - startedAt,
        visibleImageCount: visibleImages().length,
        observedFrameMs,
        stableForMs: configuredStableForMs ?? null,
        stableFrames,
        attempts,
        signatureChanges,
        readiness: readinessSnapshot()
      }
    }
    while (remainingMs() > 0) {
      const frame = await bounded(nextFrame(), 'layout stability frame', false)
      if (!frame.completed) break
      throwReadinessError()
      attempts += 1
      const current = layoutSignature()
      if (current === previous) {
        stableFrames += 1
        if (isStable(frame.value)) {
          return {
            stable: true,
            elapsedMs: performance.now() - startedAt,
            visibleImageCount: visibleImages().length,
            observedFrameMs,
            stableForMs: configuredStableForMs ?? null,
            stableFrames,
            attempts,
            signatureChanges,
            readiness: readinessSnapshot()
          }
        }
      } else {
        signatureChanges += 1
        stableSince = frame.value
        stableFrames = 0
      }
      previous = current
    }
    throwReadinessError()
    throw new Error(
      `UX viewport risk layout did not stabilize within ${waitLimitMs}ms`
      + ` (attempts=${attempts}, changes=${signatureChanges}, readiness=${readinessComplete ? 'complete' : 'pending'}`
      + `, remainingMs=${Math.round(remainingMs())})`
    )
  }, { stabilityWindowMs, maxWaitMs })
}
