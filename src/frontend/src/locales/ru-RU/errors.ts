export const localeDomainIdentity = Object.freeze({ locale: 'ru-RU', domain: 'errors' } as const)

import type { LocaleSchema } from '../keys'
import type { errors as zhCNErrors } from '../zh-CN/errors'

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: 'Доступ запрещён',
        description: 'У текущего аккаунта недостаточно прав для доступа к этой области.',
        homeCta: 'На главную',
        reLoginCta: 'Войти под другим аккаунтом'
    },
    notFound: {
        codePrefix: '404',
        title: 'Страница не найдена',
        description: 'Ресурс перемещён, удалён или не существует.',
        homeCta: 'На главную',
        searchCta: 'Поиск статей',
        archiveCta: 'Архив'
    }
} as const satisfies LocaleSchema<typeof zhCNErrors>
