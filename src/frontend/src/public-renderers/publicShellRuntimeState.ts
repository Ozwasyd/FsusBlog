import { readonly, shallowRef } from 'vue'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'
import type { PublicShellState } from '@/public-renderers/publicShellState'

export type PublicShellRuntimeAuthState = Pick<PublicShellState, 'authLabel' | 'authHref'>

export type PublicShellRuntimeAuthUser = Readonly<{
  role?: string | null
}> | null

const anonymousAuthState: PublicShellRuntimeAuthState = {
  authLabel: '登录',
  authHref: '/login'
}

const runtimeAuthState = shallowRef<PublicShellRuntimeAuthState>(anonymousAuthState)

export const publicShellRuntimeAuthState = readonly(runtimeAuthState)

export function resolvePublicShellRuntimeAuthState(
  user: PublicShellRuntimeAuthUser
): PublicShellRuntimeAuthState {
  const shellState = createPublicShellViewState({
    isRuntimeAuthResolved: true,
    isLoggedIn: Boolean(user),
    isAdmin: user?.role === 'admin'
  })

  return {
    authLabel: shellState.authLabel,
    authHref: shellState.authHref
  }
}

export function setPublicShellRuntimeAuthState(authState: PublicShellRuntimeAuthState): void {
  runtimeAuthState.value = authState
}

export function resetPublicShellRuntimeAuthState(): void {
  runtimeAuthState.value = anonymousAuthState
}
