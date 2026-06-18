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
  overlay.style.position = 'fixed'
  overlay.style.inset = '0px'
  overlay.style.overflow = 'hidden'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = String(options.zIndex ?? 2147483000)
  overlay.style.opacity = '1'
  overlay.style.background = 'transparent'
  overlay.style.contain = 'paint'
  overlay.style.transition = reducedMotion ? 'none' : `opacity ${SNAPSHOT_FADE_MS}ms ease`

  const clone = source.cloneNode(true) as HTMLElement
  clone.dataset.publicTakeoverSnapshotClone = 'true'
  clone.setAttribute('aria-hidden', 'true')
  clone.setAttribute('inert', '')
  ;(clone as HTMLElement & { inert?: boolean }).inert = true
  clone.style.pointerEvents = 'none'
  clone.style.width = `${window.innerWidth || document.documentElement.clientWidth}px`
  clone.style.minHeight = `${window.innerHeight || document.documentElement.clientHeight}px`
  clone.style.transform = `translate3d(0, -${Math.max(0, window.scrollY || window.pageYOffset || 0)}px, 0)`
  clone.style.transformOrigin = 'top left'

  overlay.append(clone)
  document.body.append(overlay)

  let removed = false
  const remove = (): void => {
    if (removed) {
      return
    }

    removed = true
    overlay.remove()
  }

  const reveal = async (): Promise<void> => {
    if (reducedMotion) {
      overlay.style.transition = 'none'
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
        overlay.style.opacity = '0'
      })
    })
  }

  return {
    element: overlay,
    reveal,
    remove
  }
}
