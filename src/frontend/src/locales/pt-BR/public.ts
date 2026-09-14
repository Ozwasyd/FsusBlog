export const localeDomainIdentity = Object.freeze({ locale: 'pt-BR', domain: 'public' } as const);

import type { LocaleSchema } from '../keys';
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public';

export const publicMessages = {
    shell: {
        skipToMain: 'Pular para o conteúdo',
        navigation: 'Navegação do site',
        primaryNavigation: 'Navegação principal',
        mobileMenu: 'Menu',
        mobileUtilities: 'Exibição e conta',
        search: 'Buscar',
        searchCancel: 'Cancelar',
        searchAria: 'Buscar conteúdo',
        searchPlaceholder: 'Buscar artigos, tags ou palavras-chave',
        searchPlaceholderShortcut: 'Buscar artigos, tags ou palavras-chave (Ctrl+K)',
        login: 'Entrar',
        account: 'Conta',
        dashboard: 'Painel',
        home: 'Início',
        archive: 'Arquivo',
        about: 'Sobre',
        light: 'Claro',
        dark: 'Escuro',
        system: 'Sistema',
        lightShort: 'Claro',
        darkShort: 'Escuro',
        systemShort: 'Sistema'
    },
    footer: {
        rssAria: 'Abrir feed RSS',
        licensePrefix: 'Exceto onde indicado, o conteúdo está licenciado sob',
        licenseSuffix: '.',
        licenseAria: 'Abrir licença de conteúdo',
        policiesAria: 'Políticas do site',
        privacy: 'Privacidade',
        guidelines: 'Diretrizes',
        copyright: 'Direitos autorais',
        recordsAria: 'Registros do site',
        policeBadgeAlt: 'Registro de segurança pública',
        icpAria: 'Abrir sistema de registro ICP',
        policeAria: 'Abrir plataforma de registro de segurança pública',
        backToTop: 'Topo',
        backToTopAria: 'Voltar ao topo',
        ownerSeparator: '. ',
        allRightsReserved: 'Todos os direitos reservados.'
    },
    home: {
        loading: 'Carregando artigos',
        emptyTitle: 'Nenhum artigo público',
        emptyDescription: 'Os artigos publicados aparecerão aqui.',
        errorTitle: 'Artigos indisponíveis',
        retry: 'Recarregar'
    },
    archive: {
        title: 'Arquivo',
        publishedCount: {
            kind: 'plural',
            forms: {
                one: '{count} artigo publicado',
                many: '{count} artigos publicados',
                other: '{count} artigos publicados'
            }
        },
        yearNavigation: 'Navegar por ano',
        emptyDescription: 'Os artigos publicados aparecerão aqui.'
    },
    filter: {
        scope: 'Escopo: artigos, tags e palavras-chave',
        result: 'Resultados: {state}',
        sort: 'Ordenar',
        sortAria: 'Ordenação dos resultados da busca',
        relevance: 'Relevância',
        latest: 'Mais recentes',
        hot: 'Populares',
        previous: 'Anterior',
        next: 'Próximo',
        searching: 'Buscando',
        unavailable: 'Alvo da busca indisponível',
        backHome: 'Início'
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>;
