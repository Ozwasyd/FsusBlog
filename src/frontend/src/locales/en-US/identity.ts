import type { DeepStringShape } from '../keys';
import type { identity as zhCNIdentity } from '../zh-CN/identity';

export const identity = {
    overview: {
        passkeyLabel: 'Passkey',
        passkeyEnabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.passkeyEnabled',
        passkeyDisabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.passkeyDisabled',
        passkeyDeviceCount: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.passkeyDeviceCount',
        recoveryKeyLabel: 'Recovery Key',
        recoveryKeyReady: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.recoveryKeyReady',
        recoveryKeyRequired: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.recoveryKeyRequired',
        recoveryKeyHint: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.recoveryKeyHint',
        mfaLabel: 'TOTP MFA',
        mfaEnabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.mfaEnabled',
        mfaDisabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.mfaDisabled',
        mfaHint: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.mfaHint',
        anonymousLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.anonymousLabel',
        anonymousCardAvailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.anonymousCardAvailable',
        anonymousCardClosed: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.anonymousCardClosed',
        zkAvailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.zkAvailable',
        zkUnavailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.zkUnavailable',
        sectionTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.sectionTitle',
        sectionDescription: '',
        publicHandleLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.publicHandleLabel',
        publicHandleEmpty: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.publicHandleEmpty',
        anonymousPolicyLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.anonymousPolicyLabel',
        anonymousPolicyAllowed: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.anonymousPolicyAllowed',
        anonymousPolicyClosed: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.anonymousPolicyClosed',
        publicSendOptionLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.publicSendOptionLabel',
        publicSendOptionAllowed: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.publicSendOptionAllowed',
        publicSendOptionClosed: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.publicSendOptionClosed',
        lifecycleTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.lifecycleTitle',
        lifecycleDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.lifecycleDescription',
        lifecycleWarning: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.lifecycleWarning',
        deleteAccountCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.deleteAccountCta'
    },
    passkeys: {
        sectionTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.sectionTitle',
        sectionDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.sectionDescription',
        loading: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.loading',
        emptyTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.emptyTitle',
        emptyContent: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.emptyContent',
        addCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.addCta',
        nameInputAriaLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.nameInputAriaLabel',
        saveCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.saveCta',
        cancelCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.cancelCta',
        editCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.editCta',
        deleteCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.deleteCta',
        nameEmpty: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.nameEmpty',
        createdAtLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.createdAtLabel',
        activeAtLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.activeAtLabel',
        activeNeverRecorded: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.activeNeverRecorded',
        backupModeLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.backupModeLabel',
        backupEligible: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.backupEligible',
        backupIneligible: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.backupIneligible',
        recoverySuggestion: '__FSUSBLOG_TRANSLATION_PENDING__:identity.passkeys.recoverySuggestion'
    },
    recoveryKey: {
        sectionTitle: 'Recovery Key',
        sectionDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.sectionDescription',
        sectionHint: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.sectionHint',
        loading: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.loading',
        panelVersionPrefix: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.panelVersionPrefix',
        panelCreatedAtPrefix: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.panelCreatedAtPrefix',
        savedCheckbox: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.savedCheckbox',
        closeOnceCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.closeOnceCta',
        createCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.createCta',
        rotateCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.recoveryKey.rotateCta'
    },
    mfa: {
        sectionTitle: 'TOTP MFA',
        sectionDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.sectionDescription',
        loading: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.loading',
        enabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.enabled',
        disabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disabled',
        lastVerifiedPrefix: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.lastVerifiedPrefix',
        lastVerifiedEmpty: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.lastVerifiedEmpty',
        enableCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.enableCta',
        disableCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disableCta',
        disableConfirmTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disableConfirmTitle',
        disableConfirmBody: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disableConfirmBody',
        disableConfirmCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disableConfirmCta',
        disabledSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disabledSuccess',
        setupChallengeRequired: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.setupChallengeRequired',
        disableChallengeRequired: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disableChallengeRequired',
        initFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.initFailedFallback',
        verifyFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.verifyFailedFallback',
        disableFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.disableFailedFallback',
        enabledSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.enabledSuccess',
        setupModalTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.setupModalTitle',
        loadFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.mfa.loadFailedFallback'
    },
    anonymous: {
        sectionTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.sectionTitle',
        sectionDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.sectionDescription',
        readOnlyBody: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.readOnlyBody',
        publicChoiceBody: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.publicChoiceBody',
        governanceHeading: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.governanceHeading',
        zkStatusHeading: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.zkStatusHeading',
        cardEnabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardEnabled',
        cardDisabled: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardDisabled',
        cardAvailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardAvailable',
        cardUnavailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardUnavailable',
        cardZkAvailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardZkAvailable',
        cardZkUnavailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardZkUnavailable',
        cardZkConfigVisible: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardZkConfigVisible',
        cardZkConfigHidden: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.cardZkConfigHidden',
        defaultModeHint: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.defaultModeHint',
        governanceHint: '__FSUSBLOG_TRANSLATION_PENDING__:identity.anonymous.governanceHint'
    },
    publicProfile: {
        sectionTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.sectionTitle',
        sectionDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.sectionDescription',
        draftLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.draftLabel',
        draftPlaceholder: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.draftPlaceholder',
        optInCheckbox: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.optInCheckbox',
        summaryAriaLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.summaryAriaLabel',
        publicSendOptionLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.publicSendOptionLabel',
        publicSendOptionAvailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.publicSendOptionAvailable',
        publicSendOptionUnavailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.publicSendOptionUnavailable',
        saveCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.saveCta',
        savedSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.savedSuccess',
        clearedSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.clearedSuccess',
        saveFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.publicProfile.saveFailedFallback'
    },
    sessions: {
        sectionTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.sectionTitle',
        sectionDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.sectionDescription',
        loading: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.loading',
        activeCountPrefix: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.activeCountPrefix',
        revokeOthersCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.revokeOthersCta',
        currentDevice: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.currentDevice',
        otherDevice: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.otherDevice',
        activeAtPrefix: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.activeAtPrefix',
        activeAtLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.activeAtLabel',
        createdAtLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.createdAtLabel',
        loginMethodLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.loginMethodLabel',
        credentialLabel: 'Passkey',
        authenticationPasskey: 'Passkey',
        authenticationRecoveryKey: 'Recovery Key',
        authenticationEnrollment: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.authenticationEnrollment',
        authenticationOther: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.authenticationOther',
        durationLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.durationLabel',
        durationPersistent: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.durationPersistent',
        durationBrowserSession: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.durationBrowserSession',
        sessionTypeLabel: 'Session',
        revokeCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.revokeCta',
        emptyTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.emptyTitle',
        emptyContent: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.emptyContent',
        revokeSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.revokeSuccess',
        revokeOthersSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.revokeOthersSuccess',
        deviceFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.deviceFallback',
        loadFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.sessions.loadFailedFallback'
    },
    commentRecords: {
        sectionTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.sectionTitle',
        sectionDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.sectionDescription',
        loading: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.loading',
        emptyTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.emptyTitle',
        emptyDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.emptyDescription',
        policyAriaLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyAriaLabel',
        policyPublicSendLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyPublicSendLabel',
        policyAnonymousLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyAnonymousLabel',
        policyZkLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyZkLabel',
        policyGovernanceLabel: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyGovernanceLabel',
        policyOpen: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyOpen',
        policyClosed: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyClosed',
        policyActive: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyActive',
        policyUnavailable: '__FSUSBLOG_TRANSLATION_PENDING__:identity.commentRecords.policyUnavailable'
    },
    placeholder: {
        cardTitle: 'Identity Settings',
        sections: {
            UserIdentityOverview: {
                title: 'Identity Overview',
                description: '',
                caption: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityOverview.caption',
                body: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityOverview.body',
                items: '["Passkey status", "Recovery Key status", "Anonymous identity & public profile", "Session summary"]'
            },
            UserIdentityPasskeys: {
                title: 'Passkeys',
                description: 'Login devices.',
                caption: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityPasskeys.caption',
                body: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityPasskeys.body',
                items: '["Registered devices", "Device rename", "Last Passkey deletion protection"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Recovery Key',
                description: 'Account recovery credential.',
                caption: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityRecoveryKey.caption',
                body: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityRecoveryKey.body',
                items: '["Create Recovery Key", "Rotate recovery credential", "Recover session to bind new Passkey"]'
            },
            UserIdentityAnonymous: {
                title: 'Anonymous Identity',
                description: 'Anonymous comments, public posts, site rules.',
                caption: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityAnonymous.caption',
                body: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityAnonymous.body',
                items: '["Default anonymous mode", "Display name language", "Credential status & reputation group"]'
            },
            UserIdentityPublicProfile: {
                title: 'Public Profile',
                description: 'Public identity information.',
                caption: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityPublicProfile.caption',
                body: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityPublicProfile.body',
                items: '["Public handle", "Public send confirmation", "Comment author preview"]'
            },
            UserIdentitySessions: {
                title: 'Device Sessions',
                description: 'Active device sessions.',
                caption: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentitySessions.caption',
                body: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentitySessions.body',
                items: '["Current device", "Other active sessions", "Revoke other devices"]'
            },
            UserIdentityMfa: {
                title: 'Two-Factor Authentication',
                description: 'TOTP status.',
                caption: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityMfa.caption',
                body: '__FSUSBLOG_TRANSLATION_PENDING__:identity.placeholder.sections.UserIdentityMfa.body',
                items: '["Enable MFA", "Disable MFA", "Regenerate TOTP recovery codes"]'
            }
        }
    },
    profile: {
        pageTitle: 'Identity Center',
        pageDescription: '__FSUSBLOG_TRANSLATION_PENDING__:identity.profile.pageDescription',
        emptyTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.profile.emptyTitle',
        emptyContent: '__FSUSBLOG_TRANSLATION_PENDING__:identity.profile.emptyContent',
        openIdentityCta: '__FSUSBLOG_TRANSLATION_PENDING__:identity.profile.openIdentityCta'
    },
    confirm: {
        deletePasskeyTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.confirm.deletePasskeyTitle',
        deletePasskeyBody: '__FSUSBLOG_TRANSLATION_PENDING__:identity.confirm.deletePasskeyBody',
        rotateRecoveryKeyTitle: 'Rotate Recovery Key',
        rotateRecoveryKeyBody: '__FSUSBLOG_TRANSLATION_PENDING__:identity.confirm.rotateRecoveryKeyBody',
        deleteAccountTitle: '__FSUSBLOG_TRANSLATION_PENDING__:identity.confirm.deleteAccountTitle',
        deleteAccountBody: '__FSUSBLOG_TRANSLATION_PENDING__:identity.confirm.deleteAccountBody',
        confirmButton: '__FSUSBLOG_TRANSLATION_PENDING__:identity.confirm.confirmButton',
        cancelButton: '__FSUSBLOG_TRANSLATION_PENDING__:identity.confirm.cancelButton'
    },
    meta: {
        UserIdentityOverview: {
            title: 'Identity Overview',
            description: ''
        },
        UserIdentityPasskeys: {
            title: 'Passkeys',
            description: 'Login devices.'
        },
        UserIdentityRecoveryKey: {
            title: 'Recovery Key',
            description: 'Account recovery credential.'
        },
        UserIdentityAnonymous: {
            title: 'Anonymous Identity',
            description: 'Anonymous comments, public posts, site rules.'
        },
        UserIdentityPublicProfile: {
            title: 'Public Profile',
            description: 'Public identity information.'
        },
        UserIdentitySessions: {
            title: 'Device Sessions',
            description: 'Active device sessions.'
        },
        UserIdentityMfa: {
            title: 'Two-Factor Authentication',
            description: 'TOTP status.'
        },
        UserIdentityCommentRecords: {
            title: 'Public Comment Records',
            description: 'Account records only contain public posts.'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.recoveryKeySensitiveOperationRequired',
        passkeySensitiveOperationRequired: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.passkeySensitiveOperationRequired',
        accountDeleteSensitiveOperationRequired: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.accountDeleteSensitiveOperationRequired',
        renameFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.renameFailedFallback',
        deleteFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.deleteFailedFallback',
        recoveryKeyFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.recoveryKeyFailedFallback',
        accountDeleteFailedFallback: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.accountDeleteFailedFallback',
        accountDeletedSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.accountDeletedSuccess',
        recoveryKeyCreatedSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.recoveryKeyCreatedSuccess',
        recoveryKeyRotatedSuccess: '__FSUSBLOG_TRANSLATION_PENDING__:identity.errors.recoveryKeyRotatedSuccess'
    }
} as const satisfies DeepStringShape<typeof zhCNIdentity>;
