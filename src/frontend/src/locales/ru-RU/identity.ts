export const localeDomainIdentity = Object.freeze({ locale: 'ru-RU', domain: 'identity' } as const);

import type { LocaleSchema } from '../keys';
import type { identity as zhCNIdentity } from '../zh-CN/identity';

export const identity = {
    overview: {
        passkeyLabel: 'Ключ доступа',
        passkeyEnabled: 'Включено',
        passkeyDisabled: 'Не добавлено',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                one: '{count} устройство для входа',
                few: '{count} устройства для входа',
                many: '{count} устройств для входа',
                other: '{count} устройства для входа'
            }
        },
        recoveryKeyLabel: 'Recovery Key',
        recoveryKeyReady: 'Создан',
        recoveryKeyRequired: 'Не создан',
        recoveryKeyHint: 'Показывается один раз после создания или замены.',
        mfaLabel: 'TOTP (второй фактор)',
        mfaEnabled: 'Включено',
        mfaDisabled: 'Отключено',
        mfaHint: 'Для чувствительных операций; не для восстановления аккаунта.',
        anonymousLabel: 'Анонимные комментарии',
        anonymousCardAvailable: 'Доступно',
        anonymousCardClosed: 'Закрыто',
        zkAvailable: 'Усиленная анонимность доступна',
        zkUnavailable: 'Усиленная анонимность недоступна',
        sectionTitle: 'Текущие настройки',
        sectionDescription: '',
        publicHandleLabel: 'Публичное имя',
        publicHandleEmpty: 'Публичное имя не задано',
        anonymousPolicyLabel: 'Анонимные комментарии',
        anonymousPolicyAllowed: 'По умолчанию анонимно; публичная отправка требует явного выбора.',
        anonymousPolicyClosed: 'Анонимные комментарии на сайте закрыты.',
        publicSendOptionLabel: 'Публичная отправка',
        publicSendOptionAllowed: 'Возможность показывать публичное имя при комментировании.',
        publicSendOptionClosed: 'Публичная отправка на сайте отключена.',
        lifecycleTitle: 'Жизненный цикл аккаунта',
        lifecycleDescription: 'Перед удалением аккаунта требуется проверка чувствительной операции.',
        lifecycleWarning: 'Удаление аккаунта преобразует его в удалённый, очищая публичное имя, сессии, ключи доступа, Recovery Key, анонимные учётные данные и данные TOTP. Опубликованное содержимое не будет удалено автоматически.',
        deleteAccountCta: 'Удалить аккаунт'
    },
    passkeys: {
        sectionTitle: 'Ключи доступа',
        sectionDescription: 'Ключи доступа, связанные с этим аккаунтом.',
        loading: 'Загрузка ключей доступа',
        emptyTitle: 'Нет добавленных ключей',
        emptyContent: 'Добавьте ключи для аутентификации устройства.',
        addCta: 'Добавить ключ доступа',
        nameInputAriaLabel: 'Название ключа доступа',
        saveCta: 'Сохранить',
        cancelCta: 'Отмена',
        editCta: 'Изменить',
        deleteCta: 'Удалить',
        nameEmpty: 'Безымянный ключ доступа',
        createdAtLabel: 'Создан',
        activeAtLabel: 'Активен',
        activeNeverRecorded: 'Не зафиксирован',
        backupModeLabel: 'Резервное копирование',
        backupEligible: 'Поддерживает синхронизацию',
        backupIneligible: 'Только на этом устройстве',
        recoverySuggestion: 'Зарегистрирован только один ключ без резервного копирования. Рекомендуется добавить ещё один ключ или создать Recovery Key.'
    },
    recoveryKey: {
        sectionTitle: 'Recovery Key',
        sectionDescription: 'Учётные данные для восстановления аккаунта; показываются один раз.',
        sectionHint: 'Сохраните сразу после создания или замены; повторно показан не будет. При утере без работающего ключа доступа аккаунт невозможно восстановить.',
        loading: 'Обработка',
        panelVersionPrefix: 'Recovery Key v',
        panelCreatedAtPrefix: 'Создан: ',
        savedCheckbox: 'Я сохранил(а) Recovery Key',
        closeOnceCta: 'Закрыть',
        createCta: 'Создать Recovery Key',
        rotateCta: 'Заменить Recovery Key'
    },
    mfa: {
        sectionTitle: 'TOTP (второй фактор)',
        sectionDescription: 'Проверка чувствительных операций; восстановление аккаунта — через Recovery Key.',
        loading: 'Загрузка статуса двухфакторной аутентификации',
        enabled: 'TOTP включён',
        disabled: 'TOTP отключён',
        lastVerifiedPrefix: 'Последняя проверка',
        lastVerifiedEmpty: 'Нет записей о недавней проверке',
        enableCta: 'Включить TOTP',
        disableCta: 'Отключить TOTP',
        disableConfirmTitle: 'Отключить TOTP',
        disableConfirmBody: 'После отключения чувствительные операции не будут требовать TOTP-проверки.',
        disableConfirmCta: 'Подтвердить отключение',
        disabledSuccess: 'TOTP отключён',
        setupChallengeRequired: 'Требуется TOTP-проверка. Коды восстановления TOTP отличаются от Recovery Key.',
        disableChallengeRequired: 'Требуется TOTP-проверка.',
        initFailedFallback: 'Не удалось инициализировать TOTP',
        verifyFailedFallback: 'Проверка TOTP не удалась',
        disableFailedFallback: 'Не удалось отключить TOTP',
        enabledSuccess: 'TOTP включён',
        setupModalTitle: 'Привязка TOTP',
        loadFailedFallback: 'Не удалось загрузить статус MFA'
    },
    anonymous: {
        sectionTitle: 'Анонимная идентификация',
        sectionDescription: 'Возможности анонимности, публичная отправка и статус усиленной анонимности.',
        readOnlyBody: 'Анонимные сообщения не раскрывают идентификацию аккаунта.',
        publicChoiceBody: 'Публичная отправка требует явного выбора на странице публикации.',
        governanceHeading: 'Обработка нарушений',
        zkStatusHeading: 'Усиленная анонимность',
        cardEnabled: 'Доступно',
        cardDisabled: 'Закрыто',
        cardAvailable: 'Доступно',
        cardUnavailable: 'Закрыто',
        cardZkAvailable: 'Доступно',
        cardZkUnavailable: 'Закрыто',
        cardZkConfigVisible: 'Обычные анонимные комментарии доступны.',
        cardZkConfigHidden: 'Закрыто на этом сайте.',
        defaultModeHint: 'Выберите, показывать ли публичное имя на странице публикации.',
        governanceHint: 'Нарушающие правила комментарии обрабатываются согласно политике сайта.'
    },
    publicProfile: {
        sectionTitle: 'Публичный профиль',
        sectionDescription: 'Публичное имя используется только для публичной отправки.',
        draftLabel: 'Публичное имя',
        draftPlaceholder: 'Заполняется при публичной отправке комментариев',
        optInCheckbox: 'Показывать только при публичной отправке',
        summaryAriaLabel: 'Статус публичного профиля',
        publicSendOptionLabel: 'Публичная отправка',
        publicSendOptionAvailable: 'Доступно',
        publicSendOptionUnavailable: 'Недоступно',
        saveCta: 'Сохранить публичное имя',
        savedSuccess: 'Публичное имя сохранено',
        clearedSuccess: 'Публичное имя удалено',
        saveFailedFallback: 'Не удалось сохранить публичное имя'
    },
    sessions: {
        sectionTitle: 'Сессии устройств',
        sectionDescription: 'Активные сессии устройств этого аккаунта.',
        loading: 'Загрузка сессий устройств',
        activeCount: {
            kind: 'plural',
            forms: {
                one: '{count} активная сессия',
                few: '{count} активные сессии',
                many: '{count} активных сессий',
                other: '{count} активной сессии'
            }
        },
        revokeOthersCta: 'Завершить сессии на других устройствах',
        currentDevice: 'Текущее устройство',
        otherDevice: 'Другое устройство',
        activeAtPrefix: 'Активен: ',
        activeAtLabel: 'Последняя активность',
        createdAtLabel: 'Создана',
        loginMethodLabel: 'Способ аутентификации',
        credentialLabel: 'Ключ доступа',
        authenticationPasskey: 'Ключ доступа',
        authenticationRecoveryKey: 'Recovery Key',
        authenticationEnrollment: 'Первичная регистрация',
        authenticationOther: 'Другой способ',
        durationLabel: 'Длительность сессии',
        durationPersistent: 'Оставаться в системе (30 дней)',
        durationBrowserSession: 'Выход при закрытии браузера',
        sessionTypeLabel: 'Сессия',
        revokeCta: 'Завершить',
        emptyTitle: 'Нет активных сессий',
        emptyContent: 'Нет сессий устройств.',
        revokeSuccess: 'Сессия устройства завершена',
        revokeOthersSuccess: 'Сессии других устройств завершены',
        deviceFallback: 'Информация об устройстве не записана',
        loadFailedFallback: 'Не удалось загрузить сессии устройств'
    },
    commentRecords: {
        sectionTitle: 'Записи публичных комментариев',
        sectionDescription: 'Записи аккаунта содержат только публичные сообщения.',
        loading: 'Загрузка записей публичных комментариев.',
        emptyTitle: 'Нет записей публичных комментариев',
        emptyDescription: 'Публичные комментарии появятся здесь; анонимные сообщения не попадают в записи аккаунта.',
        policyAriaLabel: 'Текущая политика комментариев',
        policyPublicSendLabel: 'Публичная отправка',
        policyAnonymousLabel: 'Анонимные комментарии',
        policyZkLabel: 'Усиленная анонимность',
        policyGovernanceLabel: 'Обработка анонимных комментариев',
        policyOpen: 'Открыто',
        policyClosed: 'Закрыто',
        policyActive: 'По правилам',
        policyUnavailable: 'Недоступно'
    },
    placeholder: {
        cardTitle: 'Настройки идентификации',
        sections: {
            UserIdentityOverview: {
                title: 'Обзор идентификации',
                description: '',
                caption: 'Статус безопасности и настройки публичной идентификации.',
                body: 'Ключи доступа, Recovery Key, TOTP, публичное имя и политики комментариев.',
                items: '["Статус ключей доступа", "Статус Recovery Key", "Анонимная идентификация и публичный профиль", "Сводка сессий"]'
            },
            UserIdentityPasskeys: {
                title: 'Ключи доступа',
                description: 'Устройства для входа.',
                caption: 'Ключи доступа, связанные с этим аккаунтом.',
                body: 'Зарегистрированные устройства, переименование и удаление.',
                items: '["Зарегистрированные устройства", "Переименование устройства", "Защита от удаления последнего ключа"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Recovery Key',
                description: 'Учётные данные для восстановления аккаунта.',
                caption: 'Не зависит от кодов восстановления TOTP.',
                body: 'Показывается один раз при создании или замене.',
                items: '["Создать Recovery Key", "Заменить Recovery Key", "Восстановить сессию для привязки нового ключа"]'
            },
            UserIdentityAnonymous: {
                title: 'Анонимная идентификация',
                description: 'Анонимные комментарии, публичные сообщения, правила сайта.',
                caption: 'Реальная идентификация аккаунта скрыта.',
                body: 'Статус анонимной идентификации согласно политике сайта.',
                items: '["Режим анонимности по умолчанию", "Язык отображаемого имени", "Статус учётных данных и группа репутации"]'
            },
            UserIdentityPublicProfile: {
                title: 'Публичный профиль',
                description: 'Публичная информация идентификации.',
                caption: 'Отображается только при публичной отправке.',
                body: 'Публичное имя, примечания и подтверждение перед отправкой.',
                items: '["Публичное имя", "Подтверждение публичной отправки", "Предпросмотр автора комментария"]'
            },
            UserIdentitySessions: {
                title: 'Сессии устройств',
                description: 'Активные сессии устройств.',
                caption: 'Устройства входа для текущего аккаунта.',
                body: 'Текущее устройство, другие активные сессии и завершение сессий.',
                items: '["Текущее устройство", "Другие активные сессии", "Завершить сессии других устройств"]'
            },
            UserIdentityMfa: {
                title: 'Двухфакторная аутентификация',
                description: 'Статус TOTP.',
                caption: 'Проверка чувствительных операций; не для восстановления аккаунта.',
                body: 'Включение и отключение MFA, генерация кодов восстановления TOTP.',
                items: '["Включить MFA", "Отключить MFA", "Пересоздать коды восстановления TOTP"]'
            }
        }
    },
    profile: {
        pageTitle: 'Центр идентификации',
        pageDescription: 'Безопасность аккаунта, учётные данные восстановления, публичный профиль, анонимные комментарии.',
        emptyTitle: 'Перейти в центр идентификации',
        emptyContent: 'Ключи доступа, Recovery Key, TOTP, сессии устройств, публичное имя, анонимные комментарии.',
        openIdentityCta: 'Открыть центр идентификации'
    },
    confirm: {
        deletePasskeyTitle: 'Удалить ключ доступа',
        deletePasskeyBody: 'После удаления это устройство не сможет использовать данный ключ для входа.',
        rotateRecoveryKeyTitle: 'Заменить Recovery Key',
        rotateRecoveryKeyBody: 'После замены старый Recovery Key станет недействительным.',
        deleteAccountTitle: 'Удалить аккаунт',
        deleteAccountBody: 'Удаление аккаунта преобразует его в удалённый, очищая публичное имя, сессии, ключи доступа, Recovery Key, анонимные учётные данные и данные TOTP. Опубликованное содержимое не будет удалено автоматически.',
        confirmButton: 'Подтвердить',
        cancelButton: 'Отмена'
    },
    meta: {
        UserIdentityOverview: {
            title: 'Обзор идентификации',
            description: ''
        },
        UserIdentityPasskeys: {
            title: 'Ключи доступа',
            description: ''
        },
        UserIdentityRecoveryKey: {
            title: 'Recovery Key',
            description: ''
        },
        UserIdentityAnonymous: {
            title: 'Анонимная идентификация',
            description: ''
        },
        UserIdentityPublicProfile: {
            title: 'Публичный профиль',
            description: ''
        },
        UserIdentitySessions: {
            title: 'Сессии устройств',
            description: ''
        },
        UserIdentityMfa: {
            title: 'Двухфакторная аутентификация',
            description: ''
        },
        UserIdentityCommentRecords: {
            title: 'Записи публичных комментариев',
            description: 'Записи аккаунта содержат только публичные сообщения.'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: 'Для этого аккаунта недоступна проверка чувствительных операций. Сначала добавьте ключ доступа или включите TOTP.',
        passkeySensitiveOperationRequired: 'Для этого аккаунта недоступна проверка чувствительных операций. Сначала добавьте ключ доступа или включите TOTP.',
        accountDeleteSensitiveOperationRequired: 'Для этого аккаунта недоступна проверка чувствительных операций. Сначала добавьте ключ доступа или включите TOTP.',
        renameFailedFallback: 'Не удалось переименовать ключ доступа',
        deleteFailedFallback: 'Не удалось удалить ключ доступа',
        recoveryKeyFailedFallback: 'Операция с Recovery Key не удалась',
        accountDeleteFailedFallback: 'Не удалось удалить аккаунт',
        accountDeletedSuccess: 'Аккаунт удалён',
        recoveryKeyCreatedSuccess: 'Recovery Key создан',
        recoveryKeyRotatedSuccess: 'Recovery Key заменён'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>;
