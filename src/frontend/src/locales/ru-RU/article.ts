export const localeDomainIdentity = Object.freeze({ locale: 'ru-RU', domain: 'article' } as const)

import type { LocaleSchema } from '../keys'
import type { article as zhCNArticle } from '../zh-CN/article'

export const article = {
    actions: {
        toc: 'Содержание',
        tocAria: 'Содержание статьи',
        comments: 'Комментарии',
        share: 'Поделиться',
        top: 'Наверх',
        copyLink: 'Копировать ссылку',
        linkCopied: 'Ссылка скопирована',
        copyFailed: 'Не удалось скопировать',
        copyCode: 'Копировать',
        codeCopied: 'Скопировано',
        viewImage: 'Посмотреть изображение',
        viewImageNamed: 'Посмотреть: {title}',
        closeImage: 'Закрыть изображение',
        previousImage: 'Предыдущее',
        nextImage: 'Следующее',
        previousArticle: 'Предыдущая статья',
        nextArticle: 'Следующая статья',
        related: 'Похожие',
        read: 'Читать',
        readFull: 'Читать: {title}',
        loadMoreComments: 'Загрузить ещё комментарии',
        noMoreComments: 'Комментариев больше нет'
    },
    metadata: {
        publishedAt: 'Опубликовано',
        updatedAt: 'Обновлено',
        wordsPrefix: '',
        wordsSuffix: 'слов',
        readingMinutesPrefix: '',
        readingMinutesSuffix: 'мин. чтения',
        longRead: 'Длинная статья',
        longReadAria: 'Длинная статья'
    },
    comments: {
        heading: 'Комментарии читателей',
        empty: 'Пока нет комментариев.',
        emptyTitle: 'Нет комментариев',
        emptyDescription: 'Войдите, чтобы участвовать в обсуждении.',
        loginCta: 'Войти, чтобы комментировать',
        safetyTitle: 'Пройдите проверку безопасности',
        treeAria: 'Дерево комментариев'
    },
    content: {
        emptyAria: 'Текст статьи пуст',
        empty: 'У этой статьи пока нет текста.',
        tagsAria: 'Теги статьи',
        rightsAria: 'Авторские права и цитирование',
        relatedAria: 'Похожие статьи',
        coverAlt: '{title} — обложка'
    }
} as const satisfies LocaleSchema<typeof zhCNArticle>
