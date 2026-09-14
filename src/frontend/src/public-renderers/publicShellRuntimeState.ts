import { readonly, shallowRef } from 'vue';

import type { PublicShellState } from '@/public-renderers/publicShellState';
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState';

export type PublicShellRuntimeAuthState = Pick<PublicShellState, 'authAction' | 'authHref'>;

export type PublicShellRuntimeAuthUser = Readonly<{
    accountId?: number | null;
    canManage?: boolean | null;
}> | null;

const anonymousAuthState: PublicShellRuntimeAuthState = {
    authAction: 'login',
    authHref: '/login'
};

const runtimeAuthState = shallowRef<PublicShellRuntimeAuthState>(anonymousAuthState);

export const publicShellRuntimeAuthState = readonly(runtimeAuthState);

export function resolvePublicShellRuntimeAuthState(
    user: PublicShellRuntimeAuthUser
): PublicShellRuntimeAuthState
{
    const shellState = createPublicShellViewState({
        isRuntimeAuthResolved: true,
        isLoggedIn: Boolean(user),
        isAdmin: Boolean(user?.canManage)
    });

    return {
        authAction: shellState.authAction,
        authHref: shellState.authHref
    };
}

export function setPublicShellRuntimeAuthState(authState: PublicShellRuntimeAuthState): void
{
    runtimeAuthState.value = authState;
}

export function resetPublicShellRuntimeAuthState(): void
{
    runtimeAuthState.value = anonymousAuthState;
}
