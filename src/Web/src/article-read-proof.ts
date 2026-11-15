import { watch, type Ref } from 'vue'
import { requestArticleReadChallenge, submitArticleReadProof } from '../../Contracts/article-read'

type ArticleCoordinate = { id: number; publication: bigint }

const submissionClockMarginMs = 250

export function useArticleReadProof(body: Readonly<Ref<HTMLElement | null>>, article: () => ArticleCoordinate | undefined) {
  if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined' ||
      !document.head.querySelector('meta[name="fsus-article-read-proof"][content="enabled"]')) return

  let activeArticle: ArticleCoordinate | undefined
  let challengeRequested = false

  watch([body, article], ([element, coordinate], _, onCleanup) => {
    if (!element || !coordinate || coordinate.id <= 0 || coordinate.publication <= 0n) return

    const { id, publication } = coordinate
    if (!activeArticle || activeArticle.id !== id || activeArticle.publication !== publication) {
      activeArticle = { id, publication }
      challengeRequested = false
    }
    if (challengeRequested) return

    const request = new AbortController()
    const { signal } = request
    let intersecting = false
    let challenge: Awaited<ReturnType<typeof requestArticleReadChallenge>> | undefined
    let visibleSince: number | undefined
    let elapsed = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let submitted = false

    function pause(now: number) {
      if (visibleSince === undefined) return
      elapsed += Math.max(0, now - visibleSince)
      visibleSince = undefined
    }

    function readIntersection(entries: IntersectionObserverEntry[]) {
      for (const entry of entries) {
        intersecting = entry.isIntersecting && entry.intersectionRatio > 0
        if (!intersecting) pause(entry.time)
      }
    }

    function update() {
      clearTimeout(timer)
      if (signal.aborted || submitted || body.value !== element || article() !== coordinate) return

      readIntersection(observer.takeRecords())
      const now = performance.now()
      if (!intersecting || document.visibilityState !== 'visible') {
        pause(now)
        return
      }

      if (!challenge) {
        if (challengeRequested) return
        challengeRequested = true
        void requestArticleReadChallenge(id, publication, signal).then(result => {
          if (signal.aborted) return
          challenge = result
          update()
        }).catch(() => undefined)
        return
      }

      visibleSince ??= now
      const dwell = elapsed + now - visibleSince
      const remaining = challenge.minDwellMs + submissionClockMarginMs - dwell
      if (remaining > 0) {
        timer = setTimeout(update, Math.ceil(remaining))
        return
      }

      submitted = true
      const { ticket } = challenge
      challenge = undefined
      stopObserving()
      void submitArticleReadProof(id, publication, ticket, Math.floor(dwell), signal).catch(() => undefined)
    }

    const observer = new IntersectionObserver(entries => {
      readIntersection(entries)
      update()
    }, { threshold: [0, Number.EPSILON] })

    function stopObserving() {
      clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', update)
    }

    function stop() {
      stopObserving()
      challenge = undefined
      window.removeEventListener('pagehide', stop)
      request.abort()
    }

    onCleanup(stop)
    window.addEventListener('pagehide', stop)
    document.addEventListener('visibilitychange', update)
    observer.observe(element)
  }, { flush: 'post' })
}
