<template>
    <div class="account-layout-root account-shell min-h-screen">
        <a
            href="#account-main"
            class="account-skip-link sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:z-[100] focus-visible:left-4 focus-visible:top-4"
        >
            跳到主要内容
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
                    主站
                </RouterLink>
                <ThemeModeToggle
                    class="account-header-theme-action"
                    variant="menu-button"
                />
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
                    主站
                </RouterLink>
                <ThemeModeToggle
                    class="account-header-theme-action account-header-theme-action--mobile"
                    variant="menu-button"
                />
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
import { computed, ref } from 'vue';

import AccountHeaderMenu from '@/components/account/AccountHeaderMenu.vue';
import SiteChromeHeaderAdapter from '@/components/layout/SiteChromeHeaderAdapter.vue';
import PolicyModal from '@/components/PolicyModal.vue';
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue';
import { provideAccountFrameDrawerState } from '@/layouts/accountFrameContext';
import type { AccountArea } from '@/layouts/accountNav';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';
import { showErrorToast } from '@/utils/errorPresentation';

const workspaceContext = useAccountWorkspaceContext();

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
        showErrorToast(error, '登出失败，请稍后重试');
    }
    finally
    {
        isLoggingOut.value = false;
    }
};
</script>

<style scoped>
/* stylelint-disable scss/at-rule-no-unknown, selector-pseudo-class-no-unknown -- Vue deep selectors and Tailwind reference are compile-time syntax. */
@reference "@/assets/main.css";

.account-header-link
 {
    @apply inline-flex items-center justify-center px-2 text-xs font-medium normal-case tracking-normal disabled:cursor-not-allowed disabled:opacity-60;

    min-width: var(--fsus-control-height-compact);
    min-height: var(--fsus-control-height-compact);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-secondary);
    text-decoration: none;
    transition:
        border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-header-link:hover
 {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-color-primary);
}

.account-header-link:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.account-header-link--mobile
 {
    min-width: var(--fsus-control-height);
    min-height: var(--fsus-control-height);
}

:deep(.account-header-theme-action > button)
 {
    min-width: var(--fsus-control-height-compact);
    min-height: var(--fsus-control-height-compact);
    border-color: var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
}

:deep(.account-header-theme-action > button:hover),
:deep(.account-header-theme-action > button[aria-expanded="true"])
 {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-color-primary);
}

:deep(.account-header-theme-action--mobile > button)
 {
    min-width: var(--fsus-control-height);
    min-height: var(--fsus-control-height);
}

:deep(.account-header-brand)
 {
    display: inline-flex;
    min-height: 2.5rem;
    min-width: 0;
    align-items: center;
    gap: var(--fsus-space-2);
    color: var(--fsusblog-text-primary);
    text-decoration: none;
}

.account-skip-link:focus-visible
 {
    padding: var(--fsus-space-4);
    background: var(--fsusblog-text-primary);
    color: var(--fsusblog-page-bg);
    font-size: 12px;
    font-weight: 700;
    text-transform: none;
}

/* Frame CSS ownership remains here until FB-08; :global reaches nested and teleported frame surfaces. */
:global(.account-mobile-drawer-trigger)
 {
    display: inline-flex;
    min-height: var(--fsus-control-height);
    width: var(--fsus-control-height);
    align-items: center;
    justify-content: center;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-secondary);
    padding: 0;
    transition:
        border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

:global(.account-mobile-drawer-trigger:hover),
:global(.account-mobile-drawer-trigger[aria-expanded="true"])
 {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-color-primary);
}

:global(.account-mobile-drawer-trigger:focus-visible)
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

:global(.account-mobile-drawer)
 {
    display: flex;
    height: 100vh;
    height: 100dvh;
    max-height: 100dvh;
    flex-direction: column;
    overflow: hidden;
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
}

:global(.account-mobile-drawer .el-drawer__header)
 {
    margin-bottom: 0;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-4) var(--fsus-space-5);
}

:global(.account-mobile-drawer .el-drawer__title)
 {
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
}

:global(.account-mobile-drawer .el-drawer__body)
 {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
    gap: var(--fsus-space-5);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--fsus-space-5);
}

:global(.account-mobile-drawer-nav)
 {
    flex: 0 0 auto;
    padding-bottom: env(safe-area-inset-bottom, 0);
}

:global(.account-sidebar-frame)
 {
    padding-bottom: var(--fsus-space-6);
}

:global(.account-main-scroll)
 {
    min-height: 0;
}

@media (width >= 1024px)
 {
    :global(.account-main-scroll)
 {
        max-height: calc(100vh - 7rem);
        max-height: calc(100dvh - 7rem);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding-bottom: var(--fsus-space-8);
    }
}

@media (height <= 520px) and (orientation: landscape)
 {
    :deep(.account-site-header__inner)
 {
        padding-block: var(--fsus-space-2);
    }

    :deep(.account-site-header__primary-row)
 {
        gap: var(--fsus-space-3);
    }

    :deep(.account-site-header__actions)
 {
        display: none;
    }

    :deep(.account-site-header__mobile-actions)
 {
        display: inline-flex;
        min-width: 0;
        align-items: center;
        justify-content: flex-end;
        gap: var(--fsus-space-2);
    }
}

@media (forced-colors: active)
 {
    .account-header-link,
    :global(.account-mobile-drawer-trigger),
    :deep(.account-header-theme-action > button)
 {
        border-color: ButtonText;
    }

    .account-header-link:focus-visible,
    :global(.account-mobile-drawer-trigger:focus-visible),
    :deep(.account-header-theme-action > button:focus-visible)
 {
        outline: 2px solid Highlight;
        outline-offset: -2px;
    }
}

</style>
