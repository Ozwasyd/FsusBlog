<template>
  <div class="account-page identity-center">
    <header v-if="showIdentityRouteHeader" class="identity-section-header">
      <div class="identity-section-header__copy">
        <h1>{{ sectionMeta.title }}</h1>
        <p v-if="sectionMeta.description">{{ sectionMeta.description }}</p>
      </div>
    </header>

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

      <FsusUiSettingsSection
        class="mt-6"
        :title="copy.lifecycleTitle"
        :description="copy.lifecycleDescription"
        :title-tag="'h2'"
      >
        <div class="identity-copy-block">
          <p>{{ copy.lifecycleWarning }}</p>
        </div>
        <div v-if="deleteAccountError" class="identity-error-state mt-4" role="alert">{{ deleteAccountError }}</div>
        <div class="mt-5">
          <el-button type="danger" :loading="deleteAccountLoading" @click="deleteCurrentAccount">{{ copy.deleteAccountCta }}</el-button>
        </div>
      </FsusUiSettingsSection>
    </template>

    <FsusUiSettingsSection
      v-else-if="isSection('UserIdentityPasskeys')"
      :title="passkeysCopy.sectionTitle"
      :description="passkeysCopy.sectionDescription"
      :title-tag="'h2'"
    >
      <div v-if="passkeyLoading" class="identity-loading-state">{{ passkeysCopy.loading }}</div>
      <div v-else-if="passkeyError" class="identity-error-state" role="alert">{{ passkeyError }}</div>
      <div
        v-if="!passkeyLoading && !passkeyError && showPasskeyRecoverySuggestion"
        class="identity-copy-block mt-4"
        role="status"
      >
        <p>{{ passkeysCopy.recoverySuggestion }}</p>
      </div>

      <ProfileResourceList v-if="!passkeyLoading && !passkeyError && passkeyCredentials.length">
        <ProfileResourceListItem
          v-for="credential in passkeyCredentials"
          :key="credential.id"
        >
          <template #title>
            <div v-if="passkeyEditingId === credential.id" class="flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <el-input
                  v-model="passkeyEditName"
                  maxlength="64"
                  clearable
                  :aria-label="passkeysCopy.nameInputAriaLabel"
                  @keyup.enter="savePasskeyName(credential.id)"
                  @keyup.esc="passkeyEditingId = null"
                />
              </div>
              <el-button link type="primary" @click="savePasskeyName(credential.id)">{{ passkeysCopy.saveCta }}</el-button>
              <el-button link @click="passkeyEditingId = null">{{ passkeysCopy.cancelCta }}</el-button>
            </div>
            <div v-else class="flex items-center gap-3">
              <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                {{ credential.deviceFriendlyName || passkeysCopy.nameEmpty }}
              </p>
              <el-button link @click="startEditPasskeyName(credential)">{{ passkeysCopy.editCta }}</el-button>
            </div>
          </template>
          <template #meta>
            <span>{{ passkeysCopy.createdAtLabel }}：<SemanticTime :value="credential.createdAt" format="date" /></span>
            <span v-if="credential.lastUsedAt">{{ passkeysCopy.activeAtLabel }}：<SemanticTime :value="credential.lastUsedAt" format="date" /></span>
            <span v-else>{{ passkeysCopy.activeAtLabel }}：{{ passkeysCopy.activeNeverRecorded }}</span>
            <span>{{ credential.backupEligible ? passkeysCopy.backupEligible : passkeysCopy.backupIneligible }}</span>
          </template>
          <template #actions>
              <el-button class="identity-touch-action" link type="danger" @click="confirmDeletePasskey(credential.id)">{{ passkeysCopy.deleteCta }}</el-button>
          </template>
        </ProfileResourceListItem>
      </ProfileResourceList>

      <ProfileInlineEmptyState
        v-else-if="!passkeyLoading && !passkeyError"
        class="identity-empty-state"
        :title="passkeysCopy.emptyTitle"
        :content="passkeysCopy.emptyContent"
      >
        <template #actions>
          <el-button type="primary" @click="passkeyRegisterVisible = true">{{ passkeysCopy.addCta }}</el-button>
        </template>
      </ProfileInlineEmptyState>

      <div v-if="passkeyCredentials.length" class="mt-6">
        <el-button type="primary" @click="passkeyRegisterVisible = true">{{ passkeysCopy.addCta }}</el-button>
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

      <div v-if="recoveryLoading" class="identity-loading-state">{{ recoveryKeyCopy.loading }}</div>
      <div v-if="recoveryKeyError" class="identity-error-state" role="alert">{{ recoveryKeyError }}</div>

      <div v-if="recoveryKeyPlaintext" class="identity-secret-panel" aria-live="polite">
        <span class="identity-status-label">{{ recoveryKeyCopy.panelVersionPrefix }}{{ recoveryKeyVersion }}</span>
        <code>{{ recoveryKeyPlaintext }}</code>
        <p v-if="recoveryKeyCreatedAt">{{ recoveryKeyCopy.panelCreatedAtPrefix }}{{ recoveryKeyCreatedAt }}</p>
        <el-checkbox v-model="recoveryKeySaved">{{ recoveryKeyCopy.savedCheckbox }}</el-checkbox>
        <el-button :disabled="!recoveryKeySaved" @click="clearRecoveryKeyPanel">{{ recoveryKeyCopy.closeOnceCta }}</el-button>
      </div>

      <div class="mt-6 flex flex-wrap gap-3">
        <el-button type="primary" :loading="recoveryLoading" @click="createRecoveryKeyForAccount">{{ recoveryKeyCopy.createCta }}</el-button>
        <el-button :loading="recoveryLoading" @click="rotateRecoveryKeyForAccount">{{ recoveryKeyCopy.rotateCta }}</el-button>
      </div>
    </FsusUiSettingsSection>

    <FsusUiSettingsSection
      v-else-if="isSection('UserIdentityMfa')"
      :title="mfaCopy.sectionTitle"
      :description="mfaCopy.sectionDescription"
      :title-tag="'h2'"
    >
      <div v-if="mfaLoading" class="identity-loading-state">{{ mfaCopy.loading }}</div>
      <div v-else-if="mfaError" class="identity-error-state" role="alert">{{ mfaError }}</div>
      <div v-else class="identity-state-row">
        <el-tag class="identity-mfa-status-tag" :type="mfaProfile?.enabled ? 'success' : 'warning'" effect="plain">
          {{ mfaProfile?.enabled ? mfaCopy.enabled : mfaCopy.disabled }}
        </el-tag>
        <span v-if="mfaProfile?.verifiedAt">{{ mfaCopy.lastVerifiedPrefix }}：<SemanticTime :value="mfaProfile.verifiedAt" format="date" /></span>
        <span v-else>{{ mfaCopy.lastVerifiedEmpty }}</span>
      </div>
      <div class="mt-6 flex flex-wrap gap-3">
        <el-button
          v-if="!mfaProfile?.enabled"
          type="primary"
          :loading="mfaSetupLoading"
          @click="startMfaSetupFlow"
        >
          {{ mfaCopy.enableCta }}
        </el-button>
        <el-button
          v-else
          type="danger"
          plain
          :loading="mfaDisableLoading"
          @click="disableTotpMfa"
        >
          {{ mfaCopy.disableCta }}
        </el-button>
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
          <label for="public-handle-draft" class="identity-profile-field__label">
            {{ publicProfileCopy.draftLabel }}
          </label>
          <el-input
            id="public-handle-draft"
            v-model="publicHandleDraft"
            maxlength="20"
            autocomplete="off"
            :placeholder="publicProfileCopy.draftPlaceholder"
          />
        </div>
        <div v-if="publicHandleError" class="identity-error-state" role="alert">{{ publicHandleError }}</div>
        <el-checkbox v-model="explicitPublicSendOptIn">
          {{ publicProfileCopy.optInCheckbox }}
        </el-checkbox>
        <div class="identity-profile-summary identity-policy-grid" role="list" :aria-label="publicProfileCopy.summaryAriaLabel">
          <div class="identity-policy-item" role="listitem">
            <span class="identity-policy-label">{{ publicProfileCopy.publicSendOptionLabel }}</span>
            <span :class="['identity-policy-state', `identity-policy-state--${publicSendOptionState}`]">
              <span class="identity-policy-state__dot" aria-hidden="true" />
              {{ publicSendOptionValue }}
            </span>
          </div>
        </div>
        <div class="identity-profile-actions">
          <el-button type="primary" :loading="publicHandleSaving" @click="savePublicHandle">{{ publicProfileCopy.saveCta }}</el-button>
        </div>
      </div>
    </FsusUiSettingsSection>

    <FsusUiSettingsSection
      v-else-if="isSection('UserIdentitySessions')"
      :title="sessionsCopy.sectionTitle"
      :description="sessionsCopy.sectionDescription"
      :title-tag="'h2'"
    >
      <div v-if="sessionLoading" class="identity-loading-state">{{ sessionsCopy.loading }}</div>
      <div v-else-if="sessionError" class="identity-error-state" role="alert">{{ sessionError }}</div>

      <template v-else>
        <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p class="m-0 text-[12px] text-[var(--fsusblog-text-tertiary)]">{{ sessionsActiveCountText }}</p>
          <el-button type="primary" plain :disabled="otherSessions.length === 0" @click="revokeOtherSessionDevices">
            {{ sessionsCopy.revokeOthersCta }}
          </el-button>
        </div>

        <ProfileResourceList v-if="sessions.length">
          <ProfileResourceListItem
            v-for="session in sessions"
            :key="session.sessionId"
          >
            <template #title>
              <p class="m-0 block min-w-0 max-w-full truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
                {{ formatSessionDevice(session.deviceLabel, session.deviceFingerprint) }}
              </p>
            </template>
            <template #meta>
              <span>{{ session.isCurrent ? sessionsCopy.currentDevice : sessionsCopy.otherDevice }}</span>
              <span v-if="session.lastSeenAt">{{ sessionsCopy.activeAtPrefix }}<SemanticTime :value="session.lastSeenAt" format="date" /></span>
            </template>
            <template #actions>
              <el-button
                class="identity-touch-action"
                v-if="!session.isCurrent"
                link
                type="danger"
                @click="revokeSessionDevice(session.sessionId)"
              >
                {{ sessionsCopy.revokeCta }}
              </el-button>
            </template>
          </ProfileResourceListItem>
        </ProfileResourceList>

        <ProfileInlineEmptyState
          v-else
          class="identity-empty-state"
          :title="sessionsCopy.emptyTitle"
          :content="sessionsCopy.emptyContent"
        />
      </template>
    </FsusUiSettingsSection>

    <FsusUiSettingsSection
      v-else-if="isSection('UserIdentityCommentRecords')"
      :title="commentRecordsCopy.sectionTitle"
      :description="commentRecordsCopy.sectionDescription"
      :title-tag="'h2'"
    >
      <div class="identity-policy-grid" role="list" :aria-label="commentRecordsCopy.policyAriaLabel">
        <div
          v-for="item in commentRecordPolicyItems"
          :key="item.label"
          class="identity-policy-item"
          role="listitem"
        >
          <span class="identity-policy-label">{{ item.label }}</span>
          <span :class="['identity-policy-state', `identity-policy-state--${item.state}`]">
            <span class="identity-policy-state__dot" aria-hidden="true" />
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
import { startAuthentication } from '@simplewebauthn/browser'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { FsusUiSettingsSection } from '@/fsusui'
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import UserCommentsEmptyState from '@/components/user/UserCommentsEmptyState.vue'
import UserCommentsErrorState from '@/components/user/UserCommentsErrorState.vue'
import UserCommentsList from '@/components/user/UserCommentsList.vue'
import {
  ProfileInlineEmptyState,
  ProfileResourceList,
  ProfileResourceListItem
} from '@/components/user/ProfileSettingsPrimitives'
import {
  createRecoveryKey,
  deleteAccount,
  disableMfa,
  getMfaProfile,
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
  type MfaChallengeResult,
  type MfaProfile,
  type MfaSetupStart,
  type MfaSetupVerify,
  type PasskeyCredentialSummary,
  type PasskeyLoginBeginResponse,
  type UserSessionSummary
} from '@/api/auth'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import { shouldSuggestPasskeyRecovery } from '@/composables/passkeyRecoveryCapability'
import { useUserCommentsPage } from '@/composables/useUserCommentsPage'
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext'
import { useUserStore } from '@/store/user'
import { confirmDanger, toast } from '@/fsusui/feedback'
import { toAppError } from '@/utils/appError'
import { FSUSBLOG_IDENTITY_COPY } from '@/copy'
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime'

const identityCopy = FSUSBLOG_IDENTITY_COPY
const copy = identityCopy.overview
const passkeysCopy = identityCopy.passkeys
const recoveryKeyCopy = identityCopy.recoveryKey
const mfaCopy = identityCopy.mfa
const anonymousCopy = identityCopy.anonymous
const publicProfileCopy = identityCopy.publicProfile
const sessionsCopy = identityCopy.sessions
const commentRecordsCopy = identityCopy.commentRecords
const confirmCopy = identityCopy.confirm
const errorCopy = identityCopy.errors

const sectionMetaByRoute = identityCopy.meta

type IdentityRouteName = keyof typeof sectionMetaByRoute
type IdentityPolicyState = 'open' | 'active' | 'closed' | 'muted'

const stepUpErrorCodes = new Set([
  'PASSWORD_OR_STEP_UP_PROOF_REQUIRED',
  'PASSKEY_STEP_UP_DISABLED',
  'ANONYMOUS_STEP_UP_PROOF_REQUIRED',
  'ANONYMOUS_MFA_STEP_UP_REQUIRED',
  'MFA_PROOF_REQUIRED',
  'MFA_REQUIRED',
  'STEP_UP_PROOF_INVALID',
  'STEP_UP_PRINCIPAL_REQUIRED'
])

const stripTraceSuffix = (message: string): string =>
  message.replace(/\s*\[trace:[^\]]+\]\s*$/u, '').trim()

const identityOperationErrorMessage = (
  error: unknown,
  fallback: string,
  stepUpFallback = fallback
): string => {
  const message = toAppError(error, fallback).message || fallback
  return stepUpErrorCodes.has(stripTraceSuffix(message)) ? stepUpFallback : message
}

const isPasskeyStepUpDisabledError = (error: unknown): boolean =>
  stripTraceSuffix(toAppError(error, '').message) === 'PASSKEY_STEP_UP_DISABLED'

const normalizeLocalPasskeyOptions = (options: Record<string, unknown>): Record<string, unknown> => {
  const hostname = globalThis.location?.hostname
  if (hostname === '127.0.0.1' && options.rpId === 'localhost') {
    return { ...options, rpId: '127.0.0.1' }
  }
  if (hostname === 'localhost' && options.rpId === '127.0.0.1') {
    return { ...options, rpId: 'localhost' }
  }
  return options
}

const isWebAuthnAbort = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name?: string }).name === 'NotAllowedError'

const resolvePasskeyStepUpProof = async (action: string): Promise<string> => {
  const challenge = await userStepUpPasskeyBegin(action) as PasskeyLoginBeginResponse
  const challengeToken = (challenge as any).challengeToken || (challenge as any).ChallengeToken
  const options = (challenge as any).options || (challenge as any).Options
  if (!challengeToken || !options || typeof options !== 'object') {
    throw new Error('MFA_PROOF_REQUIRED')
  }

  let assertion: Awaited<ReturnType<typeof startAuthentication>>
  try {
    assertion = await startAuthentication({
      ['options' + String.fromCharCode(74, 83, 79, 78)]: normalizeLocalPasskeyOptions(options as Record<string, unknown>)
    } as any)
  } catch (error) {
    if (isWebAuthnAbort(error)) {
      throw new Error('MFA_PROOF_REQUIRED')
    }
    throw error
  }

  const proof = await userStepUpPasskeyComplete({
    challengeToken,
    assertion
  })
  if (!proof.verified || proof.action !== action || !proof.proofToken) {
    throw new Error('MFA_PROOF_REQUIRED')
  }

  return proof.proofToken
}

const resolveTotpStepUpProof = async (action: string): Promise<string> => {
  const proof = await startMfaChallenge(action) as MfaChallengeResult
  if (!proof.verified || !proof.proofToken) {
    throw new Error('MFA_PROOF_REQUIRED')
  }

  return proof.proofToken
}

const resolveSensitiveOperationProof = async (action: string): Promise<string> => {
  if (passkeyCredentials.value.length > 0) {
    try {
      return await resolvePasskeyStepUpProof(action)
    } catch (error) {
      if (isPasskeyStepUpDisabledError(error) && mfaProfile.value?.enabled) {
        return resolveTotpStepUpProof(action)
      }

      throw error
    }
  }

  return resolveTotpStepUpProof(action)
}

const route = useRoute()
const userStore = useUserStore()
const workspaceContext = useAccountWorkspaceContext()

const {
  credentials: passkeyCredentials,
  loading: passkeyLoading,
  error: passkeyError,
  fetchPasskeys,
  removePasskey,
  renamePasskeyCredential
} = usePasskeyManagement()

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
} = useUserCommentsPage({ autoload: false })

const commentRecordsLoaded = ref(false)

const passkeyRegisterVisible = ref(false)
const passkeyEditingId = ref<number | null>(null)
const passkeyEditName = ref('')

const recoveryLoading = ref(false)
const recoveryKeyError = ref('')
const recoveryKeyPlaintext = ref('')
const recoveryKeyVersion = ref<number | null>(null)
const recoveryKeyCreatedAt = ref<string | null>(null)
const recoveryKeySaved = ref(false)
const recoveryKeyKnown = ref(false)

const mfaLoading = ref(false)
const mfaError = ref('')
const mfaProfile = ref<MfaProfile | null>(null)
const mfaSetupVisible = ref(false)
const mfaSetupLoading = ref(false)
const mfaDisableLoading = ref(false)
const mfaSetupSecret = ref('')
const mfaSetupOtpAuthUrl = ref('')
const mfaSetupCode = ref('')
const mfaSetupRecoveryCodes = ref<string[]>([])
const mfaSetupError = ref('')

const sessionLoading = ref(false)
const sessionError = ref('')
const sessions = ref<UserSessionSummary[]>([])

const publicHandleDraft = ref('')
const publicHandleSaving = ref(false)
const publicHandleError = ref('')
const explicitPublicSendOptIn = ref(false)
const deleteAccountLoading = ref(false)
const deleteAccountError = ref('')

const currentRouteName = computed<IdentityRouteName>(() => {
  const name = typeof route.name === 'string' ? route.name : ''
  return name in sectionMetaByRoute ? name as IdentityRouteName : 'UserIdentityOverview'
})

const sectionMeta = computed(() => sectionMetaByRoute[currentRouteName.value])
const isSection = (name: IdentityRouteName): boolean => currentRouteName.value === name
const showIdentityRouteHeader = computed(() => isSection('UserIdentityOverview'))

const ensureCommentRecordsLoaded = (): void => {
  if (!isSection('UserIdentityCommentRecords') || commentRecordsLoaded.value || commentRecordsLoading.value) {
    return
  }

  commentRecordsLoaded.value = true
  void fetchCommentRecords()
}

const workspaceFeatures = computed(() => workspaceContext.value.features)
const workspacePolicies = computed(() => workspaceContext.value.policies)
const currentSession = computed(() => sessions.value.find((session) => session.isCurrent) ?? null)
const otherSessions = computed(() => sessions.value.filter((session) => !session.isCurrent))

const passkeyDeviceCountText = computed(() =>
  copy.passkeyDeviceCount.replace('{n}', String(passkeyCredentials.value.length))
)

const publicHandleDisplayText = computed(() =>
  identityAccountSnapshot.value.publicHandle || copy.publicHandleEmpty
)

const anonymousPolicyDisplayText = computed(() =>
  identityAccountSnapshot.value.anonymousPolicyEnabled ? copy.anonymousPolicyAllowed : copy.anonymousPolicyClosed
)

const publicSendOptionDisplayText = computed(() =>
  identityAccountSnapshot.value.publicSendOptionEnabled ? copy.publicSendOptionAllowed : copy.publicSendOptionClosed
)

const publicSendOptionState = computed<IdentityPolicyState>(() =>
  workspaceFeatures.value.publicSendOptionEnabled ? 'open' : 'muted'
)

const publicSendOptionValue = computed(() =>
  workspaceFeatures.value.publicSendOptionEnabled
    ? publicProfileCopy.publicSendOptionAvailable
    : publicProfileCopy.publicSendOptionUnavailable
)

const commentRecordPolicyItems = computed<Array<{ label: string; value: string; state: IdentityPolicyState }>>(() => {
  const features = workspaceFeatures.value
  const policies = workspacePolicies.value

  return [
    {
      label: commentRecordsCopy.policyPublicSendLabel,
      value: features.publicSendOptionEnabled ? commentRecordsCopy.policyOpen : commentRecordsCopy.policyClosed,
      state: features.publicSendOptionEnabled ? 'open' : 'muted'
    },
    {
      label: commentRecordsCopy.policyAnonymousLabel,
      value: features.anonymousCommentsEnabled ? commentRecordsCopy.policyOpen : commentRecordsCopy.policyClosed,
      state: features.anonymousCommentsEnabled ? 'open' : 'closed'
    },
    {
      label: commentRecordsCopy.policyZkLabel,
      value: features.zkAnonymousEnabled ? commentRecordsCopy.policyOpen : commentRecordsCopy.policyUnavailable,
      state: features.zkAnonymousEnabled ? 'open' : 'muted'
    },
    {
      label: commentRecordsCopy.policyGovernanceLabel,
      value: policies.anonymousCommentGovernanceAvailable ? commentRecordsCopy.policyActive : commentRecordsCopy.policyUnavailable,
      state: policies.anonymousCommentGovernanceAvailable ? 'active' : 'closed'
    }
  ]
})

const sessionsActiveCountText = computed(() =>
  sessionsCopy.activeCountPrefix.replace('{n}', String(sessions.value.length))
)

const identityAccountSnapshot = computed(() => {
  const features = workspaceFeatures.value
  const policies = workspacePolicies.value
  const user = userStore.userInfo

  return {
    accountId: user?.accountId ?? 0,
    publicHandle: user?.publicHandle || '',
    passkeyEnabled: passkeyCredentials.value.length > 0,
    recoveryEnabled: user?.recoveryEnabled === true || recoveryKeyKnown.value || recoveryKeyPlaintext.value.length > 0,
    totpStepUpEnabled: mfaProfile.value?.enabled === true,
    anonymousPolicyEnabled: features.anonymousCommentsEnabled && policies.anonymousCommentGovernanceAvailable,
    anonymousCardStatus: features.anonymousCommentsEnabled ? copy.anonymousCardAvailable : copy.anonymousCardClosed,
    zkAnonymousAvailable: features.zkAnonymousEnabled,
    publicSendOptionEnabled: features.publicSendOptionEnabled
  }
})

const showPasskeyRecoverySuggestion = computed(() => shouldSuggestPasskeyRecovery(
  passkeyCredentials.value,
  identityAccountSnapshot.value.recoveryEnabled
))

const refreshPasskeys = async (): Promise<void> => {
  await fetchPasskeys()
}

const refreshMfaProfile = async (): Promise<void> => {
  mfaLoading.value = true
  mfaError.value = ''
  try {
    mfaProfile.value = await getMfaProfile()
  } catch (error) {
    mfaError.value = toAppError(error, mfaCopy.loadFailedFallback).message || mfaCopy.loadFailedFallback
  } finally {
    mfaLoading.value = false
  }
}

const startMfaSetupFlow = async (): Promise<void> => {
  mfaSetupVisible.value = true
  mfaSetupLoading.value = true
  mfaSetupSecret.value = ''
  mfaSetupOtpAuthUrl.value = ''
  mfaSetupCode.value = ''
  mfaSetupRecoveryCodes.value = []
  mfaSetupError.value = ''
  try {
    const action = mfaProfile.value?.enabled ? 'mfa_setup_rebind' : 'mfa_setup'
    const proof = await startMfaChallenge(action) as MfaChallengeResult
    if (!proof.verified || !proof.proofToken) {
      mfaSetupError.value = mfaCopy.setupChallengeRequired
      return
    }

    const response = await startMfaSetup({ mfaProofToken: proof.proofToken }) as MfaSetupStart
    mfaSetupSecret.value = response.secret
    mfaSetupOtpAuthUrl.value = response.otpAuthUrl
  } catch (error) {
    mfaSetupError.value = identityOperationErrorMessage(error, mfaCopy.initFailedFallback, mfaCopy.setupChallengeRequired)
  } finally {
    mfaSetupLoading.value = false
  }
}

const completeMfaSetupFlow = async (): Promise<void> => {
  if (!mfaSetupCode.value.trim()) {
    return
  }

  mfaSetupLoading.value = true
  mfaSetupError.value = ''
  try {
    const response = await verifyMfaSetup(mfaSetupCode.value.trim()) as MfaSetupVerify
    mfaSetupRecoveryCodes.value = response.recoveryCodes
    await refreshMfaProfile()
    toast.success(mfaCopy.enabledSuccess)
  } catch (error) {
    mfaSetupError.value = toAppError(error, mfaCopy.verifyFailedFallback).message || mfaCopy.verifyFailedFallback
  } finally {
    mfaSetupLoading.value = false
  }
}

const disableTotpMfa = async (): Promise<void> => {
  const confirmation = await confirmDanger(
    mfaCopy.disableConfirmBody,
    mfaCopy.disableConfirmTitle,
    { confirmButtonText: mfaCopy.disableConfirmCta, cancelButtonText: confirmCopy.cancelButton }
  )
  if (confirmation.kind !== 'confirmed') {
    return
  }

  mfaDisableLoading.value = true
  mfaError.value = ''
  try {
    const proof = await startMfaChallenge('mfa_disable') as MfaChallengeResult
    if (!proof.verified || !proof.proofToken) {
      mfaError.value = mfaCopy.disableChallengeRequired
      return
    }

    await disableMfa({ mfaProofToken: proof.proofToken })
    await refreshMfaProfile()
    toast.success(mfaCopy.disabledSuccess)
  } catch (error) {
    mfaError.value = identityOperationErrorMessage(error, mfaCopy.disableFailedFallback, mfaCopy.disableChallengeRequired)
  } finally {
    mfaDisableLoading.value = false
  }
}

const refreshSessions = async (): Promise<void> => {
  sessionLoading.value = true
  sessionError.value = ''
  try {
    sessions.value = await listSessions()
  } catch (error) {
    sessionError.value = toAppError(error, sessionsCopy.loadFailedFallback).message || sessionsCopy.loadFailedFallback
  } finally {
    sessionLoading.value = false
  }
}

const refreshIdentityData = async (): Promise<void> => {
  await Promise.all([
    refreshPasskeys(),
    refreshMfaProfile(),
    refreshSessions()
  ])
}

const startEditPasskeyName = (credential: PasskeyCredentialSummary): void => {
  passkeyEditingId.value = credential.id
  passkeyEditName.value = credential.deviceFriendlyName ?? ''
}

const savePasskeyName = async (id: number): Promise<void> => {
  if (!passkeyEditName.value.trim()) {
    return
  }

  try {
    const proofToken = await resolveSensitiveOperationProof('passkey.credential-name.update')
    const renamed = await renamePasskeyCredential(id, passkeyEditName.value.trim(), proofToken)
    if (renamed) {
      passkeyEditingId.value = null
    }
  } catch (error) {
    passkeyError.value = identityOperationErrorMessage(error, errorCopy.renameFailedFallback, errorCopy.passkeySensitiveOperationRequired)
  }
}

const confirmDeletePasskey = async (id: number): Promise<void> => {
  const confirmed = await confirmDanger(
    confirmCopy.deletePasskeyBody,
    confirmCopy.deletePasskeyTitle,
    { confirmButtonText: confirmCopy.confirmButton, cancelButtonText: confirmCopy.cancelButton }
  )
  if (!confirmed) {
    return
  }

  try {
    const proofToken = await resolveSensitiveOperationProof('passkey.delete')
    await removePasskey(id, proofToken)
  } catch (error) {
    passkeyError.value = identityOperationErrorMessage(error, errorCopy.deleteFailedFallback, errorCopy.passkeySensitiveOperationRequired)
  }
}

const onPasskeyRegistered = async (): Promise<void> => {
  passkeyRegisterVisible.value = false
  await fetchPasskeys()
}

const setRecoveryKeyResponse = (response: { recoveryKey: string; keyVersion: number; createdAt: string }): void => {
  recoveryKeyPlaintext.value = response.recoveryKey
  recoveryKeyVersion.value = response.keyVersion
  recoveryKeyCreatedAt.value = response.createdAt
  recoveryKeySaved.value = false
  recoveryKeyKnown.value = true
}

const issueRecoveryKey = async (mode: 'create' | 'rotate'): Promise<void> => {
  recoveryLoading.value = true
  recoveryKeyError.value = ''
  try {
    const proofToken = mode === 'create'
      ? await resolveSensitiveOperationProof('recovery-key.create')
      : await resolveSensitiveOperationProof('recovery-key.rotate')
    const response = mode === 'create'
      ? await createRecoveryKey({ mfaProofToken: proofToken })
      : await rotateRecoveryKey({ mfaProofToken: proofToken })
    setRecoveryKeyResponse(response)
    toast.success(mode === 'create' ? errorCopy.recoveryKeyCreatedSuccess : errorCopy.recoveryKeyRotatedSuccess)
  } catch (error) {
    recoveryKeyError.value = identityOperationErrorMessage(error, errorCopy.recoveryKeyFailedFallback, errorCopy.recoveryKeySensitiveOperationRequired)
  } finally {
    recoveryLoading.value = false
  }
}

const createRecoveryKeyForAccount = async (): Promise<void> => {
  await issueRecoveryKey('create')
}

const rotateRecoveryKeyForAccount = async (): Promise<void> => {
  const confirmed = await confirmDanger(
    confirmCopy.rotateRecoveryKeyBody,
    confirmCopy.rotateRecoveryKeyTitle,
    { confirmButtonText: confirmCopy.confirmButton, cancelButtonText: confirmCopy.cancelButton }
  )
  if (!confirmed) {
    return
  }

  await issueRecoveryKey('rotate')
}

const clearRecoveryKeyPanel = (): void => {
  recoveryKeyPlaintext.value = ''
  recoveryKeySaved.value = false
}

const savePublicHandle = async (): Promise<void> => {
  publicHandleSaving.value = true
  publicHandleError.value = ''
  const nextPublicHandle = publicHandleDraft.value.trim()
  try {
    await updatePublicHandle({ publicHandle: nextPublicHandle || null })
    await userStore.fetchUserInfo(true)
    publicHandleDraft.value = userStore.userInfo?.publicHandle ?? ''
    toast.success(nextPublicHandle ? publicProfileCopy.savedSuccess : publicProfileCopy.clearedSuccess)
  } catch (error) {
    publicHandleError.value = toAppError(error, publicProfileCopy.saveFailedFallback).message || publicProfileCopy.saveFailedFallback
  } finally {
    publicHandleSaving.value = false
  }
}

const deleteCurrentAccount = async (): Promise<void> => {
  const confirmed = await confirmDanger(
    confirmCopy.deleteAccountBody,
    confirmCopy.deleteAccountTitle,
    { confirmButtonText: confirmCopy.confirmButton, cancelButtonText: confirmCopy.cancelButton }
  )
  if (!confirmed) {
    return
  }

  deleteAccountLoading.value = true
  deleteAccountError.value = ''
  try {
    const proofToken = await resolveSensitiveOperationProof('account.delete')
    await deleteAccount({
      confirmText: 'DELETE',
      mfaProofToken: proofToken
    })
    await clearPrivateBrowserState('account-deletion')
    toast.success(errorCopy.accountDeletedSuccess)
    await userStore.logout()
  } catch (error) {
    deleteAccountError.value = identityOperationErrorMessage(error, errorCopy.accountDeleteFailedFallback, errorCopy.accountDeleteSensitiveOperationRequired)
  } finally {
    deleteAccountLoading.value = false
  }
}

const revokeSessionDevice = async (sessionId: string): Promise<void> => {
  await revokeSession(sessionId)
  toast.success(sessionsCopy.revokeSuccess)
  await refreshSessions()
}

const revokeOtherSessionDevices = async (): Promise<void> => {
  if (otherSessions.value.length === 0) {
    return
  }

  await revokeOtherSessionsApi()
  toast.success(sessionsCopy.revokeOthersSuccess)
  await refreshSessions()
}

const formatSessionDevice = (label: string | null | undefined, fingerprint: string | null | undefined): string =>
  label?.trim() || fingerprint?.trim() || sessionsCopy.deviceFallback

onMounted(() => {
  void refreshIdentityData()
  ensureCommentRecordsLoaded()
})

watch(
  () => userStore.userInfo?.publicHandle,
  (publicHandle) => {
    if (!publicHandleSaving.value) {
      publicHandleDraft.value = publicHandle ?? ''
    }
  },
  { immediate: true }
)

watch(currentRouteName, () => {
  ensureCommentRecordsLoaded()
  if (currentSession.value === null || isSection('UserIdentityOverview')) {
    void refreshIdentityData()
  }
})
</script>

<style scoped>
@reference "@/assets/main.css";

.identity-center {
  display: grid;
  gap: 2rem;
}

.identity-section-header {
  display: block;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  padding-bottom: 1rem;
}

.identity-section-header__copy {
  min-width: 0;
}

.identity-section-header__copy h1 {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: 0;
}

.identity-section-header__copy p {
  max-width: 42rem;
  margin: 1rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.6;
}

@media (min-width: 640px) {
  .identity-section-header__copy h1 {
    font-size: 1.875rem;
    line-height: 1.2;
  }
}

.identity-status-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
}

.identity-status-card {
  min-width: 0;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsusblog-panel-bg-soft);
  padding: 1rem;
}

.identity-status-card strong {
  display: block;
  margin-top: 0.35rem;
  color: var(--fsusblog-text-primary);
  font-size: 16px;
}

.identity-status-card p,
.identity-copy-block p {
  margin: 0.35rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
  line-height: 1.65;
}

.identity-status-label {
  display: block;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
}

.identity-summary-list,
.identity-state-row {
  display: grid;
  gap: 0.65rem;
  color: var(--fsusblog-text-secondary);
  font-size: 14px;
}

.identity-summary-list {
  margin: 0;
}

.identity-summary-list > div {
  display: grid;
  grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}

.identity-summary-list dt,
.identity-summary-list dd {
  margin: 0;
  min-width: 0;
  line-height: 1.65;
}

.identity-summary-list dt {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
}

.identity-summary-list dd {
  color: var(--fsusblog-text-secondary);
  font-size: 14px;
}

.identity-profile-form,
.identity-profile-field {
  display: grid;
}

.identity-profile-form {
  gap: 1rem;
}

.identity-profile-field {
  gap: 0.65rem;
}

.identity-profile-field__label {
  color: var(--fsusblog-text-secondary);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
}

.identity-profile-summary {
  margin-top: 0.15rem;
}

.identity-profile-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 0.1rem;
}

.identity-mfa-status-tag {
  justify-self: start;
  font-weight: 700;
}

.identity-policy-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  gap: 1px;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsusblog-panel-border);
  overflow: hidden;
}

.identity-policy-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  min-height: 3.7rem;
  background: var(--fsusblog-page-bg);
  padding: 0.95rem 1.1rem;
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.35;
}

.identity-policy-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.identity-policy-state {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex: 0 0 auto;
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.identity-policy-state__dot {
  box-sizing: border-box;
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.72;
}

.identity-policy-state--open {
  color: var(--fsusblog-color-primary);
}

.identity-policy-state--open .identity-policy-state__dot {
  opacity: 0.82;
}

.identity-policy-state--active {
  color: var(--fsusblog-text-secondary);
}

.identity-policy-state--active .identity-policy-state__dot {
  width: 0.55rem;
  height: 0.22rem;
  opacity: 0.86;
}

.identity-policy-state--closed {
  color: var(--fsusblog-color-error);
}

.identity-policy-state--muted {
  color: var(--fsusblog-text-muted);
}

.identity-policy-state--muted .identity-policy-state__dot {
  border: 1px solid currentColor;
  background: transparent;
  opacity: 0.8;
}

.identity-loading-state,
.identity-empty-state,
.identity-error-state {
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  padding: 0.9rem 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 14px;
  line-height: 1.65;
}

.identity-comment-records-state,
.identity-comment-records-list {
  margin-top: 1.5rem;
}

.identity-error-state {
  border-color: var(--fsusblog-color-error-border);
  background: var(--fsusblog-color-error-bg);
  color: var(--fsusblog-color-error);
  font-weight: 700;
}

.identity-secret-panel {
  display: grid;
  gap: 0.85rem;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsusblog-panel-bg-soft);
  padding: 1rem;
}

.identity-secret-panel code {
  overflow-wrap: anywhere;
  color: var(--fsusblog-text-primary);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.7;
}

.identity-touch-action {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  padding-inline: 0.75rem;
}

@media (max-width: 960px) {
  .identity-status-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .identity-status-grid,
  .identity-summary-list > div {
    grid-template-columns: minmax(0, 1fr);
  }

  .identity-summary-list > div {
    gap: 0.2rem;
  }
}
</style>
