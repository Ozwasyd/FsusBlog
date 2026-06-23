<template>
  <div class="account-page profile-page">
    <FsusUiPageHeader
      :title="profileCopy.pageTitle"
      :content="profileCopy.pageDescription"
    />

    <ProfileInlineEmptyState
      :title="profileCopy.emptyTitle"
      :content="profileCopy.emptyContent"
    >
      <template #actions>
        <router-link
          to="/user/identity"
          class="inline-flex rounded-[var(--fsus-radius-control)] bg-[var(--fsusblog-color-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--fsusblog-color-primary-hover)] focus-visible:outline-none"
        >
          {{ profileCopy.openIdentityCta }}
        </router-link>
      </template>
    </ProfileInlineEmptyState>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { FsusUiPageHeader } from "@/fsusui"
import { ProfileInlineEmptyState } from '@/components/user/ProfileSettingsPrimitives'
import { FSUSBLOG_IDENTITY_COPY } from '@/copy'

const profileCopy = FSUSBLOG_IDENTITY_COPY.profile

const router = useRouter()

onMounted(() => {
  void router.replace({ name: 'UserIdentityOverview' })
})
</script>