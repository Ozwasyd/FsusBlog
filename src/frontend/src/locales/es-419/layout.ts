export const localeDomainIdentity = Object.freeze({ locale: 'es-419', domain: 'layout' } as const)

import type { LocaleSchema } from '../keys'
import type { layout as zhCNLayout } from '../zh-CN/layout'

export const layout = {
    siteHeader: {
        ariaLabel: 'Navegación del sitio',
        navAriaLabel: 'Navegación principal',
        mobileNavMenuLabel: 'Menú',
        mobileUtilityAriaLabel: 'Visualización y cuenta',
        searchTriggerLabel: 'Buscar',
        searchCancelLabel: 'Cancelar',
        searchAriaLabel: 'Buscar contenido',
        searchPlaceholder: 'Buscar artículos, etiquetas o palabras clave',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: 'Registros de ingeniería, pruebas de rendimiento, sistemas de diseño UI y desarrollo de FsusBlog.',
        fallbackKeywords: '.NET, Rendimiento frontend, Diseño de sistemas, Sistemas UI, Blog técnico, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: 'Artículos populares',
        leadEyebrow: 'Destacado',
        feedEyebrow: 'Últimos artículos',
        leadLoadingLabel: 'Cargando artículo destacado',
        feedLoadingLabel: 'Cargando lista de artículos',
        ariaReadFull: 'Leer artículo completo: {title}',
        viewCount: {
            kind: 'plural',
            forms: {
                one: '{count} vista',
                many: '{count} vistas',
                other: '{count} vistas'
            }
        }
    },
    themeMode: {
        label: 'Modo de tema'
    }
} as const satisfies LocaleSchema<typeof zhCNLayout>
