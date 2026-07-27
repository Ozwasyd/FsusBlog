export const localeDomainIdentity = Object.freeze({ locale: 'de-DE', domain: 'article' } as const)

import type { LocaleSchema } from '../keys'
import type { article as zhCNArticle } from '../zh-CN/article'

export const article = {
    actions: {
        toc: 'Inhaltsverzeichnis',
        tocAria: 'Artikelinhaltsverzeichnis',
        comments: 'Kommentare',
        share: 'Teilen',
        top: 'Nach oben',
        copyLink: 'Link kopieren',
        linkCopied: 'Link kopiert',
        copyFailed: 'Kopieren fehlgeschlagen',
        copyCode: 'Kopieren',
        codeCopied: 'Kopiert',
        viewImage: 'Bild anzeigen',
        viewImageNamed: 'Bild anzeigen: {title}',
        closeImage: 'Bild schließen',
        previousImage: 'Vorheriges',
        nextImage: 'Nächstes',
        previousArticle: 'Vorheriger Beitrag',
        nextArticle: 'Nächster Beitrag',
        related: 'Verwandte Beiträge',
        read: 'Lesen',
        readFull: 'Lesen: {title}',
        loadMoreComments: 'Weitere Kommentare laden',
        noMoreComments: 'Keine weiteren Kommentare'
    },
    metadata: {
        publishedAt: 'Veröffentlicht',
        updatedAt: 'Aktualisiert',
        wordCount: {
            kind: 'plural',
            forms: {
                one: '{count} Wort',
                other: '{count} Wörter'
            }
        },
        readingMinuteCount: {
            kind: 'plural',
            forms: {
                one: '{count} Min. Lesezeit',
                other: '{count} Min. Lesezeit'
            }
        },
        longRead: 'Langer Beitrag',
        longReadAria: 'Hinweis auf langen Beitrag'
    },
    comments: {
        heading: 'Leserkommentare',
        empty: 'Keine Kommentare.',
        emptyTitle: 'Keine Kommentare',
        emptyDescription: 'Melden Sie sich an, um an der Diskussion teilzunehmen.',
        loginCta: 'Anmelden zum Kommentieren',
        safetyTitle: 'Sicherheitsüberprüfung für Kommentare abschließen',
        treeAria: 'Kommentarbaum'
    },
    content: {
        emptyAria: 'Artikeltext ist leer',
        empty: 'Dieser Artikel hat noch keinen Textinhalt.',
        tagsAria: 'Artikel-Tags',
        rightsAria: 'Urheberrecht und Zitierung',
        relatedAria: 'Verwandte Artikel',
        coverAlt: '{title} — Titelbild'
    }
} as const satisfies LocaleSchema<typeof zhCNArticle>
