export const localeDomainIdentity = Object.freeze({ locale: 'fr-FR', domain: 'messages' } as const);

import type { LocaleSchema } from '../keys';
import type { messages as zhCNMessages } from '../zh-CN/messages';

export const messages = {
    conversationList: {
        titleAccount: 'Messages',
        titleAdmin: 'Conversations actives',
        newTicketCta: 'Créer un ticket',
        emptyTitleAccount: 'Aucun message',
        emptyTitleAdmin: 'Aucune conversation en attente',
        emptyDescriptionAccount: 'Notifications, messages système et tickets de recours.',
        emptyDescriptionAdmin: "Aucun message ne nécessite d'action avec le filtre actuel.",
        noContentAdmin: 'Aucun contenu',
        noContentAccount: 'Aucun message',
        systemTag: 'Système',
        listAriaLabel: 'Liste des conversations',
        showMoreLabel: {
            kind: 'plural',
            forms: {
                one: 'Afficher plus de conversations ({count})',
                many: 'Afficher plus de conversations ({count})',
                other: 'Afficher plus de conversations ({count})'
            }
        }
    },
    threadPanel: {
        backAriaLabel: 'Retour à la liste des conversations',
        backCta: 'Retour à la liste',
        titleFallback: 'Sélectionnez une conversation',
        titleFallbackAccount: 'Sélectionnez une conversation ou créez un ticket',
        titleFallbackAdmin: 'Sélectionnez une conversation',
        systemTag: 'Système',
        statusChangeWillNotify: "Les changements de statut seront notifiés à l'utilisateur",
        markOpen: 'Marquer comme en cours',
        moveToPending: 'Remettre en attente',
        closeConversation: 'Fermer la conversation',
        emptyDescriptionAccount: 'Détails de la conversation et zone de réponse.',
        emptyDescriptionAdmin: 'Conversation en attente.',
        newTicketCta: 'Créer un ticket',
        replyingToPrefix: 'Réponse à',
        accountContext: 'Conversation actuelle',
        accountContextAdmin: 'Compte {id}',
        statusPrefix: 'Statut',
        showOlder: 'Charger les messages plus anciens',
        replyHeader: 'Répondre à la conversation',
        replyLabel: 'Répondre',
        replyLabelAccount: "Répondre à l'administrateur",
        replyPlaceholder: 'Saisissez votre réponse',
        replyCta: 'Envoyer la réponse'
    },
    composePanel: {
        titleAdmin: 'Envoyer un message système',
        titleAccount: 'Créer un ticket de recours',
        targetAccountIdLabel: 'ID du compte cible',
        targetAccountIdPlaceholder: "Saisissez l'ID du compte",
        subjectLabel: 'Sujet',
        systemSubjectPlaceholder: 'Ex. : Notification système',
        accountSubjectPlaceholder: 'Ex. : Recours contre un bannissement',
        bodyLabel: 'Contenu',
        bodyPlaceholderAdmin: 'Saisissez le corps du message',
        bodyPlaceholderAccount: 'Décrivez votre problème et votre demande',
        submitAdminCta: 'Envoyer le message système',
        submitAccountCta: 'Créer le ticket'
    },
    emptyState: {
        titleFallback: 'Aucune conversation à afficher'
    },
    filter: {
        open: 'En cours',
        pending: 'En attente',
        closed: 'Fermé',
        system: 'Système',
        all: 'Tout',
        unread: 'Non lu',
        systemMessages: 'Messages système'
    },
    status: {
        systemTag: 'Système'
    },
    errors: {
        loadFailed: 'Échec du chargement des messages',
        sendFailed: "Échec de l'envoi"
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>;
