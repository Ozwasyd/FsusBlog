<template>
    <div class="auth-page-content w-full max-w-md">
        <section
            class="w-full max-w-md"
            aria-labelledby="register-title"
        >
            <header class="mb-6">
                <h1
                    id="register-title"
                    class="text-2xl font-bold leading-tight tracking-normal text-[var(--fsusblog-text-primary)] sm:text-3xl"
                >
                    {{ copy.title }}
                </h1>
                <p class="mt-4 max-w-sm text-sm font-normal leading-7 text-[var(--fsusblog-text-secondary)]">
                    {{ copy.description }}
                </p>
            </header>

            <div class="space-y-6">
                <section
                    v-if="step === 'account'"
                    class="space-y-6"
                    aria-labelledby="anonymous-account-title"
                >
                    <div>
                        <h2
                            id="anonymous-account-title"
                            class="text-sm font-medium text-[var(--fsusblog-text-primary)]"
                        >
                            {{ copy.publicHandleHeading }}
                        </h2>
                        <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                            {{ copy.publicHandleHint }}
                        </p>
                    </div>

                    <div class="relative group">
                        <label
                            for="public-handle"
                            class="mb-2 block text-xs font-medium text-[var(--fsusblog-text-secondary)]"
                        >
                            {{ copy.publicHandleLabel }}
                        </label>
                        <ElInput
                            id="public-handle"
                            v-model="publicHandle"
                            name="publicHandle"
                            type="text"
                            :placeholder="copy.publicHandlePlaceholder"
                            :disabled="isProcessing"
                            :aria-invalid="Boolean(publicHandleHint)"
                            aria-describedby="public-handle-hint"
                            autocomplete="off"
                            autofocus
                        />
                        <p
                            v-if="publicHandleHint"
                            id="public-handle-hint"
                            aria-live="polite"
                            class="mt-2 text-xs font-medium text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
                        >
                            {{ publicHandleHint }}
                        </p>
                    </div>

                    <div class="pt-1">
                        <ElCheckbox
                            id="agreement"
                            v-model="isAgreed"
                            name="agreement"
                            :disabled="isProcessing"
                            aria-required="true"
                            class="register-agreement-checkbox"
                        >
                            <span class="register-agreement-copy">
                                {{ copy.agreementPrefix }}
                                <ElButton
                                    text
                                    inline-action
                                    class="register-guidelines-button"
                                    type="primary"
                                    size="large"
                                    @click.stop.prevent="handleGuidelinesActivator"
                                >
                                    {{ copy.guidelinesLink }}
                                </ElButton>
                            </span>
                        </ElCheckbox>
                    </div>

                    <div class="grid pt-4">
                        <ElButton
                            type="primary"
                            :disabled="!canCreateAnonymousAccount"
                            :loading="loading"
                            :aria-disabled="!canCreateAnonymousAccount"
                            aria-describedby="register-error"
                            class="register-submit-button"
                            @click="createAnonymousAccount"
                        >
                            {{ loading ? copy.submitButtonLoading : copy.submitButtonIdle }}
                        </ElButton>
                    </div>
                </section>

                <section
                    v-if="step === 'passkey'"
                    class="space-y-5"
                    aria-labelledby="passkey-enrollment-title"
                >
                    <div>
                        <h2
                            id="passkey-enrollment-title"
                            class="text-sm font-medium text-[var(--fsusblog-text-primary)]"
                        >
                            {{ copy.passkeyEnrollmentTitle }}
                        </h2>
                        <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                            {{ copy.passkeyEnrollmentHint }}
                        </p>
                    </div>
                    <ElButton
                        type="primary"
                        :disabled="!canRegisterPasskey"
                        @click="openPasskeyRegistration"
                    >
                        {{ copy.registerPasskeyCta }}
                    </ElButton>
                </section>

                <section
                    v-if="step === 'recovery'"
                    class="space-y-5"
                    aria-labelledby="recovery-key-title"
                >
                    <div>
                        <h2
                            id="recovery-key-title"
                            class="text-sm font-medium text-[var(--fsusblog-text-primary)]"
                        >
                            {{ copy.recoveryKeyTitle }}
                        </h2>
                        <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                            {{ copy.recoveryKeyHint }}
                        </p>
                    </div>

                    <div
                        class="rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg-soft)] p-4"
                        aria-live="polite"
                    >
                        <p class="mb-2 text-[11px] font-medium text-[var(--fsusblog-text-muted)]">
                            {{ copy.recoveryKeyVersionPrefix }}{{ recoveryKeyVersion }}
                        </p>
                        <code class="block break-all font-mono text-sm leading-7 text-[var(--fsusblog-text-primary)]">
                            {{ recoveryKeyPlaintext }}
                        </code>
                        <p
                            v-if="recoveryKeyCreatedAt"
                            class="mt-2 text-[11px] text-[var(--fsusblog-text-muted)]"
                        >
                            {{ copy.recoveryKeyCreatedAtPrefix }}{{ recoveryKeyCreatedAt }}
                        </p>
                    </div>

                    <div class="grid gap-3">
                        <ElButton
                            :disabled="!recoveryKeyPlaintext"
                            @click="copyRecoveryKey"
                        >
                            {{ copy.copyRecoveryKeyCta }}
                        </ElButton>
                        <ElCheckbox
                            id="recovery-key-saved"
                            v-model="recoveryKeySaved"
                            :disabled="!recoveryKeyPlaintext"
                            aria-required="true"
                        >
                            {{ copy.recoveryKeySavedCheckbox }}
                        </ElCheckbox>
                        <ElButton
                            type="primary"
                            :disabled="!recoveryKeySaved"
                            @click="finishOnboarding"
                        >
                            {{ copy.enterAccountCta }}
                        </ElButton>
                    </div>
                </section>

                <section
                    v-if="step === 'complete'"
                    class="space-y-5"
                    aria-labelledby="anonymous-complete-title"
                >
                    <div class="rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg-soft)] px-5 py-4">
                        <h2
                            id="anonymous-complete-title"
                            class="text-sm font-medium text-[var(--fsusblog-text-primary)]"
                        >
                            {{ copy.passkeyBoundTitle }}
                        </h2>
                        <p class="mt-2 text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                            {{ copy.passkeyBoundHint }}
                        </p>
                    </div>
                    <ElButton
                        type="primary"
                        @click="finishOnboarding"
                    >
                        {{ copy.enterAccountCta }}
                    </ElButton>
                </section>

                <div
                    v-if="localError"
                    id="register-error"
                    role="alert"
                    aria-live="polite"
                    class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-medium text-[var(--fsusblog-color-error)] animate-in fade-in"
                >
                    {{ localError }}
                </div>
            </div>

            <footer class="mt-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-[var(--fsusblog-panel-border)] pt-5">
                <div class="flex min-w-0 items-center gap-3">
                    <span class="text-xs font-medium text-[var(--fsusblog-text-muted)]">{{ copy.hasAccountLabel }}</span>
                    <RouterLink
                        to="/login"
                        class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-medium text-[var(--fsusblog-text-primary)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
                        :class="focusRingClass"
                    >
                        {{ copy.loginLink }}
                    </RouterLink>
                </div>
                <RouterLink
                    to="/"
                    class="ml-auto rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-medium text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
                    :class="focusRingClass"
                >
                    {{ copy.cancelLink }}
                </RouterLink>
            </footer>
        </section>

        <PolicyModal
            v-model:visible="showGuidelines"
            type="guidelines"
        />
        <PasskeyRegisterModal
            v-model:visible="passkeyModalVisible"
            enrollment-mode
            @success="onPasskeyRegistered"
        />
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import PolicyModal from '@/components/PolicyModal.vue';
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue';
import { useAnonymousOnboarding } from '@/composables/useAnonymousOnboarding';
import { useI18nText } from '@/composables/useI18nText';
import { themeTokens } from '@/ui-tokens/themeTokens';

const focusRingClass = themeTokens.focusRing;
const { messages } = useI18nText();
const copy = computed(() => messages.value.auth.register);

const {
    localError,
    publicHandle,
    publicHandleHint,
    isAgreed,
    showGuidelines,
    loading,
    step,
    recoveryKeyPlaintext,
    recoveryKeyVersion,
    recoveryKeyCreatedAt,
    recoveryKeySaved,
    passkeyModalVisible,
    isProcessing,
    canCreateAnonymousAccount,
    canRegisterPasskey,
    handleGuidelinesActivator,
    createAnonymousAccount,
    copyRecoveryKey,
    openPasskeyRegistration,
    onPasskeyRegistered,
    finishOnboarding
} = useAnonymousOnboarding();
</script>

<style scoped>
@reference "@/assets/main.css";

.register-guidelines-button
 {
    min-height: 40px;
    align-items: center;
}

.register-agreement-checkbox
 {
    align-items: flex-start;
}

.register-agreement-copy
 {
    display: block;
    white-space: normal;
    line-height: 1.5;
}

.register-submit-button
 {
    height: auto;
    min-height: 40px;
    padding-block: 8px;
    white-space: normal;
    line-height: 1.4;
}
</style>
