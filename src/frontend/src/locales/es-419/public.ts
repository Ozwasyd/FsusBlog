export const localeDomainIdentity = Object.freeze({ locale: 'es-419', domain: 'public' } as const)

import type { LocaleSchema } from '../keys'
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public'

export const publicMessages = {
    shell: {
        skipToMain: 'Saltar al contenido',
        navigation: 'Navegación del sitio',
        primaryNavigation: 'Navegación principal',
        mobileMenu: 'Menú',
        mobileUtilities: 'Visualización y cuenta',
        search: 'Buscar',
        searchCancel: 'Cancelar',
        searchAria: 'Buscar contenido',
        searchPlaceholder: 'Buscar artículos, etiquetas o palabras clave',
        searchPlaceholderShortcut: 'Buscar artículos, etiquetas o palabras clave (Ctrl+K)',
        login: 'Iniciar sesión',
        account: 'Cuenta',
        dashboard: 'Panel de control',
        home: 'Inicio',
        archive: 'Archivo',
        about: 'Acerca de',
        light: 'Claro',
        dark: 'Oscuro',
        system: 'Sistema',
        lightShort: 'Claro',
        darkShort: 'Oscuro',
        systemShort: 'Sistema'
    },
    footer: {
        rssAria: 'Abrir fuente RSS',
        licensePrefix: 'Salvo indicación contraria, el contenido está bajo licencia',
        licenseSuffix: '.',
        licenseAria: 'Abrir licencia de contenido',
        policiesAria: 'Políticas del sitio',
        privacy: 'Privacidad',
        guidelines: 'Normas',
        copyright: 'Derechos de autor',
        recordsAria: 'Registros del sitio',
        policeBadgeAlt: 'Registro de seguridad pública',
        icpAria: 'Abrir sistema de registro ICP',
        policeAria: 'Abrir plataforma de registro de seguridad pública',
        backToTop: 'Arriba',
        backToTopAria: 'Volver al inicio de la página',
        ownerSeparator: '. ',
        allRightsReserved: 'Todos los derechos reservados.'
    },
    home: {
        loading: 'Cargando artículos',
        emptyTitle: 'Sin artículos públicos',
        emptyDescription: 'Los artículos publicados aparecerán aquí.',
        errorTitle: 'Artículos no disponibles',
        retry: 'Recargar'
    },
    archive: {
        title: 'Archivo',
        publishedCount: {
            kind: 'plural',
            forms: {
                one: '{count} artículo publicado',
                many: '{count} artículos publicados',
                other: '{count} artículos publicados'
            }
        },
        yearNavigation: 'Navegar por año',
        emptyDescription: 'El contenido publicado aparecerá aquí.'
    },
    filter: {
        scope: 'Alcance: artículos, etiquetas y palabras clave',
        result: 'Resultados: {state}',
        sort: 'Ordenar',
        sortAria: 'Orden de resultados',
        relevance: 'Relevancia',
        latest: 'Más recientes',
        hot: 'Populares',
        previous: 'Anterior',
        next: 'Siguiente',
        searching: 'Buscando',
        unavailable: 'Búsqueda no disponible',
        backHome: 'Inicio'
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>
