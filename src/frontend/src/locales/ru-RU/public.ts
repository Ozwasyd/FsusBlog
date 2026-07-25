import type { DeepStringShape } from '../keys'
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public'

export const publicMessages = {
    shell: {
        skipToMain: 'К содержанию',
        navigation: 'Навигация по сайту',
        primaryNavigation: 'Главное меню',
        mobileMenu: 'Меню',
        mobileUtilities: 'Оформление и аккаунт',
        search: 'Поиск',
        searchCancel: 'Отмена',
        searchAria: 'Поиск по сайту',
        searchPlaceholder: 'Поиск статей, тегов или ключевых слов',
        searchPlaceholderShortcut: 'Поиск статей, тегов или ключевых слов (Ctrl+K)',
        login: 'Войти',
        account: 'Аккаунт',
        dashboard: 'Панель управления',
        home: 'Главная',
        archive: 'Архив',
        about: 'О проекте',
        light: 'Светлая',
        dark: 'Тёмная',
        system: 'Системная',
        lightShort: 'Свет',
        darkShort: 'Тьма',
        systemShort: 'Сист'
    },
    footer: {
        rssAria: 'Открыть RSS-ленту',
        licensePrefix: 'Если не указано иное, содержание распространяется по лицензии',
        licenseSuffix: '.',
        licenseAria: 'Открыть лицензию',
        policiesAria: 'Политики сайта',
        privacy: 'Конфиденциальность',
        guidelines: 'Правила',
        copyright: 'Авторские права',
        recordsAria: 'Регистрационные данные',
        policeBadgeAlt: 'Регистрация в органах безопасности',
        icpAria: 'Открыть систему регистрации ICP',
        policeAria: 'Открыть платформу регистрации',
        backToTop: 'Наверх',
        backToTopAria: 'Вернуться к началу страницы',
        ownerSeparator: '. ',
        allRightsReserved: 'Все права защищены.'
    },
    home: {
        loading: 'Загрузка статей',
        emptyTitle: 'Нет опубликованных статей',
        emptyDescription: 'Опубликованные статьи появятся здесь.',
        errorTitle: 'Статьи недоступны',
        retry: 'Обновить'
    },
    archive: {
        title: 'Архив',
        publishedCount: 'Опубликовано: {count}',
        yearNavigation: 'Навигация по годам',
        emptyDescription: 'Опубликованные статьи появятся здесь.'
    },
    filter: {
        scope: 'Поиск: статьи, теги, ключевые слова',
        result: 'Результаты: {state}',
        sort: 'Сортировка',
        sortAria: 'Сортировка результатов поиска',
        relevance: 'По релевантности',
        latest: 'По новизне',
        hot: 'По популярности',
        previous: 'Предыдущая',
        next: 'Следующая',
        searching: 'Поиск',
        unavailable: 'Поиск недоступен',
        backHome: 'На главную'
    }
} as const satisfies DeepStringShape<typeof zhCNPublicMessages>
