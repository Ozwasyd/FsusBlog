import type { DeepStringShape } from '../keys'
import type { common as zhCNCommon } from '../zh-CN/common'

export const common = {
    actions: {
        save: 'Сохранить',
        cancel: 'Отмена',
        confirm: 'Подтвердить',
        retry: 'Повторить',
        delete: 'Удалить',
        refresh: 'Обновить',
        publish: 'Опубликовать',
        close: 'Закрыть',
        backHome: 'На главную'
    },
    locale: {
        toggleLabel: 'Switch to English',
        compactLabel: 'RU / EN',
        chinese: 'Китайский',
        english: 'English'
    },
    time: {
        unknown: 'Время неизвестно',
        invalid: 'Неверный формат времени',
        justNow: 'Только что'
    },
    routeTitles: {
        home: 'Главная',
        article: 'Статья',
        archive: 'Архив',
        about: 'О проекте',
        privacy: 'Политика конфиденциальности',
        guidelines: 'Правила сайта',
        copyright: 'Авторские права',
        search: 'Результаты поиска',
        login: 'Войти',
        register: 'Регистрация',
        recover: 'Восстановление доступа',
        account: 'Центр аккаунта',
        messages: 'Сообщения',
        dashboard: 'Панель управления',
        writeArticle: 'Написать статью',
        moderateComments: 'Модерация комментариев',
        settings: 'Настройки',
        forbidden: 'Доступ запрещён',
        notFound: 'Страница не найдена'
    }
} as const satisfies DeepStringShape<typeof zhCNCommon>
