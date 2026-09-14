export const localeDomainIdentity = Object.freeze({ locale: 'fr-FR', domain: 'public' } as const);

import type { LocaleSchema } from '../keys';
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public';

export const publicMessages = {
    shell: {
        skipToMain: 'Aller au contenu',
        navigation: 'Navigation du site',
        primaryNavigation: 'Navigation principale',
        mobileMenu: 'Menu',
        mobileUtilities: 'Affichage et compte',
        search: 'Rechercher',
        searchCancel: 'Annuler',
        searchAria: 'Rechercher du contenu',
        searchPlaceholder: 'Rechercher articles, étiquettes ou mots-clés',
        searchPlaceholderShortcut: 'Rechercher articles, étiquettes ou mots-clés (Ctrl+K)',
        login: 'Connexion',
        account: 'Compte',
        dashboard: 'Tableau de bord',
        home: 'Accueil',
        archive: 'Archives',
        about: 'À propos',
        light: 'Clair',
        dark: 'Sombre',
        system: 'Système',
        lightShort: 'Clair',
        darkShort: 'Sombre',
        systemShort: 'Système'
    },
    footer: {
        rssAria: 'Ouvrir le flux RSS',
        licensePrefix: 'Sauf indication contraire, le contenu est sous licence',
        licenseSuffix: '.',
        licenseAria: 'Ouvrir la licence du contenu',
        policiesAria: 'Politiques du site',
        privacy: 'Confidentialité',
        guidelines: 'Règles',
        copyright: "Droits d'auteur",
        recordsAria: 'Enregistrements du site',
        policeBadgeAlt: 'Enregistrement de sécurité publique',
        icpAria: "Ouvrir le service d'enregistrement ICP",
        policeAria: 'Ouvrir la plateforme de sécurité publique',
        backToTop: 'Haut de page',
        backToTopAria: 'Retour en haut de page',
        ownerSeparator: '. ',
        allRightsReserved: 'Tous droits réservés.'
    },
    home: {
        loading: 'Chargement des articles',
        emptyTitle: 'Aucun article public',
        emptyDescription: 'Les articles publiés apparaîtront ici.',
        errorTitle: 'Les articles sont indisponibles',
        retry: 'Recharger'
    },
    archive: {
        title: 'Archives',
        publishedCount: {
            kind: 'plural',
            forms: {
                one: '{count} article publié',
                many: '{count} articles publiés',
                other: '{count} articles publiés'
            }
        },
        yearNavigation: 'Navigation par année',
        emptyDescription: 'Le contenu publié apparaîtra ici.'
    },
    filter: {
        scope: 'Périmètre : articles, étiquettes, mots-clés',
        result: 'Résultats : {state}',
        sort: 'Trier',
        sortAria: 'Tri des résultats de recherche',
        relevance: 'Pertinence',
        latest: 'Plus récent',
        hot: 'Popularité',
        previous: 'Précédent',
        next: 'Suivant',
        searching: 'Recherche en cours',
        unavailable: 'Cible de recherche indisponible',
        backHome: "Retour à l'accueil"
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>;
