export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'messages' } as const)

import type { LocaleSchema } from '../keys'
import type { messages as zhCNMessages } from '../zh-CN/messages'

export const messages = {
    conversationList: {
        titleAccount: 'メッセージ一覧',
        titleAdmin: '処理中の会話',
        newTicketCta: 'チケットを送信',
        emptyTitleAccount: 'サイト内メッセージはありません',
        emptyTitleAdmin: '保留中の会話はありません',
        emptyDescriptionAccount: '通知、システムメッセージ、異議申立チケット。',
        emptyDescriptionAdmin: '現在のフィルター条件では処理が必要なメッセージはありません。',
        noContentAdmin: '内容はありません',
        noContentAccount: 'メッセージ内容はありません',
        systemTag: 'システム',
        listAriaLabel: '会話一覧',
        showMoreLabel: 'さらに会話を表示（{n}）'
    },
    threadPanel: {
        backAriaLabel: '会話一覧に戻る',
        backCta: '会話一覧に戻る',
        titleFallback: '会話を選択',
        titleFallbackAccount: '会話を選択するかチケットを送信',
        titleFallbackAdmin: '会話を選択',
        systemTag: 'システム',
        statusChangeWillNotify: 'ステータス変更はユーザーに通知されます',
        markOpen: '処理中にマーク',
        moveToPending: '保留中に戻す',
        closeConversation: '会話を閉じる',
        emptyDescriptionAccount: '会話の詳細と返信エリア。',
        emptyDescriptionAdmin: '保留中の会話。',
        newTicketCta: 'チケットを送信',
        replyingToPrefix: '返信中',
        accountContext: '現在の会話',
        accountContextAdmin: 'アカウント {id}',
        statusPrefix: 'ステータス',
        showOlder: '過去のメッセージを読み込む',
        replyHeader: '現在の会話に返信',
        replyLabel: '返信',
        replyLabelAccount: '管理者に返信',
        replyPlaceholder: '返信内容を入力',
        replyCta: '返信を送信'
    },
    composePanel: {
        titleAdmin: 'システムメッセージを送信',
        titleAccount: '異議申立チケットを送信',
        targetAccountIdLabel: '対象アカウントID',
        targetAccountIdPlaceholder: 'アカウントIDを入力',
        subjectLabel: '件名',
        systemSubjectPlaceholder: '例：システム通知',
        accountSubjectPlaceholder: '例：アカウント誤停止の異議申立',
        bodyLabel: '本文',
        bodyPlaceholderAdmin: 'メッセージ本文を入力',
        bodyPlaceholderAccount: '問題と要望を説明してください',
        submitAdminCta: 'システムメッセージを送信',
        submitAccountCta: 'チケットを送信'
    },
    emptyState: {
        titleFallback: '表示できる会話はありません'
    },
    filter: {
        open: '処理中',
        pending: '保留中',
        closed: '終了',
        system: 'システム',
        all: 'すべて',
        unread: '未読',
        systemMessages: 'システムメッセージ'
    },
    status: {
        systemTag: 'システム'
    },
    errors: {
        loadFailed: 'メッセージの読み込みに失敗しました',
        sendFailed: '送信に失敗しました'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>
