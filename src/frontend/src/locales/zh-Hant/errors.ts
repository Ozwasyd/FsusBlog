import type { DeepStringShape } from '../keys'
import type { errors as zhCNErrors } from '../zh-CN/errors'

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: '存取被拒絕',
        description: '目前帳戶權限不足以存取此區域。',
        homeCta: '回到主頁',
        reLoginCta: '重新登入'
    },
    notFound: {
        codePrefix: '404',
        title: '頁面未找到',
        description: '資源已移動、刪除或不存在。',
        homeCta: '回到主頁',
        searchCta: '搜尋文章',
        archiveCta: '檢視歸檔'
    }
} as const satisfies DeepStringShape<typeof zhCNErrors>
