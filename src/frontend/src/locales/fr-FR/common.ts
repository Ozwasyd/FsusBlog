import type { DeepStringShape } from '../keys'
import type { common as zhCNCommon } from '../zh-CN/common'

export const common = {
    actions: {
        save: 'Enregistrer',
        cancel: 'Annuler',
        confirm: 'Confirmer',
        retry: 'Réessayer',
        delete: 'Supprimer',
        refresh: 'Actualiser',
        publish: 'Publier',
        close: 'Fermer',
        backHome: "Retour à l'accueil"
    },
    locale: {
        toggleLabel: 'Passer en chinois',
        compactLabel: 'FR / 中',
        chinese: '中文',
        english: 'English'
    },
    time: {
        unknown: 'Date inconnue',
        invalid: 'Format de date invalide',
        justNow: "À l'instant"
    },
    routeTitles: {
        home: 'Accueil',
        article: 'Article',
        archive: 'Archives',
        about: 'À propos',
        privacy: 'Politique de confidentialité',
        guidelines: "Règles d'utilisation",
        copyright: 'Mentions légales',
        search: 'Résultats de recherche',
        login: 'Connexion',
        register: 'Inscription',
        recover: "Récupérer l'accès",
        account: "Centre d'identité",
        messages: 'Mes messages',
        dashboard: 'Tableau de bord',
        writeArticle: 'Rédiger un article',
        moderateComments: 'Modération des commentaires',
        settings: 'Paramètres',
        forbidden: 'Accès refusé',
        notFound: 'Page introuvable'
    }
} as const satisfies DeepStringShape<typeof zhCNCommon>
