<template>
    <div class="auth-page-content w-full max-w-md">
        <section
            class="w-full max-w-md"
            aria-labelledby="login-title"
        >
            <header class="mb-6">
                <h1
                    id="login-title"
                    class="text-2xl font-bold leading-tight tracking-normal text-[var(--fsusblog-text-primary)] sm:text-3xl"
                >
                    {{ copy.title }}
                </h1>
                <p class="mt-4 max-w-sm text-sm font-normal leading-7 text-[var(--fsusblog-text-secondary)]">
                    {{ copy.description }}
                </p>
            </header>

            <form
                v-if="!requiresMfa"
                class="space-y-6"
                novalidate
                @submit.prevent
            >
                <div class="grid gap-3">
                    <ElCheckbox
                        id="anonymous-remember-me"
                        v-model="rememberMe"
                        name="rememberMe"
                        :disabled="passkeyLoading"
                        class="login-remember-checkbox"
                    >
                        <span class="login-remember-label">{{ copy.rememberMe }}</span>
                    </ElCheckbox>
                    <ElButton
                        type="primary"
                        :disabled="passkeyLoading"
                        :loading="passkeyLoading"
                        class="login-passkey-button"
                        @click="handlePasskeyLogin"
                    >
                        <template #icon>
                            <ElIcon aria-hidden="true">
                                <Key />
                            </ElIcon>
                        </template>
                        {{ passkeyLoading ? copy.passkeyLoading : copy.passkeyButton }}
                    </ElButton>
                    <p class="text-xs leading-6 text-[var(--fsusblog-text-muted)]">
                        {{ copy.passkeyHint }}
                    </p>
                </div>

                <div
                    v-if="passkeyError"
                    role="alert"
                    aria-live="polite"
                    class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-medium text-[var(--fsusblog-color-error)] animate-in fade-in slide-in-from-top-1"
                >
                    {{ passkeyError }}
                    <p class="mt-2 text-xs leading-6">
                        {{ copy.passkeyFailureHint }}
                    </p>
                </div>

                <RouterLink
                    to="/recover"
                    class="inline-flex min-h-9 items-center rounded-[var(--fsus-radius-control)] px-1 text-sm font-medium text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
                    :class="focusRingClass"
                >
                    {{ copy.recoverLink }}
                </RouterLink>
            </form>

            <form
                v-else
                class="space-y-6"
                novalidate
                aria-labelledby="mfa-title"
                @submit.prevent="handleMfaVerify"
            >
                <div class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-5 py-4">
                    <p
                        id="mfa-title"
                        class="text-sm font-medium text-[var(--fsusblog-text-primary)]"
                    >{{ copy.mfaRequiredTitle }}</p>
                    <p class="mt-1 text-sm leading-7 text-[var(--fsusblog-text-secondary)]">
                        {{ copy.mfaRequiredHint }}
                    </p>
                </div>

                <ElRadioGroup
                    v-model="mfaMode"
                    class="w-full"
                    :aria-label="copy.mfaAriaLabel"
                >
                    <ElRadioButton value="totp">{{ copy.mfaModeTOTP }}</ElRadioButton>
                    <ElRadioButton value="recovery">{{ copy.mfaModeRecovery }}</ElRadioButton>
                </ElRadioGroup>

                <div
                    v-if="mfaMode === 'totp'"
                    class="relative group"
                >
                    <label
                        for="mfa-code"
                        class="mb-2 block text-xs font-medium text-[var(--fsusblog-text-secondary)]"
                    >
                        {{ copy.mfaCodeLabel }}
                    </label>
                    <ElInput
                        id="mfa-code"
                        v-model="mfaCode"
                        name="mfaCode"
                        type="text"
                        inputmode="numeric"
                        :placeholder="copy.mfaCodePlaceholder"
                        autocomplete="one-time-code"
                        :aria-invalid="Boolean(errorMessage)"
                        aria-describedby="mfa-error"
                        :disabled="isProcessing"
                    />
                </div>

                <div
                    v-else
                    class="relative group"
                >
                    <label
                        for="mfa-recovery"
                        class="mb-2 block text-xs font-medium text-[var(--fsusblog-text-secondary)]"
                    >
                        {{ copy.mfaRecoveryLabel }}
                    </label>
                    <ElInput
                        id="mfa-recovery"
                        v-model="mfaRecoveryCode"
                        name="mfaRecoveryCode"
                        type="text"
                        :placeholder="copy.mfaRecoveryPlaceholder"
                        autocomplete="one-time-code"
                        :aria-invalid="Boolean(errorMessage)"
                        aria-describedby="mfa-error"
                        :disabled="isProcessing"
                    />
                </div>

                <div
                    v-if="errorMessage"
                    id="mfa-error"
                    role="alert"
                    aria-live="polite"
                    class="rounded-[var(--fsus-radius-control)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)] px-4 py-3 text-sm font-medium text-[var(--fsusblog-color-error)]"
                >
                    {{ errorMessage }}
                </div>

                <div class="grid pt-4">
                    <ElButton
                        type="primary"
                        native-type="submit"
                        :disabled="isProcessing"
                    >
                        {{ copy.mfaSubmit }}
                    </ElButton>
                </div>
            </form>

            <footer class="mt-10 flex items-center justify-between border-t border-[var(--fsusblog-panel-border)] pt-6">
                <RouterLink
                    to="/register"
                    class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-medium text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
                    :class="focusRingClass"
                >
                    {{ copy.registerLink }}
                </RouterLink>
                <RouterLink
                    to="/"
                    class="rounded-[var(--fsus-radius-control)] px-1 py-2 text-sm font-medium text-[var(--fsusblog-text-muted)] transition-colors hover:text-[var(--fsusblog-color-primary)] focus-visible:outline-none"
                    :class="focusRingClass"
                >
                    {{ copy.cancelLink }}
                </RouterLink>
            </footer>
        </section>

    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useAuthLogin } from '@/composables/useAuthLogin';
import { useI18nText } from '@/composables/useI18nText';
import { usePasskeyLogin } from '@/composables/usePasskeyLogin';
import { Key } from '@/fsusui/icons';
import { themeTokens } from '@/ui-tokens/themeTokens';

const focusRingClass = themeTokens.focusRing;
const { messages } = useI18nText();
const copy = computed(() => messages.value.auth.login);

const {
    errorMessage,
    rememberMe,
    isProcessing,
    handleMfaVerify,
    requiresMfa,
    mfaMode,
    mfaCode,
    mfaRecoveryCode
} = useAuthLogin();

const {
    loading: passkeyLoading,
    error: passkeyError,
    loginWithPasskey
} = usePasskeyLogin();

const handlePasskeyLogin = () => loginWithPasskey(rememberMe.value);
</script>

<style scoped>
.login-remember-checkbox
 {
    align-items: flex-start;
    height: auto;
    min-width: 0;
}

.login-remember-label
 {
    display: block;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.5;
}

.login-passkey-button
 {
    height: auto;
    min-height: 40px;
    padding-block: 8px;
    white-space: normal;
    line-height: 1.4;
}
</style>
