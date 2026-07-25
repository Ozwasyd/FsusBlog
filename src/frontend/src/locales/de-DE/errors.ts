import type { DeepStringShape } from '../keys'
import type { errors as zhCNErrors } from '../zh-CN/errors'

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: 'Zugriff verweigert',
        description: 'Dieses Konto hat keinen Zugriff auf diesen Bereich.',
        homeCta: 'Zur Startseite',
        reLoginCta: 'Anderes Konto verwenden'
    },
    notFound: {
        codePrefix: '404',
        title: 'Seite nicht gefunden',
        description: 'Die Ressource wurde verschoben, entfernt oder existiert nicht.',
        homeCta: 'Zur Startseite',
        searchCta: 'Beiträge durchsuchen',
        archiveCta: 'Archiv'
    }
} as const satisfies DeepStringShape<typeof zhCNErrors>
