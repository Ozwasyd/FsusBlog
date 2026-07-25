import type { DeepStringShape } from '../keys'
import type { common as zhCNCommon } from '../zh-CN/common'

export const common = {
    actions: {
        save: 'Salvar',
        cancel: 'Cancelar',
        confirm: 'Confirmar',
        retry: 'Tentar novamente',
        delete: 'Excluir',
        refresh: 'Atualizar',
        publish: 'Publicar',
        close: 'Fechar',
        backHome: 'Início'
    },
    locale: {
        toggleLabel: 'Mudar para chinês',
        compactLabel: '中 / EN',
        chinese: '中文',
        english: 'English'
    },
    time: {
        unknown: 'Horário desconhecido',
        invalid: 'Formato de horário inválido',
        justNow: 'Agora mesmo'
    },
    routeTitles: {
        home: 'Início',
        article: 'Detalhes do artigo',
        archive: 'Arquivo',
        about: 'Sobre',
        privacy: 'Política de privacidade',
        guidelines: 'Diretrizes do site',
        copyright: 'Declaração de direitos autorais',
        search: 'Resultados da busca',
        login: 'Entrar',
        register: 'Cadastrar',
        recover: 'Recuperar acesso',
        account: 'Central de identidade',
        messages: 'Minhas mensagens',
        dashboard: 'Painel',
        writeArticle: 'Escrever artigo',
        moderateComments: 'Moderação de comentários',
        settings: 'Configurações',
        forbidden: 'Acesso negado',
        notFound: 'Página não encontrada'
    }
} as const satisfies DeepStringShape<typeof zhCNCommon>
