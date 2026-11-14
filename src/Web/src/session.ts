import { readonly, ref, shallowRef } from 'vue'
import { api, ApiError, type Session } from '../../Contracts/client'

const session = shallowRef<Session | null>(null)
const sessionEpoch = ref(0)
let requestEpoch = 0
let mutation: number | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined

export const currentSession = readonly(session)
export const identityEpoch = readonly(sessionEpoch)

function updateSession(value: Session | null, newLogin = false) {
  const previous = session.value
  const next = value && value.expiresAt > Date.now() ? value : null
  session.value = next
  if (newLogin || previous?.generation !== next?.generation || previous?.name !== next?.name ||
      previous?.canAuthor !== next?.canAuthor || previous?.expiresAt !== next?.expiresAt) {
    sessionEpoch.value++
  }
  clearTimeout(expiryTimer)
  if (next) {
    const expire = () => {
      if (session.value !== next) return
      const remaining = next.expiresAt - Date.now()
      if (remaining > 0) expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      else invalidateSession()
    }
    expire()
  }
}

export function invalidateSession() {
  requestEpoch++
  updateSession(null)
}

export async function refreshSession(signal?: AbortSignal) {
  if (mutation !== undefined) return
  const request = ++requestEpoch
  try {
    const value = await api.session(signal)
    if (request === requestEpoch && !signal?.aborted) updateSession(value)
  } catch (error) {
    if (request === requestEpoch && !signal?.aborted) updateSession(null)
    if (!(error instanceof ApiError) || error.status !== 401) throw error
  }
}

export async function signIn(ticket: string, signal?: AbortSignal) {
  const request = ++requestEpoch
  mutation = request
  try {
    const value = await api.signIn(ticket, signal)
    if (request === requestEpoch && !signal?.aborted) updateSession(value, true)
  } finally {
    if (mutation === request) mutation = undefined
  }
}

export async function signOut(signal?: AbortSignal) {
  invalidateSession()
  const request = requestEpoch
  mutation = request
  try {
    await api.signOut(signal)
  } finally {
    if (mutation === request) mutation = undefined
  }
}
