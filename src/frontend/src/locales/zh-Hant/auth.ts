export const localeDomainIdentity = Object.freeze({ locale: 'zh-Hant', domain: 'auth' } as const);

import type { LocaleSchema } from '../keys';
import type { auth as zhCNAuth } from '../zh-CN/auth';

export const auth = {
    register: {
        title: '建立匿名帳號',
        description: '不綁定信箱或手機號碼。儲存 Recovery Key，綁定通行金鑰。',
        publicHandleHeading: '公開稱呼',
        publicHandleLabel: '公開稱呼（可選）',
        publicHandleHint: '留空時由系統產生匿名稱呼。TOTP 可在帳戶設定中作為二次驗證啟用；TOTP 恢復碼與 Recovery Key 不同。',
        publicHandlePlaceholder: '3-20 位中文、字母、數字或 #',
        agreementPrefix: '我已閱讀並同意',
        guidelinesLink: '站點使用規範',
        submitButtonIdle: '建立匿名帳號並產生 Recovery Key',
        submitButtonLoading: '正在建立匿名帳號',
        passkeyEnrollmentTitle: '綁定首枚通行金鑰',
        passkeyEnrollmentHint: '帳戶目前仍是暫時狀態；只有通行金鑰驗證成功後才會啟用並簽發正式工作階段。',
        recoveryKeyTitle: '儲存 Recovery Key',
        recoveryKeyHint: 'Recovery Key 只顯示一次。若它遺失且沒有可用通行金鑰，帳號可能無法恢復。',
        recoveryKeyVersionPrefix: 'Recovery Key v',
        recoveryKeyCreatedAtPrefix: '產生時間：',
        copyRecoveryKeyCta: '複製 Recovery Key',
        recoveryKeySavedCheckbox: '我已儲存 Recovery Key',
        registerPasskeyCta: '註冊通行金鑰',
        passkeyBoundTitle: '通行金鑰已綁定',
        passkeyBoundHint: '登入使用通行金鑰；帳號恢復使用 Recovery Key。',
        enterAccountCta: '進入帳號中心',
        hasAccountLabel: '已有帳號',
        loginLink: '登入',
        cancelLink: '回到主頁'
    },
    login: {
        title: '登入',
        description: '寫作、評論、站點維護。',
        rememberMe: '記住本裝置',
        passkeyButton: '使用通行金鑰登入',
        passkeyLoading: '等待裝置驗證',
        passkeyHint: '匿名身份不綁定信箱或手機號碼；使用已綁定裝置、安全金鑰，或用 Recovery Key 恢復存取。',
        passkeyFailureHint: '驗證失敗時使用 Recovery Key 恢復存取。',
        recoverLink: '使用 Recovery Key 恢復存取',
        mfaRequiredTitle: '需要二次驗證',
        mfaRequiredHint: '輸入驗證碼或恢復碼。',
        mfaAriaLabel: '選擇驗證方式',
        mfaModeTOTP: '驗證碼',
        mfaModeRecovery: '恢復碼',
        mfaCodeLabel: 'MFA 驗證碼',
        mfaCodePlaceholder: '6 位驗證碼',
        mfaRecoveryLabel: '恢復碼',
        mfaRecoveryPlaceholder: '恢復碼',
        mfaSubmit: '驗證',
        registerLink: '註冊',
        cancelLink: '取消'
    },
    recover: {
        title: '恢復存取',
        description: '驗證 Recovery Key，綁定新通行金鑰。',
        sectionTitle: 'Recovery Key',
        sectionHint: 'Recovery Key 是帳號恢復憑據，不是 TOTP 恢復碼。驗證後綁定新通行金鑰。',
        keyLabel: 'Recovery Key',
        keyPlaceholder: '貼上以 frk_ 開頭的 Recovery Key',
        keyHelp: 'Recovery Key 遺失且無可用通行金鑰時，帳號可能無法恢復。',
        revokePasskeys: '恢復後撤銷舊通行金鑰',
        verifyCta: '驗證 Recovery Key',
        sessionReadyHint: 'Recovery Key 已驗證。恢復工作階段有效至 {expiresAt}。綁定新的通行金鑰。',
        bindNewPasskeyCta: '綁定新的通行金鑰',
        verifyFailedFallback: 'Recovery Key 驗證失敗。',
        returnLoginLink: '返回登入',
        cancelLink: '取消'
    },
    policyModal: {
        fallbackTitle: '條款詳情',
        privacyTitle: '隱私政策',
        guidelinesTitle: '使用者守則',
        loadingStatus: '正在載入內容',
        loadError: '無法載入條款內容',
        retryCta: '重試',
        emptyStatePrefix: '暫未設定',
        emptyStateSuffix: '。',
        acknowledgementCta: '我已閱讀',
        bodyAriaLabel: '條款正文'
    }
} as const satisfies LocaleSchema<typeof zhCNAuth>;
