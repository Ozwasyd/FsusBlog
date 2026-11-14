import { readonly, ref, shallowRef } from 'vue'
import { api, ApiError, type Session } from '../../Contracts/client'

const session = shallowRef<Session | null>(null)
const sessionEpoch = ref(0)
let requestEpoch = 0

export const currentSession = readonly(session)
export const identityEpoch = readonly(sessionEpoch)

function updateSession(value: Session | null) {
  const previous = session.value
  if (previous?.generation !== value?.generation || previous?.name !== value?.name ||
      previous?.canAuthor !== value?.canAuthor) {
    sessionEpoch.value++
  }
  session.value = value
}

export function invalidateSession() {
  requestEpoch++
  updateSession(null)
}

export async function refreshSession(signal?: AbortSignal) {
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
  const value = await api.signIn(ticket, signal)
  if (request === requestEpoch && !signal?.aborted) {
    sessionEpoch.value++
    session.value = value
  }
}

export async function signOut(signal?: AbortSignal) {
  invalidateSession()
  await api.signOut(signal)
}
