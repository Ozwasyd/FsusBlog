export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'layout' } as const)

import type { LocaleSchema } from '../keys'
import type { layout as zhCNLayout } from '../zh-CN/layout'

export const layout = {
    siteHeader: {
        ariaLabel: 'Site-Navigation',
        navAriaLabel: 'Hauptnavigation',
        mobileNavMenuLabel: 'Menü',
        mobileUtilityAriaLabel: 'Anzeige und Konto',
        searchTriggerLabel: 'Suche',
        searchCancelLabel: 'Abbrechen',
        searchAriaLabel: 'Inhalt durchsuchen',
        searchPlaceholder: 'Beiträge, Tags oder Stichwörter durchsuchen',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: 'Entwicklungsprotokolle, Leistungstests, UI-Designsysteme und FsusBlog-Entwicklung.',
        fallbackKeywords: '.NET, Frontend-Performance, Systemdesign, UI-Systeme, Tech-Blog, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: 'Beliebte Beiträge',
        leadEyebrow: 'Empfohlen',
        feedEyebrow: 'Neueste Beiträge',
        leadLoadingLabel: 'Empfohlenen Beitrag laden',
        feedLoadingLabel: 'Beitragsliste laden',
        ariaReadFull: 'Ganzen Beitrag lesen: {title}',
        viewsUnit: 'Aufrufe'
    },
    themeMode: {
        label: 'Theme-Modus'
    }
} as const satisfies LocaleSchema<typeof zhCNLayout>
