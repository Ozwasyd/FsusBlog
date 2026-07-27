export const localeDomainIdentity = Object.freeze({ locale: 'fr-FR', domain: 'errors' } as const)

import type { LocaleSchema } from '../keys'
import type { errors as zhCNErrors } from '../zh-CN/errors'

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: 'Accès refusé',
        description: 'Ce compte ne dispose pas des droits nécessaires pour accéder à cette zone.',
        homeCta: "Retour à l'accueil",
        reLoginCta: 'Se reconnecter'
    },
    notFound: {
        codePrefix: '404',
        title: 'Page introuvable',
        description: "La ressource a été déplacée, supprimée ou n'existe pas.",
        homeCta: "Retour à l'accueil",
        searchCta: 'Rechercher des articles',
        archiveCta: 'Voir les archives'
    }
} as const satisfies LocaleSchema<typeof zhCNErrors>
