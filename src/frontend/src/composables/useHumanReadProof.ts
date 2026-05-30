import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { requestHumanReadChallenge, submitHumanReadProof, type HumanReadChallenge, type HumanReadScope } from '@/api/readProof'

type HumanReadProofOptions = {
  scope: ComputedRef<HumanReadScope>
  routeKey: ComputedRef<string>
  articleId?: ComputedRef<number | null>
  enabled?: ComputedRef<boolean>
}

const RETRY_SUBMIT_DELAY_MS = 1000

export function useHumanReadProof(options: HumanReadProofOptions): void {
  const enabled = computed(() => options.enabled?.value ?? true)
  const visible = ref(false)
  const rootIntersecting = ref(false)
  const challenge = ref<HumanReadChallenge | null>(null)
  const submittedKeys = new Set<string>()
  let abortController: AbortController | null = null
  let submitTimer: ReturnType<typeof setTimeout> | null = null
  let visibleSince = -1
  let dwellMs = 0
  let observer: IntersectionObserver | null = null

  const currentKey = computed(() => [
    options.scope.value,
    options.routeKey.value,
    options.articleId?.value ?? 0
  ].join(':'))

  const resetRuntime = (): void => {
    abortController?.abort()
    abortController = null
    challenge.value = null
    visible.value = false
    rootIntersecting.value = false
    visibleSince = -1
    dwellMs = 0
    clearSubmitTimer()
    observer?.disconnect()
    observer = null
  }

  const clearSubmitTimer = (): void => {
    if (!submitTimer) {
      return
    }

    clearTimeout(submitTimer)
    submitTimer = null
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
      return
    }

    visible.value = nextVisible
    if (nextVisible) {
      visibleSince = performance.now()
      scheduleSubmitCheck()
      return
    }

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

  const begin = async (): Promise<void> => {
    resetRuntime()
    if (!enabled.value || typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const routeKey = options.routeKey.value.trim()
    if (!routeKey || options.scope.value === 'article' && !(options.articleId?.value && options.articleId.value > 0)) {
      return
    }

    abortController = new AbortController()
    try {
      challenge.value = await requestHumanReadChallenge({
        scope: options.scope.value,
        routeKey,
        articleId: options.articleId?.value ?? null,
        signal: abortController.signal
      })
      if (!challenge.value.token) {
        challenge.value = null
        return
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.debug('[HumanReadProof] challenge skipped:', error)
      }
      return
    }

    await nextTick()
    const target = resolveMainElement()
    if (!target || abortController.signal.aborted) {
      return
    }

    observer = new IntersectionObserver((entries) => {
      rootIntersecting.value = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.25)
      updateVisibility(rootIntersecting.value)
    }, { threshold: [0, 0.25, 0.5, 1] })
    observer.observe(target)
  }

  const handleVisibilityChange = (): void => {
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
