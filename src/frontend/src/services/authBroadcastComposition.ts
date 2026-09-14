import { dispatchAdminLogout } from '@/bootstrap/adminLogoutBridge';
import { dispatchSessionExpired } from '@/bootstrap/sessionExpiryBridge';
import { defaultChallengeProofStore } from '@/security/challenge-proof-store';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import {
    registerPrivateStateCleanupHandler,
    type PrivateStateCleanupTrigger
} from '@/services/privateStorageRegistry';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';
import type { PrivateBrowserStateClearReason } from '@/services/serviceWorkerRuntime';
import { useAdminStore } from '@/store/admin';

import { useAppShellStore } from '@/store/appShell';
import { authBroadcastRuntime, type AuthBroadcastEventOrigin } from './authBroadcastRuntime'
import { notificationStreamRuntime } from './notificationStreamRuntime'
import { clearLocalFixtureAdminSession, clearLocalFixtureSession } from './localFixtureSession'
import { clearPrivateBrowserState } from './serviceWorkerRuntime'
import { useNotificationStreamStore } from '@/store/notificationStream';
import { useUserStore } from '@/store/user';

import type { Pinia } from 'pinia';

let activePinia: Pinia | null = null;
let unsubscribe: (() => void) | null = null;
let unregisterPrivateCleanupHandlers: (() => void)[] = [];
let unregisterPrivateSurfaceHandlers: (() => void)[] = [];

export function installAuthBroadcastComposition(pinia: Pinia): void
{
    if (activePinia === pinia && unsubscribe)
    {
        return;
    }

    disposeAuthBroadcastComposition();
    activePinia = pinia;

    const userStore = useUserStore(pinia);
    const adminStore = useAdminStore(pinia);
    const appShellStore = useAppShellStore(pinia);
    const notificationStore = useNotificationStreamStore(pinia);

    const stopAuthenticatedRuntime = (): void =>
    {
        notificationStore.dispose();
        notificationStore.resetCursor();
        notificationStore.setStatus('stopped');
        void notificationStreamRuntime.stop(true);
    };

    unregisterPrivateCleanupHandlers = [
        registerPrivateStateCleanupHandler('account-pinia', (trigger: PrivateStateCleanupTrigger) =>
        {
            userStore.cancelUserInfoRequest();
            if (trigger === 'account-switch')
            {
                userStore.invalidateIdentityCache();
            }
            else
            {
                userStore.markGuest();
            }
        }),
        registerPrivateStateCleanupHandler('admin-pinia', () =>
        {
            adminStore.clearAdminPrincipal();
        }),
        registerPrivateStateCleanupHandler('notification-runtime', () =>
        {
            stopAuthenticatedRuntime();
        }),
        registerPrivateStateCleanupHandler('challenge-proof-runtime', () =>
        {
            defaultChallengeProofStore.clear();
        })
    ];
    unregisterPrivateSurfaceHandlers = [
        privateSurfaceRuntime.registerTerminationHandler((reason) =>
        {
            userStore.cancelUserInfoRequest();
            if (reason === 'account-switch')
            {
                userStore.invalidateIdentityCache();
            }
            else if (reason !== 'admin-logout')
            {
                userStore.markGuest();
            }
        }),
        privateSurfaceRuntime.registerTerminationHandler((reason) =>
        {
            adminStore.cancelAdminSessionRequest();
            if (reason === 'admin-logout')
            {
                adminStore.clearAdminPrincipal();
            }
        }),
        privateSurfaceRuntime.registerTerminationHandler(() => stopAuthenticatedRuntime()),
        privateSurfaceRuntime.registerTerminationHandler(() => defaultChallengeProofStore.clear())
    ];

    unsubscribe = authBroadcastRuntime.subscribe((event, origin) =>
    {
        defaultChallengeProofStore.clear();
        if (event.type === 'admin-logout')
        {
            if (origin === 'remote')
            {
                clearLocalFixtureAdminSession();
                void invalidatePrivateSurfaceForBroadcast('admin-logout', origin).then(() => dispatchAdminLogout());
            }
            else
            {
                dispatchAdminLogout();
            }
            return;
        }

        if (event.type === 'admin-changed')
        {
            privateRequestRuntime.advance('admin');
            userStore.invalidateGuestCache();
            adminStore.invalidateMissingCache();
            return;
        }

        // Any authentication transition can reflect a Cookie/Session change made
        // by another tab, Passkey completion, or admin step-up. Neither negative
        // cache is allowed to outlive that transition.
        userStore.invalidateGuestCache();
        adminStore.invalidateMissingCache();

        if (event.type === 'login')
        {
            void invalidatePrivateSurfaceForBroadcast('account-switch', origin);
            if (origin === 'remote')
            {
                userStore.invalidateIdentityCache();
                dispatchSessionExpired();
            }
            return;
        }

        if (event.type === 'user-expired')
        {
            clearLocalFixtureSession();
            const expiry = userStore.expireAuthentication({ broadcastCredentialPurge: origin !== 'remote' });
            appShellStore.markSessionExpired();
            stopAuthenticatedRuntime();
            if (origin === 'remote')
            {
                void expiry.then(() => dispatchSessionExpired());
            }
            return;
        }

        let transition: Promise<void> = Promise.resolve();
        if (event.type === 'expired')
        {
            if (origin === 'remote')
            {
                transition = userStore.expireAuthentication({ broadcastCredentialPurge: false });
            }
            else
            {
                // The initiating runtime already advanced authGeneration and cleared
                // private state before publishing. Restore the terminal guest state
                // after the generic negative-cache invalidation above.
                userStore.markGuest();
            }
        }
        else
        {
            transition = invalidatePrivateSurfaceForBroadcast('logout', origin);
        }
        stopAuthenticatedRuntime();
        if (origin === 'remote')
        {
            void transition.then(() => dispatchSessionExpired());
        }
    });

    userStore.setLogoutBroadcast(() => authBroadcastRuntime.broadcastLogout());
    adminStore.setLogoutBroadcast(() => authBroadcastRuntime.broadcastAdminLogout());
    notificationStore.setSessionRevokedHandler(() =>
    {
    // SessionRevoked is account-scoped so the payload never carries a session
    // identifier. Revalidate this tab against the server before expiring it:
    // targeted revoke and active-session-limit events must leave unaffected
    // devices signed in, while the revoked device still clears immediately.
        void userStore.fetchUserInfo(true).then(() =>
        {
            if (!userStore.isLoggedIn)
            {
                authBroadcastRuntime.expireUserSession();
            }
        });
    });
}

export function disposeAuthBroadcastComposition(): void
{
    for (const unregister of unregisterPrivateSurfaceHandlers)
    {
        unregister();
    }
    unregisterPrivateSurfaceHandlers = [];
    for (const unregister of unregisterPrivateCleanupHandlers)
    {
        unregister();
    }
    unregisterPrivateCleanupHandlers = [];
    if (activePinia)
    {
        useUserStore(activePinia).setLogoutBroadcast(null);
        useAdminStore(activePinia).setLogoutBroadcast(null);
        useNotificationStreamStore(activePinia).setSessionRevokedHandler(null);
    }
    unsubscribe?.();
    unsubscribe = null;
    activePinia = null;
}

function clearPrivateStateForBroadcast(
    reason: Extract<PrivateBrowserStateClearReason, 'account-switch' | 'logout' | 'admin-logout' | 'session-expired'>,
    origin: AuthBroadcastEventOrigin
): Promise<void>
{
    const clear = origin === 'remote'
        ? clearPrivateBrowserState(reason, { broadcastCredentialPurge: false })
        : clearPrivateBrowserState(reason);
    return clear.then(() => undefined);
}

function invalidatePrivateSurfaceForBroadcast(
    reason: Extract<PrivateBrowserStateClearReason, 'account-switch' | 'logout' | 'admin-logout' | 'session-expired'>,
    origin: AuthBroadcastEventOrigin
): Promise<void>
{
    return privateSurfaceRuntime.invalidate(reason, () => clearPrivateStateForBroadcast(reason, origin));
}
