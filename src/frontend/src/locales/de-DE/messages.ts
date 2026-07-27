export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'messages' } as const)

import type { LocaleSchema } from '../keys'
import type { messages as zhCNMessages } from '../zh-CN/messages'

export const messages = {
    conversationList: {
        titleAccount: 'Nachrichten',
        titleAdmin: 'Aktive Konversationen',
        newTicketCta: 'Ticket einreichen',
        emptyTitleAccount: 'Keine Nachrichten',
        emptyTitleAdmin: 'Keine ausstehenden Konversationen',
        emptyDescriptionAccount: 'Benachrichtigungen, Systemnachrichten und Beschwerde-Tickets.',
        emptyDescriptionAdmin: 'Keine Nachrichten erfordern Maßnahmen unter dem aktuellen Filter.',
        noContentAdmin: 'Kein Inhalt',
        noContentAccount: 'Kein Nachrichteninhalt',
        systemTag: 'System',
        listAriaLabel: 'Konversationsliste',
        showMoreLabel: {
            kind: 'plural',
            forms: {
                one: 'Weitere Konversationen anzeigen ({count})',
                other: 'Weitere Konversationen anzeigen ({count})'
            }
        }
    },
    threadPanel: {
        backAriaLabel: 'Zurück zur Konversationsliste',
        backCta: 'Zurück zur Konversationsliste',
        titleFallback: 'Konversation auswählen',
        titleFallbackAccount: 'Konversation auswählen oder Ticket einreichen',
        titleFallbackAdmin: 'Konversation auswählen',
        systemTag: 'System',
        statusChangeWillNotify: 'Statusänderungen werden dem Benutzer mitgeteilt',
        markOpen: 'Als offen markieren',
        moveToPending: 'In ausstehend verschieben',
        closeConversation: 'Konversation schließen',
        emptyDescriptionAccount: 'Konversationsdetails und Antwortbereich.',
        emptyDescriptionAdmin: 'Ausstehende Konversation.',
        newTicketCta: 'Ticket einreichen',
        replyingToPrefix: 'Antwort an',
        accountContext: 'Aktuelle Konversation',
        accountContextAdmin: 'Konto {id}',
        statusPrefix: 'Status',
        showOlder: 'Ältere Nachrichten laden',
        replyHeader: 'Auf aktuelle Konversation antworten',
        replyLabel: 'Antworten',
        replyLabelAccount: 'Administrator antworten',
        replyPlaceholder: 'Antwortnachricht eingeben',
        replyCta: 'Antwort senden'
    },
    composePanel: {
        titleAdmin: 'Systemnachricht senden',
        titleAccount: 'Beschwerde-Ticket einreichen',
        targetAccountIdLabel: 'Zielkonto-ID',
        targetAccountIdPlaceholder: 'Konto-ID eingeben',
        subjectLabel: 'Betreff',
        systemSubjectPlaceholder: 'z. B. Systembenachrichtigung',
        accountSubjectPlaceholder: 'z. B. Kontobeschwerde',
        bodyLabel: 'Inhalt',
        bodyPlaceholderAdmin: 'Nachrichtentext eingeben',
        bodyPlaceholderAccount: 'Problem und Anliegen beschreiben',
        submitAdminCta: 'Systemnachricht senden',
        submitAccountCta: 'Ticket einreichen'
    },
    emptyState: {
        titleFallback: 'Keine Konversationen anzuzeigen'
    },
    filter: {
        open: 'Offen',
        pending: 'Ausstehend',
        closed: 'Geschlossen',
        system: 'System',
        all: 'Alle',
        unread: 'Ungelesen',
        systemMessages: 'Systemnachrichten'
    },
    status: {
        systemTag: 'System'
    },
    errors: {
        loadFailed: 'Laden der Nachrichten fehlgeschlagen',
        sendFailed: 'Senden fehlgeschlagen'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>
