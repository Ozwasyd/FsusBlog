<template>
  <div class="fsus-security-challenge__panel" data-fsus-pospace-challenge="true">
    <slot :assignment="assignment" :provider-payload="providerPayload" :refresh="refresh">
      <p data-test="security-challenge-unsupported">当前 PoSpace 验证需要业务方提供子组件。</p>
    </slot>
  </div>
</template>

<script setup lang="ts">
import type {
  SecurityChallengeAssignment,
  SecurityChallengeProviderPayload
} from '@/api/security'

defineProps<{
  assignment: SecurityChallengeAssignment | null
  providerPayload: SecurityChallengeProviderPayload | null
  refresh: () => Promise<void>
}>()
</script>
