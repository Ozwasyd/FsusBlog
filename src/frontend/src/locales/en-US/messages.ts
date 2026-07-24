import type { DeepStringShape } from '../keys';
import type { messages as zhCNMessages } from '../zh-CN/messages';

export const messages = {
    conversationList: {
        titleAccount: 'Messages',
        titleAdmin: 'Active Conversations',
        newTicketCta: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.newTicketCta',
        emptyTitleAccount: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.emptyTitleAccount',
        emptyTitleAdmin: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.emptyTitleAdmin',
        emptyDescriptionAccount: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.emptyDescriptionAccount',
        emptyDescriptionAdmin: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.emptyDescriptionAdmin',
        noContentAdmin: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.noContentAdmin',
        noContentAccount: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.noContentAccount',
        systemTag: 'System',
        listAriaLabel: 'Conversation list',
        showMoreLabel: '__FSUSBLOG_TRANSLATION_PENDING__:messages.conversationList.showMoreLabel'
    },
    threadPanel: {
        backAriaLabel: 'Back to conversation list',
        backCta: 'Back to conversation list',
        titleFallback: 'Select conversation',
        titleFallbackAccount: 'Select conversation or submit ticket',
        titleFallbackAdmin: 'Select conversation',
        systemTag: 'System',
        statusChangeWillNotify: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.statusChangeWillNotify',
        markOpen: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.markOpen',
        moveToPending: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.moveToPending',
        closeConversation: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.closeConversation',
        emptyDescriptionAccount: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.emptyDescriptionAccount',
        emptyDescriptionAdmin: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.emptyDescriptionAdmin',
        newTicketCta: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.newTicketCta',
        replyingToPrefix: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.replyingToPrefix',
        accountContext: 'Current conversation',
        accountContextAdmin: 'Account {id}',
        statusPrefix: 'Status',
        showOlder: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.showOlder',
        replyHeader: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.replyHeader',
        replyLabel: 'Reply',
        replyLabelAccount: 'Reply to administrator',
        replyPlaceholder: '__FSUSBLOG_TRANSLATION_PENDING__:messages.threadPanel.replyPlaceholder',
        replyCta: 'Send reply'
    },
    composePanel: {
        titleAdmin: 'Send System Message',
        titleAccount: 'Submit Ticket',
        targetAccountIdLabel: 'Target Account ID',
        targetAccountIdPlaceholder: 'Enter account ID',
        subjectLabel: 'Subject',
        systemSubjectPlaceholder: 'e.g. System Notification',
        accountSubjectPlaceholder: 'e.g. Account Appeal',
        bodyLabel: 'Body',
        bodyPlaceholderAdmin: 'Enter message body',
        bodyPlaceholderAccount: 'Describe problem and request',
        submitAdminCta: 'Send System Message',
        submitAccountCta: 'Submit Ticket'
    },
    emptyState: {
        titleFallback: 'No conversations to display'
    },
    filter: {
        open: 'Open',
        pending: 'Pending',
        closed: 'Closed',
        system: 'System',
        all: 'All',
        unread: 'Unread',
        systemMessages: 'System Messages'
    },
    status: {
        systemTag: 'System'
    },
    errors: {
        loadFailed: '__FSUSBLOG_TRANSLATION_PENDING__:messages.errors.loadFailed',
        sendFailed: '__FSUSBLOG_TRANSLATION_PENDING__:messages.errors.sendFailed'
    }
} as const satisfies DeepStringShape<typeof zhCNMessages>;
