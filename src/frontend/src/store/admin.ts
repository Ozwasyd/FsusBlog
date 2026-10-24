import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { getAdminMe, logoutAdmin } from '@/api/auth';
import { clearLocalFixtureAdminSession } from '@/services/localFixtureSession';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { isAuthFailureError } from '@/utils/errorKinds';
import { isAbortError } from '@/utils/errors';

export type AdminSessionStatus = 'missing' | 'active' | 'expired' | 'step_up_required';
export type AdminSessionState = 'unknown' | AdminSessionStatus;
export type AdminPrincipalSource = 'independent';

export const ADMIN_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
export const ADMIN_ACTIVE_TTL_MS = 60 * 1000;

export interface AdminPrincipalSnapshot {
    id: string;
    displayName: string;
    source: AdminPrincipalSource;
    permissions: readonly string[];
    adminSessionStatus: AdminSessionStatus;
    totpStepUpRequired?: boolean;
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
        adminPrincipal.value = snapshot ? {
      ...snapshot,
      permissions: [...snapshot.permissions]
    } : null;
        adminState.value = snapshot?.adminSessionStatus ?? 'missing';
        adminCheckedAt.value = Date.now();
        if (snapshot)
        {
            lastLogoutOutcome.value = null;
        }
    };

    const clearAdminPrincipal = (state: AdminSessionState = 'missing'): void =>
    {
        adminPrincipal.value = null;
        adminState.value = state;
        adminCheckedAt.value = Date.now();
    };

    const markMissing = (): void =>
    {
        clearAdminPrincipal('missing');
    };

    const invalidateMissingCache = (): void =>
    {
        if (adminState.value === 'missing')
        {
            adminPrincipal.value = null;
            adminState.value = 'unknown';
            adminCheckedAt.value = 0;
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
        adminPrincipal,
        adminState,
        adminCheckedAt,
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
