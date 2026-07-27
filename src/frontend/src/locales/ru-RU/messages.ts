export const localeDomainIdentity = Object.freeze({ locale: 'ru-RU', domain: 'messages' } as const)

import type { LocaleSchema } from '../keys'
import type { messages as zhCNMessages } from '../zh-CN/messages'

export const messages = {
    conversationList: {
        titleAccount: 'Сообщения',
        titleAdmin: 'Активные обращения',
        newTicketCta: 'Создать обращение',
        emptyTitleAccount: 'Нет сообщений',
        emptyTitleAdmin: 'Нет ожидающих обращений',
        emptyDescriptionAccount: 'Уведомления, системные сообщения и обращения.',
        emptyDescriptionAdmin: 'Нет сообщений, требующих действий по текущему фильтру.',
        noContentAdmin: 'Нет содержания',
        noContentAccount: 'Нет сообщений',
        systemTag: 'Система',
        listAriaLabel: 'Список обращений',
        showMoreLabel: 'Показать ещё обращения ({n})'
    },
    threadPanel: {
        backAriaLabel: 'Вернуться к списку обращений',
        backCta: 'Вернуться к списку',
        titleFallback: 'Выберите обращение',
        titleFallbackAccount: 'Выберите обращение или создайте новое',
        titleFallbackAdmin: 'Выберите обращение',
        systemTag: 'Система',
        statusChangeWillNotify: 'Изменение статуса уведомит пользователя',
        markOpen: 'Взять в работу',
        moveToPending: 'Вернуть в ожидание',
        closeConversation: 'Закрыть обращение',
        emptyDescriptionAccount: 'Детали обращения и область ответа.',
        emptyDescriptionAdmin: 'Ожидающее обращение.',
        newTicketCta: 'Создать обращение',
        replyingToPrefix: 'Ответ на',
        accountContext: 'Текущее обращение',
        accountContextAdmin: 'Аккаунт {id}',
        statusPrefix: 'Статус',
        showOlder: 'Загрузить более старые сообщения',
        replyHeader: 'Ответить на обращение',
        replyLabel: 'Ответить',
        replyLabelAccount: 'Ответить администратору',
        replyPlaceholder: 'Введите текст ответа',
        replyCta: 'Отправить ответ'
    },
    composePanel: {
        titleAdmin: 'Отправить системное сообщение',
        titleAccount: 'Создать обращение',
        targetAccountIdLabel: 'ID целевого аккаунта',
        targetAccountIdPlaceholder: 'Введите ID аккаунта',
        subjectLabel: 'Тема',
        systemSubjectPlaceholder: 'Например: Системное уведомление',
        accountSubjectPlaceholder: 'Например: Обжалование блокировки',
        bodyLabel: 'Содержание',
        bodyPlaceholderAdmin: 'Введите текст сообщения',
        bodyPlaceholderAccount: 'Опишите проблему и желаемый результат',
        submitAdminCta: 'Отправить системное сообщение',
        submitAccountCta: 'Отправить обращение'
    },
    emptyState: {
        titleFallback: 'Нет обращений для отображения'
    },
    filter: {
        open: 'В работе',
        pending: 'Ожидает',
        closed: 'Закрыто',
        system: 'Система',
        all: 'Все',
        unread: 'Непрочитанные',
        systemMessages: 'Системные сообщения'
    },
    status: {
        systemTag: 'Система'
    },
    errors: {
        loadFailed: 'Не удалось загрузить сообщения',
        sendFailed: 'Не удалось отправить сообщение'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>
