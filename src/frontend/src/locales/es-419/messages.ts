export const localeDomainIdentity = Object.freeze({ locale: 'es-419', domain: 'messages' } as const);

import type { LocaleSchema } from '../keys';
import type { messages as zhCNMessages } from '../zh-CN/messages';

export const messages = {
    conversationList: {
        titleAccount: 'Mensajes',
        titleAdmin: 'Conversaciones activas',
        newTicketCta: 'Enviar solicitud',
        emptyTitleAccount: 'Sin mensajes del sitio',
        emptyTitleAdmin: 'Sin conversaciones pendientes',
        emptyDescriptionAccount: 'Notificaciones, mensajes del sistema y solicitudes de apelación.',
        emptyDescriptionAdmin: 'No hay mensajes que requieran acción con el filtro actual.',
        noContentAdmin: 'Sin contenido',
        noContentAccount: 'Sin contenido de mensajes',
        systemTag: 'Sistema',
        listAriaLabel: 'Lista de conversaciones',
        showMoreLabel: {
            kind: 'plural',
            forms: {
                one: 'Mostrar más conversaciones ({count})',
                many: 'Mostrar más conversaciones ({count})',
                other: 'Mostrar más conversaciones ({count})'
            }
        }
    },
    threadPanel: {
        backAriaLabel: 'Volver a la lista de conversaciones',
        backCta: 'Volver a la lista',
        titleFallback: 'Seleccionar conversación',
        titleFallbackAccount: 'Seleccionar conversación o enviar solicitud',
        titleFallbackAdmin: 'Seleccionar conversación',
        systemTag: 'Sistema',
        statusChangeWillNotify: 'Los cambios de estado notificarán al usuario',
        markOpen: 'Marcar como abierta',
        moveToPending: 'Mover a pendiente',
        closeConversation: 'Cerrar conversación',
        emptyDescriptionAccount: 'Detalles de la conversación y sección de respuesta.',
        emptyDescriptionAdmin: 'Conversación pendiente.',
        newTicketCta: 'Enviar solicitud',
        replyingToPrefix: 'Respondiendo a',
        accountContext: 'Conversación actual',
        accountContextAdmin: 'Cuenta {id}',
        statusPrefix: 'Estado',
        showOlder: 'Cargar mensajes anteriores',
        replyHeader: 'Responder a la conversación actual',
        replyLabel: 'Responder',
        replyLabelAccount: 'Responder al administrador',
        replyPlaceholder: 'Escriba su respuesta',
        replyCta: 'Enviar respuesta'
    },
    composePanel: {
        titleAdmin: 'Enviar mensaje del sistema',
        titleAccount: 'Enviar solicitud de apelación',
        targetAccountIdLabel: 'ID de cuenta destino',
        targetAccountIdPlaceholder: 'Ingrese el ID de cuenta',
        subjectLabel: 'Asunto',
        systemSubjectPlaceholder: 'Ej.: Notificación del sistema',
        accountSubjectPlaceholder: 'Ej.: Apelación de cuenta',
        bodyLabel: 'Contenido',
        bodyPlaceholderAdmin: 'Escriba el cuerpo del mensaje',
        bodyPlaceholderAccount: 'Describa el problema y la solicitud',
        submitAdminCta: 'Enviar mensaje del sistema',
        submitAccountCta: 'Enviar solicitud'
    },
    emptyState: {
        titleFallback: 'No hay conversaciones para mostrar'
    },
    filter: {
        open: 'Abiertas',
        pending: 'Pendientes',
        closed: 'Cerradas',
        system: 'Sistema',
        all: 'Todas',
        unread: 'No leídas',
        systemMessages: 'Mensajes del sistema'
    },
    status: {
        systemTag: 'Sistema'
    },
    errors: {
        loadFailed: 'Error al cargar mensajes',
        sendFailed: 'Error al enviar mensaje'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>;
