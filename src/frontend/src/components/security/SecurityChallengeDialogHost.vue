<template>
    <FsusDialog
        v-model="visible"
        data-test="security-challenge-dialog-host"
        :title="copy.title"
        width="min(92vw, 28rem)"
        destroy-on-close
        :close-on-click-modal="false"
        @close="handleClose"
        @closed="coordinator.restoreFocus"
        @opened="focusChallenge"
    >
        <FsusSecurityChallenge
            v-if="context"
            ref="challengeHost"
            :action="context.action"
            :route-key="context.routeKey"
            :attributes="context.attributes"
            :identity="context.identity"
            :client="coordinator.challengeClient"
            dialog-composition
            @ready="focusChallenge"
            @verified="handleVerified"
            @error="coordinator.handleError"
            @expired="coordinator.handleExpired"
            @cancel="coordinator.handleCancel"
        />

        <template #footer>
            <ElButton
                data-test="security-challenge-cancel"
                @click="coordinator.handleCancel"
            >
                {{ copy.cancel }}
            </ElButton>
        </template>
    </FsusDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

import FsusSecurityChallenge from '@/components/security/FsusSecurityChallenge.vue';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import { useI18nText } from '@/composables/useI18nText';
import { getRiskChallengeCoordinator } from '@/composables/useRiskChallengeCommand';

const coordinator = getRiskChallengeCoordinator();
const { messages } = useI18nText();
const copy = computed(() => messages.value.security.challenge);
const context = coordinator.challengeContext;
const challengeHost = ref<{ focus?: () => void; } | null>(null);
let terminalHandled = false;

const visible = computed({
    get: () => coordinator.challengeVisible.value,
    set: (value: boolean) =>
    {
        if (!value && coordinator.challengeVisible.value)
        {
            coordinator.handleCancel();
        }
    }
});

function focusChallenge(): void
{
    void nextTick(() => challengeHost.value?.focus?.());
}

function handleVerified(): void
{
    if (terminalHandled)
    {
        return;
    }
    terminalHandled = true;
    void coordinator.handleVerified().finally(() =>
    {
        terminalHandled = false;
    });
}

function handleClose(): void
{
    if (coordinator.challengeVisible.value)
    {
        coordinator.handleCancel();
    }
}

onBeforeUnmount(() => coordinator.handleCancel());
</script>
