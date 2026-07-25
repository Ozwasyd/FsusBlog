import type { DeepStringShape } from '../keys'
import type { common as zhCNCommon } from '../zh-CN/common'

export const common = {
    actions: {
        save: 'Guardar',
        cancel: 'Cancelar',
        confirm: 'Confirmar',
        retry: 'Reintentar',
        delete: 'Eliminar',
        refresh: 'Actualizar',
        publish: 'Publicar',
        close: 'Cerrar',
        backHome: 'Volver al inicio'
    },
    locale: {
        toggleLabel: 'Cambiar a inglés',
        compactLabel: '中 / EN',
        chinese: '中文',
        english: 'English'
    },
    time: {
        unknown: 'Fecha desconocida',
        invalid: 'Formato de fecha inválido',
        justNow: 'Justo ahora'
    },
    routeTitles: {
        home: 'Inicio',
        article: 'Detalle del artículo',
        archive: 'Archivo',
        about: 'Acerca de',
        privacy: 'Política de privacidad',
        guidelines: 'Normas del sitio',
        copyright: 'Derechos de autor',
        search: 'Resultados de búsqueda',
        login: 'Iniciar sesión',
        register: 'Registrarse',
        recover: 'Recuperar acceso',
        account: 'Centro de identidad',
        messages: 'Mis mensajes',
        dashboard: 'Panel de control',
        writeArticle: 'Escribir artículo',
        moderateComments: 'Moderación de comentarios',
        settings: 'Configuración',
        forbidden: 'Acceso denegado',
        notFound: 'Página no encontrada'
    }
} as const satisfies DeepStringShape<typeof zhCNCommon>
