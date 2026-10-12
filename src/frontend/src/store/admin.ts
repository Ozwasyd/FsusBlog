import { defineStore } from 'pinia';
import { computed, customRef, onScopeDispose, ref } from 'vue';

import { getAdminMe, logoutAdmin } from '@/api/auth';
import { clearLocalFixtureAdminSession } from '@/services/localFixtureSession';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';
import type { PrivateSurfaceAuthoritySeal } from '@/services/privateSurfaceRuntime';
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { isAuthFailureError } from '@/utils/errorKinds';
import { isAbortError } from '@/utils/errors';

export type AdminSessionStatus = 'missing' | 'active' | 'expired' | 'step_up_required';
export type AdminSessionState = 'unknown' | AdminSessionStatus;
export type AdminPrincipalSource = 'independent';

export const ADMIN_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
export const ADMIN_ACTIVE_TTL_MS = 60 * 1000;

export interface AdminPrincipalSnapshot {
    readonly id: string;
    readonly displayName: string;
    readonly source: AdminPrincipalSource;
    readonly permissions: readonly string[];
    readonly adminSessionStatus: AdminSessionStatus;
    readonly totpStepUpRequired?: boolean;
}

declare const adminPrincipalSealBrand: unique symbol;

/** Original producer custody, never a server permission or a serializable credential. */
export type AdminPrincipalSeal = Readonly<{
    [adminPrincipalSealBrand]: true;
}>;

interface AdminPrincipalAuthority {
    readonly identityId: string;
    readonly surfaceSeal: PrivateSurfaceAuthoritySeal;
    readonly checkedAt: number;
}

interface AdminPrincipalCustody {
    readonly authority: AdminPrincipalAuthority;
    readonly epoch: object;
}

export class AdminPrincipalMutationSupersededError extends Error
{
    constructor()
    {
        super('Admin principal mutation was superseded before its action body.');
        this.name = 'AdminPrincipalMutationSupersededError';
    }
}

export interface AnonymousCommentPolicySnapshot {
    anonymousCommentsEnabled: boolean;
    publicSendOptionEnabled: boolean;
    zkAnonymousEnabled: boolean;
    anonymousCommentGovernanceAvailable: boolean;
    zkAnonymousConfigurable: boolean;
    commentMaxChars: number;
    commentMaxUtf8Bytes: number;
}

export interface EnsureAdminSessionFreshOptions {
    force?: boolean;
}

export type AdminLogoutStatus = 'revoked' | 'already_inactive' | 'local_only';

export interface AdminLogoutOutcome {
    status: AdminLogoutStatus;
    serverRevocationConfirmed: boolean;
    localCleanupComplete: boolean;
}

export class AdminLogoutUnconfirmedError extends Error
{
    readonly outcome: AdminLogoutOutcome;

    constructor(outcome: AdminLogoutOutcome)
    {
        super('管理员会话撤销未确认；本地管理状态已清理，请重试。');
        this.name = 'AdminLogoutUnconfirmedError';
        this.outcome = outcome;
    }
}

export class AdminLogoutCleanupError extends Error
{
    readonly outcome: AdminLogoutOutcome;

    constructor(outcome: AdminLogoutOutcome)
    {
        super('管理员会话已撤销，但本地私有状态未完全清理。');
        this.name = 'AdminLogoutCleanupError';
        this.outcome = outcome;
    }
}

const DEFAULT_ANONYMOUS_COMMENT_POLICY: AnonymousCommentPolicySnapshot = Object.freeze({
    anonymousCommentsEnabled: true,
    publicSendOptionEnabled: true,
    zkAnonymousEnabled: false,
    anonymousCommentGovernanceAvailable: true,
    zkAnonymousConfigurable: true,
    commentMaxChars: 1000,
    commentMaxUtf8Bytes: 4096
});

// Capture the original owner's pure predicate once; final custody must not
// consult reactive/public runtime projections or a replaceable method property.
const hasPrivateSurfaceAuthorityCustody = privateSurfaceRuntime.hasAuthorityCustody.bind(privateSurfaceRuntime);
const cancelPrivateSurfaceAuthority = privateSurfaceRuntime.cancelAuthority.bind(privateSurfaceRuntime);

export const useAdminStore = defineStore('admin', ({ action }) =>
{
    const adminPrincipal = ref<AdminPrincipalSnapshot | null>(null);
    const adminState = ref<AdminSessionState>('unknown');
    const adminCheckedAt = ref(0);
    const lastLogoutOutcome = ref<AdminLogoutOutcome | null>(null);
    const anonymousCommentPolicy = ref<AnonymousCommentPolicySnapshot>({ ...DEFAULT_ANONYMOUS_COMMENT_POLICY });
    let adminSessionRequest: Promise<void> | null = null;
    let adminSessionController: AbortController | null = null;
    let adminSessionGeneration = 0;
    let logoutRequest: Promise<AdminLogoutOutcome> | null = null;
    let logoutBroadcast: (() => void) | null = null;
    const authoritySeals = new WeakMap<AdminPrincipalSeal, AdminPrincipalCustody>();
    let principalAuthority: AdminPrincipalAuthority | null = null;
    let principalCustodyEpoch: object | null = {};
    let principalMutation: object | null = null;
    let producerDisposed = false;
    let authorityExpiryTimer: ReturnType<typeof setTimeout> | null = null;

    const retirePrincipalAuthority = (reserveMutation = false): object | null =>
    {
        const authority = principalAuthority;
        principalAuthority = null;
        principalCustodyEpoch = null;
        const mutation = reserveMutation ? {} : null;
        principalCustodyEpoch = mutation;
        principalMutation = mutation;
        const expiryTimer = authorityExpiryTimer;
        authorityExpiryTimer = null;
        if (expiryTimer !== null)
        {
            clearTimeout(expiryTimer);
        }
        if (authority)
        {
            cancelPrivateSurfaceAuthority(authority.surfaceSeal);
        }
        return mutation;
    };

    // Pinia's public setup helper supplies the real tracked action. A proxy
    // revokes before entering that wrapper, preserving $onAction names/arguments.
    const guardMutationAction = <Args extends unknown[], Result>(
        name: string,
        callback: (...args: Args) => Result,
        superseded: () => Result
    ): ((...args: Args) => Result) =>
    {
        const invocations: object[] = [];
        const tracked = action((...args: Args): Result =>
        {
            const invocation = invocations.at(-1);
            if (!invocation || principalMutation !== invocation || principalCustodyEpoch !== invocation)
            {
                return superseded();
            }
            return callback(...args);
        }, name);
        return new Proxy(tracked, {
            apply: (target, _receiver, args: Args): Result =>
            {
                principalCustodyEpoch = null;
                const invocation = {};
                principalCustodyEpoch = invocation;
                principalMutation = invocation;
                invocations.push(invocation);
                try
                {
                    return target(...args);
                }
                finally
                {
                    invocations.pop();
                    if (principalMutation === invocation)
                    {
                        principalMutation = null;
                    }
                }
            }
        });
    };

    onScopeDispose(() =>
    {
        producerDisposed = true;
        retirePrincipalAuthority();
    });

    /** Seal only the original active, fresh, non-step-up principal and surface. */
    const sealAdminPrincipalAuthority = (expectedIdentityId: string): AdminPrincipalSeal | null =>
    {
        const authority = principalAuthority;
        const epoch = principalCustodyEpoch;
        if (!authority || !epoch || principalMutation || producerDisposed || authority.identityId !== expectedIdentityId)
        {
            return null;
        }
        // Clock reads belong to admission, never to the final custody lookup.
        const now = Date.now();
        if (principalAuthority !== authority || principalCustodyEpoch !== epoch || principalMutation || producerDisposed)
        {
            return null;
        }
        if (now - authority.checkedAt >= ADMIN_ACTIVE_TTL_MS)
        {
            retirePrincipalAuthority();
            return null;
        }
        if (!hasPrivateSurfaceAuthorityCustody(authority.surfaceSeal))
        {
            return null;
        }
        const seal = Object.freeze({}) as AdminPrincipalSeal;
        if (principalAuthority !== authority || principalCustodyEpoch !== epoch || principalMutation
            || !hasPrivateSurfaceAuthorityCustody(authority.surfaceSeal))
        {
            return null;
        }
        authoritySeals.set(seal, { authority, epoch });
        return seal;
    };

    /** Pure private join; copied, cancelled, replaced and surface-retired seals refuse. */
    const hasAdminPrincipalAuthorityCustody = (seal: AdminPrincipalSeal): boolean =>
    {
        const custody = authoritySeals.get(seal);
        return custody?.authority === principalAuthority
            && custody.epoch === principalCustodyEpoch && principalMutation === null
            && hasPrivateSurfaceAuthorityCustody(custody.authority.surfaceSeal);
    };

    const cancelAdminPrincipalAuthority = (seal: AdminPrincipalSeal): boolean => authoritySeals.delete(seal);

    /** Auth event producers call this before request advancement or notifications. */
    const invalidateAdminPrincipalAuthority = (): void =>
    {
        retirePrincipalAuthority();
    };

    const adminSessionStatus = computed<AdminSessionStatus>(() =>
    {
        if (adminState.value === 'unknown')
        {
            return 'missing';
        }

        return adminState.value;
    });
    const permissions = computed<readonly string[]>(() =>
    adminState.value === 'active' && adminPrincipal.value
        ? adminPrincipal.value.permissions
        : []);
    const canManage = computed(() => adminState.value === 'active' && permissions.value.length > 0);
    const anonymousCommentsEnabled = computed(() => anonymousCommentPolicy.value.anonymousCommentsEnabled);
    const publicSendOptionEnabled = computed(() => anonymousCommentPolicy.value.publicSendOptionEnabled);
    const zkAnonymousEnabled = computed(() => anonymousCommentPolicy.value.zkAnonymousEnabled);
    const anonymousCommentGovernanceAvailable = computed(() => anonymousCommentPolicy.value.anonymousCommentGovernanceAvailable);
    const zkAnonymousConfigurable = computed(() => anonymousCommentPolicy.value.zkAnonymousConfigurable);
    const commentMaxChars = computed(() => anonymousCommentPolicy.value.commentMaxChars);
    const commentMaxUtf8Bytes = computed(() => anonymousCommentPolicy.value.commentMaxUtf8Bytes);
    const publicOnlyMode = computed(() => !anonymousCommentsEnabled.value && publicSendOptionEnabled.value);
    const totpStepUpRequired = computed(() => adminPrincipal.value?.totpStepUpRequired === true || adminSessionStatus.value === 'step_up_required');

    const hasPermission = (permission: string): boolean =>
        adminState.value === 'active'
    && adminPrincipal.value !== null
    && permissions.value.includes(permission);

    const setAdminPrincipal = (snapshot: AdminPrincipalSnapshot | null): void =>
    {
        const mutation = retirePrincipalAuthority(true);
        if (!mutation || principalMutation !== mutation)
        {
            return;
        }
        let surfaceSeal: PrivateSurfaceAuthoritySeal | null = null;
        try
        {
            // Copy and freeze before publication; caller-owned arrays and Pinia
            // projections must never mutate the admitted original snapshot.
            const principal = snapshot ? Object.freeze({
                ...snapshot,
                permissions: Object.freeze([...snapshot.permissions])
            }) : null;
            const checkedAt = Date.now();
            surfaceSeal = privateSurfaceRuntime.sealAuthority();
            if (principalMutation !== mutation)
            {
                return;
            }
            adminPrincipal.value = principal;
            if (principalMutation !== mutation)
            {
                return;
            }
            adminState.value = principal?.adminSessionStatus ?? 'missing';
            if (principalMutation !== mutation)
            {
                return;
            }
            adminCheckedAt.value = checkedAt;
            if (principalMutation !== mutation)
            {
                return;
            }
            if (principal)
            {
                lastLogoutOutcome.value = null;
            }
            if (principalMutation !== mutation)
            {
                return;
            }
            if (principal?.adminSessionStatus === 'active' && principal.source === 'independent'
                && principal.id.length > 0 && principal.permissions.length > 0
                && principal.totpStepUpRequired !== true && surfaceSeal
                && hasPrivateSurfaceAuthorityCustody(surfaceSeal))
            {
                const authority = { identityId: principal.id, surfaceSeal, checkedAt };
                const expiryTimer = setTimeout(() =>
                {
                    if (principalAuthority === authority)
                    {
                        retirePrincipalAuthority();
                    }
                }, ADMIN_ACTIVE_TTL_MS);
                if (principalMutation === mutation && !producerDisposed && hasPrivateSurfaceAuthorityCustody(surfaceSeal))
                {
                    authorityExpiryTimer = expiryTimer;
                    principalAuthority = authority;
                    surfaceSeal = null;
                }
                else
                {
                    clearTimeout(expiryTimer);
                }
            }
        }
        finally
        {
            if (principalMutation === mutation)
            {
                principalMutation = null;
            }
            if (surfaceSeal)
            {
                cancelPrivateSurfaceAuthority(surfaceSeal);
            }
        }
    };

    const clearAdminPrincipal = (state: AdminSessionState = 'missing'): void =>
    {
        const mutation = retirePrincipalAuthority(true);
        if (!mutation || principalMutation !== mutation)
        {
            return;
        }
        const checkedAt = state === 'unknown' ? 0 : Date.now();
        if (principalMutation !== mutation)
        {
            return;
        }
        adminPrincipal.value = null;
        if (principalMutation !== mutation)
        {
            return;
        }
        adminState.value = state;
        if (principalMutation !== mutation)
        {
            return;
        }
        adminCheckedAt.value = checkedAt;
        if (principalMutation === mutation)
        {
            principalMutation = null;
        }
    };

    const markMissing = (): void =>
    {
        clearAdminPrincipal('missing');
    };

    const invalidateMissingCache = (): void =>
    {
        retirePrincipalAuthority();
        if (adminState.value === 'missing')
        {
            clearAdminPrincipal('unknown');
        }
    };

    const setAnonymousCommentPolicy = (snapshot: Partial<AnonymousCommentPolicySnapshot>): void =>
    {
        anonymousCommentPolicy.value = {
            ...anonymousCommentPolicy.value,
            ...snapshot
        };
    };

    const ensureAdminSessionFresh = async (options?: unknown): Promise<void> =>
    {
        const invocation = principalMutation;
        const force = Boolean(
            options
      && typeof options === 'object'
      && 'force' in options
      && options.force
        );
        const now = Date.now();
        if (principalMutation !== invocation)
        {
            throw new AdminPrincipalMutationSupersededError();
        }

        if (!force)
        {
            if (adminState.value === 'missing' && now - adminCheckedAt.value < ADMIN_NEGATIVE_CACHE_MS)
            {
                return;
            }

            if (adminState.value === 'active' && now - adminCheckedAt.value < ADMIN_ACTIVE_TTL_MS)
            {
                return;
            }
        }

        // A missing result is only a current-page negative cache. Revalidation
        // consumes it before the request so a transport failure remains unknown.
        invalidateMissingCache();

        if (adminSessionRequest)
        {
            return adminSessionRequest;
        }

        retirePrincipalAuthority();
        const controller = new AbortController();
        const generation = adminSessionGeneration;
        adminSessionController = controller;
        adminSessionRequest = (async () =>
        {
            try
            {
                const snapshot = await getAdminMe({ signal: controller.signal });
                if (generation === adminSessionGeneration && adminSessionController === controller)
                {
                    setAdminPrincipal(snapshot);
                }
            }
            catch (error: unknown)
            {
                if (isAbortError(error) || controller.signal.aborted || generation !== adminSessionGeneration)
                {
                    return;
                }

                if (isAuthFailureError(error))
                {
                    clearAdminPrincipal('missing');
                    return;
                }

                console.warn('[AdminStore] Admin session refresh failed.');
            }
            finally
            {
                if (adminSessionController === controller)
                {
                    adminSessionController = null;
                    adminSessionRequest = null;
                }
            }
        })();

        return adminSessionRequest;
    };

    const cancelAdminSessionRequest = (): void =>
    {
        retirePrincipalAuthority();
        adminSessionGeneration += 1;
        adminSessionController?.abort();
        adminSessionController = null;
        adminSessionRequest = null;
    };

    const setLogoutBroadcast = (
        callback: (() => void) | null,
        ownsWrite?: () => boolean,
        expected?: () => void
    ): void =>
    {
        if ((ownsWrite && !ownsWrite()) || (expected && logoutBroadcast !== expected))
        {
            return;
        }
        logoutBroadcast = callback;
    };

    const logout = async (): Promise<AdminLogoutOutcome> =>
    {
        if (lastLogoutOutcome.value?.serverRevocationConfirmed && lastLogoutOutcome.value.localCleanupComplete)
        {
            return lastLogoutOutcome.value;
        }

        if (logoutRequest)
        {
            return logoutRequest;
        }

        retirePrincipalAuthority();
        logoutRequest = (async () =>
        {
            const previousOutcome = lastLogoutOutcome.value;
            let status: AdminLogoutStatus = previousOutcome?.serverRevocationConfirmed
                ? previousOutcome.status
                : 'revoked';
            let serverRevocationConfirmed = previousOutcome?.serverRevocationConfirmed === true;
            let serverRevocationFailed = false;

            if (!serverRevocationConfirmed)
            {
                try
                {
                    await logoutAdmin();
                    serverRevocationConfirmed = true;
                }
                catch (error: unknown)
                {
                    if (isAuthFailureError(error))
                    {
                        status = 'already_inactive';
                        serverRevocationConfirmed = true;
                    }
                    else
                    {
                        status = 'local_only';
                        serverRevocationFailed = true;
                    }
                }
            }

            let localCleanupComplete = true;
            try
            {
                await privateSurfaceRuntime.invalidate('admin-logout', async () =>
                {
                    cancelAdminSessionRequest();
                    clearLocalFixtureAdminSession();
                    clearAdminPrincipal();
                    await clearPrivateBrowserState('admin-logout');
                });
            }
            catch
            {
                localCleanupComplete = false;
            }

            try
            {
                logoutBroadcast?.();
            }
            catch
            {
                localCleanupComplete = false;
            }

            const outcome: AdminLogoutOutcome = Object.freeze({
                status,
                serverRevocationConfirmed,
                localCleanupComplete
            });
            lastLogoutOutcome.value = outcome;

            if (serverRevocationFailed)
            {
                throw new AdminLogoutUnconfirmedError(outcome);
            }

            if (!localCleanupComplete)
            {
                throw new AdminLogoutCleanupError(outcome);
            }

            return outcome;
        })();

        try
        {
            return await logoutRequest;
        }
        finally
        {
            logoutRequest = null;
        }
    };

    // Keep Pinia's original state/ref entry points while routing every public
    // top-level write through this owner. Getters track the private backing refs.
    const principalProjection = customRef<AdminPrincipalSnapshot | null>(() => ({
        get: () => adminPrincipal.value,
        set: setAdminPrincipal
    }));
    const stateProjection = customRef<AdminSessionState>(() => ({
        get: () => adminState.value,
        set: (state) =>
        {
            const mutation = retirePrincipalAuthority(true);
            if (mutation && principalMutation === mutation)
            {
                adminState.value = state;
                if (principalMutation === mutation)
                {
                    principalMutation = null;
                }
            }
        }
    }));
    const checkedAtProjection = customRef<number>(() => ({
        get: () => adminCheckedAt.value,
        set: (checkedAt) =>
        {
            const mutation = retirePrincipalAuthority(true);
            if (mutation && principalMutation === mutation)
            {
                adminCheckedAt.value = checkedAt;
                if (principalMutation === mutation)
                {
                    principalMutation = null;
                }
            }
        }
    }));

    return {
        adminPrincipal: principalProjection,
        adminState: stateProjection,
        adminCheckedAt: checkedAtProjection,
        lastLogoutOutcome,
        anonymousCommentPolicy,
        adminSessionStatus,
        permissions,
        canManage,
        anonymousCommentsEnabled,
        publicSendOptionEnabled,
        zkAnonymousEnabled,
        anonymousCommentGovernanceAvailable,
        zkAnonymousConfigurable,
        commentMaxChars,
        commentMaxUtf8Bytes,
        publicOnlyMode,
        totpStepUpRequired,
        hasPermission,
        // These are stable functions rather than Pinia actions: its action
        // wrapper allocates and notifies subscribers even for a final `has`.
        sealAdminPrincipalAuthority: computed(() => sealAdminPrincipalAuthority),
        hasAdminPrincipalAuthorityCustody: computed(() => hasAdminPrincipalAuthorityCustody),
        cancelAdminPrincipalAuthority: computed(() => cancelAdminPrincipalAuthority),
        invalidateAdminPrincipalAuthority: computed(() => invalidateAdminPrincipalAuthority),
        setAdminPrincipal: guardMutationAction('setAdminPrincipal', setAdminPrincipal, () => undefined),
        clearAdminPrincipal: guardMutationAction('clearAdminPrincipal', clearAdminPrincipal, () => undefined),
        markMissing: guardMutationAction('markMissing', markMissing, () => undefined),
        invalidateMissingCache: guardMutationAction('invalidateMissingCache', invalidateMissingCache, () => undefined),
        ensureAdminSessionFresh: guardMutationAction('ensureAdminSessionFresh', ensureAdminSessionFresh,
            () => Promise.reject(new AdminPrincipalMutationSupersededError())),
        cancelAdminSessionRequest: guardMutationAction('cancelAdminSessionRequest', cancelAdminSessionRequest, () => undefined),
        setAnonymousCommentPolicy,
        setLogoutBroadcast,
        logout: guardMutationAction('logout', logout, () => Promise.reject(new AdminPrincipalMutationSupersededError()))
    };
});
