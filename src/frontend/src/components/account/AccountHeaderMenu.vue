<template>
    <ElDropdown
        trigger="click"
        placement="bottom-end"
        @command="handleCommand"
        @visible-change="menuOpen = $event"
    >
        <button
            type="button"
            class="account-header-menu__trigger"
            :class="{ 'account-header-menu__trigger--touch': compact }"
            aria-label="打开账号菜单"
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
        >
            <span :class="{ 'sr-only': compact }">账号</span>
            <ElIcon
                :size="18"
                aria-hidden="true"
            ><ArrowDown /></ElIcon>
        </button>

        <template #dropdown>
            <ElDropdownMenu>
                <ElDropdownItem
                    v-if="currentArea === 'manage' || canManage"
                    :command="currentArea === 'manage' ? 'account' : 'manage'"
                >
                    {{ currentArea === 'manage' ? '账户中心' : '管理后台' }}
                </ElDropdownItem>
                <ElDropdownItem command="guidelines">使用规范</ElDropdownItem>
                <ElDropdownItem command="privacy">隐私政策</ElDropdownItem>
                <ElDropdownItem
                    command="logout"
                    divided
                    :disabled="isLoggingOut"
                >
                    {{ isLoggingOut ? '登出中…' : '登出' }}
                </ElDropdownItem>
            </ElDropdownMenu>
        </template>
    </ElDropdown>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { ArrowDown } from '@/fsusui/icons';
import type { AccountArea } from '@/layouts/accountNav';

type AccountMenuCommand = 'account' | 'manage' | 'guidelines' | 'privacy' | 'logout';

withDefaults(defineProps<{
    canManage: boolean;
    compact?: boolean;
    currentArea: AccountArea;
    isLoggingOut: boolean;
}>(), {
    compact: false
});

const emit = defineEmits<{
    (e: 'open-policy', type: 'privacy' | 'guidelines'): void;
    (e: 'logout'): void;
}>();

const router = useRouter();
const menuOpen = ref(false);

const handleCommand = (rawCommand: string | number | object): void =>
{
    if (typeof rawCommand !== 'string')
    {
        return;
    }

    const command = rawCommand as AccountMenuCommand;
    if (command === 'account')
    {
        void router.push('/user/identity');
        return;
    }

    if (command === 'manage')
    {
        void router.push('/user/manage');
        return;
    }

    if (command === 'guidelines' || command === 'privacy')
    {
        emit('open-policy', command);
        return;
    }

    if (command === 'logout')
    {
        emit('logout');
    }
};
</script>

<style scoped>
.account-header-menu__trigger
 {
    display: inline-flex;
    min-height: var(--fsus-control-height-compact);
    min-width: var(--fsus-control-height-compact);
    align-items: center;
    justify-content: center;
    gap: var(--fsus-space-1);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    padding-inline: var(--fsus-space-2);
    transition:
        border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-header-menu__trigger--touch
 {
    min-height: var(--fsus-control-height);
    min-width: var(--fsus-control-height);
}

.account-header-menu__trigger:hover,
.account-header-menu__trigger[aria-expanded="true"]
 {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-color-primary);
}

.account-header-menu__trigger:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

@media (forced-colors: active)
 {
    .account-header-menu__trigger
 {
        border-color: ButtonText;
    }

    .account-header-menu__trigger:focus-visible
 {
        outline: 2px solid Highlight;
        outline-offset: -2px;
    }
}
</style>
