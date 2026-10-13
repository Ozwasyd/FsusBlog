import { computed, type ComputedRef } from 'vue';
import { useRoute } from 'vue-router';

import {
    accountAreaMeta,
    type AccountAreaMeta
} from '@/layouts/accountNav';
import { useAdminStore, type AdminLogoutOutcome } from '@/store/admin';
import { useSiteStore } from '@/store/site';
import { useUserStore } from '@/store/user';

export type AccountWorkspaceSurface = 'self' | 'manage';

export interface AccountWorkspaceFeatures {
    anonymousCommentsEnabled: boolean;
    zkAnonymousEnabled: boolean;
    publicSendOptionEnabled: boolean;
}

export interface AccountWorkspacePolicies {
    anonymousCommentGovernanceAvailable: boolean;
    zkAnonymousConfigurable: boolean;
}

export interface AccountWorkspaceContext {
    surface: 'self' | 'manage';
    canManage: boolean;
    permissions: readonly string[];
    features: AccountWorkspaceFeatures;
    policies: AccountWorkspacePolicies;
    areaMeta: AccountAreaMeta;
    brandTitle: string;
    brandImages: AccountWorkspaceBrandImages;
    logout: () => Promise<void | AdminLogoutOutcome>;
}

export interface AccountWorkspaceBrandImages {
    adminLogoUrl?: string;
    adminCollapsedIconUrl?: string;
    siteWordmarkUrl?: string;
    siteLogoUrl?: string;
    siteLogoDarkUrl?: string;
}

export function useAccountWorkspaceContext(): ComputedRef<AccountWorkspaceContext>
{
    const route = useRoute();
    const siteStore = useSiteStore();
    const userStore = useUserStore();
    const adminStore = useAdminStore();

    return computed(() =>
    {
        const surface: AccountWorkspaceSurface = route.meta.accountArea === 'manage' ? 'manage' : 'self';
        const logout = surface === 'manage' ? adminStore.logout : userStore.logout;

        return {
            surface,
            canManage: adminStore.canManage,
            permissions: adminStore.permissions,
            features: {
                anonymousCommentsEnabled: adminStore.anonymousCommentsEnabled,
                zkAnonymousEnabled: adminStore.zkAnonymousEnabled,
                publicSendOptionEnabled: adminStore.publicSendOptionEnabled
            },
            policies: {
                anonymousCommentGovernanceAvailable: adminStore.anonymousCommentGovernanceAvailable,
                zkAnonymousConfigurable: adminStore.zkAnonymousConfigurable
            },
            areaMeta: accountAreaMeta[surface],
            brandTitle: siteStore.siteInfo.title,
            brandImages: {
                adminLogoUrl: siteStore.siteInfo.adminLogoUrl,
                adminCollapsedIconUrl: siteStore.siteInfo.adminCollapsedIconUrl,
                siteWordmarkUrl: siteStore.siteInfo.siteWordmarkUrl,
                siteLogoUrl: siteStore.siteInfo.siteLogoUrl,
                siteLogoDarkUrl: siteStore.siteInfo.siteLogoDarkUrl
            },
            logout
        };
    });
}
