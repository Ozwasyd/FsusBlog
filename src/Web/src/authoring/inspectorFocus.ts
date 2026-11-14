export type InspectorHost = 'pane' | 'drawer'
export type FocusReturn = 'restored' | 'unavailable' | 'cancelled'

export interface InspectorPresentation {
    // Bind both callbacks to this presentation's host and opening.
    close(): boolean
    closed(): Promise<FocusReturn>
}

interface FocusPorts<T> {
    externalLauncher(host: InspectorHost): T | null
    restore(target: T): boolean
    afterRender(restore: () => void): () => void
}

/**
 * Keep one focus owner across responsive presentations. For Drawer, use the
 * public close and closed events. The subsequent model=false is an acknowledgement.
 */
export function createInspectorFocus<T>(ports: FocusPorts<T>) {
    let generation = 0
    let phase: 'idle' | 'open' | 'closing' = 'idle'
    let opener: T | null = null
    let disposed = false
    let pending: { result: Promise<FocusReturn>; cancel(): void } | null = null

    function cancelPending() {
        const previous = pending
        pending = null
        previous?.cancel()
    }

    function bind(host: InspectorHost): InspectorPresentation {
        const owner = ++generation
        return {
            close() {
                if (owner !== generation || phase !== 'open') return false
                phase = 'closing'
                return true
            },
            closed() {
                if (owner !== generation || phase !== 'closing') {
                    return Promise.resolve('cancelled')
                }
                if (pending !== null) return pending.result

                let settle!: (result: FocusReturn) => void
                const result = new Promise<FocusReturn>((resolve) => { settle = resolve })
                let cancelFrame: (() => void) | undefined
                pending = {
                    result,
                    cancel() {
                        cancelFrame?.()
                        settle('cancelled')
                    },
                }
                cancelFrame = ports.afterRender(() => {
                    if (owner !== generation || phase !== 'closing') return
                    phase = 'idle'
                    pending = null
                    const exact = opener
                    opener = null
                    let restored = exact !== null && ports.restore(exact)
                    if (!restored && owner === generation) {
                        const fallback = ports.externalLauncher(host)
                        restored = fallback !== null && fallback !== exact && ports.restore(fallback)
                    }
                    settle(owner !== generation ? 'cancelled' : restored ? 'restored' : 'unavailable')
                })
                return result
            },
        }
    }

    return {
        open(host: InspectorHost, externalOpener: T | null = null): InspectorPresentation {
            if (disposed) throw new Error('Inspector focus owner is disposed')
            const presentation = bind(host)
            cancelPending()
            opener = externalOpener
            phase = 'open'
            return presentation
        },
        rehost(host: InspectorHost): InspectorPresentation | null {
            if (phase === 'idle') return null
            const presentation = bind(host)
            cancelPending()
            // The old host cannot complete a leave after it has been replaced.
            if (phase === 'closing') void presentation.closed()
            return presentation
        },
        dispose() {
            disposed = true
            ++generation
            phase = 'idle'
            opener = null
            cancelPending()
        },
    }
}

export function focusInspectorOpener(target: HTMLElement, inspector: HTMLElement | null): boolean {
    if (!target.isConnected
        || inspector?.contains(target)
        || target.matches(':disabled, [aria-disabled="true"]')
        || target.closest('[inert], [hidden], [aria-hidden="true"]')
        || target.getClientRects().length === 0
        || target.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) === false) {
        return false
    }

    const view = target.ownerDocument.defaultView
    if (view === null || view.getComputedStyle(target).visibility !== 'visible') return false
    target.focus({ preventScroll: true })
    return target.matches(':focus')
}
