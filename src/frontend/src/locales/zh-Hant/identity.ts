export const localeDomainIdentity = Object.freeze({ locale: 'zh-Hant', domain: 'identity' } as const)

import type { LocaleSchema } from '../keys'
import type { identity as zhCNIdentity } from '../zh-CN/identity'

export const identity = {
    overview: {
        passkeyLabel: 'Passkey',
        passkeyEnabled: '已啟用',
        passkeyDisabled: '未新增',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                other: '{count} 個裝置可登入'
            }
        },
        recoveryKeyLabel: 'Recovery Key',
        recoveryKeyReady: '本次已產生',
        recoveryKeyRequired: '未建立',
        recoveryKeyHint: '建立或輪換後只顯示一次。',
        mfaLabel: 'TOTP 二次驗證',
        mfaEnabled: '已啟用',
        mfaDisabled: '未啟用',
        mfaHint: '敏感操作驗證；不用於帳號恢復。',
        anonymousLabel: '匿名評論',
        anonymousCardAvailable: '可用',
        anonymousCardClosed: '已關閉',
        zkAvailable: '增強匿名可用',
        zkUnavailable: '增強匿名未開放',
        sectionTitle: '目前設定',
        sectionDescription: '',
        publicHandleLabel: '公開稱呼',
        publicHandleEmpty: '未設定公開稱呼',
        anonymousPolicyLabel: '匿名評論',
        anonymousPolicyAllowed: '預設匿名；公開發送需主動選擇。',
        anonymousPolicyClosed: '目前站點未開放匿名評論。',
        publicSendOptionLabel: '公開發送',
        publicSendOptionAllowed: '發佈評論時可選擇公開稱呼。',
        publicSendOptionClosed: '目前站點不可公開發送。',
        lifecycleTitle: '帳號生命週期',
        lifecycleDescription: '註銷帳戶前需要完成敏感操作校驗。',
        lifecycleWarning: '註銷會把帳號轉為已註銷，移除公開稱呼、工作階段、通行金鑰、Recovery Key、匿名憑據和 TOTP 資料；已發佈內容不會自動刪除。',
        deleteAccountCta: '註銷帳戶'
    },
    passkeys: {
        sectionTitle: '通行金鑰裝置',
        sectionDescription: '目前帳號的通行金鑰裝置。',
        loading: '通行金鑰載入中',
        emptyTitle: '尚未新增通行金鑰',
        emptyContent: '登記後用於裝置認證。',
        addCta: '新增通行金鑰',
        nameInputAriaLabel: '通行金鑰名稱',
        saveCta: '儲存',
        cancelCta: '取消',
        editCta: '編輯',
        deleteCta: '刪除',
        nameEmpty: '未命名通行金鑰',
        createdAtLabel: '建立',
        activeAtLabel: '活躍',
        activeNeverRecorded: '未記錄',
        backupModeLabel: '備份',
        backupEligible: '支援同步備份',
        backupIneligible: '僅本裝置',
        recoverySuggestion: '目前僅有一枚無法備份的通行金鑰。建議再新增一枚通行金鑰，或建立 Recovery Key。'
    },
    recoveryKey: {
        sectionTitle: 'Recovery Key',
        sectionDescription: '帳號恢復憑據；一次性顯示。',
        sectionHint: '建立或輪換後立即儲存；之後不會再次顯示。遺失且無可用通行金鑰時，帳號可能無法恢復。',
        loading: '處理中',
        panelVersionPrefix: 'Recovery Key v',
        panelCreatedAtPrefix: '產生：',
        savedCheckbox: '我已儲存 Recovery Key',
        closeOnceCta: '關閉',
        createCta: '建立 Recovery Key',
        rotateCta: '輪換 Recovery Key'
    },
    mfa: {
        sectionTitle: 'TOTP 二次驗證',
        sectionDescription: '敏感操作驗證；帳號恢復使用 Recovery Key。',
        loading: '二次驗證狀態載入中',
        enabled: 'TOTP 已啟用',
        disabled: 'TOTP 未啟用',
        lastVerifiedPrefix: '最近驗證',
        lastVerifiedEmpty: '未記錄最近驗證時間',
        enableCta: '啟用 TOTP 二次驗證',
        disableCta: '關閉 TOTP 二次驗證',
        disableConfirmTitle: '關閉 TOTP 二次驗證',
        disableConfirmBody: '關閉後，敏感操作將不再使用 TOTP 驗證。',
        disableConfirmCta: '確認關閉',
        disabledSuccess: 'TOTP 二次驗證已關閉',
        setupChallengeRequired: '需要先完成 TOTP 二次驗證。TOTP 恢復碼與 Recovery Key 不同。',
        disableChallengeRequired: '需要先完成 TOTP 二次驗證。',
        initFailedFallback: 'TOTP 二次驗證初始化失敗',
        verifyFailedFallback: 'TOTP 二次驗證失敗',
        disableFailedFallback: 'TOTP 二次驗證關閉失敗',
        enabledSuccess: 'TOTP 二次驗證已啟用',
        setupModalTitle: 'TOTP 二次驗證綁定',
        loadFailedFallback: '二次驗證狀態載入失敗'
    },
    anonymous: {
        sectionTitle: '匿名身份',
        sectionDescription: '匿名能力、公開發送和增強匿名狀態。',
        readOnlyBody: '匿名發送不展示帳號身份。',
        publicChoiceBody: '公開發送需在評論發佈頁主動選擇。',
        governanceHeading: '異常處理',
        zkStatusHeading: '增強匿名',
        cardEnabled: '可用',
        cardDisabled: '已關閉',
        cardAvailable: '可處理',
        cardUnavailable: '未開放',
        cardZkAvailable: '可用',
        cardZkUnavailable: '未開放',
        cardZkConfigVisible: '一般匿名評論可用。',
        cardZkConfigHidden: '目前站點未開放。',
        defaultModeHint: '發佈頁選擇是否公開稱呼。',
        governanceHint: '違規評論按站點規則處理。'
    },
    publicProfile: {
        sectionTitle: '公開資料',
        sectionDescription: '公開稱呼僅用於公開發送。',
        draftLabel: '公開稱呼',
        draftPlaceholder: '公開發送評論時可填寫',
        optInCheckbox: '僅公開發送時展示',
        summaryAriaLabel: '公開資料狀態',
        publicSendOptionLabel: '公開發送選項',
        publicSendOptionAvailable: '可用',
        publicSendOptionUnavailable: '不可用',
        saveCta: '儲存公開稱呼',
        savedSuccess: '公開稱呼已儲存',
        clearedSuccess: '公開稱呼已移除',
        saveFailedFallback: '公開稱呼儲存失敗'
    },
    sessions: {
        sectionTitle: '裝置工作階段',
        sectionDescription: '目前帳號的活躍裝置工作階段。',
        loading: '裝置工作階段載入中',
        activeCount: {
            kind: 'plural',
            forms: {
                other: '{count} 個活躍工作階段'
            }
        },
        revokeOthersCta: '下線其他裝置',
        currentDevice: '目前裝置',
        otherDevice: '其他裝置',
        activeAtPrefix: '活躍：',
        activeAtLabel: '最近活躍',
        createdAtLabel: '建立時間',
        loginMethodLabel: '登入方式',
        credentialLabel: '通行金鑰',
        authenticationPasskey: '通行金鑰',
        authenticationRecoveryKey: '恢復金鑰',
        authenticationEnrollment: '首次綁定',
        authenticationOther: '其他方式',
        durationLabel: '登入持續時間',
        durationPersistent: '保持登入（30 天）',
        durationBrowserSession: '關閉瀏覽器後退出',
        sessionTypeLabel: '工作階段',
        revokeCta: '下線',
        emptyTitle: '暫無活躍工作階段',
        emptyContent: '無裝置工作階段。',
        revokeSuccess: '裝置工作階段已下線',
        revokeOthersSuccess: '其他裝置已下線',
        deviceFallback: '未記錄裝置資訊',
        loadFailedFallback: '裝置工作階段載入失敗'
    },
    commentRecords: {
        sectionTitle: '公開評論記錄',
        sectionDescription: '帳號記錄只包含公開發送。',
        loading: '正在載入公開評論記錄。',
        emptyTitle: '暫無公開評論記錄',
        emptyDescription: '公開發送的評論會顯示在這裡；匿名發送不會進入帳號記錄。',
        policyAriaLabel: '目前評論策略',
        policyPublicSendLabel: '公開發送',
        policyAnonymousLabel: '匿名評論',
        policyZkLabel: '增強匿名',
        policyGovernanceLabel: '匿名評論處理',
        policyOpen: '已開放',
        policyClosed: '已關閉',
        policyActive: '按規則處理',
        policyUnavailable: '未開放'
    },
    placeholder: {
        cardTitle: '身份設定',
        sections: {
            UserIdentityOverview: {
                title: '身份總覽',
                description: '',
                caption: '安全狀態與公開身份設定。',
                body: '通行金鑰、Recovery Key、TOTP、公開稱呼和評論策略。',
                items: '["通行金鑰狀態", "Recovery Key 狀態", "匿名身份與公開資料", "裝置工作階段摘要"]'
            },
            UserIdentityPasskeys: {
                title: '通行金鑰',
                description: '登入裝置。',
                caption: '目前帳號的通行金鑰裝置。',
                body: '已登記裝置、名稱更新、通行金鑰移除。',
                items: '["已註冊裝置", "裝置重新命名", "最後一枚 Passkey 刪除保護"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Recovery Key',
                description: '帳號恢復憑據。',
                caption: '獨立於 TOTP 恢復碼。',
                body: '建立或輪換時一次性顯示。',
                items: '["建立 Recovery Key", "輪換恢復憑據", "恢復工作階段綁定新 Passkey"]'
            },
            UserIdentityAnonymous: {
                title: '匿名身份',
                description: '匿名評論、公開發送、站點處理規則。',
                caption: '真實帳號身份不展示。',
                body: '匿名身份狀態按站點策略顯示。',
                items: '["預設匿名模式", "匿名展示名語言", "匿名憑據狀態與聲譽分組"]'
            },
            UserIdentityPublicProfile: {
                title: '公開資料',
                description: '公開發送時使用的身份資訊。',
                caption: '僅公開發送時展示。',
                body: '公開稱呼、展示說明、發送前確認。',
                items: '["公開稱呼", "公開發送確認", "評論作者展示預覽"]'
            },
            UserIdentitySessions: {
                title: '裝置工作階段',
                description: '活躍裝置工作階段。',
                caption: '目前帳號的登入裝置。',
                body: '目前裝置、其他活躍工作階段、裝置下線。',
                items: '["目前裝置", "其他活躍工作階段", "撤銷其他裝置"]'
            },
            UserIdentityMfa: {
                title: '二次驗證',
                description: 'TOTP 狀態。',
                caption: '敏感操作驗證；不用於帳號恢復。',
                body: '二次驗證啟停、TOTP 恢復碼產生。',
                items: '["啟用二次驗證", "關閉二次驗證", "重新產生 TOTP 恢復碼"]'
            }
        }
    },
    profile: {
        pageTitle: '身份中心',
        pageDescription: '帳號安全、恢復憑據、公開資料、匿名評論。',
        emptyTitle: '前往身份中心',
        emptyContent: 'Passkey、Recovery Key、TOTP、裝置工作階段、公開稱呼、匿名評論。',
        openIdentityCta: '開啟身份中心'
    },
    confirm: {
        deletePasskeyTitle: '刪除通行金鑰',
        deletePasskeyBody: '刪除後，該裝置不能使用此金鑰登入。',
        rotateRecoveryKeyTitle: '輪換 Recovery Key',
        rotateRecoveryKeyBody: '輪換後舊 Recovery Key 失效。',
        deleteAccountTitle: '註銷帳戶',
        deleteAccountBody: '註銷會把帳號轉為已註銷，移除公開稱呼、工作階段、通行金鑰、Recovery Key、匿名憑據和 TOTP 資料；已發佈內容不會自動刪除。',
        confirmButton: '確認',
        cancelButton: '取消'
    },
    meta: {
        UserIdentityOverview: {
            title: '身份總覽',
            description: ''
        },
        UserIdentityPasskeys: {
            title: '通行金鑰',
            description: '登入裝置。'
        },
        UserIdentityRecoveryKey: {
            title: 'Recovery Key',
            description: '帳號恢復憑據。'
        },
        UserIdentityAnonymous: {
            title: '匿名身份',
            description: '匿名評論、公開發送、站點處理規則。'
        },
        UserIdentityPublicProfile: {
            title: '公開資料',
            description: '公開發送時使用的身份資訊。'
        },
        UserIdentitySessions: {
            title: '裝置工作階段',
            description: '活躍裝置工作階段。'
        },
        UserIdentityMfa: {
            title: '二次驗證',
            description: 'TOTP 狀態。'
        },
        UserIdentityCommentRecords: {
            title: '公開評論記錄',
            description: '帳號記錄只包含公開發送。'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: '目前帳號沒有可用的敏感操作驗證。請先新增通行金鑰或啟用 TOTP 後再操作。',
        passkeySensitiveOperationRequired: '目前帳號沒有可用的敏感操作驗證。請先新增通行金鑰或啟用 TOTP 後再操作。',
        accountDeleteSensitiveOperationRequired: '目前帳號沒有可用的敏感操作驗證。請先新增通行金鑰或啟用 TOTP 後再操作。',
        renameFailedFallback: '通行金鑰重新命名失敗',
        deleteFailedFallback: '通行金鑰刪除失敗',
        recoveryKeyFailedFallback: 'Recovery Key 操作失敗',
        accountDeleteFailedFallback: '帳號註銷失敗',
        accountDeletedSuccess: '帳號已註銷',
        recoveryKeyCreatedSuccess: 'Recovery Key 已建立',
        recoveryKeyRotatedSuccess: 'Recovery Key 已輪換'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>
