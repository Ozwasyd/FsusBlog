import { nextTick, onUnmounted, type MaybeRefOrGetter, toValue, watch } from 'vue'
import { toast } from '@/fsusui/feedback'
import { fsusBlogScrollRevealOptions } from '@/fsusui/blogMotion'
import { activeLocale, translate } from '@/locales'
import { useScrollReveal } from '@ozwasyd/element-plus/motion'

const ENHANCED_ATTR = 'data-fsus-code-copy'

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.className = 'fsus-clipboard-fallback'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) {
    throw new Error('copy rejected')
  }
}

export function useCodeBlockCopy(
  contentRoot: MaybeRefOrGetter<HTMLElement | null>,
  allowCodeCopy: MaybeRefOrGetter<boolean> = true
) {
  const insertedButtons = new Set<HTMLButtonElement>()
  const resetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()
  const revealControls = useScrollReveal({ ...fsusBlogScrollRevealOptions })

  const cleanup = (): void => {
    revealControls.kill()
    for (const button of insertedButtons) {
      const resetTimer = resetTimers.get(button)
      if (resetTimer) {
        globalThis.clearTimeout(resetTimer)
        resetTimers.delete(button)
      }
      button.remove()
    }
    insertedButtons.clear()
    const root = toValue(contentRoot)
    root?.querySelectorAll<HTMLElement>(`pre[${ENHANCED_ATTR}]`).forEach((pre) => {
      pre.removeAttribute(ENHANCED_ATTR)
      pre.classList.remove('fsus-code-copy-host')
      pre.removeAttribute('data-fsus-motion-surface')
    })
  }

  const enhance = async (): Promise<void> => {
    await nextTick()
    const root = toValue(contentRoot)
    if (!root) {
      cleanup()
      return
    }
    if (!toValue(allowCodeCopy)) {
      cleanup()
      return
    }

    root.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
      if (pre.hasAttribute(ENHANCED_ATTR)) {
        return
      }

      const code = pre.querySelector<HTMLElement>('code')
      const source = code?.textContent ?? pre.textContent ?? ''
      pre.setAttribute(ENHANCED_ATTR, 'true')
      pre.classList.add('fsus-code-copy-host')
      pre.setAttribute('data-fsus-motion-surface', 'article-code-block')

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fsus-code-copy-button blog-motion-reading-control'
      button.textContent = translate('article.actions.copyCode')
      button.setAttribute('aria-label', translate('article.actions.copyCode'))
      button.setAttribute('aria-live', 'polite')
      button.addEventListener('click', async (event) => {
        event.preventDefault()
        event.stopPropagation()
        try {
          await writeClipboard(source)
          button.textContent = translate('article.actions.codeCopied')
          button.setAttribute('aria-label', translate('article.actions.codeCopied'))
          button.classList.add('fsus-code-copy-button--copied')
          toast.success(translate('article.actions.codeCopied'), 1200)
          const previousTimer = resetTimers.get(button)
          if (previousTimer) {
            globalThis.clearTimeout(previousTimer)
          }
          const resetTimer = globalThis.setTimeout(() => {
            button.textContent = translate('article.actions.copyCode')
            button.setAttribute('aria-label', translate('article.actions.copyCode'))
            button.classList.remove('fsus-code-copy-button--copied')
            resetTimers.delete(button)
          }, 1400)
          resetTimers.set(button, resetTimer)
        } catch {
          toast.error(translate('article.actions.copyFailed'), 2200)
        }
      })

      pre.appendChild(button)
      insertedButtons.add(button)
      try {
        revealControls.reveal(pre, fsusBlogScrollRevealOptions)
      } catch {
        // Copy is a content right and must remain usable when motion is unavailable.
        pre.removeAttribute('data-fsus-motion-surface')
      }
    })
  }

  watch(() => [toValue(contentRoot), toValue(allowCodeCopy), activeLocale.value] as const, () => {
    cleanup()
    void enhance()
  }, { flush: 'post' })

  onUnmounted(cleanup)

  return {
    refresh: enhance,
    cleanup
  }
}
