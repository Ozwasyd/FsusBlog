<template>
  <div class="account-page identity-center">
    <header class="identity-section-header">
      <div class="identity-section-header__copy">
        <h1>{{ sectionMeta.title }}</h1>
        <p>{{ sectionMeta.description }}</p>
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
        :description="copy.sectionDescription"
        :title-tag="'h2'"
      >
        <div class="identity-summary-list">
          <p>{{ accountIdText }}</p>
          <p>{{ publicHandleText }}</p>
          <p>{{ anonymousPolicyText }}</p>
          <p>{{ publicSendOptionText }}</p>
        </div>
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

      <ProfileResourceList v-else-if="passkeyCredentials.length">
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
        v-else
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

      <div v-else class="identity-empty-state">
        {{ recoveryKeyCopy.emptyState }}
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
        <span>{{ mfaProfile?.enabled ? mfaCopy.enabled : mfaCopy.disabled }}</span>
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
        <p v-else class="m-0 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">
          {{ mfaCopy.enabledHint }}
        </p>
      </div>
    </FsusUiSettingsSection>

    <FsusUiSettingsSection
      v-else-if="isSection('UserIdentityAnonymous')"
      :title="anonymousCopy.sectionTitle"
      :description="anonymousCopy.sectionDescription"
      :title-tag="'h2'"
    >
      <div class="identity-status-grid">
        <div class="identity-status-card">
          <span class="identity-status-label">{{ anonymousCopy.sectionTitle }}</span>
          <strong>{{ workspaceFeatures.anonymousCommentsEnabled ? anonymousCopy.cardEnabled : anonymousCopy.cardDisabled }}</strong>
          <p>{{ anonymousCopy.defaultModeHint }}</p>
        </div>
        <div class="identity-status-card">
          <span class="identity-status-label">{{ anonymousCopy.governanceHeading }}</span>
          <strong>{{ workspacePolicies.anonymousCommentGovernanceAvailable ? anonymousCopy.cardAvailable : anonymousCopy.cardUnavailable }}</strong>
          <p>{{ anonymousCopy.governanceHint }}</p>
        </div>
        <div class="identity-status-card">
          <span class="identity-status-label">{{ anonymousCopy.zkStatusHeading }}</span>
          <strong>{{ workspaceFeatures.zkAnonymousEnabled ? anonymousCopy.cardZkAvailable : anonymousCopy.cardZkUnavailable }}</strong>
          <p>{{ workspacePolicies.zkAnonymousConfigurable ? anonymousCopy.cardZkConfigVisible : anonymousCopy.cardZkConfigHidden }}</p>
        </div>
      </div>
    </FsusUiSettingsSection>

    <FsusUiSettingsSection
      v-else-if="isSection('UserIdentityPublicProfile')"
      :title="publicProfileCopy.sectionTitle"
      :description="publicProfileCopy.sectionDescription"
      :title-tag="'h2'"
    >
      <div class="space-y-5">
        <label for="public-handle-draft" class="block text-[12px] font-bold text-[var(--fsusblog-text-secondary)]">
          {{ publicProfileCopy.draftLabel }}
        </label>
        <el-input
          id="public-handle-draft"
          v-model="publicHandleDraft"
          maxlength="20"
          autocomplete="off"
          :placeholder="publicProfileCopy.draftPlaceholder"
        />
        <div v-if="publicHandleError" class="identity-error-state" role="alert">{{ publicHandleError }}</div>
        <el-checkbox v-model="explicitPublicSendOptIn">
          {{ publicProfileCopy.optInCheckbox }}
        </el-checkbox>
        <div class="identity-state-row">
          <span>{{ publicProfileCopy.publicSendOptionPrefix }}{{ workspaceFeatures.publicSendOptionEnabled ? publicProfileCopy.publicSendOptionAvailable : publicProfileCopy.publicSendOptionUnavailable }}</span>
          <span>{{ publicProfileCopy.currentDraftPrefix }}{{ publicHandleDraft.trim() || publicProfileCopy.currentDraftEmpty }}</span>
        </div>
        <div class="flex flex-wrap gap-3">
          <el-button type="primary" :loading="publicHandleSaving" @click="savePublicHandle">{{ publicProfileCopy.saveCta }}</el-button>
          <el-button :disabled="publicHandleSaving" @click="clearPublicHandle">{{ publicProfileCopy.clearCta }}</el-button>
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
              <p class="truncate text-[14px] font-bold text-[var(--fsusblog-text-primary)]">
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
      <div class="identity-copy-block">
        <p>{{ commentRecordsCopy.boundary }}</p>
        <p>{{ commentRecordsCopy.governance }}</p>
      </div>
      <router-link class="identity-inline-link" to="/user/comments">
        {{ commentRecordsCopy.viewLink }}
      </router-link>
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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { FsusUiSettingsSection } from '@/fsusui'
import MfaSetupModal from '@/components/ui/MfaSetupModal.vue'
import PasskeyRegisterModal from '@/components/ui/PasskeyRegisterModal.vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import {
  ProfileInlineEmptyState,
  ProfileResourceList,
  ProfileResourceListItem
} from '@/components/user/ProfileSettingsPrimitives'
import {
  createRecoveryKey,
  deleteAccount,
  getMfaProfile,
  listSessions,
  revokeOtherSessions as revokeOtherSessionsApi,
  revokeSession,
  rotateRecoveryKey,
  startMfaChallenge,
  startMfaSetup,
  updatePublicHandle,
  verifyMfaSetup,
  type MfaChallengeResult,
  type MfaProfile,
  type MfaSetupStart,
  type MfaSetupVerify,
  type PasskeyCredentialSummary,
  type UserSessionSummary
} from '@/api/auth'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext'
import { useUserStore } from '@/store/user'
import { confirmDanger, toast } from '@/fsusui/feedback'
import { toAppError } from '@/utils/appError'
import { FSUSBLOG_IDENTITY_COPY } from '@/copy'

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

const workspaceFeatures = computed(() => workspaceContext.value.features)
const workspacePolicies = computed(() => workspaceContext.value.policies)
const currentSession = computed(() => sessions.value.find((session) => session.isCurrent) ?? null)
const otherSessions = computed(() => sessions.value.filter((session) => !session.isCurrent))

const passkeyDeviceCountText = computed(() =>
  copy.passkeyDeviceCount.replace('{n}', String(passkeyCredentials.value.length))
)

const accountIdText = computed(() =>
  copy.accountIdRow.replace('{value}', identityAccountSnapshot.value.accountId ? String(identityAccountSnapshot.value.accountId) : copy.accountIdEmpty)
)

const publicHandleText = computed(() =>
  copy.publicHandleRow.replace('{value}', identityAccountSnapshot.value.publicHandle || copy.publicHandleEmpty)
)

const anonymousPolicyText = computed(() =>
  copy.anonymousPolicyRow.replace(
    '{value}',
    identityAccountSnapshot.value.anonymousPolicyEnabled ? copy.anonymousPolicyAllowed : copy.anonymousPolicyClosed
  )
)

const publicSendOptionText = computed(() =>
  copy.publicSendOptionRow.replace(
    '{value}',
    identityAccountSnapshot.value.publicSendOptionEnabled ? copy.publicSendOptionAllowed : copy.publicSendOptionClosed
  )
)

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
    recoveryEnabled: recoveryKeyKnown.value || recoveryKeyPlaintext.value.length > 0,
    totpStepUpEnabled: mfaProfile.value?.enabled === true,
    anonymousPolicyEnabled: features.anonymousCommentsEnabled && policies.anonymousCommentGovernanceAvailable,
    anonymousCardStatus: features.anonymousCommentsEnabled ? copy.anonymousCardAvailable : copy.anonymousCardClosed,
    zkAnonymousAvailable: features.zkAnonymousEnabled,
    publicSendOptionEnabled: features.publicSendOptionEnabled
  }
})

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
    mfaSetupError.value = toAppError(error, mfaCopy.initFailedFallback).message || mfaCopy.initFailedFallback
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
    const proof = await startMfaChallenge('passkey.credential-name.update') as MfaChallengeResult
    if (!proof.verified || !proof.proofToken) {
      passkeyError.value = errorCopy.passkeySensitiveOperationRequired
      return
    }

    const renamed = await renamePasskeyCredential(id, passkeyEditName.value.trim(), proof.proofToken)
    if (renamed) {
      passkeyEditingId.value = null
    }
  } catch (error) {
    passkeyError.value = toAppError(error, errorCopy.renameFailedFallback).message || errorCopy.renameFailedFallback
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
    const proof = await startMfaChallenge('passkey.delete') as MfaChallengeResult
    if (!proof.verified || !proof.proofToken) {
      passkeyError.value = errorCopy.passkeySensitiveOperationRequired
      return
    }

    await removePasskey(id, proof.proofToken)
  } catch (error) {
    passkeyError.value = toAppError(error, errorCopy.deleteFailedFallback).message || errorCopy.deleteFailedFallback
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
    const proof = mode === 'create'
      ? await startMfaChallenge('recovery-key.create') as MfaChallengeResult
      : await startMfaChallenge('recovery-key.rotate') as MfaChallengeResult
    if (!proof.verified || !proof.proofToken) {
      recoveryKeyError.value = errorCopy.recoveryKeySensitiveOperationRequired
      return
    }

    const proofToken = proof.proofToken
    const response = mode === 'create'
      ? await createRecoveryKey({ mfaProofToken: proofToken })
      : await rotateRecoveryKey({ mfaProofToken: proofToken })
    setRecoveryKeyResponse(response)
    toast.success(mode === 'create' ? errorCopy.recoveryKeyCreatedSuccess : errorCopy.recoveryKeyRotatedSuccess)
  } catch (error) {
    recoveryKeyError.value = toAppError(error, errorCopy.recoveryKeyFailedFallback).message || errorCopy.recoveryKeyFailedFallback
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

const clearPublicHandle = async (): Promise<void> => {
  publicHandleDraft.value = ''
  await savePublicHandle()
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
    const proof = await startMfaChallenge('account.delete') as MfaChallengeResult
    if (!proof.verified || !proof.proofToken) {
      deleteAccountError.value = errorCopy.accountDeleteSensitiveOperationRequired
      return
    }

    await deleteAccount({
      confirmText: 'DELETE',
      mfaProofToken: proof.proofToken
    })
    toast.success(errorCopy.accountDeletedSuccess)
    await userStore.logout()
  } catch (error) {
    deleteAccountError.value = toAppError(error, errorCopy.accountDeleteFailedFallback).message || errorCopy.accountDeleteFailedFallback
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
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.45;
  letter-spacing: 0;
}

.identity-section-header__copy p {
  max-width: 42rem;
  margin: 0.25rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.875rem;
  line-height: 1.6;
}

.identity-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
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
  font-size: 0.95rem;
}

.identity-status-card p,
.identity-summary-list p,
.identity-copy-block p {
  margin: 0.35rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.78rem;
  line-height: 1.65;
}

.identity-status-label {
  display: block;
  color: var(--fsusblog-text-muted);
  font-size: 0.68rem;
  font-weight: 700;
}

.identity-summary-list,
.identity-state-row {
  display: grid;
  gap: 0.65rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.85rem;
}

.identity-loading-state,
.identity-empty-state,
.identity-error-state {
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  padding: 0.9rem 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.82rem;
  line-height: 1.65;
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
  font-size: 0.88rem;
  line-height: 1.7;
}

.identity-inline-link {
  display: inline-flex;
  margin-top: 1rem;
  color: var(--fsusblog-color-primary);
  font-size: 0.85rem;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 0.25rem;
}

.identity-touch-action {
  min-width: 44px;
  min-height: 36px;
  justify-content: center;
  padding-inline: 0.75rem;
}
</style>
