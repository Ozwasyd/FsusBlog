export const localeDomainIdentity = Object.freeze({ locale: 'fr-FR', domain: 'auth' } as const);

import type { LocaleSchema } from '../keys';
import type { auth as zhCNAuth } from '../zh-CN/auth';

export const auth = {
    register: {
        title: 'Créer un compte anonyme',
        description: "Aucune adresse e-mail ni numéro de téléphone requis. Conservez votre clé de récupération et ajoutez une clé d'accès.",
        publicHandleHeading: 'Nom public',
        publicHandleLabel: 'Nom public (facultatif)',
        publicHandleHint: "Laissez vide pour générer un nom anonyme. Le TOTP peut être activé ultérieurement ; les codes de récupération TOTP sont distincts de la clé de récupération.",
        publicHandlePlaceholder: '3 à 20 caractères : lettres, chiffres, sinogrammes ou #',
        agreementPrefix: "J'ai lu et j'accepte les",
        guidelinesLink: "règles d'utilisation du site",
        submitButtonIdle: 'Créer le compte et la clé de récupération',
        submitButtonLoading: 'Création du compte en cours',
        passkeyEnrollmentTitle: "Ajouter la première clé d'accès",
        passkeyEnrollmentHint: "Le compte reste temporaire jusqu'à la vérification de la clé d'accès qui l'active et crée la session complète.",
        recoveryKeyTitle: 'Conservez la clé de récupération',
        recoveryKeyHint: "La clé de récupération n'est affichée qu'une seule fois. Sans elle ni clé d'accès fonctionnelle, le compte peut être irrécupérable.",
        recoveryKeyVersionPrefix: 'Clé de récupération v',
        recoveryKeyCreatedAtPrefix: 'Créée le : ',
        copyRecoveryKeyCta: 'Copier la clé de récupération',
        recoveryKeySavedCheckbox: "J'ai sauvegardé la clé de récupération",
        registerPasskeyCta: "Ajouter une clé d'accès",
        passkeyBoundTitle: "Clé d'accès ajoutée",
        passkeyBoundHint: "Utilisez la clé d'accès pour vous connecter et la clé de récupération pour récupérer le compte.",
        enterAccountCta: 'Accéder au compte',
        hasAccountLabel: 'Déjà un compte',
        loginLink: 'Connexion',
        cancelLink: "Retour à l'accueil"
    },
    login: {
        title: 'Connexion',
        description: 'Rédaction, commentaires et maintenance du site.',
        rememberMe: 'Se souvenir de cet appareil',
        passkeyButton: "Se connecter avec une clé d'accès",
        passkeyLoading: "En attente de l'appareil",
        passkeyHint: "Les comptes anonymes n'ont ni e-mail ni téléphone. Utilisez un appareil enregistré ou une clé de sécurité, ou récupérez l'accès avec la clé de récupération.",
        passkeyFailureHint: "Utilisez la clé de récupération si la vérification de l'appareil échoue.",
        recoverLink: "Récupérer l'accès avec une clé de récupération",
        mfaRequiredTitle: 'Double authentification requise',
        mfaRequiredHint: "Saisissez un code d'authentification ou un code de récupération.",
        mfaAriaLabel: 'Choisir la méthode de vérification',
        mfaModeTOTP: "Code d'authentification",
        mfaModeRecovery: 'Code de récupération',
        mfaCodeLabel: 'Code MFA',
        mfaCodePlaceholder: 'Code à 6 chiffres',
        mfaRecoveryLabel: 'Code de récupération',
        mfaRecoveryPlaceholder: 'Code de récupération',
        mfaSubmit: 'Vérifier',
        registerLink: 'Inscription',
        cancelLink: 'Annuler'
    },
    recover: {
        title: "Récupérer l'accès",
        description: 'Vérifiez la clé de récupération et ajoutez une nouvelle clé d\'accès.',
        sectionTitle: 'Clé de récupération',
        sectionHint: 'La clé de récupération restaure le compte et ne remplace pas un code de récupération TOTP.',
        keyLabel: 'Clé de récupération',
        keyPlaceholder: 'Collez la clé de récupération commençant par frk_',
        keyHelp: "Sans la clé de récupération ni clé d'accès fonctionnelle, le compte peut être irrécupérable.",
        revokePasskeys: "Révoquer les anciennes clés d'accès après la récupération",
        verifyCta: 'Vérifier la clé de récupération',
        sessionReadyHint: 'Clé de récupération vérifiée. La session de récupération expire le {expiresAt}. Ajoutez une nouvelle clé d\'accès.',
        bindNewPasskeyCta: "Ajouter une nouvelle clé d'accès",
        verifyFailedFallback: 'La vérification de la clé de récupération a échoué.',
        returnLoginLink: 'Retour à la connexion',
        cancelLink: 'Annuler'
    },
    policyModal: {
        fallbackTitle: 'Détails des conditions',
        privacyTitle: 'Politique de confidentialité',
        guidelinesTitle: "Règles d'utilisation",
        loadingStatus: 'Chargement du contenu',
        loadError: 'Le contenu des conditions est indisponible',
        retryCta: 'Réessayer',
        emptyStatePrefix: 'Aucun contenu ',
        emptyStateSuffix: " n'est configuré.",
        acknowledgementCta: "J'ai lu ce document",
        bodyAriaLabel: 'Texte des conditions'
    }
} as const satisfies LocaleSchema<typeof zhCNAuth>;
