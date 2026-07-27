export const localeDomainIdentity = Object.freeze({ locale: 'es-419', domain: 'identity' } as const)

import type { LocaleSchema } from '../keys'
import type { identity as zhCNIdentity } from '../zh-CN/identity'

export const identity = {
    overview: {
        passkeyLabel: 'Llave de acceso',
        passkeyEnabled: 'Activada',
        passkeyDisabled: 'No registrada',
        passkeyDeviceCount: {
            kind: 'plural',
            forms: {
                one: '{count} dispositivo de inicio de sesión',
                many: '{count} dispositivos de inicio de sesión',
                other: '{count} dispositivos de inicio de sesión'
            }
        },
        recoveryKeyLabel: 'Clave de recuperación',
        recoveryKeyReady: 'Generada',
        recoveryKeyRequired: 'No creada',
        recoveryKeyHint: 'Se muestra una sola vez tras la creación o rotación.',
        mfaLabel: 'TOTP (segundo factor)',
        mfaEnabled: 'Activado',
        mfaDisabled: 'Desactivado',
        mfaHint: 'Usado para operaciones sensibles; no para recuperación de cuenta.',
        anonymousLabel: 'Comentarios anónimos',
        anonymousCardAvailable: 'Disponible',
        anonymousCardClosed: 'Cerrado',
        zkAvailable: 'Anonimato mejorado disponible',
        zkUnavailable: 'Anonimato mejorado cerrado',
        sectionTitle: 'Configuración actual',
        sectionDescription: '',
        publicHandleLabel: 'Nombre público',
        publicHandleEmpty: 'No se ha establecido un nombre público',
        anonymousPolicyLabel: 'Comentarios anónimos',
        anonymousPolicyAllowed: 'Anónimo por defecto; el envío público requiere selección explícita.',
        anonymousPolicyClosed: 'Los comentarios anónimos están cerrados en este sitio.',
        publicSendOptionLabel: 'Envío público',
        publicSendOptionAllowed: 'Opción de mostrar el nombre público al comentar.',
        publicSendOptionClosed: 'El envío público está desactivado en este sitio.',
        lifecycleTitle: 'Ciclo de vida de la cuenta',
        lifecycleDescription: 'Se requiere verificación de operación sensible antes de eliminar la cuenta.',
        lifecycleWarning: 'La eliminación de cuenta la convierte en eliminada, removiendo nombre público, sesiones, llaves de acceso, clave de recuperación, credenciales anónimas y datos TOTP. El contenido publicado no se eliminará automáticamente.',
        deleteAccountCta: 'Eliminar cuenta'
    },
    passkeys: {
        sectionTitle: 'Dispositivos con llave de acceso',
        sectionDescription: 'Llaves de acceso asociadas a esta cuenta.',
        loading: 'Cargando llaves de acceso',
        emptyTitle: 'No hay llaves de acceso registradas',
        emptyContent: 'Registre llaves de acceso para autenticación de dispositivos.',
        addCta: 'Registrar llave de acceso',
        nameInputAriaLabel: 'Nombre de la llave de acceso',
        saveCta: 'Guardar',
        cancelCta: 'Cancelar',
        editCta: 'Editar',
        deleteCta: 'Eliminar',
        nameEmpty: 'Llave de acceso sin nombre',
        createdAtLabel: 'Creada',
        activeAtLabel: 'Última actividad',
        activeNeverRecorded: 'Sin registro',
        backupModeLabel: 'Respaldo',
        backupEligible: 'Respaldo por sincronización compatible',
        backupIneligible: 'Solo este dispositivo',
        recoverySuggestion: 'Solo hay una llave de acceso sin respaldo registrada. Considere registrar otra llave o crear una clave de recuperación.'
    },
    recoveryKey: {
        sectionTitle: 'Clave de recuperación',
        sectionDescription: 'Credencial de recuperación de cuenta; se muestra una sola vez.',
        sectionHint: 'Guárdela inmediatamente tras la creación o rotación; no se mostrará de nuevo. Si se pierde sin una llave de acceso activa, la cuenta no podrá recuperarse.',
        loading: 'Procesando',
        panelVersionPrefix: 'Clave de recuperación v',
        panelCreatedAtPrefix: 'Generada: ',
        savedCheckbox: 'He guardado mi clave de recuperación',
        closeOnceCta: 'Cerrar',
        createCta: 'Crear clave de recuperación',
        rotateCta: 'Rotar clave de recuperación'
    },
    mfa: {
        sectionTitle: 'Verificación TOTP',
        sectionDescription: 'Verificación de operaciones sensibles; la recuperación de cuenta usa la clave de recuperación.',
        loading: 'Cargando estado de verificación en dos pasos',
        enabled: 'TOTP activado',
        disabled: 'TOTP desactivado',
        lastVerifiedPrefix: 'Última verificación',
        lastVerifiedEmpty: 'Sin verificación reciente registrada',
        enableCta: 'Activar verificación TOTP',
        disableCta: 'Desactivar verificación TOTP',
        disableConfirmTitle: 'Desactivar verificación TOTP',
        disableConfirmBody: 'Tras desactivarla, las operaciones sensibles ya no requerirán verificación TOTP.',
        disableConfirmCta: 'Confirmar desactivación',
        disabledSuccess: 'Verificación TOTP desactivada',
        setupChallengeRequired: 'Se requiere completar la verificación TOTP. Los códigos de recuperación TOTP son distintos de la clave de recuperación.',
        disableChallengeRequired: 'Se requiere completar la verificación TOTP.',
        initFailedFallback: 'Error al inicializar la verificación TOTP',
        verifyFailedFallback: 'Falló la verificación TOTP',
        disableFailedFallback: 'Error al desactivar la verificación TOTP',
        enabledSuccess: 'Verificación TOTP activada',
        setupModalTitle: 'Vincular verificación TOTP',
        loadFailedFallback: 'Error al cargar el estado de verificación'
    },
    anonymous: {
        sectionTitle: 'Identidad anónima',
        sectionDescription: 'Capacidades de anonimato, envío público y estado de anonimato mejorado.',
        readOnlyBody: 'Las publicaciones anónimas no revelan la identidad de la cuenta.',
        publicChoiceBody: 'El envío público requiere elección explícita en la página de publicación.',
        governanceHeading: 'Manejo de excepciones',
        zkStatusHeading: 'Anonimato mejorado',
        cardEnabled: 'Disponible',
        cardDisabled: 'Cerrado',
        cardAvailable: 'Procesable',
        cardUnavailable: 'Cerrado',
        cardZkAvailable: 'Disponible',
        cardZkUnavailable: 'Cerrado',
        cardZkConfigVisible: 'Comentarios anónimos estándar disponibles.',
        cardZkConfigHidden: 'Cerrado en este sitio.',
        defaultModeHint: 'Elija si mostrar el nombre público en la página de publicación.',
        governanceHint: 'Los comentarios infractores se manejan según la política del sitio.'
    },
    publicProfile: {
        sectionTitle: 'Perfil público',
        sectionDescription: 'El nombre público solo se usa para envíos públicos.',
        draftLabel: 'Nombre público',
        draftPlaceholder: 'Complete al enviar comentarios públicos',
        optInCheckbox: 'Mostrar solo al enviar públicamente',
        summaryAriaLabel: 'Estado del perfil público',
        publicSendOptionLabel: 'Opción de envío público',
        publicSendOptionAvailable: 'Disponible',
        publicSendOptionUnavailable: 'No disponible',
        saveCta: 'Guardar nombre público',
        savedSuccess: 'Nombre público guardado',
        clearedSuccess: 'Nombre público eliminado',
        saveFailedFallback: 'Error al guardar el nombre público'
    },
    sessions: {
        sectionTitle: 'Sesiones de dispositivos',
        sectionDescription: 'Sesiones activas de esta cuenta.',
        loading: 'Cargando sesiones',
        activeCount: {
            kind: 'plural',
            forms: {
                one: '{count} sesión activa',
                many: '{count} sesiones activas',
                other: '{count} sesiones activas'
            }
        },
        revokeOthersCta: 'Cerrar sesión en otros dispositivos',
        currentDevice: 'Dispositivo actual',
        otherDevice: 'Otro dispositivo',
        activeAtPrefix: 'Activo: ',
        activeAtLabel: 'Última actividad',
        createdAtLabel: 'Creado',
        loginMethodLabel: 'Método de autenticación',
        credentialLabel: 'Llave de acceso',
        authenticationPasskey: 'Llave de acceso',
        authenticationRecoveryKey: 'Clave de recuperación',
        authenticationEnrollment: 'Registro inicial',
        authenticationOther: 'Otro método',
        durationLabel: 'Duración de la sesión',
        durationPersistent: 'Mantener sesión (30 días)',
        durationBrowserSession: 'Cerrar al salir del navegador',
        sessionTypeLabel: 'Sesión',
        revokeCta: 'Cerrar sesión',
        emptyTitle: 'Sin sesiones activas',
        emptyContent: 'No hay sesiones de dispositivos.',
        revokeSuccess: 'Sesión cerrada',
        revokeOthersSuccess: 'Sesiones de otros dispositivos cerradas',
        deviceFallback: 'Sin información de dispositivo registrada',
        loadFailedFallback: 'Error al cargar las sesiones'
    },
    commentRecords: {
        sectionTitle: 'Historial de comentarios públicos',
        sectionDescription: 'El historial de la cuenta solo contiene publicaciones públicas.',
        loading: 'Cargando historial de comentarios públicos.',
        emptyTitle: 'Sin comentarios públicos registrados',
        emptyDescription: 'Los comentarios enviados públicamente aparecerán aquí; las publicaciones anónimas no se registran en la cuenta.',
        policyAriaLabel: 'Política de comentarios actual',
        policyPublicSendLabel: 'Envío público',
        policyAnonymousLabel: 'Comentarios anónimos',
        policyZkLabel: 'Anonimato mejorado',
        policyGovernanceLabel: 'Manejo de comentarios anónimos',
        policyOpen: 'Abierto',
        policyClosed: 'Cerrado',
        policyActive: 'Manejado según reglas',
        policyUnavailable: 'Cerrado'
    },
    placeholder: {
        cardTitle: 'Configuración de identidad',
        sections: {
            UserIdentityOverview: {
                title: 'Resumen de identidad',
                description: '',
                caption: 'Estado de seguridad y configuración de identidad pública.',
                body: 'Llaves de acceso, clave de recuperación, TOTP, nombre público y políticas de comentarios.',
                items: '["Estado de llave de acceso", "Estado de clave de recuperación", "Identidad anónima y perfil público", "Resumen de sesiones"]'
            },
            UserIdentityPasskeys: {
                title: 'Llaves de acceso',
                description: 'Dispositivos de inicio de sesión.',
                caption: 'Llaves de acceso asociadas a esta cuenta.',
                body: 'Dispositivos registrados, cambio de nombre y eliminación.',
                items: '["Dispositivos registrados", "Renombrar dispositivo", "Protección al eliminar última llave"]'
            },
            UserIdentityRecoveryKey: {
                title: 'Clave de recuperación',
                description: 'Credencial de recuperación de cuenta.',
                caption: 'Independiente de los códigos de recuperación TOTP.',
                body: 'Se muestra una sola vez al crear o rotar.',
                items: '["Crear clave de recuperación", "Rotar credencial de recuperación", "Sesión de recuperación para nueva llave de acceso"]'
            },
            UserIdentityAnonymous: {
                title: 'Identidad anónima',
                description: 'Comentarios anónimos, publicaciones públicas, reglas del sitio.',
                caption: 'La identidad real de la cuenta permanece oculta.',
                body: 'El estado de identidad anónima se muestra según la política del sitio.',
                items: '["Modo anónimo por defecto", "Idioma del nombre mostrado", "Estado de credencial y grupo de reputación"]'
            },
            UserIdentityPublicProfile: {
                title: 'Perfil público',
                description: 'Información de identidad pública.',
                caption: 'Se muestra solo al enviar públicamente.',
                body: 'Nombre público, notas de visualización y confirmación antes del envío.',
                items: '["Nombre público", "Confirmación de envío público", "Vista previa del autor del comentario"]'
            },
            UserIdentitySessions: {
                title: 'Sesiones de dispositivos',
                description: 'Sesiones activas.',
                caption: 'Dispositivos con sesión iniciada en esta cuenta.',
                body: 'Dispositivo actual, otras sesiones activas y cierre de sesiones.',
                items: '["Dispositivo actual", "Otras sesiones activas", "Cerrar otros dispositivos"]'
            },
            UserIdentityMfa: {
                title: 'Verificación en dos pasos',
                description: 'Estado de TOTP.',
                caption: 'Verificación de operaciones sensibles; no para recuperación de cuenta.',
                body: 'Activación/desactivación de verificación, generación de códigos de recuperación TOTP.',
                items: '["Activar verificación", "Desactivar verificación", "Regenerar códigos de recuperación TOTP"]'
            }
        }
    },
    profile: {
        pageTitle: 'Centro de identidad',
        pageDescription: 'Seguridad de cuenta, credenciales de recuperación, perfil público, comentarios anónimos.',
        emptyTitle: 'Ir al centro de identidad',
        emptyContent: 'Llaves de acceso, clave de recuperación, TOTP, sesiones, nombre público, comentarios anónimos.',
        openIdentityCta: 'Abrir centro de identidad'
    },
    confirm: {
        deletePasskeyTitle: 'Eliminar llave de acceso',
        deletePasskeyBody: 'Tras eliminarla, este dispositivo no podrá usarse para iniciar sesión con esta llave.',
        rotateRecoveryKeyTitle: 'Rotar clave de recuperación',
        rotateRecoveryKeyBody: 'Tras la rotación, la clave de recuperación anterior quedará invalidada.',
        deleteAccountTitle: 'Eliminar cuenta',
        deleteAccountBody: 'La eliminación convierte la cuenta en eliminada, removiendo nombre público, sesiones, llaves de acceso, clave de recuperación, credenciales anónimas y datos TOTP. El contenido publicado no se eliminará automáticamente.',
        confirmButton: 'Confirmar',
        cancelButton: 'Cancelar'
    },
    meta: {
        UserIdentityOverview: {
            title: 'Resumen de identidad',
            description: ''
        },
        UserIdentityPasskeys: {
            title: 'Llaves de acceso',
            description: 'Dispositivos de inicio de sesión.'
        },
        UserIdentityRecoveryKey: {
            title: 'Clave de recuperación',
            description: 'Credencial de recuperación de cuenta.'
        },
        UserIdentityAnonymous: {
            title: 'Identidad anónima',
            description: 'Comentarios anónimos, publicaciones públicas, reglas del sitio.'
        },
        UserIdentityPublicProfile: {
            title: 'Perfil público',
            description: 'Información de identidad pública.'
        },
        UserIdentitySessions: {
            title: 'Sesiones de dispositivos',
            description: 'Sesiones activas.'
        },
        UserIdentityMfa: {
            title: 'Verificación en dos pasos',
            description: 'Estado de TOTP.'
        },
        UserIdentityCommentRecords: {
            title: 'Historial de comentarios públicos',
            description: 'El historial solo contiene publicaciones públicas.'
        }
    },
    errors: {
        recoveryKeySensitiveOperationRequired: 'No hay verificación de operación sensible disponible para esta cuenta. Registre una llave de acceso o active TOTP primero.',
        passkeySensitiveOperationRequired: 'No hay verificación de operación sensible disponible para esta cuenta. Registre una llave de acceso o active TOTP primero.',
        accountDeleteSensitiveOperationRequired: 'No hay verificación de operación sensible disponible para esta cuenta. Registre una llave de acceso o active TOTP primero.',
        renameFailedFallback: 'Error al renombrar la llave de acceso',
        deleteFailedFallback: 'Error al eliminar la llave de acceso',
        recoveryKeyFailedFallback: 'Error en la operación de clave de recuperación',
        accountDeleteFailedFallback: 'Error al eliminar la cuenta',
        accountDeletedSuccess: 'Cuenta eliminada',
        recoveryKeyCreatedSuccess: 'Clave de recuperación creada',
        recoveryKeyRotatedSuccess: 'Clave de recuperación rotada'
    }
} as const satisfies LocaleSchema<typeof zhCNIdentity>
