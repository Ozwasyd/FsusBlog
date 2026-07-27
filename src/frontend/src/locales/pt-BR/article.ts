export const localeDomainIdentity = Object.freeze({ locale: 'pt-BR', domain: 'article' } as const)

import type { LocaleSchema } from '../keys'
import type { article as zhCNArticle } from '../zh-CN/article'

export const article = {
    actions: {
        toc: 'Índice',
        tocAria: 'Índice do artigo',
        comments: 'Comentários',
        share: 'Compartilhar',
        top: 'Topo',
        copyLink: 'Copiar link',
        linkCopied: 'Link copiado',
        copyFailed: 'Falha ao copiar',
        copyCode: 'Copiar',
        codeCopied: 'Copiado',
        viewImage: 'Ver imagem',
        viewImageNamed: 'Ver imagem: {title}',
        closeImage: 'Fechar imagem',
        previousImage: 'Anterior',
        nextImage: 'Próxima',
        previousArticle: 'Artigo anterior',
        nextArticle: 'Próximo artigo',
        related: 'Leitura recomendada',
        read: 'Ler',
        readFull: 'Ler artigo completo: {title}',
        loadMoreComments: 'Carregar mais comentários',
        noMoreComments: 'Não há mais comentários'
    },
    metadata: {
        publishedAt: 'Publicado em',
        updatedAt: 'Atualizado em',
        wordsPrefix: 'Cerca de ',
        wordsSuffix: ' palavras',
        readingMinutesPrefix: 'Leitura de ',
        readingMinutesSuffix: ' min',
        longRead: 'Artigo longo',
        longReadAria: 'Aviso de leitura longa'
    },
    comments: {
        heading: 'Comentários dos leitores',
        empty: 'Nenhum comentário.',
        emptyTitle: 'Nenhum comentário',
        emptyDescription: 'Entre para participar da discussão.',
        loginCta: 'Entrar para comentar',
        safetyTitle: 'Concluir verificação de segurança do comentário',
        treeAria: 'Árvore de comentários'
    },
    content: {
        emptyAria: 'Corpo do artigo vazio',
        empty: 'Este artigo ainda não possui conteúdo.',
        tagsAria: 'Tags do artigo',
        rightsAria: 'Direitos autorais e citação',
        relatedAria: 'Artigos relacionados',
        coverAlt: '{title} — imagem de capa'
    }
} as const satisfies LocaleSchema<typeof zhCNArticle>
