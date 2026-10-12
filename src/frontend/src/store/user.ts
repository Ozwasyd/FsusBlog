import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import { getMe, logout as logoutApi, type CurrentUserSnapshot } from '@/api/auth';
import { clearLocalFixtureSession } from '@/services/localFixtureSession';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { getKnownErrorInfo, isAuthFailureError } from '@/utils/errorKinds';
import { isAbortError } from '@/utils/errors';

export type AccountSessionState = 'unknown' | 'guest' | 'authenticated';

export const ACCOUNT_GUEST_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
const LEGACY_USER_AUTH_STORAGE_KEY = 'fsus_user_storage';

function clearLegacyPersistedAuthState(): void
{
    if (typeof localStorage === 'undefined')
    {
        return;
    }

    try
    {
        // This key only ever contained authentication conclusions and their
        // verification timestamps. Removing it is deliberately all-or-nothing:
        // a malformed legacy payload must not survive as an authorization hint.
        localStorage.removeItem(LEGACY_USER_AUTH_STORAGE_KEY);
    }
    catch
    {
        // Restricted browser contexts can reject storage access. The current
        // page still starts from the in-memory unknown state below.
    }
}

export const useUserStore = defineStore('user', () =>
{
    clearLegacyPersistedAuthState();

    // ================= 1. State =================
    const userInfo = ref<CurrentUserSnapshot | null>(null);
    const accountState = ref<AccountSessionState>('unknown');
    const lastVerifiedAt = ref(0);
    const isLoading = ref(false);
    const isLoggingOut = ref(false);
    const lastFetchedAt = ref(0);
    const authGeneration = privateSurfaceRuntime.authGeneration;

    let fetchPromise: Promise<void> | null = null;
    let abortController: AbortController | null = null;
    let logoutBroadcast: (() => void) | null = null;
    let identityGeneration = 0;

    // ================= 2. Getters =================
    const isAuthChecked = computed(() => accountState.value !== 'unknown');
    const isLoggedIn = computed(() => accountState.value === 'authenticated' && userInfo.value !== null);

    const isAdmin = computed(() => false);

    const isBanned = computed(() => userInfo.value?.status === 1);
    const isDeleted = computed(() => userInfo.value?.status === 2);

    // ================= 3. Private Helpers =================

    // ================= 4. Actions =================

    const markGuest = () =>
    {
        userInfo.value = null;
        accountState.value = 'guest';
        lastVerifiedAt.value = Date.now();
        lastFetchedAt.value = lastVerifiedAt.value;
    };

    const markAuthenticated = (info: CurrentUserSnapshot) =>
    {
        userInfo.value = info;
        accountState.value = 'authenticated';
        lastVerifiedAt.value = Date.now();
        lastFetchedAt.value = lastVerifiedAt.value;
    };

    const invalidateGuestCache = () =>
    {
        if (accountState.value === 'guest')
        {
            accountState.value = 'unknown';
            lastVerifiedAt.value = 0;
            lastFetchedAt.value = 0;
        }
    };

    const cancelUserInfoRequest = () =>
    {
        identityGeneration += 1;
        abortController?.abort();
        abortController = null;
        fetchPromise = null;
        isLoading.value = false;
    };

    const expireAuthentication = async (options?: { broadcastCredentialPurge?: boolean; }) =>
    {
        await privateSurfaceRuntime.invalidate('session-expired', async () =>
        {
            cancelUserInfoRequest();
            markGuest();
            await clearPrivateBrowserState('session-expired', {
                broadcastCredentialPurge: options?.broadcastCredentialPurge ?? true
            });
        });
    };

    const invalidateIdentityCache = () =>
    {
        cancelUserInfoRequest();
        userInfo.value = null;
        accountState.value = 'unknown';
        lastVerifiedAt.value = 0;
        lastFetchedAt.value = 0;
    };

    const setLogoutBroadcast = (
        publisher: (() => void) | null,
        ownsWrite?: () => boolean,
        expected?: () => void
    ): void =>
    {
        if ((ownsWrite && !ownsWrite()) || (expected && logoutBroadcast !== expected))
        {
            return;
        }
        logoutBroadcast = publisher;
    };

    const fetchUserInfo = async (force = false) =>
    {
        if (!force)
        {
            if (accountState.value === 'authenticated' && userInfo.value)
            {
                return;
            }
            if (accountState.value === 'guest' && Date.now() - lastVerifiedAt.value <= ACCOUNT_GUEST_NEGATIVE_CACHE_MS)
            {
                return;
            }
        }
        const hadAuthenticatedSession =
            accountState.value === 'authenticated' && userInfo.value !== null;

        if (force && abortController)
        {
            cancelUserInfoRequest();
        }

        if (fetchPromise)
        {
            return fetchPromise;
        }

        // A negative result belongs to the page epoch only. Once revalidation
        // starts, it is no longer a fact even if the request later loses the
        // network, so keep that outcome as unknown.
        invalidateGuestCache();

        abortController = new AbortController();
        const currentController = abortController;
        const requestGeneration = identityGeneration;
        isLoading.value = true;

        fetchPromise = (async () =>
        {
            try
            {
                const res = await getMe({ signal: currentController.signal });

                if (currentController === abortController && requestGeneration === identityGeneration)
                {
                    markAuthenticated(res);
                }
            }
            catch (error: unknown)
            {
                if (isAbortError(error))
                {
                    return;
                }

                if (isAuthFailureError(error))
                {
                    if (hadAuthenticatedSession)
                    {
                        await expireAuthentication();
                    }
                    else
                    {
                        markGuest();
                    }
                }
                else
                {
                    const info = getKnownErrorInfo(error, 'auth_handshake_failed');
                    console.error('[UserStore] Auth handshake failed:', info.message);
                    // 如果是 500 或网络错误，不设置 accountState，允许重试
                }
            }
            finally
            {
                if (currentController === abortController && requestGeneration === identityGeneration)
                {
                    fetchPromise = null;
                    abortController = null;
                    isLoading.value = false;
                }
            }
        })();

        return fetchPromise;
    };

    const ensureUserInfoFresh = async (options?: { maxAgeMs?: number; forceWhenUnknown?: boolean; }) =>
    {
        const maxAgeMs = options?.maxAgeMs ?? 30_000;
        const forceWhenUnknown = options?.forceWhenUnknown ?? true;

        if (accountState.value === 'unknown')
        {
            return fetchUserInfo(false);
        }

        if (accountState.value === 'guest')
        {
            if (lastVerifiedAt.value > 0 && Date.now() - lastVerifiedAt.value <= ACCOUNT_GUEST_NEGATIVE_CACHE_MS)
            {
                return;
            }
            return fetchUserInfo(forceWhenUnknown);
        }

        if (lastVerifiedAt.value <= 0)
        {
            return fetchUserInfo(forceWhenUnknown);
        }

        if (Date.now() - lastVerifiedAt.value <= maxAgeMs)
        {
            return;
        }

        return fetchUserInfo(true);
    };

    const logout = async () =>
    {
        if (isLoggingOut.value)
        {
            return;
        }
        isLoggingOut.value = true;

        try
        {
            await logoutApi();
        }
        catch
        {
            console.warn('[UserStore] Logout partial failure.');
        }
        finally
        {
            clearLocalFixtureSession();
            await privateSurfaceRuntime.invalidate('logout', async () =>
            {
                cancelUserInfoRequest();
                markGuest();
                await clearPrivateBrowserState('logout');
            });
            logoutBroadcast?.();
            isLoggingOut.value = false;
        }
    };

    const updateStatus = (status: number, reason: string | null) =>
    {
        if (userInfo.value)
        {
            userInfo.value = {
                ...userInfo.value,
                status: status,
                banReason: reason
            };
        }
    };

    return {
        userInfo,
        isLoading,
        accountState,
        isAuthChecked,
        lastVerifiedAt,
        lastFetchedAt,
        authGeneration,
        isLoggedIn,
        isAdmin,
        isBanned,
        isDeleted,
        markGuest,
        markAuthenticated,
        invalidateGuestCache,
        cancelUserInfoRequest,
        expireAuthentication,
        invalidateIdentityCache,
        setLogoutBroadcast,
        fetchUserInfo,
        ensureUserInfoFresh,
        logout,
        updateStatus
    };
});
