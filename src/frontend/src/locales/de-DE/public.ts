export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'public' } as const);

import type { LocaleSchema } from '../keys';
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public';

export const publicMessages = {
    shell: {
        skipToMain: 'Zum Inhalt springen',
        navigation: 'Site-Navigation',
        primaryNavigation: 'Hauptnavigation',
        mobileMenu: 'Menü',
        mobileUtilities: 'Anzeige und Konto',
        search: 'Suche',
        searchCancel: 'Abbrechen',
        searchAria: 'Inhalt durchsuchen',
        searchPlaceholder: 'Beiträge, Tags oder Stichwörter durchsuchen',
        searchPlaceholderShortcut: 'Beiträge, Tags oder Stichwörter durchsuchen (Strg+K)',
        login: 'Anmelden',
        account: 'Konto',
        dashboard: 'Dashboard',
        home: 'Startseite',
        archive: 'Archiv',
        about: 'Über',
        light: 'Hell',
        dark: 'Dunkel',
        system: 'System',
        lightShort: 'Hell',
        darkShort: 'Dunkel',
        systemShort: 'System'
    },
    footer: {
        rssAria: 'RSS-Feed öffnen',
        licensePrefix: 'Sofern nicht anders angegeben, stehen die Inhalte unter der',
        licenseSuffix: '-Lizenz.',
        licenseAria: 'Inhaltslizenz öffnen',
        policiesAria: 'Site-Richtlinien',
        privacy: 'Datenschutz',
        guidelines: 'Richtlinien',
        copyright: 'Urheberrecht',
        recordsAria: 'Site-Registrierungen',
        policeBadgeAlt: 'Behördliche Registrierung',
        icpAria: 'ICP-Registrierungsdienst öffnen',
        policeAria: 'Behördlichen Registrierungsdienst öffnen',
        backToTop: 'Nach oben',
        backToTopAria: 'Zurück zum Seitenanfang',
        ownerSeparator: '. ',
        allRightsReserved: 'Alle Rechte vorbehalten.'
    },
    home: {
        loading: 'Beiträge werden geladen',
        emptyTitle: 'Keine öffentlichen Beiträge',
        emptyDescription: 'Veröffentlichte Beiträge erscheinen hier.',
        errorTitle: 'Beiträge sind nicht verfügbar',
        retry: 'Neu laden'
    },
    archive: {
        title: 'Archiv',
        publishedCount: {
            kind: 'plural',
            forms: {
                one: '{count} Beitrag veröffentlicht',
                other: '{count} Beiträge veröffentlicht'
            }
        },
        yearNavigation: 'Nach Jahr durchsuchen',
        emptyDescription: 'Veröffentlichte Beiträge erscheinen hier.'
    },
    filter: {
        scope: 'Bereich: Beiträge, Tags und Stichwörter',
        result: 'Ergebnisse: {state}',
        sort: 'Sortierung',
        sortAria: 'Suchergebnissortierung',
        relevance: 'Relevanz',
        latest: 'Neueste',
        hot: 'Beliebt',
        previous: 'Vorherige',
        next: 'Nächste',
        searching: 'Suche läuft',
        unavailable: 'Suchziel nicht verfügbar',
        backHome: 'Zur Startseite'
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>;
