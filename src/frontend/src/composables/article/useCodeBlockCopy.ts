import { nextTick, onUnmounted, type MaybeRefOrGetter, toValue, watch } from 'vue'
import { toast } from '@/fsusui/feedback'
import { fsusBlogScrollRevealOptions, useScrollReveal } from '@/fsusui/motion'

const ENHANCED_ATTR = 'data-fsus-code-copy'

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) {
    throw new Error('copy rejected')
  }
}

export function useCodeBlockCopy(contentRoot: MaybeRefOrGetter<HTMLElement | null>) {
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

    root.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
      if (pre.hasAttribute(ENHANCED_ATTR)) {
        return
      }

      const code = pre.querySelector<HTMLElement>('code')
      const source = code?.textContent ?? pre.textContent ?? ''
      pre.setAttribute(ENHANCED_ATTR, 'true')
      pre.classList.add('fsus-code-copy-host')
      pre.setAttribute('data-fsus-motion-surface', 'article-code-block')
      revealControls.reveal(pre, fsusBlogScrollRevealOptions)

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fsus-code-copy-button blog-motion-reading-control'
      button.textContent = '复制'
      button.setAttribute('aria-label', '复制代码块')
      button.setAttribute('aria-live', 'polite')
      button.addEventListener('click', async (event) => {
        event.preventDefault()
        event.stopPropagation()
        try {
          await writeClipboard(source)
          button.textContent = '已复制'
          button.setAttribute('aria-label', '代码已复制')
          button.classList.add('fsus-code-copy-button--copied')
          toast.success('已复制', 1200)
          const previousTimer = resetTimers.get(button)
          if (previousTimer) {
            globalThis.clearTimeout(previousTimer)
          }
          const resetTimer = globalThis.setTimeout(() => {
            button.textContent = '复制'
            button.setAttribute('aria-label', '复制代码块')
            button.classList.remove('fsus-code-copy-button--copied')
            resetTimers.delete(button)
          }, 1400)
          resetTimers.set(button, resetTimer)
        } catch {
          toast.error('复制失败', 2200)
        }
      })

      pre.appendChild(button)
      insertedButtons.add(button)
    })
  }

  watch(() => toValue(contentRoot), () => {
    cleanup()
    void enhance()
  }, { flush: 'post' })

  onUnmounted(cleanup)

  return {
    refresh: enhance,
    cleanup
  }
}
