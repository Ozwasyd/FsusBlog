import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { requestHumanReadChallenge, submitHumanReadProof, type HumanReadChallenge, type HumanReadScope } from '@/api/readProof'

type HumanReadProofOptions = {
  scope: ComputedRef<HumanReadScope>
  routeKey: ComputedRef<string>
  articleId?: ComputedRef<number | null>
  enabled?: ComputedRef<boolean>
}

const RETRY_SUBMIT_DELAY_MS = 1000
const READABLE_ROOT_VISIBLE_THRESHOLD = 0.25
const CHALLENGE_REQUEST_DEFER_MS = 0

function isHumanReadProofSuppressed(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }

  const runtimeWindow = window as typeof window & {
    __FSUSBLOG_DISABLE_HUMAN_READ_PROOF__?: boolean
  }

  return runtimeWindow.__FSUSBLOG_DISABLE_HUMAN_READ_PROOF__ === true
    || document.documentElement.dataset.fsusDisableHumanReadProof === 'true'
}

export function useHumanReadProof(options: HumanReadProofOptions): void {
  const enabled = computed(() => (options.enabled?.value ?? true) && !isHumanReadProofSuppressed())
  const visible = ref(false)
  const rootIntersecting = ref(false)
  const challenge = ref<HumanReadChallenge | null>(null)
  const submittedKeys = new Set<string>()
  let abortController: AbortController | null = null
  let submitTimer: ReturnType<typeof setTimeout> | null = null
  let visibleSince = -1
  let dwellMs = 0
  let observer: IntersectionObserver | null = null
  let observedTarget: Element | null = null
  let challengeRequestTimer: ReturnType<typeof setTimeout> | null = null
  let challengeRequestStarted = false
  let challengeRequestFinished = false
  let fallbackVisibilityBound = false
  let runtimeVersion = 0

  const currentKey = computed(() => [
    options.scope.value,
    options.routeKey.value,
    options.articleId?.value ?? 0
  ].join(':'))

  const resetRuntime = (): void => {
    runtimeVersion += 1
    abortController?.abort()
    abortController = null
    challenge.value = null
    visible.value = false
    rootIntersecting.value = false
    visibleSince = -1
    dwellMs = 0
    challengeRequestStarted = false
    challengeRequestFinished = false
    observedTarget = null
    clearChallengeRequestTimer()
    clearSubmitTimer()
    observer?.disconnect()
    observer = null
    unbindFallbackVisibility()
  }

  const clearSubmitTimer = (): void => {
    if (!submitTimer) {
      return
    }

    clearTimeout(submitTimer)
    submitTimer = null
  }

  const clearChallengeRequestTimer = (): void => {
    if (!challengeRequestTimer) {
      return
    }

    clearTimeout(challengeRequestTimer)
    challengeRequestTimer = null
  }

  const resolveMainElement = (): Element | null => {
    if (typeof document === 'undefined') {
      return null
    }

    return document.querySelector('[data-human-read-root]')
      ?? document.querySelector('main')
      ?? document.getElementById('app')
  }

  const updateVisibility = (nextVisible: boolean): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      nextVisible = false
    }

    if (visible.value === nextVisible) {
      if (nextVisible) {
        scheduleChallengeRequest()
      }
      return
    }

    visible.value = nextVisible
    if (nextVisible) {
      visibleSince = performance.now()
      scheduleChallengeRequest()
      scheduleSubmitCheck()
      return
    }

    clearChallengeRequestTimer()
    if (visibleSince >= 0) {
      dwellMs += Math.max(0, performance.now() - visibleSince)
      visibleSince = -1
    }

    scheduleSubmitCheck()
  }

  const currentDwellMs = (): number => {
    if (!visible.value || visibleSince < 0) {
      return Math.trunc(dwellMs)
    }

    return Math.trunc(dwellMs + Math.max(0, performance.now() - visibleSince))
  }

  const submitIfReady = async (): Promise<void> => {
    const activeChallenge = challenge.value
    if (!activeChallenge || submittedKeys.has(currentKey.value)) {
      return
    }

    const dwell = currentDwellMs()
    if (dwell < activeChallenge.minDwellMs) {
      scheduleSubmitCheck()
      return
    }

    clearSubmitTimer()
    submittedKeys.add(currentKey.value)
    try {
      await submitHumanReadProof({
        token: activeChallenge.token,
        scope: options.scope.value,
        routeKey: options.routeKey.value,
        articleId: options.articleId?.value ?? null,
        dwellMs: dwell,
        signal: abortController?.signal
      })
    } catch (error) {
      submittedKeys.delete(currentKey.value)
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.debug('[HumanReadProof] submit skipped:', error)
        scheduleSubmitCheck(RETRY_SUBMIT_DELAY_MS)
      }
    }
  }

  const scheduleSubmitCheck = (delayOverrideMs?: number): void => {
    const activeChallenge = challenge.value
    if (!activeChallenge || submittedKeys.has(currentKey.value) || !visible.value || typeof setTimeout === 'undefined') {
      clearSubmitTimer()
      return
    }

    const remainingMs = Math.max(0, activeChallenge.minDwellMs - currentDwellMs())
    clearSubmitTimer()
    submitTimer = setTimeout(() => {
      submitTimer = null
      void submitIfReady()
    }, delayOverrideMs ?? remainingMs)
  }

  const resolveChallengeRequest = (): {
    scope: HumanReadScope
    routeKey: string
    articleId: number | null
  } | null => {
    const routeKey = options.routeKey.value.trim()
    if (!routeKey || options.scope.value === 'article' && !(options.articleId?.value && options.articleId.value > 0)) {
      return null
    }

    return {
      scope: options.scope.value,
      routeKey,
      articleId: options.articleId?.value ?? null
    }
  }

  const requestChallenge = async (): Promise<void> => {
    if (challenge.value || challengeRequestStarted || challengeRequestFinished || submittedKeys.has(currentKey.value)) {
      return
    }

    const request = resolveChallengeRequest()
    if (!request) {
      return
    }

    challengeRequestStarted = true
    const requestVersion = runtimeVersion
    const controller = abortController ?? new AbortController()
    abortController = controller
    try {
      const response = await requestHumanReadChallenge({
        scope: request.scope,
        routeKey: request.routeKey,
        articleId: request.articleId,
        signal: controller.signal
      })
      if (requestVersion !== runtimeVersion || controller.signal.aborted) {
        return
      }

      challenge.value = response
      if (!challenge.value.token) {
        challenge.value = null
        challengeRequestFinished = true
        return
      }
      challengeRequestFinished = true
      scheduleSubmitCheck()
    } catch (error) {
      if (requestVersion !== runtimeVersion) {
        return
      }
      challengeRequestFinished = true
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.debug('[HumanReadProof] challenge skipped:', error)
      }
    } finally {
      if (requestVersion === runtimeVersion) {
        challengeRequestStarted = false
      }
    }
  }

  const scheduleChallengeRequest = (): void => {
    if (!visible.value || challenge.value || challengeRequestStarted || challengeRequestFinished || challengeRequestTimer || typeof setTimeout === 'undefined') {
      return
    }

    challengeRequestTimer = setTimeout(() => {
      challengeRequestTimer = null
      void requestChallenge()
    }, CHALLENGE_REQUEST_DEFER_MS)
  }

  const calculateVisibleRatio = (target: Element): number => {
    if (typeof window === 'undefined') {
      return 0
    }

    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return 0
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0))
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0))
    return (visibleWidth * visibleHeight) / (rect.width * rect.height)
  }

  const evaluateFallbackVisibility = (): void => {
    if (!observedTarget) {
      rootIntersecting.value = false
      updateVisibility(false)
      return
    }

    rootIntersecting.value = calculateVisibleRatio(observedTarget) >= READABLE_ROOT_VISIBLE_THRESHOLD
    updateVisibility(rootIntersecting.value)
  }

  const bindFallbackVisibility = (target: Element): void => {
    observedTarget = target
    if (fallbackVisibilityBound) {
      evaluateFallbackVisibility()
      return
    }

    fallbackVisibilityBound = true
    window.addEventListener('scroll', evaluateFallbackVisibility, { passive: true })
    window.addEventListener('resize', evaluateFallbackVisibility)
    evaluateFallbackVisibility()
  }

  const unbindFallbackVisibility = (): void => {
    if (!fallbackVisibilityBound || typeof window === 'undefined') {
      fallbackVisibilityBound = false
      return
    }

    window.removeEventListener('scroll', evaluateFallbackVisibility)
    window.removeEventListener('resize', evaluateFallbackVisibility)
    fallbackVisibilityBound = false
  }

  const begin = async (): Promise<void> => {
    resetRuntime()
    if (!enabled.value || typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const request = resolveChallengeRequest()
    if (!request) {
      return
    }

    abortController = new AbortController()
    await nextTick()
    const target = resolveMainElement()
    if (!target || abortController.signal.aborted) {
      return
    }

    observedTarget = target
    if (typeof IntersectionObserver === 'undefined') {
      bindFallbackVisibility(target)
      return
    }

    observer = new IntersectionObserver((entries) => {
      rootIntersecting.value = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= READABLE_ROOT_VISIBLE_THRESHOLD)
      updateVisibility(rootIntersecting.value)
    }, { threshold: [0, READABLE_ROOT_VISIBLE_THRESHOLD, 0.5, 1] })
    observer.observe(target)
  }

  const handleVisibilityChange = (): void => {
    if (typeof IntersectionObserver === 'undefined' && observedTarget) {
      evaluateFallbackVisibility()
      return
    }

    updateVisibility(rootIntersecting.value)
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange)
    void begin()
  })

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    resetRuntime()
  })

  watch(currentKey, () => {
    void begin()
  })

  watch(enabled, () => {
    void begin()
  })
}
