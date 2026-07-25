import type { DeepStringShape } from '../keys'
import type { article as zhCNArticle } from '../zh-CN/article'

export const article = {
    actions: {
        toc: 'Índice',
        tocAria: 'Índice del artículo',
        comments: 'Comentarios',
        share: 'Compartir',
        top: 'Arriba',
        copyLink: 'Copiar enlace',
        linkCopied: 'Enlace copiado',
        copyFailed: 'Error al copiar',
        copyCode: 'Copiar',
        codeCopied: 'Copiado',
        viewImage: 'Ver imagen',
        viewImageNamed: 'Ver imagen: {title}',
        closeImage: 'Cerrar imagen',
        previousImage: 'Anterior',
        nextImage: 'Siguiente',
        previousArticle: 'Artículo anterior',
        nextArticle: 'Artículo siguiente',
        related: 'Lecturas relacionadas',
        read: 'Leer',
        readFull: 'Leer artículo completo: {title}',
        loadMoreComments: 'Cargar más comentarios',
        noMoreComments: 'No hay más comentarios'
    },
    metadata: {
        publishedAt: 'Publicado el',
        updatedAt: 'Actualizado el',
        wordsPrefix: 'Aprox. ',
        wordsSuffix: 'palabras',
        readingMinutesPrefix: 'Lectura estimada: ',
        readingMinutesSuffix: 'min',
        longRead: 'Lectura extensa',
        longReadAria: 'Aviso de lectura extensa'
    },
    comments: {
        heading: 'Comentarios',
        empty: 'Sin comentarios.',
        emptyTitle: 'Sin comentarios',
        emptyDescription: 'Inicie sesión para participar en la discusión.',
        loginCta: 'Iniciar sesión para comentar',
        safetyTitle: 'Complete la verificación de seguridad',
        treeAria: 'Árbol de comentarios'
    },
    content: {
        emptyAria: 'El cuerpo del artículo está vacío',
        empty: 'Este artículo aún no tiene contenido',
        tagsAria: 'Etiquetas del artículo',
        rightsAria: 'Derechos de autor y cita',
        relatedAria: 'Artículos relacionados',
        coverAlt: '{title} — imagen de portada'
    }
} as const satisfies DeepStringShape<typeof zhCNArticle>
