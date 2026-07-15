export type PublicTakeoverSnapshotOptions = Readonly<{
  source?: HTMLElement | null
  reducedMotion?: boolean
  zIndex?: number
}>

export type PublicTakeoverSnapshot = Readonly<{
  element: HTMLElement
  reveal(): Promise<void>
  remove(): void
}>

const SNAPSHOT_FADE_MS = 160

function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function resolveSnapshotSource(source?: HTMLElement | null): HTMLElement | null {
  if (source) {
    return source
  }

  return document.getElementById('fsus-aot-shell')
}

export function createPublicTakeoverSnapshot(
  options: PublicTakeoverSnapshotOptions = {}
): PublicTakeoverSnapshot | null {
  const source = resolveSnapshotSource(options.source)
  if (!source || !document.body) {
    return null
  }

  const reducedMotion = options.reducedMotion ?? prefersReducedMotion()
  const overlay = document.createElement('div')
  overlay.dataset.publicTakeoverSnapshot = 'true'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.setAttribute('inert', '')
  ;(overlay as HTMLElement & { inert?: boolean }).inert = true
  overlay.classList.add('fsus-public-takeover-snapshot')
  const overlayStyle = createCspStyleBinding(overlay, {
    zIndex: String(options.zIndex ?? 2147483000),
    opacity: '1',
    transition: reducedMotion ? 'none' : `opacity ${SNAPSHOT_FADE_MS}ms ease`
  }, 'public-takeover-overlay')

  const clone = source.cloneNode(true) as HTMLElement
  clone.dataset.publicTakeoverSnapshotClone = 'true'
  clone.setAttribute('aria-hidden', 'true')
  clone.setAttribute('inert', '')
  ;(clone as HTMLElement & { inert?: boolean }).inert = true
  clone.classList.add('fsus-public-takeover-snapshot__clone')
  const cloneStyle = createCspStyleBinding(clone, {
    width: `${window.innerWidth || document.documentElement.clientWidth}px`,
    minHeight: `${window.innerHeight || document.documentElement.clientHeight}px`,
    transform: `translate3d(0, -${Math.max(0, window.scrollY || window.pageYOffset || 0)}px, 0)`
  }, 'public-takeover-clone')

  overlay.append(clone)
  document.body.append(overlay)

  let removed = false
  const remove = (): void => {
    if (removed) {
      return
    }

    removed = true
    overlayStyle.dispose()
    cloneStyle.dispose()
    overlay.remove()
  }

  const reveal = async (): Promise<void> => {
    if (reducedMotion) {
      overlayStyle.update({
        zIndex: String(options.zIndex ?? 2147483000),
        opacity: '1',
        transition: 'none'
      })
      remove()
      return
    }

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        overlay.removeEventListener('transitionend', onTransitionEnd)
        window.clearTimeout(fallback)
        remove()
        resolve()
      }
      const onTransitionEnd = (event: TransitionEvent): void => {
        if (event.target === overlay) {
          finish()
        }
      }
      const fallback = window.setTimeout(finish, SNAPSHOT_FADE_MS + 80)
      overlay.addEventListener('transitionend', onTransitionEnd)
      window.requestAnimationFrame(() => {
        overlayStyle.update({
          zIndex: String(options.zIndex ?? 2147483000),
          opacity: '0',
          transition: `opacity ${SNAPSHOT_FADE_MS}ms ease`
        })
      })
    })
  }

  return {
    element: overlay,
    reveal,
    remove
  }
}
import { createCspStyleBinding } from '@/services/cspStyleRuntime'
