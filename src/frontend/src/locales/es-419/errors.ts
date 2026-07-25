import type { DeepStringShape } from '../keys'
import type { errors as zhCNErrors } from '../zh-CN/errors'

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: 'Acceso denegado',
        description: 'Esta cuenta no tiene acceso a esta área.',
        homeCta: 'Inicio',
        reLoginCta: 'Usar otra cuenta'
    },
    notFound: {
        codePrefix: '404',
        title: 'Página no encontrada',
        description: 'El recurso se movió, fue eliminado o no existe.',
        homeCta: 'Inicio',
        searchCta: 'Buscar artículos',
        archiveCta: 'Archivo'
    }
} as const satisfies DeepStringShape<typeof zhCNErrors>
