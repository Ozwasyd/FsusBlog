<template>
  <div class="fsus-security-challenge__panel" data-fsus-passkey-step-up-challenge="true">
    <slot :assignment="assignment" :provider-payload="providerPayload" :refresh="refresh">
      <p data-test="security-challenge-unsupported">{{ copy.unavailable }}</p>
    </slot>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type {
  SecurityChallengeAssignment,
  SecurityChallengeProviderPayload
} from '@/api/security'
import { useI18nText } from '@/composables/useI18nText'

defineProps<{
  assignment: SecurityChallengeAssignment | null
  providerPayload: SecurityChallengeProviderPayload | null
  refresh: () => Promise<void>
}>()

const { messages } = useI18nText()
const copy = computed(() => messages.value.security.passkeyStepUp)
</script>