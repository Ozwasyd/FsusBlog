<template>
  <div class="account-page profile-page">
    <AccountPageHeader
      title="身份中心"
      description="资料页已迁移到身份中心。"
    />

    <ProfileInlineEmptyState
      title="资料页已迁移"
      description="匿名账号设置集中在身份中心，包括 Passkey、Recovery Key、TOTP step-up、设备会话、公开称呼和匿名评论边界。"
    >
      <template #actions>
        <router-link
          to="/user/identity"
          class="inline-flex rounded-[var(--fsus-radius-control)] bg-[var(--fsusblog-color-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--fsusblog-color-primary-hover)] focus-visible:outline-none"
        >
          打开身份中心
        </router-link>
      </template>
    </ProfileInlineEmptyState>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import { ProfileInlineEmptyState } from '@/components/user/ProfileSettingsPrimitives'

const router = useRouter()

onMounted(() => {
  void router.replace({ name: 'UserIdentityOverview' })
})
</script>
