export const localeDomainIdentity = Object.freeze({ locale: 'ru-RU', domain: 'common' } as const);

import type { LocaleSchema } from '../keys';
import type { common as zhCNCommon } from '../zh-CN/common';

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
    },
    loading: {
        status: 'Загрузка',
        statusWithSite: 'Загрузка {siteTitle}'
    }
} as const satisfies LocaleSchema<typeof zhCNCommon>;
