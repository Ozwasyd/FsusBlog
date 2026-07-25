import type { DeepStringShape } from '../keys'
import type { layout as zhCNLayout } from '../zh-CN/layout'

export const layout = {
    siteHeader: {
        ariaLabel: 'Navegação do site',
        navAriaLabel: 'Navegação principal',
        mobileNavMenuLabel: 'Menu',
        mobileUtilityAriaLabel: 'Exibição e conta',
        searchTriggerLabel: 'Buscar',
        searchCancelLabel: 'Cancelar',
        searchAriaLabel: 'Buscar conteúdo',
        searchPlaceholder: 'Buscar artigos, tags ou palavras-chave',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: 'Registros de engenharia, benchmarks de performance, sistemas de UI e desenvolvimento do FsusBlog.',
        fallbackKeywords: '.NET, Performance frontend, Design de sistemas, Sistemas de UI, Blog técnico, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: 'Posts populares',
        leadEyebrow: 'Destaque',
        feedEyebrow: 'Posts recentes',
        leadLoadingLabel: 'Carregando destaque',
        feedLoadingLabel: 'Carregando lista de posts',
        ariaReadFull: 'Ler post completo: {title}',
        viewsUnit: ' visualizações'
    },
    themeMode: {
        label: 'Modo de tema'
    }
} as const satisfies DeepStringShape<typeof zhCNLayout>
