<template>
    <ElDropdown
        trigger="click"
        placement="bottom-end"
        @command="handleCommand"
        @visible-change="menuOpen = $event"
    >
        <FsusUiButton
            native-type="button"
            :size="compact ? 'default' : 'small'"
            class="account-header-menu__trigger"
            aria-label="打开账号菜单"
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
        >
            <span :class="{ 'sr-only': compact }">账号</span>
            <ElIcon
                :size="18"
                aria-hidden="true"
            ><ArrowDown /></ElIcon>
        </FsusUiButton>

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

import { FsusUiButton } from '@/fsusui/button';
import { ArrowDown } from '@/fsusui/icons';
import type { AccountArea } from '@/layouts/accountNav';

type AccountMenuCommand = 'account' | 'manage' | 'guidelines' | 'privacy' | 'logout';

const props = withDefaults(defineProps<{
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

    if (command === 'logout' && !props.isLoggingOut)
    {
        emit('logout');
    }
};
</script>
