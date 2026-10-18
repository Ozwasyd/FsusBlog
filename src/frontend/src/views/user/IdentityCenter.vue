<template>
    <div class="account-page identity-center">
        <FsusUiTaskPageHeader
            :title="sectionMeta.title"
            :description="sectionMeta.description"
            density="compact"
        />

        <template v-if="isSection('UserIdentityOverview')">
            <div class="identity-status-grid">
                <div class="identity-status-card">
                    <span class="identity-status-label">{{ copy.passkeyLabel }}</span>
                    <strong>{{ identityAccountSnapshot.passkeyEnabled ? copy.passkeyEnabled : copy.passkeyDisabled }}</strong>
                    <p>{{ passkeyDeviceCountText }}</p>
                </div>
                <div class="identity-status-card">
                    <span class="identity-status-label">{{ copy.recoveryKeyLabel }}</span>
                    <strong>{{ identityAccountSnapshot.recoveryEnabled ? copy.recoveryKeyReady : copy.recoveryKeyRequired }}</strong>
                    <p>{{ copy.recoveryKeyHint }}</p>
                </div>
                <div class="identity-status-card">
                    <span class="identity-status-label">{{ copy.mfaLabel }}</span>
                    <strong>{{ identityAccountSnapshot.totpStepUpEnabled ? copy.mfaEnabled : copy.mfaDisabled }}</strong>
                    <p>{{ copy.mfaHint }}</p>
                </div>
                <div class="identity-status-card">
                    <span class="identity-status-label">{{ copy.anonymousLabel }}</span>
                    <strong>{{ identityAccountSnapshot.anonymousCardStatus }}</strong>
                    <p>{{ identityAccountSnapshot.zkAnonymousAvailable ? copy.zkAvailable : copy.zkUnavailable }}</p>
                </div>
            </div>

            <FsusUiSettingsSection
                class="mt-8"
                :title="copy.sectionTitle"
                :title-tag="'h2'"
            >
                <dl class="identity-summary-list">
                    <div>
                        <dt>{{ copy.publicHandleLabel }}</dt>
                        <dd>{{ publicHandleDisplayText }}</dd>
                    </div>
                    <div>
                        <dt>{{ copy.anonymousPolicyLabel }}</dt>
                        <dd>{{ anonymousPolicyDisplayText }}</dd>
                    </div>
                    <div>
                        <dt>{{ copy.publicSendOptionLabel }}</dt>
                        <dd>{{ publicSendOptionDisplayText }}</dd>
                    </div>
                </dl>
            </FsusUiSettingsSection>

            <FsusUiDangerZone
                id="identity-account-lifecycle"
                class="mt-6"
                :title="copy.lifecycleTitle"
                :description="copy.lifecycleDescription"
                title-tag="h2"
                density="compact"
            >
                <FsusUiRiskNotice
                    :title="copy.deleteAccountCta"
                    type="danger"
                    role="note"
                >
                    <p>{{ copy.lifecycleWarning }}</p>
                </FsusUiRiskNotice>
                <div
                    v-if="deleteAccountError"
                    class="identity-error-state mt-4"
                    role="alert"
                >{{ deleteAccountError }}</div>
                <FsusUiDestructiveActionPanel
                    class="mt-4"
                    density="compact"
                >
                    <template #actions>
                        <FsusUiInlineActions
                            :aria-label="copy.deleteAccountCta"
                            density="compact"
                        >
                            <ElButton
                                type="danger"
                                :loading="deleteAccountLoading"
                                @click="deleteCurrentAccount"
                            >{{ copy.deleteAccountCta }}</ElButton>
                        </FsusUiInlineActions>
                    </template>
                </FsusUiDestructiveActionPanel>
            </FsusUiDangerZone>
        </template>

        <FsusUiSettingsSection
            v-else-if="isSection('UserIdentityPasskeys')"
            :title="passkeysCopy.sectionTitle"
            :description="passkeysCopy.sectionDescription"
            :title-tag="'h2'"
        >
            <div
                v-if="passkeyLoading"
                class="identity-loading-state"
            >{{ passkeysCopy.loading }}</div>
            <div
                v-else-if="passkeyError"
                class="identity-error-state"
                role="alert"
            >{{ passkeyError }}</div>
            <div
                v-if="!passkeyLoading && !passkeyError && showPasskeyRecoverySuggestion"
                class="identity-copy-block mt-4"
                role="status"
            >
                <p>{{ passkeysCopy.recoverySuggestion }}</p>
            </div>

            <FsusUiResourceList
                v-if="!passkeyLoading && !passkeyError && passkeyCredentials.length"
                density="compact"
            >
                <FsusUiResourceListItem
                    v-for="credential in passkeyCredentials"
                    :key="credential.id"
                    density="compact"
                >
                    <template #title>
                        <div
                            v-if="passkeyEditingId === credential.id"
                            class="flex items-center gap-3"
                        >
                            <div class="min-w-0 flex-1">
                                <ElInput
                                    v-model="passkeyEditName"
                                    maxlength="64"
                                    clearable
                                    :aria-label="passkeysCopy.nameInputAriaLabel"
                                    @keyup.enter="savePasskeyName(credential.id)"
                                    @keyup.esc="passkeyEditingId = null"
                                />
                            </div>
                            <ElButton
                                link
                                type="primary"
                                @click="savePasskeyName(credential.id)"
                            >{{ passkeysCopy.saveCta }}</ElButton>
                            <ElButton
                                link
                                @click="passkeyEditingId = null"
                            >{{ passkeysCopy.cancelCta }}</ElButton>
                        </div>
                        <div
                            v-else
                            class="flex items-center gap-3"
                        >
                            <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                                {{ credential.deviceFriendlyName || passkeysCopy.nameEmpty }}
                            </p>
                            <ElButton
                                link
                                @click="startEditPasskeyName(credential)"
                            >{{ passkeysCopy.editCta }}</ElButton>
                        </div>
                    </template>
                    <template #meta>
                        <FsusUiMetadataRow density="compact">
                            <FsusUiMetadataItem :label="passkeysCopy.createdAtLabel">
                                <SemanticTime
                                    :value="credential.createdAt"
                                    format="date"
                                />
                            </FsusUiMetadataItem>
                            <FsusUiMetadataItem :label="passkeysCopy.activeAtLabel">
                                <SemanticTime
                                    v-if="credential.lastUsedAt"
                                    :value="credential.lastUsedAt"
                                    format="date"
                                />
                                <template v-else>{{ passkeysCopy.activeNeverRecorded }}</template>
                            </FsusUiMetadataItem>
                            <FsusUiMetadataItem
                                :label="passkeysCopy.backupModeLabel"
                                :value="credential.backupEligible ? passkeysCopy.backupEligible : passkeysCopy.backupIneligible"
                            />
                        </FsusUiMetadataRow>
                    </template>
                    <template #actions>
                        <FsusUiInlineActions
                            :aria-label="credential.deviceFriendlyName || passkeysCopy.nameEmpty"
                            density="compact"
                        >
                            <ElButton
                                class="identity-touch-action"
                                link
                                type="danger"
                                @click="confirmDeletePasskey(credential.id)"
                            >{{ passkeysCopy.deleteCta }}</ElButton>
                        </FsusUiInlineActions>
                    </template>
                </FsusUiResourceListItem>
            </FsusUiResourceList>

            <FsusUiEmptyState
                v-else-if="!passkeyLoading && !passkeyError"
                size="inline"
                :illustration="false"
                role="status"
                aria-live="polite"
                :title="passkeysCopy.emptyTitle"
                :description="passkeysCopy.emptyContent"
            >
                <template #actions>
                    <ElButton
                        type="primary"
                        @click="passkeyRegisterVisible = true"
                    >{{ passkeysCopy.addCta }}</ElButton>
                </template>
            </FsusUiEmptyState>

            <div
                v-if="passkeyCredentials.length"
                class="mt-6"
            >
                <ElButton
                    type="primary"
                    @click="passkeyRegisterVisible = true"
                >{{ passkeysCopy.addCta }}</ElButton>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-else-if="isSection('UserIdentityRecoveryKey')"
            :title="recoveryKeyCopy.sectionTitle"
            :description="recoveryKeyCopy.sectionDescription"
            :title-tag="'h2'"
        >
            <div class="identity-copy-block">
                <p>{{ recoveryKeyCopy.sectionHint }}</p>
            </div>

            <div
                v-if="recoveryLoading"
                class="identity-loading-state"
            >{{ recoveryKeyCopy.loading }}</div>
            <div
                v-if="recoveryKeyError"
                class="identity-error-state"
                role="alert"
            >{{ recoveryKeyError }}</div>

            <div
                v-if="recoveryKeyPlaintext"
                class="identity-secret-panel"
                aria-live="polite"
            >
                <span class="identity-status-label">{{ recoveryKeyCopy.panelVersionPrefix }}{{ recoveryKeyVersion }}</span>
                <code>{{ recoveryKeyPlaintext }}</code>
                <p v-if="recoveryKeyCreatedAt">{{ recoveryKeyCopy.panelCreatedAtPrefix }}{{ recoveryKeyCreatedAt }}</p>
                <ElCheckbox v-model="recoveryKeySaved">{{ recoveryKeyCopy.savedCheckbox }}</ElCheckbox>
                <ElButton
                    :disabled="!recoveryKeySaved"
                    @click="clearRecoveryKeyPanel"
                >{{ recoveryKeyCopy.closeOnceCta }}</ElButton>
            </div>

            <div class="mt-6 flex flex-wrap gap-3">
                <ElButton
                    type="primary"
                    :loading="recoveryLoading"
                    @click="createRecoveryKeyForAccount"
                >{{ recoveryKeyCopy.createCta }}</ElButton>
                <ElButton
                    :loading="recoveryLoading"
                    @click="rotateRecoveryKeyForAccount"
                >{{ recoveryKeyCopy.rotateCta }}</ElButton>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-else-if="isSection('UserIdentityMfa')"
            :title="mfaCopy.sectionTitle"
            :description="mfaCopy.sectionDescription"
            :title-tag="'h2'"
        >
            <div
                v-if="mfaLoading"
                class="identity-loading-state"
            >{{ mfaCopy.loading }}</div>
            <div
                v-else-if="mfaError"
                class="identity-error-state"
                role="alert"
            >{{ mfaError }}</div>
            <div
                v-else
                class="identity-state-row"
            >
                <ElTag
                    class="identity-mfa-status-tag"
                    :type="mfaProfile?.enabled ? 'success' : 'warning'"
                    effect="plain"
                >
                    {{ mfaProfile?.enabled ? mfaCopy.enabled : mfaCopy.disabled }}
                </ElTag>
                <span v-if="mfaProfile?.verifiedAt">{{ mfaCopy.lastVerifiedPrefix }}：<SemanticTime
                    :value="mfaProfile.verifiedAt"
                    format="date"
                /></span>
                <span v-else>{{ mfaCopy.lastVerifiedEmpty }}</span>
            </div>
            <div class="mt-6 flex flex-wrap gap-3">
                <ElButton
                    v-if="!mfaProfile?.enabled"
                    type="primary"
                    :loading="mfaSetupLoading"
                    @click="startMfaSetupFlow"
                >
                    {{ mfaCopy.enableCta }}
                </ElButton>
                <ElButton
                    v-else
                    type="danger"
                    plain
                    :loading="mfaDisableLoading"
                    @click="disableTotpMfa"
                >
                    {{ mfaCopy.disableCta }}
                </ElButton>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-else-if="isSection('UserIdentityAnonymous')"
            :title="anonymousCopy.sectionTitle"
            :description="anonymousCopy.sectionDescription"
            :title-tag="'h2'"
        >
            <div class="identity-copy-block">
                <p>{{ anonymousCopy.readOnlyBody }}</p>
                <p>{{ anonymousCopy.publicChoiceBody }}</p>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-else-if="isSection('UserIdentityPublicProfile')"
            :title="publicProfileCopy.sectionTitle"
            :description="publicProfileCopy.sectionDescription"
            :title-tag="'h2'"
        >
            <div class="identity-profile-form">
                <div class="identity-profile-field">
                    <label
                        for="public-handle-draft"
                        class="identity-profile-field__label"
                    >
                        {{ publicProfileCopy.draftLabel }}
                    </label>
                    <ElInput
                        id="public-handle-draft"
                        v-model="publicHandleDraft"
                        maxlength="20"
                        autocomplete="off"
                        :placeholder="publicProfileCopy.draftPlaceholder"
                    />
                </div>
                <div
                    v-if="publicHandleError"
                    class="identity-error-state"
                    role="alert"
                >{{ publicHandleError }}</div>
                <ElCheckbox v-model="explicitPublicSendOptIn">
                    {{ publicProfileCopy.optInCheckbox }}
                </ElCheckbox>
                <div
                    class="identity-profile-summary identity-policy-grid"
                    role="list"
                    :aria-label="publicProfileCopy.summaryAriaLabel"
                >
                    <div
                        class="identity-policy-item"
                        role="listitem"
                    >
                        <span class="identity-policy-label">{{ publicProfileCopy.publicSendOptionLabel }}</span>
                        <span :class="['identity-policy-state', `identity-policy-state--${publicSendOptionState}`]">
                            <span
                                class="identity-policy-state__dot"
                                aria-hidden="true"
                            />
                            {{ publicSendOptionValue }}
                        </span>
                    </div>
                </div>
                <div class="identity-profile-actions">
                    <ElButton
                        type="primary"
                        :loading="publicHandleSaving"
                        @click="savePublicHandle"
                    >{{ publicProfileCopy.saveCta }}</ElButton>
                </div>
            </div>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-else-if="isSection('UserIdentitySessions')"
            :title="sessionsCopy.sectionTitle"
            :description="sessionsCopy.sectionDescription"
            :title-tag="'h2'"
        >
            <template #actions>
                <FsusUiInlineActions
                    :aria-label="sessionsCopy.sectionTitle"
                    density="compact"
                >
                    <ElButton
                        type="primary"
                        plain
                        :disabled="otherSessions.length === 0"
                        @click="revokeOtherSessionDevices"
                    >
                        {{ sessionsCopy.revokeOthersCta }}
                    </ElButton>
                </FsusUiInlineActions>
            </template>
            <div
                v-if="sessionLoading"
                class="identity-loading-state"
            >{{ sessionsCopy.loading }}</div>
            <div
                v-else-if="sessionError"
                class="identity-error-state"
                role="alert"
            >{{ sessionError }}</div>

            <template v-else>
                <p class="mb-6 text-[12px] text-[var(--fsusblog-text-tertiary)]">{{ sessionsActiveCountText }}</p>

                <FsusUiResourceList
                    v-if="sessions.length"
                    density="compact"
                >
                    <FsusUiResourceListItem
                        v-for="session in sessions"
                        :key="session.sessionId"
                        density="compact"
                    >
                        <template #title>
                            <p class="m-0 block min-w-0 max-w-full truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                                {{ formatSessionDevice(session.deviceLabel) }}
                            </p>
                        </template>
                        <template #meta>
                            <FsusUiMetadataRow density="compact">
                                <FsusUiMetadataItem
                                    :label="sessionsCopy.sessionTypeLabel"
                                    :value="session.isCurrent ? sessionsCopy.currentDevice : sessionsCopy.otherDevice"
                                />
                                <FsusUiMetadataItem
                                    v-if="session.lastSeenAt"
                                    :label="sessionsCopy.activeAtLabel"
                                >
                                    <SemanticTime
                                        :value="session.lastSeenAt"
                                        format="date"
                                    />
                                </FsusUiMetadataItem>
                                <FsusUiMetadataItem :label="sessionsCopy.createdAtLabel">
                                    <SemanticTime
                                        :value="session.createdAt"
                                        format="date"
                                    />
                                </FsusUiMetadataItem>
                                <FsusUiMetadataItem
                                    :label="sessionsCopy.loginMethodLabel"
                                    :value="formatAuthenticationMethod(session.authenticationMethod)"
                                />
                                <FsusUiMetadataItem
                                    v-if="session.passkeyFriendlyName"
                                    :label="sessionsCopy.credentialLabel"
                                    :value="session.passkeyFriendlyName"
                                />
                                <FsusUiMetadataItem
                                    :label="sessionsCopy.durationLabel"
                                    :value="formatDurationPolicy(session.durationPolicy)"
                                />
                            </FsusUiMetadataRow>
                        </template>
                        <template
                            v-if="!session.isCurrent"
                            #actions
                        >
                            <FsusUiInlineActions
                                :aria-label="sessionsCopy.revokeCta"
                                density="compact"
                            >
                                <ElButton
                                    class="identity-touch-action"
                                    link
                                    type="danger"
                                    @click="revokeSessionDevice(session.sessionId)"
                                >
                                    {{ sessionsCopy.revokeCta }}
                                </ElButton>
                            </FsusUiInlineActions>
                        </template>
                    </FsusUiResourceListItem>
                </FsusUiResourceList>

                <FsusUiEmptyState
                    v-else
                    size="inline"
                    :illustration="false"
                    role="status"
                    aria-live="polite"
                    :title="sessionsCopy.emptyTitle"
                    :description="sessionsCopy.emptyContent"
                />
            </template>
        </FsusUiSettingsSection>

        <FsusUiSettingsSection
            v-else-if="isSection('UserIdentityCommentRecords')"
            :title="commentRecordsCopy.sectionTitle"
            :description="commentRecordsCopy.sectionDescription"
            :title-tag="'h2'"
        >
            <div
                class="identity-policy-grid"
                role="list"
                :aria-label="commentRecordsCopy.policyAriaLabel"
            >
                <div
                    v-for="item in commentRecordPolicyItems"
                    :key="item.label"
                    class="identity-policy-item"
                    role="listitem"
                >
                    <span class="identity-policy-label">{{ item.label }}</span>
                    <span :class="['identity-policy-state', `identity-policy-state--${item.state}`]">
                        <span
                            class="identity-policy-state__dot"
                            aria-hidden="true"
                        />
                        {{ item.value }}
                    </span>
                </div>
            </div>
            <UserCommentsErrorState
                v-if="commentRecordsIsError"
                class="identity-comment-records-state"
                @retry="fetchCommentRecords"
            />

            <div
                v-else-if="commentRecordsLoading && commentRecordList.length === 0"
                class="identity-loading-state identity-comment-records-state"
                role="status"
                aria-live="polite"
            >
                {{ commentRecordsCopy.loading }}
            </div>

            <UserCommentsEmptyState
                v-else-if="commentRecordList.length === 0"
                class="identity-comment-records-state"
                :title="commentRecordsCopy.emptyTitle"
                :description="commentRecordsCopy.emptyDescription"
            />

            <UserCommentsList
                v-else
                class="identity-comment-records-list"
                :list="commentRecordFilteredList"
                :loading="commentRecordsLoading"
                :show-load-more-button="commentRecordsShowLoadMoreButton"
                :show-end-hint="commentRecordsShowEndHint"
                :load-more-button-text="commentRecordsLoadMoreButtonText"
                :end-hint-text="commentRecordsEndHintText"
                @delete="deleteCommentRecord"
                @load-more="fetchCommentRecords"
            />
        </FsusUiSettingsSection>

        <PasskeyRegisterModal
            v-model:visible="passkeyRegisterVisible"
            @success="onPasskeyRegistered"
        />

        <MfaSetupModal
            v-model:visible="mfaSetupVisible"
            :title="mfaCopy.setupModalTitle"
            :loading="mfaSetupLoading"
            :secret="mfaSetupSecret"
            :otp-auth-url="mfaSetupOtpAuthUrl"
            :setup-code="mfaSetupCode"
            :recovery-codes="mfaSetupRecoveryCodes"
            :error-message="mfaSetupError"
            @update:setup-code="(value) => (mfaSetupCode = value)"
            @verify="completeMfaSetupFlow"
        />
    </div>
</template>

<script setup lang="ts">
import { startAuthentication } from '@simplewebauthn/browser';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import {
    createRecoveryKey,
    deleteAccount,
    disableMfa,
    getMfaProfile,
    getPasskeySignalState,
    listSessions,
    revokeOtherSessions as revokeOtherSessionsApi,
    revokeSession,
    rotateRecoveryKey,
    startMfaChallenge,
    startMfaSetup,
    updatePublicHandle,
    userStepUpPasskeyBegin,
    userStepUpPasskeyComplete,
    verifyMfaSetup,
    type MfaProfile,
    type PasskeyCredentialSummary,
    type UserSessionSummary
} from '@/api/auth';
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue';
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue';
import SemanticTime from '@/components/ui/SemanticTime.vue';
import UserCommentsEmptyState from '@/components/user/UserCommentsEmptyState.vue';
import UserCommentsErrorState from '@/components/user/UserCommentsErrorState.vue';
import UserCommentsList from '@/components/user/UserCommentsList.vue';
import { shouldSuggestPasskeyRecovery } from '@/composables/passkeyRecoveryCapability';
import { useI18nText } from '@/composables/useI18nText';
import { usePasskeyManagement } from '@/composables/usePasskeyManagement';
import { useUserCommentsPage } from '@/composables/useUserCommentsPage';
import {
    FsusUiDangerZone,
    FsusUiDestructiveActionPanel,
    FsusUiEmptyState,
    FsusUiInlineActions,
    FsusUiMetadataItem,
    FsusUiMetadataRow,
    FsusUiResourceList,
    FsusUiResourceListItem,
    FsusUiRiskNotice,
    FsusUiSettingsSection,
    FsusUiTaskPageHeader
} from '@/fsusui';
import { confirmDanger, toast } from '@/fsusui/feedback';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { webauthnSignalService } from '@/services/webauthnSignal';
import { useUserStore } from '@/store/user';
import { toAppError } from '@/utils/appError';

const { messages, translatePlural } = useI18nText();
const identityCopy = computed(() => messages.value.identity);
const copy = computed(() => identityCopy.value.overview);
const passkeysCopy = computed(() => identityCopy.value.passkeys);
const recoveryKeyCopy = computed(() => identityCopy.value.recoveryKey);
const mfaCopy = computed(() => identityCopy.value.mfa);
const anonymousCopy = computed(() => identityCopy.value.anonymous);
const publicProfileCopy = computed(() => identityCopy.value.publicProfile);
const sessionsCopy = computed(() => identityCopy.value.sessions);
const commentRecordsCopy = computed(() => identityCopy.value.commentRecords);
const confirmCopy = computed(() => identityCopy.value.confirm);
const errorCopy = computed(() => identityCopy.value.errors);

const sectionMetaByRoute = computed(() => identityCopy.value.meta);

type IdentityRouteName = keyof typeof sectionMetaByRoute.value;
type IdentityPolicyState = 'open' | 'active' | 'closed' | 'muted';

const stepUpErrorCodes = new Set([
    'PASSWORD_OR_STEP_UP_PROOF_REQUIRED',
    'PASSKEY_STEP_UP_DISABLED',
    'ANONYMOUS_STEP_UP_PROOF_REQUIRED',
    'ANONYMOUS_MFA_STEP_UP_REQUIRED',
    'MFA_PROOF_REQUIRED',
    'MFA_REQUIRED',
    'STEP_UP_PROOF_INVALID',
    'STEP_UP_PRINCIPAL_REQUIRED'
]);

const stripTraceSuffix = (message: string): string =>
    message.replace(/\s*\[trace:[^\]]+\]\s*$/u, '').trim();

const identityOperationErrorMessage = (
    error: unknown,
    fallback: string,
    stepUpFallback = fallback
): string =>
{
    const message = toAppError(error, fallback).message || fallback;
    return stepUpErrorCodes.has(stripTraceSuffix(message)) ? stepUpFallback : message;
};

const isPasskeyStepUpDisabledError = (error: unknown): boolean =>
    stripTraceSuffix(toAppError(error, '').message) === 'PASSKEY_STEP_UP_DISABLED';

const normalizeLocalPasskeyOptions = (options: Record<string, unknown>): Record<string, unknown> =>
{
    const hostname = globalThis.location?.hostname;
    if (hostname === '127.0.0.1' && options.rpId === 'localhost')
    {
        return { ...options, rpId: '127.0.0.1' };
    }
    if (hostname === 'localhost' && options.rpId === '127.0.0.1')
    {
        return { ...options, rpId: 'localhost' };
    }
    return options;
};

const isWebAuthnAbort = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string; }).name === 'NotAllowedError';

interface PasskeyStepUpChallenge {
    challengeToken?: string | null;
    ChallengeToken?: string | null;
    options?: Record<string, unknown> | null;
    Options?: Record<string, unknown> | null;
}

const resolvePasskeyStepUpProof = async (action: string): Promise<string> =>
{
    const challenge: PasskeyStepUpChallenge = await userStepUpPasskeyBegin(action);
    const primaryChallengeToken = challenge.challengeToken;
    let challengeToken: PasskeyStepUpChallenge['challengeToken'];
    if (primaryChallengeToken)
    {
        challengeToken = primaryChallengeToken;
    }
    else
    {
        challengeToken = challenge.ChallengeToken;
    }
    const primaryOptions = challenge.options;
    let options: PasskeyStepUpChallenge['options'];
    if (primaryOptions)
    {
        options = primaryOptions;
    }
    else
    {
        options = challenge.Options;
    }
    if (!challengeToken || !options || typeof options !== 'object')
    {
        throw new Error('MFA_PROOF_REQUIRED');
    }

    let assertion: Awaited<ReturnType<typeof startAuthentication>>;
    try
    {
        assertion = await startAuthentication({
            optionsJSON: normalizeLocalPasskeyOptions(options) as Parameters<typeof startAuthentication>[0]['optionsJSON']
        });
    }
    catch (error)
    {
        if (isWebAuthnAbort(error))
        {
            throw new Error('MFA_PROOF_REQUIRED', { cause: error });
        }
        throw error;
    }

    const proof = await userStepUpPasskeyComplete({
        challengeToken,
        assertion
    });
    if (!proof.verified || proof.action !== action || !proof.proofToken)
    {
        throw new Error('MFA_PROOF_REQUIRED');
    }

    return proof.proofToken;
};

const resolveTotpStepUpProof = async (action: string): Promise<string> =>
{
    const proof = await startMfaChallenge(action);
    if (!proof.verified || !proof.proofToken)
    {
        throw new Error('MFA_PROOF_REQUIRED');
    }

    return proof.proofToken;
};

const resolveSensitiveOperationProof = async (action: string): Promise<string> =>
{
    if (passkeyCredentials.value.length > 0)
    {
        try
        {
            return await resolvePasskeyStepUpProof(action);
        }
        catch (error)
        {
            if (isPasskeyStepUpDisabledError(error) && mfaProfile.value?.enabled)
            {
                return resolveTotpStepUpProof(action);
            }

            throw error;
        }
    }

    return resolveTotpStepUpProof(action);
};

const route = useRoute();
const userStore = useUserStore();
const workspaceContext = useAccountWorkspaceContext();

const {
    credentials: passkeyCredentials,
    loading: passkeyLoading,
    error: passkeyError,
    fetchPasskeys,
    removePasskey,
    renamePasskeyCredential
} = usePasskeyManagement();

const {
    list: commentRecordList,
    filteredList: commentRecordFilteredList,
    loading: commentRecordsLoading,
    showLoadMoreButton: commentRecordsShowLoadMoreButton,
    showEndHint: commentRecordsShowEndHint,
    loadMoreButtonText: commentRecordsLoadMoreButtonText,
    endHintText: commentRecordsEndHintText,
    isError: commentRecordsIsError,
    fetchComments: fetchCommentRecords,
    onDelete: deleteCommentRecord
} = useUserCommentsPage({ autoload: false });

const commentRecordsLoaded = ref(false);

const passkeyRegisterVisible = ref(false);
const passkeyEditingId = ref<number | null>(null);
const passkeyEditName = ref('');

const recoveryLoading = ref(false);
const recoveryKeyError = ref('');
const recoveryKeyPlaintext = ref('');
const recoveryKeyVersion = ref<number | null>(null);
const recoveryKeyCreatedAt = ref<string | null>(null);
const recoveryKeySaved = ref(false);
const recoveryKeyKnown = ref(false);

const mfaLoading = ref(false);
const mfaError = ref('');
const mfaProfile = ref<MfaProfile | null>(null);
const mfaSetupVisible = ref(false);
const mfaSetupLoading = ref(false);
const mfaDisableLoading = ref(false);
const mfaSetupSecret = ref('');
const mfaSetupOtpAuthUrl = ref('');
const mfaSetupCode = ref('');
const mfaSetupRecoveryCodes = ref<string[]>([]);
const mfaSetupError = ref('');

const sessionLoading = ref(false);
const sessionError = ref('');
const sessions = ref<UserSessionSummary[]>([]);

const publicHandleDraft = ref('');
const publicHandleSaving = ref(false);
const publicHandleError = ref('');
const explicitPublicSendOptIn = ref(false);
const deleteAccountLoading = ref(false);
const deleteAccountError = ref('');

const currentRouteName = computed<IdentityRouteName>(() =>
{
    const name = typeof route.name === 'string' ? route.name : '';
    return name in sectionMetaByRoute.value ? name as IdentityRouteName : 'UserIdentityOverview';
});

const sectionMeta = computed(() => sectionMetaByRoute.value[currentRouteName.value]);
const isSection = (name: IdentityRouteName): boolean => currentRouteName.value === name;

const ensureCommentRecordsLoaded = (): void =>
{
    if (!isSection('UserIdentityCommentRecords') || commentRecordsLoaded.value || commentRecordsLoading.value)
    {
        return;
    }

    commentRecordsLoaded.value = true;
    void fetchCommentRecords();
};

const workspaceFeatures = computed(() => workspaceContext.value.features);
const workspacePolicies = computed(() => workspaceContext.value.policies);
const currentSession = computed(() => sessions.value.find((session) => session.isCurrent) ?? null);
const otherSessions = computed(() => sessions.value.filter((session) => !session.isCurrent));

const passkeyDeviceCountText = computed(() =>
    translatePlural('identity.overview.passkeyDeviceCount', passkeyCredentials.value.length)
);

const publicHandleDisplayText = computed(() =>
    identityAccountSnapshot.value.publicHandle || copy.value.publicHandleEmpty
);

const anonymousPolicyDisplayText = computed(() =>
    identityAccountSnapshot.value.anonymousPolicyEnabled ? copy.value.anonymousPolicyAllowed : copy.value.anonymousPolicyClosed
);

const publicSendOptionDisplayText = computed(() =>
    identityAccountSnapshot.value.publicSendOptionEnabled ? copy.value.publicSendOptionAllowed : copy.value.publicSendOptionClosed
);

const publicSendOptionState = computed<IdentityPolicyState>(() =>
    workspaceFeatures.value.publicSendOptionEnabled ? 'open' : 'muted'
);

const publicSendOptionValue = computed(() =>
    workspaceFeatures.value.publicSendOptionEnabled
        ? publicProfileCopy.value.publicSendOptionAvailable
        : publicProfileCopy.value.publicSendOptionUnavailable
);

const commentRecordPolicyItems = computed<{ label: string; value: string; state: IdentityPolicyState; }[]>(() =>
{
    const features = workspaceFeatures.value;
    const policies = workspacePolicies.value;

    return [
        {
            label: commentRecordsCopy.value.policyPublicSendLabel,
            value: features.publicSendOptionEnabled ? commentRecordsCopy.value.policyOpen : commentRecordsCopy.value.policyClosed,
            state: features.publicSendOptionEnabled ? 'open' : 'muted'
        },
        {
            label: commentRecordsCopy.value.policyAnonymousLabel,
            value: features.anonymousCommentsEnabled ? commentRecordsCopy.value.policyOpen : commentRecordsCopy.value.policyClosed,
            state: features.anonymousCommentsEnabled ? 'open' : 'closed'
        },
        {
            label: commentRecordsCopy.value.policyZkLabel,
            value: features.zkAnonymousEnabled ? commentRecordsCopy.value.policyOpen : commentRecordsCopy.value.policyUnavailable,
            state: features.zkAnonymousEnabled ? 'open' : 'muted'
        },
        {
            label: commentRecordsCopy.value.policyGovernanceLabel,
            value: policies.anonymousCommentGovernanceAvailable ? commentRecordsCopy.value.policyActive : commentRecordsCopy.value.policyUnavailable,
            state: policies.anonymousCommentGovernanceAvailable ? 'active' : 'closed'
        }
    ];
});

const sessionsActiveCountText = computed(() =>
    translatePlural('identity.sessions.activeCount', sessions.value.length)
);

const identityAccountSnapshot = computed(() =>
{
    const features = workspaceFeatures.value;
    const policies = workspacePolicies.value;
    const user = userStore.userInfo;
    const storedPublicHandle = user?.publicHandle;
    let publicHandle = '';
    if (storedPublicHandle)
    {
        publicHandle = storedPublicHandle;
    }

    return {
        accountId: user?.accountId ?? 0,
        publicHandle,
        passkeyEnabled: passkeyCredentials.value.length > 0,
        recoveryEnabled: user?.recoveryEnabled === true || recoveryKeyKnown.value || recoveryKeyPlaintext.value.length > 0,
        totpStepUpEnabled: mfaProfile.value?.enabled === true,
        anonymousPolicyEnabled: features.anonymousCommentsEnabled && policies.anonymousCommentGovernanceAvailable,
        anonymousCardStatus: features.anonymousCommentsEnabled ? copy.value.anonymousCardAvailable : copy.value.anonymousCardClosed,
        zkAnonymousAvailable: features.zkAnonymousEnabled,
        publicSendOptionEnabled: features.publicSendOptionEnabled
    };
});

const showPasskeyRecoverySuggestion = computed(() => shouldSuggestPasskeyRecovery(
    passkeyCredentials.value,
    identityAccountSnapshot.value.recoveryEnabled
));

const refreshPasskeys = async (): Promise<void> =>
{
    await fetchPasskeys();
};

const refreshMfaProfile = async (): Promise<void> =>
{
    mfaLoading.value = true;
    mfaError.value = '';
    try
    {
        mfaProfile.value = await getMfaProfile();
    }
    catch (error)
    {
        mfaError.value = toAppError(error, mfaCopy.value.loadFailedFallback).message || mfaCopy.value.loadFailedFallback;
    }
    finally
    {
        mfaLoading.value = false;
    }
};

const startMfaSetupFlow = async (): Promise<void> =>
{
    mfaSetupVisible.value = true;
    mfaSetupLoading.value = true;
    mfaSetupSecret.value = '';
    mfaSetupOtpAuthUrl.value = '';
    mfaSetupCode.value = '';
    mfaSetupRecoveryCodes.value = [];
    mfaSetupError.value = '';
    try
    {
        const action = mfaProfile.value?.enabled ? 'mfa_setup_rebind' : 'mfa_setup';
        const proof = await startMfaChallenge(action);
        if (!proof.verified || !proof.proofToken)
        {
            mfaSetupError.value = mfaCopy.value.setupChallengeRequired;
            return;
        }

        const response = await startMfaSetup({ mfaProofToken: proof.proofToken });
        mfaSetupSecret.value = response.secret;
        mfaSetupOtpAuthUrl.value = response.otpAuthUrl;
    }
    catch (error)
    {
        mfaSetupError.value = identityOperationErrorMessage(error, mfaCopy.value.initFailedFallback, mfaCopy.value.setupChallengeRequired);
    }
    finally
    {
        mfaSetupLoading.value = false;
    }
};

const completeMfaSetupFlow = async (): Promise<void> =>
{
    if (!mfaSetupCode.value.trim())
    {
        return;
    }

    mfaSetupLoading.value = true;
    mfaSetupError.value = '';
    try
    {
        const response = await verifyMfaSetup(mfaSetupCode.value.trim());
        mfaSetupRecoveryCodes.value = response.recoveryCodes;
        await refreshMfaProfile();
        toast.success(mfaCopy.value.enabledSuccess);
    }
    catch (error)
    {
        mfaSetupError.value = toAppError(error, mfaCopy.value.verifyFailedFallback).message || mfaCopy.value.verifyFailedFallback;
    }
    finally
    {
        mfaSetupLoading.value = false;
    }
};

const disableTotpMfa = async (): Promise<void> =>
{
    const confirmation = await confirmDanger(
        mfaCopy.value.disableConfirmBody,
        mfaCopy.value.disableConfirmTitle,
        { confirmButtonText: mfaCopy.value.disableConfirmCta, cancelButtonText: confirmCopy.value.cancelButton }
    );
    if (confirmation.kind !== 'confirmed')
    {
        return;
    }

    mfaDisableLoading.value = true;
    mfaError.value = '';
    try
    {
        const proof = await startMfaChallenge('mfa_disable');
        if (!proof.verified || !proof.proofToken)
        {
            mfaError.value = mfaCopy.value.disableChallengeRequired;
            return;
        }

        await disableMfa({ mfaProofToken: proof.proofToken });
        await refreshMfaProfile();
        toast.success(mfaCopy.value.disabledSuccess);
    }
    catch (error)
    {
        mfaError.value = identityOperationErrorMessage(error, mfaCopy.value.disableFailedFallback, mfaCopy.value.disableChallengeRequired);
    }
    finally
    {
        mfaDisableLoading.value = false;
    }
};

const refreshSessions = async (): Promise<void> =>
{
    sessionLoading.value = true;
    sessionError.value = '';
    try
    {
        sessions.value = await listSessions();
    }
    catch (error)
    {
        sessionError.value = toAppError(error, sessionsCopy.value.loadFailedFallback).message || sessionsCopy.value.loadFailedFallback;
    }
    finally
    {
        sessionLoading.value = false;
    }
};

const refreshIdentityData = async (): Promise<void> =>
{
    await Promise.all([
        refreshPasskeys(),
        refreshMfaProfile(),
        refreshSessions()
    ]);
};

const startEditPasskeyName = (credential: PasskeyCredentialSummary): void =>
{
    passkeyEditingId.value = credential.id;
    passkeyEditName.value = credential.deviceFriendlyName ?? '';
};

const savePasskeyName = async (id: number): Promise<void> =>
{
    if (!passkeyEditName.value.trim())
    {
        return;
    }

    try
    {
        const proofToken = await resolveSensitiveOperationProof('passkey.credential-name.update');
        const renamed = await renamePasskeyCredential(id, passkeyEditName.value.trim(), proofToken);
        if (renamed)
        {
            passkeyEditingId.value = null;
        }
    }
    catch (error)
    {
        passkeyError.value = identityOperationErrorMessage(error, errorCopy.value.renameFailedFallback, errorCopy.value.passkeySensitiveOperationRequired);
    }
};

const confirmDeletePasskey = async (id: number): Promise<void> =>
{
    const confirmed = await confirmDanger(
        confirmCopy.value.deletePasskeyBody,
        confirmCopy.value.deletePasskeyTitle,
        { confirmButtonText: confirmCopy.value.confirmButton, cancelButtonText: confirmCopy.value.cancelButton }
    );
    if (!confirmed)
    {
        return;
    }

    try
    {
        const proofToken = await resolveSensitiveOperationProof('passkey.delete');
        await removePasskey(id, proofToken);
    }
    catch (error)
    {
        passkeyError.value = identityOperationErrorMessage(error, errorCopy.value.deleteFailedFallback, errorCopy.value.passkeySensitiveOperationRequired);
    }
};

const onPasskeyRegistered = async (): Promise<void> =>
{
    passkeyRegisterVisible.value = false;
    await fetchPasskeys();
};

const setRecoveryKeyResponse = (response: { recoveryKey: string; keyVersion: number; createdAt: string; }): void =>
{
    recoveryKeyPlaintext.value = response.recoveryKey;
    recoveryKeyVersion.value = response.keyVersion;
    recoveryKeyCreatedAt.value = response.createdAt;
    recoveryKeySaved.value = false;
    recoveryKeyKnown.value = true;
};

const issueRecoveryKey = async (mode: 'create' | 'rotate'): Promise<void> =>
{
    recoveryLoading.value = true;
    recoveryKeyError.value = '';
    try
    {
        const proofToken = mode === 'create'
            ? await resolveSensitiveOperationProof('recovery-key.create')
            : await resolveSensitiveOperationProof('recovery-key.rotate');
        const response = mode === 'create'
            ? await createRecoveryKey({ mfaProofToken: proofToken })
            : await rotateRecoveryKey({ mfaProofToken: proofToken });
        setRecoveryKeyResponse(response);
        toast.success(mode === 'create' ? errorCopy.value.recoveryKeyCreatedSuccess : errorCopy.value.recoveryKeyRotatedSuccess);
    }
    catch (error)
    {
        recoveryKeyError.value = identityOperationErrorMessage(error, errorCopy.value.recoveryKeyFailedFallback, errorCopy.value.recoveryKeySensitiveOperationRequired);
    }
    finally
    {
        recoveryLoading.value = false;
    }
};

const createRecoveryKeyForAccount = async (): Promise<void> =>
{
    await issueRecoveryKey('create');
};

const rotateRecoveryKeyForAccount = async (): Promise<void> =>
{
    const confirmed = await confirmDanger(
        confirmCopy.value.rotateRecoveryKeyBody,
        confirmCopy.value.rotateRecoveryKeyTitle,
        { confirmButtonText: confirmCopy.value.confirmButton, cancelButtonText: confirmCopy.value.cancelButton }
    );
    if (!confirmed)
    {
        return;
    }

    await issueRecoveryKey('rotate');
};

const clearRecoveryKeyPanel = (): void =>
{
    recoveryKeyPlaintext.value = '';
    recoveryKeySaved.value = false;
};

const savePublicHandle = async (): Promise<void> =>
{
    publicHandleSaving.value = true;
    publicHandleError.value = '';
    const nextPublicHandle = publicHandleDraft.value.trim();
    try
    {
        if (passkeyCredentials.value.length > 0)
        {
            await webauthnSignalService.commitAndReconcile(
                () => updatePublicHandle({ publicHandle: nextPublicHandle || null }),
                getPasskeySignalState,
                { currentUserDetails: true }
            );
        }
        else
        {
            await updatePublicHandle({ publicHandle: nextPublicHandle || null });
        }
        await userStore.fetchUserInfo(true);
        publicHandleDraft.value = userStore.userInfo?.publicHandle ?? '';
        toast.success(nextPublicHandle ? publicProfileCopy.value.savedSuccess : publicProfileCopy.value.clearedSuccess);
    }
    catch (error)
    {
        publicHandleError.value = toAppError(error, publicProfileCopy.value.saveFailedFallback).message || publicProfileCopy.value.saveFailedFallback;
    }
    finally
    {
        publicHandleSaving.value = false;
    }
};

const deleteCurrentAccount = async (): Promise<void> =>
{
    const confirmed = await confirmDanger(
        confirmCopy.value.deleteAccountBody,
        confirmCopy.value.deleteAccountTitle,
        { confirmButtonText: confirmCopy.value.confirmButton, cancelButtonText: confirmCopy.value.cancelButton }
    );
    if (!confirmed)
    {
        return;
    }

    deleteAccountLoading.value = true;
    deleteAccountError.value = '';
    try
    {
        const proofToken = await resolveSensitiveOperationProof('account.delete');
        await deleteAccount({
            confirmText: 'DELETE',
            mfaProofToken: proofToken
        });
        await clearPrivateBrowserState('account-deletion');
        toast.success(errorCopy.value.accountDeletedSuccess);
        await userStore.logout();
    }
    catch (error)
    {
        deleteAccountError.value = identityOperationErrorMessage(error, errorCopy.value.accountDeleteFailedFallback, errorCopy.value.accountDeleteSensitiveOperationRequired);
    }
    finally
    {
        deleteAccountLoading.value = false;
    }
};

const revokeSessionDevice = async (sessionId: string): Promise<void> =>
{
    await revokeSession(sessionId);
    toast.success(sessionsCopy.value.revokeSuccess);
    await refreshSessions();
};

const revokeOtherSessionDevices = async (): Promise<void> =>
{
    if (otherSessions.value.length === 0)
    {
        return;
    }

    await revokeOtherSessionsApi();
    toast.success(sessionsCopy.value.revokeOthersSuccess);
    await refreshSessions();
};

const formatSessionDevice = (label: string | null | undefined): string =>
{
    const trimmedLabel = label?.trim();
    if (trimmedLabel)
    {
        return trimmedLabel;
    }
    return sessionsCopy.value.deviceFallback;
};

const formatAuthenticationMethod = (method: UserSessionSummary['authenticationMethod']): string => ({
    passkey: sessionsCopy.value.authenticationPasskey,
    recovery_key: sessionsCopy.value.authenticationRecoveryKey,
    enrollment: sessionsCopy.value.authenticationEnrollment,
    other: sessionsCopy.value.authenticationOther
})[method];

const formatDurationPolicy = (policy: UserSessionSummary['durationPolicy']): string =>
    policy === 'persistent_30d' ? sessionsCopy.value.durationPersistent : sessionsCopy.value.durationBrowserSession;

onMounted(() =>
{
    void refreshIdentityData();
    ensureCommentRecordsLoaded();
});

watch(
    () => userStore.userInfo?.publicHandle,
    (publicHandle) =>
    {
        if (!publicHandleSaving.value)
        {
            publicHandleDraft.value = publicHandle ?? '';
        }
    },
    { immediate: true }
);

watch(currentRouteName, () =>
{
    ensureCommentRecordsLoaded();
    if (currentSession.value === null || isSection('UserIdentityOverview'))
    {
        void refreshIdentityData();
    }
});
</script>

<style scoped>
@import "@/assets/main.css" reference;

.identity-center
 {
    display: grid;
    gap: var(--fsus-space-8);
}

.identity-status-grid
 {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--fsus-space-4);
}

.identity-status-card
 {
    min-width: 0;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-panel-bg-soft);
    padding: var(--fsus-space-4);
}

.identity-status-card strong
 {
    display: block;
    margin-top: var(--fsus-space-1);
    color: var(--fsusblog-text-primary);
    font-size: 16px;
}

.identity-status-card p,
.identity-copy-block p
 {
    margin: var(--fsus-space-1) 0 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.65;
}

.identity-status-label
 {
    display: block;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.identity-summary-list,
.identity-state-row
 {
    display: grid;
    gap: var(--fsus-space-3);
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
}

.identity-summary-list
 {
    margin: 0;
}

.identity-summary-list > div
 {
    display: grid;
    grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr);
    gap: var(--fsus-space-4);
    align-items: start;
}

.identity-summary-list dt,
.identity-summary-list dd
 {
    margin: 0;
    min-width: 0;
    line-height: 1.65;
}

.identity-summary-list dt
 {
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.identity-summary-list dd
 {
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
}

.identity-profile-form,
.identity-profile-field
 {
    display: grid;
}

.identity-profile-form
 {
    gap: var(--fsus-space-4);
}

.identity-profile-field
 {
    gap: var(--fsus-space-3);
}

.identity-profile-field__label
 {
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.35;
}

.identity-profile-summary
 {
    margin-top: var(--fsus-space-1);
}

.identity-profile-actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
    padding-top: var(--fsus-space-1);
}

.identity-mfa-status-tag
 {
    justify-self: start;
    font-weight: 700;
}

.identity-policy-grid
 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: var(--fsus-space-1);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-panel-border);
    overflow: hidden;
}

.identity-policy-item
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-4);
    min-width: 0;
    min-height: 3.7rem;
    background: var(--fsusblog-page-bg);
    padding: var(--fsus-space-4) var(--fsus-space-4);
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.35;
}

.identity-policy-label
 {
    min-width: 0;
    overflow-wrap: anywhere;
}

.identity-policy-state
 {
    display: inline-flex;
    align-items: center;
    gap: var(--fsus-space-2);
    flex: 0 0 auto;
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
}

.identity-policy-state__dot
 {
    box-sizing: border-box;
    width: 0.35rem;
    height: 0.35rem;
    border-radius: var(--fsus-radius-pill);
    background: currentcolor;
    opacity: 0.72;
}

.identity-policy-state--open
 {
    color: var(--fsusblog-color-primary);
}

.identity-policy-state--open .identity-policy-state__dot
 {
    opacity: 0.82;
}

.identity-policy-state--active
 {
    color: var(--fsusblog-text-secondary);
}

.identity-policy-state--active .identity-policy-state__dot
 {
    width: 0.55rem;
    height: 0.22rem;
    opacity: 0.86;
}

.identity-policy-state--closed
 {
    color: var(--fsusblog-color-error);
}

.identity-policy-state--muted
 {
    color: var(--fsusblog-text-muted);
}

.identity-policy-state--muted .identity-policy-state__dot
 {
    border: 1px solid currentcolor;
    background: transparent;
    opacity: 0.8;
}

.identity-loading-state,
.identity-error-state
 {
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    padding: var(--fsus-space-4) var(--fsus-space-4);
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    line-height: 1.65;
}

.identity-comment-records-state,
.identity-comment-records-list
 {
    margin-top: var(--fsus-space-6);
}

.identity-error-state
 {
    border-color: var(--fsusblog-color-error-border);
    background: var(--fsusblog-color-error-bg);
    color: var(--fsusblog-color-error);
    font-weight: 700;
}

.identity-secret-panel
 {
    display: grid;
    gap: var(--fsus-space-3);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-panel-bg-soft);
    padding: var(--fsus-space-4);
}

.identity-secret-panel code
 {
    overflow-wrap: anywhere;
    color: var(--fsusblog-text-primary);
    font-family: var(--fsus-typography-code-family, var(--fsus-font-code, ui-monospace, monospace));
    font-size: 14px;
    line-height: 1.7;
}

.identity-touch-action
 {
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
    padding-inline: var(--fsus-space-3);
}

@media (width <= 1023px)
 {
    .identity-status-grid
 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (width <= 639px)
 {
    .identity-status-grid,
    .identity-summary-list > div
 {
        grid-template-columns: minmax(0, 1fr);
    }

    .identity-summary-list > div
 {
        gap: var(--fsus-space-1);
    }
}
</style>
