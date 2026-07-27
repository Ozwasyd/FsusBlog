export const localeDomainIdentity = Object.freeze({ locale: 'en-US', domain: 'messages' } as const)

import type { LocaleSchema } from '../keys';
import type { messages as zhCNMessages } from '../zh-CN/messages';

export const messages = {
    conversationList: {
        titleAccount: 'Messages',
        titleAdmin: 'Active Conversations',
        newTicketCta: 'Submit Ticket',
        emptyTitleAccount: 'No Site Messages',
        emptyTitleAdmin: 'No Pending Conversations',
        emptyDescriptionAccount: 'Notifications, system messages, and appeal tickets.',
        emptyDescriptionAdmin: 'No messages require action under current filter.',
        noContentAdmin: 'No content',
        noContentAccount: 'No message content',
        systemTag: 'System',
        listAriaLabel: 'Conversation list',
        showMoreLabel: 'Show more conversations ({n})'
    },
    threadPanel: {
        backAriaLabel: 'Back to conversation list',
        backCta: 'Back to conversation list',
        titleFallback: 'Select conversation',
        titleFallbackAccount: 'Select conversation or submit ticket',
        titleFallbackAdmin: 'Select conversation',
        systemTag: 'System',
        statusChangeWillNotify: 'Status changes will notify user',
        markOpen: 'Mark Open',
        moveToPending: 'Move to Pending',
        closeConversation: 'Close Conversation',
        emptyDescriptionAccount: 'Conversation details and reply section.',
        emptyDescriptionAdmin: 'Pending conversation.',
        newTicketCta: 'Submit Ticket',
        replyingToPrefix: 'Replying to',
        accountContext: 'Current conversation',
        accountContextAdmin: 'Account {id}',
        statusPrefix: 'Status',
        showOlder: 'Load older messages',
        replyHeader: 'Reply to current conversation',
        replyLabel: 'Reply',
        replyLabelAccount: 'Reply to administrator',
        replyPlaceholder: 'Enter reply message',
        replyCta: 'Send reply'
    },
    composePanel: {
        titleAdmin: 'Send System Message',
        titleAccount: 'Submit Appeal Ticket',
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
        loadFailed: 'Failed to load messages',
        sendFailed: 'Failed to send message'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>;
