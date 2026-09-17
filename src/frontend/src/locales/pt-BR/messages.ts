export const localeDomainIdentity = Object.freeze({ locale: 'pt-BR', domain: 'messages' } as const);

import type { LocaleSchema } from '../keys';
import type { messages as zhCNMessages } from '../zh-CN/messages';

export const messages = {
    conversationList: {
        titleAccount: 'Mensagens',
        titleAdmin: 'Conversas ativas',
        newTicketCta: 'Enviar chamado',
        emptyTitleAccount: 'Nenhuma mensagem',
        emptyTitleAdmin: 'Nenhuma conversa pendente',
        emptyDescriptionAccount: 'Notificações, mensagens do sistema e chamados de recurso.',
        emptyDescriptionAdmin: 'Nenhuma mensagem requer ação no filtro atual.',
        noContentAdmin: 'Sem conteúdo',
        noContentAccount: 'Nenhum conteúdo de mensagem',
        systemTag: 'Sistema',
        listAriaLabel: 'Lista de conversas',
        showMoreLabel: {
            kind: 'plural',
            forms: {
                one: 'Mostrar mais conversas ({count})',
                many: 'Mostrar mais conversas ({count})',
                other: 'Mostrar mais conversas ({count})'
            }
        }
    },
    threadPanel: {
        backAriaLabel: 'Voltar para lista de conversas',
        backCta: 'Voltar para lista de conversas',
        titleFallback: 'Selecionar conversa',
        titleFallbackAccount: 'Selecionar conversa ou enviar chamado',
        titleFallbackAdmin: 'Selecionar conversa',
        systemTag: 'Sistema',
        statusChangeWillNotify: 'Mudanças de status notificarão o usuário',
        markOpen: 'Marcar como em andamento',
        moveToPending: 'Mover para pendente',
        closeConversation: 'Fechar conversa',
        emptyDescriptionAccount: 'Detalhes da conversa e área de resposta.',
        emptyDescriptionAdmin: 'Conversa pendente.',
        newTicketCta: 'Enviar chamado',
        replyingToPrefix: 'Respondendo a',
        accountContext: 'Conversa atual',
        accountContextAdmin: 'Conta {id}',
        statusPrefix: 'Status',
        showOlder: 'Carregar mensagens anteriores',
        replyHeader: 'Responder à conversa atual',
        replyLabel: 'Responder',
        replyLabelAccount: 'Responder ao administrador',
        replyPlaceholder: 'Digite a resposta',
        replyCta: 'Enviar resposta'
    },
    composePanel: {
        titleAdmin: 'Enviar mensagem do sistema',
        titleAccount: 'Enviar chamado de recurso',
        targetAccountIdLabel: 'ID da conta de destino',
        targetAccountIdPlaceholder: 'Digite o ID da conta',
        subjectLabel: 'Assunto',
        systemSubjectPlaceholder: 'Ex.: Notificação do sistema',
        accountSubjectPlaceholder: 'Ex.: Recurso de conta',
        bodyLabel: 'Conteúdo',
        bodyPlaceholderAdmin: 'Digite o corpo da mensagem',
        bodyPlaceholderAccount: 'Descreva o problema e a solicitação',
        submitAdminCta: 'Enviar mensagem do sistema',
        submitAccountCta: 'Enviar chamado'
    },
    emptyState: {
        titleFallback: 'Nenhuma conversa para exibir'
    },
    filter: {
        open: 'Em andamento',
        pending: 'Pendente',
        closed: 'Fechado',
        system: 'Sistema',
        all: 'Todas',
        unread: 'Não lidas',
        systemMessages: 'Mensagens do sistema'
    },
    status: {
        systemTag: 'Sistema'
    },
    errors: {
        loadFailed: 'Falha ao carregar mensagens',
        sendFailed: 'Falha ao enviar mensagem'
    }
} as const satisfies LocaleSchema<typeof zhCNMessages>;
