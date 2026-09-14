export const localeDomainIdentity = Object.freeze({ locale: 'zh-Hant', domain: 'messages' } as const);

import type { LocaleSchema } from '../keys';
import type { messages as zhCNMessages } from '../zh-CN/messages';

export const messages = {
    conversationList: {
        titleAccount: '訊息列表',
        titleAdmin: '處理中工作階段',
        newTicketCta: '提交工單',
        emptyTitleAccount: '暫無站內信',
        emptyTitleAdmin: '暫無待處理工作階段',
        emptyDescriptionAccount: '通知、系統訊息、申訴工單。',
        emptyDescriptionAdmin: '目前篩選下沒有需要處理的訊息。',
        noContentAdmin: '暫無內容',
        noContentAccount: '暫無訊息內容',
        systemTag: '系統',
        listAriaLabel: '工作階段列表',
        showMoreLabel: {
            kind: 'plural',
            forms: {
                other: '顯示更多工作階段（{count}）'
            }
        }
    },
    threadPanel: {
        backAriaLabel: '返回工作階段列表',
        backCta: '返回工作階段列表',
        titleFallback: '選擇工作階段',
        titleFallbackAccount: '選擇工作階段或提交工單',
        titleFallbackAdmin: '選擇工作階段',
        systemTag: '系統',
        statusChangeWillNotify: '狀態變更會通知使用者',
        markOpen: '標記為處理中',
        moveToPending: '移回待處理',
        closeConversation: '關閉工作階段',
        emptyDescriptionAccount: '工作階段詳情與回覆區。',
        emptyDescriptionAdmin: '待處理工作階段。',
        newTicketCta: '提交工單',
        replyingToPrefix: '正在回覆',
        accountContext: '目前工作階段',
        accountContextAdmin: '帳號 {id}',
        statusPrefix: '狀態',
        showOlder: '載入較早訊息',
        replyHeader: '回覆目前工作階段',
        replyLabel: '回覆',
        replyLabelAccount: '回覆管理員',
        replyPlaceholder: '輸入回覆內容',
        replyCta: '傳送回覆'
    },
    composePanel: {
        titleAdmin: '傳送系統訊息',
        titleAccount: '提交申訴工單',
        targetAccountIdLabel: '目標帳號 ID',
        targetAccountIdPlaceholder: '輸入帳號 ID',
        subjectLabel: '主旨',
        systemSubjectPlaceholder: '例如：系統通知',
        accountSubjectPlaceholder: '例如：帳號誤封申訴',
        bodyLabel: '內容',
        bodyPlaceholderAdmin: '輸入訊息正文',
        bodyPlaceholderAccount: '描述問題與訴求',
        submitAdminCta: '傳送系統訊息',
        submitAccountCta: '提交工單'
    },
    emptyState: {
        titleFallback: '沒有可顯示的工作階段'
    },
    filter: {
        open: '處理中',
        pending: '待處理',
        closed: '已關閉',
        system: '系統',
        all: '全部',
        unread: '未讀',
        systemMessages: '系統訊息'
    },
    status: {
        systemTag: '系統'
    },
    errors: {
        loadFailed: '載入訊息失敗',
        sendFailed: '傳送失敗'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>;
