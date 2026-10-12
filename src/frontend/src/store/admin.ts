import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';

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

export const useAdminStore = defineStore('admin', () =>
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
    const authoritySeals = new WeakMap<AdminPrincipalSeal, AdminPrincipalAuthority>();
    let principalAuthority: AdminPrincipalAuthority | null = null;
    let principalMutation: object | null = null;
    let producerDisposed = false;
    let authorityExpiryTimer: ReturnType<typeof setTimeout> | null = null;

    const retirePrincipalAuthority = (): void =>
    {
        const authority = principalAuthority;
        principalAuthority = null;
        principalMutation = null;
        if (authorityExpiryTimer !== null)
        {
            clearTimeout(authorityExpiryTimer);
            authorityExpiryTimer = null;
        }
        if (authority)
        {
            privateSurfaceRuntime.cancelAuthority(authority.surfaceSeal);
        }
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
        if (!authority || principalMutation || producerDisposed || authority.identityId !== expectedIdentityId)
        {
            return null;
        }
        // Clock reads belong to admission, never to the final custody lookup.
        if (Date.now() - authority.checkedAt >= ADMIN_ACTIVE_TTL_MS)
        {
            retirePrincipalAuthority();
            return null;
        }
        if (!hasPrivateSurfaceAuthorityCustody(authority.surfaceSeal))
        {
            return null;
        }
        const seal = Object.freeze({}) as AdminPrincipalSeal;
        if (principalAuthority !== authority || principalMutation
            || !hasPrivateSurfaceAuthorityCustody(authority.surfaceSeal))
        {
            return null;
        }
        authoritySeals.set(seal, authority);
        return seal;
    };

    /** Pure private join; copied, cancelled, replaced and surface-retired seals refuse. */
    const hasAdminPrincipalAuthorityCustody = (seal: AdminPrincipalSeal): boolean =>
    {
        const authority = authoritySeals.get(seal);
        return authority !== undefined && authority === principalAuthority && principalMutation === null
            && hasPrivateSurfaceAuthorityCustody(authority.surfaceSeal);
    };

    const cancelAdminPrincipalAuthority = (seal: AdminPrincipalSeal): boolean => authoritySeals.delete(seal);

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
        retirePrincipalAuthority();
        const mutation = {};
        principalMutation = mutation;
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
                && privateSurfaceRuntime.hasAuthorityCustody(surfaceSeal))
            {
                const authority = { identityId: principal.id, surfaceSeal, checkedAt };
                authorityExpiryTimer = setTimeout(() =>
                {
                    if (principalAuthority === authority)
                    {
                        retirePrincipalAuthority();
                    }
                }, ADMIN_ACTIVE_TTL_MS);
                if (principalMutation === mutation && !producerDisposed && privateSurfaceRuntime.hasAuthorityCustody(surfaceSeal))
                {
                    principalAuthority = authority;
                    surfaceSeal = null;
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
                privateSurfaceRuntime.cancelAuthority(surfaceSeal);
            }
        }
    };

    const clearAdminPrincipal = (state: AdminSessionState = 'missing'): void =>
    {
        retirePrincipalAuthority();
        const mutation = {};
        principalMutation = mutation;
        const checkedAt = state === 'unknown' ? 0 : Date.now();
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

    const ensureAdminSessionFresh = async (options?: EnsureAdminSessionFreshOptions | unknown): Promise<void> =>
    {
        const force = Boolean(
            options
      && typeof options === 'object'
      && 'force' in options
      && (options as EnsureAdminSessionFreshOptions).force
        );
        const now = Date.now();

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

    const setLogoutBroadcast = (callback: (() => void) | null): void =>
    {
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

    return {
        adminPrincipal: computed(() => adminPrincipal.value),
        adminState: computed(() => adminState.value),
        adminCheckedAt: computed(() => adminCheckedAt.value),
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
        sealAdminPrincipalAuthority,
        hasAdminPrincipalAuthorityCustody,
        cancelAdminPrincipalAuthority,
        setAdminPrincipal,
        clearAdminPrincipal,
        markMissing,
        invalidateMissingCache,
        ensureAdminSessionFresh,
        cancelAdminSessionRequest,
        setAnonymousCommentPolicy,
        setLogoutBroadcast,
        logout
    };
});
