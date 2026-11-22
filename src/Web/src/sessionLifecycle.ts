import { ApiError, type Session } from '../../Contracts/client'

export function createSessionExpiry(current: () => Session | null, invalidate: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (next: Session | null) => {
    clearTimeout(timer)
    if (!next) return
    const expire = () => {
      if (current() !== next) return
      const remaining = next.expiresAt - Date.now()
      if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      else invalidate()
    }
    expire()
  }
}

export function createSessionRead(options: {
  blocked(): boolean
  begin(): number
  current(request: number): boolean
  session(): Session | null
  update(value: Session | null): void
  read(signal: AbortSignal | undefined, reuse: boolean, admissible: () => boolean): Promise<Session | null>
  allowUnauthorized?: boolean
}) {
  let sessionRead: { completion: Promise<void>; signal?: AbortSignal } | undefined
  return async (signal?: AbortSignal, reuse = true): Promise<void> => {
    const blocked = () => options.blocked() || signal?.aborted
    if (blocked()) return
    if (sessionRead && !sessionRead.signal?.aborted) {
      if (reuse) return sessionRead.completion
      await sessionRead.completion.catch(() => {})
      if (blocked()) return
    }
    const request = options.begin()
    const admissible = () => options.current(request) && !blocked()
    const completion = (async () => {
      try {
        let value: Session | null
        try { value = await options.read(signal, reuse, admissible) }
        catch (error) {
          if (options.allowUnauthorized && error instanceof ApiError && error.status === 401) value = null
          else throw error
        }
        if (admissible()) options.update(value)
      } catch (error) {
        if (admissible() && (options.session()?.expiresAt ?? 0) <= Date.now()) options.update(null)
        throw error
      }
    })()
    sessionRead = { completion, signal }
    try { await completion }
    finally { if (sessionRead?.completion === completion) sessionRead = undefined }
  }
}
