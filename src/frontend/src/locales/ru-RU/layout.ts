import type { DeepStringShape } from '../keys'
import type { layout as zhCNLayout } from '../zh-CN/layout'

export const layout = {
    siteHeader: {
        ariaLabel: 'Навигация по сайту',
        navAriaLabel: 'Главное меню',
        mobileNavMenuLabel: 'Меню',
        mobileUtilityAriaLabel: 'Оформление и аккаунт',
        searchTriggerLabel: 'Поиск',
        searchCancelLabel: 'Отмена',
        searchAriaLabel: 'Поиск по сайту',
        searchPlaceholder: 'Поиск статей, тегов или ключевых слов',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: 'Технические заметки, тесты производительности, системы дизайна и разработка FsusBlog.',
        fallbackKeywords: '.NET, Производительность фронтенда, Системный дизайн, UI-системы, Технический блог, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: 'Популярные статьи',
        leadEyebrow: 'Рекомендуемое',
        feedEyebrow: 'Последние статьи',
        leadLoadingLabel: 'Загрузка рекомендуемой статьи',
        feedLoadingLabel: 'Загрузка списка статей',
        ariaReadFull: 'Читать полностью: {title}',
        viewsUnit: 'просмотров'
    },
    themeMode: {
        label: 'Тема оформления'
    }
} as const satisfies DeepStringShape<typeof zhCNLayout>
