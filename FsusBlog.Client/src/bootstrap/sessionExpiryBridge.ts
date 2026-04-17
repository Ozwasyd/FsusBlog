export const SESSION_EXPIRED_EVENT = 'fsus:session-expired'

export type SessionExpiredDetail = Readonly<{
  currentPath: string
}>

export function dispatchSessionExpired(detail: SessionExpiredDetail): void {
  window.dispatchEvent(
    new CustomEvent<SessionExpiredDetail>(SESSION_EXPIRED_EVENT, {
      detail
    })
  )
}
