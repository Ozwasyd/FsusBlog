export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'common' } as const)

import type { LocaleSchema } from '../keys'
import type { common as zhCNCommon } from '../zh-CN/common'

export const common = {
    actions: {
        save: 'Speichern',
        cancel: 'Abbrechen',
        confirm: 'Bestätigen',
        retry: 'Wiederholen',
        delete: 'Löschen',
        refresh: 'Aktualisieren',
        publish: 'Veröffentlichen',
        close: 'Schließen',
        backHome: 'Zur Startseite'
    },
    time: {
        unknown: 'Zeit unbekannt',
        invalid: 'Ungültige Zeitangabe',
        justNow: 'Gerade eben'
    },
    routeTitles: {
        home: 'Startseite',
        article: 'Artikel',
        archive: 'Archiv',
        about: 'Über',
        privacy: 'Datenschutzerklärung',
        guidelines: 'Nutzungsrichtlinien',
        copyright: 'Urheberrecht',
        search: 'Suchergebnisse',
        login: 'Anmelden',
        register: 'Registrieren',
        recover: 'Zugriff wiederherstellen',
        account: 'Identitätscenter',
        messages: 'Meine Nachrichten',
        dashboard: 'Dashboard',
        writeArticle: 'Artikel schreiben',
        moderateComments: 'Kommentarmoderation',
        settings: 'Einstellungen',
        forbidden: 'Zugriff verweigert',
        notFound: 'Seite nicht gefunden'
    }
} as const satisfies LocaleSchema<typeof zhCNCommon>
