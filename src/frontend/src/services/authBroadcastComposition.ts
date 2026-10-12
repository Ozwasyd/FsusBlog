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

/** A retained cleanup callback no longer owns the state it was asked to clear. */
export class AuthBroadcastCleanupIncompleteError extends Error
{
    constructor()
    {
        super('Auth broadcast cleanup ownership retired before completion.');
        this.name = 'AuthBroadcastCleanupIncompleteError';
    }
}

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

    const requireActiveOwner = (): void =>
    {
        if (!isActiveOwner())
        {
            throw new AuthBroadcastCleanupIncompleteError();
        }
    };
    const cleanupStep = (work: () => void): void =>
    {
        requireActiveOwner();
        work();
        requireActiveOwner();
    };
    const stopAuthenticatedRuntime = (): Promise<void> =>
    {
        cleanupStep(() => notificationStore.dispose());
        cleanupStep(() => notificationStore.resetCursor());
        cleanupStep(() => notificationStore.setStatus('stopped'));
        requireActiveOwner();
        const stop = notificationStreamRuntime.stop(true);
        // Preserve actual rejection unchanged; only confirmed completion can
        // satisfy this original queued cleanup obligation for the same owner.
        return stop.then(() => requireActiveOwner());
    };

    const cleanupRegistrations = [
        () => registerPrivateStateCleanupHandler('account-pinia', (trigger: PrivateStateCleanupTrigger) =>
        {
            cleanupStep(() => userStore.cancelUserInfoRequest());
            if (trigger === 'account-switch')
            {
                cleanupStep(() => userStore.invalidateIdentityCache());
            }
            else
            {
                cleanupStep(() => userStore.markGuest());
            }
        }),
        () => registerPrivateStateCleanupHandler('admin-pinia', () =>
            cleanupStep(() => adminStore.clearAdminPrincipal())),
        () => registerPrivateStateCleanupHandler('notification-runtime', () => stopAuthenticatedRuntime()),
        () => registerPrivateStateCleanupHandler('challenge-proof-runtime', () =>
            cleanupStep(() => defaultChallengeProofStore.clear()))
    ];
    const surfaceRegistrations = [
        () => privateSurfaceRuntime.registerTerminationHandler((reason) =>
        {
            cleanupStep(() => userStore.cancelUserInfoRequest());
            if (reason === 'account-switch')
            {
                cleanupStep(() => userStore.invalidateIdentityCache());
            }
            else if (reason !== 'admin-logout')
            {
                cleanupStep(() => userStore.markGuest());
            }
        }),
        () => privateSurfaceRuntime.registerTerminationHandler((reason) =>
        {
            cleanupStep(() => adminStore.cancelAdminSessionRequest());
            if (reason === 'admin-logout')
            {
                cleanupStep(() => adminStore.clearAdminPrincipal());
            }
        }),
        () => privateSurfaceRuntime.registerTerminationHandler(() => stopAuthenticatedRuntime()),
        () => privateSurfaceRuntime.registerTerminationHandler(() =>
            cleanupStep(() => defaultChallengeProofStore.clear()))
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
                if (!isActiveOwner())
                {
                    return;
                }
                void invalidatePrivateSurfaceForBroadcast('admin-logout', origin, requireActiveOwner).then(() =>
                {
                    if (isActiveOwner())
                    {
                        dispatchAdminLogout();
                    }
                });
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
        if (!isActiveOwner())
        {
            return;
        }
        adminStore.invalidateMissingCache();
        if (!isActiveOwner())
        {
            return;
        }

        if (event.type === 'login')
        {
            void invalidatePrivateSurfaceForBroadcast('account-switch', origin, requireActiveOwner);
            if (!isActiveOwner())
            {
                return;
            }
            if (origin === 'remote')
            {
                userStore.invalidateIdentityCache();
                if (!isActiveOwner())
                {
                    return;
                }
                dispatchSessionExpired();
            }
            return;
        }

        if (event.type === 'user-expired')
        {
            clearLocalFixtureSession();
            if (!isActiveOwner())
            {
                return;
            }
            const expiry = userStore.expireAuthentication({ broadcastCredentialPurge: origin !== 'remote', ownsCleanup: isActiveOwner });
            if (!isActiveOwner())
            {
                return;
            }
            appShellStore.markSessionExpired();
            if (!isActiveOwner())
            {
                return;
            }
            void stopAuthenticatedRuntime();
            if (!isActiveOwner())
            {
                return;
            }
            if (origin === 'remote')
            {
                void expiry.then(() =>
                {
                    if (isActiveOwner())
                    {
                        dispatchSessionExpired();
                    }
                });
            }
            return;
        }

        let transition: Promise<void> = Promise.resolve();
        if (event.type === 'expired')
        {
            if (origin === 'remote')
            {
                transition = userStore.expireAuthentication({ broadcastCredentialPurge: false, ownsCleanup: isActiveOwner });
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
            transition = invalidatePrivateSurfaceForBroadcast('logout', origin, requireActiveOwner);
        }
        if (!isActiveOwner())
        {
            return;
        }
        void stopAuthenticatedRuntime();
        if (!isActiveOwner())
        {
            return;
        }
        if (origin === 'remote')
        {
            void transition.then(() =>
            {
                if (isActiveOwner())
                {
                    dispatchSessionExpired();
                }
            });
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
    origin: AuthBroadcastEventOrigin,
    requireOwner: () => void
): Promise<void>
{
    requireOwner();
    const clear = origin === 'remote'
        ? clearPrivateBrowserState(reason, { broadcastCredentialPurge: false })
        : clearPrivateBrowserState(reason);
    return clear.then(() =>
    {
        requireOwner();
    });
}

function invalidatePrivateSurfaceForBroadcast(
    reason: Extract<PrivateBrowserStateClearReason, 'account-switch' | 'logout' | 'admin-logout' | 'session-expired'>,
    origin: AuthBroadcastEventOrigin,
    requireOwner: () => void
): Promise<void>
{
    requireOwner();
    return privateSurfaceRuntime.invalidate(reason, () => clearPrivateStateForBroadcast(reason, origin, requireOwner));
}
