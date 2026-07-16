<template>
  <el-dropdown
    trigger="click"
    placement="bottom-end"
    @command="handleCommand"
    @visible-change="menuOpen = $event"
  >
    <button
      type="button"
      class="account-header-menu__trigger"
      aria-label="打开账号菜单"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
    >
      <span :class="{ 'sr-only': compact }">账号</span>
      <el-icon :size="14" aria-hidden="true"><ArrowDown /></el-icon>
    </button>

    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-if="currentArea === 'manage' || canManage"
          :command="currentArea === 'manage' ? 'account' : 'manage'"
        >
          {{ currentArea === 'manage' ? '账户中心' : '管理后台' }}
        </el-dropdown-item>
        <el-dropdown-item command="guidelines">使用规范</el-dropdown-item>
        <el-dropdown-item command="privacy">隐私政策</el-dropdown-item>
        <el-dropdown-item command="logout" divided :disabled="isLoggingOut">
          {{ isLoggingOut ? '登出中…' : '登出' }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowDown } from '@/fsusui/icons'
import type { AccountArea } from '@/layouts/accountNav'

type AccountMenuCommand = 'account' | 'manage' | 'guidelines' | 'privacy' | 'logout'

withDefaults(defineProps<{
  canManage: boolean
  compact?: boolean
  currentArea: AccountArea
  isLoggingOut: boolean
}>(), {
  compact: false
})

const emit = defineEmits<{
  (e: 'open-policy', type: 'privacy' | 'guidelines'): void
  (e: 'logout'): void
}>()

const router = useRouter()
const menuOpen = ref(false)

const handleCommand = (rawCommand: string | number | object): void => {
  const command = String(rawCommand) as AccountMenuCommand
  if (command === 'account') {
    void router.push('/user/identity')
    return
  }

  if (command === 'manage') {
    void router.push('/user/manage')
    return
  }

  if (command === 'guidelines' || command === 'privacy') {
    emit('open-policy', command)
    return
  }

  if (command === 'logout') {
    emit('logout')
  }
}
</script>

<style scoped>
.account-header-menu__trigger {
  display: inline-flex;
  min-height: 2.5rem;
  min-width: 2.5rem;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  border: 1px solid transparent;
  border-radius: var(--fsus-radius-control-small);
  background: transparent;
  color: var(--fsusblog-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  padding-inline: 0.5rem;
  transition:
    border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-header-menu__trigger:hover {
  border-color: var(--fsusblog-panel-border);
  color: var(--fsusblog-text-primary);
}

.account-header-menu__trigger:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  outline: none;
}
</style>
