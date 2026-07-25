import type { DeepStringShape } from '../keys'
import type { errors as zhCNErrors } from '../zh-CN/errors'

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: 'Acesso negado',
        description: 'A conta atual não tem permissão para acessar esta área.',
        homeCta: 'Início',
        reLoginCta: 'Usar outra conta'
    },
    notFound: {
        codePrefix: '404',
        title: 'Página não encontrada',
        description: 'O recurso foi movido, removido ou não existe.',
        homeCta: 'Início',
        searchCta: 'Buscar artigos',
        archiveCta: 'Ver arquivo'
    }
} as const satisfies DeepStringShape<typeof zhCNErrors>
