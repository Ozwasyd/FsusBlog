export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'identity' } as const);

import type { LocaleSchema } from '../keys';
import type { identity as zhCNIdentity } from '../zh-CN/identity';

export const identity = {
    overview: {
        passkeyLabel: 'パスキー',
        passkeyEnabled: '有効',
        passkeyDisabled: '未追加',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                other: '{count} 台のデバイスでログイン可能'
            }
        },
        recoveryKeyLabel: 'Recovery Key',
        recoveryKeyReady: '生成済み',
        recoveryKeyRequired: '未作成',
        recoveryKeyHint: '作成またはローテーション後に一度だけ表示されます。',
        mfaLabel: 'TOTP 二要素認証',
        mfaEnabled: '有効',
        mfaDisabled: '無効',
        mfaHint: 'センシティブ操作の検証に使用されます。アカウント復旧には使用されません。',
        anonymousLabel: '匿名コメント',
        anonymousCardAvailable: '利用可能',
        anonymousCardClosed: '停止中',
        zkAvailable: '強化匿名 利用可能',
        zkUnavailable: '強化匿名 停止中',
        sectionTitle: '現在の設定',
        sectionDescription: '',
        publicHandleLabel: '公開名',
        publicHandleEmpty: '公開名が設定されていません',
        anonymousPolicyLabel: '匿名コメント',
        anonymousPolicyAllowed: 'デフォルトで匿名。公開送信には明示的な選択が必要です。',
        anonymousPolicyClosed: '現在このサイトでは匿名コメントは受け付けていません。',
        publicSendOptionLabel: '公開送信',
        publicSendOptionAllowed: 'コメント投稿時に公開名を表示するオプションがあります。',
        publicSendOptionClosed: '現在このサイトでは公開送信はできません。',
        lifecycleTitle: 'アカウントライフサイクル',
        lifecycleDescription: 'アカウント削除にはセンシティブ操作の検証が必要です。',
        lifecycleWarning: 'アカウント削除を行うと、アカウントは削除済み状態に変更され、公開名、セッション、パスキー、Recovery Key、匿名資格、TOTP データが削除されます。公開済みコンテンツは自動的には削除されません。',
        deleteAccountCta: 'アカウントを削除'
    },
    passkeys: {
        sectionTitle: 'パスキーデバイス',
        sectionDescription: 'このアカウントに関連付けられたパスキーデバイスです。',
        loading: 'パスキーを読み込み中',
        emptyTitle: 'パスキーが追加されていません',
        emptyContent: 'デバイス認証のためにパスキーを登録してください。',
        addCta: 'パスキーを追加',
        nameInputAriaLabel: 'パスキー名',
        saveCta: '保存',
        cancelCta: 'キャンセル',
        editCta: '編集',
        deleteCta: '削除',
        nameEmpty: '名称未設定のパスキー',
        createdAtLabel: '作成日',
        activeAtLabel: '最終アクティブ',
        activeNeverRecorded: '記録なし',
        backupModeLabel: 'バックアップ',
        backupEligible: '同期バックアップ対応',
        backupIneligible: 'このデバイスのみ',
        recoverySuggestion: 'バックアップ非対応のパスキーが1つだけ登録されています。別のパスキーを追加するか、Recovery Key を作成することをお勧めします。'
    },
    recoveryKey: {
        sectionTitle: 'Recovery Key',
        sectionDescription: 'アカウント復旧用の認証情報です。一度だけ表示されます。',
        sectionHint: '作成またはローテーション後すぐに保存してください。以降は表示されません。紛失し、利用可能なパスキーもない場合、アカウントの復旧ができなくなります。',
        loading: '処理中',
        panelVersionPrefix: 'Recovery Key v',
        panelCreatedAtPrefix: '生成：',
        savedCheckbox: 'Recovery Key を保存しました',
        closeOnceCta: '閉じる',
        createCta: 'Recovery Key を作成',
        rotateCta: 'Recovery Key をローテーション'
    },
    mfa: {
        sectionTitle: 'TOTP 二要素認証',
        sectionDescription: 'センシティブ操作の検証用です。アカウント復旧には Recovery Key を使用します。',
        loading: '二要素認証の状態を読み込み中',
        enabled: 'TOTP 有効',
        disabled: 'TOTP 無効',
        lastVerifiedPrefix: '最終検証',
        lastVerifiedEmpty: '最近の検証記録はありません',
        enableCta: 'TOTP 二要素認証を有効化',
        disableCta: 'TOTP 二要素認証を無効化',
        disableConfirmTitle: 'TOTP 二要素認証を無効化',
        disableConfirmBody: '無効化すると、センシティブ操作で TOTP 検証が不要になります。',
        disableConfirmCta: '無効化を確認',
        disabledSuccess: 'TOTP 二要素認証が無効化されました',
        setupChallengeRequired: '先に TOTP 二要素認証を完了する必要があります。TOTP 復旧コードは Recovery Key とは異なります。',
        disableChallengeRequired: '先に TOTP 二要素認証を完了する必要があります。',
        initFailedFallback: 'TOTP 二要素認証の初期化に失敗しました',
        verifyFailedFallback: 'TOTP 検証に失敗しました',
        disableFailedFallback: 'TOTP 二要素認証の無効化に失敗しました',
        enabledSuccess: 'TOTP 二要素認証が有効化されました',
        setupModalTitle: 'TOTP 二要素認証の設定',
        loadFailedFallback: '二要素認証の状態の読み込みに失敗しました'
    },
    anonymous: {
        sectionTitle: '匿名アイデンティティ',
        sectionDescription: '匿名機能、公開送信、強化匿名の状態です。',
        readOnlyBody: '匿名送信ではアカウントの身元は表示されません。',
        publicChoiceBody: '公開送信はコメント投稿ページで明示的に選択する必要があります。',
        governanceHeading: '例外処理',
        zkStatusHeading: '強化匿名',
        cardEnabled: '利用可能',
        cardDisabled: '停止中',
        cardAvailable: '処理可能',
        cardUnavailable: '停止中',
        cardZkAvailable: '利用可能',
        cardZkUnavailable: '停止中',
        cardZkConfigVisible: '通常の匿名コメントが利用可能です。',
        cardZkConfigHidden: '現在このサイトでは停止中です。',
        defaultModeHint: '投稿ページで公開名を表示するか選択します。',
        governanceHint: '違反コメントはサイトポリシーに従って処理されます。'
    },
    publicProfile: {
        sectionTitle: '公開プロフィール',
        sectionDescription: '公開名は公開送信時にのみ使用されます。',
        draftLabel: '公開名',
        draftPlaceholder: '公開コメント送信時に入力できます',
        optInCheckbox: '公開送信時のみ表示',
        summaryAriaLabel: '公開プロフィールの状態',
        publicSendOptionLabel: '公開送信オプション',
        publicSendOptionAvailable: '利用可能',
        publicSendOptionUnavailable: '利用不可',
        saveCta: '公開名を保存',
        savedSuccess: '公開名を保存しました',
        clearedSuccess: '公開名を削除しました',
        saveFailedFallback: '公開名の保存に失敗しました'
    },
    sessions: {
        sectionTitle: 'デバイスセッション',
        sectionDescription: 'このアカウントのアクティブなデバイスセッションです。',
        loading: 'デバイスセッションを読み込み中',
        activeCount: {
            kind: 'plural',
            forms: {
                other: '{count} 件のアクティブセッション'
            }
        },
        revokeOthersCta: '他のデバイスをログアウト',
        currentDevice: '現在のデバイス',
        otherDevice: '他のデバイス',
        activeAtPrefix: 'アクティブ：',
        activeAtLabel: '最終アクティブ',
        createdAtLabel: '作成日時',
        loginMethodLabel: '認証方法',
        credentialLabel: 'パスキー',
        authenticationPasskey: 'パスキー',
        authenticationRecoveryKey: '復旧キー',
        authenticationEnrollment: '初回登録',
        authenticationOther: 'その他の方法',
        durationLabel: 'セッション期間',
        durationPersistent: 'ログイン状態を維持（30日間）',
        durationBrowserSession: 'ブラウザを閉じるとログアウト',
        sessionTypeLabel: 'セッション',
        revokeCta: 'ログアウト',
        emptyTitle: 'アクティブなセッションはありません',
        emptyContent: 'デバイスセッションはありません。',
        revokeSuccess: 'デバイスセッションをログアウトしました',
        revokeOthersSuccess: '他のデバイスをログアウトしました',
        deviceFallback: 'デバイス情報は記録されていません',
        loadFailedFallback: 'デバイスセッションの読み込みに失敗しました'
    },
    commentRecords: {
        sectionTitle: '公開コメント履歴',
        sectionDescription: 'アカウント記録には公開送信のみが含まれます。',
        loading: '公開コメント履歴を読み込み中です。',
        emptyTitle: '公開コメント履歴はありません',
        emptyDescription: '公開送信されたコメントはここに表示されます。匿名送信はアカウント記録に含まれません。',
        policyAriaLabel: '現在のコメントポリシー',
        policyPublicSendLabel: '公開送信',
        policyAnonymousLabel: '匿名コメント',
        policyZkLabel: '強化匿名',
        policyGovernanceLabel: '匿名コメントの処理',
        policyOpen: '開放中',
        policyClosed: '停止中',
        policyActive: 'ルールに従って処理',
        policyUnavailable: '停止中'
    },
    placeholder: {
        cardTitle: 'アイデンティティ設定',
        sections: {
            UserIdentityOverview: {
                title: 'アイデンティティ概要',
                description: '',
                caption: 'セキュリティ状態と公開アイデンティティの設定。',
                body: 'パスキー、Recovery Key、TOTP、公開名、コメントポリシー。',
                items: '["パスキー状態", "Recovery Key 状態", "匿名アイデンティティと公開プロフィール", "セッションサマリー"]'
            },
            UserIdentityPasskeys: {
                title: 'パスキー',
                description: 'ログインデバイス。',
                caption: 'このアカウントに関連付けられたパスキーデバイス。',
                body: '登録済みデバイス、名前変更、パスキー削除。',
                items: '["登録済みデバイス", "デバイス名変更", "最後のパスキー削除保護"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Recovery Key',
                description: 'アカウント復旧用認証情報。',
                caption: 'TOTP 復旧コードとは独立しています。',
                body: '作成またはローテーション時に一度だけ表示されます。',
                items: '["Recovery Key の作成", "復旧認証情報のローテーション", "復旧セッションで新しいパスキーを登録"]'
            },
            UserIdentityAnonymous: {
                title: '匿名アイデンティティ',
                description: '匿名コメント、公開送信、サイト処理ルール。',
                caption: '実際のアカウント身元は表示されません。',
                body: '匿名アイデンティティの状態はサイトポリシーに従って表示されます。',
                items: '["デフォルト匿名モード", "匿名表示名の言語", "匿名資格状態とレピュテーショングループ"]'
            },
            UserIdentityPublicProfile: {
                title: '公開プロフィール',
                description: '公開送信時に使用されるアイデンティティ情報。',
                caption: '公開送信時のみ表示されます。',
                body: '公開名、表示設定、送信前確認。',
                items: '["公開名", "公開送信の確認", "コメント著者プレビュー"]'
            },
            UserIdentitySessions: {
                title: 'デバイスセッション',
                description: 'アクティブなデバイスセッション。',
                caption: '現在のアカウントのログインデバイス。',
                body: '現在のデバイス、他のアクティブセッション、デバイスのログアウト。',
                items: '["現在のデバイス", "他のアクティブセッション", "他のデバイスをログアウト"]'
            },
            UserIdentityMfa: {
                title: '二要素認証',
                description: 'TOTP 状態。',
                caption: 'センシティブ操作の検証用。アカウント復旧には使用されません。',
                body: '二要素認証の有効化/無効化、TOTP 復旧コードの生成。',
                items: '["二要素認証を有効化", "二要素認証を無効化", "TOTP 復旧コードの再生成"]'
            }
        }
    },
    profile: {
        pageTitle: 'アイデンティティセンター',
        pageDescription: 'アカウントセキュリティ、復旧認証情報、公開プロフィール、匿名コメント。',
        emptyTitle: 'アイデンティティセンターへ',
        emptyContent: 'パスキー、Recovery Key、TOTP、デバイスセッション、公開名、匿名コメント。',
        openIdentityCta: 'アイデンティティセンターを開く'
    },
    confirm: {
        deletePasskeyTitle: 'パスキーを削除',
        deletePasskeyBody: '削除後、このデバイスではこのパスキーを使用してログインできなくなります。',
        rotateRecoveryKeyTitle: 'Recovery Key をローテーション',
        rotateRecoveryKeyBody: 'ローテーション後、古い Recovery Key は無効になります。',
        deleteAccountTitle: 'アカウントを削除',
        deleteAccountBody: 'アカウント削除を行うと、アカウントは削除済み状態に変更され、公開名、セッション、パスキー、Recovery Key、匿名資格、TOTP データが削除されます。公開済みコンテンツは自動的には削除されません。',
        confirmButton: '確認',
        cancelButton: 'キャンセル'
    },
    meta: {
        UserIdentityOverview: {
            title: 'アイデンティティ概要',
            description: ''
        },
        UserIdentityPasskeys: {
            title: 'パスキー',
            description: ''
        },
        UserIdentityRecoveryKey: {
            title: 'Recovery Key',
            description: ''
        },
        UserIdentityAnonymous: {
            title: '匿名アイデンティティ',
            description: ''
        },
        UserIdentityPublicProfile: {
            title: '公開プロフィール',
            description: ''
        },
        UserIdentitySessions: {
            title: 'デバイスセッション',
            description: ''
        },
        UserIdentityMfa: {
            title: '二要素認証',
            description: ''
        },
        UserIdentityCommentRecords: {
            title: '公開コメント履歴',
            description: 'アカウント記録には公開送信のみが含まれます。'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: 'このアカウントで利用可能なセンシティブ操作検証がありません。先にパスキーを追加するか TOTP を有効化してください。',
        passkeySensitiveOperationRequired: 'このアカウントで利用可能なセンシティブ操作検証がありません。先にパスキーを追加するか TOTP を有効化してください。',
        accountDeleteSensitiveOperationRequired: 'このアカウントで利用可能なセンシティブ操作検証がありません。先にパスキーを追加するか TOTP を有効化してください。',
        renameFailedFallback: 'パスキー名の変更に失敗しました',
        deleteFailedFallback: 'パスキーの削除に失敗しました',
        recoveryKeyFailedFallback: 'Recovery Key の操作に失敗しました',
        accountDeleteFailedFallback: 'アカウント削除に失敗しました',
        accountDeletedSuccess: 'アカウントが削除されました',
        recoveryKeyCreatedSuccess: 'Recovery Key が作成されました',
        recoveryKeyRotatedSuccess: 'Recovery Key がローテーションされました'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>;
