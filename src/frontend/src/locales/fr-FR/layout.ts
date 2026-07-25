import type { DeepStringShape } from '../keys'
import type { layout as zhCNLayout } from '../zh-CN/layout'

export const layout = {
    siteHeader: {
        ariaLabel: 'Navigation du site',
        navAriaLabel: 'Navigation principale',
        mobileNavMenuLabel: 'Menu',
        mobileUtilityAriaLabel: 'Affichage et compte',
        searchTriggerLabel: 'Rechercher',
        searchCancelLabel: 'Annuler',
        searchAriaLabel: 'Rechercher du contenu',
        searchPlaceholder: 'Rechercher articles, étiquettes ou mots-clés',
        fallbackTitle: 'Le blog de Fsu',
        fallbackDescription: "Notes d'ingénierie, tests de performance, systèmes UI et développement de FsusBlog.",
        fallbackKeywords: '.NET, Performance frontale, Conception système, Systèmes UI, Blog technique, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: 'Le blog de Fsu',
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: 'Articles populaires',
        leadEyebrow: 'À la une',
        feedEyebrow: 'Derniers articles',
        leadLoadingLabel: "Chargement de l'article principal",
        feedLoadingLabel: "Chargement de la liste d'articles",
        ariaReadFull: "Lire l'article : {title}",
        viewsUnit: 'vues'
    },
    themeMode: {
        label: 'Thème'
    }
} as const satisfies DeepStringShape<typeof zhCNLayout>
