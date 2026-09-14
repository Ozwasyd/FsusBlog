export const localeDomainIdentity = Object.freeze({ locale: 'zh-CN', domain: 'messages' } as const);

export const messages = {
    conversationList: {
        titleAccount: '消息列表',
        titleAdmin: '处理中会话',
        newTicketCta: '提交工单',
        emptyTitleAccount: '暂无站内信',
        emptyTitleAdmin: '暂无待处理会话',
        emptyDescriptionAccount: '通知、系统消息、申诉工单。',
        emptyDescriptionAdmin: '当前筛选下没有需要处理的消息。',
        noContentAdmin: '暂无内容',
        noContentAccount: '暂无消息内容',
        systemTag: '系统',
        listAriaLabel: '会话列表',
        showMoreLabel: {
            kind: 'plural',
            forms: {
                other: '显示更多会话（{count}）'
            }
        }
    },
    threadPanel: {
        backAriaLabel: '返回会话列表',
        backCta: '返回会话列表',
        titleFallback: '选择会话',
        titleFallbackAccount: '选择会话或提交工单',
        titleFallbackAdmin: '选择会话',
        systemTag: '系统',
        statusChangeWillNotify: '状态变更会通知用户',
        markOpen: '标记为处理中',
        moveToPending: '移回待处理',
        closeConversation: '关闭会话',
        emptyDescriptionAccount: '会话详情与回复区。',
        emptyDescriptionAdmin: '待处理会话。',
        newTicketCta: '提交工单',
        replyingToPrefix: '正在回复',
        accountContext: '当前会话',
        accountContextAdmin: '账号 {id}',
        statusPrefix: '状态',
        showOlder: '加载更早消息',
        replyHeader: '回复当前会话',
        replyLabel: '回复',
        replyLabelAccount: '回复管理员',
        replyPlaceholder: '输入回复内容',
        replyCta: '发送回复'
    },
    composePanel: {
        titleAdmin: '发送系统消息',
        titleAccount: '提交申诉工单',
        targetAccountIdLabel: '目标账号 ID',
        targetAccountIdPlaceholder: '输入账号 ID',
        subjectLabel: '主题',
        systemSubjectPlaceholder: '例如：系统通知',
        accountSubjectPlaceholder: '例如：账号误封申诉',
        bodyLabel: '内容',
        bodyPlaceholderAdmin: '输入消息正文',
        bodyPlaceholderAccount: '描述问题与诉求',
        submitAdminCta: '发送系统消息',
        submitAccountCta: '提交工单'
    },
    emptyState: {
        titleFallback: '没有可显示的会话'
    },
    filter: {
        open: '处理中',
        pending: '待处理',
        closed: '已关闭',
        system: '系统',
        all: '全部',
        unread: '未读',
        systemMessages: '系统消息'
    },
    status: {
        systemTag: '系统'
    },
    errors: {
        loadFailed: '加载消息失败',
        sendFailed: '发送失败'
    }
} as const;
