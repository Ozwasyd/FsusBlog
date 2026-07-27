export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'auth' } as const)

import type { LocaleSchema } from '../keys'
import type { auth as zhCNAuth } from '../zh-CN/auth'

export const auth = {
    register: {
        title: '匿名アカウントを作成',
        description: 'メールアドレスや電話番号は不要です。Recovery Key を保存し、パスキーを登録してください。',
        publicHandleHeading: '公開名',
        publicHandleLabel: '公開名（任意）',
        publicHandleHint: '空欄の場合はシステムが匿名名を生成します。TOTP はアカウント設定で二要素認証として後から有効化できます。TOTP 復旧コードは Recovery Key とは異なります。',
        publicHandlePlaceholder: '3～20文字の日本語、英数字、または #',
        agreementPrefix: '以下を読み、同意します：',
        guidelinesLink: 'サイト利用規約',
        submitButtonIdle: '匿名アカウントを作成して Recovery Key を生成',
        submitButtonLoading: '匿名アカウントを作成中',
        passkeyEnrollmentTitle: '最初のパスキーを登録',
        passkeyEnrollmentHint: 'アカウントはまだ一時的な状態です。パスキー検証が成功した後にのみ有効化され、正式なセッションが発行されます。',
        recoveryKeyTitle: 'Recovery Key を保存',
        recoveryKeyHint: 'Recovery Key は一度だけ表示されます。これを紛失し、利用可能なパスキーもない場合、アカウントの復旧ができなくなる可能性があります。',
        recoveryKeyVersionPrefix: 'Recovery Key v',
        recoveryKeyCreatedAtPrefix: '生成日時：',
        copyRecoveryKeyCta: 'Recovery Key をコピー',
        recoveryKeySavedCheckbox: 'Recovery Key を保存しました',
        registerPasskeyCta: 'パスキーを登録',
        passkeyBoundTitle: 'パスキーが登録されました',
        passkeyBoundHint: 'ログインにはパスキーを、アカウント復旧には Recovery Key を使用してください。',
        enterAccountCta: 'アカウントセンターへ',
        hasAccountLabel: 'アカウントをお持ちの方',
        loginLink: 'ログイン',
        cancelLink: 'ホームに戻る'
    },
    login: {
        title: 'ログイン',
        description: '執筆、コメント、サイトメンテナンス。',
        rememberMe: 'このデバイスを記憶する',
        passkeyButton: 'パスキーでログイン',
        passkeyLoading: 'デバイス認証を待機中',
        passkeyHint: '匿名アカウントはメールアドレスや電話番号と紐付きません。登録済みデバイスやセキュリティキーを使用するか、Recovery Key でアクセスを復旧してください。',
        passkeyFailureHint: 'デバイス検証に失敗した場合は Recovery Key でアクセスを復旧してください。',
        recoverLink: 'Recovery Key でアクセスを復旧',
        mfaRequiredTitle: '二要素認証が必要です',
        mfaRequiredHint: '認証コードまたは復旧コードを入力してください。',
        mfaAriaLabel: '検証方法を選択',
        mfaModeTOTP: '認証コード',
        mfaModeRecovery: '復旧コード',
        mfaCodeLabel: 'MFA 認証コード',
        mfaCodePlaceholder: '6桁の認証コード',
        mfaRecoveryLabel: '復旧コード',
        mfaRecoveryPlaceholder: '復旧コード',
        mfaSubmit: '検証',
        registerLink: '登録',
        cancelLink: 'キャンセル'
    },
    recover: {
        title: 'アクセスを復旧',
        description: 'Recovery Key を検証し、新しいパスキーを登録します。',
        sectionTitle: 'Recovery Key',
        sectionHint: 'Recovery Key はアカウント復旧用の認証情報であり、TOTP 復旧コードではありません。検証後、新しいパスキーを登録してください。',
        keyLabel: 'Recovery Key',
        keyPlaceholder: 'frk_ で始まる Recovery Key を貼り付けてください',
        keyHelp: 'Recovery Key を紛失し、利用可能なパスキーもない場合、アカウントの復旧ができなくなる可能性があります。',
        revokePasskeys: '復旧後に古いパスキーを取り消す',
        verifyCta: 'Recovery Key を検証',
        sessionReadyHint: 'Recovery Key が検証されました。復旧セッションは {expiresAt} まで有効です。新しいパスキーを登録してください。',
        bindNewPasskeyCta: '新しいパスキーを登録',
        verifyFailedFallback: 'Recovery Key の検証に失敗しました。',
        returnLoginLink: 'ログインに戻る',
        cancelLink: 'キャンセル'
    },
    policyModal: {
        fallbackTitle: '規約詳細',
        privacyTitle: 'プライバシーポリシー',
        guidelinesTitle: '利用規約',
        loadingStatus: 'コンテンツを読み込み中',
        loadError: '規約内容を読み込めませんでした',
        retryCta: '再試行',
        emptyStatePrefix: '',
        emptyStateSuffix: 'の内容はまだ設定されていません。',
        acknowledgementCta: '確認しました',
        bodyAriaLabel: '規約本文'
    }
} as const satisfies LocaleSchema<typeof zhCNAuth>
