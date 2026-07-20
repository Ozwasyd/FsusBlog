<template>
    <div class="account-layout-root account-shell min-h-screen">
        <a
            href="#account-main"
            class="account-skip-link sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:z-[100] focus-visible:left-4 focus-visible:top-4"
        >
            {{ messages.admin.shell.skipToMain }}
        </a>

        <SiteChromeHeaderAdapter
            :site-title="workspaceContext.brandTitle"
            :site-logo-url="workspaceContext.brandImages.siteLogoUrl"
            :site-logo-dark-url="workspaceContext.brandImages.siteLogoDarkUrl"
            :site-wordmark-url="workspaceContext.brandImages.siteWordmarkUrl"
            :admin-logo-url="workspaceContext.brandImages.adminLogoUrl"
            :admin-collapsed-icon-url="workspaceContext.brandImages.adminCollapsedIconUrl"
            brand-context="account"
            brand-link-class="account-header-brand"
            max-width="var(--fsusblog-container-workbench)"
            header-class="account-site-header"
            inner-class="account-site-header__inner"
            primary-row-class="account-site-header__primary-row"
            desktop-actions-class="account-site-header__actions"
            mobile-primary-actions-class="account-site-header__mobile-actions"
            :show-desktop-theme-toggle="false"
            :show-mobile-theme-toggle="false"
        >
            <template #desktop-actions>
                <RouterLink
                    to="/"
                    class="account-header-link"
                >
                    {{ messages.admin.shell.mainSite }}
                </RouterLink>
                <ThemeModeToggle
                    class="account-header-theme-action"
                    variant="menu-button"
                />
                <LocaleToggle />
                <AccountHeaderMenu
                    :can-manage="workspaceContext.canManage"
                    :current-area="currentArea"
                    :is-logging-out="isLoggingOut"
                    @open-policy="openPolicy"
                    @logout="handleLogout"
                />
            </template>

            <template #mobile-primary-actions>
                <RouterLink
                    to="/"
                    class="account-header-link account-header-link--mobile"
                >
                    {{ messages.admin.shell.mainSite }}
                </RouterLink>
                <ThemeModeToggle
                    class="account-header-theme-action account-header-theme-action--mobile"
                    variant="menu-button"
                />
                <LocaleToggle />
                <AccountHeaderMenu
                    :can-manage="workspaceContext.canManage"
                    compact
                    :current-area="currentArea"
                    :is-logging-out="isLoggingOut"
                    @open-policy="openPolicy"
                    @logout="handleLogout"
                />
                <RouterView name="accountMobileAction" />
            </template>
        </SiteChromeHeaderAdapter>

        <RouterView />

        <PolicyModal
            v-model:visible="showPolicy"
            :type="policyType"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import AccountHeaderMenu from '@/components/account/AccountHeaderMenu.vue';
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue';
import PolicyModal from '@/components/PolicyModal.vue';
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue';
import LocaleToggle from '@/components/ui/LocaleToggle.vue';
import { useI18nText } from '@/composables/useI18nText';
import { provideAccountFrameDrawerState } from '@/layouts/accountFrameContext';
import type { AccountArea } from '@/layouts/accountNav';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';
import { showErrorToast } from '@/utils/errorPresentation';

const workspaceContext = useAccountWorkspaceContext();
const { initializeLocaleRuntime, messages } = useI18nText();
onMounted(initializeLocaleRuntime);

const showPolicy = ref(false);
const policyType = ref<'privacy' | 'guidelines'>('guidelines');
const isLoggingOut = ref(false);
provideAccountFrameDrawerState();

const currentArea = computed<AccountArea>(() =>
    workspaceContext.value.surface
);

const openPolicy = (type: 'privacy' | 'guidelines') =>
{
    policyType.value = type;
    showPolicy.value = true;
};

const handleLogout = async () =>
{
    if (isLoggingOut.value)
    {
        return;
    }

    isLoggingOut.value = true;
    try
    {
        await workspaceContext.value.logout();
    }
    catch (error)
    {
        showErrorToast(error, messages.value.admin.shell.logoutFailed);
    }
    finally
    {
        isLoggingOut.value = false;
    }
};
</script>
