export const localeDomainIdentity = Object.freeze({ locale: 'en-US', domain: 'identity' } as const)

import type { LocaleSchema } from '../keys';
import type { identity as zhCNIdentity } from '../zh-CN/identity';

export const identity = {
    overview: {
        passkeyLabel: 'Passkey',
        passkeyEnabled: 'Enabled',
        passkeyDisabled: 'Not added',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                one: '{count} login device',
                other: '{count} login devices'
            }
        },
        recoveryKeyLabel: 'Recovery Key',
        recoveryKeyReady: 'Generated',
        recoveryKeyRequired: 'Not created',
        recoveryKeyHint: 'Shown once after creation or rotation.',
        mfaLabel: 'TOTP MFA',
        mfaEnabled: 'Enabled',
        mfaDisabled: 'Disabled',
        mfaHint: 'Used for sensitive operations; not for account recovery.',
        anonymousLabel: 'Anonymous Comments',
        anonymousCardAvailable: 'Available',
        anonymousCardClosed: 'Closed',
        zkAvailable: 'Enhanced Anonymity Available',
        zkUnavailable: 'Enhanced Anonymity Closed',
        sectionTitle: 'Current Settings',
        sectionDescription: '',
        publicHandleLabel: 'Public Handle',
        publicHandleEmpty: 'No public handle set',
        anonymousPolicyLabel: 'Anonymous Comments',
        anonymousPolicyAllowed: 'Anonymous by default; public sending requires explicit selection.',
        anonymousPolicyClosed: 'Anonymous comments are closed on this site.',
        publicSendOptionLabel: 'Public Sending',
        publicSendOptionAllowed: 'Option to display public handle when commenting.',
        publicSendOptionClosed: 'Public sending is disabled on this site.',
        lifecycleTitle: 'Account Lifecycle',
        lifecycleDescription: 'Sensitive operation verification required before account deletion.',
        lifecycleWarning: 'Account deletion converts the account to deleted, removing public handle, sessions, passkeys, Recovery Key, anonymous credentials, and TOTP data. Published content will not be deleted automatically.',
        deleteAccountCta: 'Delete Account'
    },
    passkeys: {
        sectionTitle: 'Passkey Devices',
        sectionDescription: 'Passkey devices associated with this account.',
        loading: 'Loading passkeys',
        emptyTitle: 'No passkeys added',
        emptyContent: 'Register passkeys for device authentication.',
        addCta: 'Add Passkey',
        nameInputAriaLabel: 'Passkey device name',
        saveCta: 'Save',
        cancelCta: 'Cancel',
        editCta: 'Edit',
        deleteCta: 'Delete',
        nameEmpty: 'Unnamed Passkey',
        createdAtLabel: 'Created',
        activeAtLabel: 'Last active',
        activeNeverRecorded: 'Never recorded',
        backupModeLabel: 'Backup',
        backupEligible: 'Sync backup supported',
        backupIneligible: 'This device only',
        recoverySuggestion: 'Only one non-backed-up passkey is registered. Consider adding another passkey or creating a Recovery Key.'
    },
    recoveryKey: {
        sectionTitle: 'Recovery Key',
        sectionDescription: 'Account recovery credential; displayed once.',
        sectionHint: 'Save immediately upon creation or rotation; it will not be shown again. If lost without a working passkey, the account cannot be recovered.',
        loading: 'Processing',
        panelVersionPrefix: 'Recovery Key v',
        panelCreatedAtPrefix: 'Generated: ',
        savedCheckbox: 'I have saved my Recovery Key',
        closeOnceCta: 'Close',
        createCta: 'Create Recovery Key',
        rotateCta: 'Rotate Recovery Key'
    },
    mfa: {
        sectionTitle: 'TOTP MFA',
        sectionDescription: 'Sensitive operation verification; account recovery uses Recovery Key.',
        loading: 'Loading two-factor authentication status',
        enabled: 'TOTP Enabled',
        disabled: 'TOTP Disabled',
        lastVerifiedPrefix: 'Last verified',
        lastVerifiedEmpty: 'No recent verification recorded',
        enableCta: 'Enable TOTP MFA',
        disableCta: 'Disable TOTP MFA',
        disableConfirmTitle: 'Disable TOTP MFA',
        disableConfirmBody: 'After disabling, sensitive operations will no longer require TOTP verification.',
        disableConfirmCta: 'Confirm Disable',
        disabledSuccess: 'TOTP MFA disabled',
        setupChallengeRequired: 'TOTP MFA required. TOTP recovery codes are distinct from Recovery Key.',
        disableChallengeRequired: 'TOTP MFA required.',
        initFailedFallback: 'Failed to initialize TOTP MFA',
        verifyFailedFallback: 'TOTP verification failed',
        disableFailedFallback: 'Failed to disable TOTP MFA',
        enabledSuccess: 'TOTP MFA enabled',
        setupModalTitle: 'Bind TOTP MFA',
        loadFailedFallback: 'Failed to load MFA status'
    },
    anonymous: {
        sectionTitle: 'Anonymous Identity',
        sectionDescription: 'Anonymity capabilities, public sending, and enhanced anonymity status.',
        readOnlyBody: 'Anonymous posts do not reveal account identity.',
        publicChoiceBody: 'Public sending requires explicit choice on the post page.',
        governanceHeading: 'Exception Handling',
        zkStatusHeading: 'Enhanced Anonymity',
        cardEnabled: 'Available',
        cardDisabled: 'Closed',
        cardAvailable: 'Actionable',
        cardUnavailable: 'Closed',
        cardZkAvailable: 'Available',
        cardZkUnavailable: 'Closed',
        cardZkConfigVisible: 'Standard anonymous comments available.',
        cardZkConfigHidden: 'Closed on this site.',
        defaultModeHint: 'Choose whether to display public handle on post page.',
        governanceHint: 'Violating comments are handled per site policy.'
    },
    publicProfile: {
        sectionTitle: 'Public Profile',
        sectionDescription: 'Public handle is only used for public sending.',
        draftLabel: 'Public Handle',
        draftPlaceholder: 'Fill when sending public comments',
        optInCheckbox: 'Display only when sending publicly',
        summaryAriaLabel: 'Public profile status',
        publicSendOptionLabel: 'Public Sending Option',
        publicSendOptionAvailable: 'Available',
        publicSendOptionUnavailable: 'Unavailable',
        saveCta: 'Save Public Handle',
        savedSuccess: 'Public handle saved',
        clearedSuccess: 'Public handle cleared',
        saveFailedFallback: 'Failed to save public handle'
    },
    sessions: {
        sectionTitle: 'Device Sessions',
        sectionDescription: 'Active device sessions for this account.',
        loading: 'Loading device sessions',
        activeCount: {
            kind: 'plural',
            forms: {
                one: '{count} active session',
                other: '{count} active sessions'
            }
        },
        revokeOthersCta: 'Revoke Other Devices',
        currentDevice: 'Current device',
        otherDevice: 'Other device',
        activeAtPrefix: 'Active: ',
        activeAtLabel: 'Last active',
        createdAtLabel: 'Created at',
        loginMethodLabel: 'Authentication method',
        credentialLabel: 'Passkey',
        authenticationPasskey: 'Passkey',
        authenticationRecoveryKey: 'Recovery Key',
        authenticationEnrollment: 'Initial enrollment',
        authenticationOther: 'Other method',
        durationLabel: 'Session duration',
        durationPersistent: 'Keep logged in (30 days)',
        durationBrowserSession: 'Exit on browser close',
        sessionTypeLabel: 'Session',
        revokeCta: 'Revoke',
        emptyTitle: 'No active sessions',
        emptyContent: 'No device sessions.',
        revokeSuccess: 'Device session revoked',
        revokeOthersSuccess: 'Other device sessions revoked',
        deviceFallback: 'No device info recorded',
        loadFailedFallback: 'Failed to load device sessions'
    },
    commentRecords: {
        sectionTitle: 'Public Comment Records',
        sectionDescription: 'Account records only contain public posts.',
        loading: 'Loading public comment records.',
        emptyTitle: 'No public comment records',
        emptyDescription: 'Comments sent publicly will appear here; anonymous posts will not enter account records.',
        policyAriaLabel: 'Current comment policy',
        policyPublicSendLabel: 'Public Sending',
        policyAnonymousLabel: 'Anonymous Comments',
        policyZkLabel: 'Enhanced Anonymity',
        policyGovernanceLabel: 'Anonymous Comment Handling',
        policyOpen: 'Open',
        policyClosed: 'Closed',
        policyActive: 'Handled per rules',
        policyUnavailable: 'Closed'
    },
    placeholder: {
        cardTitle: 'Identity Settings',
        sections: {
            UserIdentityOverview: {
                title: 'Identity Overview',
                description: '',
                caption: 'Security status and public identity settings.',
                body: 'Passkeys, Recovery Key, TOTP, public handle, and comment policies.',
                items: '["Passkey status", "Recovery Key status", "Anonymous identity & public profile", "Session summary"]'
            },
            UserIdentityPasskeys: {
                title: 'Passkeys',
                description: 'Login devices.',
                caption: 'Passkey devices associated with this account.',
                body: 'Registered devices, device renaming, and removal.',
                items: '["Registered devices", "Device rename", "Last Passkey deletion protection"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Recovery Key',
                description: 'Account recovery credential.',
                caption: 'Independent of TOTP recovery codes.',
                body: 'Displayed once upon creation or rotation.',
                items: '["Create Recovery Key", "Rotate recovery credential", "Recover session to bind new Passkey"]'
            },
            UserIdentityAnonymous: {
                title: 'Anonymous Identity',
                description: 'Anonymous comments, public posts, site rules.',
                caption: 'Real account identity is hidden.',
                body: 'Anonymous identity status shown according to site policy.',
                items: '["Default anonymous mode", "Display name language", "Credential status & reputation group"]'
            },
            UserIdentityPublicProfile: {
                title: 'Public Profile',
                description: 'Public identity information.',
                caption: 'Displayed only when sending publicly.',
                body: 'Public handle, display notes, and confirmation before sending.',
                items: '["Public handle", "Public send confirmation", "Comment author preview"]'
            },
            UserIdentitySessions: {
                title: 'Device Sessions',
                description: 'Active device sessions.',
                caption: 'Login devices for current account.',
                body: 'Current device, other active sessions, and revoking devices.',
                items: '["Current device", "Other active sessions", "Revoke other devices"]'
            },
            UserIdentityMfa: {
                title: 'Two-Factor Authentication',
                description: 'TOTP status.',
                caption: 'Sensitive operation verification; not for account recovery.',
                body: 'Enabling/disabling MFA, generating TOTP recovery codes.',
                items: '["Enable MFA", "Disable MFA", "Regenerate TOTP recovery codes"]'
            }
        }
    },
    profile: {
        pageTitle: 'Identity Center',
        pageDescription: 'Account security, recovery credentials, public profile, anonymous comments.',
        emptyTitle: 'Go to Identity Center',
        emptyContent: 'Passkeys, Recovery Key, TOTP, device sessions, public handle, anonymous comments.',
        openIdentityCta: 'Open Identity Center'
    },
    confirm: {
        deletePasskeyTitle: 'Delete Passkey',
        deletePasskeyBody: 'After deletion, this device cannot be used to log in with this passkey.',
        rotateRecoveryKeyTitle: 'Rotate Recovery Key',
        rotateRecoveryKeyBody: 'After rotation, the old Recovery Key will become invalid.',
        deleteAccountTitle: 'Delete Account',
        deleteAccountBody: 'Account deletion converts the account to deleted, removing public handle, sessions, passkeys, Recovery Key, anonymous credentials, and TOTP data. Published content will not be deleted automatically.',
        confirmButton: 'Confirm',
        cancelButton: 'Cancel'
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
        recoveryKeySensitiveOperationRequired: 'No sensitive operation verification available for this account. Add a passkey or enable TOTP first.',
        passkeySensitiveOperationRequired: 'No sensitive operation verification available for this account. Add a passkey or enable TOTP first.',
        accountDeleteSensitiveOperationRequired: 'No sensitive operation verification available for this account. Add a passkey or enable TOTP first.',
        renameFailedFallback: 'Failed to rename passkey',
        deleteFailedFallback: 'Failed to delete passkey',
        recoveryKeyFailedFallback: 'Recovery Key operation failed',
        accountDeleteFailedFallback: 'Account deletion failed',
        accountDeletedSuccess: 'Account deleted',
        recoveryKeyCreatedSuccess: 'Recovery Key created',
        recoveryKeyRotatedSuccess: 'Recovery Key rotated'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>;
