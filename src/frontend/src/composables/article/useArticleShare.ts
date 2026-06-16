import { computed, getCurrentInstance, onMounted, ref, type MaybeRefOrGetter, toValue } from 'vue'
import { toast } from '@/fsusui/feedback'

type ShareInput = Readonly<{
  title: MaybeRefOrGetter<string>
  canonicalUrl: MaybeRefOrGetter<string | null | undefined>
}>

function currentArticleUrl(): string {
  if (typeof window === 'undefined') {
    return ''
  }
  return window.location.href.split('#')[0] || window.location.href
}

async function copyToClipboard(text: string): Promise<void> {
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
    throw new Error('clipboard copy rejected')
  }
}

export function useArticleShare(input: ShareInput) {
  const mountedDocumentTitle = ref('')

  if (getCurrentInstance()) {
    onMounted(() => {
      mountedDocumentTitle.value = typeof document !== 'undefined' ? document.title : ''
    })
  }

  const shareUrl = computed(() => toValue(input.canonicalUrl)?.trim() || currentArticleUrl())
  const shareTitle = computed(() => toValue(input.title)?.trim() || mountedDocumentTitle.value || '文章')

  const copyLink = async (): Promise<void> => {
    try {
      await copyToClipboard(shareUrl.value)
      toast.success('链接已复制', 1800)
    } catch {
      toast.error('复制失败', 2200)
    }
  }

  const shareOrCopy = async (): Promise<void> => {
    const canShare = typeof navigator !== 'undefined'
      && typeof navigator.share === 'function'

    if (canShare) {
      try {
        await navigator.share({
          title: shareTitle.value,
          url: shareUrl.value
        })
        return
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') {
          return
        }
      }
    }

    await copyLink()
  }

  return {
    shareUrl,
    copyLink,
    shareOrCopy
  }
}
