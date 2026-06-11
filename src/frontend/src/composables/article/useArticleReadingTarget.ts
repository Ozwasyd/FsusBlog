import { resolveMotionScrollBehavior } from '@/composables/useMotionPreference'

export const ARTICLE_READING_TARGET_CLASS = 'blog-motion-reading-target'

const highlightTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

function focusReadingTarget(target: HTMLElement): void {
  const hadTabIndex = target.hasAttribute('tabindex')
  if (!hadTabIndex) {
    target.setAttribute('tabindex', '-1')
  }

  target.focus({ preventScroll: true })
  if (!hadTabIndex) {
    target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
  }
}

export function highlightArticleReadingTarget(target: HTMLElement, settleMs = 1_600): void {
  const existingTimer = highlightTimers.get(target)
  if (existingTimer) {
    globalThis.clearTimeout(existingTimer)
  }

  target.classList.remove(ARTICLE_READING_TARGET_CLASS)
  void target.offsetWidth
  target.classList.add(ARTICLE_READING_TARGET_CLASS)

  const timer = globalThis.setTimeout(() => {
    target.classList.remove(ARTICLE_READING_TARGET_CLASS)
    highlightTimers.delete(target)
  }, settleMs)
  highlightTimers.set(target, timer)
}

export function scrollToArticleTarget(target: HTMLElement, offset = 88): void {
  if (typeof window === 'undefined') {
    return
  }

  window.scrollTo({
    top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - offset),
    behavior: resolveMotionScrollBehavior()
  })
  focusReadingTarget(target)
  highlightArticleReadingTarget(target)
}
