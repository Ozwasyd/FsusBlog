import type { DeepStringShape } from '../keys'
import type { article as zhCNArticle } from '../zh-CN/article'

export const article = {
    actions: {
        toc: 'Sommaire',
        tocAria: 'Table des matières',
        comments: 'Commentaires',
        share: 'Partager',
        top: 'Haut',
        copyLink: 'Copier le lien',
        linkCopied: 'Lien copié',
        copyFailed: 'Échec de la copie',
        copyCode: 'Copier',
        codeCopied: 'Copié',
        viewImage: "Voir l'image",
        viewImageNamed: "Voir l'image : {title}",
        closeImage: "Fermer l'image",
        previousImage: 'Précédente',
        nextImage: 'Suivante',
        previousArticle: 'Article précédent',
        nextArticle: 'Article suivant',
        related: 'Articles connexes',
        read: 'Lire',
        readFull: 'Lire : {title}',
        loadMoreComments: 'Charger plus de commentaires',
        noMoreComments: 'Pas plus de commentaires'
    },
    metadata: {
        publishedAt: 'Publié le',
        updatedAt: 'Mis à jour le',
        wordsPrefix: 'Environ ',
        wordsSuffix: ' mots',
        readingMinutesPrefix: 'Lecture de ',
        readingMinutesSuffix: ' min',
        longRead: 'Article long',
        longReadAria: "Indication d'article long"
    },
    comments: {
        heading: 'Commentaires des lecteurs',
        empty: 'Aucun commentaire.',
        emptyTitle: 'Aucun commentaire',
        emptyDescription: 'Connectez-vous pour participer à la discussion.',
        loginCta: 'Se connecter pour commenter',
        safetyTitle: 'Vérification de sécurité pour commentaire',
        treeAria: 'Arbre des commentaires'
    },
    content: {
        emptyAria: "Le corps de l'article est vide",
        empty: "Cet article n'a pas encore de contenu.",
        tagsAria: "Étiquettes de l'article",
        rightsAria: "Droits d'auteur et citation",
        relatedAria: 'Articles connexes',
        coverAlt: '{title} — image de couverture'
    }
} as const satisfies DeepStringShape<typeof zhCNArticle>
