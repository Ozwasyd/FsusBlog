<template>
  <div class="fsus-security-challenge__panel" data-fsus-passkey-step-up-challenge="true">
    <slot :assignment="assignment" :provider-payload="providerPayload" :refresh="refresh">
      <p data-test="security-challenge-unsupported">{{ copy.unavailable }}</p>
    </slot>
  </div>
</template>

<script setup lang="ts">
import type {
  SecurityChallengeAssignment,
  SecurityChallengeProviderPayload
} from '@/api/security'
import { FSUSBLOG_SECURITY_COPY } from '@/copy'

defineProps<{
  assignment: SecurityChallengeAssignment | null
  providerPayload: SecurityChallengeProviderPayload | null
  refresh: () => Promise<void>
}>()

const copy = FSUSBLOG_SECURITY_COPY.passkeyStepUp
</script>