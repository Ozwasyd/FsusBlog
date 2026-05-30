export const SESSION_EXPIRED_EVENT = 'fsus:session-expired'

export type SessionExpiredDetail = Readonly<{
  currentPath: string
}>
