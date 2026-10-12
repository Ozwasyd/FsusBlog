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
import { useNotificationStreamStore } from '@/store/notificationStream';
import { useUserStore } from '@/store/user';

import { authBroadcastRuntime, type AuthBroadcastEventOrigin } from './authBroadcastRuntime';
import { clearLocalFixtureAdminSession, clearLocalFixtureSession } from './localFixtureSession';
import { notificationStreamRuntime } from './notificationStreamRuntime';
import { clearPrivateBrowserState } from './serviceWorkerRuntime';

import type { Pinia } from 'pinia';

interface AuthBroadcastCompositionOwnership {
    readonly pinia: Pinia;
    unsubscribe: (() => void) | null;
    unregisterInvalidation: (() => void) | null;
    cleanupHandlers: (() => void)[];
    surfaceHandlers: (() => void)[];
    userStore?: ReturnType<typeof useUserStore>;
    adminStore?: ReturnType<typeof useAdminStore>;
    notificationStore?: ReturnType<typeof useNotificationStreamStore>;
    userPublisher?: () => void;
    adminPublisher?: () => void;
    sessionHandler?: () => void;
}

let activeComposition: AuthBroadcastCompositionOwnership | null = null;

export function installAuthBroadcastComposition(pinia: Pinia): void
{
    if (activeComposition?.pinia === pinia && activeComposition.unsubscribe)
    {
        return;
    }
    const previous = activeComposition;
    const owner: AuthBroadcastCompositionOwnership = {
        pinia,
        unsubscribe: null,
        unregisterInvalidation: null,
        cleanupHandlers: [],
        surfaceHandlers: []
    };
    activeComposition = owner;
    const ownsWrite = (): boolean => activeComposition === owner;
    if (previous)
    {
        disposeOwnedComposition(previous, ownsWrite);
    }
    if (!ownsWrite())
    {
        return;
    }

    const userStore = useUserStore(pinia);
    if (!ownsWrite())
    {
        return;
    }
    owner.userStore = userStore;
    const adminStore = useAdminStore(pinia);
    if (!ownsWrite())
    {
        return;
    }
    owner.adminStore = adminStore;
    const appShellStore = useAppShellStore(pinia);
    if (!ownsWrite())
    {
        return;
    }
    const notificationStore = useNotificationStreamStore(pinia);
    if (!ownsWrite())
    {
        return;
    }
    owner.notificationStore = notificationStore;

    const unregisterInvalidation = authBroadcastRuntime.registerAdminPrincipalInvalidation(
        adminStore.invalidateAdminPrincipalAuthority
    );
    if (!ownsWrite())
    {
        unregisterInvalidation();
        return;
    }
    owner.unregisterInvalidation = unregisterInvalidation;
    const isActiveOwner = (): boolean => ownsWrite() && owner.unsubscribe !== null;

    const stopAuthenticatedRuntime = (): void =>
    {
        notificationStore.dispose();
        notificationStore.resetCursor();
        notificationStore.setStatus('stopped');
        void notificationStreamRuntime.stop(true);
    };

    const cleanupRegistrations = [
        () => registerPrivateStateCleanupHandler('account-pinia', (trigger: PrivateStateCleanupTrigger) =>
        {
            if (!isActiveOwner())
            {
                return;
            }
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
        () => registerPrivateStateCleanupHandler('admin-pinia', () =>
        {
            if (!isActiveOwner())
            {
                return;
            }
            adminStore.clearAdminPrincipal();
        }),
        () => registerPrivateStateCleanupHandler('notification-runtime', () =>
        {
            if (!isActiveOwner())
            {
                return;
            }
            stopAuthenticatedRuntime();
        }),
        () => registerPrivateStateCleanupHandler('challenge-proof-runtime', () =>
        {
            if (!isActiveOwner())
            {
                return;
            }
            defaultChallengeProofStore.clear();
        })
    ];
    const surfaceRegistrations = [
        () => privateSurfaceRuntime.registerTerminationHandler((reason) =>
        {
            if (!isActiveOwner())
            {
                return;
            }
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
        () => privateSurfaceRuntime.registerTerminationHandler((reason) =>
        {
            if (!isActiveOwner())
            {
                return;
            }
            adminStore.cancelAdminSessionRequest();
            if (reason === 'admin-logout')
            {
                adminStore.clearAdminPrincipal();
            }
        }),
        () => privateSurfaceRuntime.registerTerminationHandler(() =>
        {
            if (isActiveOwner())
            {
                stopAuthenticatedRuntime();
            }
        }),
        () => privateSurfaceRuntime.registerTerminationHandler(() =>
        {
            if (isActiveOwner())
            {
                defaultChallengeProofStore.clear();
            }
        })
    ];

    for (const register of cleanupRegistrations)
    {
        if (!ownsWrite())
        {
            return;
        }
        const unregister = register();
        if (!ownsWrite())
        {
            unregister();
            return;
        }
        owner.cleanupHandlers.push(unregister);
    }
    for (const register of surfaceRegistrations)
    {
        if (!ownsWrite())
        {
            return;
        }
        const unregister = register();
        if (!ownsWrite())
        {
            unregister();
            return;
        }
        owner.surfaceHandlers.push(unregister);
    }
    if (!ownsWrite())
    {
        return;
    }
    owner.unsubscribe = authBroadcastRuntime.subscribe((event, origin) =>
    {
        if (!isActiveOwner())
        {
            return;
        }
        defaultChallengeProofStore.clear();
        if (!isActiveOwner())
        {
            return;
        }
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
            if (!isActiveOwner())
            {
                return;
            }
            userStore.invalidateGuestCache();
            if (!isActiveOwner())
            {
                return;
            }
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

    if (!isActiveOwner())
    {
        return;
    }
    owner.userPublisher = () =>
    {
        if (isActiveOwner())
        {
            authBroadcastRuntime.broadcastLogout();
        }
    };
    userStore.setLogoutBroadcast(owner.userPublisher, ownsWrite);
    if (!isActiveOwner())
    {
        return;
    }
    owner.adminPublisher = () =>
    {
        if (isActiveOwner())
        {
            authBroadcastRuntime.broadcastAdminLogout();
        }
    };
    adminStore.setLogoutBroadcast(owner.adminPublisher, ownsWrite);
    if (!isActiveOwner())
    {
        return;
    }
    owner.sessionHandler = () =>
    {
        if (!isActiveOwner())
        {
            return;
        }
        // SessionRevoked is account-scoped so the payload never carries a session
        // identifier. Revalidate this tab against the server before expiring it:
        // targeted revoke and active-session-limit events must leave unaffected
        // devices signed in, while the revoked device still clears immediately.
        void userStore.fetchUserInfo(true).then(() =>
        {
            if (isActiveOwner() && !userStore.isLoggedIn)
            {
                authBroadcastRuntime.expireUserSession();
            }
        });
    };
    notificationStore.setSessionRevokedHandler(owner.sessionHandler, ownsWrite);
}

function disposeOwnedComposition(owner: AuthBroadcastCompositionOwnership, ownsWrite: () => boolean): void
{
    if (!ownsWrite())
    {
        return;
    }
    const unsubscribe = owner.unsubscribe;
    owner.unsubscribe = null;
    unsubscribe?.();
    if (!ownsWrite())
    {
        return;
    }
    const unregisterInvalidation = owner.unregisterInvalidation;
    owner.unregisterInvalidation = null;
    unregisterInvalidation?.();
    if (!ownsWrite())
    {
        return;
    }
    while (owner.surfaceHandlers.length > 0)
    {
        const unregister = owner.surfaceHandlers.shift();
        unregister?.();
        if (!ownsWrite())
        {
            return;
        }
    }
    while (owner.cleanupHandlers.length > 0)
    {
        const unregister = owner.cleanupHandlers.shift();
        unregister?.();
        if (!ownsWrite())
        {
            return;
        }
    }
    if (owner.userPublisher)
    {
        owner.userStore?.setLogoutBroadcast(null, ownsWrite, owner.userPublisher);
        if (!ownsWrite())
        {
            return;
        }
        owner.userPublisher = undefined;
    }
    if (owner.adminPublisher)
    {
        owner.adminStore?.setLogoutBroadcast(null, ownsWrite, owner.adminPublisher);
        if (!ownsWrite())
        {
            return;
        }
        owner.adminPublisher = undefined;
    }
    if (owner.sessionHandler)
    {
        owner.notificationStore?.setSessionRevokedHandler(null, ownsWrite, owner.sessionHandler);
        if (!ownsWrite())
        {
            return;
        }
        owner.sessionHandler = undefined;
    }
}

export function disposeAuthBroadcastComposition(): void
{
    const owner = activeComposition;
    if (!owner)
    {
        return;
    }
    const ownsWrite = (): boolean => activeComposition === owner;
    disposeOwnedComposition(owner, ownsWrite);
    if (ownsWrite())
    {
        activeComposition = null;
    }
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
