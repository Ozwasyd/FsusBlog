import { nextTick, onUnmounted, type MaybeRefOrGetter, toValue, watch } from 'vue'
import { toast } from '@/fsusui/feedback'

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

  const cleanup = (): void => {
    for (const button of insertedButtons) {
      button.remove()
    }
    insertedButtons.clear()
    const root = toValue(contentRoot)
    root?.querySelectorAll<HTMLElement>(`pre[${ENHANCED_ATTR}]`).forEach((pre) => {
      pre.removeAttribute(ENHANCED_ATTR)
      pre.classList.remove('fsus-code-copy-host')
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

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fsus-code-copy-button'
      button.textContent = '复制'
      button.setAttribute('aria-label', '复制代码块')
      button.addEventListener('click', async (event) => {
        event.preventDefault()
        event.stopPropagation()
        try {
          await writeClipboard(source)
          button.textContent = '已复制'
          toast.success('已复制', 1200)
          window.setTimeout(() => {
            button.textContent = '复制'
          }, 1400)
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
