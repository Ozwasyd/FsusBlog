export const localeDomainIdentity = Object.freeze({ locale: 'fr-FR', domain: 'identity' } as const)

import type { LocaleSchema } from '../keys'
import type { identity as zhCNIdentity } from '../zh-CN/identity'

export const identity = {
    overview: {
        passkeyLabel: "Clé d'accès",
        passkeyEnabled: 'Activée',
        passkeyDisabled: 'Non ajoutée',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                one: '{count} appareil de connexion',
                many: '{count} appareils de connexion',
                other: '{count} appareils de connexion'
            }
        },
        recoveryKeyLabel: 'Clé de récupération',
        recoveryKeyReady: 'Générée',
        recoveryKeyRequired: 'Non créée',
        recoveryKeyHint: 'Affichée une seule fois après création ou rotation.',
        mfaLabel: 'TOTP MFA',
        mfaEnabled: 'Activée',
        mfaDisabled: 'Désactivée',
        mfaHint: 'Utilisée pour les opérations sensibles ; ne remplace pas la récupération de compte.',
        anonymousLabel: 'Commentaires anonymes',
        anonymousCardAvailable: 'Disponible',
        anonymousCardClosed: 'Fermé',
        zkAvailable: 'Anonymat renforcé disponible',
        zkUnavailable: 'Anonymat renforcé fermé',
        sectionTitle: 'Paramètres actuels',
        sectionDescription: '',
        publicHandleLabel: 'Nom public',
        publicHandleEmpty: 'Aucun nom public défini',
        anonymousPolicyLabel: 'Commentaires anonymes',
        anonymousPolicyAllowed: "Anonyme par défaut ; l'envoi public nécessite une sélection explicite.",
        anonymousPolicyClosed: 'Les commentaires anonymes sont fermés sur ce site.',
        publicSendOptionLabel: 'Envoi public',
        publicSendOptionAllowed: "Possibilité d'afficher le nom public lors des commentaires.",
        publicSendOptionClosed: "L'envoi public est désactivé sur ce site.",
        lifecycleTitle: 'Cycle de vie du compte',
        lifecycleDescription: 'Une vérification sensible est requise avant la suppression du compte.',
        lifecycleWarning: "La suppression convertit le compte en supprimé, effaçant le nom public, les sessions, les clés d'accès, la clé de récupération, les identifiants anonymes et les données TOTP. Le contenu publié ne sera pas supprimé automatiquement.",
        deleteAccountCta: 'Supprimer le compte'
    },
    passkeys: {
        sectionTitle: "Clés d'accès",
        sectionDescription: "Clés d'accès associées à ce compte.",
        loading: "Chargement des clés d'accès",
        emptyTitle: "Aucune clé d'accès ajoutée",
        emptyContent: "Enregistrez des clés d'accès pour l'authentification des appareils.",
        addCta: "Ajouter une clé d'accès",
        nameInputAriaLabel: "Nom de la clé d'accès",
        saveCta: 'Enregistrer',
        cancelCta: 'Annuler',
        editCta: 'Modifier',
        deleteCta: 'Supprimer',
        nameEmpty: "Clé d'accès sans nom",
        createdAtLabel: 'Créée le',
        activeAtLabel: 'Dernière activité',
        activeNeverRecorded: 'Jamais enregistrée',
        backupModeLabel: 'Sauvegarde',
        backupEligible: 'Sauvegarde synchronisée prise en charge',
        backupIneligible: 'Cet appareil uniquement',
        recoverySuggestion: "Une seule clé d'accès non sauvegardée est enregistrée. Pensez à ajouter une autre clé d'accès ou à créer une clé de récupération."
    },
    recoveryKey: {
        sectionTitle: 'Clé de récupération',
        sectionDescription: 'Identifiant de récupération de compte ; affiché une seule fois.',
        sectionHint: "Sauvegardez-la immédiatement après création ou rotation ; elle ne sera plus affichée. Perdue et sans clé d'accès fonctionnelle, le compte ne pourra pas être récupéré.",
        loading: 'Traitement en cours',
        panelVersionPrefix: 'Clé de récupération v',
        panelCreatedAtPrefix: 'Générée le : ',
        savedCheckbox: "J'ai sauvegardé ma clé de récupération",
        closeOnceCta: 'Fermer',
        createCta: 'Créer une clé de récupération',
        rotateCta: 'Remplacer la clé de récupération'
    },
    mfa: {
        sectionTitle: 'TOTP MFA',
        sectionDescription: 'Vérification pour opérations sensibles ; la récupération de compte utilise la clé de récupération.',
        loading: "Chargement du statut d'authentification à deux facteurs",
        enabled: 'TOTP activé',
        disabled: 'TOTP désactivé',
        lastVerifiedPrefix: 'Dernière vérification',
        lastVerifiedEmpty: 'Aucune vérification récente enregistrée',
        enableCta: 'Activer TOTP MFA',
        disableCta: 'Désactiver TOTP MFA',
        disableConfirmTitle: 'Désactiver TOTP MFA',
        disableConfirmBody: 'Après désactivation, les opérations sensibles ne nécessiteront plus de vérification TOTP.',
        disableConfirmCta: 'Confirmer la désactivation',
        disabledSuccess: 'TOTP MFA désactivé',
        setupChallengeRequired: 'TOTP MFA requis. Les codes de récupération TOTP sont distincts de la clé de récupération.',
        disableChallengeRequired: 'TOTP MFA requis.',
        initFailedFallback: "Échec de l'initialisation TOTP MFA",
        verifyFailedFallback: 'Échec de la vérification TOTP',
        disableFailedFallback: 'Échec de la désactivation TOTP MFA',
        enabledSuccess: 'TOTP MFA activé',
        setupModalTitle: 'Lier TOTP MFA',
        loadFailedFallback: 'Échec du chargement du statut MFA'
    },
    anonymous: {
        sectionTitle: 'Identité anonyme',
        sectionDescription: "Capacités d'anonymat, envoi public et statut d'anonymat renforcé.",
        readOnlyBody: "Les publications anonymes ne révèlent pas l'identité du compte.",
        publicChoiceBody: "L'envoi public nécessite un choix explicite sur la page de publication.",
        governanceHeading: 'Traitement des exceptions',
        zkStatusHeading: 'Anonymat renforcé',
        cardEnabled: 'Disponible',
        cardDisabled: 'Fermé',
        cardAvailable: "Possibilité d'action",
        cardUnavailable: 'Fermé',
        cardZkAvailable: 'Disponible',
        cardZkUnavailable: 'Fermé',
        cardZkConfigVisible: 'Commentaires anonymes standards disponibles.',
        cardZkConfigHidden: 'Fermé sur ce site.',
        defaultModeHint: "Choisissez d'afficher ou non le nom public sur la page de publication.",
        governanceHint: 'Les commentaires en infraction sont traités selon la politique du site.'
    },
    publicProfile: {
        sectionTitle: 'Profil public',
        sectionDescription: "Le nom public est utilisé uniquement pour l'envoi public.",
        draftLabel: 'Nom public',
        draftPlaceholder: "À remplir lors de l'envoi public de commentaires",
        optInCheckbox: "Afficher uniquement lors de l'envoi public",
        summaryAriaLabel: 'Statut du profil public',
        publicSendOptionLabel: "Option d'envoi public",
        publicSendOptionAvailable: 'Disponible',
        publicSendOptionUnavailable: 'Indisponible',
        saveCta: 'Enregistrer le nom public',
        savedSuccess: 'Nom public enregistré',
        clearedSuccess: 'Nom public retiré',
        saveFailedFallback: "Échec de l'enregistrement du nom public"
    },
    sessions: {
        sectionTitle: "Sessions d'appareils",
        sectionDescription: 'Sessions actives pour ce compte.',
        loading: 'Chargement des sessions',
        activeCount: {
            kind: 'plural',
            forms: {
                one: '{count} session active',
                many: '{count} sessions actives',
                other: '{count} sessions actives'
            }
        },
        revokeOthersCta: 'Déconnecter les autres appareils',
        currentDevice: 'Appareil actuel',
        otherDevice: 'Autre appareil',
        activeAtPrefix: 'Actif le : ',
        activeAtLabel: 'Dernière activité',
        createdAtLabel: 'Créé le',
        loginMethodLabel: "Méthode d'authentification",
        credentialLabel: "Clé d'accès",
        authenticationPasskey: "Clé d'accès",
        authenticationRecoveryKey: 'Clé de récupération',
        authenticationEnrollment: 'Inscription initiale',
        authenticationOther: 'Autre méthode',
        durationLabel: 'Durée de la session',
        durationPersistent: 'Rester connecté (30 jours)',
        durationBrowserSession: 'Déconnexion à la fermeture du navigateur',
        sessionTypeLabel: 'Session',
        revokeCta: 'Déconnecter',
        emptyTitle: 'Aucune session active',
        emptyContent: "Aucune session d'appareil.",
        revokeSuccess: "Session d'appareil déconnectée",
        revokeOthersSuccess: 'Autres sessions déconnectées',
        deviceFallback: "Aucune information d'appareil enregistrée",
        loadFailedFallback: 'Échec du chargement des sessions'
    },
    commentRecords: {
        sectionTitle: 'Historique des commentaires publics',
        sectionDescription: 'Les enregistrements du compte contiennent uniquement les publications publiques.',
        loading: "Chargement de l'historique des commentaires publics.",
        emptyTitle: 'Aucun commentaire public',
        emptyDescription: "Les commentaires envoyés publiquement apparaîtront ici ; les publications anonymes n'entrent pas dans l'historique du compte.",
        policyAriaLabel: 'Politique actuelle des commentaires',
        policyPublicSendLabel: 'Envoi public',
        policyAnonymousLabel: 'Commentaires anonymes',
        policyZkLabel: 'Anonymat renforcé',
        policyGovernanceLabel: 'Traitement des commentaires anonymes',
        policyOpen: 'Ouvert',
        policyClosed: 'Fermé',
        policyActive: 'Traité selon les règles',
        policyUnavailable: 'Fermé'
    },
    placeholder: {
        cardTitle: "Paramètres d'identité",
        sections: {
            UserIdentityOverview: {
                title: "Aperçu de l'identité",
                description: '',
                caption: "Statut de sécurité et paramètres d'identité publique.",
                body: "Clés d'accès, clé de récupération, TOTP, nom public et politiques de commentaires.",
                items: '["Statut des clés d\'accès", "Statut de la clé de récupération", "Identité anonyme et profil public", "Résumé des sessions"]'
            },
            UserIdentityPasskeys: {
                title: "Clés d'accès",
                description: 'Appareils de connexion.',
                caption: "Clés d'accès associées à ce compte.",
                body: 'Appareils enregistrés, renommage et suppression.',
                items: '["Appareils enregistrés", "Renommer un appareil", "Protection de la dernière clé d\'accès"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Clé de récupération',
                description: 'Identifiant de récupération de compte.',
                caption: 'Indépendante des codes de récupération TOTP.',
                body: 'Affichée une seule fois lors de la création ou de la rotation.',
                items: '["Créer une clé de récupération", "Remplacer la clé de récupération", "Récupérer la session pour lier une nouvelle clé d\'accès"]'
            },
            UserIdentityAnonymous: {
                title: 'Identité anonyme',
                description: 'Commentaires anonymes, envois publics, règles du site.',
                caption: "L'identité réelle du compte est masquée.",
                body: "Statut d'identité anonyme affiché selon la politique du site.",
                items: '["Mode anonyme par défaut", "Langue du nom affiché", "Statut des identifiants et groupe de réputation"]'
            },
            UserIdentityPublicProfile: {
                title: 'Profil public',
                description: "Informations d'identité publique.",
                caption: "Affichées uniquement lors de l'envoi public.",
                body: "Nom public, notes d'affichage et confirmation avant envoi.",
                items: '["Nom public", "Confirmation d\'envoi public", "Aperçu de l\'auteur du commentaire"]'
            },
            UserIdentitySessions: {
                title: "Sessions d'appareils",
                description: 'Sessions actives.',
                caption: 'Appareils de connexion pour le compte actuel.',
                body: "Appareil actuel, autres sessions actives et déconnexion d'appareils.",
                items: '["Appareil actuel", "Autres sessions actives", "Déconnecter les autres appareils"]'
            },
            UserIdentityMfa: {
                title: 'Double authentification',
                description: 'Statut TOTP.',
                caption: 'Vérification pour opérations sensibles ; ne remplace pas la récupération de compte.',
                body: 'Activation/désactivation MFA, génération de codes de récupération TOTP.',
                items: '["Activer MFA", "Désactiver MFA", "Régénérer les codes TOTP"]'
            }
        }
    },
    profile: {
        pageTitle: "Centre d'identité",
        pageDescription: 'Sécurité du compte, identifiants de récupération, profil public, commentaires anonymes.',
        emptyTitle: "Accéder au centre d'identité",
        emptyContent: "Clés d'accès, clé de récupération, TOTP, sessions, nom public, commentaires anonymes.",
        openIdentityCta: "Ouvrir le centre d'identité"
    },
    confirm: {
        deletePasskeyTitle: "Supprimer la clé d'accès",
        deletePasskeyBody: "Après suppression, cet appareil ne pourra plus utiliser cette clé d'accès pour se connecter.",
        rotateRecoveryKeyTitle: 'Remplacer la clé de récupération',
        rotateRecoveryKeyBody: "Après remplacement, l'ancienne clé de récupération deviendra invalide.",
        deleteAccountTitle: 'Supprimer le compte',
        deleteAccountBody: "La suppression convertit le compte en supprimé, effaçant le nom public, les sessions, les clés d'accès, la clé de récupération, les identifiants anonymes et les données TOTP. Le contenu publié ne sera pas supprimé automatiquement.",
        confirmButton: 'Confirmer',
        cancelButton: 'Annuler'
    },
    meta: {
        UserIdentityOverview: {
            title: "Aperçu de l'identité",
            description: ''
        },
        UserIdentityPasskeys: {
            title: "Clés d'accès",
            description: '',
        },
        UserIdentityRecoveryKey: {
            title: 'Clé de récupération',
            description: '',
        },
        UserIdentityAnonymous: {
            title: 'Identité anonyme',
            description: '',
        },
        UserIdentityPublicProfile: {
            title: 'Profil public',
            description: '',
        },
        UserIdentitySessions: {
            title: "Sessions d'appareils",
            description: '',
        },
        UserIdentityMfa: {
            title: 'Double authentification',
            description: '',
        },
        UserIdentityCommentRecords: {
            title: 'Historique des commentaires publics',
            description: 'Les enregistrements du compte contiennent uniquement les publications publiques.'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: "Aucune vérification d'opération sensible disponible pour ce compte. Ajoutez une clé d'accès ou activez TOTP d'abord.",
        passkeySensitiveOperationRequired: "Aucune vérification d'opération sensible disponible pour ce compte. Ajoutez une clé d'accès ou activez TOTP d'abord.",
        accountDeleteSensitiveOperationRequired: "Aucune vérification d'opération sensible disponible pour ce compte. Ajoutez une clé d'accès ou activez TOTP d'abord.",
        renameFailedFallback: "Échec du renommage de la clé d'accès",
        deleteFailedFallback: "Échec de la suppression de la clé d'accès",
        recoveryKeyFailedFallback: "Échec de l'opération sur la clé de récupération",
        accountDeleteFailedFallback: 'Échec de la suppression du compte',
        accountDeletedSuccess: 'Compte supprimé',
        recoveryKeyCreatedSuccess: 'Clé de récupération créée',
        recoveryKeyRotatedSuccess: 'Clé de récupération remplacée'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>
